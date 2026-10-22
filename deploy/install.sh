#!/usr/bin/env bash
# 仓库管理 —— 一键部署脚本（Ubuntu 22.04 / 24.04，Debian 12 亦可）
#
# 用法（在服务器上，root 权限）：
#   bash install.sh                      # 只装 Node + 服务，用 IP:8766 访问
#   bash install.sh example.com          # 额外用 Caddy 配 HTTPS（域名需已解析到本机）
#
# 环境变量：
#   ACCESS_CODE=你的访问码   bash install.sh    # 开启访问码（强烈建议）
#   PORT=8766                bash install.sh    # 自定义端口
set -euo pipefail

APP_DIR="/opt/cangku"
SERVICE="cangku"
NODE_VERSION="22.14.0"
PORT="${PORT:-8766}"
ACCESS_CODE="${ACCESS_CODE:-}"
DOMAIN="${1:-}"

log() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
die() { printf "\n\033[1;31m错误：%s\033[0m\n" "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash install.sh"

# 定位源码目录：脚本可能位于仓库根目录或其 deploy/ 子目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/server.js" ]; then
  SRC_DIR="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/../server.js" ]; then
  SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  SRC_DIR="$(pwd)"
fi
[ -f "$SRC_DIR/server.js" ] || die "找不到 server.js（当前目录：$SRC_DIR）"

# ---------- 1. 系统依赖 ----------
log "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl tar xz-utils ca-certificates >/dev/null

# ---------- 2. Node.js（走国内镜像，避免 nodesource 慢） ----------
if command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge 18 ]; then
  log "已有 Node $(node -v)，跳过安装"
else
  log "安装 Node ${NODE_VERSION}"
  ARCH="x64"
  [ "$(uname -m)" = "aarch64" ] && ARCH="arm64"
  URL="https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz"
  TMP="$(mktemp -d)"
  curl -fsSL "$URL" -o "$TMP/node.tar.xz" || die "Node 下载失败，可改用 https://nodejs.org 或云厂商自带镜像"
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$TMP/node.tar.xz" -C /usr/local/lib/nodejs
  mv "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${ARCH}" /usr/local/lib/nodejs/current
  ln -sf /usr/local/lib/nodejs/current/bin/node /usr/local/bin/node
  ln -sf /usr/local/lib/nodejs/current/bin/npm /usr/local/bin/npm
  rm -rf "$TMP"
  log "Node 安装完成：$(node -v)"
fi

# 记录 node 的绝对路径（可能是 /usr/bin/node 或 /usr/local/bin/node）
NODE_BIN="$(command -v node)"
[ -x "$NODE_BIN" ] || die "找不到可执行的 node"
log "使用 node：${NODE_BIN}（$(node -v)）"

# ---------- 3. 部署文件 ----------
log "复制程序到 ${APP_DIR}（源：${SRC_DIR}）"
mkdir -p "$APP_DIR"
cp -f "$SRC_DIR/server.js" "$APP_DIR/"
rm -rf "$APP_DIR/public"
cp -r "$SRC_DIR/public" "$APP_DIR/"
mkdir -p "$APP_DIR/backups"
# 如果已有数据，绝不覆盖
if [ -f "$APP_DIR/data.json" ]; then
  log "检测到已有 data.json，保留不覆盖"
fi
chown -R root:root "$APP_DIR"

# ---------- 4. systemd 服务 ----------
log "写入 systemd 服务"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Cangku inventory server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Environment=PORT=${PORT}
Environment=CANGKU_CODE=${ACCESS_CODE}
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
sleep 1.5
systemctl is-active --quiet "$SERVICE" || { journalctl -u "$SERVICE" -n 30 --no-pager; die "服务启动失败"; }
log "服务已启动（systemctl status ${SERVICE} 查看状态）"

# ---------- 5. 可选：Caddy + HTTPS ----------
if [ -n "$DOMAIN" ]; then
  log "安装 Caddy 并为 ${DOMAIN} 配置 HTTPS"
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
      | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    encode gzip
    reverse_proxy 127.0.0.1:${PORT}
}
EOF
  systemctl reload caddy || systemctl restart caddy
  log "HTTPS 已配置：https://${DOMAIN}"
fi

# ---------- 6. 防火墙提示 ----------
PORT_DESC="80/443"
[ -z "$DOMAIN" ] && PORT_DESC="${PORT}"
log "完成"
cat <<EOF

  服务目录 : ${APP_DIR}
  数据文件 : ${APP_DIR}/data.json
  端口     : ${PORT}
  访问码   : $([ -n "$ACCESS_CODE" ] && echo "已设置" || echo "未设置（任何人都能访问，建议重跑并带上 ACCESS_CODE）")

  下一步：
    1) 到云控制台「安全组 / 防火墙」放行 TCP ${PORT_DESC}
    2) 浏览器打开  http://本机公网IP:${PORT}   查看是否正常
    3) 把旧数据 data.json 拷到 ${APP_DIR}/ 后重启：systemctl restart ${SERVICE}

EOF
