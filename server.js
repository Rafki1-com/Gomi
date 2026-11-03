'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { findCompatible } = require('./src/matcher');
const { JsonStore } = require('./src/store');

function loadEnvFile() {
  try {
    const content = fsSync.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) { if (error.code !== 'ENOENT') console.warn('Tidak dapat membaca .env:', error.message); }
}
loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const APP_ORIGIN = process.env.APP_ORIGIN || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const MAX_COMMENT = 500;
const MAX_SOCKET_PAYLOAD = 100_000;
const COUNTRY_CODES = new Set(['ID', 'MY', 'SG', 'TH', 'PH', 'VN', 'JP', 'KR', 'IN', 'AU', 'US', 'GB', 'DE', 'FR', 'BR', 'TR']);
const store = new JsonStore(DATA_DIR);
const waiting = new Map();
const partnerByConnection = new Map();
const userToConnection = new Map();
const connections = new Set();
const eventTimes = new Map();
const httpRates = new Map();
const upgradeRates = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8'
};

function validUserId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function timingSafeToken(candidate) {
  if (!ADMIN_TOKEN || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function makeIceServers() {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const urls = (process.env.TURN_URLS || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (urls.length && process.env.TURN_SHARED_SECRET) {
    const expiry = Math.floor(Date.now() / 1000) + 60 * 60;
    const username = `${expiry}:gomi`;
    const credential = crypto.createHmac('sha1', process.env.TURN_SHARED_SECRET).update(username).digest('base64');
    servers.push({ urls, username, credential });
  } else if (urls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  return servers;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateAllowed(map, key, limit, windowMs) {
  const now = Date.now();
  let record = map.get(key);
  if (!record || now - record.start >= windowMs) {
    record = { start: now, count: 0 };
    map.set(key, record);
  }
  record.count += 1;
  return record.count <= limit;
}

function setSecurityHeaders(res) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    ...(process.env.NODE_ENV === 'production' ? ['upgrade-insecure-requests'] : [])
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJsonBody(req, maxBytes = 20_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body terlalu besar.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON tidak valid.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function checkAdmin(req, res) {
  if (!ADMIN_TOKEN) {
    sendJson(res, 503, { error: 'ADMIN_TOKEN belum dikonfigurasi di server.' });
    return false;
  }
  const candidate = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!timingSafeToken(candidate)) {
    sendJson(res, 401, { error: 'Token admin tidak valid.' });
    return false;
  }
  return true;
}

function originAllowed(origin, host) {
  if (!origin) return true;
  if (APP_ORIGIN) return origin === APP_ORIGIN;
  try { return new URL(origin).host === host; }
  catch { return false; }
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method tidak diizinkan.' });
  let relative = pathname === '/' ? 'index.html' : pathname === '/admin' ? 'admin.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  relative = path.normalize(relative);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return sendJson(res, 403, { error: 'Path tidak diizinkan.' });
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return sendJson(res, 403, { error: 'Path tidak diizinkan.' });
  let stat;
  try { stat = await fs.stat(filePath); }
  catch { return sendJson(res, 404, { error: 'Halaman tidak ditemukan.' }); }
  if (!stat.isFile()) return sendJson(res, 404, { error: 'Halaman tidak ditemukan.' });
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : (process.env.NODE_ENV === 'production' ? 'public, max-age=3600' : 'no-store')
  });
  if (req.method === 'HEAD') return res.end();
  const stream = require('node:fs').createReadStream(filePath);
  stream.on('error', () => { if (!res.headersSent) sendJson(res, 500, { error: 'Gagal membaca file.' }); else res.destroy(); });
  stream.pipe(res);
}

async function handleHttp(req, res) {
  setSecurityHeaders(res);
  if (!rateAllowed(httpRates, clientIp(req), 240, 60_000)) return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi sebentar.' });
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return sendJson(res, 400, { error: 'URL tidak valid.' }); }
  const pathname = url.pathname;

  if (pathname.startsWith('/api/') && !originAllowed(req.headers.origin, req.headers.host || '')) {
    return sendJson(res, 403, { error: 'Origin tidak diizinkan.' });
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, app: 'Gomi', version: '1.1.0', timestamp: new Date().toISOString() });
  }
  if (pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { name: 'Gomi', version: '1.1.0', iceServers: makeIceServers(), countries: Array.from(COUNTRY_CODES) });
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!checkAdmin(req, res)) return;
    if (pathname === '/api/admin/reports' && req.method === 'GET') {
      return sendJson(res, 200, { reports: store.reports.slice(0, 500), bans: store.bans });
    }
    if (pathname.startsWith('/api/admin/reports/') && req.method === 'PATCH') {
      const id = decodeURIComponent(pathname.slice('/api/admin/reports/'.length));
      let body;
      try { body = await readJsonBody(req); } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
      if (!['open', 'reviewed', 'resolved'].includes(body.status)) return sendJson(res, 400, { error: 'Status tidak valid.' });
      if (!store.setReportStatus(id, body.status)) return sendJson(res, 404, { error: 'Laporan tidak ditemukan.' });
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/admin/bans' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
      if (!validUserId(body.userId)) return sendJson(res, 400, { error: 'ID pengguna tidak valid.' });
      const created = store.ban(body.userId, body.reason);
      const active = userToConnection.get(body.userId);
      if (active) active.close(4003, 'Banned by moderator');
      return sendJson(res, created ? 201 : 200, { ok: true, alreadyBanned: !created });
    }
    if (pathname.startsWith('/api/admin/bans/') && req.method === 'DELETE') {
      const userId = decodeURIComponent(pathname.slice('/api/admin/bans/'.length));
      if (!validUserId(userId)) return sendJson(res, 400, { error: 'ID pengguna tidak valid.' });
      return sendJson(res, 200, { ok: store.unban(userId) });
    }
    return sendJson(res, 404, { error: 'Endpoint admin tidak ditemukan.' });
  }

  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Endpoint tidak ditemukan.' });
  return serveStatic(req, res, pathname);
}

