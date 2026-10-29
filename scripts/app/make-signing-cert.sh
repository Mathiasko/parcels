#!/bin/bash
# Creates the self-signed code-signing identity "Parcels Signing" in the login keychain
# (valid 3650 days), once. Prints the leaf certificate's SHA-256 and writes it, as bare
# lowercase hex, to app/signing-cert.sha256.
#
# Runs without a password prompt: the key is imported with an ACL that lets
# /usr/bin/codesign use it. The certificate is NOT marked as trusted; codesign signs with
# an untrusted self-signed identity, and `security find-identity -v` hides it (use
# `security find-identity -p codesigning` without -v to see it).
#
# Usage: scripts/app/make-signing-cert.sh
set -euo pipefail

NAME="Parcels Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/app/signing-cert.sha256"
# LibreSSL ships with macOS and writes PKCS#12 files that `security import` accepts.
OPENSSL=/usr/bin/openssl

cert_sha256() {
  security find-certificate -c "$NAME" -Z "$KEYCHAIN" \
    | awk '/^SHA-256 hash:/ { print tolower($3); exit }'
}

if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "\"$NAME\" already exists in the login keychain; not creating it again."
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  cat >"$TMP/req.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

  "$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -config "$TMP/req.cnf" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null

  PASS="$("$OPENSSL" rand -hex 16)"
  "$OPENSSL" pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
    -name "$NAME" -passout "pass:$PASS" -out "$TMP/id.p12"

  security import "$TMP/id.p12" -k "$KEYCHAIN" -f pkcs12 -P "$PASS" -T /usr/bin/codesign
  echo "Created \"$NAME\" in the login keychain."
fi

SHA="$(cert_sha256)"
if [ -z "$SHA" ]; then
  echo "Could not read the SHA-256 of \"$NAME\"." >&2
  exit 1
fi
mkdir -p "$(dirname "$OUT")"
printf '%s\n' "$SHA" >"$OUT"
echo "SHA-256: $SHA"
echo "Written to app/signing-cert.sha256. Commit it."
