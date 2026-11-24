#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="getpleasure"
APP_USER="getpleasure"
APP_DIR="/opt/getpleasure"
CONFIG_DIR="/etc/getpleasure"
ENV_FILE="${CONFIG_DIR}/getpleasure.env"
SERVICE_FILE="/etc/systemd/system/getpleasure.service"
ACCESS_FILE="/root/getpleasure-access.txt"
NODE_MAJOR=22
MONGO_SERIES="8.0"

PORT=""
MEDIA_ROOT=""
EXTERNAL_MONGODB_URI=""
IP_MODE=""
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -t 1 ]]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; PINK=$'\e[38;5;211m'; RESET=$'\e[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; PINK=""; RESET=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$PINK" "$RESET" "$BOLD" "$*" "$RESET"; }
info() { printf '    %s\n' "$*"; }
ok() { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die() { printf '\n%sError:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

on_error() {
  local line="$1"
  printf '\n%sSetup stopped at line %s.%s Fix the problem above and run the script again; it is safe to re-run.\n' "$RED" "$line" "$RESET" >&2
}

usage() {
  cat <<EOF
Get Pleasure one-command installer

Usage: sudo bash setup.sh [options]

  --port N            Port the website listens on (default 3000, or the current value on re-run)
  --media PATH        Folder the admin console can browse for videos (default /srv/getpleasure/media)
  --mongodb-uri URI   Use an existing MongoDB replica set or Atlas cluster instead of installing one
  --ip-mode MODE      relaxed (same subnet, best for phones) or strict (exact IP). Default relaxed
  -h, --help          Show this help

Re-running the script updates the app and keeps your existing secrets and data.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port) PORT="${2:-}"; shift 2 ;;
      --port=*) PORT="${1#*=}"; shift ;;
      --media) MEDIA_ROOT="${2:-}"; shift 2 ;;
      --media=*) MEDIA_ROOT="${1#*=}"; shift ;;
      --mongodb-uri) EXTERNAL_MONGODB_URI="${2:-}"; shift 2 ;;
      --mongodb-uri=*) EXTERNAL_MONGODB_URI="${1#*=}"; shift ;;
      --ip-mode) IP_MODE="${2:-}"; shift 2 ;;
      --ip-mode=*) IP_MODE="${1#*=}"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage; die "Unknown option: $1" ;;
    esac
  done
}

existing_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

