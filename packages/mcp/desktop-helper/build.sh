#!/bin/sh
# Builds the desktop helper into an .app bundle and signs it ad hoc
# (docs/design/desktop-mcp.md「helper のビルド」).
#
#   packages/mcp/desktop-helper/build.sh [--debug] [--out <dir>]
#
# Output: <out>/SynapseDesktopHelper.app (default out: packages/mcp/desktop-helper/build).
# Installs nothing and grants nothing: move the .app where you want it and
# grant Accessibility / Screen Recording by hand in System Settings.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
config=release
out="$here/build"
while [ $# -gt 0 ]; do
  case "$1" in
    --debug) config=debug ;;
    --out) shift; out=$1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# Ad hoc: macOS ties the TCC grants to this signature, so a rebuilt helper
# must be granted again (System Settings → Privacy & Security).
codesign --force --sign - --identifier com.mizunowanko.synapse-desktop-helper "$app"
codesign --verify --strict "$app"
echo "$app"
