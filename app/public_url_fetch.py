"""Bounded public HTTP downloads with DNS pinning and per-redirect validation."""
import email.message
import http.client
import http.cookiejar
import urllib.request
from types import SimpleNamespace
import ipaddress
import json
import mimetypes
from pathlib import PurePosixPath
import re
import socket
import ssl
import threading
import time
import urllib.parse
import zlib


MAX_BYTES = 64 * 1024 * 1024
MAX_REDIRECTS = 5
DOH_TIMEOUT = 8
DOH_MAX_BYTES = 64 * 1024
DOH_HOST = 'cloudflare-dns.com'
DOH_BOOTSTRAP = ('1.1.1.1', '1.0.0.1')
FAKE_DNS_NETWORKS = (ipaddress.ip_network('198.18.0.0/15'), ipaddress.ip_network('2001:2::/48'))


class PublicFetchError(ValueError):
    def __init__(self, message, code='FETCH_FAILED', status=422):
        super().__init__(message)
        self.code, self.status = code, status


def _url(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 8192:
        raise PublicFetchError('网页地址无效。', 'INVALID_URL', 400)
    value = value.strip()
    if '\\' in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise PublicFetchError('网页地址包含不允许的字符。', 'INVALID_URL', 400)
    try:
        parts = urllib.parse.urlsplit(value)
        if parts.scheme.lower() not in ('http', 'https') or not parts.hostname or parts.username is not None or parts.password is not None:
            raise ValueError()
        host = parts.hostname.rstrip('.').encode('idna').decode('ascii').lower()
        if '%' in host or not host or any(char.isspace() for char in host):
            raise ValueError()
        port = parts.port or (443 if parts.scheme.lower() == 'https' else 80)
        if not 1 <= port <= 65535:
            raise ValueError()
        host_field = '[' + host + ']' if ':' in host else host
        authority = host_field + (':' + str(port) if parts.port is not None else '')
        path = urllib.parse.quote(parts.path or '/', safe="/%:@!$&'()*+,;=-._~")
        query = urllib.parse.quote(parts.query, safe="/%?:@!$&'()*+,;=-._~")
        normalized = urllib.parse.urlunsplit((parts.scheme.lower(), authority, path, query, ''))
    except (ValueError, UnicodeError):
        raise PublicFetchError('仅支持不含用户名或密码的完整 HTTP(S) 地址。', 'INVALID_URL', 400) from None
    return normalized, host, port


def _public_ip(value):
    address = ipaddress.ip_address(value)
    if getattr(address, 'ipv4_mapped', None):
        return _public_ip(str(address.ipv4_mapped))
    return (address.is_global and not address.is_multicast and not address.is_reserved
            and not address.is_loopback and not address.is_link_local
            and not address.is_unspecified and not getattr(address, 'is_site_local', False))


def _dns_name(value):
    if not isinstance(value, str):
        return None
    name = value[:-1] if value.endswith('.') else value
    name = name.lower()
    if not 1 <= len(name) <= 253 or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                                      for label in name.split('.')):
        return None
    return name


def _doh_hostname(host):
    name = _dns_name(host)
    if not name or '.' not in name or not re.search(r'[a-z]', name.rsplit('.', 1)[-1]):
        return False
    # Do not leak local/special-use names to an external resolver. Numeric URL
    # spellings (including legacy inet_aton forms) never enable this fallback.
    if name.endswith(('.localhost', '.local', '.internal', '.invalid', '.test', '.example', '.onion',
                      '.arpa', '.lan', '.home', '.corp', '.localdomain')):
        return False
    try:
        socket.inet_aton(name)
        return False
    except OSError:
        return True


