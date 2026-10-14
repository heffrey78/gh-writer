#!/bin/sh
# Build the Arch package from the desktop app's .deb (see PKGBUILD).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
version=$(sed -n 's/^pkgver=//p' "$here/PKGBUILD")
cd "$here/.."
npx tauri build --bundles deb
ln -sf "../src-tauri/target/release/bundle/deb/gh-writer_${version}_amd64.deb" "$here/"
cd "$here"
makepkg --force --cleanbuild
