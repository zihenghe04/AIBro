"""Local bundled PDF extraction: no external parser, no silent truncation, immutable cursors."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import urllib.error
import urllib.request
import fitz
from http_test_support import python_http_service

ROOT = Path(__file__).resolve().parents[1] / 'app'
def request(origin, suffix, data=None, name=None):
    headers = {'X-Filename': name} if name else {}
    req = urllib.request.Request(origin + suffix, data=data, headers=headers)
    try:
        response = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())
    with response:
        return response.status, json.loads(response.read())

with tempfile.TemporaryDirectory(prefix='aibro-pdf-index-') as temporary:
    data = Path(temporary); files = data / 'files'; files.mkdir()
    wrapper = data / 'no-external-parser.py'
    wrapper.write_text('import sys,runpy,shutil\n'
        + 'sys.path.insert(0,' + repr(str(ROOT)) + ')\n'
        + 'def no_binary(*a,**kw):\n raise AssertionError("No external PDF parser may be required")\n'
        + 'shutil.which=no_binary\n'
        + 'runpy.run_path(' + repr(str(ROOT / 'server.py')) + ',run_name="__main__")\n')
    with fitz.open() as document:
        page = document.new_page(width=1000, height=2500)
        for row in range(400):
            page.insert_text((10, 20 + row * 6), f'ROW{row:04d} ' + 'searchable extraction ' * 8, fontsize=3)
        page.insert_text((10, 2460), '最后一行完整保留', fontname='china-s', fontsize=9)
        for number in range(501):
            page = document.new_page(width=200, height=200)
            page.insert_text((10, 25), f'Page {number + 2}: preserved end marker')
        raw = document.tobytes() + b'\0' * (32 * 1024 * 1024)
        expected = [page.get_text('text', sort=True, flags=fitz.TEXTFLAGS_TEXT & ~fitz.TEXT_PRESERVE_IMAGES) for page in document]
        assert len(expected[0]) > 60000
        (files / 'long').write_bytes(raw)
        restricted = document.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256,owner_pw='fixture-owner',user_pw='',permissions=fitz.PDF_PERM_PRINT)
        encrypted = document.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256,owner_pw='fixture-owner',user_pw='fixture-user')
    with fitz.open() as document:
        document.new_page(width=200,height=200)
        blank = document.tobytes()
    digest = hashlib.sha256(raw).hexdigest()
    with python_http_service(wrapper, cwd=data, env={'AI_WORKSTATION_PORT':'0','AI_WORKSTATION_DATA_DIR':str(data),'AI_WORKSTATION_ASSET_DIR':str(ROOT)}) as origin:
        status, parsed = request(origin, '/__parse', raw, 'long.pdf')
        assert status == 200, parsed
        assert parsed['parser'] == 'pymupdf-local' and parsed['truncated'] is False
        assert parsed['pageCount'] == len(parsed['pages']) == 502
        assert [page['text'] for page in parsed['pages']] == expected
        assert len(parsed['content']) > 60000 and expected[-1].strip() in parsed['content']
        assert parsed['sourceHash'] == digest and parsed['textExtractionComplete'] is True
        status, first = request(origin, '/__files/long/read-text?page=1&offset=0')
        assert status == 200 and first['sourceHash'] == digest and first['nextOffset'] == 12000
        assembled = first['text']; offset = first['nextOffset']
        while offset is not None:
            status, part = request(origin, f'/__files/long/read-text?page=1&offset={offset}&source={digest}')
            assert status == 200 and part['sourceHash'] == digest
            assembled += part['text']; offset = part['nextOffset']
        assert assembled == expected[0]
        status, part = request(origin, f'/__files/long/read-text?page=502&offset=0&source={digest}')
        assert status == 200 and part['text'] == expected[-1]
        started = time.monotonic(); batched_pages = {}; page, offset, batches = 1, 0, 0
        while page is not None:
            status, batch = request(origin, f'/__files/long/read-text?batch=1&page={page}&offset={offset}&source={digest}')
            assert status == 200 and batch['sourceHash'] == digest and 0 < len(batch['parts']) <= 10
            assert sum(len(part['text']) for part in batch['parts']) <= 100000
            for part in batch['parts']:
                assert len(batched_pages.get(part['page'], '')) == part['offset']
                batched_pages[part['page']] = batched_pages.get(part['page'], '') + part['text']
            page, offset = batch['nextPage'], batch['nextOffset']; batches += 1
        elapsed = time.monotonic() - started
        assert [batched_pages[i+1] for i in range(502)] == expected
        assert batches == 51
        print(json.dumps({'syntheticPdfBytes':len(raw),'pages':502,'indexHttpRequests':batches,'elapsedSeconds':round(elapsed,3),'sourceValidation':'secure reopen and SHA256 on every batch'}))
        status, part = request(origin, '/__files/long/read-text?source=' + 'b' * 64)
        assert status == 409 and part['code'] == 'PDF_SOURCE_CHANGED'
        assert request(origin, '/__files/long/read-text?source=bad')[0] == 400
        assert request(origin, '/__parse', restricted, 'restricted.pdf')[0] == 403
        assert request(origin, '/__parse', encrypted, 'encrypted.pdf')[0] == 422
        status, parsed = request(origin, '/__parse', blank, 'blank.pdf')
        assert status == 200 and parsed['content'] == '' and parsed['pages'] == [{'page':1,'text':''}] and 'OCR' in parsed['warning']
        assert hashlib.sha256((files/'long').read_bytes()).hexdigest() == digest
print('PASS: bundled local extraction without pdftotext; 502 pages and >60k single page; Unicode tail; source-pinned pagination; permissions/encryption/blank pages; no original writes.')
