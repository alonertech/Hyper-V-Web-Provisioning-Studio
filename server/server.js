'use strict';

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const readline = require('readline');
const EmbeddedStore = require('./database');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'default.json'), 'utf8'));
const PORT = Number(process.env.HYPERV_V3_PORT || CONFIG.port || 3000);
const BIND = process.env.HYPERV_V3_BIND || CONFIG.bindAddress || '127.0.0.1';
const TARGET_HOST = process.env.HYPERV_V3_TARGET_HOST || 'localhost';
const AUTH_MODE = process.env.HYPERV_V3_AUTH_MODE === 'Explicit' ? 'Explicit' : 'Integrated';
const USE_SSL = process.env.HYPERV_V3_USE_SSL === '1';
const CREDENTIAL_FILE = process.env.HYPERV_V3_CREDENTIAL_FILE || '';
const POWERSHELL = process.env.POWERSHELL_EXE || 'powershell.exe';
const VMCONNECT = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'vmconnect.exe');
const NODE_ID = crypto.randomBytes(8).toString('hex');
const LAUNCH_TOKEN = process.env.HYPERV_V3_LAUNCH_TOKEN || '';
const ACTIVE_JOB_STATES = new Set(['queued', 'running']);

const DATA_ROOT = path.join(process.env.ProgramData || path.join(process.env.LOCALAPPDATA || ROOT, 'ProgramData'), 'HyperV-Web-V3');
const JOB_ROOT = path.join(DATA_ROOT, 'jobs');
const AUDIT_ROOT = path.join(DATA_ROOT, 'audit');
const DB_ROOT = path.join(DATA_ROOT, 'data');
const store = new EmbeddedStore(DB_ROOT);
const jobs = new Map();
const lifecycleClients = new Map();
let mutationActive = false;
let shutdownTimer = null;
let httpServer = null;
let shuttingDown = false;
let inventoryInFlight = null;
let inventoryCache = null;
let initialized = false;

const ROLES = {
  Viewer: ['inventory.view', 'details.view'],
  Auditor: ['inventory.view', 'details.view', 'audit.view', 'audit.verify'],
  Operator: ['inventory.view', 'details.view', 'vm.provision', 'vm.modify', 'vm.control', 'vm.console', 'iso.eject', 'switch.create', 'switch.modify'],
  Administrator: ['*']
};

function safeId() { return crypto.randomBytes(12).toString('hex'); }
function now() { return new Date().toISOString(); }
function isLocalTarget() { return ['localhost', '127.0.0.1', '.'].includes(TARGET_HOST.toLowerCase()); }
function targetLabel() { return isLocalTarget() ? 'Local Hyper-V' : TARGET_HOST; }
function currentIdentity() {
  const domain = String(process.env.USERDOMAIN || '').trim();
  const username = String(process.env.USERNAME || process.env.USER || '').trim() || 'UnknownUser';
  return domain ? `${domain}\\${username}` : username;
}
function roleForIdentity(identity) {
  const mapped = store.get('users').find(x => String(x.username).toLowerCase() === identity.toLowerCase());
  return mapped?.role || 'Viewer';
}
function hasPermission(permission) {
  const role = roleForIdentity(currentIdentity());
  const permissions = ROLES[role] || [];
  return permissions.includes('*') || permissions.includes(permission);
}
function requirePermission(permission) {
  return (req, res, next) => {
    if (!hasPermission(permission)) return res.status(403).json({ success: false, error: `Permission denied: ${permission}` });
    next();
  };
}

async function ensureDirs() {
  await fsp.mkdir(JOB_ROOT, { recursive: true });
  await fsp.mkdir(AUDIT_ROOT, { recursive: true });
  await fsp.mkdir(DB_ROOT, { recursive: true });
}

function jobPresentation(type, config = {}) {
  const c = config || {};
  let summary = 'Management job';
  const details = [];
  if (type === 'provision-vm') {
    summary = `Create VM · ${c.vmName || 'Unnamed VM'}`;
    if (c.generation) details.push(['Generation', `Gen ${c.generation}`]);
    if (c.cpuCount != null) details.push(['CPU', `${c.cpuCount} vCPU`]);
    if (c.memoryMB != null) details.push(['Startup RAM', `${c.memoryMB} MB`]);
    if (c.diskSizeGB != null) details.push(['Disk', `${c.diskSizeGB} GB ${c.diskType || ''}`.trim()]);
    if (c.storagePath) details.push(['Storage path', c.storagePath]);
    if (c.vSwitch) details.push(['Virtual switch', c.vSwitch]);
    if (c.isoPath) details.push(['Installation ISO', c.isoPath]);
  } else if (type === 'create-switch') {
    summary = `Create Switch · ${c.name || 'Unnamed switch'}`;
    if (c.type) details.push(['Type', c.type]);
    if (c.adapter) details.push(['Physical adapter', c.adapter]);
  } else if (type === 'modify-vm') {
    summary = `Modify VM · ${c.vmName || 'Unnamed VM'}`;
    if (c.diskPath) details.push(['Virtual disk', c.diskPath]);
    if (c.requestedDiskSizeGB != null) details.push(['New disk size', `${c.requestedDiskSizeGB} GB`]);
    if (c.destinationStoragePath) details.push(['New storage path', c.destinationStoragePath]);
    if (c.networkAdapterName) details.push(['Network adapter', c.networkAdapterName]);
    if (c.vSwitch) details.push(['New virtual switch', c.vSwitch]);
  } else if (type === 'modify-switch') {
    summary = `Modify Switch · ${c.name || 'Unnamed switch'}`;
    if (c.type) details.push(['Type', c.type]);
    if (c.adapter) details.push(['Physical adapter', c.adapter]);
    if (c.allowManagementOS != null) details.push(['Allow management OS', c.allowManagementOS ? 'Yes' : 'No']);
    if (c.notes != null) details.push(['Notes', c.notes || '']);
  } else if (type === 'vm-action') {
    summary = `VM Action · ${c.vmName || 'Unnamed VM'} · ${c.operation || 'Action'}`;
    if (c.operation) details.push(['Operation', c.operation]);
  } else if (type === 'eject-iso') {
    summary = `Eject ISO · ${c.vmName || 'Unnamed VM'}`;
  } else if (type) {
    summary = String(type).replace(/-/g, ' ').replace(/\b\w/g, x => x.toUpperCase());
  }
  return { summary, details };
}

