#!/usr/bin/env node
/*
 * CPE Explorer — standalone server
 * Serves the game (./public) and a small scoreboard API. No npm packages needed (Node.js 18+).
 *
 *   node server.js                 → http://localhost:8080
 *   PORT=3000 ADMIN_KEY=secret node server.js
 *
 * Scores are stored in ./data/scores.json (created automatically).
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

// ---------- settings ----------
loadDotEnv(path.join(__dirname, ".env"));
const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_ENTRIES = parseInt(process.env.MAX_ENTRIES || "5000", 10);
const WRITE_GAP_MS = parseInt(process.env.WRITE_GAP_MS || "2000", 10); // min gap between saves per device/IP
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || "");

// Game limits (generated from the course data when the package was built).
const LIMITS = /*LIMITS*/{"courses": 81, "quizzes": 79, "shards": 12, "islandStars": 12, "pts": {"disc": 10, "star": 20, "shard": 25, "istar": 50, "title": 100}, "maxScore": 3390}/*END*/;

// Words that must not appear in public nicknames (lower-case; Thai and English). Extend in data/blocklist.txt (one per line).
const BLOCK = ["fuck", "shit", "bitch", "cunt", "pussy", "nigger", "nigga", "slut", "whore", "porn",
  "เหี้ย", "สัส", "ควย", "แตด", "เย็ด", "ไอ้สัตว์", "อีดอก", "ส้นตีน", "ระยำ", "ชาติหมา"];

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const SCORE_FILE = path.join(DATA_DIR, "scores.json");
let scores = {};
try { scores = JSON.parse(fs.readFileSync(SCORE_FILE, "utf8")) || {}; } catch { scores = {}; }
try { fs.readFileSync(path.join(DATA_DIR, "blocklist.txt"), "utf8").split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean).forEach(w => BLOCK.push(w)); } catch {}
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = SCORE_FILE + ".tmp";
    fs.writeFile(tmp, JSON.stringify(scores), err => {
      if (err) return console.error("save failed:", err.message);
      fs.rename(tmp, SCORE_FILE, e2 => e2 && console.error("save failed:", e2.message));
    });
  }, 300);
}
function trim() {
  const ids = Object.keys(scores);
  if (ids.length <= MAX_ENTRIES) return;
  ids.sort((a, b) => scores[b].score - scores[a].score || scores[b].ts - scores[a].ts);
  for (const id of ids.slice(MAX_ENTRIES)) delete scores[id];
}