def _fake_dns_answers(host, addresses):
    if not _doh_hostname(host) or not addresses:
        return False
    try:
        for family, socktype, proto, _, address in addresses:
            if family not in (socket.AF_INET, socket.AF_INET6) or socktype != socket.SOCK_STREAM or proto not in (0, socket.IPPROTO_TCP):
                return False
            value = ipaddress.ip_address(address[0])
            if '%' in address[0] or (value.version == 4) != (family == socket.AF_INET):
                return False
            if not any(value.version == network.version and value in network for network in FAKE_DNS_NETWORKS):
                return False
    except (ValueError, TypeError, IndexError):
        return False
    return True


def _resolve(host, port, deadline=None):
    if host == 'localhost' or host.endswith(('.localhost', '.local', '.internal')):
        raise PublicFetchError('只能读取公网地址，不能访问本机或内网服务。', 'NON_PUBLIC_URL', 403)
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise PublicFetchError('无法解析网页域名，请检查地址或网络。', 'DNS_FAILED', 502) from None
    if not addresses:
        raise PublicFetchError('网页域名没有可连接的地址。', 'DNS_FAILED', 502)
    # Recognized benchmark ranges are only a compatibility signal. They never
    # become connection targets; any mixed/other private answer still fails.
    if _fake_dns_answers(host, addresses):
        return _doh_addresses(host, port, deadline if deadline is not None else time.monotonic() + DOH_TIMEOUT)
    if any(family not in (socket.AF_INET, socket.AF_INET6) or not _public_ip(address[0])
           for family, _, _, _, address in addresses):
        raise PublicFetchError('只能读取公网地址，不能访问本机或内网服务。', 'NON_PUBLIC_URL', 403)
    return list(dict.fromkeys((family, socktype, proto, address)
                             for family, socktype, proto, _, address in addresses))


class _PinnedConnection(http.client.HTTPConnection):
    def __init__(self, host, port, addresses, timeout, secure):
        super().__init__(host, port, timeout=timeout)
        self.addresses, self.secure = addresses, secure

    def connect(self):
        last_error = None
        deadline = time.monotonic() + self.timeout
        for family, socktype, proto, address in self.addresses:
            connection = socket.socket(family, socktype, proto)
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                connection.settimeout(remaining)
                # Connect to the already-validated numeric address. Do not
                # resolve the hostname a second time or inherit proxy settings.
                connection.connect(address)
                if self.secure:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError()
                    connection.settimeout(remaining)
                    connection = ssl.create_default_context().wrap_socket(connection, server_hostname=self.host)
                self.sock = connection
                return
            except OSError as error:
                last_error = error
                connection.close()
        raise last_error or OSError('No usable public address')


def _invalid_dns():
    return PublicFetchError('安全域名解析返回了无法验证的结果，未连接网页。收藏已保留，可稍后重试。', 'DNS_RESPONSE_INVALID', 502)


def _parse_doh_answer(payload, host, qtype):
    """Accept only the requested question and its bounded CNAME terminal RRset."""
    try:
        if not isinstance(payload, dict) or type(payload.get('Status')) is not int or payload['Status'] != 0:
            raise ValueError()
        if payload.get('TC') is not False or payload.get('CD') is not False or type(qtype) is not int or qtype not in (1, 28):
            raise ValueError()
        questions = payload.get('Question')
        if not isinstance(questions, list) or len(questions) != 1 or not isinstance(questions[0], dict):
            raise ValueError()
        question = questions[0]
        if _dns_name(question.get('name')) != host or type(question.get('type')) is not int or question['type'] != qtype:
            raise ValueError()
        answers = payload.get('Answer', [])
        if not isinstance(answers, list) or len(answers) > 128:
            raise ValueError()
        aliases, records = {}, []
        for entry in answers:
            if not isinstance(entry, dict) or type(entry.get('type')) is not int or not 1 <= entry['type'] <= 65535:
                raise ValueError()
            owner = _dns_name(entry.get('name'))
            if not owner or not _doh_hostname(owner):
                raise ValueError()
            if entry['type'] not in (1, 5, 28):
                continue  # DNSSEC metadata is not a connection target.
            if not isinstance(entry.get('data'), str) or type(entry.get('TTL')) is not int or not 0 <= entry['TTL'] <= 0xffffffff:
                raise ValueError()
            if entry['type'] == 5:
                target = _dns_name(entry['data'])
                if not target or not _doh_hostname(target) or owner in aliases and aliases[owner] != target:
                    raise ValueError()
                aliases[owner] = target
            else:
                address = ipaddress.ip_address(entry['data'])
                if '%' in entry['data'] or not _public_ip(str(address)):
                    raise PublicFetchError('安全域名解析包含非公网地址，已停止连接。', 'NON_PUBLIC_URL', 403)
                if entry['type'] != qtype or address.version != (4 if qtype == 1 else 6):
                    raise ValueError()
                records.append((owner, str(address)))
        terminal, seen = host, set()
        while terminal in aliases:
            if terminal in seen or len(seen) >= 8:
                raise ValueError()
            seen.add(terminal)
            terminal = aliases[terminal]
        if any(owner not in seen for owner in aliases) or any(owner != terminal for owner, _ in records):
            raise ValueError()
        return list(dict.fromkeys(address for _, address in records))
    except PublicFetchError:
        raise
    except (ValueError, TypeError, KeyError):
        raise _invalid_dns() from None


