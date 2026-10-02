#!/bin/sh
# Terminal 1: htop. Runs under a PTY provided by socat.
stty rows ${ROWS:-30} cols ${COLS:-80} 2>/dev/null
echo $$ > /tmp/term-htop.pid
export TERM=xterm-256color HOME=/home/node
exec /usr/bin/htop
