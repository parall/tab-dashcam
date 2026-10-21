import { listIndex, getSnapshot } from '../lib/db.js';
import { restoreSnapshot } from '../lib/restore.js';
import { timeAgo, clock, fullTime } from '../lib/util.js';

const state = { index: [], pending: null, startup: null };
let toastTimer = null;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

async function openPanel() {
  if (chrome.sidePanel && chrome.sidePanel.open) {
    try {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
      return;
    } catch (e) {
      /* 落到下面的降级方案 */
    }
  }
  // 没有侧边栏 API 的浏览器（Opera、Vivaldi 等）退化成独立小窗，功能一样
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('sidepanel/panel.html'),
      type: 'popup',
      width: 424,
      height: 820,
    });
  } catch (e) {
    /* ignore */
  }
  window.close();
}

function entryOf(id) {
  return state.index.find((e) => e.id === id) || null;
}

function renderAlert() {
  const box = document.getElementById('alert');
  box.textContent = '';
  box.className = 'alert hidden';

  if (state.pending) {
    const entry = entryOf(state.pending.id);
    box.className = 'alert danger';
    const h = el('h3', '', '刚才关闭的窗口已保存');
    const p = el('p', '', `${entry ? entry.tabCount : 0} 个标签 · ${timeAgo(state.pending.ts)}`);
    const btn = el('button', 'act danger', '立即整窗恢复');
    btn.addEventListener('click', () => restoreById(state.pending.id, btn, 'tv:restore-pending'));
    box.append(h, p, btn);
    return;
  }

  if (state.startup && state.startup.snapshotId) {
    const s = state.startup;
    box.className = 'alert info';
    box.append(el('h3', '', s.suspicious ? '疑似上次未正常关闭' : '上次离开时的会话'));
    box.append(el('p', '', `${s.tabCount} 个标签 · ${fullTime(s.ts)}`));
    const btn = el('button', 'act solid', '恢复这个会话');
    btn.addEventListener('click', () => restoreById(s.snapshotId, btn, 'tv:dismiss-startup'));
    box.append(btn);
    return;
  }

  if (state.index.length) {
    const top = state.index[0];
    box.className = 'alert';
    box.append(el('h3', '', '最近一条记录'));
    box.append(el('p', '', `${top.windowCount} 窗口 · ${top.tabCount} 标签 · ${timeAgo(top.ts)}`));
    const btn = el('button', 'act', '恢复这一条');
    btn.addEventListener('click', () => restoreById(top.id, btn, null));
    box.append(btn);
  }
}

async function restoreById(id, btn, dismissType) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '恢复中…';
  try {
    const snap = await getSnapshot(id);
    if (!snap) throw new Error('记录已不存在');
    const n = await restoreSnapshot(snap, { focused: true });
    if (dismissType) await chrome.runtime.sendMessage({ type: dismissType }).catch(() => {});
    btn.textContent = `已恢复 ${n} 个窗口`;
    toast('已恢复');
    setTimeout(render, 600);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    toast(e && e.message ? e.message : '恢复失败');
  }
}

function renderRecent() {
  const box = document.getElementById('recent');
  box.textContent = '';
  if (!state.index.length) {
    box.append(el('div', 'ritem empty', '还没有记录，正常用浏览器就行'));
    return;
  }
  state.index.slice(0, 3).forEach((e) => {
    const row = el('div', 'ritem');
    row.append(el('span', 't', clock(e.ts)));
    row.append(el('span', 'c', `${e.windowCount} 窗口 · ${e.tabCount} 标签`));
    if (e.closedEvent) row.append(el('span', 'b', '已关闭'));
    box.append(row);
  });
}

async function render() {
  const [index, store] = await Promise.all([
    listIndex(),
    chrome.storage.local.get(['pendingClosedId', 'pendingClosedTs', 'startupCard']),
  ]);
  state.index = index;
  state.pending = store.pendingClosedId
    ? { id: store.pendingClosedId, ts: store.pendingClosedTs || Date.now() }
    : null;
  state.startup = store.startupCard || null;

  renderAlert();
  renderRecent();
}

document.getElementById('btnSnap').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'tv:capture-now' }).catch(() => null);
  btn.disabled = false;
  if (res && res.snapshot) {
    toast('已记录当前状态');
    render();
  } else {
    toast('与上一条记录相同，未重复保存');
  }
});

document.getElementById('btnPanel').addEventListener('click', openPanel);
document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;

render();
