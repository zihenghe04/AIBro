#!/usr/bin/env python3
"""Validate a produced iPhoneOS archive, without signing or installing it."""
import json
import pathlib
import plistlib
import struct
import sys


archive = pathlib.Path(sys.argv[1]).resolve()
applications = list((archive / "Products/Applications").glob("*.app"))
assert len(applications) == 1, "Expected one archived application"
app = applications[0]
info = plistlib.loads((app / "Info.plist").read_bytes())
assert info["CFBundleIdentifier"] == "app.aibro.mobile"
assert (app / "Assets.car").is_file(), "Missing compiled asset catalog"
assert (app / "public/index.html").is_file(), "Missing bundled mobile frontend"
assert not list(app.rglob("*.xctest")), "Test bundle leaked into archive"
extensions = sorted((app / "PlugIns").glob("*.appex"))
identifiers = []
for bundle in [app, *extensions]:
    metadata = plistlib.loads((bundle / "Info.plist").read_bytes())
    assert metadata["CFBundleShortVersionString"] == info["CFBundleShortVersionString"]
    assert metadata["CFBundleVersion"] == info["CFBundleVersion"]
    assert metadata["CFBundleSupportedPlatforms"] == ["iPhoneOS"]
    binary = (bundle / metadata["CFBundleExecutable"]).read_bytes()
    magic, cpu, _, _, count, _, _, _ = struct.unpack_from("<8I", binary)
    assert magic == 0xFEEDFACF and cpu == 0x100000C, "Expected arm64 Mach-O"
    offset, platform = 32, None
    for _ in range(count):
        command, length = struct.unpack_from("<II", binary, offset)
        assert length >= 8 and offset + length <= len(binary)
        if command == 0x32:
            platform = struct.unpack_from("<I", binary, offset + 8)[0]
        offset += length
    assert platform == 2, "Simulator binary cannot be distributed to iPhone"
    if bundle != app:
        identifiers.append(metadata["CFBundleIdentifier"])
assert set(identifiers) == {"app.aibro.mobile.share", "app.aibro.mobile.widget"}
print(json.dumps({
    "archive": str(archive),
    "version": info["CFBundleShortVersionString"],
    "build": info["CFBundleVersion"],
    "minimumIOS": info["MinimumOSVersion"],
    "platform": "iPhoneOS",
    "architecture": "arm64",
    "extensions": identifiers,
    "installation": "Requires valid signing and provisioning before iPhone installation",
}, ensure_ascii=False, indent=2))
