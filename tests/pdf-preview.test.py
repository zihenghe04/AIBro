"""PDF preview endpoints use real rendering and never change source bytes."""
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import urllib.error
import urllib.request
from http_test_support import python_http_service

import fitz

ROOT = (Path(__file__).resolve().parents[1] / 'app')


def response(origin, suffix):
    try:
        result = urllib.request.urlopen(origin + suffix, timeout=5)
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()
    with result:
        return result.status, result.headers, result.read()


with tempfile.TemporaryDirectory(prefix='workstation-pdf-test-') as temporary:
    data = Path(temporary)
    files = data / 'files'
    files.mkdir()
    with fitz.open() as document:
        first = document.new_page(width=300, height=200)
        first.insert_text((30, 40), 'First page: original PDF')
        first.draw_rect(fitz.Rect(50, 70, 180, 130), color=(0, 0.2, 0.8), fill=(0.1, 0.4, 0.9))
        document.new_page(width=420, height=300).insert_text((30, 40), 'Second page')
        source_bytes = document.tobytes()
        encrypted_bytes = document.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='test')
        non_pdf = document[0].get_pixmap().tobytes('png')
    (files / 'test-pdf').write_bytes(source_bytes)
    (files / 'test-pdf.meta.json').write_text(json.dumps({'name': 'Original.pdf', 'mimeType': 'application/pdf'}))
    (files / 'encrypted').write_bytes(encrypted_bytes)
    (files / 'invalid-pdf').write_bytes(b'%PDF-1.7\ninvalid document')
    (files / 'image-not-pdf').write_bytes(non_pdf)
    with fitz.open() as document:
        document.new_page(width=3000, height=3000)
        (files / 'large-page').write_bytes(document.tobytes())
    before = {file.name: hashlib.sha256(file.read_bytes()).digest() for file in files.iterdir()}

    with python_http_service(ROOT / 'server.py', cwd=data,
        env={**os.environ, 'AI_WORKSTATION_PORT': '0', 'AI_WORKSTATION_DATA_DIR': str(data), 'AI_WORKSTATION_ASSET_DIR': str(ROOT)},
    ) as origin:
        status, headers, body = response(origin, '/__files/test-pdf/preview-info')
        assert status == 200
        assert json.loads(body) == {'pageCount': 2, 'width': 300.0, 'height': 200.0}
        assert headers['Cache-Control'] == 'no-store'
        for query, expected_dimensions in (
            ('', (450, 300)),
            ('?page=1&scale=0.5', (150, 100)),
            ('?page=2&scale=1.5', (630, 450)),
            ('?page=2&scale=2', (840, 600)),
        ):
            for image_format in (None, 'png', 'jpeg'):
                parameters = query
                if image_format:
                    parameters += ('&' if query else '?') + 'format=' + image_format
                status, headers, body = response(origin, '/__files/test-pdf/preview' + parameters)
                assert status == 200, (parameters, body)
                assert headers['Content-Type'] == 'image/' + (image_format or 'png')
                assert headers['Cache-Control'] == 'no-store'
                assert headers['X-Content-Type-Options'] == 'nosniff'
                assert int(headers['Content-Length']) == len(body)
                if image_format == 'jpeg':
                    assert body.startswith(b'\xff\xd8\xff') and body.endswith(b'\xff\xd9')
                else:
                    assert body.startswith(b'\x89PNG\r\n\x1a\n')
                    assert struct.unpack('>II', body[16:24]) == expected_dimensions
                image = fitz.Pixmap(body)
                assert (image.width, image.height) == expected_dimensions
                assert image.n == 3 and not image.alpha
                # Confirm the actual source artwork was rendered, not merely
                # that the endpoint returned a valid blank PNG or JPEG.
                if query == '':
                    red, green, blue = image.pixel(150, 150)
                    assert blue > green > red

        jpeg = response(origin, '/__files/test-pdf/preview?format=jpeg')[2]
        with fitz.open(stream=source_bytes, filetype='pdf') as document:
            assert jpeg == document[0].get_pixmap(matrix=fitz.Matrix(1.5, 1.5), colorspace=fitz.csRGB, alpha=False).tobytes('jpeg', jpg_quality=85)
        # Quality is controlled by the server, never by caller parameters.
        for quality in ('1', '100', 'nan'):
            assert response(origin, '/__files/test-pdf/preview?format=jpeg&quality=' + quality)[2] == jpeg

        for query in ('?page=0', '?page=3'):
            for suffix in ('', '&format=jpeg'):
                assert response(origin, '/__files/test-pdf/preview' + query + suffix)[0] == 404
        for query in (
            '?page=-1', '?page=1.2', '?page=', '?page=one', '?page=1&page=2',
            '?scale=nan', '?scale=inf', '?scale=-inf', '?scale=0.49', '?scale=2.01',
            '?scale=', '?scale=1&scale=2',
        ):
            for suffix in ('', '&format=jpeg'):
                status, _, body = response(origin, '/__files/test-pdf/preview' + query + suffix)
                assert status == 400, (query, suffix, status, body)
                assert json.loads(body).get('error')
        for query in ('?format=', '?format=jpg', '?format=gif', '?format=JPEG', '?format=jpeg%00', '?format=../png', '?format=png&format=jpeg', '?format=jpeg&format=jpeg'):
            status, _, body = response(origin, '/__files/test-pdf/preview' + query)
            assert status == 400, (query, status, body)
            assert json.loads(body).get('error')
        for identifier, expected_status in (
            ('missing-file', 404), ('bad%2Fid', 400), ('%2e%2e', 400),
            ('invalid-pdf', 400), ('image-not-pdf', 400), ('encrypted', 400),
        ):
            for action in ('preview-info', 'preview', 'preview?format=jpeg'):
                status, _, body = response(origin, f'/__files/{identifier}/{action}')
                assert status == expected_status, (identifier, action, status, body)
        for suffix in ('', '&format=jpeg'):
            assert response(origin, '/__files/large-page/preview?scale=2' + suffix)[0] == 400
            assert response(origin, '/__files/large-page/preview?scale=0.5' + suffix)[0] == 200
        assert response(origin, '/__files/test-pdf')[2] == source_bytes
    after = {file.name: hashlib.sha256(file.read_bytes()).digest() for file in files.iterdir()}
    assert before == after, 'Previewing must preserve every original file and metadata byte'

print('PDF PNG/JPEG preview, fixed quality, page rendering, bounds, invalid input and source preservation tests passed')
