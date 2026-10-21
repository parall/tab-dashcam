import { isRestorable } from './util.js';

function cut(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function tabLine(t, i) {
  const url = t.url || t.pendingUrl || '';
  const pin = t.pinned ? '[固定] ' : '';
  return `  ${String(i + 1).padStart(2, ' ')}. ${pin}${cut(t.title || '(无标题)', 52)}  |  ${cut(url, 100)}`;
}

/**
 * 把浏览器实际报告的窗口结构导成纯文本，用来对账：
 * 「侧边栏说 N 个窗口，可我屏幕上只有 1 个」到底是谁数错了。
 * 只读窗口元信息和标签地址，不碰网页内容。
 */
export async function buildWindowReport() {
  const out = [];
  const all = await chrome.windows.getAll({ populate: true });
  const normal = all.filter((w) => w.type === 'normal');
  const tabsAll = await chrome.tabs.query({});

  out.push('标签页保险箱 · 窗口诊断');
  out.push('时间：' + new Date().toLocaleString());
  out.push('浏览器：' + navigator.userAgent);
  out.push('');
  out.push(`浏览器报告：普通窗口 ${normal.length} 个（全部窗口 ${all.length} 个），标签 ${tabsAll.length} 个`);
  out.push('');

  normal.forEach((w, i) => {
    const tabs = (w.tabs || []).slice().sort((a, b) => a.index - b.index);
    const restorable = tabs.filter((t) => isRestorable(t.url || t.pendingUrl || ''));
    out.push(`───── 窗口 ${i + 1} ─────`);
    out.push(`id=${w.id}  状态=${w.state}  是否聚焦=${w.focused}  无痕=${w.incognito}`);
    out.push(`位置 left=${w.left} top=${w.top}  大小 ${w.width}×${w.height}`);
    out.push(`标签 ${tabs.length} 个，其中可恢复 ${restorable.length} 个`);
    tabs.forEach((t, j) => out.push(tabLine(t, j)));
    out.push('');
  });

  const others = all.filter((w) => w.type !== 'normal');
  if (others.length) {
    out.push(`另有 ${others.length} 个非常规窗口（扩展、弹窗等）：`);
    others.forEach((w) => out.push(`  id=${w.id} type=${w.type} 状态=${w.state} 标签 ${(w.tabs || []).length} 个`));
    out.push('');
  }

  try {
    out.push(`屏幕 ${screen.width}×${screen.height}，可用区域 ${screen.availWidth}×${screen.availHeight}`);
  } catch (e) {
    /* ignore */
  }

  return out.join('\n');
}
