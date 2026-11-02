'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class JsonStore {
  constructor(directory) {
    this.directory = directory;
    this.blocks = [];
    this.reports = [];
    this.bans = [];
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    this.blocks = await this.read('blocks.json', []);
    this.reports = await this.read('reports.json', []);
    this.bans = await this.read('bans.json', []);
  }

  async read(filename, fallback) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(this.directory, filename), 'utf8'));
      return Array.isArray(value) ? value : fallback;
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      console.error(`Could not read ${filename}:`, error.message);
      return fallback;
    }
  }

  persist(filename, value) {
    const target = path.join(this.directory, filename);
    const temporary = `${target}.${process.pid}.tmp`;
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
      await fs.rename(temporary, target);
    }).catch((error) => {
      console.error(`Could not persist ${filename}:`, error.message);
    });
    return this.writeQueue;
  }

  isBlocked(by, target) {
    return this.blocks.some((item) => item.by === by && item.target === target);
  }

  addBlock(by, target) {
    if (!by || !target || by === target || this.isBlocked(by, target)) return false;
    this.blocks.push({ by, target, createdAt: new Date().toISOString() });
    void this.persist('blocks.json', this.blocks);
    return true;
  }

  isBanned(userId) {
    return this.bans.some((item) => item.userId === userId);
  }

  addReport({ reporterId, reportedId, reason, comment }) {
    const report = {
      id: crypto.randomUUID(),
      reporterId,
      reportedId,
      reason,
      comment: comment || '',
      status: 'open',
      createdAt: new Date().toISOString()
    };
    this.reports.unshift(report);
    void this.persist('reports.json', this.reports);
    return report;
  }

  setReportStatus(id, status) {
    const report = this.reports.find((item) => item.id === id);
    if (!report) return false;
    report.status = status;
    report.updatedAt = new Date().toISOString();
    void this.persist('reports.json', this.reports);
    return true;
  }

  ban(userId, reason = 'Pelanggaran panduan komunitas') {
    if (!userId || this.isBanned(userId)) return false;
    this.bans.push({ userId, reason: String(reason).slice(0, 160), createdAt: new Date().toISOString() });
    void this.persist('bans.json', this.bans);
    return true;
  }

  unban(userId) {
    const originalLength = this.bans.length;
    this.bans = this.bans.filter((item) => item.userId !== userId);
    if (this.bans.length === originalLength) return false;
    void this.persist('bans.json', this.bans);
    return true;
  }
}

module.exports = { JsonStore };
