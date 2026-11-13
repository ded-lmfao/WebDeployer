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

detect_repo_slug() {
    if [[ -n "${WEBDEP_REPO:-}" ]]; then
        echo "$WEBDEP_REPO"
        return 0
    fi
    local origin=""
    if command -v git >/dev/null 2>&1 && [[ -d ".git" ]]; then
        origin=$(git remote get-url origin 2>/dev/null || true)
    fi
    if [[ "$origin" =~ github\.com[:/]([^/]+/[^/.]+)(\.git)?$ ]]; then
        echo "${BASH_REMATCH[1]}"
        return 0
    fi
    echo "ded-lmfao/WebDeployer"
}

install_release_binary() {
    local arch asset repo tmp_dir expected actual
    arch=$(uname -m)
    case "$arch" in
        x86_64|amd64) asset="webdep-linux-x86_64.tar.gz" ;;
        aarch64|arm64) asset="webdep-linux-aarch64.tar.gz" ;;
        *)
            echo "[!] Unsupported architecture '${arch}' for prebuilt release."
            return 1
            ;;
    esac

    if ! command -v curl >/dev/null 2>&1; then
        echo "[!] 'curl' is required to download GitHub Releases."
        return 1
    fi

    repo=$(detect_repo_slug)
    tmp_dir="data/tmp/release-$$"
    mkdir -p "$tmp_dir" target/release

    echo "[*] Downloading latest GitHub Release from ${repo} (${asset})..."
    if ! curl -fsSL --max-time 180 "https://github.com/${repo}/releases/latest/download/checksums.txt" -o "${tmp_dir}/checksums.txt" \
       || ! curl -fsSL --max-time 180 "https://github.com/${repo}/releases/latest/download/${asset}" -o "${tmp_dir}/${asset}"; then
        rm -rf "$tmp_dir"
        return 1
    fi

    if command -v sha256sum >/dev/null 2>&1; then
        expected=$(awk -v f="$asset" '{ gsub(/^\*/, "", $2); n=split($2, p, "/"); if (p[n]==f) { print tolower($1); exit } }' "${tmp_dir}/checksums.txt")
        actual=$(sha256sum "${tmp_dir}/${asset}" | awk '{ print tolower($1) }')
        if [[ -z "$expected" || "$expected" != "$actual" ]]; then
            echo "[!] SHA-256 verification failed (expected=${expected}, actual=${actual})."
            rm -rf "$tmp_dir"
            return 1
        fi
        echo "[+] SHA-256 verified: ${actual}"
    fi

    tar -xzf "${tmp_dir}/${asset}" -C "$tmp_dir"
    if [[ ! -f "${tmp_dir}/webdep" ]]; then
        echo "[!] Release archive did not contain 'webdep' binary."
        rm -rf "$tmp_dir"
        return 1
    fi

    chmod +x "${tmp_dir}/webdep"
    if ! "${tmp_dir}/webdep" --version; then
        echo "[!] Downloaded binary failed '--version' smoke check."
        rm -rf "$tmp_dir"
        return 1
    fi

    mv "${tmp_dir}/webdep" target/release/webdep.new
    if [[ -f "target/release/webdep" ]]; then
        mv target/release/webdep target/release/webdep.old
    fi
    mv target/release/webdep.new target/release/webdep
    rm -f target/release/webdep.old
    rm -rf "$tmp_dir"
    chmod +x target/release/webdep
    return 0
}

if [[ "$MODE" == "--update" || "$MODE" == "update" ]]; then
    echo "[*] Updating WebDep..."
    echo "[*] Preserving data/ directory and .env secrets..."
    if [[ -f ".env" ]]; then
        cp .env .env.update-bak 2>/dev/null || true
    fi

    if [[ "${2:-}" == "--source" ]]; then
        BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
        [[ "$BRANCH" == "HEAD" || -z "$BRANCH" ]] && BRANCH="main"
        echo "[*] Fetching latest commits from origin/${BRANCH}..."
        git fetch origin "$BRANCH"
        git reset --hard "origin/${BRANCH}"
        [[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
        mv target/release/webdep target/release/webdep.old 2>/dev/null || true
        echo "[*] Compiling release binary (Low-RAM: CARGO_BUILD_JOBS=1)..."
        CARGO_BUILD_JOBS=1 cargo build --release
        rm -f target/release/webdep.old 2>/dev/null || true
        chmod +x target/release/webdep
    else
        install_release_binary
    fi

    if [[ -f ".env.update-bak" && ! -f ".env" ]]; then
        cp .env.update-bak .env
    fi
    rm -f .env.update-bak 2>/dev/null || true

    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet webdep 2>/dev/null; then
        if [[ -f "/etc/systemd/system/webdep.service" ]] && ! grep -q "KillMode=process" /etc/systemd/system/webdep.service 2>/dev/null; then
            sudo sed -i '/RestartSec=/a KillMode=process' /etc/systemd/system/webdep.service 2>/dev/null || true
            sudo systemctl daemon-reload 2>/dev/null || true
        fi
        echo "[*] Restarting systemd service 'webdep'..."
        sudo systemctl restart webdep || systemctl restart webdep
        echo "[+] WebDep successfully updated and restarted!"
    else
        echo "[+] WebDep updated to latest release. Run './start.sh' or './start.sh --service' to start."
    fi
    exit 0
fi

# Ensure .env exists and binds to 0.0.0.0 for VPS access
if [[ ! -f ".env" ]]; then
    cp .env.example .env 2>/dev/null || true
fi
if grep -q "^HOST=127.0.0.1" .env 2>/dev/null; then
    sed -i 's/^HOST=127.0.0.1/HOST=0.0.0.0/' .env
fi

# Download prebuilt GitHub Release binary when missing; fallback to source build if no release exists
if [[ ! -f "target/release/webdep" ]]; then
    if ! install_release_binary; then
        echo "[*] Prebuilt release unavailable; falling back to local Cargo compilation..."
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
fi

chmod +x target/release/webdep
mkdir -p data/logs data/caddy

# Low-memory allocator tuning for Linux glibc (eliminates multi-arena RAM bloat)
export MALLOC_ARENA_MAX=2
export MALLOC_TRIM_THRESHOLD_=65536

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
    # Allow WebDep service user to automatically open ports in UFW/iptables, reload Caddy & restart WebDep
    if [[ -d "/etc/sudoers.d" ]]; then
        echo "${SERVICE_USER} ALL=(ALL) NOPASSWD: /usr/sbin/ufw, /usr/sbin/iptables, /usr/bin/systemctl reload caddy, /usr/bin/systemctl restart webdep, /bin/systemctl restart webdep" | sudo tee /etc/sudoers.d/webdep-firewall >/dev/null 2>&1 || true
        sudo chmod 0440 /etc/sudoers.d/webdep-firewall 2>/dev/null || true
    fi
fi

if [[ "$MODE" == "--service" || "$MODE" == "service" ]]; then
    echo "[*] Installing systemd service (/etc/systemd/system/webdep.service)..."
    SERVICE_USER="${SUDO_USER:-$(whoami)}"
    USER_HOME=$(eval echo "~${SERVICE_USER}")
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
KillMode=process
Environment=RUST_LOG=webdep=info
Environment="PATH=${USER_HOME}/.cargo/bin:/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment="MALLOC_ARENA_MAX=2"
Environment="MALLOC_TRIM_THRESHOLD_=65536"

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
