#!/usr/bin/env python3
"""Check the actual delivery archive, not a build directory or simulator artifact."""
import hashlib, json, pathlib, plistlib, struct, sys, zipfile
path = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(path) as archive:
    assert archive.testzip() is None, 'Corrupted ZIP'
    names = archive.namelist()
    roots = [n[:-len('Info.plist')] for n in names if n.startswith('Payload/') and n.count('/') == 2 and n.endswith('.app/Info.plist')]
    assert len(roots) == 1, 'Expected one application'
    root = roots[0]
    info = plistlib.loads(archive.read(root+'Info.plist'))
    assert info['CFBundleIdentifier'] == 'app.aibro.mobile'
    assert root+'Assets.car' in names and root+'public/index.html' in names
    assert any(n.startswith(root+'AppIcon') and n.endswith('.png') for n in names)
    assert not any('.xctest/' in n for n in names), 'Test bundle leaked into delivery'
    extensions = [plistlib.loads(archive.read(n))['CFBundleIdentifier'] for n in names if '/PlugIns/' in n and n.endswith('.appex/Info.plist')]
    assert set(extensions) == {'app.aibro.mobile.share','app.aibro.mobile.widget'}
    binary = archive.read(root+info['CFBundleExecutable'])
    magic, cpu, subtype, filetype, count, size, flags, reserved = struct.unpack_from('<8I', binary)
    assert magic == 0xfeedfacf and cpu == 0x100000c, 'Expected arm64 Mach-O'
    offset=32; platform=None
    for _ in range(count):
        command, length = struct.unpack_from('<II', binary, offset)
        if command == 0x32: platform = struct.unpack_from('<I', binary, offset+8)[0]
        offset += length
    assert platform == 2, 'Not an iPhoneOS binary'
print(json.dumps({'file':str(path.resolve()),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'version':info['CFBundleShortVersionString'],'minimumIOS':info['MinimumOSVersion'],'extensions':extensions,'architecture':'arm64','platform':'iPhoneOS','signing':'Requires developer signing before iPhone installation'}, ensure_ascii=False,indent=2))
