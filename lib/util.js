export const DEFAULT_SETTINGS = {
  autoSnapshot: true,
  notifyOnClose: true,
  minTabsForNotify: 5,
  showRecoveryCard: true,
  maxSnapshots: 300,
  retentionDays: 90,
};

export const APP_NAME = '标签页保险箱';
export const VERSION = '1.1.0';

export const RESTORABLE = /^(https?|file|ftp):/i;

export function isRestorable(url) {
  return typeof url === 'string' && url.length > 0 && RESTORABLE.test(url);
}

export function domainOf(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host || '';
  } catch (e) {
    return '';
  }
}

export function letterOf(url) {
  const d = domainOf(url);
  return (d.charAt(0) || '?').toUpperCase();
}

export function hashCode(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 45 * 1000) return '刚刚';
  if (d < 3600 * 1000) return Math.max(1, Math.round(d / 60000)) + ' 分钟前';
  if (d < 86400 * 1000) return Math.round(d / 3600000) + ' 小时前';
  const days = Math.round(d / 86400000);
  if (days < 30) return days + ' 天前';
  return Math.round(days / 30) + ' 个月前';
}

export function clock(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function fullTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clock(ts)}`;
}

export function stamp(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function downloadText(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file);
  });
}

export const REASON_LABEL = {
  auto: '自动记录',
  event: '标签变动',
  startup: '启动记录',
  manual: '手动记录',
  closed: '窗口关闭',
  imported: '导入记录',
};
