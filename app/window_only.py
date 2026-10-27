"""Shared guard: only the application's own settings window (same loopback origin) may call an endpoint."""
import ipaddress


def is_settings_window(handler, mutation=True):
    try:
        if not ipaddress.ip_address(handler.client_address[0]).is_loopback:
            return False
        port = handler.server.server_port
        hosts = {f'127.0.0.1:{port}', f'localhost:{port}', f'[::1]:{port}'}
        if handler.headers.get('Host') not in hosts:
            return False
        origin = handler.headers.get('Origin')
        allowed = {'http://' + host for host in hosts}
        if origin is not None and origin not in allowed:
            return False
        if mutation and origin not in allowed:
            return False
        return handler.headers.get('Sec-Fetch-Site') not in ('cross-site', 'same-site')
    except (ValueError, AttributeError):
        return False
