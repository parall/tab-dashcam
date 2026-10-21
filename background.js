import { collectSnapshot, snapshotFromClosedWindow } from './lib/model.js';
import { putSnapshot, getSnapshot, getIndexEntry, setMeta, getMeta, pruneSnapshots, deleteSnapshot } from './lib/db.js';
import { restoreSnapshot } from './lib/restore.js';
import { getSettings, sleep } from './lib/util.js';

const TICK = 'tv-tick';
const NOTIF_PREFIX = 'tv-closed-';

let capturing = false;
let debounceTimer = null;

async function capture(reason = 'auto', { force = false } = {}) {
  if (capturing) return null;
  capturing = true;
  try {
    const settings = await getSettings();
    if (!force && reason === 'auto' && !settings.autoSnapshot) return null;

    const snap = await collectSnapshot(reason);
    if (!snap) return null;

    const prev = await getMeta('lastHash');
    if (!force && prev && prev.value === snap.hash) return null;

    await putSnapshot(snap);
    await setMeta('lastHash', snap.hash);
    await setMeta('lastSnapshotId', snap.id);
    await setMeta('lastSnapshotTs', snap.ts);

    await pruneSnapshots({ max: settings.maxSnapshots, days: settings.retentionDays });
    pingPanels();
    return snap;
  } catch (e) {
    console.warn('[标签页保险箱] 记录失败', e);
    return null;
  } finally {
    capturing = false;
  }
}

function scheduleCapture(delay = 900) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    capture('event');
  }, delay);
}

function pingPanels() {
  chrome.runtime.sendMessage({ type: 'tv:refresh' }).catch(() => {});
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(TICK);
  if (!existing) {
    chrome.alarms.create(TICK, { periodInMinutes: 1, delayInMinutes: 1 });
  }
}

async function refreshBadge() {
  const { pendingClosedId } = await chrome.storage.local.get('pendingClosedId');
  try {
    if (pendingClosedId) {
      await chrome.action.setBadgeBackgroundColor({ color: '#B42318' });
      await chrome.action.setBadgeText({ text: '!' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {
    /* ignore */
  }
}

/**
 * 窗口被关闭时，从浏览器的"刚刚关闭"里把那一整窗标签抢救出来，单独存成一条记录。
 */
async function handleClosedWindow() {
  const settings = await getSettings();
  const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []);
  if (!sessions || !sessions.length) return;

  const { handledSessions = [] } = await chrome.storage.local.get('handledSessions');
  const handled = new Set(handledSessions.map(String));

  let pick = null;
  let sessionId = '';
  for (const s of sessions) {
    if (!s || !s.window) continue;
    const id = String(
      s.window.sessionId || `${s.lastModified || 0}-${(s.window.tabs || []).length}`
    );
    if (handled.has(id)) continue;
    pick = s;
    sessionId = id;
    break;
  }
  if (!pick) return;

  const snap = snapshotFromClosedWindow(pick, sessionId);
  if (!snap) return;

  await putSnapshot(snap);
  await chrome.storage.local.set({
    handledSessions: [sessionId, ...handledSessions].slice(0, 80),
    pendingClosedId: snap.id,
    pendingClosedTs: snap.ts,
  });
  await refreshBadge();
  await pruneSnapshots({ max: settings.maxSnapshots, days: settings.retentionDays });

  if (settings.notifyOnClose && snap.tabCount >= settings.minTabsForNotify) {
    try {
      await chrome.notifications.create(NOTIF_PREFIX + snap.id, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '已保存刚才关闭的窗口',
        message: `${snap.tabCount} 个标签页 · 点击立即整窗恢复`,
        buttons: [{ title: '立即恢复' }],
        priority: 2,
      });
    } catch (e) {
      /* ignore */
    }
  }
  pingPanels();
}

async function restorePendingClosed() {
  const { pendingClosedId } = await chrome.storage.local.get('pendingClosedId');
  if (!pendingClosedId) return 0;
  const snap = await getSnapshot(pendingClosedId);
  if (!snap) return 0;
  const opened = await restoreSnapshot(snap, { focused: true });
  await dismissPending();
  return opened;
}

async function dismissPending() {
  await chrome.storage.local.remove(['pendingClosedId', 'pendingClosedTs']);
  await refreshBadge();
  pingPanels();
}

async function handleStartup() {
  const settings = await getSettings();
  const data = await chrome.storage.local.get(['cleanQuitAt', 'pendingClosedId']);

  await chrome.storage.local.remove('pendingClosedId');

  if (settings.showRecoveryCard) {
    const lastId = await getMeta('lastSnapshotId');
    const lastTs = await getMeta('lastSnapshotTs');
    if (lastId && lastTs && lastTs.value) {
      const entry = await getIndexEntry(lastId.value).catch(() => null);
      if (entry && entry.tabCount >= 1) {
        const cleanQuitAt = data.cleanQuitAt || 0;
        const clean = cleanQuitAt > 0 && cleanQuitAt >= (lastTs.value || 0);
        await chrome.storage.local.set({
          startupCard: {
            snapshotId: entry.id,
            ts: entry.ts,
            tabCount: entry.tabCount,
            windowCount: entry.windowCount,
            suspicious: !clean,
          },
        });
      }
    }
  }
  await refreshBadge();
}

async function bootstrap() {
  await ensureAlarm();
  await refreshBadge();
}

chrome.runtime.onInstalled.addListener(async () => {
  await bootstrap();
  await capture('startup', { force: true });
});

chrome.runtime.onStartup.addListener(async () => {
  await bootstrap();
  await handleStartup();
  await sleep(1500);
  await capture('startup', { force: true });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== TICK) return;
  await chrome.storage.local.set({ lastHeartbeat: Date.now() });
  await capture('auto');
});

const onTabEvent = () => scheduleCapture();
chrome.tabs.onCreated.addListener(onTabEvent);
chrome.tabs.onRemoved.addListener(onTabEvent);
chrome.tabs.onMoved.addListener(onTabEvent);
chrome.tabs.onAttached.addListener(onTabEvent);
chrome.tabs.onDetached.addListener(onTabEvent);
chrome.tabs.onReplaced.addListener(onTabEvent);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.pinned !== undefined || info.status === 'complete') scheduleCapture();
});
chrome.windows.onCreated.addListener(onTabEvent);

chrome.windows.onRemoved.addListener(async () => {
  scheduleCapture(600);
  await sleep(350);
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (!wins.length) await chrome.storage.local.set({ cleanQuitAt: Date.now() });
  } catch (e) {
    /* ignore */
  }
  await sleep(400);
  await handleClosedWindow();
});

chrome.notifications.onButtonClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith(NOTIF_PREFIX)) return;
  await restorePendingClosed();
  chrome.notifications.clear(notificationId);
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith(NOTIF_PREFIX)) return;
  await restorePendingClosed();
  chrome.notifications.clear(notificationId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'tv:capture-now') {
    capture('manual').then((s) => sendResponse({ ok: !!s, snapshot: s }));
    return true;
  }
  if (msg.type === 'tv:restore-pending') {
    restorePendingClosed().then((n) => sendResponse({ ok: true, opened: n }));
    return true;
  }
  if (msg.type === 'tv:dismiss-pending') {
    dismissPending().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'tv:dismiss-startup') {
    chrome.storage.local.remove('startupCard').then(() => {
      pingPanels();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'tv:delete-snapshot') {
    deleteSnapshot(msg.id).then(() => {
      pingPanels();
      sendResponse({ ok: true });
    });
    return true;
  }
});

bootstrap();
