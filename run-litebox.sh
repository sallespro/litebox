#!/bin/zsh
# Run a Linux (aarch64) program under LiteBox on Apple Silicon via the HVF backend.
#
# Usage:
#   ./run-litebox.sh                      # interactive-ish: runs /bin/sh -c 'uname -a; cat /etc/os-release'
#   ./run-litebox.sh /bin/echo hi         # run a program from the Alpine image
#   ./run-litebox.sh --rebuild ...        # force rebuild + re-sign + re-package first
#   ./run-litebox.sh --diag               # run the HVF self-checks only
#
# Env overrides: LITEBOX_IMAGE (default docker.io/library/alpine:latest)
set -eu

ROOT="${0:A:h}"
cd "$ROOT"

# Xcode's toolchain is broken on this machine; use the Command Line Tools + macOS 26.5 SDK.
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
export SDKROOT=$DEVELOPER_DIR/SDKs/MacOSX26.5.sdk
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

RUNNER=target/release/litebox_runner_linux_on_macos_userland
PACKAGER=target/release/litebox_packager
TAR=guest-rootfs.tar
IMAGE="${LITEBOX_IMAGE:-docker.io/library/alpine:latest}"

REBUILD=0
if [ "${1:-}" = "--rebuild" ]; then REBUILD=1; shift; fi

if [ $REBUILD = 1 ] || [ ! -x "$RUNNER" ] || [ ! -x "$PACKAGER" ]; then
  cargo build --release --locked -p litebox_runner_linux_on_macos_userland -p litebox_packager
  codesign --force --options runtime --sign - \
    --entitlements litebox_runner_linux_on_macos_userland/entitlements.plist "$RUNNER"
fi

if [ "${1:-}" = "--diag" ]; then
  "$RUNNER" --unstable --hvf-boundary >/dev/null && echo "hvf-boundary OK"
  "$RUNNER" --unstable --hvf-memory   >/dev/null && echo "hvf-memory OK"
  exit 0
fi

# Stock (unrewritten) binaries: the HVF backend needs no syscall rewriting.
if [ $REBUILD = 1 ] || [ ! -f "$TAR" ]; then
  "$PACKAGER" --oci-image "$IMAGE" --no-rewrite-all -o "$TAR"
fi

if [ $# -eq 0 ]; then
  set -- /bin/sh -c 'uname -a; cat /etc/os-release | head -2'
fi

exec "$RUNNER" --unstable --hvf --initial-files "$TAR" "$@"
