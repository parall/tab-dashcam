import { listIndex, getSnapshot } from '../lib/db.js';
import {
  restoreWindow,
  restoreSingleTab,
  restoreSnapshot,
  findOpenDuplicate,
  countOpenDuplicates,
} from '../lib/restore.js';
import { currentStateSummary } from '../lib/model.js';
import { exportBackup } from '../lib/backup.js';
import {
  timeAgo,
  clock,
  dayLabel,
  fullTime,
  domainOf,
  letterOf,
  REASON_LABEL,
} from '../lib/util.js';

const state = {
  index: [],
  pending: null,
  startup: null,
  summary: { tabs: 0, windows: 0 },
  openId: null,
  limit: 40,
};

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
  toastTimer = setTimeout(() => t.classList.remove('show'), 2300);
}

function fallbackIcon(url) {
  return el('span', 'fall', letterOf(url));
}

function faviconOf(tab) {
  if (tab.f) {
    const img = document.createElement('img');
    img.className = 'fav';
    img.src = tab.f;
    img.alt = '';
    img.addEventListener('error', () => img.replaceWith(fallbackIcon(tab.u)));
    return img;
  }
  return fallbackIcon(tab.u);
}

/* ---------- 数据 ---------- */

async function refresh() {
  const [index, store] = await Promise.all([
    listIndex(),
    chrome.storage.local.get(['pendingClosedId', 'pendingClosedTs', 'startupCard']),
  ]);
  state.index = index;

  state.pending = store.pendingClosedId
    ? { id: store.pendingClosedId, ts: store.pendingClosedTs || Date.now() }
    : null;
  state.startup = store.startupCard || null;

  try {
    state.summary = await currentStateSummary();
  } catch (e) {
    state.summary = { tabs: 0, windows: 0 };
  }

  render();
}

function indexEntryOf(id) {
  return state.index.find((e) => e.id === id) || null;
}

/* ---------- 渲染 ---------- */

function render() {
  const sub = document.getElementById('sub');
  const now = `现在 ${state.summary.windows} 个窗口 · ${state.summary.tabs} 个标签`;
  sub.textContent = state.index.length
    ? `${now} · 已存 ${state.index.length} 条记录`
    : `${now} · 尚无记录`;

  renderNotices();
  renderTimeline();

  if (state.openId) {
    const card = document.querySelector(`.card[data-id="${state.openId}"]`);
    if (card) expandCard(card, state.openId);
    else state.openId = null;
  }
}

function renderNotices() {
  const box = document.getElementById('notices');
  box.textContent = '';

  if (state.pending) {
    const entry = indexEntryOf(state.pending.id);
    const count = entry ? entry.tabCount : 0;
    const n = el('div', 'notice danger');
    const h = el('h3');
    h.append(document.createTextNode('刚才关闭的窗口已保存'));
    n.append(h);
    n.append(el('p', '', `${count} 个标签 · ${timeAgo(state.pending.ts)} · 内容与顺序都会还原`));

    const acts = el('div', 'acts');
    const restore = el('button', 'btn-danger', '立即整窗恢复');
    restore.addEventListener('click', () => doRestorePending(restore));
    const ignore = el('button', 'btn-ghost', '忽略');
    ignore.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'tv:dismiss-pending' }).catch(() => {});
      state.pending = null;
      render();
    });
    acts.append(restore, ignore);
    n.append(acts);
    box.append(n);
  }

  if (state.startup && state.startup.snapshotId) {
    const s = state.startup;
    const n = el('div', 'notice info');
    const h = el('h3');
    h.append(document.createTextNode(s.suspicious ? '疑似上次未正常关闭' : '上次离开时的会话'));
    n.append(h);
    n.append(
      el(
        'p',
        '',
        s.suspicious
          ? `浏览器没有收到正常退出信号，可能是崩溃或强制退出。上次记录：${s.tabCount} 个标签 · ${fullTime(s.ts)}`
          : `上次记录于 ${fullTime(s.ts)}，共 ${s.tabCount} 个标签、${s.windowCount} 个窗口。`
      )
    );
    const acts = el('div', 'acts');
    const restore = el('button', 'btn-primary', '恢复这个会话');
    restore.addEventListener('click', () => doRestoreStartup(restore, s));
    const dismiss = el('button', 'btn-ghost', '不用了');
    dismiss.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'tv:dismiss-startup' }).catch(() => {});
      state.startup = null;
      render();
    });
    acts.append(restore, dismiss);
    n.append(acts);
    box.append(n);
  }
}

