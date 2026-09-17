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
import time
import urllib.parse
import zlib


MAX_BYTES = 64 * 1024 * 1024
MAX_REDIRECTS = 5


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


def _resolve(host, port):
    if host == 'localhost' or host.endswith(('.localhost', '.local', '.internal')):
        raise PublicFetchError('只能读取公网地址，不能访问本机或内网服务。', 'NON_PUBLIC_URL', 403)
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise PublicFetchError('无法解析网页域名，请检查地址或网络。', 'DNS_FAILED', 502) from None
    if not addresses:
        raise PublicFetchError('网页域名没有可连接的地址。', 'DNS_FAILED', 502)
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
                    connection = ssl.create_default_context().wrap_socket(connection, server_hostname=self.host)
                self.sock = connection
                return
            except OSError as error:
                last_error = error
                connection.close()
        raise last_error or OSError('No usable public address')


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
        addresses = _resolve(host, port)
        connection = response = None
        try:
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
