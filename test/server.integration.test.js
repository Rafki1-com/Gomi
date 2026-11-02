'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function listenFor(ws, eventName, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), timeoutMs);
    const handler = (event) => {
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (packet.event !== eventName) return;
      clearTimeout(timer);
      ws.removeEventListener('message', handler);
      resolve(packet.data);
    };
    ws.addEventListener('message', handler);
  });
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 4000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); }, { once: true });
  });
}

const isWindows = process.platform === 'win32';
test('native server exposes health/config and matches two websocket users with realtime chat + reports', { timeout: 20_000 }, async (t) => {
  const port = await getFreePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gomi-server-'));
  const adminToken = 'integration-test-admin-secret';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ADMIN_TOKEN: adminToken, NODE_ENV: 'test', APP_ORIGIN: '', TRUST_PROXY: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill(isWindows ? undefined : 'SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) { health = await response.json(); break; }
    } catch { /* Server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(health?.app, 'Gomi', `server failed to start: ${serverOutput}`);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Obrolan baru/);
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.iceServers[0].urls[0], 'stun:stun.l.google.com:19302');

  const id1 = cryptoUuid();
  const id2 = cryptoUuid();
  const ws1 = await connectWs(`ws://127.0.0.1:${port}/ws?userId=${id1}`);
  const waiting1 = listenFor(ws1, 'match:waiting');
  ws1.send(JSON.stringify({ event: 'match:find', data: { country: 'ID', desiredCountry: 'ANY' } }));
  await waiting1;

  const ws2 = await connectWs(`ws://127.0.0.1:${port}/ws?userId=${id2}`);
  const found1 = listenFor(ws1, 'match:found');
  const found2 = listenFor(ws2, 'match:found');
  ws2.send(JSON.stringify({ event: 'match:find', data: { country: 'MY', desiredCountry: 'ANY' } }));
  const [match1, match2] = await Promise.all([found1, found2]);
  assert.equal(match1.partnerId, id2);
  assert.equal(match2.partnerId, id1);

  const signalReceived = listenFor(ws2, 'peer:signal');
  ws1.send(JSON.stringify({ event: 'peer:signal', data: { description: { type: 'offer', sdp: 'test-sdp' } } }));
  assert.equal((await signalReceived).description.sdp, 'test-sdp');

  const messageReceived = listenFor(ws2, 'chat:message');
  const messageSent = listenFor(ws1, 'chat:sent');
  ws1.send(JSON.stringify({ event: 'chat:send', data: { message: 'Halo dari integration test' } }));
  assert.equal((await messageReceived).message, 'Halo dari integration test');
  assert.equal((await messageSent).message, 'Halo dari integration test');

  const reportAck = listenFor(ws1, 'safety:reported');
  ws1.send(JSON.stringify({ event: 'safety:report', data: { userId: id2, reason: 'Spam atau penipuan', comment: 'test report' } }));
  await reportAck;
  const adminResponse = await fetch(`${base}/api/admin/reports`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(adminResponse.status, 200);
  const adminData = await adminResponse.json();
  assert.equal(adminData.reports.length, 1);
  assert.equal(adminData.reports[0].reportedId, id2);
  const patchResponse = await fetch(`${base}/api/admin/reports/${adminData.reports[0].id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'reviewed' }) });
  assert.equal(patchResponse.status, 200);
  const banResponse = await fetch(`${base}/api/admin/bans`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: id2, reason: 'integration test' }) });
  assert.equal(banResponse.status, 201);
  assert.equal((await fetch(`${base}/api/admin/reports`, { headers: { Authorization: `Bearer ${adminToken}` } })).status, 200);
  const unbanResponse = await fetch(`${base}/api/admin/bans/${id2}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(unbanResponse.status, 200);
  ws1.close(); ws2.close();
});

function cryptoUuid() { return require('node:crypto').randomUUID(); }
