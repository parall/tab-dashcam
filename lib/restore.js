import { isRestorable, sleep } from './util.js';

const GROUP_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);

async function waitForTabs(windowId, expected) {
  let last = [];
  for (let i = 0; i < 16; i++) {
    const tabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
    if (tabs.length >= expected) return tabs;
    if (tabs.length === last.length && i >= 5) return tabs;
    last = tabs;
    await sleep(120);
  }
  return last;
}

/**
 * 把一个窗口快照还原成真实窗口：顺序、固定状态、标签组都会保留。
 */
export async function restoreWindow(win, { focused = true } = {}) {
  const specs = (win && win.tabs ? win.tabs : []).filter((t) => isRestorable(t.u));
  if (!specs.length) throw new Error('这个窗口里没有可以打开的网页');

  const urls = specs.map((s) => s.u);
  let created;

  try {
    created = await chrome.windows.create({ url: urls, focused });
  } catch (e) {
    created = await chrome.windows.create({ focused });
    for (const u of urls) {
      try {
        await chrome.tabs.create({ windowId: created.id, url: u, active: false });
      } catch (err) {
        /* 单个网址打不开就跳过 */
      }
    }
  }

  const newTabs = await waitForTabs(created.id, specs.length);
  const n = Math.min(specs.length, newTabs.length);

  for (let i = 0; i < n; i++) {
    if (specs[i].p) {
      try {
        await chrome.tabs.update(newTabs[i].id, { pinned: true });
      } catch (e) {
        /* 固定失败不影响主体 */
      }
    }
  }

  const meta = win.groups || {};
  for (const key of Object.keys(meta)) {
    const ids = [];
    for (let i = 0; i < n; i++) {
      if (String(specs[i].g) === String(key) && !specs[i].p) ids.push(newTabs[i].id);
    }
    if (!ids.length) continue;
    try {
      const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: created.id } });
      const g = meta[key] || {};
      await chrome.tabGroups.update(gid, {
        title: g.title || '',
        color: GROUP_COLORS.has(g.color) ? g.color : 'grey',
      });
    } catch (e) {
      /* 分组失败不影响主体 */
    }
  }

  return created.id;
}

export async function restoreSnapshot(snap, { focused = true } = {}) {
  const wins = (snap && snap.windows) || [];
  let opened = 0;
  for (const w of wins) {
    try {
      await restoreWindow(w, { focused: focused && opened === 0 });
      opened++;
    } catch (e) {
      /* 继续下一个窗口 */
    }
  }
  return opened;
}

export async function restoreSingleTab(url) {
  if (!isRestorable(url)) throw new Error('这个页面无法重新打开');
  return chrome.tabs.create({ url, active: true });
}

export function countRestorable(win) {
  return ((win && win.tabs) || []).filter((t) => isRestorable(t.u)).length;
}

/* ---------- 恢复前的重复窗口检查 ----------
 * 用户常对着「当前这一刻」的记录点整窗恢复，结果浏览器里又长出一个一模一样的窗口。
 * 恢复前先比一次，有相同的就要求二次确认。
 */

function joinKey(list) {
  return list.map((t) => (t.p ? '1' : '0') + t.u).join('\u0001');
}

function specsOf(win) {
  return ((win && win.tabs) || []).filter((t) => isRestorable(t.u));
}

function tabsOfWindow(tabs) {
  return (tabs || [])
    .filter((t) => isRestorable(t.url || t.pendingUrl || ''))
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((t) => ({ u: t.url || t.pendingUrl || '', p: t.pinned ? 1 : 0 }));
}

/** 当前是否已经开着和这条记录里某个窗口高度重合的窗口 */
export async function findOpenDuplicate(win) {
  const specs = specsOf(win);
  if (!specs.length) return null;
  const key = joinKey(specs);
  const total = specs.length;
  // 整窗完全相同算重复；此外只要有六成以上标签重合，也当成「这一个已经开着了」，
  // 因为用户常常是在那个窗口里又开了几个新标签，再去点恢复。
  const need = Math.max(3, Math.ceil(total * 0.6));

  let wins = [];
  try {
    wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  } catch (e) {
    return null;
  }

  let best = null;
  for (const w of wins) {
    const tabs = tabsOfWindow(w.tabs);
    if (!tabs.length) continue;
    if (joinKey(tabs) === key) {
      return { tabCount: tabs.length, same: total, total, exact: true };
    }
    const same = overlapCount(specs.map((t) => t.u), tabs.map((t) => t.u));
    if (same >= need && (!best || same > best.same)) {
      best = { tabCount: tabs.length, same, total, exact: false };
    }
  }
  return best;
}

/** 多重集交集大小：同一个网址在两边各出现两次就算两次 */
function overlapCount(a, b) {
  const counts = new Map();
  for (const u of b) counts.set(u, (counts.get(u) || 0) + 1);
  let n = 0;
  for (const u of a) {
    const c = counts.get(u) || 0;
    if (c > 0) {
      n++;
      counts.set(u, c - 1);
    }
  }
  return n;
}

/** 这条记录里有多少个窗口，现在浏览器里已经开着 */
export async function countOpenDuplicates(wins) {
  let n = 0;
  for (const w of wins || []) {
    if (await findOpenDuplicate(w)) n++;
  }
  return n;
}
