# 运维现状（本文件记录线上真实状态）

> README.md 是通用部署指南，本文件记录**这一台服务器当前的实际状态**。
> 变更线上环境后请同步更新最后一节的变更记录。
> ⚠️ 本仓库为公开仓库，**访问码等敏感信息一律不写入本文件**。

## 一、实例信息

| 项目 | 值 |
|---|---|
| 云厂商 / 产品 | 腾讯云 轻量应用服务器（Lighthouse） |
| 实例 ID | `lhins-ivmsju6h` |
| 实例名称 | Hermes Agent-5P5h |
| 地域 / 可用区 | 广州 `ap-guangzhou` / `ap-guangzhou-6` |
| 公网 IP | `123.207.6.108` |
| 规格 | 2 核 2G，系统盘 50G SSD |
| 出带宽 | 4 Mbps（约 500 KB/s 峰值） |
| 操作系统 | Ubuntu 24.04.4 LTS |
| 运行时 | Node.js v22.23.3（`/usr/bin/node`，系统自带） |
| 到期时间 | 2026-11-22 |

## 二、访问地址

```
http://123.207.6.108:8766
```

- 端口：**8766**（应用直接监听，未使用 Nginx 反代）
- 访问控制：**已启用访问码**，通过 systemd 单元的环境变量 `CANGKU_CODE` 注入
- 访问码取值**不在本仓库中记录**，请向运维负责人索取

## 三、目录布局

| 用途 | 路径 |
|---|---|
| 运行目录（systemd 工作目录） | `/opt/cangku` |
| 源码 clone（git 仓库） | `/opt/cangku-src` |
| 业务数据 | `/opt/cangku/data.json` |
| 数据备份 | `/opt/cangku/backups/` |

> ⚠️ README.md 第八章示例写的是 `cd /opt/cg`，那是示例路径。**本机实际是 `/opt/cangku-src`**。

运行目录只放三类东西，均由 `update.sh` 覆盖式写入：

```
/opt/cangku/
├── server.js
├── public/
├── data.json        ← 业务数据，更新时绝不覆盖
└── backups/
```

## 四、服务管理

```bash
systemctl status cangku        # 查看状态
systemctl restart cangku       # 重启
journalctl -u cangku -n 50 --no-pager   # 查看日志
```

- 服务名：`cangku`
- 已 `enable` 开机自启，`Restart=always`（进程崩溃 3 秒后自动拉起）
- systemd 单元：`/etc/systemd/system/cangku.service`

修改访问码或端口后必须执行：

```bash
systemctl daemon-reload && systemctl restart cangku
```

## 五、防火墙（Lighthouse 防火墙）

| 协议 | 端口 | 来源 | 用途 |
|---|---|---|---|
| TCP | 22 | 0.0.0.0/0 | SSH 登录 |
| TCP | 8766 | 0.0.0.0/0 | 应用访问 |
| ICMP | ALL | 0.0.0.0/0 | Ping 探测 |

> 云厂商防火墙在控制台管理，**不是**服务器上的 ufw/iptables。改端口要两边同时放行。

## 六、数据备份

已配置每日自动备份（root crontab）：

```cron
0 3 * * * cp /opt/cangku/data.json /opt/cangku/backups/data-$(date +\%F).json 2>/dev/null; find /opt/cangku/backups -name 'data-*.json' -mtime +30 -delete
```

- 每天凌晨 3:00 备份一次，按日期命名（如 `data-2026-10-23.json`）
- 自动清理 30 天前的备份
- 查看现有备份：`ls -la /opt/cangku/backups/`

**局限**：备份与主文件在同一块磁盘上，可防误删/误操作，**不能防磁盘损坏或实例故障**。
如需异地容灾，建议再同步到腾讯云 COS 对象存储。

`data.json` 不存在时（尚未录入任何数据）`cp` 会静默失败，不会产生空文件。

## 七、更新流程

设计侧改动 → 推送 GitHub → 运维侧执行：

```bash
cd /opt/cangku-src
git fetch origin && git reset --hard origin/main   # 强制与远端一致，避免本地残留
bash deploy/update.sh                              # 备份数据 → 换文件 → 重启 → 自检
```

`update.sh` 的行为：

1. 若源码目录是 git 仓库，先 `git pull --ff-only`
2. 备份 `data.json` 到 `backups/data-<时间戳>.json`
3. 停服务 → 替换 `server.js` 与 `public/` → 起服务
4. 读取现有 systemd 配置里的端口与访问码（**不会改动**）

> **日常更新只用 `update.sh`，不要用 `install.sh`。**
> `install.sh` 会重写 systemd 单元，若忘了带 `ACCESS_CODE`，访问码会被清空，等于对公网敞开。

### 关于 `update.sh` 输出「健康接口无响应」

启用访问码后会出现这个提示，**属正常现象**：脚本用 `curl -fsS` 请求 `/api/health`，
带鉴权的接口在无 `X-Access-Code` 头时返回 401，`-f` 参数会把它当作失败。
判断服务是否正常请看 `systemctl is-active cangku` 与下面的手工验证。

## 八、部署后标准验证

```bash
systemctl is-active cangku                                        # 期望 active

# 首页：应 200，且不带访问码也能打开（登录页要能显示）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8766/

# 接口无码：应 401（数据被拦截）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8766/api/health

# 接口带码：应 200
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "X-Access-Code: <访问码>" http://127.0.0.1:8766/api/health

# 外网可达
curl -s -o /dev/null -w "%{http_code}\n" http://123.207.6.108:8766/
```

**鉴权分层要点**：首页不校验访问码（否则登录框本身都加载不出来），
只有 `/api/*` 校验。历史上曾因把鉴权放在静态资源之前，导致开启访问码后整站不可用。

## 九、回滚

```bash
# 回滚数据
cp /opt/cangku/backups/data-2026-10-23.json /opt/cangku/data.json
systemctl restart cangku

# 回滚代码
cd /opt/cangku-src && git reset --hard <上一个提交哈希>
bash deploy/update.sh
```

## 十、已知待办

- [ ] **HTTPS**：当前访问码经 HTTP 明文传输，仅适合内部使用。可加域名 + Caddy 自动签发证书。
- [ ] **异地备份**：备份与主数据同盘，建议同步到 COS。
- [ ] **访问码强度**：当前取值偏短，猜中风险高。已配置同 IP 5 分钟 6 次失败限流，
      但仍建议换成 12 位以上的字母数字组合。

> 🔴 **本仓库是公开仓库，访问码、密钥一律不得写进这里（包括变更记录）。**
> 一旦写进去就视为已泄露，必须立即到服务器上换新码：
> `修改 /etc/systemd/system/cangku.service 里的 CANGKU_CODE` →
> `systemctl daemon-reload && systemctl restart cangku`。

## 十一、变更记录

| 日期 | 版本 / 提交 | 变更内容 |
|---|---|---|
| 2026-10-22 | `c6a158b` | 首次部署；systemd 注册、放行 8766 |
| 2026-10-22 | `1a156df` | 更新 v2：鉴权下沉到 API 层、前端登录框、恒定时间比较、失败限流 |
| 2026-10-22 | 配置 | 访问码启用（取值见下方红色警示，不记录在此） |
| 2026-10-22 | `991786b` | 更新 v3：XFF 伪造防护、目录穿越、CSV 公式注入加固；新增 `update.sh` |
| 2026-10-22 | 运维 | 配置每日 3:00 自动备份，保留 30 天 |
