# 仓库管理 · 云端部署手册

目标：把这套系统从「你电脑上的临时服务」搬到一台 7×24 开机的云服务器上。
部署后地址永久固定，你关机、断网都不影响同事使用。

---

## 一、先买一台服务器

| 项目 | 建议 |
|---|---|
| 厂商 | 阿里云 / 腾讯云 / 华为云（哪家有活动买哪家） |
| 产品 | **轻量应用服务器**（比 ECS/CVM 便宜，够用） |
| 规格 | 2 核 2 GB，系统盘 40 GB 起 |
| 镜像 | **Ubuntu 22.04 LTS**（不要选 CentOS 7，太老） |
| 地区 | 同事都在国内 → 选国内节点（如上海、广州）；不想备案 → 选**香港/新加坡** |
| 价格 | 国内首年约 ¥60–120，续费约 ¥200/年；香港稍贵 |

**关于备案**：

- 用「公网 IP + 端口」访问 → **不需要备案**
- 用「域名 + 80/443」访问 → 国内服务器**必须备案**（约 7–20 天）
- 香港/海外服务器 + 域名 → 免备案

> 建议第一次先用 IP 访问跑通，域名以后再加。

---

## 二、连上服务器

Windows 自带 SSH。打开 PowerShell：

```powershell
ssh root@你的服务器公网IP
```

第一次会问 `Are you sure you want to continue connecting?`，输入 `yes` 回车，然后输密码（Linux 下**密码不显示**，盲打，输完直接回车）。

> 腾讯云/阿里云控制台里通常也有「网页终端」，点了就能用，不用装任何东西 —— 新手建议用这个。

---

## 三、上传程序

**方法 A：在服务器上下载（推荐，最省事）**

如果代码放在 GitHub 上就直接 `git clone`。如果不在，用方法 B。

**方法 B：从你电脑传上去**

在**你电脑**的 PowerShell 里执行（注意是本地终端，不是服务器里）：

```powershell
cd "D:\Users\Q\Documents\deepseek-harness\default-workspace\我的测试"
scp -r cangku-server root@你的服务器IP:/opt/
```

这会把整个目录放到服务器的 `/opt/cangku-server`。

**方法 C：打包上传**

先在本地打包：

```powershell
Compress-Archive -Path "cangku-server\*" -DestinationPath "cangku.zip" -Force
```

然后把 `cangku.zip` 拖到云控制台的「文件上传」，再在服务器上解压：

```bash
apt-get install -y unzip
mkdir -p /opt/cangku-server && cd /opt/cangku-server
unzip ~/cangku.zip
```

---

## 四、一键安装

```bash
cd /opt/cangku-server
sudo ACCESS_CODE=你的访问码 PORT=8766 bash deploy/install.sh
```

脚本会做四件事：装 Node → 复制程序到 `/opt/cangku` → 注册成开机自启的系统服务 → 启动。

**务必带上 `ACCESS_CODE`**：公网上没有密码，等于把仓库门敞开。

输出里会打印：服务目录、端口、访问码状态。看到 `服务已启动` 就成了一半。

---

## 五、放行端口

到云控制台找到这台服务器的 **「防火墙 / 安全组」**，新增一条规则：

- 协议：TCP
- 端口：`8766`
- 来源：`0.0.0.0/0`（如果你只给固定办公室用，可以填办公室公网 IP 更安全）

> 这一步是新手最容易漏的。服务明明在跑、浏览器却打不开，十有八九是安全组没放行。

---

## 六、验证

浏览器打开：

```
http://你的服务器公网IP:8766
```

能看到界面、能新增一个物料、能入库，就成了。

再试一下重启后是否自动恢复：

```bash
sudo systemctl restart cangku
curl -s http://127.0.0.1:8766/api/health
```

---

## 七、迁移旧数据

把本地 `data.json` 传上去：

```powershell
scp "D:\Users\Q\Documents\deepseek-harness\default-workspace\我的测试\cangku-server\data.json" root@你的IP:/opt/cangku/
```

然后在服务器上：

```bash
sudo systemctl restart cangku
```

数据就在了。

---

## 八、日常维护

| 要做的事 | 命令 |
|---|---|
| 看运行状态 | `systemctl status cangku` |
| 看日志 | `journalctl -u cangku -n 50 --no-pager` |
| 重启 | `systemctl restart cangku` |
| 手动备份数据 | `cp /opt/cangku/data.json /opt/cangku/backups/data-$(date +%F).json` |
| 更新程序 | 上传新 `server.js` 后 `systemctl restart cangku` |

**备份建议**：数据只有一个文件，最省事的做法是每天自动复制一份。

```bash
# 每天凌晨 3 点备份，保留 30 天
(crontab -l 2>/dev/null; echo "0 3 * * * cp /opt/cangku/data.json /opt/cangku/backups/data-\$(date +\%F).json && find /opt/cangku/backups -name 'data-*.json' -mtime +30 -delete") | crontab -
```

---

## 九、常见问题

**Q：浏览器打不开，服务却在跑？**
A：安全组没放行端口。到云控制台检查。

**Q：`install.sh` 报 Node 下载失败？**
A：换镜像：

```bash
NODE_MIRROR=https://nodejs.org/dist bash deploy/install.sh
```

或直接用云厂商镜像市场的 Node 应用镜像。

**Q：想用域名 + HTTPS？**

域名解析到服务器 IP 后，重跑：

```bash
sudo ACCESS_CODE=你的访问码 bash deploy/install.sh 你的域名.com
```

脚本会自动装 Caddy 并申请证书（需要 80/443 放行 + 域名已解析）。

**Q：忘了访问码？**

```bash
systemctl cat cangku | grep CANGKU_CODE
```

**Q：想换端口？**

改 `/etc/systemd/system/cangku.service` 里的 `Environment=PORT=`，然后 `systemctl daemon-reload && systemctl restart cangku`，记得安全组也改。

---

## 附：目录结构

```
/opt/cangku/
├── server.js          # 服务端（零依赖）
├── public/
│   └── index.html     # 前端
├── data.json          # 所有数据（重要！）
├── data.json.bak      # 上一版备份
└── backups/           # 手动/cron 备份目录
```
