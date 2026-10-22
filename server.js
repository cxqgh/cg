"use strict";

/**
 * 仓库管理服务端（零依赖）
 * - JSON 文件持久化，原子写入（tmp + rename），并保留一份 .bak
 * - 单进程串行处理请求，库存校验在服务端做，避免多人同时出库算错
 * - 可选访问码：设置环境变量 CANGKU_CODE 后，请求需带 X-Access-Code
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data.json");
const PORT = Number(process.env.PORT || 8766);
const ACCESS_CODE = process.env.CANGKU_CODE || "";
const MAX_BODY = 1024 * 1024;

let db = load();

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const d = JSON.parse(raw);
    return {
      items: Array.isArray(d.items) ? d.items : [],
      records: Array.isArray(d.records) ? d.records : [],
      version: Number(d.version) || 1,
      updatedAt: d.updatedAt || null
    };
  } catch {
    return { items: [], records: [], version: 1, updatedAt: null };
  }
}

function persist() {
  db.version += 1;
  db.updatedAt = new Date().toISOString();
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db), "utf8");
  try {
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_FILE + ".bak");
  } catch {}
  fs.renameSync(tmp, DATA_FILE);
}

/* ---------------- 工具 ---------------- */

function uid() {
  return crypto.randomBytes(6).toString("hex");
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function str(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max || 60);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function stockMap() {
  const map = new Map();
  for (const it of db.items) map.set(it.id, 0);
  for (const r of db.records) {
    if (!map.has(r.itemId)) continue;
    map.set(r.itemId, map.get(r.itemId) + (r.type === "in" ? r.qty : -r.qty));
  }
  return map;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

/* ---------------- 业务 ---------------- */

function createItem(body) {
  const code = str(body.code, 24);
  const name = str(body.name, 40);
  if (!code) return { status: 400, error: "编码不能为空" };
  if (!name) return { status: 400, error: "名称不能为空" };
  if (db.items.some((it) => it.code.toLowerCase() === code.toLowerCase())) {
    return { status: 409, error: "编码 " + code + " 已存在" };
  }
  const init = Math.max(0, num(body.init) || 0);
  const item = {
    id: uid(),
    code,
    name,
    spec: str(body.spec, 60),
    unit: str(body.unit, 8) || "个",
    safe: Math.max(0, num(body.safe) || 0),
    createdAt: new Date().toISOString()
  };
  db.items.push(item);
  if (init > 0) {
    db.records.push({
      id: uid(),
      itemId: item.id,
      type: "in",
      qty: init,
      date: today(),
      note: "期初库存",
      by: str(body.by, 20) || "系统",
      ts: Date.now()
    });
  }
  persist();
  return { status: 200, data: { ok: true, item, state: db } };
}

function updateItem(id, body) {
  const item = db.items.find((x) => x.id === id);
  if (!item) return { status: 404, error: "物料不存在" };
  const code = str(body.code, 24);
  const name = str(body.name, 40);
  if (!code) return { status: 400, error: "编码不能为空" };
  if (!name) return { status: 400, error: "名称不能为空" };
  if (db.items.some((x) => x.id !== id && x.code.toLowerCase() === code.toLowerCase())) {
    return { status: 409, error: "编码 " + code + " 已存在" };
  }
  item.code = code;
  item.name = name;
  item.spec = str(body.spec, 60);
  item.unit = str(body.unit, 8) || "个";
  item.safe = Math.max(0, num(body.safe) || 0);
  persist();
  return { status: 200, data: { ok: true, item, state: db } };
}

function deleteItem(id) {
  const item = db.items.find((x) => x.id === id);
  if (!item) return { status: 404, error: "物料不存在" };
  db.items = db.items.filter((x) => x.id !== id);
  db.records = db.records.filter((r) => r.itemId !== id);
  persist();
  return { status: 200, data: { ok: true, state: db } };
}

function today() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function createMove(body) {
  const item = db.items.find((x) => x.id === body.itemId);
  if (!item) return { status: 404, error: "物料不存在" };
  const type = body.type === "out" ? "out" : body.type === "in" ? "in" : null;
  if (!type) return { status: 400, error: "类型必须是 in 或 out" };
  const qty = round(num(body.qty));
  if (!Number.isFinite(qty) || qty <= 0) return { status: 400, error: "数量必须大于 0" };
  if (qty > 1e7) return { status: 400, error: "数量太大" };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) ? body.date : today();

  if (type === "out") {
    const stock = stockMap().get(item.id) || 0;
    if (qty > stock) {
      return { status: 400, error: "库存不足：当前只有 " + stock + " " + item.unit };
    }
  }

  const rec = {
    id: uid(),
    itemId: item.id,
    type,
    qty,
    date,
    note: str(body.note, 40),
    by: str(body.by, 20) || "未署名",
    ts: Date.now()
  };
  db.records.push(rec);
  persist();
  return { status: 200, data: { ok: true, record: rec, state: db } };
}

function deleteMove(id) {
  const rec = db.records.find((r) => r.id === id);
  if (!rec) return { status: 404, error: "记录不存在" };

  // 删掉一条入库会让库存减少；如果减完变负，说明有出库记录依赖它，
  // 直接删会留下对不上账的负库存，所以在这里拦住。
  if (rec.type === "in") {
    const stock = stockMap().get(rec.itemId) || 0;
    const after = round(stock - rec.qty);
    if (after < -1e-9) {
      const item = db.items.find((x) => x.id === rec.itemId);
      const unit = item ? item.unit : "";
      return {
        status: 400,
        error:
          "删掉这条入库会让库存变成 " + fmtNum(after) + " " + unit +
          "（当前 " + fmtNum(stock) + " " + unit + "），请先把依赖它的出库记录删掉"
      };
    }
  }

  db.records = db.records.filter((r) => r.id !== id);
  persist();
  return { status: 200, data: { ok: true, state: db } };
}

function fmtNum(n) {
  return String(Math.round(n * 1000) / 1000);
}

/* ---------------- 路由 ---------------- */

function authorized(req) {
  if (!ACCESS_CODE) return true;
  const given = String(req.headers["x-access-code"] || "");
  const a = Buffer.from(given);
  const b = Buffer.from(ACCESS_CODE);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/* 失败次数限制：同一 IP 5 分钟内最多试 6 次 */
const AUTH_FAILS = new Map();
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_MAX_FAILS = 6;
const AUTH_CLEANUP_THRESHOLD = 500;

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function clientIp(req) {
  const remote = req.socket.remoteAddress || "";

  // X-Forwarded-For 是客户端能随意伪造的请求头，直接采信等于把限流交给攻击者：
  // 每次换个头就能换一个桶，爆破次数限制形同虚设。
  // 只有当连接确实来自本机的反向代理（Caddy/Nginx）时才采信，
  // 这时代理会把真实客户端 IP 追加在末尾，所以取最后一个而不是第一个。
  if (isLoopback(remote)) {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) {
      const parts = String(fwd).split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return remote || "unknown";
}

function authBlocked(ip) {
  const rec = AUTH_FAILS.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > AUTH_WINDOW_MS) {
    AUTH_FAILS.delete(ip);
    return false;
  }
  return rec.count >= AUTH_MAX_FAILS;
}

function recordAuthFail(ip) {
  const now = Date.now();

  // AUTH_FAILS 只按 IP 增长，不清理会一直占内存，这里顺手扫掉过期项
  if (AUTH_FAILS.size > AUTH_CLEANUP_THRESHOLD) {
    for (const [k, v] of AUTH_FAILS) {
      if (now - v.first > AUTH_WINDOW_MS) AUTH_FAILS.delete(k);
    }
  }

  const rec = AUTH_FAILS.get(ip);
  if (!rec || now - rec.first > AUTH_WINDOW_MS) {
    AUTH_FAILS.set(ip, { first: now, count: 1 });
  } else {
    rec.count += 1;
  }
}

async function handleApi(req, res, pathname) {
  const method = req.method || "GET";

  if (method === "GET" && pathname === "/api/state") {
    return sendJson(res, 200, { ok: true, state: db, serverTime: Date.now() });
  }
  if (method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      version: db.version,
      items: db.items.length,
      records: db.records.length,
      updatedAt: db.updatedAt
    });
  }

  let body;
  if (method !== "GET" && method !== "DELETE") {
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  } else {
    body = {};
  }

  const mItem = pathname.match(/^\/api\/items\/([\w-]+)$/);
  const mMove = pathname.match(/^\/api\/moves\/([\w-]+)$/);

  let result;
  if (method === "POST" && pathname === "/api/items") result = createItem(body);
  else if (method === "PUT" && mItem) result = updateItem(mItem[1], body);
  else if (method === "DELETE" && mItem) result = deleteItem(mItem[1]);
  else if (method === "POST" && pathname === "/api/moves") result = createMove(body);
  else if (method === "DELETE" && mMove) result = deleteMove(mMove[1]);
  else return sendJson(res, 404, { ok: false, error: "接口不存在" });

  if (result.error) return sendJson(res, result.status, { ok: false, error: result.error });
  return sendJson(res, 200, result.data);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8"
};

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(path.join(PUBLIC_DIR, rel));

  // 用 relative 判断而不是 startsWith：
  // startsWith 会把 /opt/cangku/public-secrets 误判成在 /opt/cangku/public 里面
  const inside = path.relative(path.resolve(PUBLIC_DIR), resolved);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    return sendJson(res, 403, { ok: false, error: "禁止访问" });
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff"
      });
      res.end("页面不存在");
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600"
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return sendJson(res, 400, { ok: false, error: "非法路径" });
  }

  if (pathname.startsWith("/api/")) {
    if (!authorized(req)) {
      // 只有「带了错误访问码」才计入失败次数；没带码不算（否则登录页轮询会把自己锁死）
      const given = String(req.headers["x-access-code"] || "");
      const ip = clientIp(req);
      if (given) {
        if (authBlocked(ip)) {
          return sendJson(res, 429, { ok: false, error: "尝试次数过多，请 5 分钟后再试" });
        }
        recordAuthFail(ip);
        return sendJson(res, 401, { ok: false, error: "访问码错误" });
      }
      return sendJson(res, 401, { ok: false, error: "需要访问码" });
    }
    handleApi(req, res, pathname).catch((err) => {
      console.error("[api]", err);
      sendJson(res, 500, { ok: false, error: "服务器内部错误" });
    });
    return;
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("仓库管理服务已启动");
  console.log("  端口: " + PORT);
  console.log("  数据: " + DATA_FILE);
  console.log("  物料 " + db.items.length + " 种，流水 " + db.records.length + " 条");
  console.log("  访问码: " + (ACCESS_CODE ? "已启用" : "未启用（局域网内任何人可访问）"));
});

function shutdown(sig) {
  try { persist(); } catch {}
  console.log("\n收到 " + sig + "，已保存并退出");
  process.exit(0);
}

// systemd stop 发的是 SIGTERM，只监听 SIGINT 的话正常停止走不到保存逻辑
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Node 15+ 默认遇到未捕获的 Promise 拒绝会直接退出，
// 这里先打日志，避免线上只看到进程没了却不知道原因
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});
