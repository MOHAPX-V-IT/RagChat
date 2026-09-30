import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { audit, store } from './store.js';

const backupRoot = resolve(process.env.BACKUP_DIR || '/backups');
const requiredFiles = ['postgresql.sql.gz', 'rag-state.tar.gz', 'knowledge-documents.tar.gz', 'SHA256SUMS'];

const safePath = (name) => {
  if (!/^\d{8}-\d{6}$/.test(name)) throw new Error('Некорректный идентификатор резервной копии.');
  const target = resolve(backupRoot, name);
  if (!target.startsWith(`${backupRoot}${sep}`)) throw new Error('Резервная копия находится вне разрешённого каталога.');
  return target;
};

const sha256 = (path) => new Promise((resolveHash, reject) => {
  const hash = createHash('sha256');
  createReadStream(path).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolveHash(hash.digest('hex')));
});

export async function verifyBackup(name) {
  const directory = safePath(name);
  const metadata = await stat(directory);
  if (!metadata.isDirectory()) throw new Error('Резервная копия не является каталогом.');
  const files = await readdir(directory);
  const missing = requiredFiles.filter((file) => !files.includes(file));
  if (missing.length) return { id: name, status: 'INVALID', checkedAt: new Date().toISOString(), missing, errors: [`Отсутствуют файлы: ${missing.join(', ')}`] };
  const manifest = await readFile(resolve(directory, 'SHA256SUMS'), 'utf8');
  const expected = new Map(manifest.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [hash, file] = line.split(/\s+/, 2);
    return [basename(file || ''), hash];
  }));
  const errors = [];
  const sizes = {};
  for (const file of requiredFiles.filter((item) => item !== 'SHA256SUMS')) {
    const path = resolve(directory, file);
    const info = await stat(path);
    sizes[file] = info.size;
    const actual = await sha256(path);
    if (!expected.get(file) || expected.get(file) !== actual) errors.push(`Контрольная сумма ${file} не совпадает.`);
  }
  return { id: name, status: errors.length ? 'INVALID' : 'VERIFIED', checkedAt: new Date().toISOString(), sizes, errors };
}

export async function listBackups({ verifyLatest = true } = {}) {
  let names = [];
  try { names = (await readdir(backupRoot, { withFileTypes: true })).filter((item) => item.isDirectory() && /^\d{8}-\d{6}$/.test(item.name)).map((item) => item.name).sort().reverse(); }
  catch { return { configured: false, restoreEnabled: false, backups: [], root: backupRoot }; }
  const cached = store.read().settings.backupChecks || {};
  const backups = names.slice(0, 30).map((id) => cached[id] || { id, status: 'UNCHECKED' });
  if (verifyLatest && backups[0]) backups[0] = await verifyBackup(backups[0].id);
  return { configured: true, restoreEnabled: process.env.RESTORE_ENABLED === 'true', backups, root: backupRoot };
}

export async function recordBackupCheck(result, actorId = 'system') {
  return store.mutate((data) => {
    data.settings.backupChecks ||= {};
    data.settings.backupChecks[result.id] = result;
    data.settings.lastBackupCheck = result;
    audit(data, actorId, 'BACKUP_VERIFIED', 'backup', result.id, { status: result.status, errors: result.errors || [] });
    return result;
  });
}

export function startBackupScheduler() {
  const run = async () => {
    const listing = await listBackups({ verifyLatest: false });
    if (!listing.backups[0]) return;
    await recordBackupCheck(await verifyBackup(listing.backups[0].id));
  };
  run().catch(console.error);
  const timer = setInterval(() => run().catch(console.error), Number(process.env.BACKUP_CHECK_INTERVAL_MS || 3_600_000));
  timer.unref();
}

export function startRestore(name, actorId) {
  if (process.env.RESTORE_ENABLED !== 'true') throw new Error('Восстановление отключено в конфигурации сервера.');
  const directory = safePath(name);
  const script = resolve(import.meta.dirname, '..', 'scripts', 'restore-backup.sh');
  const child = spawn('/bin/sh', [script, directory], { detached: true, stdio: 'ignore', env: { ...process.env, RESTORE_ACTOR_ID: actorId } });
  child.unref();
  return { accepted: true, backupId: name, pid: child.pid };
}
