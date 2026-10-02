# litebox-serve

A single macOS (Apple Silicon) binary that runs a Node.js web server inside an Alpine aarch64 Linux guest
under LiteBox, using the Hypervisor.framework (`--hvf`) backend, and exposes it to the host browser.

```
litebox-serve              # Alpine dashboard: htop + shell terminals (webjsx + AnEntrypoint design)
litebox-serve <dir>        # serve <dir> as a static website
litebox-serve --selftest / # in-guest smoke test, no sudo / no network interface
```

Open http://10.0.0.2:8080. The guest is reached through a host `utun` interface (needs `sudo`).
The dashboard gives anyone who can reach that address a shell in the guest.

## Build

Requires Apple Silicon, macOS 26+ SDK, and Rust. From the repo root:

```sh
cargo build --release --locked -p litebox_runner_linux_on_macos_userland -p litebox_packager
cd litebox-serve
./build-assets.sh            # node:alpine + htop/socat + dashboard -> assets/*.gz
cargo build --release        # embeds the assets -> target/release/litebox-serve
```

If Xcode's toolchain is broken, build with `DEVELOPER_DIR=/Library/Developer/CommandLineTools` and a
macOS 26.x `SDKROOT` (see `../run-litebox.sh`).

Other helpers at the repo root: `run-litebox.sh` (run any program from an Alpine image) and
`serve-node.sh` (minimal Node server demo).