class WebSocketConnection {
  constructor(socket, head, userId) {
    this.id = crypto.randomUUID();
    this.socket = socket;
    this.userId = userId;
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentSize = 0;
    this.closed = false;
    this.lastPong = Date.now();
    this.handlers = new Map();
    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('error', () => this.finish());
    socket.on('close', () => this.finish());
  }

  on(event, callback) {
    const list = this.handlers.get(event) || [];
    list.push(callback);
    this.handlers.set(event, list);
  }

  dispatch(event, data) {
    const list = this.handlers.get(event) || [];
    for (const callback of list) {
      try { callback(data); } catch (error) { console.error(`WebSocket handler ${event}:`, error); }
    }
  }

  sendFrame(opcode, payload = Buffer.alloc(0)) {
    if (this.closed && opcode !== 8) return;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let header;
    if (data.length < 126) {
      header = Buffer.alloc(2); header[1] = data.length;
    } else if (data.length <= 0xffff) {
      header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, data]));
  }

  send(event, data = {}) {
    if (this.closed || this.socket.destroyed) return;
    const payload = JSON.stringify({ event, data });
    this.sendFrame(1, Buffer.from(payload, 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(String(reason).slice(0, 100), 'utf8');
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0); reasonBuffer.copy(payload, 2);
    this.sendFrame(8, payload);
    this.closed = true;
    this.socket.end();
    this.finish();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.closed = true;
    this.dispatch('close');
  }

  consume(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if ((first & 0x70) !== 0 || !masked) return this.close(1002, 'Invalid frame');
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const bigLength = this.buffer.readBigUInt64BE(2);
        if (bigLength > BigInt(MAX_SOCKET_PAYLOAD)) return this.close(1009, 'Payload too large');
        length = Number(bigLength); offset = 10;
      }
      if (length > MAX_SOCKET_PAYLOAD) return this.close(1009, 'Payload too large');
      const control = opcode >= 8;
      if (control && (!fin || length > 125)) return this.close(1002, 'Invalid control frame');
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      this.buffer = this.buffer.subarray(offset + 4 + length);
      if (opcode === 8) { this.sendFrame(8, payload.subarray(0, 125)); this.closed = true; this.socket.end(); this.finish(); return; }
      if (opcode === 9) { this.sendFrame(10, payload); continue; }
      if (opcode === 10) { this.lastPong = Date.now(); continue; }
      if (opcode === 1) {
        if (this.fragmentOpcode !== null) return this.close(1002, 'Nested fragments');
        if (fin) this.dispatch('message', payload.toString('utf8'));
        else { this.fragmentOpcode = 1; this.fragments = [payload]; this.fragmentSize = payload.length; }
      } else if (opcode === 0) {
        if (this.fragmentOpcode === null) return this.close(1002, 'Unexpected continuation');
        this.fragmentSize += payload.length;
        if (this.fragmentSize > MAX_SOCKET_PAYLOAD) return this.close(1009, 'Payload too large');
        this.fragments.push(payload);
        if (fin) {
          this.dispatch('message', Buffer.concat(this.fragments).toString('utf8'));
          this.fragmentOpcode = null; this.fragments = []; this.fragmentSize = 0;
        }
      } else if (opcode === 2) return this.close(1003, 'Binary not supported');
      else return this.close(1002, 'Unsupported opcode');
    }
  }
}