function presentationForJobId(jobId) {
  if (!jobId) return { summary: '', details: [] };
  const live = jobs.get(jobId);
  if (live) return { summary: live.summary || jobPresentation(live.type, live.config).summary, details: live.details || [] };
  const row = store.get('jobs').find(x => x.id === jobId);
  if (row) return { summary: row.summary || jobPresentation(row.type, row.config || {}).summary, details: row.details || [] };
  return { summary: '', details: [] };
}

function publicJob(job) {
  return {
    id: job.id, type: job.type, state: job.state, createdAt: job.createdAt,
    startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
    targetHost: TARGET_HOST, message: job.message || '', result: job.result || null,
    summary: job.summary || jobPresentation(job.type, job.config).summary,
    details: job.details || jobPresentation(job.type, job.config).details
  };
}

async function audit(event) {
  const jobPresentation = event.jobId ? presentationForJobId(event.jobId) : null;
  const enriched = {
    nodeId: NODE_ID, targetHost: TARGET_HOST, actor: currentIdentity(),
    ...(event.jobId && jobPresentation?.summary ? { jobLabel: jobPresentation.summary, jobDetails: jobPresentation.details } : {}),
    ...event
  };
  const row = await store.appendAudit(enriched);
  const dateFile = path.join(AUDIT_ROOT, `${now().slice(0, 10)}.jsonl`);
  await fsp.appendFile(dateFile, JSON.stringify(row) + '\n', 'utf8').catch(() => {});
  return row;
}

function emit(job, event) {
  const item = { ...event, jobId: job.id, timestamp: event.timestamp || now() };
  job.events.push(item);
  for (const res of job.clients) {
    try { res.write(`data: ${JSON.stringify(item)}\n\n`); } catch {}
  }
  if (job.events.length > 1000) job.events.shift();
  if (event.type === 'log') job.message = event.message || job.message;
}

async function persistJob(job) {
  const dir = path.join(JOB_ROOT, job.id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'job.json'), JSON.stringify({ ...publicJob(job), events: job.events }, null, 2), 'utf8');
  await store.upsertById('jobs', {
    id: job.id, type: job.type, state: job.state, createdAt: job.createdAt,
    startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
    targetHost: TARGET_HOST, message: job.message || '', result: job.result || null,
    summary: job.summary || jobPresentation(job.type, job.config).summary,
    details: job.details || jobPresentation(job.type, job.config).details,
    eventCount: job.events.length
  });
}

function validateVmName(vmName) {
  const value = String(vmName || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(value)) throw new Error('VM name is invalid.');
  return value;
}

function validateVmConfig(body) {
  const c = body || {};
  const vmName = validateVmName(c.vmName);
  const storagePath = String(c.storagePath || '').trim();
  const vSwitch = String(c.vSwitch || '').trim();
  const isoPath = String(c.isoPath || '').trim();
  const generation = Number(c.generation);
  const cpuCount = Number(c.cpuCount);
  const memoryMB = Number(c.memoryMB);
  const diskSizeGB = Number(c.diskSizeGB);
  const vlanId = Number(c.vlanId || 1);
  if (!storagePath || storagePath.length > 260) throw new Error('Storage path is required and must be 260 characters or fewer.');
  if (!vSwitch || vSwitch.length > 80) throw new Error('Virtual switch is required.');
  if (![1, 2].includes(generation)) throw new Error('Generation must be 1 or 2.');
  if (!Number.isInteger(cpuCount) || cpuCount < 1 || cpuCount > 64) throw new Error('CPU count must be 1-64.');
  if (!Number.isInteger(memoryMB) || memoryMB < 512 || memoryMB > 1048576) throw new Error('Startup memory is outside the allowed range.');
  if (!Number.isInteger(diskSizeGB) || diskSizeGB < 10 || diskSizeGB > 65536) throw new Error('Disk size is outside the allowed range.');
  if (!['Dynamic', 'Fixed'].includes(c.diskType)) throw new Error('Disk type is invalid.');
  if (c.vlanTagging && (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094)) throw new Error('VLAN ID must be 1-4094.');
  if (isoPath && path.extname(isoPath).toLowerCase() !== '.iso') throw new Error('Installation media must be an .iso file.');
  if (generation === 1 && (c.secureBoot || c.enableVTPM)) throw new Error('Secure Boot and vTPM require Generation 2.');
  return {
    vmName, generation, cpuCount, memoryMB, diskSizeGB, diskType: c.diskType,
    vSwitch, vlanTagging: Boolean(c.vlanTagging), vlanId, storagePath, isoPath,
    bootFromIsoFirst: Boolean(isoPath),
    secureBoot: Boolean(c.secureBoot && generation === 2),
    secureBootTemplate: String(c.secureBootTemplate || 'MicrosoftWindows'),
    enableVTPM: Boolean(c.enableVTPM && generation === 2),
    rollbackOnFailure: c.rollbackOnFailure !== false
  };
}