def _doh_query(host, qtype, deadline):
    if not _doh_hostname(host) or type(qtype) is not int or qtype not in (1, 28):
        raise _invalid_dns()
    path = '/dns-query?' + urllib.parse.urlencode({'name': host, 'type': qtype, 'cd': 'false'})
    for bootstrap in DOH_BOOTSTRAP:
        if time.monotonic() >= deadline:
            break
        connection = response = watchdog = None
        expired = threading.Event()
        try:
            addresses = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, (bootstrap, 443))]
            connection = _PinnedConnection(DOH_HOST, 443, addresses, min(3, deadline - time.monotonic()), True)
            connection.connect()
            active_socket = connection.sock

            def expire(active_socket=active_socket, expired=expired):
                expired.set()
                try:
                    active_socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            # A read timeout alone allows a slow header/body to keep extending
            # its lifetime. Shutdown this exact socket at the absolute deadline.
            watchdog = threading.Timer(remaining, expire)
            watchdog.daemon = True
            watchdog.start()
            active_socket.settimeout(remaining)
            connection.request('GET', path, headers={'Host': DOH_HOST, 'Accept': 'application/dns-json', 'Accept-Encoding': 'identity'})
            response = connection.getresponse()
            if response.status != 200 or response.headers.get_content_type() != 'application/dns-json':
                raise _invalid_dns()
            if response.headers.get('Content-Encoding', '').strip().lower() not in ('', 'identity'):
                raise _invalid_dns()
            declared = response.headers.get('Content-Length')
            if declared is not None and (len(declared.strip()) > 10 or not re.fullmatch(r'[0-9]+', declared.strip())):
                raise _invalid_dns()
            expected = int(declared) if declared is not None else None
            if expected is not None and expected > DOH_MAX_BYTES:
                raise _invalid_dns()
            if response.headers.get('Transfer-Encoding', '').lower() not in ('', 'chunked') or declared is not None and response.headers.get('Transfer-Encoding'):
                raise _invalid_dns()
            raw = bytearray()
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or expired.is_set():
                    raise TimeoutError()
                active_socket.settimeout(remaining)
                chunk = response.read1(min(16384, DOH_MAX_BYTES + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
                if len(raw) > DOH_MAX_BYTES:
                    raise _invalid_dns()
            if time.monotonic() >= deadline or expired.is_set():
                raise TimeoutError()
            if expected is not None and len(raw) != expected:
                raise _invalid_dns()

            def unique_object(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError()
                    result[key] = value
                return result

            def invalid_constant(_):
                raise ValueError()

            try:
                return json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object, parse_constant=invalid_constant)
            except (ValueError, UnicodeError, RecursionError):
                raise _invalid_dns() from None
        except PublicFetchError:
            raise
        except (OSError, http.client.HTTPException):
            if expired.is_set() or time.monotonic() >= deadline:
                break
            # Try only the second fixed public bootstrap, never a discovered
            # endpoint, an environment proxy, or the original fake addresses.
        finally:
            if watchdog is not None:
                watchdog.cancel()
            if response is not None:
                response.close()
            if connection is not None:
                connection.close()
    if time.monotonic() >= deadline:
        raise PublicFetchError('安全域名解析等待超时，收藏已保留。', 'DNS_FALLBACK_TIMEOUT', 504)
    raise PublicFetchError('当前网络返回代理虚拟地址，安全域名解析暂时不可用。收藏已保留，可稍后重试。', 'DNS_FALLBACK_FAILED', 502)


def _doh_addresses(host, port, deadline):
    deadline = min(deadline, time.monotonic() + DOH_TIMEOUT)
    values = []
    for qtype in (1, 28):
        if time.monotonic() >= deadline:
            raise PublicFetchError('安全域名解析等待超时，收藏已保留。', 'DNS_FALLBACK_TIMEOUT', 504)
        # Do not connect until BOTH families have been validated. Failed AAAA
        # is not equivalent to a successful empty AAAA answer.
        values.extend(_parse_doh_answer(_doh_query(host, qtype, deadline), host, qtype))
    if time.monotonic() >= deadline:
        raise PublicFetchError('安全域名解析等待超时，收藏已保留。', 'DNS_FALLBACK_TIMEOUT', 504)
    if not values:
        raise PublicFetchError('安全域名解析没有返回公网地址，收藏已保留。', 'DNS_FAILED', 502)
    return [(socket.AF_INET6 if ':' in value else socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP,
             (value, port, 0, 0) if ':' in value else (value, port)) for value in dict.fromkeys(values)]


def _open(url, host, port, addresses, timeout, user_agent, cookie=None):
    parsed = urllib.parse.urlsplit(url)
    connection = _PinnedConnection(host, port, addresses, timeout, parsed.scheme == 'https')
    try:
        headers = {'User-Agent': user_agent, 'Accept': 'application/pdf,text/html,text/plain,*/*;q=0.8', 'Accept-Encoding': 'identity'}
        if cookie: headers['Cookie'] = cookie
        connection.request('GET', urllib.parse.urlunsplit(('', '', parsed.path, parsed.query, '')),
                           headers=headers)
        return connection, connection.getresponse()
    except Exception:
        connection.close()
        raise


def _too_large(max_bytes):
    return PublicFetchError(f'文件实际体积超过本次 {max_bytes // (1024 * 1024)} MiB 下载预算，未保存截断文件。', 'FILE_TOO_LARGE', 413)


def _decode_body(raw, encoding, max_bytes):
    if encoding in ('', 'identity'):
        return raw
    if encoding not in ('gzip', 'deflate'):
        raise PublicFetchError('网页服务器返回了不支持的压缩格式。', 'UNSUPPORTED_ENCODING', 502)
    try:
        decoder = zlib.decompressobj(31 if encoding == 'gzip' else zlib.MAX_WBITS)
        body = decoder.decompress(raw, max_bytes + 1)
        if len(body) > max_bytes or decoder.unconsumed_tail:
            raise _too_large(max_bytes)
        body += decoder.flush(max_bytes + 1 - len(body))
        if len(body) > max_bytes:
            raise _too_large(max_bytes)
        if not decoder.eof or decoder.unused_data:
            raise zlib.error('Incomplete or concatenated compressed response')
        return body
    except zlib.error:
        raise PublicFetchError('网页压缩数据不完整，未保存原件。', 'INVALID_RESPONSE', 502) from None


def _filename(headers, final_url, mime):
    message = email.message.Message()
    message['Content-Disposition'] = headers.get('Content-Disposition', '')
    suggested = message.get_filename() or PurePosixPath(urllib.parse.unquote(urllib.parse.urlsplit(final_url).path)).name
    name = str(suggested or '网页资料').replace('\\', '/').rsplit('/', 1)[-1]
    name = ''.join(char for char in name if ord(char) >= 32 and ord(char) != 127).strip(' .')[:180] or '网页资料'
    if mime == 'application/pdf' and not name.lower().endswith('.pdf'):
        name += '.pdf'
    return name


def fetch_public_url(url, *, max_bytes=MAX_BYTES, timeout=45, total_timeout=180, user_agent='AI-Workstation'):
    """Return complete decoded entity bytes, or an explicit error; never truncate."""
    if not isinstance(max_bytes, int) or max_bytes <= 0:
        raise ValueError('Invalid download byte limit')
    original, _, _ = _url(url)
    current, visited = original, set()
    # Anonymous cookies live only for this download. Never borrow browser login.
    jar = http.cookiejar.CookieJar(policy=http.cookiejar.DefaultCookiePolicy(
        strict_ns_domain=http.cookiejar.DefaultCookiePolicy.DomainStrictNonDomain))
    deadline = time.monotonic() + total_timeout
    for hop in range(MAX_REDIRECTS + 1):
        current, host, port = _url(current)
        cookie_request = urllib.request.Request(current)
        jar.add_cookie_header(cookie_request)
        cookie = cookie_request.get_header('Cookie')
        visit = (current, cookie)
        if visit in visited:
            raise PublicFetchError('网页发生循环重定向。', 'REDIRECT_LOOP', 502)
        visited.add(visit)
        connection = response = None
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            addresses = _resolve(host, port, deadline=deadline)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            args = (current, host, port, addresses, min(timeout, remaining), user_agent)
            connection, response = _open(*args, cookie) if cookie else _open(*args)
            jar.extract_cookies(SimpleNamespace(info=lambda: response.headers), cookie_request)
            if response.status in (301, 302, 303, 307, 308):
                location = response.headers.get('Location')
                if not location:
                    raise PublicFetchError('网页重定向缺少目标地址。', 'INVALID_REDIRECT', 502)
                if hop == MAX_REDIRECTS:
                    raise PublicFetchError('网页重定向次数过多。', 'TOO_MANY_REDIRECTS', 502)
                next_url, _, _ = _url(urllib.parse.urljoin(current, location))
                if current.startswith('https:') and next_url.startswith('http:'):
                    raise PublicFetchError('网页重定向降低了连接安全性，已停止下载。', 'INSECURE_REDIRECT', 502)
                current = next_url
                continue
            if response.status < 200 or response.status >= 300 or response.status == 206:
                raise PublicFetchError(f'网页服务器返回 HTTP {response.status}，未保存不完整原件。', 'UPSTREAM_HTTP', 502)
            declared = response.headers.get('Content-Length')
            if declared is not None and not re.fullmatch(r'\d+', declared.strip()):
                raise PublicFetchError('网页返回了无效的文件长度。', 'INVALID_RESPONSE', 502)
            expected = int(declared) if declared is not None else None
            if expected is not None and expected > max_bytes:
                raise _too_large(max_bytes)
            raw = bytearray()
            while True:
                if time.monotonic() >= deadline:
                    raise TimeoutError()
                chunk = response.read1(min(65536, max_bytes + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
                if len(raw) > max_bytes:
                    raise _too_large(max_bytes)
            if expected is not None and len(raw) != expected:
                raise PublicFetchError('文件下载不完整，请重试。', 'INCOMPLETE_DOWNLOAD', 502)
            raw = _decode_body(bytes(raw), response.headers.get('Content-Encoding', '').strip().lower(), max_bytes)
            if not raw:
                raise PublicFetchError('网页返回了空文件，未保存原件。', 'EMPTY_RESPONSE', 422)
            content_type = response.headers.get('Content-Type', '')
            mime = content_type.split(';', 1)[0].strip().lower()
            mime = mime or mimetypes.guess_type(urllib.parse.urlsplit(current).path)[0] or 'application/octet-stream'
            if not re.fullmatch(r'[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+', mime):
                mime = 'application/octet-stream'
            is_pdf = raw[:1024].lstrip(b'\xef\xbb\xbf\x00\t\r\n ').startswith(b'%PDF-')
            expects_pdf = mime == 'application/pdf' or urllib.parse.urlsplit(current).path.lower().endswith('.pdf')
            if expects_pdf and not is_pdf:
                raise PublicFetchError('链接返回的不是有效 PDF，可能是访问限制或错误页面。', 'NOT_PDF', 422)
            if is_pdf:
                mime = 'application/pdf'
            header = email.message.Message(); header['Content-Type'] = content_type
            return {'raw': raw, 'url': original, 'finalUrl': current, 'name': _filename(response.headers, current, mime),
                    'mimeType': mime, 'size': len(raw), 'charset': header.get_content_charset() or 'utf-8'}
        except PublicFetchError:
            raise
        except (TimeoutError, socket.timeout):
            raise PublicFetchError('下载等待超时，原件尚未保存，请检查网络后重试。', 'DOWNLOAD_TIMEOUT', 504) from None
        except (OSError, http.client.HTTPException):
            raise PublicFetchError('无法完整下载链接内容，请检查网络或访问权限后重试。', 'DOWNLOAD_FAILED', 502) from None
        finally:
            if response is not None:
                response.close()
            if connection is not None:
                connection.close()


def extract_feishu_mindnote(source, url):
    """Read public mindnote bootstrap JSON, without executing untrusted scripts."""
    parsed = urllib.parse.urlsplit(url)
    if not ((parsed.hostname or '').endswith(('.feishu.cn', '.larksuite.com'))
            and re.fullmatch(r'/mindnotes/[A-Za-z0-9]+/?', parsed.path)):
        return None
    match = re.search(r'window\.DATA\s*=\s*\{\s*clientVars\s*:\s*Object\(\s*', source)
    if not match:
        raise PublicFetchError('飞书未返回可读取的思维笔记正文，请检查分享权限，或导出后添加。', 'DOCUMENT_UNAVAILABLE', 422)
    try:
        payload, _ = json.JSONDecoder().raw_decode(source, match.end())
        data = payload.get('data', {})
        if payload.get('code') != 0 or data.get('code', 0) != 0 or data.get('permission_status_code', 0) != 0:
            raise ValueError()
        nodes = data.get('collab_client_vars', {}).get('nodes')
        if not isinstance(nodes, list) or not nodes:
            raise ValueError()
        title = str(data.get('title') or '飞书思维笔记')
        lines, images = [title], 0
        stack = [(node, 0) for node in reversed(nodes)]
        while stack:
            node, depth = stack.pop()
            if not isinstance(node, dict) or depth > 100:
                raise ValueError()
            runs = node.get('text', [])
            text = ''.join(str(run.get('text', '')) for run in runs if isinstance(run, dict)) if isinstance(runs, list) else str(runs or '')
            if text.strip(): lines.append('  ' * depth + '- ' + text.strip())
            images += len(node.get('images') or [])
            children = node.get('children', [])
            if not isinstance(children, list): raise ValueError()
            stack.extend((child, depth + 1) for child in reversed(children))
        if len(lines) == 1: raise ValueError()
        return {'name': title, 'content': '\n'.join(lines), 'parser': 'feishu-mindnote',
                'warning': f'正文含 {images} 张图片；图片内容尚未提取。' if images else ''}
    except (ValueError, TypeError, AttributeError, RecursionError):
        raise PublicFetchError('飞书未提供可读取的思维笔记正文，请检查分享权限或导出文件。', 'DOCUMENT_UNAVAILABLE', 422) from None
