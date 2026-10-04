'use strict';
const APP = document.getElementById('app');
const SHEET_ROOT = document.getElementById('sheet-root');
const TOAST_ROOT = document.getElementById('toast-root');
const TIP = document.getElementById('chart-tip');
const PRINT_ROOT = document.getElementById('print-root');
const SHEET_CTL = new WeakMap();
const NBSP = ' ';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const group3 = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
function money(tiyn) {
  const value = Math.round(Number(tiyn) || 0);
  const neg = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return (neg ? '−' : '') + group3(whole) + (frac ? ',' + String(frac).padStart(2, '0') : '') + NBSP + '₸';
}
const moneyShort = (tiyn) => {
  const t = Math.round((Number(tiyn) || 0) / 100);
  if (Math.abs(t) >= 1e6) return (t / 1e6).toFixed(1).replace('.', ',') + NBSP + 'млн' + NBSP + '₸';
  if (Math.abs(t) >= 1e4) return Math.round(t / 1000) + NBSP + 'тыс' + NBSP + '₸';
  return group3(t) + NBSP + '₸';
};
const MONEY_RE = /^(-?)(\d{1,9})(?:[.,](\d{1,2}))?$/;
function toTiyn(value) {
  const m = String(value ?? '').replace(/[\s ₸]/g, '').match(MONEY_RE);
  if (!m) return null;
  const v = Number(m[2]) * 100 + Number((m[3] || '0').padEnd(2, '0'));
  return m[1] ? -v : v;
}
function tiynText(tiyn) {
  const v = Math.abs(Math.round(Number(tiyn) || 0));
  return (tiyn < 0 ? '-' : '') + Math.floor(v / 100) + (v % 100 ? ',' + String(v % 100).padStart(2, '0') : '');
}
const fmt1 = (n) => String(Math.round((Number(n) || 0) * 10) / 10).replace('.', ',');
const fmt0 = (n) => group3(Math.round(Number(n) || 0));
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
const pl = (n, one, few, many) => `${n}${NBSP}${plural(n, one, few, many)}`;
const clock = { offset: 0, sync(iso) { if (iso) this.offset = new Date(iso).getTime() - Date.now(); }, now() { return Date.now() + this.offset; } };
const timeHM = (iso) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');
function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
function ago(iso) {
  const min = Math.round((clock.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min}${NBSP}мин назад`;
  return timeHM(iso);
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 7.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  bag: '<path d="M5 8h14l-1.2 12.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  qr: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.5"/><path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18zM14 19h1.5M19 14h1.5"/>',
  share: '<path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m5 9 7 7 7-7"/>',
  up: '<path d="m5 15 7-7 7 7"/>',
  flame: '<path d="M12 21c4 0 7-2.7 7-6.6 0-3.6-2.6-5.4-3.6-8.4-.4 2.4-1.6 3.6-2.9 4.2C12.7 6.8 11 4.6 8.6 3c.5 3.7-3.6 6.1-3.6 11.3C5 18.3 8 21 12 21Z"/>',
  leaf: '<path d="M5 19c0-8 5.5-14 15-14 0 9.5-6 15-14 15"/><path d="M5 19c3-4 6-6.5 10-8.5"/>',
  alert: '<path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 17.2v.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
  image: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-8.5 8.5"/>',
  print: '<path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v6.5H7z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16.5 14.5 12 10 7.5M14.5 12H4"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  receipt: '<path d="M5 3h14v18l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21z"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
  utensils: '<path d="M7 3v8M4.5 3v5a2.5 2.5 0 0 0 5 0V3M7 11v10M17 3c-2 1.5-3 4-3 7v3h3v8"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.1M3.5 12h.1M3.5 18h.1"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5"/><path d="M20 3.5v5h-5"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  sparkles: '<path d="M12 3.5 13.6 9 19 10.5l-5.4 1.6L12 17.5l-1.6-5.4L5 10.5 10.4 9z"/><path d="M19 3v3M17.5 4.5h3M5 17v3M3.5 18.5h3"/>',
  table: '<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 16a5 5 0 0 1 6.4 0M12 19.5h.1"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>',
  scale: '<path d="M12 4v16M7 20h10M5 8h14"/><path d="m5 8-2.5 6a3 3 0 0 0 5 0zM19 8l-2.5 6a3 3 0 0 0 5 0z"/>',
  door: '<path d="M14 3H6v18h8"/><path d="M14 3l5 2v16l-5-2z"/><path d="M11 12h.1"/>',
  heart: '<path d="M12 20s-7.5-4.5-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.5 12 20 12 20Z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  volume: '<path d="M4 9.5h4l5-4v13l-5-4H4z"/><path d="M16.5 9a4.5 4.5 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h4l5-4v13l-5-4H4z"/><path d="m17 9.5 5 5M22 9.5l-5 5"/>',
};
const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.2" fill="none" stroke="#FF6B3D" stroke-width="2.3"/><path d="M9.7 7.6v8.8M14.3 7.6v8.8" stroke="#FFD166" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="12" r="1.5" fill="#fff"/></svg>';

const store = {
  get(key, fallback = null) { try { const raw = localStorage.getItem('fb.' + key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; } },
  set(key, value) { try { localStorage.setItem('fb.' + key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ } },
  del(key) { try { localStorage.removeItem('fb.' + key); } catch (e) { /* storage unavailable */ } },
};

class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
const api = {
  async req(method, path, { body, token, staff, idem, timeout = 20000 } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['X-Participant-Token'] = token;
    if (staff) headers.Authorization = 'Bearer ' + staff;
    if (idem) headers['Idempotency-Key'] = idem;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl.signal, cache: 'no-store' });
    } catch (e) {
      throw new ApiError(0, 'network', e.name === 'AbortError' ? 'Сервер долго не отвечает — проверьте интернет и попробуйте ещё раз' : 'Нет связи с сервером. Проверьте мобильный интернет');
    } finally { clearTimeout(timer); }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const err = (data && data.error) || {};
      throw new ApiError(res.status, err.code || 'http_' + res.status, err.message || `Ошибка сервера (${res.status})`, err.details);
    }
    return data;
  },
  get(path, opts) { return this.req('GET', path, opts); },
  post(path, body, opts = {}) { return this.req('POST', path, { ...opts, body: body ?? {} }); },
  patch(path, body, opts = {}) { return this.req('PATCH', path, { ...opts, body }); },
  put(path, body, opts = {}) { return this.req('PUT', path, { ...opts, body }); },
  del(path, opts) { return this.req('DELETE', path, opts); },
};

function toast(message, type = 'info', opts = {}) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const ic = { error: 'alert', success: 'check', warn: 'alert', info: 'info' }[type] || 'info';
  el.innerHTML = `${icon(opts.icon || ic)}<span>${esc(message)}</span>${opts.action ? `<button class="t-act">${esc(opts.action.label)}</button>` : ''}`;
  if (opts.action) el.querySelector('.t-act').addEventListener('click', () => { opts.action.run(); remove(); });
  TOAST_ROOT.appendChild(el);
  while (TOAST_ROOT.children.length > 3) TOAST_ROOT.firstElementChild.remove();
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  const timer = setTimeout(remove, opts.ms || (type === 'error' ? 5200 : 3200));
  function remove() { clearTimeout(timer); el.classList.remove('show'); setTimeout(() => el.remove(), 320); }
}
const showError = (e) => toast(e && e.message ? e.message : 'Что-то пошло не так', 'error');

async function busy(btn, fn) {
  if (btn && btn.classList.contains('loading')) return undefined;
  if (btn) { btn.classList.add('loading'); btn.disabled = true; }
  try { return await fn(); } catch (e) { showError(e); return undefined; } finally { if (btn && btn.isConnected) { btn.classList.remove('loading'); btn.disabled = false; } }
}

function openSheet({ title, body = '', foot = '', size = 'md', actions = {}, onClose, onMount, cls = '' }) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet';
  wrap.innerHTML = `<div class="sheet-backdrop" data-close></div><section class="sheet-panel size-${size} ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sheet-grip"></div><header class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn plain" data-close aria-label="Закрыть">${icon('x')}</button></header><div class="sheet-body">${body}</div><footer class="sheet-foot"${foot ? '' : ' hidden'}>${foot}</footer></section>`;
  SHEET_ROOT.appendChild(wrap);
  document.body.classList.add('no-scroll');
  const previous = document.activeElement;
  const ctl = {
    el: wrap, actions, closed: false,
    get body() { return wrap.querySelector('.sheet-body'); },
    get foot() { return wrap.querySelector('.sheet-foot'); },
    setTitle(t) { wrap.querySelector('.sheet-head h2').textContent = t; },
    setBody(html) { this.body.innerHTML = html; },
    setFoot(html) { const f = this.foot; f.innerHTML = html; f.hidden = !html; },
    close(result) {
      if (this.closed) return;
      this.closed = true;
      wrap.classList.remove('open');
      setTimeout(() => { wrap.remove(); if (!SHEET_ROOT.children.length) document.body.classList.remove('no-scroll'); }, 260);
      if (previous && previous.focus && previous.isConnected) previous.focus({ preventScroll: true });
      if (onClose) onClose(result);
    },
  };
  SHEET_CTL.set(wrap, ctl);
  wrap.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) ctl.close(); });
  requestAnimationFrame(() => {
    wrap.classList.add('open');
    const focusable = wrap.querySelector('[autofocus], .sheet-body input, .sheet-body textarea, .sheet-body button, .sheet-head button');
    if (focusable && window.matchMedia('(pointer:fine)').matches) focusable.focus({ preventScroll: true });
  });
  if (onMount) onMount(ctl);
  return ctl;
}
function topSheet() { const last = SHEET_ROOT.lastElementChild; return last ? SHEET_CTL.get(last) : null; }
function closeAllSheets() { qsa('.sheet', SHEET_ROOT).forEach((el) => { const c = SHEET_CTL.get(el); if (c) c.close(); }); }
function confirmBox({ title, text = '', html = '', ok = 'Подтвердить', cancel = 'Отмена', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const ctl = openSheet({
      title, size: 'sm',
      body: `${text ? `<p class="muted">${esc(text)}</p>` : ''}${html}`,
      foot: `<button class="btn btn-ghost" data-act="no">${esc(cancel)}</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="yes">${esc(ok)}</button>`,
      actions: { yes() { answered = true; ctl.close(); resolve(true); }, no() { answered = true; ctl.close(); resolve(false); } },
      onClose() { if (!answered) resolve(false); },
    });
  });
}
async function copyText(text, okMessage = 'Ссылка скопирована') {
  try { await navigator.clipboard.writeText(text); toast(okMessage, 'success'); }
  catch (e) {
    const area = document.createElement('textarea');
    area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select();
    try { document.execCommand('copy'); toast(okMessage, 'success'); } catch (err) { toast('Не удалось скопировать — выделите ссылку вручную', 'warn'); }
    area.remove();
  }
}
async function shareLink(url, title) {
  if (navigator.share) { try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  copyText(url);
}

function selectBox(name, options, value, { placeholder = 'Выберите', cls = '' } = {}) {
  const current = options.find((o) => String(o.value) === String(value));
  return `<div class="select ${cls}" data-select="${esc(name)}" data-value="${esc(value ?? '')}"><button type="button" class="select-btn" aria-haspopup="listbox" aria-expanded="false">${current ? `${current.icon ? `<span>${esc(current.icon)}</span>` : ''}<span class="ellipsis">${esc(current.label)}</span>` : `<span class="muted">${esc(placeholder)}</span>`}${icon('down')}</button><div class="select-list" role="listbox">${options.map((o) => `<button type="button" role="option" data-option="${esc(o.value)}" class="${String(o.value) === String(value) ? 'on' : ''}" aria-selected="${String(o.value) === String(value)}">${o.icon ? `<span>${esc(o.icon)}</span>` : ''}<span class="ellipsis">${esc(o.label)}</span></button>`).join('')}</div></div>`;
}
function closeSelects(except) { qsa('.select.open').forEach((s) => { if (s !== except) { s.classList.remove('open'); s.querySelector('.select-btn').setAttribute('aria-expanded', 'false'); } }); }

let View = null;
const Global = { actions: {} };
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-link]');
  if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey && link.target !== '_blank') { e.preventDefault(); go(link.getAttribute('href')); return; }
  const selBtn = e.target.closest('.select-btn');
  const option = e.target.closest('[data-option]');
  if (option) {
    const sel = option.closest('.select');
    sel.dataset.value = option.dataset.option;
    qsa('[data-option]', sel).forEach((o) => { o.classList.toggle('on', o === option); o.setAttribute('aria-selected', String(o === option)); });
    sel.querySelector('.select-btn').innerHTML = option.innerHTML + icon('down');
    sel.classList.remove('open');
    sel.dispatchEvent(new CustomEvent('select', { bubbles: true, detail: { name: sel.dataset.select, value: option.dataset.option } }));
    return;
  }
  if (selBtn) {
    const sel = selBtn.closest('.select');
    closeSelects(sel);
    const open = sel.classList.toggle('open');
    selBtn.setAttribute('aria-expanded', String(open));
    if (open) { const on = sel.querySelector('[data-option].on') || sel.querySelector('[data-option]'); if (on) on.focus(); }
    return;
  }
  closeSelects();
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
  const act = el.dataset.act;
  const sheetEl = el.closest('.sheet');
  const sheet = sheetEl ? SHEET_CTL.get(sheetEl) : null;
  const handler = (sheet && sheet.actions[act]) || (View && View.actions && View.actions[act]) || Global.actions[act];
  if (handler) { e.preventDefault(); Promise.resolve(handler(el, e, sheet)).catch(showError); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const open = qs('.select.open');
    if (open) { closeSelects(); open.querySelector('.select-btn').focus(); return; }
    const top = topSheet();
    if (top) top.close();
  }
  const opt = e.target.closest && e.target.closest('[data-option]');
  if (opt && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const list = qsa('[data-option]', opt.parentElement);
    const next = list[(list.indexOf(opt) + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
    next.focus();
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-act]:not(button):not(a):not(input):not(textarea)')) { e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
});
document.addEventListener('select', (e) => {
  const sheetEl = e.target.closest('.sheet');
  const sheet = sheetEl ? SHEET_CTL.get(sheetEl) : null;
  const handler = (sheet && sheet.actions['select:' + e.detail.name]) || (View && View.actions && View.actions['select:' + e.detail.name]);
  if (handler) Promise.resolve(handler(e.detail.value, e.target, sheet)).catch(showError);
});
document.addEventListener('mousemove', (e) => {
  const target = e.target.closest && e.target.closest('[data-tip]');
  if (!target) { TIP.classList.remove('show'); return; }
  TIP.textContent = target.dataset.tip;
  TIP.classList.add('show');
  const w = TIP.offsetWidth;
  TIP.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, e.clientX - w / 2)) + 'px';
  TIP.style.top = Math.max(8, e.clientY - 44) + 'px';
});
window.addEventListener('unhandledrejection', (e) => { e.preventDefault(); showError(e.reason); });

