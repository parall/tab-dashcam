import { hashCode, domainOf, isRestorable } from './util.js';

function compactTab(t, i) {
  return {
    u: t.url || t.pendingUrl || '',
    t: t.title || '',
    f: t.favIconUrl || '',
    p: t.pinned ? 1 : 0,
    g: typeof t.groupId === 'number' ? t.groupId : -1,
    i: typeof t.index === 'number' ? t.index : i,
    a: t.active ? 1 : 0,
  };
}

export function buildSnapshot({ windows = [], tabs = [], groups = [], reason = 'auto', closedEvent = false }) {
  const byWin = new Map();
  for (const t of tabs) {
    if (!byWin.has(t.windowId)) byWin.set(t.windowId, []);
    byWin.get(t.windowId).push(t);
  }
  const gmap = new Map((groups || []).map((g) => [g.id, g]));

  const wins = [];
  const firstSeen = new Map();
  for (const w of windows) {
    const list = (byWin.get(w.id) || [])
      .slice()
      .sort((a, b) => a.index - b.index)
      .map(compactTab);

    const restorable = list.filter((t) => isRestorable(t.u));
    if (!restorable.length) continue;

    const gm = {};
    for (const t of restorable) {
      if (t.g > -1 && !gm[t.g]) {
        const g = gmap.get(t.g);
        gm[t.g] = { title: (g && g.title) || '', color: (g && g.color) || 'grey' };
      }
    }

    const entry = {
      bounds: { l: w.left, t: w.top, w: w.width, h: w.height },
      tabs: restorable,
      groups: gm,
    };

    // 同一个快照里出现两个内容完全相同的窗口，通常不是用户真的开了两份，
    // 而是「整窗恢复」刚多开了一个副本，被打点记录了下来。标出来，别让人以为窗口数算错了。
    const key = restorable.map((t) => (t.p ? '1' : '0') + t.u).join('\u0001');
    if (firstSeen.has(key)) entry.dupOf = firstSeen.get(key);
    else firstSeen.set(key, wins.length + 1);

    wins.push(entry);
  }

  return finalize({ wins, reason, closedEvent });
}

export function snapshotFromClosedWindow(entry, sessionId) {
  const w = entry && entry.window;
  if (!w || !Array.isArray(w.tabs)) return null;

  const tabs = w.tabs
    .map((t, i) => compactTab(t, i))
    .filter((t) => isRestorable(t.u));

  if (!tabs.length) return null;

  return finalize({
    wins: [{ bounds: {}, tabs, groups: {} }],
    reason: 'closed',
    closedEvent: true,
    sessionId: sessionId || '',
  });
}

function finalize({ wins, reason, closedEvent, sessionId }) {
  const restorableCount = wins.reduce((n, w) => n + w.tabs.length, 0);
  if (!restorableCount) return null;

  const domains = [];
  for (const w of wins) {
    for (const t of w.tabs) {
      const d = domainOf(t.u);
      if (d && !domains.includes(d)) domains.push(d);
      if (domains.length >= 5) break;
    }
    if (domains.length >= 5) break;
  }

  const fingerprint = wins
    .map((w) => w.tabs.map((t) => (t.p ? '1' : '0') + t.u).join('\u0001'))
    .join('\u0002');

  const ts = Date.now();

  return {
    id: `s_${ts.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    ts,
    reason,
    closedEvent: !!closedEvent,
    sessionId: sessionId || '',
    hash: hashCode(fingerprint),
    tabCount: restorableCount,
    windowCount: wins.length,
    domains,
    windows: wins,
  };
}

export async function collectSnapshot(reason = 'auto') {
  // 关键：窗口和窗口里的标签必须一次读取拿到。
  // 分成 windows.getAll() + tabs.query() 两次调用，中间只要有窗口开关或标签移动，
  // 两次结果就对不上（出现过「一个窗口被记成两个」的情况）。
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const tabs = [];
  for (const w of windows) {
    for (const t of w.tabs || []) tabs.push({ ...t, windowId: w.id });
  }
  let groups = [];
  try {
    groups = await chrome.tabGroups.query({});
  } catch (e) {
    groups = [];
  }
  return buildSnapshot({ windows, tabs, groups, reason });
}

export async function currentStateSummary() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  let tabs = 0;
  for (const w of windows) {
    for (const t of w.tabs || []) {
      if (isRestorable(t.url || t.pendingUrl)) tabs++;
    }
  }
  return { tabs, windows: windows.length };
}
