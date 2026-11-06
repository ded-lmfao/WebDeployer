#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "==================================================="
echo "     WebDep - Multi-Website Hosting Platform"
echo "==================================================="
echo ""

if [ ! -f "target/release/webdep" ]; then
    echo "[*] Compiling optimized release binary..."
    cargo build --release
fi

PORT="${PORT:-4600}"
URL="http://127.0.0.1:${PORT}"

echo "[*] Starting WebDep server on ${URL}"
echo "[*] SQLite Database: data/webdep.sqlite"
echo "[*] Default Credentials:"
echo "    - Username: admin"
echo "    - Password: admin123"
echo ""

# Try opening default browser
if command -v xdg-open &> /dev/null; then
    (sleep 1 && xdg-open "${URL}") &
elif command -v open &> /dev/null; then
    (sleep 1 && open "${URL}") &
fi

exec ./target/release/webdep