function removeFromQueue(connection) { waiting.delete(connection); }

function endPair(connection, reason = 'left') {
  const peer = partnerByConnection.get(connection);
  if (!peer) return;
  partnerByConnection.delete(connection);
  partnerByConnection.delete(peer);
  if (!peer.closed) peer.send('peer:left', { reason });
}

function cleanupConnection(connection) {
  removeFromQueue(connection);
  endPair(connection, 'disconnected');
  if (userToConnection.get(connection.userId) === connection) userToConnection.delete(connection.userId);
  connections.delete(connection);
  for (const key of eventTimes.keys()) if (key.startsWith(`${connection.id}:`)) eventTimes.delete(key);
}

function allowEvent(connection, event, interval = 250) {
  const key = `${connection.id}:${event}`;
  const now = Date.now();
  const last = eventTimes.get(key) || 0;
  if (now - last < interval) return false;
  eventTimes.set(key, now);
  return true;
}

function normalizePreference(payload) {
  const country = payload && typeof payload.country === 'string' && COUNTRY_CODES.has(payload.country) ? payload.country : 'ID';
  const desiredCountry = payload && (payload.desiredCountry === 'ANY' || COUNTRY_CODES.has(payload.desiredCountry)) ? payload.desiredCountry : 'ANY';
  return { country, desiredCountry };
}

function findMatch(connection, payload) {
  removeFromQueue(connection);
  endPair(connection, 'skipped');
  const preference = normalizePreference(payload || {});
  const current = { socketId: connection.id, connection, userId: connection.userId, ...preference };
  const candidate = findCompatible(Array.from(waiting.values()), current, (a, b) => a === b || store.isBlocked(a, b));
  if (!candidate) {
    waiting.set(connection, current);
    connection.send('match:waiting');
    return;
  }
  waiting.delete(candidate.connection);
  if (candidate.connection.closed) {
    waiting.set(connection, current);
    connection.send('match:waiting');
    return;
  }
  const pairId = crypto.randomUUID();
  partnerByConnection.set(connection, candidate.connection);
  partnerByConnection.set(candidate.connection, connection);
  connection.send('match:found', { pairId, partnerId: candidate.userId, partnerCountry: candidate.country, initiator: true });
  candidate.connection.send('match:found', { pairId, partnerId: connection.userId, partnerCountry: preference.country, initiator: false });
}

