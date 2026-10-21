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
