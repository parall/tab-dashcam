import { getAllSnapshots, putSnapshots, listIndex } from './db.js';
import { getSettings, saveSettings, downloadText, stamp } from './util.js';

export async function exportBackup() {
  const [snaps, settings] = await Promise.all([getAllSnapshots(), getSettings()]);
  const payload = {
    app: 'tab-vault',
    kind: 'backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    snapshots: snaps,
  };
  const name = `tab-vault-backup-${stamp()}.json`;
  downloadText(name, JSON.stringify(payload));
  return { name, count: snaps.length };
}

export async function importBackup(text, { withSettings = true } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('文件不是有效的 JSON 格式');
  }
  if (!data || data.kind !== 'backup' || !Array.isArray(data.snapshots)) {
    throw new Error('这不是标签页保险箱的备份文件');
  }

  const valid = data.snapshots.filter(
    (s) => s && typeof s.id === 'string' && typeof s.ts === 'number' && Array.isArray(s.windows)
  );

  const existing = new Set((await listIndex()).map((e) => e.id));
  const fresh = valid.filter((s) => !existing.has(s.id));
  if (fresh.length) await putSnapshots(fresh);
  if (withSettings && data.settings && typeof data.settings === 'object') {
    await saveSettings(data.settings);
  }

  return { imported: fresh.length, skipped: valid.length - fresh.length };
}

export function backupFileName(ts = Date.now()) {
  return `tab-vault-backup-${stamp(ts)}.json`;
}
