#!/bin/zsh
# Build assets/agent.tar.gz: the sallespro/dsh-dynamic-agent script plus a Linux (aarch64, musl) runtime closure of the
# deepseek-harness (dsh), laid out under /opt/dsh for the Alpine guest:
#   /opt/dsh/lib/bin.js           the dsh launcher         (DSH_BIN)
#   /opt/dsh/node_modules         pruned runtime closure   (linux-arm64-musl natives only)
#   /opt/dsh/home/profiles/sdk    the "sdk" profile        (DSH_HOME=/opt/dsh/home)
#   /opt/dsh/agent                dsh-dynamic-agent.mjs (patched for the current dsh client)
# Needs: git, pnpm 11.7.0, node >= 22, npm, network. The credentials are NOT baked in (see main.rs: --agent).
set -eu
HERE="${0:A:h}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"
export COPYFILE_DISABLE=1
HARNESS_REPO=https://github.com/deepseek-ai/deepseek-harness.git
AGENT_REPO=https://github.com/sallespro/dsh-dynamic-agent.git
NATIVE_VER=0.1.2            # @deepseek-ai/node-addon-system-* prebuilds
W="${BUILD_AGENT_DIR:-$HERE/.build-agent}"
mkdir -p "$W"

clone() { # url dir sha  (pinned to the commits this was tested against)
  local git=(git)
  command -v gh >/dev/null 2>&1 && git=(git -c credential.helper= -c credential.helper='!gh auth git-credential')
  [ -d "$2/.git" ] || "${git[@]}" init -q "$2"
  ( cd "$2" && "${git[@]}" fetch -q --depth 1 "$1" "$3" && "${git[@]}" checkout -q FETCH_HEAD )
}

echo "== sources"
clone $HARNESS_REPO "$W/harness" 639ed015397290b3745d163aafe02ffee4aa3f84
clone $AGENT_REPO "$W/agent-src" 14a5ed52d743ac7e663f559f849b8b07567cd390

echo "== harness: install + build (host)"
cd "$W/harness"
pnpm install --frozen-lockfile
node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.host.json
pnpm exec tsdown --env.DSH_BUILD_FACE host
node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.client.json
pnpm exec tsdown --env.DSH_BUILD_FACE client   # typert-registry / api-gateway come from the client face

echo "== native addon prebuilds (flock: linux glibc+musl)"
rm -rf "$W/native" && mkdir -p "$W/native"
( cd "$W/native" && npm pack "@deepseek-ai/node-addon-system-linux-arm64@$NATIVE_VER" >/dev/null && tar -xzf ./*.tgz )
rm -rf native/system/packages/linux-arm64/bin && cp -R "$W/native/package/bin" native/system/packages/linux-arm64/bin

echo "== pnpm deploy (linux/arm64/musl, no scripts)"
cp pnpm-workspace.yaml "$W/pnpm-workspace.yaml.orig"
trap 'cp "$W/pnpm-workspace.yaml.orig" "$W/harness/pnpm-workspace.yaml"' EXIT
cat >> pnpm-workspace.yaml <<'YAML'

supportedArchitectures:
  os: [linux]
  cpu: [arm64]
  libc: [musl]
nodeLinker: hoisted
allowUnusedPatches: true
ignoreScripts: true
YAML
rm -rf "$W/deploy"
pnpm --filter @deepseek-ai/dsh deploy --prod --legacy "$W/deploy"
cp "$W/pnpm-workspace.yaml.orig" pnpm-workspace.yaml

echo "== stage /opt/dsh"
S="$W/stage"; rm -rf "$S"; mkdir -p "$S/opt"
cp -R "$W/deploy" "$S/opt/dsh"
cd "$S/opt/dsh"
D=node_modules/@deepseek-ai
find . -name .bin -type d -prune -exec rm -rf {} +
# `link:` overrides into vendor/ are symlinks in the deploy; materialize (lib only: vendor nodes carry cyclic node_modules)
rm -f $D/schemastery
for v in cosmokit group hmr logger-console schemastery; do
  n=$(node -e "console.log(require('$W/harness/vendor/$v/package.json').name.split('/')[1])")
  rm -rf $D/$n; mkdir -p $D/$n
  cp "$W/harness/vendor/$v/package.json" $D/$n/; cp -R "$W/harness/vendor/$v/lib" $D/$n/lib
done
# SDK client + protocol (the agent imports them; they are not in the cli's closure)
for p in client protocol; do
  mkdir -p $D/dsh-sdk-$p/lib
  cp "$W/harness/packages/sdk/$p/package.json" $D/dsh-sdk-$p/
  cp "$W/harness/packages/sdk/$p/lib/index.js" $D/dsh-sdk-$p/lib/
done
# prune what the headless agent never loads
rm -rf $D/libreoffice-kit-wasm node_modules/sherpa-onnx* node_modules/@img/sharp-libvips-linux-arm64 node_modules/@img/sharp-linux-arm64
for d in win32-arm64 win32-x64 darwin-x64 darwin-arm64 linux-x64; do rm -rf node_modules/node-pty/prebuilds/$d; done
find . \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -iname 'README*' -o -iname 'CHANGELOG*' \) -type f -delete

echo "== close workspace-package gaps (peer/dev-declared packages imported at runtime)"
node "$HERE/agent/closure.mjs" "$S/opt/dsh" "$W/harness"
# supports-color (used by the vendored console logger) is pure JS
sc=$(ls -d "$W"/harness/node_modules/.pnpm/supports-color@9.* | head -1)
[ -d node_modules/supports-color ] || cp -RL "$sc/node_modules/supports-color" node_modules/supports-color
find node_modules/supports-color \( -name '*.d.ts' -o -iname 'readme*' \) -delete
find . -type l | grep -v '^$' && { echo "unexpected symlinks left (tar_ro dislikes them)" >&2; exit 1; } || true

echo "== profile + agent"
mkdir -p home/profiles/sdk agent
cp "$HERE/agent/profile-package.json" home/profiles/sdk/package.json
printf '# Your patch layer for this dsh profile.\n[]\n' > home/profiles/sdk/cordis.patch.yml
printf '# dsh profile root\n[]\n' > home/profiles/sdk/cordis.yml
printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > home/profiles/sdk/pnpm-workspace.yaml
cp "$W/agent-src/dsh-dynamic-agent.mjs" agent/dsh-dynamic-agent.mjs
node "$HERE/agent/patch-agent.mjs" agent/dsh-dynamic-agent.mjs

echo "== pack"
mkdir -p "$HERE/assets"
# opt/dsh only (no `opt/` entry: it already exists in the base rootfs and duplicate dirs clobber each other)
tar -czf "$HERE/assets/agent.tar.gz" -C "$S" opt/dsh
ls -la "$HERE/assets/agent.tar.gz"
