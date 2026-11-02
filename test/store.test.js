'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../src/store');

test('store persists reports, blocks and bans', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gomi-store-'));
  try {
    const store = new JsonStore(directory);
    await store.init();
    const report = store.addReport({ reporterId: 'reporter', reportedId: 'reported', reason: 'Spam atau penipuan', comment: 'test' });
    store.addBlock('reporter', 'reported');
    store.ban('reported', 'spam');
    await store.persist('reports.json', store.reports);
    await store.persist('blocks.json', store.blocks);
    await store.persist('bans.json', store.bans);

    const restored = new JsonStore(directory);
    await restored.init();
    assert.equal(restored.reports[0].id, report.id);
    assert.equal(restored.isBlocked('reporter', 'reported'), true);
    assert.equal(restored.isBanned('reported'), true);
    assert.equal(restored.setReportStatus(report.id, 'reviewed'), true);
    assert.equal(restored.reports[0].status, 'reviewed');
    await restored.persist('reports.json', restored.reports);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
