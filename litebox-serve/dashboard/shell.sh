#!/bin/sh
# Terminal 2: an interactive shell. Runs under a PTY provided by socat.
stty rows ${ROWS:-30} cols ${COLS:-80} 2>/dev/null
echo $$ > /tmp/term-shell.pid
export TERM=xterm-256color HOME=/home/node
export PS1="$(printf '\033[1;32m')alpine$(printf '\033[0m'):\\w\\$ "
cd "$HOME" 2>/dev/null
echo "Alpine $(cat /etc/alpine-release) on $(uname -m), running under LiteBox"
exec /bin/sh -i