function renderTimeline() {
  const box = document.getElementById('timeline');
  box.textContent = '';

  if (!state.index.length) {
    const empty = el('div', 'empty');
    const strong = el('strong', '', '还没有任何快照');
    empty.append(strong);
    empty.append(
      document.createTextNode(
        '从现在开始，你打开的每个窗口和标签都会被自动记录。什么都不用做，正常用浏览器就行。'
      )
    );
    box.append(empty);
    return;
  }

  let lastDay = '';
  const items = state.index.slice(0, state.limit);
  for (const entry of items) {
    const label = dayLabel(entry.ts);
    if (label !== lastDay) {
      lastDay = label;
      box.append(el('h2', 'day-h', label));
    }
    box.append(cardFor(entry));
  }

  const rest = state.index.length - state.limit;
  if (rest > 0) {
    const more = el('button', 'more', `显示更早的记录（还有 ${rest} 条）`);
    more.addEventListener('click', () => {
      state.limit += 40;
      renderTimeline();
    });
    box.append(more);
  }
}

function cardFor(entry) {
  const card = el('article', 'card');
  card.dataset.id = entry.id;

  const row = el('button', 'row');
  row.title = `${fullTime(entry.ts)} · ${REASON_LABEL[entry.reason] || entry.reason}`;
  row.append(el('span', 'time', clock(entry.ts)));

  const label = el('div', 'label');
  const count = el('div', 'count');
  count.append(document.createTextNode(`${entry.windowCount} 窗口 · ${entry.tabCount} 标签`));
  if (entry.closedEvent) count.append(el('span', 'badge', '已关闭'));
  label.append(count);
  row.append(label);
  row.append(el('span', 'chev', '›'));
  card.append(row);

  if (entry.domains && entry.domains.length) {
    const chips = el('div', 'chips');
    entry.domains.slice(0, 3).forEach((d) => chips.append(el('span', 'chip', d)));
    card.append(chips);
  }

  row.addEventListener('click', () => toggleCard(card, entry));
  return card;
}

function collapseAll(except) {
  document.querySelectorAll('.card.open').forEach((c) => {
    if (c === except) return;
    c.classList.remove('open');
    const d = c.querySelector('.detail');
    if (d) d.remove();
  });
}

async function toggleCard(card, entry) {
  if (card.classList.contains('open')) {
    card.classList.remove('open');
    const d = card.querySelector('.detail');
    if (d) d.remove();
    if (state.openId === entry.id) state.openId = null;
    return;
  }
  collapseAll(card);
  state.openId = entry.id;
  card.classList.add('open');
  await expandCard(card, entry.id);
}

async function expandCard(card, id) {
  if (card.querySelector('.detail')) return;
  const snap = await getSnapshot(id);
  if (!snap) {
    toast('这条记录已不存在');
    return;
  }
  card.append(renderDetail(snap));
}

function renderDetail(snap) {
  const box = el('div', 'detail');

  snap.windows.forEach((win, i) => {
    const wrap = el('div', 'win');
    const head = el('div', 'win-h');
    head.append(
      el(
        'span',
        'win-title',
        snap.windows.length > 1 ? `窗口 ${i + 1} · ${win.tabs.length} 个标签` : `${win.tabs.length} 个标签`
      )
    );
    const btn = el('button', 'btn-primary', '整窗恢复');
    btn.addEventListener('click', () => doRestoreWindow(btn, win));
    if (win.dupOf) head.append(el('span', 'badge muted', `同窗口 ${win.dupOf}`));
    head.append(btn);
    wrap.append(head);

    if (win.dupOf) {
      wrap.append(
        el(
          'p',
          'dup-note',
          `内容和窗口 ${win.dupOf} 完全一样。多数情况是点「整窗恢复」时多开出来的副本，不是记录算错了。`
        )
      );
    }

    const ul = el('ul', 'tabs');
    win.tabs.forEach((t) => ul.append(tabRow(t)));
    wrap.append(ul);
    box.append(wrap);
  });

  const foot = el('div', 'detail-foot');
  if (snap.windows.length > 1) {
    const all = el('button', 'btn-ghost', `恢复全部 ${snap.windows.length} 个窗口`);
    all.addEventListener('click', () => doRestoreAll(all, snap));
    foot.append(all);
  }
  const del = el('button', 'link danger', '删除这条记录');
  del.addEventListener('click', () => doDelete(snap, del));
  foot.append(del);
  box.append(foot);

  return box;
}

function tabRow(tab) {
  const li = el('li');
  li.title = `${tab.t || ''}\n${tab.u}\n\n点击单独打开`;
  li.append(faviconOf(tab));
  li.append(el('span', 'tab-title', tab.t || domainOf(tab.u) || '空白页'));
  li.append(el('span', 'host', domainOf(tab.u)));
  li.addEventListener('click', () => doOpenTab(tab.u));
  return li;
}

/* ---------- 动作 ---------- */

/**
 * 把按钮切换成「二次确认」状态。返回 true 表示这一次算确认，可以继续。
 * 4 秒内不再点就自动还原，避免按钮一直停在危险样式上。
 */
