"""Managed image bytes, exact portable Markdown and actual loopback routes."""
import base64
import copy
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import zipfile
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))
host = tempfile.TemporaryDirectory()
os.environ.setdefault("AI_WORKSTATION_DATA_DIR", host.name)
import document_media as media
import server
from PIL import Image
from wiki_migration import WikiMigration
from wiki_bundle import WikiBundle


def raster(format="PNG", size=(4, 3)):
    buffer = io.BytesIO()
    Image.new("RGB", size, "red").save(buffer, format=format)
    return buffer.getvalue()


class DocumentMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = server.WorkspaceStore(self.temp.name)
        self.state = {"projects": [{"id": "p", "workspace": "科研"}], "notes": [{"id": "n", "title": "Original", "content": "Original body", "workspace": "科研", "projectId": "p"}],
                      "imports": [], "conversations": [], "agentRuns": [], "trash": [], "tasks": []}
        self.store.save(self.state)
        self.media = media.DocumentMedia(self.store)

    def upload(self, format="PNG", note="n", raw=None, name="clipboard.png"):
        return self.media.upload({"noteId": note, "name": name, "data": base64.b64encode(raw if raw is not None else raster(format)).decode()})

    def register(self, result):
        state = self.store.load()
        state["imports"].append(result)
        self.store.save(state)

    def bundle(self, content, title="Draft title"):
        result = self.media.export({"noteId": "n", "title": title, "content": content})
        return zipfile.ZipFile(io.BytesIO(result["data"]))

    def test_all_four_actual_formats_use_decoded_type_not_extension(self):
        before = copy.deepcopy(self.store.load())
        for format, extension in (("PNG", "png"), ("JPEG", "jpg"), ("GIF", "gif"), ("WEBP", "webp")):
            result = self.upload(format, name="misleading.svg")
            self.assertEqual(result["name"], "misleading." + extension)
            self.assertEqual((result["width"], result["height"]), (4, 3))
            self.assertEqual(self.store.file_path(result["id"]).read_bytes(), raster(format))
            self.assertEqual(result["importOrigin"], {"kind": "document-image", "noteId": "n"})
        self.assertEqual(self.store.load(), before)

    def test_dedup_is_per_note_and_exact_content_not_user_filename(self):
        first = self.upload()
        self.assertEqual(first["id"], self.upload(name="other-name.jpg")["id"])
        state = self.store.load(); state["notes"].append({**state["notes"][0], "id": "second"}); self.store.save(state)
        self.assertNotEqual(first["id"], self.upload(note="second")["id"])
        self.assertNotEqual(first["id"], self.upload(raw=raster(size=(5, 3)))["id"])

    def test_corrupt_svg_fake_images_and_bad_base64_do_not_write(self):
        for raw in (b"", b"<svg><rect /></svg>", b"\x89PNG\r\n\x1a\ntruncated", raster()[:35], b"%PDF-test"):
            with self.assertRaises(media.MediaError): self.upload(raw=raw)
        with self.assertRaises(media.MediaError): self.media.upload({"noteId": "n", "name": "x", "data": "not base64!"})
        self.assertFalse((self.store.directory / "files").exists())

    def test_size_and_decode_bounds_are_explicit(self):
        with patch.object(media, "MAX_IMAGE_BYTES", 16):
            with self.assertRaises(media.MediaError) as result: self.upload()
            self.assertEqual(result.exception.status, 413)
        with patch.object(media, "MAX_PIXELS", 11):
            with self.assertRaises(media.MediaError) as result: self.upload()
            self.assertEqual(result.exception.status, 413)
        frames = [Image.new("RGB", (4,3), color) for color in ("red", "blue", "green")]
        out = io.BytesIO(); frames[0].save(out, format="GIF", save_all=True, append_images=frames[1:])
        self.assertEqual(media.validate_image(out.getvalue())["frames"], 3)
        with patch.object(media, "MAX_ANIMATION_PIXELS", 30):
            with self.assertRaises(media.MediaError): self.upload(raw=out.getvalue())

    def test_note_parent_private_lifecycle_and_duplicates_block_upload(self):
        original = self.store.load()
        for field, value in (("archived", True), ("archivedAt", 1), ("deleted", True), ("deletedAt", 1), ("status", "deleted"), ("private", True)):
            # Start from the live state each time: history keeps only the newest four
            # baselines, so a writer six saves behind would rightly conflict.
            state = copy.deepcopy(self.store.load()); state["notes"][0][field] = value; self.store.save(state)
            with self.assertRaises(media.MediaError): self.upload()
            state = copy.deepcopy(self.store.load())
            if field in original["notes"][0]: state["notes"][0][field] = original["notes"][0][field]
            else: state["notes"][0].pop(field, None)
            self.store.save(state)
        for variant in ("private", "archived", "duplicate", "missing"):
            state = copy.deepcopy(original)
            if variant == "duplicate": state["projects"].append(copy.deepcopy(state["projects"][0]))
            elif variant == "missing": state["projects"] = []
            else: state["projects"][0][variant] = True
            with patch.object(self.store, 'load', lambda: state):
                with self.assertRaises(media.MediaError): self.upload()

    def test_existing_sync_captures_import_blob_and_portable_origin(self):
        result = self.upload(); self.register(result)
        stored = next(item for item in self.store.load()['imports'] if item['id'] == result['id'])
        digest = hashlib.sha256(raster()).hexdigest()
        self.assertEqual(stored['blobHash'], digest)
        operation = next(item for item in self.store.sync.pending() if item['entityType'] == 'imports' and item['entityId'] == result['id'])
        self.assertEqual(operation['data']['blobHash'], digest)
        self.assertEqual(operation['data']['importOrigin'], {'kind': 'document-image', 'noteId': 'n'})
        blob = next(item for item in self.store.sync.blob_manifest() if item['id'] == result['id'])
        self.assertEqual((blob['hash'], blob['mimeType'], blob['size']), (digest, 'image/png', len(raster())))

    def test_lifecycle_rechecked_after_image_decode(self):
        decode = media.decode_image
        def invalidate(encoded):
            result = decode(encoded)
            state = self.store.load(); state["notes"][0]["archived"] = True; self.store.save(state)
            return result
        with patch.object(media, "decode_image", invalidate):
            with self.assertRaises(media.MediaError): self.upload()
        self.assertFalse((self.store.directory / "files").exists())

    def test_partial_metadata_failure_does_not_mutate_note_and_can_retry(self):
        before = self.store.load(); write = self.store.atomic_write
        def fail_meta(path, raw):
            if path.name.endswith(".meta.json"): raise OSError("synthetic disk fault")
            return write(path, raw)
        with patch.object(self.store, "atomic_write", fail_meta):
            with self.assertRaises(OSError): self.upload()
        self.assertEqual(self.store.load(), before)
        result = self.upload()
        self.assertTrue(self.store.file_path(result["id"]).with_suffix(".meta.json").is_file())

    def test_no_symlinks_and_never_replace_conflicting_bytes(self):
        result = self.upload(); path = self.store.file_path(result["id"])
        path.write_bytes(b"different")
        with self.assertRaises(media.MediaError): self.upload()
        self.assertEqual(path.read_bytes(), b"different")
        path.unlink(); path.symlink_to(self.store.path)
        with self.assertRaises(media.MediaError): self.upload()

    def test_registered_image_metadata_recovery_preserves_name_and_bytes(self):
        result = self.upload(name='Original.png'); self.register(result)
        path = self.store.file_path(result['id']); metadata = path.with_suffix('.meta.json')
        stamp = path.stat().st_mtime_ns; metadata.unlink()
        restored = self.upload(name='Renamed.png')
        self.assertEqual(restored['name'], 'Original.png')
        self.assertEqual(json.loads(metadata.read_text())['mimeType'], 'image/png')
        self.assertEqual(path.stat().st_mtime_ns, stamp)

    def test_same_project_image_requires_document_origin_or_source_membership(self):
        state = self.store.load(); state['notes'].append({**state['notes'][0], 'id': 'other'}); self.store.save(state)
        result = self.upload(note='other'); self.register(result)
        with self.assertRaises(media.MediaError): self.bundle(f'![x]({result["url"]})')
        state = self.store.load(); state['notes'][0]['sourceAttachmentIds'] = [result['id']]; self.store.save(state)
        with self.bundle(f'![x]({result["url"]})') as archive:
            self.assertIn('assets/' + result['id'] + '.png', archive.namelist())

    def test_zip_includes_unsaved_body_and_exact_images_without_mutation(self):
        result = self.upload(); self.register(result); before = self.store.load()
        body = '# Unsaved draft\n\n![中文图](' + result["url"] + ' "Title")\n'
        with self.bundle(body) as archive:
            target = 'assets/' + result['id'] + '.png'
            self.assertEqual(archive.read('Draft title.md').decode(), body.replace(result['url'], target))
            self.assertEqual(archive.read(target), raster())
        self.assertEqual(self.store.load(), before)

    def test_export_ignores_code_and_rewrites_reference_and_angle_images(self):
        result = self.upload(); self.register(result); href = result['url']
        code = f'`![inline]({href})`\n\n~~~md\n![fenced]({href})\n~~~\n\n    ![indented]({href})\n'
        live = f'![angle](<{href}> "Angle")\n![reference][pic]\n\n[pic]: <{href}> "Caption"\n'
        with self.bundle(code + live) as archive:
            body = archive.read('Draft title.md').decode()
            self.assertTrue(body.startswith(code))
            self.assertEqual(body[len(code):], live.replace(href, 'assets/' + result['id'] + '.png'))

    def test_reference_definition_after_fence_and_escaped_image_markers(self):
        href = '/__files/test'
        text = f'![outside][pic]\n```\n![inside]({href})\n```\n[pic]: {href}\n' + rf'\![escaped]({href})' + '\n' + rf'\\![live]({href})'
        occurrences = media.image_occurrences(text)
        self.assertEqual(len(occurrences), 2)
        self.assertTrue(all(text[start:end] == href for _, start, end in occurrences))

    def test_balanced_parentheses_escapes_titles_and_nested_list_indents(self):
        text = '- Parent\n\n    ![nested](assets/a(1).png "caption")\n\n  - Nested\n\n    ![escaped](assets/a\\(2\\).png)\n\n        ![code](missing.png)\n\nOutside\n\n    ![outside code](also-missing.png)\n'
        values = media.image_occurrences(text)
        self.assertEqual([href for href, _, _ in values], ['assets/a(1).png', 'assets/a(2).png'])
        self.assertEqual(text[values[1][1]:values[1][2]], r'assets/a\(2\).png')
        seen = []
        rewritten, files = media.portable_markdown(text, lambda href: (seen.append(href) or {'path': 'assets/export-' + str(len(seen)) + '.png', 'data': b'fixture'}))
        self.assertIn('![nested](assets/export-1.png "caption")', rewritten)
        self.assertIn('![escaped](assets/export-2.png)', rewritten)
        self.assertIn('![code](missing.png)', rewritten)
        self.assertEqual(len(files), 2)

    def test_parenthesized_reference_destinations_preserve_spans_and_inline_code(self):
        content = '![ref][pic]\n\n[pic]: assets/a(1).png "caption"\n`![code](assets/a(2).png)`\n'
        values = media.image_occurrences(content)
        self.assertEqual([href for href, _, _ in values], ['assets/a(1).png'])
        self.assertEqual(content[values[0][1]:values[0][2]], 'assets/a(1).png')

    def test_escaped_backticks_do_not_hide_rendered_images_from_export(self):
        content = r'\`![visible](assets/a(1).png)\`' + '\n' + '``![code](missing.png)``'
        self.assertEqual([href for href, _, _ in media.image_occurrences(content)], ['assets/a(1).png'])

    def test_export_missing_private_cross_project_and_unregistered_fail(self):
        result = self.upload(); href = result['url']
        with self.assertRaises(media.MediaError): self.bundle(f'![x]({href})')
        self.register(result); original = self.store.load()
        for key, value in (("private", True), ("archived", True), ("projectId", "other"), ("workspace", "日常")):
            state = copy.deepcopy(original); state['imports'][0][key] = value; self.store.save(state)
            with self.assertRaises(media.MediaError): self.bundle(f'![x]({href})')
        self.store.save(original); self.store.file_path(result['id']).unlink()
        with self.assertRaises(media.MediaError): self.bundle(f'![x]({href})')

    def test_export_external_and_data_links_are_never_fetched(self):
        for href in ('https://example.com/image.png', 'file:///etc/hosts', 'data:image/png;base64,AAAA', '../outside.png'):
            with self.assertRaises(media.MediaError): self.bundle(f'![x]({href})')

    def test_managed_images_survive_wiki_bundle_source_optout(self):
        state = self.store.load(); state['notes'][0]['kind'] = '科研笔记'; self.store.save(state)
        migration = WikiMigration(self.store); migration.adopt(migration.preview())
        result = self.upload(); self.register(result)
        state = self.store.load(); state['notes'][0]['content'] = f'![body]({result["url"]})\n`![code]({result["url"]})`'; self.store.save(state)
        bundle = WikiBundle(self.store); before = self.store.load()
        with zipfile.ZipFile(io.BytesIO(bundle.build({**bundle.preview(['n']), 'includeSources': False}))) as archive:
            manifest = json.loads(archive.read('AIBRO-EXPORT.json'))
            source = manifest['sources'][0]
            self.assertTrue(source['embedded']); self.assertEqual(archive.read(source['path']), raster())
            body = archive.read(manifest['notes'][0]['path']).decode()
            self.assertIn('`![code](' + result['url'] + ')`', body)
            self.assertNotIn('![body](' + result['url'], body)
        self.assertEqual(self.store.load(), before)


