#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"
APP_DIR="$(pwd)"

echo "==================================================="
echo "     WebDep - Multi-Website Hosting Platform"
echo "==================================================="
echo ""

MODE="${1:-foreground}"

if [ "$MODE" = "--stop" ] || [ "$MODE" = "stop" ]; then
    echo "[*] Stopping WebDep..."
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet webdep 2>/dev/null; then
        sudo systemctl stop webdep
        echo "[+] Stopped systemd service 'webdep'."
    fi
    pkill -f "target/release/webdep" 2>/dev/null || true
    echo "[+] WebDep stopped."
    exit 0
fi

# Ensure .env exists and binds to 0.0.0.0 for VPS access
if [ ! -f ".env" ]; then
    cp .env.example .env 2>/dev/null || true
fi
if grep -q "^HOST=127.0.0.1" .env 2>/dev/null; then
    sed -i 's/^HOST=127.0.0.1/HOST=0.0.0.0/' .env
fi

# Ensure Rust toolchain is installed on VPS if binary needs compilation
if [ ! -f "target/release/webdep" ]; then
    if ! command -v cargo >/dev/null 2>&1; then
        echo "[*] Rust (cargo) not found. Installing build essentials & Rust toolchain..."
        if command -v apt-get >/dev/null 2>&1; then
            sudo apt-get update -y && sudo apt-get install -y curl build-essential pkg-config libssl-dev git
        elif command -v dnf >/dev/null 2>&1; then
            sudo dnf install -y curl gcc make pkgconfig openssl-devel git
        fi
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        # shellcheck disable=SC1090
        source "$HOME/.cargo/env"
    fi
    echo "[*] Compiling optimized Linux release binary (target/release/webdep)..."
    cargo build --release
fi

chmod +x target/release/webdep
mkdir -p data/logs

PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d'=' -f2 | tr -d '[:space:]')
PORT="${PORT:-4600}"
PUBLIC_IP=$(curl -s --max-time 2 https://api.ipify.org || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")

if [ "$MODE" = "--service" ] || [ "$MODE" = "service" ]; then
    echo "[*] Installing systemd service (/etc/systemd/system/webdep.service)..."
    SERVICE_USER="${SUDO_USER:-$(whoami)}"
    sudo tee /etc/systemd/system/webdep.service >/dev/null <<EOF
[Unit]
Description=WebDep Multi-Website Deployment & Hosting Platform
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/target/release/webdep
Restart=always
RestartSec=3
Environment=RUST_LOG=webdep=info

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable webdep
    sudo systemctl restart webdep
    echo ""
    echo "[+] WebDep is now running 24/7 as a systemd service!"
    echo "    - Panel URL:  http://${PUBLIC_IP}:${PORT}"
    echo "    - Status:     sudo systemctl status webdep"
    echo "    - Logs:       sudo journalctl -u webdep -f"
    exit 0
fi

if [ "$MODE" = "--daemon" ] || [ "$MODE" = "-d" ] || [ "$MODE" = "daemon" ] || [ "$MODE" = "start" ]; then
    pkill -f "target/release/webdep" 2>/dev/null || true
    nohup ./target/release/webdep > data/logs/webdep-server.log 2>&1 &
    PID=$!
    echo "[+] WebDep started in background (PID: ${PID})"
    echo "    - Panel URL:  http://${PUBLIC_IP}:${PORT}"
    echo "    - Log file:   data/logs/webdep-server.log"
    echo "    - Stop cmd:   ./start.sh --stop"
    exit 0
fi

echo "[*] Starting WebDep server on http://${PUBLIC_IP}:${PORT} (0.0.0.0:${PORT})"
echo "[*] SQLite Database: data/webdep.sqlite"
echo "[*] Tip: Run './start.sh -d' for background mode or './start.sh --service' for 24/7 systemd auto-start."
echo ""

exec ./target/release/webdep
