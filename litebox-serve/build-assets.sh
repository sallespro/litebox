#!/bin/zsh
# Rebuild assets/rootfs.tar.gz (node:alpine + htop/socat/ncurses + /dash dashboard) and assets/runner.gz.
# Run this after changing anything under dashboard/ or the LiteBox runner, then `cargo build --release`.
set -eu
HERE="${0:A:h}"; cd "$HERE"
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
LB="$HERE/.."
ALPINE=v3.24
MIRROR=https://dl-cdn.alpinelinux.org/alpine/$ALPINE/main/aarch64
PKGS=(htop socat libncursesw ncurses-terminfo-base readline)   # libssl/libcrypto/zlib already in node:alpine
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT

echo "== base rootfs"
"$LB/target/release/litebox_packager" --oci-image docker.io/library/node:alpine --no-rewrite-all -o "$W/base.tar" | tail -1

echo "== alpine packages"
curl -sfL $MIRROR/APKINDEX.tar.gz | tar -xzf - -C "$W" APKINDEX
mkdir "$W/root"
for p in $PKGS; do
  v=$(awk -v RS= -v p="$p" '$0 ~ "(^|\n)P:"p"\n"' "$W/APKINDEX" | sed -n 's/^V://p')
  [ -n "$v" ] || { echo "package $p not found" >&2; exit 1; }
  curl -sfL "$MIRROR/$p-$v.apk" | tar -xzf - -C "$W/root" --exclude='.*' 2>/dev/null || true
done
# file entries only (directory entries and duplicates make LiteBox's tar reader panic), nothing already in the base
tar -tf "$W/base.tar" | sed 's|/$||;s|^\./||' | sort > "$W/base.lst"
( cd "$W/root" && find . \( -type f -o -type l \) -not -path './usr/share/*' | sed 's|^\./||' | sort ) > "$W/extra.all"
comm -23 "$W/extra.all" "$W/base.lst" > "$W/extra.lst"
tar -rf "$W/base.tar" -C "$W/root" -T "$W/extra.lst"

echo "== dashboard"
mkdir "$W/stage"; cp -R dashboard "$W/stage/dash"
tar -rf "$W/base.tar" -C "$W/stage" dash

gzip -9 -c "$W/base.tar" > assets/rootfs.tar.gz
gzip -9 -c "$LB/target/release/litebox_runner_linux_on_macos_userland" > assets/runner.gz
ls -la assets
