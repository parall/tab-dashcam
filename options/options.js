import { getSettings, saveSettings, readTextFile } from '../lib/util.js';
import { exportBackup, importBackup } from '../lib/backup.js';
import { listIndex, clearAllSnapshots, estimateSize } from '../lib/db.js';
import { currentStateSummary } from '../lib/model.js';
import { buildWindowReport } from '../lib/diagnose.js';

const $ = (id) => document.getElementById(id);
let toastTimer = null;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function fmtBytes(n) {
  if (!n) return '0 KB';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function clamp(v, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

const NUM_FIELDS = [
  ['minTabsForNotify', 2, 50],
  ['maxSnapshots', 50, 1000],
  ['retentionDays', 7, 365],
];

const BOOL_FIELDS = ['autoSnapshot', 'notifyOnClose', 'showRecoveryCard'];

async function load() {
  const s = await getSettings();
  BOOL_FIELDS.forEach((k) => {
    $(k).checked = !!s[k];
  });
  NUM_FIELDS.forEach(([k]) => {
    $(k).value = s[k];
  });
  $('verText').textContent = '标签页保险箱 v' + chrome.runtime.getManifest().version;
  await refreshStats();
}

async function refreshStats() {
  const [index, size, summary] = await Promise.all([
    listIndex(),
    estimateSize(),
    currentStateSummary().catch(() => ({ tabs: 0, windows: 0 })),
  ]);
  $('statCount').textContent = index.length;
  $('statSize').textContent = fmtBytes(size);
  $('statWin').textContent = summary.windows;
  $('statTab').textContent = summary.tabs;
}

BOOL_FIELDS.forEach((k) => {
  $(k).addEventListener('change', async (e) => {
    await saveSettings({ [k]: e.target.checked });
    toast('已保存');
  });
});

NUM_FIELDS.forEach(([k, min, max]) => {
  $(k).addEventListener('change', async (e) => {
    const v = clamp(e.target.value, min, max);
    e.target.value = v;
    await saveSettings({ [k]: v });
    toast('已保存');
  });
});

$('btnExport').addEventListener('click', async () => {
  try {
    const { count, name } = await exportBackup();
    toast(`已导出 ${count} 条记录 · ${name}`);
  } catch (e) {
    toast('导出失败：' + (e.message || ''));
  }
});

$('btnImport').addEventListener('click', () => $('fileInput').click());

$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await readTextFile(file);
    const res = await importBackup(text);
    toast(`导入完成：新增 ${res.imported} 条，跳过重复 ${res.skipped} 条`);
    await load();
  } catch (err) {
    toast(err.message || '导入失败');
  } finally {
    e.target.value = '';
  }
});

$('btnClear').addEventListener('click', async () => {
  if (!window.confirm('将删除全部快照记录，且无法恢复。确定继续？')) return;
  if (!window.confirm('再确认一次：真的要清空所有记录吗？（建议先导出备份）')) return;
  await clearAllSnapshots();
  await chrome.storage.local.remove(['pendingClosedId', 'pendingClosedTs', 'startupCard', 'handledSessions']);
  toast('已清空全部记录');
  await refreshStats();
});

$('btnDiag').addEventListener('click', async () => {
  const box = $('diagOut');
  try {
    const text = await buildWindowReport();
    box.textContent = text;
    box.hidden = false;
    toast('已生成，可点「复制」发给我');
  } catch (e) {
    toast('生成失败：' + (e.message || ''));
  }
});

$('btnCopyDiag').addEventListener('click', async () => {
  const box = $('diagOut');
  if (!box.textContent) {
    $('btnDiag').click();
    return;
  }
  try {
    await navigator.clipboard.writeText(box.textContent);
    toast('已复制到剪贴板');
  } catch (e) {
    const range = document.createRange();
    range.selectNodeContents(box);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('已选中，按 Cmd+C 复制');
  }
});

load();