class DocumentMediaHTTPTests(DocumentMediaTests):
    # Reuse setup utilities but run route cases only (avoid running base cases twice).
    def setUp(self):
        super().setUp()
        server.STORE = self.store
        server.DOCUMENT_MEDIA = self.media
        class QuietHandler(server.Handler):
            def log_message(self, *_): pass
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        worker = threading.Thread(target=self.httpd.serve_forever, daemon=True); worker.start()
        self.addCleanup(lambda: (self.httpd.shutdown(), self.httpd.server_close(), worker.join(timeout=2)))
        self.origin = f'http://127.0.0.1:{self.httpd.server_port}'

    def request(self, path, payload, headers=None):
        request = Request(self.origin + path, data=json.dumps(payload).encode(), headers=headers if headers is not None else {'Origin': self.origin, 'Content-Type': 'application/json'}, method='POST')
        try:
            with urlopen(request, timeout=3) as response: return response.status, response.read(), response.headers
        except HTTPError as response: return response.code, response.read(), response.headers

    def test_http_upload_download_and_export_roundtrip(self):
        payload = {'noteId': 'n', 'name': 'sample.png', 'data': base64.b64encode(raster()).decode()}
        status, raw, _ = self.request('/__document-images/upload', payload)
        self.assertEqual(status, 200); result = json.loads(raw); self.register(result)
        with urlopen(self.origin + result['url'], timeout=3) as response:
            self.assertEqual(response.headers['Content-Type'], 'image/png'); self.assertEqual(response.read(), raster())
        status, raw, headers = self.request('/__document-images/export', {'noteId': 'n', 'title': 'Unsaved', 'content': f'![x]({result["url"]})'})
        self.assertEqual((status, headers['Content-Type']), (200, 'application/zip'))
        with zipfile.ZipFile(io.BytesIO(raw)) as archive: self.assertIn('Unsaved.md', archive.namelist())

    def test_http_origin_media_type_and_size_guards(self):
        for headers in ({'Content-Type': 'application/json'}, {'Origin': 'https://evil.invalid', 'Content-Type': 'application/json'}, {'Origin': self.origin, 'Host': 'evil.invalid'}, {'Origin': self.origin, 'Sec-Fetch-Site': 'cross-site'}):
            self.assertEqual(self.request('/__document-images/upload', {}, headers)[0], 403)
        self.assertEqual(self.request('/__document-images/upload', {}, {'Origin': self.origin, 'Content-Type': 'text/plain'})[0], 415)
        connection = http.client.HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=3); self.addCleanup(connection.close)
        connection.request('POST', '/__document-images/upload', body=None, headers={'Origin': self.origin, 'Content-Type': 'application/json', 'Content-Length': str(media.MAX_UPLOAD_BODY + 1)})
        self.assertEqual(connection.getresponse().status, 413)


if __name__ == '__main__':
    # Select base storage cases once and HTTP-specific cases only.
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(DocumentMediaTests)
    suite.addTests(DocumentMediaHTTPTests(name) for name in ('test_http_upload_download_and_export_roundtrip', 'test_http_origin_media_type_and_size_guards'))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
