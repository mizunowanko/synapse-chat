#!/bin/sh
# Builds the desktop helper into an .app bundle and signs it
# (docs/design/desktop-mcp.md「helper のビルド」).
#
#   packages/mcp/desktop-helper/build.sh [--debug] [--out <dir>] [--sign <identity>]
#
# Output: <out>/SynapseDesktopHelper.app (default out: packages/mcp/desktop-helper/build).
# --sign (or $SYNAPSE_DESKTOP_SIGN_IDENTITY) signs with a certificate identity
# (e.g. "Apple Development: …", or its SHA-1 from `security find-identity -v
# -p codesigning`): the grants then survive rebuilds. Without it: ad hoc.
# Installs nothing and grants nothing: move the .app where you want it and
# grant Accessibility / Screen Recording by hand in System Settings.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
config=release
out="$here/build"
identity=${SYNAPSE_DESKTOP_SIGN_IDENTITY:-}
while [ $# -gt 0 ]; do
  case "$1" in
    --debug) config=debug ;;
    --out) shift; out=$1 ;;
    --sign) shift; identity=$1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

name=SynapseDesktopHelper
cd "$here"
swift build -c "$config"
bin=$(swift build -c "$config" --show-bin-path)/$name

mkdir -p "$out"
app="$out/$name.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin" "$app/Contents/MacOS/$name"
cp "$here/Info.plist" "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"

# macOS ties the TCC grants to the designated requirement of this signature.
# With a certificate it names the bundle id and the certificate, so a rebuilt
# helper keeps its grants; ad hoc it is the cdhash, so every rebuild must be
# granted again (System Settings → Privacy & Security). No hardened runtime
# and no timestamp: the helper is not notarized and needs no entitlements.
bundle_id=com.mizunowanko.synapse-desktop-helper
if [ -n "$identity" ]; then
  codesign --force --sign "$identity" --timestamp=none --identifier "$bundle_id" "$app"
else
  echo "build.sh: signing ad hoc (pass --sign <identity> to keep the grants across rebuilds)" >&2
  codesign --force --sign - --identifier "$bundle_id" "$app"
fi
codesign --verify --strict "$app"
echo "$app"