function handleSocketEvent(connection, event, payload) {
  if (connection.closed || typeof event !== 'string') return;
  if (event === 'match:find') {
    if (!allowEvent(connection, event, 700)) return;
    if (store.isBanned(connection.userId)) return connection.close(4003, 'Banned');
    findMatch(connection, payload || {});
    return;
  }
  if (event === 'match:stop') {
    removeFromQueue(connection);
    endPair(connection, 'stopped');
    connection.send('match:stopped');
    return;
  }
  if (event === 'peer:signal') {
    if (!allowEvent(connection, event, 15)) return;
    const peer = partnerByConnection.get(connection);
    if (!peer || !payload || typeof payload !== 'object') return;
    const description = payload.description;
    const candidate = payload.candidate;
    if (description && typeof description.type === 'string' && typeof description.sdp === 'string' && description.sdp.length < 50_000) {
      peer.send('peer:signal', { description });
    } else if (candidate && typeof candidate.candidate === 'string' && candidate.candidate.length < 4_000) {
      peer.send('peer:signal', { candidate });
    }
    return;
  }
  if (event === 'chat:send') {
    if (!allowEvent(connection, event, 350)) return;
    const peer = partnerByConnection.get(connection);
    const message = payload && typeof payload.message === 'string' ? payload.message.trim().slice(0, 500) : '';
    if (!peer || !message) return;
    const sentAt = new Date().toISOString();
    peer.send('chat:message', { message, sentAt });
    connection.send('chat:sent', { message, sentAt });
    return;
  }
  if (event === 'safety:block') {
    const targetId = payload && payload.userId;
    if (!validUserId(targetId) || targetId === connection.userId) return;
    store.addBlock(connection.userId, targetId);
    if (partnerByConnection.has(connection)) endPair(connection, 'blocked');
    connection.send('safety:blocked');
    return;
  }
  if (event === 'safety:report') {
    if (!allowEvent(connection, event, 1000)) return;
    const targetId = payload && payload.userId;
    const reason = payload && typeof payload.reason === 'string' ? payload.reason : '';
    const comment = payload && typeof payload.comment === 'string' ? payload.comment.trim().slice(0, MAX_COMMENT) : '';
    const allowedReasons = ['Konten tidak pantas', 'Pelecehan atau ujaran kebencian', 'Spam atau penipuan', 'Pengguna di bawah umur', 'Lainnya'];
    if (!validUserId(targetId) || targetId === connection.userId || !allowedReasons.includes(reason)) return;
    const peer = partnerByConnection.get(connection);
    if (!peer || peer.userId !== targetId) return;
    store.addReport({ reporterId: connection.userId, reportedId: targetId, reason, comment });
    store.addBlock(connection.userId, targetId);
    endPair(connection, 'reported');
    connection.send('safety:reported');
  }
}

const server = http.createServer((req, res) => {
  handleHttp(req, res).catch((error) => {
    console.error('HTTP error:', error);
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : 'Kesalahan server.' });
    else res.destroy();
  });
});

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy(); }
  const origin = req.headers.origin;
  const userId = url.searchParams.get('userId');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy();
  }
  if (!originAllowed(origin, req.headers.host || '')) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy();
  }
  const forwardedIp = TRUST_PROXY && typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : '';
  const upgradeIp = forwardedIp || req.socket.remoteAddress || 'unknown';
  if (!rateAllowed(upgradeRates, upgradeIp, 30, 60_000)) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return socket.destroy();
  }
  if (!validUserId(userId) || store.isBanned(userId)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy();
  }
  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n'
  ].join('\r\n'));
  const connection = new WebSocketConnection(socket, head, userId);
  const previous = userToConnection.get(userId);
  if (previous && previous !== connection) previous.close(4000, 'Session replaced');
  connections.add(connection);
  userToConnection.set(userId, connection);
  connection.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw); } catch { return connection.close(1007, 'Invalid JSON'); }
    if (!message || typeof message !== 'object' || typeof message.event !== 'string') return;
    handleSocketEvent(connection, message.event, message.data);
  });
  connection.on('close', () => cleanupConnection(connection));
  if (head && head.length) connection.consume(head);
});

const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const connection of connections) {
    if (connection.closed) continue;
    if (now - connection.lastPong > 60_000) connection.close(4001, 'Heartbeat timeout');
    else connection.sendFrame(9, Buffer.from('gomi'));
  }
}, 25_000);
heartbeat.unref();

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of eventTimes) if (now - value > 60_000) eventTimes.delete(key);
  for (const map of [httpRates, upgradeRates]) for (const [key, value] of map) if (now - value.start > 120_000) map.delete(key);
}, 60_000);
cleanup.unref();

async function start() {
  await store.init();
  server.listen(PORT, HOST, () => {
    console.log(`Gomi v1 listening on http://${HOST}:${PORT}`);
    if (!ADMIN_TOKEN) console.warn('ADMIN_TOKEN belum diatur — endpoint admin dinonaktifkan.');
    if (!(process.env.TURN_URLS && process.env.TURN_SHARED_SECRET) && process.env.NODE_ENV === 'production') {
      console.warn('TURN belum dikonfigurasi. Koneksi video antar jaringan tertentu mungkin gagal.');
    }
  });
}

start().catch((error) => {
  console.error('Gagal menjalankan Gomi:', error);
  process.exit(1);
});
