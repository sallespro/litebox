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

## Running the dsh agent (`--agent`)

```sh
echo 'OPENAI_API_KEY=sk-...' > .env          # next to the binary (or pass --env-file FILE)
./litebox-serve --agent "fetch https://example.com and summarize it"
```

Runs [sallespro/dsh-dynamic-agent](https://github.com/sallespro/dsh-dynamic-agent) inside the Alpine guest and prints the
answer. No sudo and no utun: the guest reaches OpenAI and the web through LiteBox's rootless outbound proxy
(`--net-proxy`). The `.env` is staged as a file in a private temp dir (never on a command line) and deleted afterwards;
it is not embedded in the binary.

`./build-agent.sh` builds `assets/agent.tar.gz` (pinned deepseek-harness + agent commits): it builds the harness on the
host, `pnpm deploy`s a linux/arm64/musl runtime closure, fills in workspace packages the deploy omits, prunes it and lays
it out under `/opt/dsh`. The agent script gets one patch (`agent/patch-agent.mjs`): the current dsh SDK client no longer
reads the `launch:` option the script used, so it silently started a stock dsh with no OpenAI route.

LiteBox needed one fix for this: `msync` was unimplemented, and the harness's native "require builtin" addon uses it as a
pointer-validity probe (`litebox_shim_linux::sys_msync`). The guest runs with `--guest-root` so the harness home is writable.
