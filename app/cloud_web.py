"""Optional browser gateway. No credentials are stored or logged here."""
import ipaddress
import json
import os
import socket
import urllib.error
import urllib.request
from urllib.parse import urlsplit

SCHOOL_ORIGIN = 'https://iclass.ucas.edu.cn:8181'
SCHOOL_PATHS = {
    '/app/user/login.action': 'POST',
    '/app/course/get_stu_course_sched.action': 'POST',
    '/app/course/get_stu_course_sched_week.action': 'POST',
    '/app/common/get_timestamp.do': 'POST',
    '/app/course/stu_scan_sign.action': 'GET',
}


def origins(raw):
    result = set()
    for value in raw.split(','):
        value = value.strip().rstrip('/')
        if not value: continue
        u = urlsplit(value)
        if (u.scheme != 'https' and not (u.scheme == 'http' and u.hostname in ('localhost', '127.0.0.1', '::1'))) or u.username or u.password or u.path or u.query or u.fragment:
            raise ValueError('Web origins must be exact HTTPS origins (localhost allowed).')
        result.add(value)
    return frozenset(result)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def relay(payload, error_type):
    def fail(status, code, message): raise error_type(status, code, message)
    if not isinstance(payload, dict): fail(400, 'invalid_request', '转接参数无效。')
    target = payload.get('url', '')
    if not isinstance(target, str) or len(target) > 4096: fail(400, 'invalid_request', '转接地址无效。')
    u = urlsplit(target)
    origin = f'{u.scheme}://{u.netloc}'
    if u.scheme != 'https' or u.username or u.password or u.fragment:
        fail(400, 'invalid_request', '转接仅支持 HTTPS。')
    method = payload.get('method', 'GET')
    headers = payload.get('headers') or {}
    if not isinstance(headers, dict): fail(400, 'invalid_request', '请求头无效。')
    headers = {str(k).lower(): str(v) for k, v in headers.items()}
    outgoing = {'Accept': 'application/json'}
    if origin == SCHOOL_ORIGIN:
        if SCHOOL_PATHS.get(u.path) != method:
            fail(403, 'relay_denied', '该学校接口不支持转接。')
        outgoing['User-Agent'] = 'student_5.0.1.2_android_12_20__110000' if u.path.endswith('/login.action') else 'student_5.0.1.2_android_12_20_100000000000000_110000'
        outgoing['Content-Type'] = 'application/x-www-form-urlencoded'
        if 'sessionid' in headers: outgoing['sessionId'] = headers['sessionid']
    else:
        allowed = origins(os.environ.get('CLOUD_MODEL_ORIGINS', ''))
        if origin not in allowed or method != 'POST' or u.query or not (u.path.endswith('/chat/completions') or u.path.endswith('/responses')):
            fail(403, 'model_origin_denied', '请先由服务器管理员将模型服务域名加入 CLOUD_MODEL_ORIGINS。')
        # Prevent a configured hostname from reaching metadata or private services.
        addresses = socket.getaddrinfo(u.hostname, u.port or 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            fail(403, 'relay_denied', '模型转接不允许访问内网地址。')
        outgoing['Content-Type'] = 'application/json'
        if 'authorization' in headers: outgoing['Authorization'] = headers['authorization']
    body = payload.get('body')
    if body is not None and not isinstance(body, str): body = json.dumps(body, ensure_ascii=False)
    data = None if body is None else body.encode('utf-8')
    if data and len(data) > 2 * 1024 * 1024: fail(413, 'body_too_large', '转接内容过大。')
    if any('\r' in v or '\n' in v or len(v) > 8192 for v in outgoing.values()): fail(400, 'invalid_request', '请求头无效。')
    request = urllib.request.Request(target, data=data, headers=outgoing, method=method)
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=90) as response:
            data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024: fail(502, 'upstream_too_large', '服务返回内容过大。')
            return json.loads(data)
    except urllib.error.HTTPError as exc:
        # Never reflect upstream bodies: login failures can include credentials.
        if origin == SCHOOL_ORIGIN and exc.code in (401, 403):
            fail(401, 'upstream_auth_expired', '学校会话已失效，请重新连接学校账号。')
        fail(502, 'upstream_http_error', f'上游服务返回 HTTP {exc.code}，请核对连接。')
    except (urllib.error.URLError, TimeoutError, ValueError):
        fail(502, 'upstream_unavailable', '无法连接上游服务，请稍后重试。')