class Live {
  constructor(url, onEvent, onState) { this.url = url; this.onEvent = onEvent; this.onState = onState; this.fails = 0; this.closed = false; this.poll = null; this.es = null; }
  start() { if (!('EventSource' in window)) { this.startPoll(); this.onState('polling'); return this; } this.connect(); return this; }
  connect() {
    if (this.closed) return;
    this.es = new EventSource(this.url);
    this.es.onopen = () => { this.fails = 0; this.onState('online'); this.stopPoll(); };
    this.es.onmessage = (msg) => { let data; try { data = JSON.parse(msg.data); } catch (e) { return; } this.onEvent(data); };
    this.es.onerror = () => {
      this.fails += 1;
      this.onState('reconnecting');
      if (this.fails >= 3) this.startPoll();
      if (this.es.readyState === 2) { this.es.close(); setTimeout(() => this.connect(), Math.min(15000, 800 * 2 ** Math.min(this.fails, 5))); }
    };
  }
  startPoll() { if (this.poll || this.closed) return; this.poll = setInterval(() => this.onEvent({ type: 'poll' }), 5000); }
  stopPoll() { clearInterval(this.poll); this.poll = null; }
  stop() { this.closed = true; this.stopPoll(); if (this.es) this.es.close(); }
}

const routes = [];
let routeToken = 0;
function go(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  route();
}
async function route() {
  routeToken += 1;
  const token = routeToken;
  if (View && View.unmount) { try { View.unmount(); } catch (e) { /* ignore */ } }
  closeAllSheets();
  document.body.className = '';
  document.title = 'Foodbuster — общий стол без хаоса';
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const found = routes.find((r) => r.re.test(path));
  View = found ? found.view : NotFoundView;
  const params = found ? path.match(found.re).slice(1) : [];
  try { await View.mount(...params, token); }
  catch (e) { if (token === routeToken) renderFatal(e); }
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', route);
const isCurrent = (token) => token === routeToken;
function renderFatal(e) {
  APP.innerHTML = `<div class="notfound"><div class="empty-art" style="margin:0 auto 14px;width:72px;height:72px;border-radius:24px;background:var(--pome-soft);display:grid;place-items:center;font-size:34px">⚠️</div><h2>Не удалось загрузить страницу</h2><p class="muted" style="margin:10px 0 20px">${esc(e && e.message ? e.message : 'Ошибка')}</p><button class="btn btn-primary" data-act="reload">${icon('refresh')}Обновить</button></div>`;
}
Global.actions.reload = () => location.reload();

const Data = {
  config: null, menu: null, menuRevision: null, menuPromise: null,
  async getConfig(force = false) { if (!this.config || force) this.config = await api.get('/api/config'); return this.config; },
  async getMenu(force = false) {
    if (this.menu && !force) return this.menu;
    if (this.menuPromise && !force) return this.menuPromise;
    this.menuPromise = api.get('/api/menu').then((m) => {
      this.menu = m; this.menuRevision = m.revision;
      this.menu.byId = new Map(m.items.map((i) => [i.id, i]));
      this.menu.catByCode = new Map(m.categories.map((c) => [c.code, c]));
      this.menuPromise = null;
      return this.menu;
    }).catch((e) => { this.menuPromise = null; throw e; });
    return this.menuPromise;
  },
  allergen(code) { return (this.config && this.config.allergens.find((a) => a.code === code)) || { code, name: code, short: code, icon: '•' }; },
  diet(code) { return (this.config && this.config.diets.find((d) => d.code === code)) || { code, name: code, icon: '' }; },
};
const KNOWN_CATS = new Set(['national', 'salads', 'soups', 'hot', 'grill', 'pasta', 'bowls', 'sides', 'breakfast', 'desserts', 'drinks', 'coffee']);
const catClass = (code) => 'cat-' + (KNOWN_CATS.has(code) ? code : 'other');
const ALL_ORDER = ['gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soy', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs'];
const sortCodes = (list) => [...new Set(list)].sort((a, b) => ALL_ORDER.indexOf(a) - ALL_ORDER.indexOf(b));

function effectiveAllergens(item, choices) {
  const contains = new Set(item.allergens);
  const traces = new Set(item.traces);
  for (const c of choices) {
    (c.add_allergens || []).forEach((a) => contains.add(a));
    (c.remove_allergens || []).forEach((a) => contains.delete(a));
    (c.add_traces || []).forEach((a) => traces.add(a));
  }
  contains.forEach((a) => traces.delete(a));
  return { contains: sortCodes([...contains]), traces: sortCodes([...traces]) };
}
function levelFor(contains, traces, profile) {
  if (!profile || !profile.length) return { level: 'none', danger: [], caution: [] };
  const danger = contains.filter((a) => profile.includes(a));
  const caution = traces.filter((a) => profile.includes(a) && !danger.includes(a));
  return { level: danger.length ? 'danger' : caution.length ? 'caution' : 'safe', danger, caution };
}
function defaultChoices(item) {
  const out = [];
  for (const g of item.options || []) if (g.required && g.choices.length) out.push({ group_id: g.id, group: g.name, ...g.choices[0] });
  return out;
}
const allergenNames = (codes) => codes.map((c) => Data.allergen(c).short).join(', ');

function avatar(p, size = '', opts = {}) {
  const off = opts.offline ? ' off' : '';
  return `<span class="avatar ${size}${off}" style="--c:${esc(p.color || '#0e6b57')}" title="${esc(p.name || '')}">${esc(p.avatar || '🙂')}${opts.dot ? '<i class="on-dot"></i>' : ''}</span>`;
}
function avatarStack(people, max = 5, size = 'sm') {
  const shown = people.slice(0, max);
  return `<span class="avatar-stack">${shown.map((p) => avatar(p, size, { offline: p.online === false })).join('')}${people.length > max ? `<span class="more">+${people.length - max}</span>` : ''}</span>`;
}
function dishArt(item, cls = 'dish-art', extra = '') {
  const code = item.category_code || 'other';
  if (item.image_url) return `<div class="${cls} ${catClass(code)}">${extra}<img src="${esc(item.image_url)}" alt="${esc(item.name)}" loading="lazy" decoding="async"></div>`;
  return `<div class="${cls} ${catClass(code)}">${extra}<span class="ring"></span><span class="emo" aria-hidden="true">${esc(item.emoji || '🍽')}</span></div>`;
}
function macroBar(item) {
  const p = item.protein * 4; const f = item.fat * 9; const c = item.carbs * 4;
  const total = p + f + c || 1;
  return `<div class="macro"><div class="macro-bar" role="img" aria-label="Белки ${fmt1(item.protein)} г, жиры ${fmt1(item.fat)} г, углеводы ${fmt1(item.carbs)} г"><i class="p" style="width:${(p / total) * 100}%"></i><i class="f" style="width:${(f / total) * 100}%"></i><i class="c" style="width:${(c / total) * 100}%"></i></div><div class="macro-legend"><span>Б <b>${fmt1(item.protein)}</b></span><span>Ж <b>${fmt1(item.fat)}</b></span><span>У <b>${fmt1(item.carbs)}</b></span><span class="k"><b>${fmt0(item.kcal)}</b>${NBSP}ккал</span></div></div>`;
}
function allergenChipsHtml(selected, act = 'toggle-allergen') {
  return `<div class="allergen-grid">${Data.config.allergens.map((a) => `<button type="button" class="chip ${selected.includes(a.code) ? 'on-danger' : ''}" data-act="${act}" data-code="${a.code}" aria-pressed="${selected.includes(a.code)}"><span class="ico">${a.icon}</span>${esc(a.name)}</button>`).join('')}</div>`;
}
function dietChipsHtml(selected, act = 'toggle-diet') {
  return `<div class="chip-row">${Data.config.diets.filter((d) => d.code !== 'spicy').map((d) => `<button type="button" class="chip ${selected.includes(d.code) ? 'on-jade' : ''}" data-act="${act}" data-code="${d.code}" aria-pressed="${selected.includes(d.code)}"><span class="ico">${d.icon}</span>${esc(d.name)}</button>`).join('')}</div>`;
}
function toggleIn(list, value) { const i = list.indexOf(value); if (i >= 0) list.splice(i, 1); else list.push(value); return list; }
function brandHtml(sub = '') {
  return `<a class="brand" href="/" data-link aria-label="Foodbuster — на главную"><span class="brand-mark">${LOGO}</span><span><span class="brand-name">Food<em>buster</em></span>${sub ? `<span class="brand-sub">${esc(sub)}</span>` : ''}</span></a>`;
}
function vibrate(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* unsupported */ } }

const HallMap = {
  W: 600, H: 380,
  ZONES: ['#dff1e8', '#e3ecfb', '#fff1d6', '#efe7fa', '#fde8e5', '#e6f0d9'],
  geo(seats, dense = false) {
    const n = Math.max(1, Math.min(seats, dense ? 6 : 14));
    if (n <= 2) { const r = 21; return { kind: 'round', w: r * 2, h: r * 2, chairs: n === 1 ? [[0, -r - 10]] : [[0, -r - 10], [0, r + 10]] }; }
    if (n <= 4) { const s = 22; return { kind: 'square', w: s * 2, h: s * 2, chairs: [[0, -s - 10], [0, s + 10], [-s - 10, 0], [s + 10, 0]].slice(0, n) }; }
    const per = Math.ceil(n / 2); const w = Math.max(64, per * 24 + 10); const h = 40; const chairs = [];
    for (let i = 0; i < per; i++) chairs.push([-w / 2 + (i + 0.5) * (w / per), -h / 2 - 10]);
    for (let i = 0; i < n - per; i++) chairs.push([-w / 2 + (i + 0.5) * (w / (n - per)), h / 2 + 10]);
    return { kind: 'rect', w, h, chairs };
  },
  shape(g, grow = 0, cls = 'hm-top') {
    return g.kind === 'round' ? `<circle class="${cls}" r="${g.w / 2 + grow}"/>` : `<rect class="${cls}" x="${-g.w / 2 - grow}" y="${-g.h / 2 - grow}" width="${g.w + grow * 2}" height="${g.h + grow * 2}" rx="${10 + grow}"/>`;
  },
  scaleFor(count) { return Math.max(0.42, Math.min(1, Math.sqrt(14 / Math.max(count, 1)))); },
  tableHtml(t, { act, selected, edit, scale = 1, dense = false }) {
    const g = this.geo(t.seats, dense);
    const people = t.people || [];
    const guests = t.guests || 0;
    const chairs = g.chairs.map(([cx, cy], i) => `<circle class="hm-chair${i < guests ? ' taken' : ''}" cx="${cx}" cy="${cy}" r="7"${i < guests ? ` style="fill:${esc((people[i] || {}).color || '#0e6b57')}"` : ''}/>`).join('');
    const num = (String(t.label).match(/\d+/) || [String(t.label).slice(0, 2)])[0];
    const faces = !edit && !dense && guests && people.length ? `<text class="hm-people" y="${-g.h / 2 - 25}">${people.slice(0, 3).map((p) => esc(p.avatar)).join('')}</text>` : '';
    const count = guests > 1 ? `<g transform="translate(${g.w / 2 + 2},${-g.h / 2 - 2})"><circle r="9" class="hm-count"/><text class="hm-count-t">${guests}</text></g>` : '';
    const call = t.calls ? `<g class="hm-call" transform="translate(${-g.w / 2 - 2},${-g.h / 2 - 2})"><circle r="10"/><text>!</text></g>` : '';
    const attrs = edit ? `data-key="${t.key}"` : `data-act="${act}" data-key="${t.key}" tabindex="0" role="button" aria-label="${esc(`${t.label}, ${t.text}, ${pl(t.seats, 'место', 'места', 'мест')}`)}"`;
    return `<g class="hm-table ${esc(t.state)}${t.key === selected ? ' sel' : ''}${t.active === false ? ' off' : ''}" transform="translate(${(t.x / 100 * this.W).toFixed(1)},${(t.y / 100 * this.H).toFixed(1)})" ${attrs}><g transform="scale(${scale.toFixed(3)})"><g class="hm-body">${this.shape(g, 8, 'hm-halo')}${chairs}${this.shape(g)}<text class="hm-num">${esc(num)}</text>${faces}${count}${call}</g></g></g>`;
  },
  zonesHtml(tables, scale = this.scaleFor(tables.length), dense = tables.length > 24) {
    const zones = new Map();
    for (const t of tables) {
      if (!t.zone) continue;
      const g = this.geo(t.seats, dense);
      const px = t.x / 100 * this.W; const py = t.y / 100 * this.H;
      const hw = (g.w / 2 + 26) * scale; const hh = (g.h / 2 + 26) * scale;
      const z = zones.get(t.zone) || { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
      z.x0 = Math.min(z.x0, px - hw); z.x1 = Math.max(z.x1, px + hw); z.y0 = Math.min(z.y0, py - hh - 38 * scale); z.y1 = Math.max(z.y1, py + hh);
      zones.set(t.zone, z);
    }
    return [...zones.entries()].map(([name, z], i) => `<g class="hm-zone"><rect x="${z.x0.toFixed(1)}" y="${z.y0.toFixed(1)}" width="${(z.x1 - z.x0).toFixed(1)}" height="${(z.y1 - z.y0).toFixed(1)}" rx="22" fill="${this.ZONES[i % this.ZONES.length]}"/><text class="hm-zone-name" x="${(z.x0 + 14).toFixed(1)}" y="${(z.y0 + 18).toFixed(1)}">${esc(name)}</text></g>`).join('');
  },
  html(tables, { act = 'map-pick', selected = null, edit = false, label = 'Карта зала' } = {}) {
    const { W, H } = this;
    const scale = this.scaleFor(tables.length);
    const dense = tables.length > 24;
    const windows = [90, 230, 370, 510].map((x) => `<rect x="${x}" y="-2" width="60" height="6" rx="3" class="hm-window"/>`).join('');
    const decor = `${windows}<g class="hm-kitchen"><rect x="${W - 112}" y="${H - 38}" width="96" height="26" rx="8"/><text x="${W - 64}" y="${H - 25}">Кухня</text></g><g class="hm-door"><path d="M${W / 2 - 22} ${H} v-3 a22 22 0 0 1 44 0 v3"/><text x="${W / 2}" y="${H - 30}">Вход</text></g>`;
    return `<svg class="hm${edit ? ' editing' : ''}${dense ? ' dense' : ''}" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(label)}"><rect class="hm-floor" x="1" y="1" width="${W - 2}" height="${H - 2}" rx="26"/><g class="hm-decor">${decor}</g><g class="hm-zones">${this.zonesHtml(tables, scale, dense)}</g>${tables.map((t) => this.tableHtml(t, { act, selected, edit, scale, dense })).join('')}</svg>`;
  },
  legend(items) {
    return `<div class="hm-legend">${items.map(([cls, text]) => `<span><i class="hm-dot ${cls}"></i>${esc(text)}</span>`).join('')}</div>`;
  },
};
