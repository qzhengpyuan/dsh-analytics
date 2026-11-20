#!/bin/bash
# Build the macOS engine from source against Homebrew dependencies.
#
# There is no PSPP formula in Homebrew, so the engine is compiled from the GNU
# release tarball. Every library reference is then rewritten to @loader_path by
# scripts/bundle-engine.mjs, which is what keeps the engine working without
# Homebrew and without DYLD_LIBRARY_PATH (SIP strips it for system binaries).
#
#   scripts/build-engine-macos.sh [--platform darwin-arm64]
#
# Must run on macOS: install_name_tool is part of Xcode command line tools.
set -euo pipefail

cd "$(dirname "$0")/.."
root=$(pwd)

platform=""
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) platform=$2; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "this build must run on macOS" >&2
  exit 1
fi
if [ -z "$platform" ]; then
  case "$(uname -m)" in
    arm64) platform=darwin-arm64 ;;
    x86_64) platform=darwin-x64 ;;
    *) echo "unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
  esac
fi

work="$root/build"
prefix="$work/engine-prefix-$platform"
mkdir -p "$work" "$prefix"

echo "== deps =="
brew install gsl libxml2 readline gettext cairo pango glib gmp pkg-config

# Apple Silicon installs Homebrew under /opt/homebrew, which is not on the
# default include or library search path, so configure's probes need it spelled
# out — without this the gsl check fails on libgslcblas only on arm64.
brew_prefix=$(brew --prefix)
export PKG_CONFIG_PATH="$brew_prefix/lib/pkgconfig:$(brew --prefix libxml2)/lib/pkgconfig:$(brew --prefix readline)/lib/pkgconfig"
export CPPFLAGS="-I$brew_prefix/include -I$(brew --prefix libxml2)/include -I$(brew --prefix readline)/include"
export LDFLAGS="-L$brew_prefix/lib -L$(brew --prefix libxml2)/lib -L$(brew --prefix readline)/lib"

echo "== source =="
[ -f "$work/pspp.tar.gz" ] || curl -fL --retry 3 -o "$work/pspp.tar.gz" https://ftp.gnu.org/gnu/pspp/pspp-2.1.3.tar.gz
rm -rf "$work/pspp-2.1.3"
tar -C "$work" -xzf "$work/pspp.tar.gz"

echo "== configure/build =="
cd "$work/pspp-2.1.3"
./configure --prefix="$prefix" --without-gui --without-perl-module \
            --disable-silent-rules MAKEINFO=true
make -j"$(sysctl -n hw.ncpu)"
make install
mkdir -p "$prefix/share/doc/pspp"
cp COPYING "$prefix/share/doc/pspp/COPYING"

cd "$root"
node scripts/bundle-engine.mjs --from-prefix "$prefix" --platform "$platform"
echo "done: engine/$platform"
