#!/bin/bash
# Creates the code signing certificate "MacAIterm Local Signing" ONCE on this Mac and puts it into your login keychain, so every
# build of the app is signed with the same identity (see docs/SIGNING.md for why: macOS permissions follow the app's identity).
#
#   scripts/make-signing-cert.sh          run it yourself in Terminal
#
# macOS may open a window asking for your login password or Touch ID (to let the keychain accept the key): type it THERE, this script
# never sees it. It changes no trust settings and needs no administrator rights. The certificate is valid for 10 years.
# Back it up afterwards (docs/SIGNING.md): the private key lives only in your keychain.
set -eu
NAME="${AIT_SIGN_IDENTITY:-MacAIterm Local Signing}"
KEYCHAIN="${AIT_SIGN_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
OSSL=/usr/bin/openssl   # macOS's own LibreSSL: its .p12 is the kind `security import` accepts (Homebrew's OpenSSL 3 writes one macOS rejects)

[ -x "$OSSL" ] || { echo "ERROR: $OSSL not found" >&2; exit 1; }
if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "\"$NAME\""; then
  echo "\"$NAME\" already exists in the keychain. Nothing to do."
  security find-identity -p codesigning "$KEYCHAIN" | grep "\"$NAME\"" | sed -E 's/^ *[0-9]+\) *//'
  exit 0
fi

umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/openssl.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $NAME
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
CNF
"$OSSL" req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -days 3650 -config "$tmp/openssl.cnf" >/dev/null 2>&1
pw="$("$OSSL" rand -hex 16)"   # a throw-away password for the temporary file only
"$OSSL" pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$NAME" -out "$tmp/cert.p12" -passout "pass:$pw" >/dev/null 2>&1

echo "Importing the certificate into $KEYCHAIN ..."
echo "(if macOS asks for your password or Touch ID, answer in the macOS window)"
security import "$tmp/cert.p12" -k "$KEYCHAIN" -P "$pw" -T /usr/bin/codesign >/dev/null

if security find-identity -p codesigning "$KEYCHAIN" | grep -q "\"$NAME\""; then
  echo
  echo "Done: \"$NAME\" is in the keychain."
  echo "  - The first build may show a window \"codesign wants to use the key\": enter your login password and choose Always Allow."
  echo "  - Build as usual (npm run dist); the build says which identity it used."
  echo "  - Back the key up (Keychain Access > My Certificates > \"$NAME\" > Export), see docs/SIGNING.md."
else
  echo "ERROR: the certificate was not found after the import." >&2
  exit 1
fi
