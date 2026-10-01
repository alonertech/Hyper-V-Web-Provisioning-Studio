'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

class EmbeddedStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.dbFile = path.join(rootDir, 'professional-db.json');
    this.tmpFile = path.join(rootDir, 'professional-db.json.tmp');
    this.state = null;
    this.writeQueue = Promise.resolve();
  }

  emptyState() {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      metadata: { createdAt: now, updatedAt: now, provider: 'embedded-json', product: 'Hyper-V Web Provisioning Studio Professional' },
      settings: {
        defaultRole: 'Viewer',
        auditIntegrity: 'sha256-chain',
        policyEnforcementDefault: false,
        jobHistoryLimit: 500,
        auditHistoryLimit: 5000
      },
      users: [],
      hosts: [],
      templates: [],
      policies: [],
      jobs: [],
      auditEvents: [],
      migrations: []
    };
  }

  async init() {
    await fsp.mkdir(this.rootDir, { recursive: true });
    try {
      this.state = JSON.parse(await fsp.readFile(this.dbFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.state = this.emptyState();
      await this.save();
    }
    this.normalize();
  }

  normalize() {
    const defaults = this.emptyState();
    if (!this.state || typeof this.state !== 'object') this.state = defaults;
    for (const key of ['metadata','settings']) this.state[key] = { ...(defaults[key] || {}), ...(this.state[key] || {}) };
    for (const key of ['users','hosts','templates','policies','jobs','auditEvents','migrations']) {
      if (!Array.isArray(this.state[key])) this.state[key] = [];
    }
    if (!Number.isInteger(this.state.schemaVersion)) this.state.schemaVersion = 1;
  }

  async save() {
    this.state.metadata.updatedAt = new Date().toISOString();
    const data = JSON.stringify(this.state, null, 2) + '\n';
    await fsp.writeFile(this.tmpFile, data, 'utf8');
    await fsp.rename(this.tmpFile, this.dbFile);
  }

  transaction(mutator) {
    const run = this.writeQueue.then(async () => {
      const result = await mutator(this.state);
      await this.save();
      return result;
    });
    this.writeQueue = run.catch(() => {});
    return run;
  }

  get(table) {
    return this.state[table];
  }

  async add(table, value) {
    return this.transaction(state => {
      state[table].push(value);
      return value;
    });
  }

  async upsertById(table, value) {
    return this.transaction(state => {
      const i = state[table].findIndex(x => x.id === value.id);
      if (i >= 0) state[table][i] = value;
      else state[table].push(value);
      return value;
    });
  }

  async removeById(table, id) {
    return this.transaction(state => {
      const before = state[table].length;
      state[table] = state[table].filter(x => x.id !== id);
      return state[table].length < before;
    });
  }

  async updateWhere(table, predicate, updater) {
    return this.transaction(state => {
      let changed = 0;
      state[table] = state[table].map(row => {
        if (!predicate(row)) return row;
        changed += 1;
        return updater({ ...row });
      });
      return changed;
    });
  }

  async appendAudit(event) {
    return this.transaction(state => {
      const previous = state.auditEvents[state.auditEvents.length - 1];
      const base = {
        id: crypto.randomBytes(10).toString('hex'),
        timestamp: new Date().toISOString(),
        ...event,
        prevHash: previous?.hash || null
      };
      const hashInput = JSON.stringify(base, Object.keys(base).sort());
      const hash = crypto.createHash('sha256').update(hashInput, 'utf8').digest('hex');
      const row = { ...base, hash };
      state.auditEvents.push(row);
      return row;
    });
  }

  verifyAudit() {
    let previousHash = null;
    for (const row of this.state.auditEvents) {
      const clone = { ...row };
      delete clone.hash;
      const hashInput = JSON.stringify(clone, Object.keys(clone).sort());
      const expected = crypto.createHash('sha256').update(hashInput, 'utf8').digest('hex');
      if (row.prevHash !== previousHash || row.hash !== expected) {
        return { valid: false, failedEventId: row.id, expected, actual: row.hash, previousHash, foundPrevHash: row.prevHash };
      }
      previousHash = row.hash;
    }
    return { valid: true, events: this.state.auditEvents.length, lastHash: previousHash };
  }

  async migrateV2Audit(v2AuditDir) {
    const marker = this.state.migrations.find(x => x.id === 'v2-audit-import');
    if (marker || !fs.existsSync(v2AuditDir)) return { imported: 0, skipped: true };
    let imported = 0;
    const files = (await fsp.readdir(v2AuditDir, { withFileTypes: true })).filter(x => x.isFile() && x.name.endsWith('.jsonl'));
    for (const file of files.sort((a,b) => a.name.localeCompare(b.name))) {
      const text = await fsp.readFile(path.join(v2AuditDir, file.name), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          await this.appendAudit({ action: 'legacy-v2-import', legacyEvent: e });
          imported += 1;
        } catch {}
      }
    }
    await this.transaction(state => {
      state.migrations.push({ id: 'v2-audit-import', timestamp: new Date().toISOString(), imported });
    });
    return { imported, skipped: false };
  }
}

module.exports = EmbeddedStore;
