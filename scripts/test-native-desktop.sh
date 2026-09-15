#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/aibro-desktop-check.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
cd "$ROOT"
node - "$TEST_DIR/legacy.txt" <<'JS'
const c=require('crypto'),fs=require('fs');const key=c.pbkdf2Sync('synthetic-password','saltysalt',1003,16,'sha1'),cipher=c.createCipheriv('aes-128-cbc',key,Buffer.alloc(16,32));fs.writeFileSync(process.argv[2],Buffer.concat([Buffer.from('v10'),cipher.update('synthetic credential record'),cipher.final()]).toString('base64'));
JS
xcrun swiftc native/Sources/AIBro/AgendaCore.swift native/Sources/AIBro/NativeCredentials.swift tests/native-credentials.swift -o "$TEST_DIR/credentials"
"$TEST_DIR/credentials" "$TEST_DIR/legacy.txt"
node --test tests/native-desktop.test.cjs