// ---------- validation ----------
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
function cleanNick(n) {
  let s = String(n || "").normalize("NFC").replace(/[^\p{L}\p{M}\p{N} _.\-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 14);
  const low = s.toLowerCase().replace(/[\s_.\-]/g, "");
  if (!s || BLOCK.some(w => low.includes(w))) s = "Explorer";
  return s;
}
function validate(b) {
  if (!b || typeof b !== "object") return "body";
  if (typeof b.id !== "string" || !/^[a-z0-9]{6,32}$/i.test(b.id)) return "id";
  const L = LIMITS;
  if (!int(b.seen, 0, L.courses) || !int(b.stars, 0, L.quizzes) || !int(b.shards, 0, L.shards) || !int(b.istars, 0, L.islandStars)) return "counts";
  if (b.stars > b.seen) return "stars";
  const title = typeof b.title === "string" ? b.title.slice(0, 40) : "";
  if (title && !/^[A-Z0-9 ]{0,12}\|[A-Z0-9 ]{0,12}$/i.test(title)) return "title";
  const both = /^[^|]+\|[^|]+$/.test(title);
  const expect = b.seen * L.pts.disc + b.stars * L.pts.star + b.shards * L.pts.shard + b.istars * L.pts.istar + (both ? L.pts.title : 0);
  if (!int(b.score, 0, L.maxScore) || b.score !== expect) return "score";
  if (b.lv !== undefined && !int(b.lv, 1, 99)) return "lv";
  const form = String(b.form || "");
  if (form && !["Bit", "Byte", "Kilobyte", "Megabyte", "Gigabyte"].includes(form)) return "form";
  return null;
}

// ---------- rate limit ----------
const lastWrite = new Map();
function limited(key) {
  const now = Date.now(), t = lastWrite.get(key) || 0;
  if (now - t < WRITE_GAP_MS) return true;
  lastWrite.set(key, now);
  if (lastWrite.size > 20000) for (const [k, v] of lastWrite) if (now - v > 60000) lastWrite.delete(k);
  return false;
}

// ---------- http helpers ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8" };
const SEC = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "SAMEORIGIN" };
function send(res, code, body, type = "application/json; charset=utf-8", extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(code, { "Content-Type": type, "Content-Length": buf.length, "Cache-Control": "no-store", ...SEC, ...extra });
  res.end(buf);
}
function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on("data", c => { n += c.length; if (n > max) { reject(new Error("too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); } catch { reject(new Error("json")); } });
    req.on("error", reject);
  });
}
const clientIp = req => (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
function isAdmin(req) {
  if (!ADMIN_KEY) return false;
  const k = Buffer.from(String(req.headers["x-admin-key"] || "")), a = Buffer.from(ADMIN_KEY);
  return k.length === a.length && crypto.timingSafeEqual(k, a);
}
const publicRow = r => ({ nick: r.nick, score: r.score, stars: r.stars, seen: r.seen, shards: r.shards, istars: r.istars, lv: r.lv, title: r.title, form: r.form, ts: r.ts });
const top = n => Object.values(scores).sort((a, b) => b.score - a.score || a.ts - b.ts).slice(0, n);

// ---------- static files ----------
const fileCache = new Map();
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: "forbidden" });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found", "text/plain; charset=utf-8");
    const ext = path.extname(file).toLowerCase(), type = MIME[ext] || "application/octet-stream";
    const etag = '"' + st.size.toString(36) + "-" + st.mtimeMs.toString(36) + '"';
    const cache = ext === ".html" || rel === "/config.js" ? "no-cache" : "public, max-age=604800";
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag, "Cache-Control": cache, ...SEC }); return res.end(); }
    const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "") && /html|javascript|css|json|svg|plain/.test(type);
    const key = file + (gz ? ":gz" : "");
    const hit = fileCache.get(key);
    const done = buf => {
      res.writeHead(200, { "Content-Type": type, "Content-Length": buf.length, ETag: etag, "Cache-Control": cache, ...(gz ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}), ...SEC });
      res.end(req.method === "HEAD" ? undefined : buf);
    };
    if (hit && hit.etag === etag) return done(hit.buf);
    fs.readFile(file, (e2, raw) => {
      if (e2) return send(res, 500, { error: "read" });
      const buf = gz ? zlib.gzipSync(raw, { level: 9 }) : raw;
      if (buf.length < 8e6) fileCache.set(key, { etag, buf });
      done(buf);
    });
  });
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/\/{2,}/g, "/");
  try {
    // health
    if (p === "/api/health") return send(res, 200, { ok: true, entries: Object.keys(scores).length });
    // public scoreboard
    if (p === "/api/scores" && req.method === "GET") {
      const n = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit") || "200", 10) || 200));
      return send(res, 200, top(n).map(publicRow));
    }
    if (p === "/api/scores" && req.method === "POST") {
      const b = await readBody(req).catch(() => null);
      if (!b) return send(res, 400, { error: "bad json" });
      const why = validate(b);
      if (why) return send(res, 422, { error: "rejected", field: why });
      if (limited(clientIp(req) + "|" + b.id)) return send(res, 429, { error: "slow down" }, undefined, { "Retry-After": "3" });
      const prev = scores[b.id];
      if (prev && prev.score > b.score && !b.reset) return send(res, 200, { ok: true, kept: "higher" });
      scores[b.id] = { id: b.id, nick: cleanNick(b.nick), score: b.score, stars: b.stars, seen: b.seen, shards: b.shards, istars: b.istars,
        lv: b.lv || 1, title: typeof b.title === "string" ? b.title.slice(0, 40) : "", form: b.form || "Bit", ts: Date.now() };
      trim(); persist();
      return send(res, 200, { ok: true });
    }
    // admin
    if (p.startsWith("/api/admin/")) {
      if (!isAdmin(req)) return send(res, ADMIN_KEY ? 401 : 503, { error: ADMIN_KEY ? "admin key required" : "set ADMIN_KEY to enable admin" });
      if (p === "/api/admin/scores" && req.method === "GET") return send(res, 200, top(100000));
      const m = p.match(/^\/api\/admin\/scores\/([a-z0-9]{6,32})$/i);
      if (m && req.method === "DELETE") { const had = !!scores[m[1]]; delete scores[m[1]]; persist(); return send(res, 200, { ok: true, deleted: had }); }
      if (m && req.method === "PATCH") { const b = await readBody(req).catch(() => ({})); if (!scores[m[1]]) return send(res, 404, { error: "not found" }); if (b.nick !== undefined) scores[m[1]].nick = cleanNick(b.nick); persist(); return send(res, 200, { ok: true, entry: scores[m[1]] }); }
      if (p === "/api/admin/reset" && req.method === "POST") {
        const backup = path.join(DATA_DIR, "scores-backup-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
        fs.writeFileSync(backup, JSON.stringify(scores)); scores = {}; persist();
        return send(res, 200, { ok: true, backup: path.basename(backup) });
      }
      return send(res, 404, { error: "unknown admin route" });
    }
    if (p.startsWith("/api/")) return send(res, 404, { error: "unknown route" });
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method" });
    return serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: "server" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`CPE Explorer running at http://localhost:${PORT}`);
  console.log(`Scores: ${SCORE_FILE} (${Object.keys(scores).length} entries)` + (ADMIN_KEY ? "" : " · admin disabled (set ADMIN_KEY)"));
});
const stop = () => { clearTimeout(saveTimer); try { fs.writeFileSync(SCORE_FILE, JSON.stringify(scores)); } catch {} process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {}
}