resolve_settings() {
  PORT="${PORT:-$(existing_value PORT)}"
  PORT="${PORT:-3000}"
  MEDIA_ROOT="${MEDIA_ROOT:-$(existing_value MEDIA_ROOT)}"
  MEDIA_ROOT="${MEDIA_ROOT:-/srv/getpleasure/media}"
  IP_MODE="${IP_MODE:-$(existing_value IP_MATCH_MODE)}"
  IP_MODE="${IP_MODE:-relaxed}"

  if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
    die "--port must be a number between 1 and 65535"
  fi
  [[ "$IP_MODE" == "relaxed" || "$IP_MODE" == "strict" ]] || die '--ip-mode must be "relaxed" or "strict"'
  [[ "$MEDIA_ROOT" == /* ]] || die "--media must be an absolute path, for example /srv/getpleasure/media"
  case "$MEDIA_ROOT" in
    /|/etc|/etc/*|/usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*|/boot|/boot/*|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*|/root|/root/*)
      die "--media cannot be a system folder ($MEDIA_ROOT). Use something like /srv/getpleasure/media" ;;
  esac

  if [[ -z "$EXTERNAL_MONGODB_URI" ]]; then
    local current_uri
    current_uri="$(existing_value MONGODB_URI)"
    if [[ -n "$current_uri" && "$current_uri" != mongodb://127.0.0.1:* ]]; then
      EXTERNAL_MONGODB_URI="$current_uri"
    fi
  fi
}

preflight() {
  step "Checking this server"

  [[ "${EUID}" -eq 0 ]] || die "Run this with sudo: sudo bash setup.sh"
  if ! command -v systemctl >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
    die "This installer needs a systemd-based Linux server"
  fi
  [[ -f "${SOURCE_DIR}/package.json" && -f "${SOURCE_DIR}/src/server.js" ]] || die "Run setup.sh from inside the project folder (where package.json is)"

  [[ -r /etc/os-release ]] || die "Cannot detect the operating system"
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_CODENAME="${VERSION_CODENAME:-}"
  OS_PRETTY="${PRETTY_NAME:-$OS_ID}"

  case "$OS_ID" in
    ubuntu|debian) ;;
    *) die "Supported systems are Ubuntu 20.04, 22.04, 24.04 and Debian 12. Found: $OS_PRETTY" ;;
  esac
  command -v apt-get >/dev/null 2>&1 || die "apt-get is required"
  ok "$OS_PRETTY"

  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|aarch64) ok "Architecture $ARCH" ;;
    *) die "MongoDB needs a 64-bit x86 or ARM server. Found: $ARCH" ;;
  esac

  local mem_mb
  mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
  if (( mem_mb < 900 )); then
    warn "Only ${mem_mb} MB of RAM. MongoDB and Node together want about 1 GB; consider adding swap"
  else
    ok "${mem_mb} MB of RAM"
  fi

  if [[ -z "$EXTERNAL_MONGODB_URI" ]]; then
    if [[ "$ARCH" == "x86_64" ]] && ! grep -qw avx /proc/cpuinfo; then
      die "This CPU has no AVX support, which MongoDB ${MONGO_SERIES} requires.
       Use a free MongoDB Atlas cluster instead:
       sudo bash setup.sh --mongodb-uri 'mongodb+srv://USER:PASS@cluster.example.mongodb.net/'"
    fi
    case "$OS_ID:$OS_CODENAME" in
      ubuntu:focal|ubuntu:jammy|ubuntu:noble|debian:bookworm) ok "MongoDB ${MONGO_SERIES} is supported here" ;;
      *) die "MongoDB ${MONGO_SERIES} has no package for $OS_PRETTY.
       Use Ubuntu 22.04/24.04 or Debian 12, or pass --mongodb-uri for an existing database" ;;
    esac
  else
    ok "Using an existing MongoDB at the URI you provided"
  fi

  if port_in_use "$PORT" && ! systemctl is-active --quiet "$APP_NAME"; then
    die "Port $PORT is already used by another program. Pick another one: sudo bash setup.sh --port 8080"
  fi
  ok "Port $PORT is available"
}

port_in_use() {
  ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y -qq "$@" >/dev/null
}

install_base_packages() {
  step "Installing system packages"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  apt_install ca-certificates curl gnupg rsync ffmpeg iproute2
  ok "curl, gnupg, rsync, ffmpeg"
}

install_node() {
  step "Installing Node.js ${NODE_MAJOR}"
  local current=0
  if command -v node >/dev/null 2>&1; then
    current="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  fi

  if (( current >= NODE_MAJOR )); then
    ok "Node.js $(node -v) already installed"
    return
  fi

  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  apt_install nodejs
  ok "Node.js $(node -v)"
}

install_mongodb() {
  if [[ -n "$EXTERNAL_MONGODB_URI" ]]; then
    MONGODB_URI="$EXTERNAL_MONGODB_URI"
    return
  fi

  step "Installing MongoDB ${MONGO_SERIES}"
  local keyring="/usr/share/keyrings/mongodb-server-${MONGO_SERIES}.gpg"
  local list="/etc/apt/sources.list.d/mongodb-org-${MONGO_SERIES}.list"

  if ! command -v mongod >/dev/null 2>&1; then
    curl -fsSL "https://pgp.mongodb.com/server-${MONGO_SERIES}.asc" | gpg --batch --yes -o "$keyring" --dearmor
    if [[ "$OS_ID" == "ubuntu" ]]; then
      echo "deb [ arch=amd64,arm64 signed-by=${keyring} ] https://repo.mongodb.org/apt/ubuntu ${OS_CODENAME}/mongodb-org/${MONGO_SERIES} multiverse" > "$list"
    else
      echo "deb [ signed-by=${keyring} ] https://repo.mongodb.org/apt/debian ${OS_CODENAME}/mongodb-org/${MONGO_SERIES} main" > "$list"
    fi
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
    apt_install mongodb-org
    ok "MongoDB $(mongod --version | awk 'NR==1 {print $3}') installed"
  else
    ok "MongoDB already installed"
  fi

  local conf="/etc/mongod.conf"
  local replset="rs0"
  local conf_changed=0
  if grep -qE '^replication:' "$conf"; then
    replset="$(awk '/^replication:/ {f=1; next} f && /replSetName:/ {print $2; exit} f && /^[^ ]/ {exit}' "$conf")"
    replset="${replset:-rs0}"
    ok "Replica set \"$replset\" already configured"
  else
    printf '\nreplication:\n  replSetName: %s\n' "$replset" >> "$conf"
    conf_changed=1
    ok "Enabled replica set \"$replset\" (needed for durable writes)"
  fi

  if ! grep -qE '^\s*bindIp:\s*127\.0\.0\.1\s*$' "$conf"; then
    warn "mongod.conf does not bind to 127.0.0.1 only. Make sure port 27017 is not open to the internet"
  fi

  systemctl enable mongod >/dev/null 2>&1
  if (( conf_changed )) || ! systemctl is-active --quiet mongod; then
    systemctl restart mongod
  fi

  info "Waiting for MongoDB to start"
  local tries=0
  until mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1; do
    tries=$((tries + 1))
    (( tries < 60 )) || die "MongoDB did not start. Check: journalctl -u mongod -n 50"
    sleep 1
  done

  mongosh --quiet --eval "
    try { rs.status().ok }
    catch (error) { rs.initiate({ _id: '${replset}', members: [{ _id: 0, host: '127.0.0.1:27017' }] }).ok }
  " >/dev/null

  tries=0
  until [[ "$(mongosh --quiet --eval 'db.hello().isWritablePrimary' 2>/dev/null)" == "true" ]]; do
    tries=$((tries + 1))
    (( tries < 60 )) || die "MongoDB replica set did not become primary. Check: journalctl -u mongod -n 50"
    sleep 1
  done
  ok "MongoDB is running as a single-node replica set, reachable only from this server"

  MONGODB_URI="mongodb://127.0.0.1:27017/?replicaSet=${replset}"
}

create_user_and_folders() {
  step "Creating the app user and folders"
  if ! id -u "$APP_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
    ok "System user $APP_USER created"
  else
    ok "System user $APP_USER exists"
  fi

  install -d -m 0755 "$APP_DIR"
  install -d -m 0750 -o root -g "$APP_USER" "$CONFIG_DIR"
  install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$MEDIA_ROOT"
  ok "Videos folder: $MEDIA_ROOT"
}

deploy_app() {
  step "Installing the website"
  if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
    rsync -a --delete \
      --exclude '.git' --exclude 'node_modules' --exclude '.env' \
      --exclude 'tests' --exclude 'screenshots' --exclude 'harness.json' \
      "${SOURCE_DIR}/" "${APP_DIR}/"
  fi

  (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
  chown -R root:"$APP_USER" "$APP_DIR"
  chmod -R u=rwX,g=rX,o= "$APP_DIR"
  ok "Code in $APP_DIR, dependencies installed"
}

random_secret() {
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'
}

write_env() {
  step "Writing configuration"
  local admin_token session_secret stream_secret reused=0
  admin_token="$(existing_value ADMIN_TOKEN)"
  session_secret="$(existing_value SESSION_SECRET)"
  stream_secret="$(existing_value STREAM_SECRET)"

  [[ -n "$admin_token" ]] && reused=1
  admin_token="${admin_token:-$(random_secret)}"
  session_secret="${session_secret:-$(random_secret)}"
  stream_secret="${stream_secret:-$(random_secret)}"

  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<EOF
PORT=${PORT}
MONGODB_URI=${MONGODB_URI}
MONGODB_DB=$(existing_value MONGODB_DB | grep . || echo getpleasure)
ADMIN_TOKEN=${admin_token}
SESSION_SECRET=${session_secret}
STREAM_SECRET=${stream_secret}
MEDIA_ROOT=${MEDIA_ROOT}
IP_MATCH_MODE=${IP_MODE}
TRUST_PROXY_HOPS=0
COOKIE_SECURE=false
SESSION_TTL_HOURS=12
STREAM_TOKEN_TTL_SECONDS=120
PRESENCE_WINDOW_SECONDS=60
VIEW_DEDUPE_HOURS=6
MAX_VALIDITY_DAYS=3650
SITE_NAME=Get Pleasure
EOF
  install -m 0640 -o root -g "$APP_USER" "$tmp" "$ENV_FILE"
  rm -f "$tmp"

  ADMIN_TOKEN="$admin_token"
  if (( reused )); then
    ok "Kept your existing admin token and secrets"
  else
    ok "Generated a new admin token and secrets"
  fi
  ok "Settings saved to $ENV_FILE (readable by root and the app only)"
}

write_service() {
  step "Registering the background service"
  local node_bin protect_home="read-only"
  node_bin="$(command -v node)"
  [[ "$MEDIA_ROOT" == /home/* ]] && protect_home="false"

  local mongo_deps=""
  [[ -z "$EXTERNAL_MONGODB_URI" ]] && mongo_deps=$'After=mongod.service\nWants=mongod.service'

  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Get Pleasure members-only video archive
After=network-online.target
Wants=network-online.target
${mongo_deps}

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
Environment=NODE_ENV=production
ExecStart=${node_bin} src/server.js
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=${protect_home}
ReadWritePaths=${MEDIA_ROOT}

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$APP_NAME" >/dev/null 2>&1
  ok "Starts automatically on boot and restarts if it crashes"
}

open_firewall() {
  step "Opening port ${PORT}"
  local opened=0

  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "${PORT}/tcp" >/dev/null
    ok "ufw: allowed ${PORT}/tcp"
    opened=1
  fi

  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null
    firewall-cmd --reload >/dev/null
    ok "firewalld: allowed ${PORT}/tcp"
    opened=1
  fi

  if (( ! opened )) && command -v iptables >/dev/null 2>&1; then
    local policy
    policy="$(iptables -S INPUT 2>/dev/null | awk '/^-P INPUT/ {print $3}')"
    if [[ "$policy" == "DROP" ]] || iptables -S INPUT 2>/dev/null | grep -qE -- '-j (REJECT|DROP)'; then
      if ! iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
        iptables -I INPUT 1 -p tcp --dport "$PORT" -j ACCEPT
      fi
      if command -v netfilter-persistent >/dev/null 2>&1; then
        netfilter-persistent save >/dev/null 2>&1 || true
        ok "iptables: allowed ${PORT}/tcp and saved the rule"
      else
        ok "iptables: allowed ${PORT}/tcp"
        warn "The iptables rule is not saved across reboots. Install iptables-persistent to keep it"
      fi
      opened=1
    fi
  fi

  if (( ! opened )); then
    ok "No active firewall on this server, so the port is already reachable"
  fi
  warn "If your provider has a cloud firewall (AWS security group, Oracle security list, GCP/Azure/Hetzner firewall), allow TCP ${PORT} there too"
}

start_app() {
  step "Starting Get Pleasure"
  systemctl restart "$APP_NAME"

  local tries=0
  until curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; do
    tries=$((tries + 1))
    local crashed=0
    if (( tries > 5 )) && ! systemctl is-active --quiet "$APP_NAME"; then crashed=1; fi
    if (( tries >= 45 || crashed )); then
      printf '\n%sThe app did not come up. Last log lines:%s\n' "$RED" "$RESET"
      journalctl -u "$APP_NAME" -n 40 --no-pager || true
      die "Start failed. Fix the error above and run setup.sh again"
    fi
    sleep 1
  done
  ok "Running and healthy on port ${PORT}"
}

detect_public_ip() {
  local ip=""
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -4 -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && break
    ip=""
  done
  if [[ -z "$ip" ]]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  printf '%s' "${ip:-YOUR_SERVER_IP}"
}

check_public_reachability() {
  local url="$1"
  if curl -fsS --max-time 5 "${url}/health" >/dev/null 2>&1; then
    ok "Reachable from the internet at ${url}"
  else
    warn "This server could not reach its own public address. That is normal on some providers;"
    warn "if the link does not open from your phone, allow TCP ${PORT} in your provider's cloud firewall"
  fi
}

print_summary() {
  local ip url
  ip="$(detect_public_ip)"
  url="http://${ip}:${PORT}"
  check_public_reachability "$url"

  local summary
  summary="$(cat <<EOF
Get Pleasure is live

  Website        ${url}
  Owner console  ${url}/admin
  Admin token    ${ADMIN_TOKEN}

  Videos folder  ${MEDIA_ROOT}
  Settings       ${ENV_FILE}

Upload videos from your computer:
  scp -r ./my-videos root@${ip}:${MEDIA_ROOT}/
  sudo chown -R ${APP_USER}:${APP_USER} ${MEDIA_ROOT}
Then open the console, Library tab, and import the folder.

Useful commands:
  sudo systemctl status ${APP_NAME}     check it is running
  sudo journalctl -u ${APP_NAME} -f     live logs
  sudo systemctl restart ${APP_NAME}    restart
  sudo bash setup.sh                    update after git pull (keeps secrets and data)
EOF
)"

  printf '%s\n' "$summary" > "$ACCESS_FILE"
  chmod 600 "$ACCESS_FILE"

  printf '\n%s%s%s\n' "$PINK" "────────────────────────────────────────────────────────────" "$RESET"
  printf '%s  Get Pleasure is live%s\n\n' "$BOLD" "$RESET"
  printf '  Website        %s%s%s\n' "$BOLD$GREEN" "$url" "$RESET"
  printf '  Owner console  %s%s/admin%s\n' "$BOLD" "$url" "$RESET"
  printf '  Admin token    %s%s%s\n' "$YELLOW" "$ADMIN_TOKEN" "$RESET"
  printf '%s%s%s\n' "$PINK" "────────────────────────────────────────────────────────────" "$RESET"
  printf '\n  Videos folder  %s\n' "$MEDIA_ROOT"
  printf '  Upload with    %sscp -r ./my-videos root@%s:%s/%s\n' "$DIM" "$ip" "$MEDIA_ROOT" "$RESET"
  printf '  Then run       %ssudo chown -R %s:%s %s%s\n' "$DIM" "$APP_USER" "$APP_USER" "$MEDIA_ROOT" "$RESET"
  printf '\n  This summary, including the admin token, is saved to %s (root only).\n' "$ACCESS_FILE"
  printf '\n  %sThe site runs over plain HTTP.%s Access keys and session cookies cross the\n' "$YELLOW" "$RESET"
  printf '  network unencrypted. Point a domain at this server and put HTTPS in front\n'
  printf '  before sharing keys with real buyers.\n\n'
}

main() {
  parse_args "$@"
  trap 'on_error $LINENO' ERR
  resolve_settings
  preflight
  install_base_packages
  install_node
  install_mongodb
  create_user_and_folders
  deploy_app
  write_env
  write_service
  open_firewall
  start_app
  print_summary
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
