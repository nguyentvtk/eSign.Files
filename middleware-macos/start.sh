#!/bin/bash
# Khởi động middleware ký số VGCA. Tự biên dịch phần native nếu cần.
set -e
cd "$(dirname "$0")"

if [ ! -x native/pcsc-pipe ] || [ native/pcsc-pipe.c -nt native/pcsc-pipe ]; then
  echo "Đang biên dịch cầu nối PC/SC…"
  cc -O2 -arch arm64 -framework PCSC -o native/pcsc-pipe native/pcsc-pipe.c
fi

exec node index.js
