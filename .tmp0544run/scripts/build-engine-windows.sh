#!/bin/bash
# Build the Windows engine from source inside an MSYS2 MINGW64 shell.
#
# Upstream PSPP does not ship Windows binaries and MSYS2 has no pspp package,
# so this compiles the GNU release tarball with the mingw-w64 toolchain, then
# copies the DLLs the three tools actually need next to them. The bundler wraps
# them in `bin/pspp.cmd`, which prepends `lib/` to PATH because Windows has no
# LD_LIBRARY_PATH equivalent.
#
#   scripts/build-engine-windows.sh [--platform win32-x64]
#
# Run from an MSYS2 MINGW64 shell (CI uses msys2/setup-msys2). Node must be on
# PATH (the command-line tools work unchanged on Windows).
set -euo pipefail

cd "$(dirname "$0")/.."
root=$(pwd)

platform=win32-x64
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) platform=$2; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

case "$(uname -s)" in
  MSYS_NT*|MINGW64_NT*) ;;
  *) echo "this build must run in an MSYS2 MINGW64 shell" >&2; exit 1 ;;
esac

work="$root/build"
prefix="$work/engine-prefix-win"
mkdir -p "$work" "$prefix"

echo "== source =="
[ -f "$work/pspp.tar.gz" ] || curl -fL --retry 3 -o "$work/pspp.tar.gz" https://ftp.gnu.org/gnu/pspp/pspp-2.1.3.tar.gz
rm -rf "$work/pspp-2.1.3"
tar -C "$work" -xzf "$work/pspp.tar.gz"

echo "== configure/build =="
cd "$work/pspp-2.1.3"
./configure --prefix="$(cygpath -m "$prefix")" --without-gui --without-perl-module \
            --disable-silent-rules MAKEINFO=true
make -j"$(nproc)"
make install
mkdir -p "$prefix/share/doc/pspp"
cp COPYING "$prefix/share/doc/pspp/COPYING"

cd "$root"
echo "== bundle =="
# DLL collection is the bundler's job: it walks the import closure with ldd and
# skips the Windows system DLLs. Doing it here as well used to fail the job when
# a glob found nothing.
# The bundler is Node, so it needs a Windows-style path for the prefix.
node scripts/bundle-engine.mjs --from-prefix "$(cygpath -w "$prefix")" --platform "$platform"
echo "done: engine/$platform"