function validateTemplate(body) {
  const name = String(body?.name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(name)) throw new Error('Template name is invalid.');
  const c = body?.config || {};
  const generation = Number(c.generation || 2);
  const cpuCount = Number(c.cpuCount || 2);
  const memoryMB = Number(c.memoryMB || 4096);
  const diskSizeGB = Number(c.diskSizeGB || 60);
  if (![1,2].includes(generation)) throw new Error('Template generation must be 1 or 2.');
  if (!Number.isInteger(cpuCount) || cpuCount < 1 || cpuCount > 64) throw new Error('Template CPU count must be 1-64.');
  if (!Number.isInteger(memoryMB) || memoryMB < 512) throw new Error('Template memory is invalid.');
  if (!Number.isInteger(diskSizeGB) || diskSizeGB < 10) throw new Error('Template disk size is invalid.');
  if (generation === 1 && (c.secureBoot || c.enableVTPM)) throw new Error('Secure Boot and vTPM require Generation 2.');
  return {
    id: safeId(), name, createdAt: now(), updatedAt: now(),
    config: {
      generation, cpuCount, memoryMB, diskSizeGB,
      diskType: ['Dynamic','Fixed'].includes(c.diskType) ? c.diskType : 'Dynamic',
      vSwitch: String(c.vSwitch || ''), vlanTagging: Boolean(c.vlanTagging), vlanId: Number(c.vlanId || 1),
      secureBoot: Boolean(c.secureBoot && generation === 2),
      secureBootTemplate: String(c.secureBootTemplate || 'MicrosoftWindows'),
      enableVTPM: Boolean(c.enableVTPM && generation === 2), rollbackOnFailure: c.rollbackOnFailure !== false
    }
  };
}

function validatePolicy(body) {
  const name = String(body?.name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(name)) throw new Error('Policy name is invalid.');
  const rules = body?.rules || {};
  return {
    id: safeId(), name, enabled: Boolean(body?.enabled), createdAt: now(), updatedAt: now(),
    rules: {
      requireGeneration2: Boolean(rules.requireGeneration2),
      requireSecureBoot: Boolean(rules.requireSecureBoot),
      requireVTPM: Boolean(rules.requireVTPM),
      minCpu: Math.max(0, Number(rules.minCpu || 0)),
      minMemoryMB: Math.max(0, Number(rules.minMemoryMB || 0)),
      approvedSwitches: Array.isArray(rules.approvedSwitches) ? rules.approvedSwitches.map(String).filter(Boolean).slice(0,100) : [],
      allowedStorageRoots: Array.isArray(rules.allowedStorageRoots) ? rules.allowedStorageRoots.map(String).filter(Boolean).slice(0,100) : []
    }
  };
}

function pathStartsWithRoot(target, root) {
  const a = path.win32.normalize(String(target || '')).replace(/[\\/]+$/, '').toLowerCase();
  const b = path.win32.normalize(String(root || '')).replace(/[\\/]+$/, '').toLowerCase();
  return a === b || a.startsWith(b + '\\');
}

function evaluatePolicies(config) {
  const policies = store.get('policies').filter(p => p.enabled);
  const failures = [];
  for (const policy of policies) {
    const r = policy.rules || {};
    if (r.requireGeneration2 && config.generation !== 2) failures.push(`${policy.name}: Generation 2 is required.`);
    if (r.requireSecureBoot && !config.secureBoot) failures.push(`${policy.name}: Secure Boot is required.`);
    if (r.requireVTPM && !config.enableVTPM) failures.push(`${policy.name}: vTPM is required.`);
    if (r.minCpu && config.cpuCount < r.minCpu) failures.push(`${policy.name}: CPU count must be at least ${r.minCpu}.`);
    if (r.minMemoryMB && config.memoryMB < r.minMemoryMB) failures.push(`${policy.name}: Startup RAM must be at least ${r.minMemoryMB} MB.`);
    if (r.approvedSwitches.length && !r.approvedSwitches.includes(config.vSwitch)) failures.push(`${policy.name}: Virtual switch '${config.vSwitch}' is not approved.`);
    if (r.allowedStorageRoots.length && !r.allowedStorageRoots.some(root => pathStartsWithRoot(config.storagePath, root))) failures.push(`${policy.name}: Storage path is outside approved roots.`);
  }
  return { enforced: policies.length > 0, failures, policies };
}

function validateSwitchConfig(body) {
  const c = body || {};
  const name = String(c.name || '').trim();
  const type = String(c.type || '');
  const adapter = String(c.adapter || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(name)) throw new Error('Switch name is invalid.');
  if (!['External', 'Internal', 'Private'].includes(type)) throw new Error('Switch type is invalid.');
  if (type === 'External' && !adapter) throw new Error('An adapter is required for an External switch.');
  return { name, type, adapter };
}

function validateSwitchModifyConfig(body) {
  const c = body || {};
  const name = String(c.name || '').trim();
  const type = String(c.type || '').trim();
  const adapter = String(c.adapter || '').trim();
  const notes = String(c.notes ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(name)) throw new Error('Switch name is invalid.');
  if (!['External', 'Internal', 'Private'].includes(type)) throw new Error('Switch type is invalid.');
  if (type === 'External' && !adapter) throw new Error('An adapter is required for an External switch.');
  if (notes.length > 1000) throw new Error('Switch notes must be 1000 characters or fewer.');
  return { name, type, adapter, allowManagementOS: Boolean(c.allowManagementOS), notes };
}

function validateVmModifyConfig(body) {
  const c = body || {};
  const vmName = validateVmName(c.vmName);
  const diskPath = String(c.diskPath || '').trim();
  const requestedDiskSizeGB = c.requestedDiskSizeGB == null || c.requestedDiskSizeGB === '' ? null : Number(c.requestedDiskSizeGB);
  const destinationStoragePath = String(c.destinationStoragePath || '').trim();
  const networkAdapterName = String(c.networkAdapterName || '').trim();
  const vSwitch = String(c.vSwitch || '').trim();
  const changes = [];
  if (requestedDiskSizeGB != null) {
    if (!Number.isInteger(requestedDiskSizeGB) || requestedDiskSizeGB < 10 || requestedDiskSizeGB > 65536) throw new Error('New disk size must be an integer between 10 GB and 65536 GB.');
    if (!diskPath || diskPath.length > 320) throw new Error('A virtual disk must be selected when changing disk size.');
    changes.push('disk');
  }
  if (destinationStoragePath) {
    if (destinationStoragePath.length > 260) throw new Error('Destination storage path must be 260 characters or fewer.');
    changes.push('storage');
  }
  if (networkAdapterName || vSwitch) {
    if (!networkAdapterName || !vSwitch) throw new Error('Network adapter and virtual switch are both required for a network change.');
    if (networkAdapterName.length > 120 || vSwitch.length > 80) throw new Error('Network adapter or virtual switch value is too long.');
    changes.push('network');
  }
  if (!changes.length) throw new Error('Select at least one VM change.');
  return { vmName, diskPath, requestedDiskSizeGB, destinationStoragePath, networkAdapterName, vSwitch };
}

