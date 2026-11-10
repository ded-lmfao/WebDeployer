#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"
APP_DIR="$(pwd)"

echo "==================================================="
echo "     WebDep - Multi-Website Hosting Platform"
echo "==================================================="
echo ""

MODE="${1:-foreground}"

if [[ "$MODE" == "--stop" || "$MODE" == "stop" ]]; then
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
if [[ ! -f ".env" ]]; then
    cp .env.example .env 2>/dev/null || true
fi
if grep -q "^HOST=127.0.0.1" .env 2>/dev/null; then
    sed -i 's/^HOST=127.0.0.1/HOST=0.0.0.0/' .env
fi

# Ensure Rust toolchain is installed on VPS if binary needs compilation
if [[ ! -f "target/release/webdep" ]]; then
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
mkdir -p data/logs data/caddy

PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d'=' -f2 | tr -d '[:space:]')
PORT="${PORT:-4600}"
PUBLIC_IP=$(curl -s --max-time 2 https://api.ipify.org || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")

# Automatically configure UFW & iptables firewall rules so ports are open out-of-the-box
SERVICE_USER="${SUDO_USER:-$(whoami)}"
if command -v sudo >/dev/null 2>&1; then
    echo "[*] Configuring automatic firewall rules (UFW & iptables)..."
    if ! command -v ufw >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -y >/dev/null 2>&1 && sudo apt-get install -y ufw >/dev/null 2>&1 || true
    fi
    if command -v ufw >/dev/null 2>&1; then
        sudo ufw allow OpenSSH >/dev/null 2>&1 || sudo ufw allow 22/tcp >/dev/null 2>&1 || true
        sudo ufw allow 80/tcp >/dev/null 2>&1 || true
        sudo ufw allow 443/tcp >/dev/null 2>&1 || true
        sudo ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
        sudo ufw --force enable >/dev/null 2>&1 || true
    fi
    if command -v iptables >/dev/null 2>&1; then
        for p in 80 443 "${PORT}"; do
            sudo iptables -C INPUT -p tcp --dport "$p" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null || \
                sudo iptables -I INPUT 1 -p tcp --dport "$p" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null || true
        done
    fi
    # Allow WebDep service user to automatically open ports in UFW/iptables & reload Caddy when new websites are created
    if [[ -d "/etc/sudoers.d" ]]; then
        echo "${SERVICE_USER} ALL=(ALL) NOPASSWD: /usr/sbin/ufw, /usr/sbin/iptables, /usr/bin/systemctl reload caddy" | sudo tee /etc/sudoers.d/webdep-firewall >/dev/null 2>&1 || true
        sudo chmod 0440 /etc/sudoers.d/webdep-firewall 2>/dev/null || true
    fi
fi

if [[ "$MODE" == "--service" || "$MODE" == "service" ]]; then
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
    echo "    - Panel Address:       ${PUBLIC_IP}:${PORT}"
    echo "    - Localhost:           127.0.0.1:${PORT}"
    if [[ "${PUBLIC_IP}" != "127.0.0.1" ]]; then
        echo "    - Secure SSH Tunnel:   ssh -N -L ${PORT}:127.0.0.1:${PORT} ${SERVICE_USER}@${PUBLIC_IP}"
        echo "                           (Recommended: enables encrypted transit & browser Passkey authentication)"
    fi
    echo "    - Status:              sudo systemctl status webdep"
    echo "    - Logs:                sudo journalctl -u webdep -f"
    exit 0
fi

if [[ "$MODE" == "--daemon" || "$MODE" == "-d" || "$MODE" == "daemon" || "$MODE" == "start" ]]; then
    pkill -f "target/release/webdep" 2>/dev/null || true
    nohup ./target/release/webdep > data/logs/webdep-server.log 2>&1 &
    PID=$!
    echo "[+] WebDep started in background (PID: ${PID})"
    echo "    - Panel Address:       ${PUBLIC_IP}:${PORT}"
    echo "    - Localhost:           127.0.0.1:${PORT}"
    if [[ "${PUBLIC_IP}" != "127.0.0.1" ]]; then
        echo "    - Secure SSH Tunnel:   ssh -N -L ${PORT}:127.0.0.1:${PORT} ${SERVICE_USER}@${PUBLIC_IP}"
        echo "                           (Recommended: enables encrypted transit & browser Passkey authentication)"
    fi
    echo "    - Log file:            data/logs/webdep-server.log"
    echo "    - Stop cmd:            ./start.sh --stop"
    exit 0
fi

echo "[*] Starting WebDep server on ${PUBLIC_IP}:${PORT} (0.0.0.0:${PORT})"
echo "[*] Localhost: 127.0.0.1:${PORT}"
if [[ "${PUBLIC_IP}" != "127.0.0.1" ]]; then
    echo "[!] Security notice: Direct HTTP over public IP is unencrypted."
    echo "    Recommended for production: route via Caddy/HTTPS domain, or use an SSH tunnel:"
    echo "    ssh -N -L ${PORT}:127.0.0.1:${PORT} ${SERVICE_USER}@${PUBLIC_IP}"
fi
echo "[*] SQLite Database: data/webdep.sqlite"
echo "[*] Tip: Run './start.sh -d' for background mode or './start.sh --service' for 24/7 systemd auto-start."
echo ""

exec ./target/release/webdep
