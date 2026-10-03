"""Explicit, anonymous website metadata for the native link library.

Behavior reference: TO-DO Panel (MIT), fixed 1deb3cac1e32599f13b1d6b30a7e52af76f67efd,
main.js fetchFaviconDataUrl/inspectLink. Unlike upstream, saving a bookmark does
not call this module. No model, browser cookies, original-file writes or sync.
"""
import base64
from html.parser import HTMLParser
import io
import math
import re
import warnings
from urllib.parse import urljoin, urlsplit

import bookmark_fetch
from public_url_fetch import PublicFetchError, fetch_public_url

MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_ICON_BYTES = 160 * 1024
MAX_PNG_BYTES = 32 * 1024
IDENTIFIER = re.compile(r'[A-Za-z0-9_-]{1,200}')


class _Head(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_title = False
        self.title = ''
        self.description = ''
        self.icon = ''
        self.finished = False

    def handle_starttag(self, tag, attrs):
        if self.finished:
            return
        attrs = dict(attrs)
        if tag == 'title':
            self.in_title = True
        elif tag == 'meta' and not self.description and (attrs.get('name') or attrs.get('property') or '').lower() in ('description', 'og:description'):
            self.description = str(attrs.get('content') or '')[:2000]
        elif tag == 'link' and not self.icon and 'icon' in (attrs.get('rel') or '').lower().split():
            self.icon = str(attrs.get('href') or '')[:8192]

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False
        elif tag == 'head':
            self.finished = True

    def handle_data(self, value):
        if self.in_title and not self.finished:
            self.title = (self.title + value)[:2000]


def _text(value, limit):
    return re.sub(r'\s+', ' ', re.sub(r'[\x00-\x1f\x7f]', ' ', value)).strip()[:limit]


def record(store, request):
    target = request.get('bookmark') if isinstance(request, dict) else None
    if (not isinstance(target, dict) or set(target) != {'id', 'identity', 'updatedAt', 'requestId'}
            or not IDENTIFIER.fullmatch(str(target.get('id', '')))
            or not bookmark_fetch.ID.fullmatch(str(target.get('requestId', '')))
            or not isinstance(target.get('identity'), str) or len(target['identity']) > 240
            or isinstance(target.get('updatedAt'), bool)
            or not isinstance(target.get('updatedAt'), (int, float))
            or not math.isfinite(target['updatedAt']) or target['updatedAt'] < 0
            or request.get('native') is not True):
        raise PublicFetchError('网站信息请求格式无效。', 'INVALID_REQUEST', 400)
    state = store.load()
    matches = bookmark_fetch._matches(state, 'imports', target['id'])
    if len(matches) != 1 or not bookmark_fetch._active(matches[0]):
        raise bookmark_fetch._changed()
    row = matches[0]
    if bookmark_fetch._private(state, row):
        raise PublicFetchError('私密资料不能从快捷链接库联网读取。', 'BOOKMARK_PRIVATE', 403)
    projects = bookmark_fetch._matches(state, 'projects', row.get('projectId'))
    if row.get('projectId') and (len(projects) != 1 or not bookmark_fetch._active(projects[0])):
        raise bookmark_fetch._changed()
    if ((row.get('quickLinkIdentity') or '') != target['identity']
            or (row.get('updatedAt') or 0) != target['updatedAt'] or row.get('url') != request.get('url')):
        raise bookmark_fetch._changed()
    return row


def _png(raw):
    # Pillow is already the document-image decoder. Never pass remote SVG, HTML
    # or unbounded source pixels to AppKit. The UI only receives a tiny PNG.
    from PIL import Image
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in ('PNG', 'JPEG', 'GIF', 'WEBP', 'ICO') or not 0 < image.width * image.height <= 1_048_576:
                raise ValueError('unsupported icon')
            image.seek(0)
            image.load()
            image.thumbnail((64, 64), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            image.convert('RGBA').save(output, format='PNG')
            value = output.getvalue()
            if not 0 < len(value) <= MAX_PNG_BYTES:
                raise ValueError('icon budget')
            return 'data:image/png;base64,' + base64.b64encode(value).decode('ascii')


def inspect(url, *, fetcher=fetch_public_url):
    fetched = fetcher(url, max_bytes=MAX_PAGE_BYTES, timeout=8, total_timeout=12,
                      user_agent='AI-Bro/website-metadata')
    result = {'title': '', 'description': '', 'finalUrl': fetched['finalUrl'],
              'iconDataUrl': '', 'iconStatus': 'unavailable'}
    head = _Head()
    if fetched['mimeType'] in ('text/html', 'application/xhtml+xml'):
        try:
            source = fetched['raw'].decode(fetched.get('charset') or 'utf-8', 'replace')
        except LookupError:
            source = fetched['raw'].decode('utf-8', 'replace')
        head.feed(source)
        result.update(title=_text(head.title, 180), description=_text(head.description, 500))
    try:
        # One candidate only. All resolution, public address pinning, redirect
        # and downgrade checks still run in the existing public fetch service.
        candidate = urljoin(fetched['finalUrl'], head.icon or '/favicon.ico')
        if urlsplit(fetched['finalUrl']).scheme.lower() == 'https' and urlsplit(candidate).scheme.lower() == 'http':
            raise ValueError('icon downgrade')
        icon = fetcher(candidate, max_bytes=MAX_ICON_BYTES, timeout=3.5, total_timeout=4,
                       user_agent='AI-Bro/site-icon')
        result.update(iconDataUrl=_png(icon['raw']), iconStatus='ready')
    except Exception:
        # A missing/unsafe/broken favicon is not a failed page or a permission
        # fallback. The client keeps any prior valid icon and saved original.
        result['iconStatus'] = 'unavailable'
    return result


def receive(store, request, *, fetcher=fetch_public_url):
    with store.lock():
        before = record(store, request)
    result = inspect(request['url'], fetcher=fetcher)
    with store.lock():
        if record(store, request) != before:
            raise bookmark_fetch._changed()
    return dict(result, id=before['id'], bookmarkRequestId=request['bookmark']['requestId'])