function validateVmAction(body) {
  const vmName = validateVmName(body?.vmName);
  const operation = String(body?.operation || '');
  if (!['Start', 'Shutdown', 'TurnOff', 'Restart', 'Pause', 'Resume', 'Save'].includes(operation)) throw new Error('Unsupported VM operation.');
  return { vmName, operation };
}

function psArgs(action, configPath, extra = {}) {
  const args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'powershell', 'Invoke-HyperVAction.ps1'), '-Action', action, '-TargetHost', TARGET_HOST, '-AuthMode', AUTH_MODE];
  if (USE_SSL) args.push('-UseSSL');
  if (configPath) args.push('-ConfigPath', configPath);
  if (CREDENTIAL_FILE) args.push('-CredentialFile', CREDENTIAL_FILE);
  if (extra.cancelFile) args.push('-CancelFile', extra.cancelFile);
  return args;
}

function runAction(action, configPath, job, onExit, options = {}) {
  const child = spawn(POWERSHELL, psArgs(action, configPath, options), { cwd: ROOT, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  if (job) job.process = child;
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let finalResult = null;
  let settled = false;
  const diagnostics = { stderr: [], events: [] };
  rl.on('line', line => {
    const text = line.trim();
    if (!text) return;
    try {
      const event = JSON.parse(text);
      diagnostics.events.push(event);
      if (diagnostics.events.length > 50) diagnostics.events.shift();
      if (job) emit(job, event);
      if (event.type === 'result') finalResult = event;
    } catch {
      if (job) emit(job, { type: 'log', level: 'info', message: text });
    }
  });
  child.stderr.on('data', buf => {
    const text = buf.toString().trim();
    if (text) { diagnostics.stderr.push(text); if (diagnostics.stderr.length > 30) diagnostics.stderr.shift(); if (job) emit(job, { type: 'log', level: 'error', message: text }); }
  });
  const finish = (err, code) => {
    if (settled) return;
    settled = true;
    rl.close();
    const lastLog = [...diagnostics.events].reverse().find(e => e && e.type === 'log' && e.message);
    const diagnosticText = diagnostics.stderr.at(-1) || lastLog?.message || '';
    if (err && diagnosticText && !String(err.message || '').includes(diagnosticText)) err.message = `${err.message}. PowerShell: ${diagnosticText}`;
    onExit(err, finalResult, child, code, diagnostics);
  };
  child.on('error', err => finish(err, null));
  child.on('close', code => finish(code === 0 ? null : new Error(finalResult?.message || diagnostics.stderr.at(-1) || [...diagnostics.events].reverse().find(e => e?.type === 'log' && e.message)?.message || `PowerShell exited with code ${code}`), code));
}

function runQueryWithRetry(action, attempts = 3) {
  return new Promise(resolve => {
    let attempt = 0;
    let lastError = null;
    const next = () => {
      attempt += 1;
      runAction(action, null, null, (err, result, child, code, diagnostics) => {
        if (!err) return resolve({ err: null, result, diagnostics });
        lastError = err;
        if (attempt >= attempts) return resolve({ err: lastError, result: null, diagnostics });
        setTimeout(next, 500 * attempt);
      });
    };
    next();
  });
}

function newJob(type, config) {
  const id = safeId();
  const dir = path.join(JOB_ROOT, id);
  const cancelFile = path.join(dir, 'cancel.flag');
  const presentation = jobPresentation(type, config);
  const job = { id, type, config, summary: presentation.summary, details: presentation.details, state: 'queued', createdAt: now(), startedAt: null, finishedAt: null, message: 'Queued', result: null, events: [], clients: new Set(), process: null, cancelFile, cancelRequested: false };
  jobs.set(id, job);
  return job;
}

async function startMutationJob(job, action) {
  mutationActive = true;
  job.state = 'running';
  job.startedAt = now();
  emit(job, { type: 'log', level: 'info', message: `Starting ${job.type} on ${targetLabel()}.` });
  await audit({ action: 'job-start', jobId: job.id, jobType: job.type, vmName: job.config?.vmName || null, operation: job.config?.operation || null });
  const dir = path.join(JOB_ROOT, job.id);
  await fsp.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  if (job.config) await fsp.writeFile(configPath, JSON.stringify(job.config, null, 2), 'utf8');
  await persistJob(job);
  runAction(action, configPath, job, async (err, result) => {
    job.process = null;
    job.finishedAt = now();
    const cancelled = job.state === 'cancelled' || job.cancelRequested;
    if (err) {
      job.state = cancelled ? 'cancelled' : 'failed';
      job.message = cancelled ? 'Job cancelled.' : err.message;
      job.result = result || { success: false, message: job.message };
      emit(job, { type: 'result', success: false, cancelled, message: job.message, data: result?.data || null });
      await audit({ action: 'job-finish', jobId: job.id, jobType: job.type, outcome: job.state, message: job.message });
    } else {
      job.state = 'completed';
      job.message = result?.message || 'Completed';
      if (job.type === 'create-switch') inventoryCache = null;
      job.result = result || { success: true, message: job.message };
      emit(job, { type: 'result', success: true, message: job.message, data: result?.data || null });
      await audit({ action: 'job-finish', jobId: job.id, jobType: job.type, outcome: 'completed', message: job.message });
    }
    mutationActive = false;
    await persistJob(job);
    for (const res of job.clients) { try { res.write(`event: end\ndata: ${JSON.stringify(publicJob(job))}\n\n`); res.end(); } catch {} }
    job.clients.clear();
    maybeScheduleShutdown();
  }, { cancelFile: job.cancelFile });
}

function registerLifecycleClient(clientId, res) {
  clearTimeout(shutdownTimer);
  const id = String(clientId || safeId()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || safeId();
  lifecycleClients.set(id, { res, connectedAt: Date.now() });
  res.write(`event: hello\ndata: ${JSON.stringify({ clientId: id, nodeId: NODE_ID })}\n\n`);
  const timer = setInterval(() => { try { res.write(`event: ping\ndata: ${JSON.stringify({ timestamp: now() })}\n\n`); } catch {} }, 15000);
  const cleanup = () => { clearInterval(timer); const current = lifecycleClients.get(id); if (current && current.res === res) lifecycleClients.delete(id); maybeScheduleShutdown(); };
  res.on('close', cleanup);
  return id;
}

function requestCancel(job, reason) {
  if (!job || job.state !== 'running') return;
  job.cancelRequested = true;
  job.state = 'cancelled';
  emit(job, { type: 'log', level: 'warn', message: reason || 'Cancellation requested.' });
  try { fs.writeFileSync(job.cancelFile, `${now()}\n`, 'utf8'); } catch {}
  setTimeout(() => { if (job.process && !job.process.killed) { try { job.process.kill('SIGTERM'); } catch {} } }, 10000);
}

function maybeScheduleShutdown() {
  if (lifecycleClients.size > 0 || shuttingDown) return;
  clearTimeout(shutdownTimer);
  shutdownTimer = setTimeout(async () => {
    if (lifecycleClients.size > 0 || shuttingDown) return;
    const running = [...jobs.values()].filter(j => j.state === 'running' && j.process);
    if (running.length) {
      for (const job of running) requestCancel(job, 'Browser session closed. Cancellation requested before portal shutdown.');
      setTimeout(() => shutdownGracefully(), 12000);
      return;
    }
    shutdownGracefully();
  }, 8000);
}

function shutdownGracefully() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(shutdownTimer);
  for (const job of jobs.values()) { try { if (job.process && !job.process.killed) job.process.kill('SIGTERM'); } catch {} }
  if (httpServer) { httpServer.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
  else process.exit(0);
}

async function updateHostSnapshot(data) {
  if (!data) return;
  const id = crypto.createHash('sha256').update(TARGET_HOST.toLowerCase(), 'utf8').digest('hex').slice(0, 24);
  const existing = store.get('hosts').find(x => x.id === id) || { id, createdAt: now() };
  const record = {
    ...existing, targetHost: TARGET_HOST, label: targetLabel(), localTarget: isLocalTarget(), lastSeen: now(),
    computerName: data.ComputerName || null, os: data.OS || null, osVersion: data.OSVersion || null,
    vmCount: Array.isArray(data.VMs) ? data.VMs.length : 0, switchCount: Array.isArray(data.Switches) ? data.Switches.length : 0,
    adapterCount: Array.isArray(data.Adapters) ? data.Adapters.length : 0, adapterSource: data.AdapterSource || null
  };
  await store.upsertById('hosts', record);
}

async function importLegacyV2Data() {
  const legacyAudit = path.join(process.env.ProgramData || 'C:\\ProgramData', 'HyperV-Web-V2', 'audit');
  try {
    const result = await store.migrateV2Audit(legacyAudit);
    if (result.imported) await audit({ action: 'v2-audit-import-complete', imported: result.imported });
  } catch {}
}

async function startServer() {
  await ensureDirs();
  await store.init();

  // First-run security bootstrap:
  // Persist the Windows identity that launched the portal as Administrator only
  // when the management store has no user mappings yet. Once any mappings exist,
  // unmapped identities fall back to the least-privileged Viewer role.
  if (store.get('users').length === 0) {
    await store.add('users', {
      id: safeId(),
      username: currentIdentity(),
      role: 'Administrator',
      bootstrap: true,
      createdAt: now(),
      updatedAt: now()
    });
  }

  await importLegacyV2Data();
  initialized = true;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.static(path.join(ROOT, 'public'), { etag: true, maxAge: '1h' }));

  app.get('/api/config', (req, res) => res.json({
    product: 'Hyper-V Web Provisioning Studio', edition: 'Professional', version: '3.1.0',
    targetHost: TARGET_HOST, targetLabel: targetLabel(), localTarget: isLocalTarget(), authMode: AUTH_MODE, useSSL: USE_SSL,
    defaultStoragePath: CONFIG.defaultStoragePath, defaults: CONFIG.defaults, embeddedStore: true,
    user: currentIdentity(), role: roleForIdentity(currentIdentity())
  }));
  app.get('/api/health', (req, res) => res.json({
    ok: true, version: '3.1.0', edition: 'Professional', targetHost: TARGET_HOST, localTarget: isLocalTarget(), nodeId: NODE_ID,
    clients: lifecycleClients.size, activeJobs: [...jobs.values()].filter(j => ACTIVE_JOB_STATES.has(j.state)).length,
    mutationActive, shuttingDown, initialized, time: now(), role: roleForIdentity(currentIdentity())
  }));

  app.get('/api/professional/summary', async (req, res) => {
    const inventory = inventoryCache?.data || null;
    const jobsHistory = store.get('jobs');
    res.json({ success: true, data: {
      product: 'Hyper-V Web Provisioning Studio', edition: 'Professional', version: '3.1.0',
      user: currentIdentity(), role: roleForIdentity(currentIdentity()),
      targetHost: TARGET_HOST, targetLabel: targetLabel(), localTarget: isLocalTarget(), useSSL: USE_SSL,
      vmCount: inventory?.VMs?.length ?? 0,
      runningVmCount: inventory?.VMs?.filter(v => String(v.State).toLowerCase() === 'running').length ?? 0,
      offVmCount: inventory?.VMs?.filter(v => String(v.State).toLowerCase() === 'off').length ?? 0,
      switchCount: inventory?.Switches?.length ?? 0,
      adapterCount: inventory?.Adapters?.length ?? 0,
      templateCount: store.get('templates').length,
      enabledPolicyCount: store.get('policies').filter(p => p.enabled).length,
      jobHistoryCount: jobsHistory.length,
      auditCount: store.get('auditEvents').length,
      auditIntegrity: store.verifyAudit(),
      dataStore: { provider: 'embedded-json', path: path.join(DB_ROOT, 'professional-db.json') }
    }});
  });

  app.get('/api/professional/backup', requirePermission('audit.view'), (req, res) => {
    const snapshot = JSON.stringify(store.state, null, 2);
    res.setHeader('Content-Disposition', 'attachment; filename="HyperV-Web-V3-Professional-Backup.json"');
    res.type('application/json').send(snapshot);
  });

  app.get('/api/rbac/me', (req, res) => res.json({ success: true, data: { username: currentIdentity(), role: roleForIdentity(currentIdentity()), permissions: ROLES[roleForIdentity(currentIdentity())] || [] } }));
  app.get('/api/rbac/roles', (req, res) => res.json({ success: true, data: ROLES }));
  app.get('/api/rbac/users', requirePermission('audit.view'), (req, res) => res.json({ success: true, data: store.get('users') }));
  app.post('/api/rbac/users', requirePermission('*'), async (req, res) => {
    try {
      const username = String(req.body?.username || '').trim();
      const role = String(req.body?.role || '');
      if (!username) throw new Error('Username is required.');
      if (!Object.prototype.hasOwnProperty.call(ROLES, role)) throw new Error('Unknown role.');
      const existing = store.get('users').find(x => x.username.toLowerCase() === username.toLowerCase());
      const row = { id: existing?.id || safeId(), username, role, updatedAt: now() };
      await store.upsertById('users', row);
      await audit({ action: 'rbac-user-upsert', username, role });
      res.json({ success: true, data: row });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });
  app.delete('/api/rbac/users/:id', requirePermission('*'), async (req, res) => {
    const row = store.get('users').find(x => x.id === req.params.id);
    if (!row) return res.status(404).json({ success:false,error:'User mapping not found.' });
    await store.removeById('users', row.id);
    await audit({ action: 'rbac-user-remove', username: row.username });
    res.json({ success: true });
  });

  app.get('/api/templates', requirePermission('inventory.view'), (req, res) => res.json({ success: true, data: store.get('templates') }));
  app.post('/api/templates', requirePermission('vm.provision'), async (req, res) => {
    try {
      const template = validateTemplate(req.body);
      await store.add('templates', template);
      await audit({ action: 'template-create', templateId: template.id, templateName: template.name });
      res.status(201).json({ success: true, data: template });
    } catch (e) { res.status(400).json({ success:false,error:e.message }); }
  });
  app.delete('/api/templates/:id', requirePermission('*'), async (req, res) => {
    const row = store.get('templates').find(x => x.id === req.params.id);
    if (!row) return res.status(404).json({ success:false,error:'Template not found.' });
    await store.removeById('templates', row.id);
    await audit({ action: 'template-delete', templateId: row.id, templateName: row.name });
    res.json({ success:true });
  });

  app.get('/api/policies', requirePermission('inventory.view'), (req, res) => res.json({ success:true,data:store.get('policies') }));
  app.post('/api/policies', requirePermission('*'), async (req, res) => {
    try {
      const policy=validatePolicy(req.body);
      await store.add('policies',policy);
      await audit({ action:'policy-create', policyId:policy.id, policyName:policy.name, enabled:policy.enabled });
      res.status(201).json({success:true,data:policy});
    } catch(e){res.status(400).json({success:false,error:e.message});}
  });
  app.put('/api/policies/:id', requirePermission('*'), async (req,res)=>{
    try{
      const existing=store.get('policies').find(x=>x.id===req.params.id); if(!existing) return res.status(404).json({success:false,error:'Policy not found.'});
      const p=validatePolicy({...req.body,name:req.body?.name || existing.name}); p.id=existing.id; p.createdAt=existing.createdAt; p.updatedAt=now();
      await store.upsertById('policies',p); await audit({action:'policy-update',policyId:p.id,policyName:p.name,enabled:p.enabled}); res.json({success:true,data:p});
    }catch(e){res.status(400).json({success:false,error:e.message});}
  });
  app.delete('/api/policies/:id', requirePermission('*'), async (req,res)=>{
    const row=store.get('policies').find(x=>x.id===req.params.id); if(!row) return res.status(404).json({success:false,error:'Policy not found.'});
    await store.removeById('policies',row.id); await audit({action:'policy-delete',policyId:row.id,policyName:row.name}); res.json({success:true});
  });

  app.get('/api/audit', requirePermission('audit.view'), (req,res)=>{
    const limit=Math.min(Math.max(Number(req.query.limit||100),1),500);
    const q=String(req.query.q||'').trim().toLowerCase();
    let rows=[...store.get('auditEvents')].reverse();
    if(q) rows=rows.filter(r=>JSON.stringify(r).toLowerCase().includes(q));
    const data=rows.slice(0,limit).map(e=>{
      const jp=e.jobId ? presentationForJobId(e.jobId) : {summary:e.jobLabel||'',details:e.jobDetails||[]};
      return {...e, jobLabel:e.jobLabel||jp.summary||'', jobDetails:e.jobDetails||jp.details||[]};
    });
    res.json({success:true,data});
  });
  app.get('/api/audit/verify', requirePermission('audit.verify'), (req,res)=>res.json({success:true,data:store.verifyAudit()}));
  app.get('/api/audit/export', requirePermission('audit.view'), (req,res)=>{res.setHeader('Content-Disposition','attachment; filename="HyperV-Web-V3-Audit.json"');res.type('application/json').send(JSON.stringify(store.get('auditEvents'),null,2));});
  app.get('/api/jobs/history', requirePermission('inventory.view'), (req,res)=>{
    const limit=Math.min(Math.max(Number(req.query.limit||100),1),500);
    const data=[...store.get('jobs')].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,limit).map(j=>({
      ...j,
      summary:j.summary||jobPresentation(j.type,j.config||{}).summary,
      details:j.details||jobPresentation(j.type,j.config||{}).details
    }));
    res.json({success:true,data});
  });

  app.post('/api/launcher/shutdown', (req, res) => {
    if (!LAUNCH_TOKEN || req.get('X-HyperV-Launcher-Token') !== LAUNCH_TOKEN) return res.status(403).json({ success:false,error:'Invalid launcher token.' });
    if (lifecycleClients.size > 0) return res.status(409).json({ success:false,error:'Browser clients are still connected.' });
    const active=[...jobs.values()].filter(j=>ACTIVE_JOB_STATES.has(j.state));
    if(active.length>0)return res.status(409).json({success:false,error:'Active jobs are still running.'});
    res.json({success:true,message:'Portal shutdown requested.'}); setTimeout(()=>shutdownGracefully(),50);
  });
  app.get('/api/lifecycle',(req,res)=>{res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});if(typeof res.flushHeaders==='function')res.flushHeaders();registerLifecycleClient(req.query.clientId,res);});
  app.post('/api/lifecycle/bye',(req,res)=>{const id=String(req.body?.clientId||'');const entry=lifecycleClients.get(id);if(entry){try{entry.res.end();}catch{}lifecycleClients.delete(id);}maybeScheduleShutdown();res.json({success:true});});

  app.get('/api/inventory', requirePermission('inventory.view'), async (req,res)=>{
    if(!inventoryInFlight){
      inventoryInFlight=runQueryWithRetry('Inventory',3).then(async ({err,result,diagnostics})=>{
        if(err)return {success:false,error:`Target inventory failed after 3 attempts: ${err.message}`,diagnostics};
        inventoryCache={data:result?.data||null,timestamp:now(),diagnostics}; await updateHostSnapshot(inventoryCache.data).catch(()=>{}); return {success:true,data:inventoryCache.data,diagnostics};
      }).finally(()=>{inventoryInFlight=null;});
    }
    const payload=await inventoryInFlight;
    if(!payload.success&&inventoryCache)return res.status(502).json({...payload,staleData:inventoryCache.data,staleAt:inventoryCache.timestamp});
    if(!payload.success){await audit({action:'inventory-failed',error:payload.error}).catch(()=>{});return res.status(502).json(payload);}
    res.json(payload);
  });
  app.get('/api/target', requirePermission('inventory.view'), async (req,res)=>{const {err,result}=await runQueryWithRetry('TargetInfo',3);return err?res.status(502).json({success:false,error:err.message}):res.json({success:true,data:result?.data||null});});
  app.get('/api/switches', requirePermission('inventory.view'), async (req,res)=>{const {err,result}=await runQueryWithRetry('Switches',3);return err?res.status(502).json({success:false,error:err.message}):res.json({success:true,data:result?.data||[]});});
  app.get('/api/adapters', requirePermission('inventory.view'), async (req,res)=>{const {err,result}=await runQueryWithRetry('Adapters',3);return err?res.status(502).json({success:false,error:err.message}):res.json({success:true,data:result?.data||[]});});

  async function browse(req,res,mode){
    if(!isLocalTarget())return res.status(400).json({success:false,error:'The native picker runs on this computer. For a remote Hyper-V host, enter a path that exists on the target host.'});
    if(!hasPermission('vm.provision'))return res.status(403).json({success:false,error:'Permission denied: vm.provision'});
    const child=spawn(POWERSHELL,['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'powershell','Open-HyperVPicker.ps1'),'-Mode',mode],{windowsHide:false,stdio:['ignore','pipe','pipe']});
    let out='',errOut=''; child.stdout.on('data',b=>out+=b.toString());child.stderr.on('data',b=>errOut+=b.toString());child.on('close',code=>res.json({success:code===0,path:out.trim(),error:code===0?'':errOut.trim()||'Picker failed.'}));child.on('error',e=>res.status(500).json({success:false,error:e.message}));
  }
  app.get('/api/browse/iso',(req,res)=>browse(req,res,'Iso'));
  app.get('/api/browse/folder',(req,res)=>browse(req,res,'Folder'));

  app.post('/api/jobs', async (req,res)=>{
    try{
      if(mutationActive)return res.status(409).json({success:false,error:'Another provisioning operation is currently running. Cancel or wait for it to complete.'});
      const type=String(req.body?.type||'');let config;let action;
      if(type==='provision-vm'){config=validateVmConfig(req.body.config);action='ProvisionVM';const policyResult=evaluatePolicies(config);if(policyResult.failures.length){await audit({action:'policy-block',jobType:type,failures:policyResult.failures});return res.status(422).json({success:false,error:'Provisioning blocked by policy.',policyFailures:policyResult.failures});}}
      else if(type==='create-switch'){if(!hasPermission('switch.create'))return res.status(403).json({success:false,error:'Permission denied: switch.create'});config=validateSwitchConfig(req.body.config);action='CreateSwitch';}
      else if(type==='modify-vm'){if(!hasPermission('vm.modify'))return res.status(403).json({success:false,error:'Permission denied: vm.modify'});config=validateVmModifyConfig(req.body.config);action='ModifyVM';}
      else if(type==='modify-switch'){if(!hasPermission('switch.modify'))return res.status(403).json({success:false,error:'Permission denied: switch.modify'});config=validateSwitchModifyConfig(req.body.config);action='ModifySwitch';}
      else if(type==='vm-action'){if(!hasPermission('vm.control'))return res.status(403).json({success:false,error:'Permission denied: vm.control'});config=validateVmAction(req.body.config);action='VMAction';}
      else throw new Error('Unsupported job type.');
      const job=newJob(type,config);await startMutationJob(job,action);res.status(202).json({success:true,job:publicJob(job)});
    }catch(e){res.status(400).json({success:false,error:e.message});}
  });

  app.post('/api/preflight', requirePermission('vm.provision'), async (req,res)=>{
    try{
      const config=validateVmConfig(req.body.config);const policyResult=evaluatePolicies(config);if(policyResult.failures.length)return res.status(422).json({success:false,error:'Pre-flight blocked by policy.',policyFailures:policyResult.failures});
      const dir=path.join(JOB_ROOT,'preflight-'+safeId());await fsp.mkdir(dir,{recursive:true});const configPath=path.join(dir,'config.json');await fsp.writeFile(configPath,JSON.stringify(config,null,2),'utf8');
      const {err,result}=await new Promise(resolve=>runAction('ValidateProvision',configPath,null,(e,r)=>resolve({err:e,result:r})));await fsp.rm(dir,{recursive:true,force:true}).catch(()=>{});
      if(err)return res.status(400).json({success:false,error:err.message});res.json({success:true,data:result?.data||null,policies:policyResult.policies.map(p=>p.name)});
    }catch(e){res.status(400).json({success:false,error:e.message});}
  });

  app.post('/api/jobs/:id/cancel', requirePermission('vm.control'), async (req,res)=>{const job=jobs.get(req.params.id);if(!job)return res.status(404).json({success:false,error:'Job not found.'});if(!job.process||job.state!=='running')return res.json({success:true,message:'Job is not currently running.'});requestCancel(job,'Cancellation requested by the user.');await audit({action:'job-cancel',jobId:job.id,jobType:job.type});res.json({success:true,message:'Cancellation requested. The worker will stop at a safe checkpoint and rollback if necessary.'});});
  app.get('/api/jobs/:id',(req,res)=>{const job=jobs.get(req.params.id);if(job)return res.json({success:true,job:publicJob(job)});const row=store.get('jobs').find(x=>x.id===req.params.id);if(!row)return res.status(404).json({success:false,error:'Job not found.'});res.json({success:true,job:{...row,summary:row.summary||jobPresentation(row.type,row.config||{}).summary,details:row.details||jobPresentation(row.type,row.config||{}).details}});});
  app.get('/api/jobs/:id/events',(req,res)=>{const job=jobs.get(req.params.id);if(!job)return res.status(404).end();res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});if(typeof res.flushHeaders==='function')res.flushHeaders();for(const event of job.events)res.write(`data: ${JSON.stringify(event)}\n\n`);if(['completed','failed','cancelled'].includes(job.state))res.write(`event: end\ndata: ${JSON.stringify(publicJob(job))}\n\n`);else job.clients.add(res);req.on('close',()=>job.clients.delete(res));});

  app.post('/api/vms/:name/console', requirePermission('vm.console'), async (req,res)=>{
    try{
      const vmName=validateVmName(req.params.name);if(!fs.existsSync(VMCONNECT))throw new Error(`VMConnect.exe was not found at ${VMCONNECT}. Install the Hyper-V management tools on this workstation.`);
      const helper=path.join(ROOT,'powershell','Open-HyperVConsole.ps1');const args=['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',helper,'-TargetHost',TARGET_HOST,'-AuthMode',AUTH_MODE,'-VMName',vmName,'-VMConnectPath',VMCONNECT];if(USE_SSL)args.push('-UseSSL');if(CREDENTIAL_FILE)args.push('-CredentialFile',CREDENTIAL_FILE);
      const result=await new Promise(resolve=>{const child=spawn(POWERSHELL,args,{cwd:ROOT,windowsHide:false,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b.toString());child.stderr.on('data',b=>err+=b.toString());child.on('error',e=>resolve({ok:false,error:e.message}));child.on('close',code=>{let parsed=null;try{const lines=out.trim().split(/\r?\n/).filter(Boolean);parsed=JSON.parse(lines[lines.length-1]||'');}catch{}resolve(parsed||{ok:code===0,message:out.trim(),error:code===0?'':(err.trim()||out.trim()||`Console launcher exited with code ${code}`)});});});
      if(!result.ok)throw new Error(result.error||'Unable to open VM console.');await audit({action:'vm-console',vmName,consoleTarget:result.consoleTarget||TARGET_HOST,launchMode:result.launchMode||'current-user'});res.json({success:true,message:result.message||`Opened the native VMConnect console for '${vmName}' on '${result.consoleTarget||TARGET_HOST}'.`,data:result});
    }catch(e){res.status(400).json({success:false,error:e.message});}
  });
  app.post('/api/vms/:name/eject-iso', requirePermission('iso.eject'), async (req,res)=>{try{const vmName=validateVmName(req.params.name);if(mutationActive)return res.status(409).json({success:false,error:'Another provisioning operation is currently running.'});const job=newJob('eject-iso',{vmName});await startMutationJob(job,'EjectISO');res.status(202).json({success:true,job:publicJob(job)});}catch(e){res.status(400).json({success:false,error:e.message});}});

  app.get('*',(req,res)=>res.sendFile(path.join(ROOT,'public','index.html')));
  httpServer=app.listen(PORT,BIND,()=>console.log(`Hyper-V Web Provisioning Studio v3.1.0 Professional listening on http://${BIND}:${PORT}`));
  httpServer.on('error',err=>{console.error(err);process.exit(1);});
}

process.on('SIGINT',shutdownGracefully);
process.on('SIGTERM',shutdownGracefully);
startServer().catch(err=>{console.error(err);process.exit(1);});
