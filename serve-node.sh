#!/bin/zsh
# Run app/server.js (Node, in an Alpine guest under LiteBox) and make it reachable from the host browser.
#
#   ./serve-node.sh            # then open http://10.0.0.2:8080
#   ./serve-node.sh --rebuild  # re-pull the node image and re-add ./app
#
# Networking: the guest gets a host `utun` interface (needs root, so you'll be asked for sudo).
# Host side is 10.0.0.1, guest side is 10.0.0.2 (LiteBox's defaults).
set -eu
ROOT="${0:A:h}"; cd "$ROOT"

export DEVELOPER_DIR=/Library/Developer/CommandLineTools
export SDKROOT=$DEVELOPER_DIR/SDKs/MacOSX26.5.sdk
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

RUNNER=target/release/litebox_runner_linux_on_macos_userland
PACKAGER=target/release/litebox_packager
TAR=node-rootfs.tar
IFACE=utun9            # high number to avoid clashing with VPN utuns
HOST_IP=10.0.0.1
GUEST_IP=10.0.0.2
PORT="${PORT:-8080}"

[ -x "$RUNNER" ] && [ -x "$PACKAGER" ] || ./run-litebox.sh --rebuild >/dev/null

if [ "${1:-}" = "--rebuild" ] || [ ! -f "$TAR" ]; then
  rm -f "$TAR"
  "$PACKAGER" --oci-image docker.io/library/node:alpine --no-rewrite-all -o "$TAR"
  tar -rf "$TAR" -C "$ROOT" app      # add the app dir (app/server.js) to the guest rootfs
fi

echo "Requesting sudo (needed to create the $IFACE network interface)..."
sudo -v

sudo "$RUNNER" --unstable --hvf --guest-ip "$GUEST_IP" --gateway-ip "$HOST_IP" \
  --tun-device-name "$IFACE" --initial-files "$TAR" \
  --env "PORT=$PORT" /usr/local/bin/node /app/server.js &
RPID=$!
trap 'sudo kill $RPID 2>/dev/null; wait $RPID 2>/dev/null; exit' INT TERM EXIT

for _ in {1..50}; do ifconfig "$IFACE" >/dev/null 2>&1 && break; sleep 0.2; done
sudo ifconfig "$IFACE" "$HOST_IP" "$GUEST_IP" up
echo "\n==> Open http://$GUEST_IP:$PORT in your browser (Ctrl-C to stop)\n"
wait $RPID