function armButton(btn, hint, label) {
  btn.dataset.armed = '1';
  btn.textContent = hint;
  btn.classList.add('armed');
  clearTimeout(btn._armTimer);
  btn._armTimer = setTimeout(() => {
    if (!btn.isConnected) return;
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    btn.textContent = label;
  }, 4200);
  return true;
}

function disarm(btn) {
  clearTimeout(btn._armTimer);
  delete btn.dataset.armed;
  btn.classList.remove('armed');
}

async function doRestoreWindow(btn, win) {
  if (!btn.dataset.armed) {
    const dup = await findOpenDuplicate(win).catch(() => null);
    if (dup) {
      toast(
        dup.exact
          ? `这个窗口现在还开着（${dup.tabCount} 个标签），再点一次会多开一个副本`
          : `这些标签里有 ${dup.same}/${dup.total} 个已经在另一个窗口开着，再点一次会多开一份`
      );
      armButton(btn, '仍要再开？', '整窗恢复');
      return;
    }
  }
  disarm(btn);
  const original = '整窗恢复';
  btn.disabled = true;
  btn.textContent = '恢复中…';
  try {
    await restoreWindow(win, { focused: true });
    btn.textContent = '已恢复';
    toast('窗口已恢复');
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = original;
    }, 1800);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    toast(e && e.message ? e.message : '恢复失败');
  }
}

async function doRestoreAll(btn, snap) {
  const label = `恢复全部 ${snap.windows.length} 个窗口`;
  if (!btn.dataset.armed) {
    const dup = await countOpenDuplicates(snap.windows).catch(() => 0);
    if (dup) {
      toast(`其中 ${dup} 个窗口现在还开着，再点一次会多开副本`);
      armButton(btn, '仍要恢复？', label);
      return;
    }
  }
  disarm(btn);
  btn.disabled = true;
  btn.textContent = '恢复中…';
  try {
    const n = await restoreSnapshot(snap, { focused: true });
    btn.textContent = `已恢复 ${n} 个窗口`;
    toast(`${n} 个窗口已恢复`);
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = label;
    }, 1800);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = label;
    toast('恢复失败');
  }
}

async function doRestorePending(btn) {
  btn.disabled = true;
  btn.textContent = '恢复中…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'tv:restore-pending' });
    btn.textContent = '已恢复';
    toast(res && res.opened ? `已恢复 ${res.opened} 个窗口` : '已恢复');
    state.pending = null;
    setTimeout(refresh, 400);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '立即整窗恢复';
    toast('恢复失败');
  }
}

async function doRestoreStartup(btn, s) {
  const snap = await getSnapshot(s.snapshotId).catch(() => null);
  if (!snap) {
    toast('这条记录已不存在');
    return;
  }
  if (!btn.dataset.armed) {
    const dup = await countOpenDuplicates(snap.windows).catch(() => 0);
    if (dup) {
      toast(`上一次的窗口现在还开着一部分，再点一次会多开副本`);
      armButton(btn, '仍要恢复？', '恢复这个会话');
      return;
    }
  }
  disarm(btn);
  btn.disabled = true;
  btn.textContent = '恢复中…';
  try {
    const n = await restoreSnapshot(snap, { focused: true });
    await chrome.runtime.sendMessage({ type: 'tv:dismiss-startup' }).catch(() => {});
    state.startup = null;
    toast(`已恢复 ${n} 个窗口`);
    setTimeout(refresh, 300);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '恢复这个会话';
    toast(e && e.message ? e.message : '恢复失败');
  }
}

async function doOpenTab(url) {
  try {
    await restoreSingleTab(url);
  } catch (e) {
    toast(e && e.message ? e.message : '无法打开这个页面');
  }
}

async function doDelete(snap, btn) {
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = '再点一次确认删除';
    setTimeout(() => {
      if (!btn.isConnected) return;
      delete btn.dataset.armed;
      btn.textContent = '删除这条记录';
    }, 3200);
    return;
  }
  delete btn.dataset.armed;
  await chrome.runtime.sendMessage({ type: 'tv:delete-snapshot', id: snap.id }).catch(() => {});
  if (state.openId === snap.id) state.openId = null;
  await refresh();
  toast('已删除');
}

/* ---------- 绑定 ---------- */

function bind() {
  document.getElementById('btnSnap').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'tv:capture-now' }).catch(() => null);
    btn.disabled = false;
    if (res && res.snapshot) {
      toast('已记录当前状态');
      await refresh();
    } else {
      toast('当前状态与上一条记录相同，未重复保存');
    }
  });

  document.getElementById('btnOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('btnExport').addEventListener('click', async () => {
    try {
      const { count } = await exportBackup();
      toast(`已导出 ${count} 条记录`);
    } catch (e) {
      toast('导出失败');
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'tv:refresh') refresh();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}

async function init() {
  bind();
  await refresh();
}

init();
