#!/bin/sh
# One-time setup, run by the user: creates a self-signed code signing identity
# "AI Bro Local Signing" in the login keychain. Builds signed with it keep the
# same designated requirement across versions, so macOS keeps Accessibility,
# microphone and other privacy grants after an update instead of asking again.
#
# What it changes: imports one certificate + private key into the login
# keychain (only /usr/bin/codesign may use the key) and marks the certificate
# trusted for code signing for this user. macOS asks for your login password
# once for the trust change. Nothing is uploaded anywhere.
#
# Undo: Keychain Access > login > My Certificates > "AI Bro Local Signing" > Delete.
set -eu
NAME="AI Bro Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
OPENSSL=/usr/bin/openssl
if /usr/bin/security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo "\"$NAME\" already exists and is valid for code signing."; exit 0
fi
if /usr/bin/security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "A certificate named \"$NAME\" exists but is not a valid signing identity." >&2
  echo "Delete it in Keychain Access (login > My Certificates) and run this again." >&2
  exit 1
fi
TMP=$(mktemp -d "${TMPDIR:-/tmp}/aibro-signing.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
umask 077
cat > "$TMP/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF
"$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -config "$TMP/cert.cnf" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null
# Throwaway passphrase: only protects the .p12 between export and import.
PASS=$("$OPENSSL" rand -hex 16)
"$OPENSSL" pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" \
  -out "$TMP/identity.p12" -passout "pass:$PASS" 2>/dev/null
/usr/bin/security import "$TMP/identity.p12" -k "$KEYCHAIN" -f pkcs12 -P "$PASS" -T /usr/bin/codesign
/usr/bin/security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"
if /usr/bin/security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo "Done. Builds from scripts/build-native-app.sh now sign with \"$NAME\"."
else
  echo "Imported, but macOS does not list \"$NAME\" as a valid signing identity yet." >&2
  exit 1
fi
