#!/bin/bash
# Build the Linux engine from source inside an AlmaLinux 8 container.
#
# AlmaLinux 8 ships glibc 2.28, so a PSPP built there runs on every
# distribution from that era onwards (RHEL/Alma/Rocky 8+, Ubuntu 18.10+,
# Debian 10+, openSUSE Leap 15+). Building on a current Fedora would raise the
# floor to that glibc (2.43) and make the engine unusable everywhere else.
#
#   scripts/build-engine-almalinux8.sh [--platform linux-x64] [--image ...]
#                                      [--engine-arch amd64|arm64]
#
# Requires podman (or docker) and network access to fetch the PSPP tarball and
# the distribution packages. The compiled prefix is left in
# build/engine-prefix/ and then imported into engine/<platform>/ by
# scripts/bundle-engine.mjs.
#
# On a non-native architecture the container runs under emulation (binfmt), so
# an arm64 engine can be produced on an x86_64 host, just slowly.
set -euo pipefail

cd "$(dirname "$0")/.."
root=$(pwd)

platform=linux-x64
image=docker.io/library/almalinux:8
engine_arch=""
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) platform=$2; shift 2 ;;
    --image) image=$2; shift 2 ;;
    --engine-arch) engine_arch=$2; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

work="$root/build/engine-prefix"
mkdir -p "$work"

if command -v podman >/dev/null 2>&1; then
  runtime=podman
  # podman on an SELinux host needs the relabel suffix; docker rejects it.
  # It is a separate option after the target path, so a read-only mount needs
  # ":ro,Z" while a plain one needs ":Z" — not a comma in both cases.
  dir_opts=":Z"
  file_opts=":ro,Z"
elif command -v docker >/dev/null 2>&1; then
  runtime=docker
  dir_opts=""
  file_opts=":ro"
else
  echo "neither podman nor docker found" >&2
  exit 1
fi

host_arch=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
platform_flag=""
if [ -n "$engine_arch" ] && [ "$engine_arch" != "$host_arch" ]; then
  case "$engine_arch" in
    arm64) image_platform=linux/arm64/v8 ;;
    *) image_platform="linux/$engine_arch" ;;
  esac
  platform_flag="--platform $image_platform"
  if [ "$runtime" = docker ]; then
    # binfmt handlers, so the emulated prefix can also be executed for the
    # bundler's version probe and the smoke test.
    docker run --privileged --rm tonistiigi/binfmt --install "$engine_arch" >/dev/null
  fi
fi

echo "building PSPP in $image (artifacts: $work)"
# shellcheck disable=SC2086
"$runtime" run --rm $platform_flag \
  -v "$work:/work/out$dir_opts" \
  -v "$root/scripts/build-pspp-inner.sh:/build/build-pspp.sh$file_opts" \
  "$image" bash /build/build-pspp.sh

node "$root/scripts/bundle-engine.mjs" --from-prefix "$work" --platform "$platform"
echo
echo "done: engine/$platform"
echo "verify: engine/$platform/bin/pspp --version && npm test"
