#!/bin/bash
# Inner half of the Linux engine build: runs INSIDE an AlmaLinux 8 container.
#
# Mounted at /build/build-pspp.sh, writes the installed prefix to /work/out, and
# is driven by scripts/build-engine-almalinux8.sh locally and by
# .github/workflows/build-engine.yml in CI.
#
# AlmaLinux 8 ships glibc 2.28, which is what lowers the engine's runtime floor
# from 2.43 (a current Fedora) to something every distribution since 2018 has.
set -uo pipefail

echo "== os =="; cat /etc/almalinux-release; echo "glibc: $(rpm -q glibc)"; nproc

echo "== deps =="
dnf -y install --setopt=install_weak_deps=False \
  gcc gcc-c++ make tar gzip which findutils diffutils python3 \
  gsl-devel readline-devel ncurses-devel libxml2-devel zlib-devel \
  cairo-devel pango-devel glib2-devel gmp-devel gettext > /tmp/dnf.log 2>&1
echo "dnf rc=$?"
[ $? -eq 0 ] || tail -20 /tmp/dnf.log

echo "== source =="
cd /tmp
# Tsinghua mirrors GNU byte for byte and is far faster from this region; the
# canonical GNU host is the fallback for CI runners outside China.
curl -fsSL --retry 3 -o pspp.tar.gz https://mirrors.tuna.tsinghua.edu.cn/gnu/pspp/pspp-2.1.3.tar.gz \
  || curl -fsSL --retry 3 -o pspp.tar.gz https://ftp.gnu.org/gnu/pspp/pspp-2.1.3.tar.gz
rm -rf pspp-2.1.3 && tar xzf pspp.tar.gz && cd pspp-2.1.3

echo "== configure =="
# MAKEINFO=true: AlmaLinux 8 has no texinfo package, so let configure skip the
# manual instead of failing on a makeinfo feature probe.
# --without-gui: the plugin drives the CLI and renders its own dialogs.
./configure --prefix=/work/out --without-gui --without-perl-module \
            --disable-silent-rules MAKEINFO=true > /tmp/configure.log 2>&1
rc=$?; echo "configure rc=$rc"
[ $rc -eq 0 ] || { tail -40 /tmp/configure.log; exit 1; }

echo "== make =="
make -j"$(nproc)" > /tmp/make.log 2>&1
rc=$?; echo "make rc=$rc"
[ $rc -eq 0 ] || { tail -40 /tmp/make.log; exit 1; }

echo "== install =="
make install > /tmp/install.log 2>&1 && echo "install rc=0"

# make install does not ship the licence text; the bundler looks for it here.
mkdir -p /work/out/share/doc/pspp
cp COPYING /work/out/share/doc/pspp/COPYING

# libtool installs PSPP's own libraries into lib/pspp/ and hardcodes that path
# as an RPATH. Flatten them into lib/ so the bundler sees one directory and the
# launcher's LD_LIBRARY_PATH is enough.
if [ -d /work/out/lib/pspp ]; then
  # -type f skips the unversioned dev symlinks (libpspp.so -> libpspp-2.1.3.so).
  find /work/out/lib/pspp -maxdepth 1 -type f -name '*.so*' -exec mv -t /work/out/lib/ {} +
  rm -rf /work/out/lib/pspp
fi

# Static libraries and libtool files are build residue, not runtime payload.
rm -f /work/out/lib/*.a /work/out/lib/*.la /work/out/lib/*.lai
for f in /work/out/lib/*.so*; do strip --strip-unneeded "$f" 2>/dev/null || true; done
strip --strip-unneeded /work/out/bin/* 2>/dev/null || true

# Vendored dependencies (GSL, Cairo, Pango, ...) live in the distribution, not
# in the prefix. Pull in whatever the three tools resolve to, so the prefix is
# self-contained and the bundler can run the executables on a foreign host.
echo "== collect dependency libraries =="
for tool in pspp pspp-convert pspp-output; do
  [ -f "/work/out/bin/$tool" ] || continue
  LD_LIBRARY_PATH=/work/out/lib ldd "/work/out/bin/$tool" | awk '/=> \//{print $3}'
done | sort -u | grep -vE '/(ld-linux|libc\.so|libm\.so|libdl\.so|libpthread\.so|librt\.so|libresolv\.so|libutil\.so|libanl\.so|libmvec\.so|libnss_)' | while read -r lib; do
  target="/work/out/lib/$(basename "$lib")"
  [ -e "$target" ] || cp "$lib" "$target"
done
ls /work/out/lib | wc -l | sed 's/^/libraries: /'

echo "== check =="
LD_LIBRARY_PATH=/work/out/lib /work/out/bin/pspp --version | head -1
for f in /work/out/lib/*.so*; do
  objdump -T "$f" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1
done | sort -V | tail -1 | sed 's/^/max glibc: /'
