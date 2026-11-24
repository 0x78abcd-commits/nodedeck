'use strict';
// 极简 UI 工具：h() 建元素、modal、toast、表单
/* eslint-disable no-unused-vars */
// 让 el.append(a, cond ? b : null) 忽略 null / undefined / false，避免页面上出现 "null"
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  const orig = proto.append;
  proto.append = function (...nodes) { return orig.apply(this, nodes.filter((n) => n !== null && n !== undefined && n !== false)); };
}
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(msg, type = '') {
  const t = h('div', { class: 'toast ' + type }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), type === 'err' ? 8000 : 3500);
}

function modal({ title, body, wide, buttons = [], onClose }) {
  const root = document.getElementById('modalRoot');
  let bg;
  const close = () => { bg.remove(); onClose && onClose(); };
  const footer = buttons.length ? h('footer', {}, buttons.map((b) => h('button', { class: b.class || '', onclick: async (e) => {
    const btn = e.currentTarget;
    if (!b.onClick) return close();
    btn.disabled = true;
    try { const r = await b.onClick(close); if (r !== false && b.close !== false) close(); } catch (err) { toast(err.message, 'err'); } finally { btn.disabled = false; }
  } }, b.label))) : null;
  bg = h('div', { class: 'modal-bg', onmousedown: (e) => { if (e.target === bg) bg.dataset.down = '1'; }, onmouseup: (e) => { if (e.target === bg && bg.dataset.down) close(); bg.dataset.down = ''; } },
    h('div', { class: 'modal' + (wide ? ' wide' : '') },
      h('header', {}, h('b', {}, title), h('button', { class: 'x', onclick: close }, '×')),
      h('div', { class: 'body' }, body),
      footer));
  root.append(bg);
  return { close, el: bg };
}

function confirmBox(text, okLabel = '确定') {
  return new Promise((resolve) => {
    let done = false;
    modal({ title: '确认', body: h('div', { style: { whiteSpace: 'pre-wrap' } }, text), buttons: [
      { label: '取消', onClick: () => { done = true; resolve(false); } },
      { label: okLabel, class: 'primary', onClick: () => { done = true; resolve(true); } },
    ], onClose: () => { if (!done) resolve(false); } });
  });
}

function field(label, input, hint) {
  return h('label', { class: 'f' }, h('span', {}, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
}

function copy(text) { navigator.clipboard.writeText(text).then(() => toast('已复制', 'ok')); }

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(2) : n) + ' ' + u[i];
}

function fmtDate(ms) { if (!ms) return '—'; const d = new Date(ms); return d.toLocaleDateString('zh-CN') + ' ' + d.toTimeString().slice(0, 5); }

async function busy(btn, fn) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> ' + old;
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = old; }
}

// 下拉菜单：items = [{ label, onClick, danger }]，假值会被忽略
function menu(anchor, items) {
  document.querySelectorAll('.menu-pop').forEach((m) => m.remove());
  const r = anchor.getBoundingClientRect();
  const pop = h('div', { class: 'menu-pop', style: { top: r.bottom + 4 + 'px', left: Math.max(8, r.right - 180) + 'px' } },
    items.filter(Boolean).filter((it, i, arr) => !it.sep || (i > 0 && i < arr.length - 1 && !arr[i - 1].sep)).map((it) => it.sep ? h('div', { class: 'menu-sep' }) : h('div', { class: 'menu-item' + (it.danger ? ' danger' : ''), onclick: async () => {
      pop.remove();
      try { await it.onClick(); } catch (e) { toast(e.message, 'err'); }
    } }, it.label)));
  document.body.append(pop);
  setTimeout(() => document.addEventListener('mousedown', function close(e) { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', close); } }), 0);
}
