#!/bin/bash
# Khởi động middleware ký số VGCA.
# Cầu nối PC/SC được lib/card.js tự biên dịch khi cần, không phải lo ở đây.
set -e
cd "$(dirname "$0")"
exec node index.js
