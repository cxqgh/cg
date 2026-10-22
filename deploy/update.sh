#!/usr/bin/env bash
# 仓库管理 —— 增量更新脚本
#
# 用法（服务器上，root 权限）：
#   bash deploy/update.sh              # 源码目录就是本仓库时直接跑
#   bash deploy/update.sh /opt/cg      # 指定源码目录
#
# 与 install.sh 的区别：
#   install.sh 会重写 systemd 配置，重跑时若忘了带 ACCESS_CODE，访问码会被清空；
#   update.sh 只替换程序与前端，保留现有服务配置和全部数据，适合日常更新。
set -euo pipefail

APP_DIR="/opt/cangku"
SERVICE="cangku"

log() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
die() { printf "\n\033[1;31m错误：%s\033[0m\n" "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash deploy/update.sh"

# 定位源码目录：脚本可能在仓库根目录或其 deploy/ 子目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/server.js" ]; then
  SRC_DIR="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/../server.js" ]; then
  SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  SRC_DIR="${1:-$(pwd)}"
fi

# 源码目录是 git 仓库就先拉最新代码
if [ -d "$SRC_DIR/.git" ]; then
  log "拉取最新代码：$SRC_DIR"
  git -C "$SRC_DIR" pull --ff-only
fi

[ -f "$SRC_DIR/server.js" ] || die "找不到 server.js（$SRC_DIR）"

# 先备份数据，万一新版有问题还能退回去
if [ -f "$APP_DIR/data.json" ]; then
  log "备份数据"
  mkdir -p "$APP_DIR/backups"
  cp -f "$APP_DIR/data.json" "$APP_DIR/backups/data-$(date +%F-%H%M%S).json"
fi

log "更新程序到 ${APP_DIR}"
mkdir -p "$APP_DIR"

# 先停服务再换文件，避免请求读到换到一半的 public/
systemctl stop "$SERVICE" 2>/dev/null || true
cp -f "$SRC_DIR/server.js" "$APP_DIR/server.js"
rm -rf "$APP_DIR/public"
cp -r "$SRC_DIR/public" "$APP_DIR/public"
chown -R root:root "$APP_DIR"

log "重启服务"
systemctl restart "$SERVICE"
sleep 1.5
systemctl is-active --quiet "$SERVICE" || {
  journalctl -u "$SERVICE" -n 30 --no-pager
  die "服务启动失败，可用 backups/ 里的数据回滚"
}

# 端口从现有服务配置里读，读不到就用默认
PORT="$(systemctl cat "$SERVICE" 2>/dev/null | sed -n 's/^Environment=PORT=//p' | head -1)"
PORT="${PORT:-8766}"
HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || echo '健康接口无响应')"
CODE="$(systemctl cat "$SERVICE" 2>/dev/null | sed -n 's/^Environment=CANGKU_CODE=//p' | head -1)"

log "完成"
cat <<EOF

  服务目录 : ${APP_DIR}
  端口     : ${PORT}
  访问码   : $([ -n "$CODE" ] && echo "已设置（未被改动）" || echo "未设置，公网部署强烈建议设置")
  健康接口 : ${HEALTH}

  回滚方法：
    把 backups/ 里对应的 data-*.json 拷回 ${APP_DIR}/data.json，再 systemctl restart ${SERVICE}

EOF
