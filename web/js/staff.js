'use strict';
const ROLE_META = {
  kitchen: { title: 'Кухня', icon: '👨‍🍳', desc: 'Тикеты, аллергии, ETA и стоп-лист' },
  waiter: { title: 'Официант', icon: '🧑‍💼', desc: 'Карта зала, вызовы, наличные, закрытие столов' },
  admin: { title: 'Администратор', icon: '🗂️', desc: 'Меню, столы и QR, аналитика, настройки' },
};
function staffAuth() { const s = store.get('staff'); return s && s.exp > Date.now() ? s : null; }
async function sapi(method, path, body) {
  const auth = staffAuth();
  if (!auth) { go('/staff', { replace: true }); throw new ApiError(401, 'staff_auth', 'Войдите заново'); }
  try { return await api.req(method, path, { body, staff: auth.token }); }
  catch (e) {
    if (e.status === 401) { store.del('staff'); toast('Сессия персонала истекла — войдите снова', 'warn'); go('/staff', { replace: true }); }
    throw e;
  }
}
const Sound = {
  ctx: null,
  on: store.get('sound', true),
  beep(kind = 'new') {
    if (!this.on) return;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const notes = kind === 'call' ? [880, 660, 880] : [660, 880];
      notes.forEach((f, i) => {
        const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
        o.frequency.value = f; o.type = 'sine';
        g.gain.setValueAtTime(0.0001, this.ctx.currentTime + i * 0.18);
        g.gain.exponentialRampToValueAtTime(0.25, this.ctx.currentTime + i * 0.18 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + i * 0.18 + 0.16);
        o.connect(g).connect(this.ctx.destination); o.start(this.ctx.currentTime + i * 0.18); o.stop(this.ctx.currentTime + i * 0.18 + 0.18);
      });
    } catch (e) { /* audio unavailable */ }
  },
};

const StaffLoginView = {
  actions: {
    async login(el) {
      const form = qs('#login-form');
      const username = form.username.value.trim();
      const password = form.password.value;
      const err = qs('#login-error');
      if (!username || !password) { err.hidden = false; err.textContent = 'Введите логин и пароль'; (username ? form.password : form.username).focus(); return; }
      await busy(el, async () => {
        try {
          const res = await api.post('/api/staff/login', { username, password });
          store.set('staff', { token: res.token, role: res.role, name: res.display_name, username: res.username, exp: Date.now() + res.expires_in * 1000 - 60000 });
          go('/staff/' + res.role);
        } catch (e) { err.hidden = false; err.textContent = e.message; form.password.select(); }
      });
    },
    'toggle-pass'(el) { const input = qs('#login-form').password; input.type = input.type === 'password' ? 'text' : 'password'; el.setAttribute('aria-pressed', String(input.type === 'text')); },
    'continue'() { go('/staff/' + staffAuth().role); },
    logout() { store.del('staff'); route(); },
  },
  async mount() {
    await Data.getConfig();
    const auth = staffAuth();
    document.title = 'Вход для персонала · Foodbuster';
    APP.innerHTML = `<header class="topbar"><div class="topbar-in">${brandHtml(Data.config.restaurant.name)}<div class="topbar-actions"><a class="btn btn-ghost btn-sm" href="/" data-link>${icon('left')}<span class="hide-sm">На главную</span></a></div></div></header>
    <main class="staff-login" id="main"><div class="login-card"><div class="login-badge">${icon('lock', 'ic-lg')}</div><h1>Вход для персонала</h1><p class="muted">Логин и пароль выдаёт администратор. Права разделены: кухня не видит деньги, официант не меняет меню, администратор видит всё.</p>
    ${auth ? `<div class="notice ok actions">${icon('check')}<span>Вы уже вошли: ${esc(auth.name || ROLE_META[auth.role].title)}</span><button class="btn btn-sm btn-primary" data-act="continue">Продолжить</button><button class="btn btn-sm btn-ghost" data-act="logout">Выйти</button></div>` : ''}
    <form class="stack" id="login-form" novalidate><label class="field"><span class="label">Логин</span><input class="input" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="40" placeholder="например, fb_kitchen_41"></label><label class="field"><span class="label">Пароль</span><div class="input-wrap"><input class="input" name="password" type="password" autocomplete="current-password" maxlength="128" placeholder="••••••••"><button type="button" class="input-suffix-btn" data-act="toggle-pass" aria-label="Показать пароль" aria-pressed="false">${icon('eye')}</button></div></label><div class="form-error" id="login-error" hidden></div><button type="submit" class="btn btn-primary btn-lg btn-block" data-act="login">${icon('lock')}Войти</button></form>
    <div class="login-roles">${Object.entries(ROLE_META).map(([k, m]) => `<div class="login-role"><span>${m.icon}</span><div><b>${m.title}</b><span>${m.desc}</span></div></div>`).join('')}</div></div></main>`;
    const form = qs('#login-form');
    form.addEventListener('submit', (e) => { e.preventDefault(); qs('[data-act="login"]').click(); });
    if (!auth) form.username.focus();
  },
};

const StaffView = {
  role: null, panel: null, live: null,
  get actions() { return { ...StaffCommon, ...(this.panel ? this.panel.actions : {}) }; },
  async mount(view, token) {
    const auth = staffAuth();
    if (!auth) { go('/staff', { replace: true }); return; }
    if (auth.role !== 'admin' && auth.role !== view) { toast(`Раздел «${ROLE_META[view].title}» недоступен для вашей роли`, 'warn'); go('/staff/' + auth.role, { replace: true }); return; }
    await Data.getConfig();
    if (!isCurrent(token)) return;
    this.role = view;
    this.panel = { kitchen: Kitchen, waiter: Waiter, admin: Admin }[view];
    const tabs = auth.role === 'admin' ? ['kitchen', 'waiter', 'admin'] : [auth.role];
    document.title = `${ROLE_META[view].title} · Foodbuster`;
    APP.innerHTML = `<header class="staff-top"><div class="staff-top-in">${brandHtml(ROLE_META[view].title)}<nav class="role-tabs" aria-label="Роли">${tabs.map((t) => `<a href="/staff/${t}" data-link class="${t === view ? 'on' : ''}">${ROLE_META[t].icon} <span class="hide-sm">${ROLE_META[t].title}</span></a>`).join('')}</nav><div class="topbar-actions"><span class="live-dot" id="s-live">В сети</span><button class="icon-btn" data-act="my-password" aria-label="Сменить пароль" title="Сменить пароль">${icon('key')}</button><button class="icon-btn" data-act="sound" aria-label="Звук уведомлений" title="Звук уведомлений">${icon(Sound.on ? 'volume' : 'mute')}</button><button class="icon-btn" data-act="staff-logout" aria-label="Выйти" title="Выйти">${icon('logout')}</button></div></div></header><main class="staff-page" id="main"><div id="staff-body"><div class="skeleton" style="height:60vh"></div></div></main>`;
    this.live = new Live(`/api/staff/events?token=${encodeURIComponent(auth.token)}`, (ev) => { if (View === StaffView && this.panel.onEvent) this.panel.onEvent(ev); }, (s) => {
      const el = qs('#s-live');
      if (el) { el.className = 'live-dot' + (s === 'online' ? '' : ' warn'); el.textContent = s === 'online' ? 'В сети' : 'Переподключение…'; }
      if (s === 'online' && this.panel.reload) this.panel.reload();
    }).start();
    await this.panel.mount();
  },
  unmount() { if (this.live) this.live.stop(); this.live = null; if (this.panel && this.panel.unmount) this.panel.unmount(); },
};
function passwordSheet({ title, own = false, onSave }) {
  openSheet({
    title, size: 'sm',
    body: `<form class="stack" id="pw-form" novalidate>${own ? '<label class="field"><span class="label">Текущий пароль</span><input class="input" name="current" type="password" autocomplete="current-password"></label>' : ''}<label class="field"><span class="label">Новый пароль</span><input class="input" name="next" type="password" autocomplete="new-password" minlength="8"><span class="hint">Не короче 8 символов: и буквы, и цифры. Старые входы с этого аккаунта сразу перестанут работать.</span></label><label class="field"><span class="label">Повторите пароль</span><input class="input" name="again" type="password" autocomplete="new-password"></label><div class="form-error" id="pw-err" hidden></div></form>`,
    foot: `<button class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary" data-act="pw-save">${icon('check')}Сохранить</button>`,
    actions: {
      async 'pw-save'(el, e, sheet) {
        const f = qs('#pw-form', sheet.el);
        const err = qs('#pw-err', sheet.el);
        const show = (text) => { err.hidden = false; err.textContent = text; };
        if (f.next.value.length < 8 || !/\d/.test(f.next.value) || !/\D/.test(f.next.value)) return show('Пароль — от 8 символов, буквы и цифры');
        if (f.next.value !== f.again.value) return show('Пароли не совпадают');
        await busy(el, async () => {
          try { await onSave({ new_password: f.next.value, ...(own ? { current_password: f.current.value } : {}) }); sheet.close(); toast('Пароль изменён', 'success'); if (own) { store.del('staff'); go('/staff'); } }
          catch (e2) { show(e2.message); }
        });
      },
    },
  });
}

const StaffCommon = {
  'staff-logout'() { store.del('staff'); toast('Вы вышли', 'info'); go('/staff'); },
  'my-password'() { passwordSheet({ title: 'Сменить мой пароль', own: true, onSave: (body) => sapi('POST', '/api/staff/me/password', body) }); },
  sound(el) { Sound.on = !Sound.on; store.set('sound', Sound.on); el.innerHTML = icon(Sound.on ? 'volume' : 'mute'); if (Sound.on) Sound.beep(); toast(Sound.on ? 'Звук уведомлений включён' : 'Звук выключен', 'info', { ms: 1500 }); },
};

function stopListSheet() {
  let q = '';
  const listHtml = () => {
    const items = Data.menu.items.filter((i) => !q || i.name.toLowerCase().includes(q.toLowerCase()));
    return items.map((i) => `<div class="list-row"><span class="emo">${esc(i.emoji)}</span><div class="grow"><b class="small">${esc(i.name)}</b><div class="tiny muted">${esc(i.category_name)}</div></div><label class="switch"><input type="checkbox" data-stop="${i.id}" ${i.in_stock ? 'checked' : ''}><span class="track"></span><span class="small">${i.in_stock ? 'В продаже' : 'Стоп'}</span></label></div>`).join('') || '<div class="empty">Ничего не найдено</div>';
  };
  const sheet = openSheet({
    title: 'Стоп-лист', size: 'lg',
    body: `<p class="small muted" style="margin-bottom:10px">Выключите блюдо — оно сразу станет недоступно у всех гостей, а из незаказанных корзин его нельзя будет отправить.</p><div class="search-box" style="margin-bottom:10px">${icon('search')}<input class="input" id="stop-q" type="search" placeholder="Найти блюдо"></div><div class="card" id="stop-list">${listHtml()}</div>`,
  });
  qs('#stop-q', sheet.el).addEventListener('input', (e) => { q = e.target.value; qs('#stop-list', sheet.el).innerHTML = listHtml(); });
  sheet.el.addEventListener('change', async (e) => {
    const box = e.target.closest('[data-stop]');
    if (!box) return;
    try {
      await sapi('PATCH', `/api/admin/menu/${box.dataset.stop}/availability`, { available: box.checked });
      await Data.getMenu(true);
      box.parentElement.querySelector('.small').textContent = box.checked ? 'В продаже' : 'Стоп';
      toast(box.checked ? 'Снова в продаже' : 'Добавлено в стоп-лист', 'success', { ms: 1600 });
    } catch (err) { box.checked = !box.checked; showError(err); }
  });
}

const Kitchen = {
  data: null, tab: 'new', seen: new Set(), first: true, ticker: null,
  actions: {
    'kds-tab'(el) { Kitchen.tab = el.dataset.tab; Kitchen.render(); },
    async accept(el) { await busy(el, async () => { const r = await sapi('POST', `/api/kitchen/orders/${el.dataset.id}/accept`, { eta_minutes: el.dataset.eta ? Number(el.dataset.eta) : null }); toast(`Принято · готово через ${r.eta_minutes} мин`, 'success', { ms: 1800 }); await Kitchen.load(); }); },
    async status(el) { await busy(el, async () => { await sapi('POST', `/api/kitchen/orders/${el.dataset.id}/status`, { status: el.dataset.status }); await Kitchen.load(); }); },
    async eta(el) { await busy(el, async () => { await sapi('POST', `/api/kitchen/orders/${el.dataset.id}/eta`, { delta: Number(el.dataset.delta) }); await Kitchen.load(); }); },
    async 'item-status'(el) { await busy(el, async () => { await sapi('POST', `/api/kitchen/items/${el.dataset.id}/status`, { status: el.dataset.status }); await Kitchen.load(); }); },
    'item-cancel'(el) {
      let reason = 'Закончилось на кухне';
      const reasons = ['Закончилось на кухне', 'Ошибка в заказе', 'Гость передумал', 'Невозможно приготовить без аллергена'];
      const body = () => `<p class="small muted">Позиция исчезнет из счёта гостя, он получит уведомление с причиной.</p><div class="stack" style="gap:8px;margin-top:12px">${reasons.map((r) => `<button type="button" class="check-card radio ${r === reason ? 'on' : ''}" data-act="ic-r" data-r="${esc(r)}"><span class="mark">${icon('check')}</span><span class="cc-main"><span class="cc-title">${esc(r)}</span></span></button>`).join('')}</div>`;
      openSheet({ title: 'Убрать позицию', size: 'sm', body: body(), foot: '<button class="btn btn-ghost" data-close>Назад</button><button class="btn btn-danger" data-act="ic-go">Убрать из заказа</button>', actions: {
        'ic-r'(b, e, sheet) { reason = b.dataset.r; sheet.setBody(body()); },
        async 'ic-go'(b, e, sheet) { await busy(b, async () => { await sapi('POST', `/api/kitchen/items/${el.dataset.id}/status`, { status: 'cancelled', reason }); sheet.close(); await Kitchen.load(); }); },
      } });
    },
    async 'order-cancel'(el) {
      const ok = await confirmBox({ title: 'Отклонить заказ?', text: 'Гости увидят, что заказ отменён, сумма уйдёт из счёта.', ok: 'Отклонить', danger: true });
      if (ok) await busy(el, async () => { await sapi('POST', `/api/kitchen/orders/${el.dataset.id}/status`, { status: 'cancelled', reason: 'Кухня не может принять заказ' }); await Kitchen.load(); });
    },
    async 'stop-list'() { await Data.getMenu(true); stopListSheet(); },
    'print-ticket'(el) {
      const t = Kitchen.data.tickets.find((x) => x.id === el.dataset.id);
      if (!t) return;
      PRINT_ROOT.innerHTML = `<div class="print-ticket"><h2>№${String(t.number).padStart(3, '0')} · ${esc(t.table)}</h2><p>${timeHM(t.created_at)}${t.eta_at ? ' · к ' + timeHM(t.eta_at) : ''}</p>${t.allergies.length ? `<p><b>!!! АЛЛЕРГИИ: ${esc(t.allergies.map((a) => a.name + ' — ' + allergenNames(a.allergens)).join('; '))}</b></p>` : ''}${t.items.filter((i) => i.status !== 'cancelled').map((i) => `<p><b>${i.qty} × ${esc(i.name)}</b>${i.options.length ? '<br>  ' + esc(i.options.map((o) => o.choice).join(', ')) : ''}${i.note ? '<br>  «' + esc(i.note) + '»' : ''}${i.conflicts.length ? '<br>  !!! ' + esc(i.conflicts.map((c) => allergenNames(c.danger) + ' — ' + c.name).join('; ')) : ''}</p>`).join('')}${t.kitchen_note ? `<p>Комментарий: ${esc(t.kitchen_note)}</p>` : ''}</div>`;
      window.print();
    },
  },
  async mount() {
    document.body.classList.add('kds-mode');
    this.first = true;
    this.seen = new Set();
    await this.load();
    this.ticker = setInterval(() => this.tick(), 1000);
  },
  unmount() { clearInterval(this.ticker); document.body.classList.remove('kds-mode'); },
  reload() { Kitchen.loadSoon(); },
  onEvent(ev) {
    if (ev.type === 'kitchen' && ev.data && ev.data.reason === 'new') { Sound.beep('new'); toast(ev.data.text || 'Новый заказ', 'info', { icon: 'utensils' }); }
    if (['kitchen', 'floor', 'poll'].includes(ev.type)) this.loadSoon();
  },
  loadSoon: debounce(() => { if (View === StaffView && StaffView.panel === Kitchen) Kitchen.load().catch(() => {}); }, 200),
  async load() {
    const data = await sapi('GET', '/api/kitchen/tickets');
    clock.sync(data.server_time);
    this.data = data;
    this.render();
  },
  tick() {
    const now = clock.now();
    qsa('[data-since]').forEach((el) => { el.textContent = mmss(now - new Date(el.dataset.since).getTime()); });
    qsa('[data-due]').forEach((el) => { const left = new Date(el.dataset.due).getTime() - now; el.textContent = left >= 0 ? 'ещё ' + mmss(left) : 'опоздание ' + mmss(-left); el.classList.toggle('late', left < 0); el.closest('.ticket').classList.toggle('late', left < 0); });
  },
  ticketHtml(t) {
    const fresh = !this.first && !this.seen.has(t.id) && t.status === 'submitted';
    const num = String(t.number).padStart(3, '0');
    const groups = new Map();
    t.items.forEach((i) => { if (!groups.has(i.participant_name)) groups.set(i.participant_name, []); groups.get(i.participant_name).push(i); });
    const itemHtml = (i) => {
      const done = i.status === 'ready' || i.status === 'served';
      const btns = i.status === 'cancelled' || i.status === 'served' || t.status === 'submitted' ? '' : `<div class="t-item-actions">${done ? `<button class="t-btn on" data-act="item-status" data-id="${i.id}" data-status="cooking" aria-label="Вернуть в работу" title="Вернуть в работу">${icon('check')}</button>` : `<button class="t-btn" data-act="item-status" data-id="${i.id}" data-status="ready" aria-label="Позиция готова" title="Готово">${icon('check')}</button><button class="t-btn" data-act="item-cancel" data-id="${i.id}" aria-label="Убрать позицию" title="Убрать">${icon('x')}</button>`}</div>`;
      return `<div class="t-item ${done ? 'done' : ''} ${i.status === 'cancelled' ? 'cancelled' : ''}"><span class="t-qty">${i.qty}×</span><div class="t-main"><div class="t-name">${esc(i.emoji)} ${esc(i.name)}</div>${i.options.length ? `<div class="t-mods">${esc(i.options.map((o) => o.choice).join(' · '))}</div>` : ''}${i.note ? `<div class="t-note">«${esc(i.note)}»</div>` : ''}${i.shared_names.length ? `<div class="t-shared">на компанию: + ${esc(i.shared_names.join(', '))}</div>` : ''}${i.conflicts.map((c) => c.danger.length ? `<div class="t-conf">⚠ АЛЛЕРГИЯ: ${esc(allergenNames(c.danger))} — ${esc(c.name)}</div>` : c.caution.length ? `<div class="t-conf" style="color:#ffd27a">следы: ${esc(allergenNames(c.caution))} — ${esc(c.name)}</div>` : '').join('')}${i.status === 'cancelled' ? `<div class="t-mods">${esc(i.cancel_reason)}</div>` : ''}</div>${btns}</div>`;
    };
    const etaPicks = t.status === 'submitted' ? `<div class="eta-picks"><button class="auto" data-act="accept" data-id="${t.id}">Принять · ≈${t.eta_predicted} мин</button>${[10, 15, 20, 30].map((m) => `<button data-act="accept" data-id="${t.id}" data-eta="${m}">${m}</button>`).join('')}</div><button class="btn btn-ghost btn-sm" data-act="order-cancel" data-id="${t.id}">Отклонить</button>` : '';
    const work = t.status === 'accepted' || t.status === 'cooking' ? `${t.status === 'accepted' ? `<button class="btn btn-ghost" data-act="status" data-id="${t.id}" data-status="cooking">${icon('flame')}Начать</button>` : ''}<button class="btn btn-primary" data-act="status" data-id="${t.id}" data-status="ready">${icon('check')}Всё готово</button><button class="btn btn-ghost btn-sm" data-act="eta" data-id="${t.id}" data-delta="-5">−5 мин</button><button class="btn btn-ghost btn-sm" data-act="eta" data-id="${t.id}" data-delta="5">+5 мин</button>` : '';
    const ready = t.status === 'ready' ? `<button class="btn btn-primary" data-act="status" data-id="${t.id}" data-status="served">${icon('check')}Выдано гостям</button>` : '';
    const time = t.status === 'submitted' ? `<span class="timer" data-since="${esc(t.created_at)}">0:00</span><span>ждёт принятия</span>` : t.status === 'ready' ? `<span class="timer" data-since="${esc(t.ready_at)}">0:00</span><span>ждёт выдачи</span>` : `<span class="timer" data-due="${esc(t.eta_at)}">—</span><span>до ${timeHM(t.eta_at)}</span>`;
    return `<article class="ticket ${fresh ? 'fresh' : ''} ${t.overdue ? 'late' : ''}"><div class="ticket-head"><div><div class="ticket-num">№${num}</div></div><div class="ticket-where"><b>${esc(t.table)}</b><span>${esc(t.zone)}${t.batch > 1 ? ' · дозаказ' : ''} · ${timeHM(t.created_at)}</span></div><div class="ticket-time">${time}</div></div>
      <div class="ticket-flags">${t.rush ? `<span class="badge saffron">⏱ Спешат: уйти к ${timeHM(t.deadline_at)}</span>` : ''}${t.kind === 'office' ? '<span class="badge sky">Офис · самовывоз</span>' : ''}${t.has_conflict ? '<span class="badge danger">Аллерген в блюде</span>' : ''}<button class="badge" style="background:rgba(255,255,255,.08);color:#cfe0d7" data-act="print-ticket" data-id="${t.id}">${icon('print', 'ic-sm')}печать</button></div>
      ${t.allergies.length ? `<div class="ticket-allergy">${icon('alert')}<span>Аллергии за столом: ${esc(t.allergies.map((a) => `${a.name} — ${allergenNames(a.allergens)}`).join('; '))}</span></div>` : ''}
      ${t.kitchen_note ? `<div class="ticket-note">💬 ${esc(t.kitchen_note)}</div>` : ''}
      <div class="ticket-items">${[...groups.entries()].map(([name, list]) => `${groups.size > 1 ? `<div class="t-who">${esc(name)}</div>` : ''}${list.map(itemHtml).join('')}`).join('')}</div>
      <div class="ticket-actions">${etaPicks}${work}${ready}</div></article>`;
  },
  render() {
    const body = qs('#staff-body');
    if (!body || !this.data) return;
    const d = this.data;
    const cols = [
      { id: 'new', title: 'Новые', short: 'Новые', list: d.tickets.filter((t) => t.status === 'submitted') },
      { id: 'work', title: 'Готовятся', short: 'В работе', list: d.tickets.filter((t) => t.status === 'accepted' || t.status === 'cooking') },
      { id: 'ready', title: 'Готово к выдаче', short: 'Готово', list: d.tickets.filter((t) => t.status === 'ready') },
    ];
    const allergic = d.tickets.filter((t) => t.allergies.length).length;
    body.innerHTML = `<div class="kds"><div class="kds-bar"><span class="kds-stat">Новые <b>${cols[0].list.length}</b></span><span class="kds-stat">В работе <b>${cols[1].list.length}</b></span><span class="kds-stat">Готово <b>${cols[2].list.length}</b></span><span class="kds-stat">Выдано сегодня <b>${d.served_today}</b></span>${allergic ? `<span class="kds-stat" style="border-color:#7a2a22;color:#ffb4ab">⚠ С аллергиями <b>${allergic}</b></span>` : ''}<button class="btn btn-ghost btn-sm" style="margin-left:auto" data-act="stop-list">${icon('list')}Стоп-лист</button></div>
      <div class="seg block kds-tabs" style="background:#16211d">${cols.map((c) => `<button class="${this.tab === c.id ? 'on' : ''}" data-act="kds-tab" data-tab="${c.id}">${c.short} · ${c.list.length}</button>`).join('')}</div>
      <div class="kds-cols">${cols.map((c) => `<section class="kds-col ${this.tab === c.id ? 'on' : ''}" aria-label="${c.title}"><div class="kds-col-head"><h2>${c.title}</h2><span class="cnt">${c.list.length}</span></div>${c.list.length ? c.list.map((t) => this.ticketHtml(t)).join('') : `<div class="empty"><div class="empty-art">${c.id === 'new' ? '🔕' : c.id === 'work' ? '🍳' : '🛎️'}</div><h3>${c.id === 'new' ? 'Новых заказов нет' : c.id === 'work' ? 'Сейчас ничего не готовится' : 'Нечего выдавать'}</h3><p>${c.id === 'new' ? 'Новый тикет появится здесь мгновенно со звуковым сигналом.' : 'Принятые заказы появятся здесь.'}</p></div>`}</section>`).join('')}</div></div>`;
    d.tickets.forEach((t) => this.seen.add(t.id));
    this.first = false;
    this.tick();
  },
};

const Waiter = {
  data: null, ticker: null, view: store.get('waiter-view', 'map'), picked: null,
  actions: {
    'w-view'(el) { Waiter.view = el.dataset.v; store.set('waiter-view', Waiter.view); Waiter.render(); },
    'w-pick'(el) { Waiter.picked = el.dataset.key; Waiter.render(); },
    async resolve(el) { await busy(el, async () => { await sapi('POST', `/api/waiter/calls/${el.dataset.id}/resolve`); await Waiter.load(); }); },
    async served(el) { await busy(el, async () => { await sapi('POST', `/api/waiter/orders/${el.dataset.id}/served`); toast('Отмечено: подано', 'success', { ms: 1500 }); await Waiter.load(); }); },
    async cash(el) {
      const ok = await confirmBox({ title: 'Принять наличные?', text: `Вы получили ${el.dataset.sum} от гостя?`, ok: 'Да, получил' });
      if (ok) await busy(el, async () => { await sapi('POST', `/api/waiter/payments/${el.dataset.id}/confirm-cash`); toast('Оплата наличными принята', 'success'); await Waiter.load(); });
    },
    async close(el) {
      const code = el.dataset.code;
      const ok = await confirmBox({ title: 'Закрыть стол?', text: 'Сессия завершится, гости увидят благодарность и чек, стол станет свободным.', ok: 'Закрыть стол' });
      if (!ok) return;
      await busy(el, async () => {
        try { await sapi('POST', `/api/waiter/sessions/${code}/close`, { force: false }); }
        catch (e) {
          if (e.code !== 'close_blocked') throw e;
          const d = e.details || {};
          const force = await confirmBox({ title: 'Есть незакрытые позиции', html: `<div class="notice danger">${icon('alert')}<span>${d.due ? `Не оплачено: <b>${money(d.due)}</b>. ` : ''}${d.pending ? `В процессе оплаты: ${money(d.pending)}. ` : ''}${d.active_orders ? `Активных заказов на кухне: ${d.active_orders}.` : ''}</span></div><p class="small muted" style="margin-top:10px">Закрыть всё равно? Действие попадёт в журнал администратора.</p>`, ok: 'Закрыть принудительно', danger: true });
          if (!force) return;
          await sapi('POST', `/api/waiter/sessions/${code}/close`, { force: true });
        }
        toast('Стол закрыт', 'success');
        await Waiter.load();
      });
    },
    async details(el) { await Waiter.detailsSheet(el.dataset.code); },
    'copy-link'(el) { copyText(el.dataset.url); },
  },
  async mount() { await this.load(); this.ticker = setInterval(() => qsa('[data-ago]').forEach((e) => { e.textContent = ago(e.dataset.ago); }), 15000); },
  unmount() { clearInterval(this.ticker); },
  reload() { Waiter.loadSoon(); },
  onEvent(ev) {
    if (ev.type === 'call') { Sound.beep('call'); toast(ev.data.text || 'Вызов официанта', 'warn', { icon: 'bell', ms: 5000 }); }
    if (ev.type === 'kitchen' && ev.data && ev.data.reason === 'status') this.loadSoon();
    if (['floor', 'call', 'kitchen', 'poll'].includes(ev.type)) this.loadSoon();
  },
  loadSoon: debounce(() => { if (View === StaffView && StaffView.panel === Waiter) Waiter.load().catch(() => {}); }, 250),
  async load() { const d = await sapi('GET', '/api/waiter/floor'); clock.sync(d.server_time); this.data = d; this.render(); },
  stateText(s) {
    if (!s) return 'Свободен';
    const active = s.orders.filter((o) => ['submitted', 'accepted', 'cooking'].includes(o.status));
    return { ordering: `Выбирают · ${pl(s.participants.length, 'гость', 'гостя', 'гостей')}`, waiting: `Готовится ${active.map((o) => '№' + String(o.number).padStart(3, '0')).join(', ')}`, ready: 'Готово — отнесите к столу', eating: `Едят · к оплате ${money(s.bill.due_total)}`, paid: 'Всё оплачено — можно закрывать' }[s.state] || '';
  },
  cardHtml(label, zone, seats, s, joinUrl) {
    const short = label.replace(/[^0-9]/g, '') || label.slice(0, 2);
    const st = s ? s.state : 'free';
    const bill = s && s.bill.grand_total ? `<div class="mini-bill"><div class="mini-bar"><i style="width:${(s.bill.paid_total / s.bill.grand_total) * 100}%;background:var(--ok)"></i><i style="width:${(s.bill.pending_total / s.bill.grand_total) * 100}%;background:var(--saffron)"></i></div><div class="row-between small"><span class="muted">Оплачено ${money(s.bill.paid_total)} из ${money(s.bill.grand_total)}</span>${s.bill.overpaid_total ? `<span class="badge caution">переплата ${money(s.bill.overpaid_total)}</span>` : ''}</div></div>` : '';
    return `<article class="tcard st-${st}"><div class="tcard-head"><span class="tcard-num">${esc(short)}</span><div class="grow"><b>${esc(label)}${zone ? ' · ' + esc(zone) : ''}</b><span>${esc(this.stateText(s))}</span></div>${s ? avatarStack(s.participants.map((p) => ({ ...p, online: true })), 3, 'xs') : `<span class="badge">${pl(seats, 'место', 'места', 'мест')}</span>`}</div>
      <div class="tcard-body">${s ? `${s.calls.length ? `<div class="tcard-calls">${s.calls.map((c) => `<div class="call-pill">${icon('bell')}<div class="grow">${esc(c.label)}<span>${esc(c.name)} · <span data-ago="${esc(c.created_at)}">${ago(c.created_at)}</span></span></div><button class="btn btn-sm btn-danger" data-act="resolve" data-id="${c.id}">Иду</button></div>`).join('')}</div>` : ''}${s.cash.map((p) => `<div class="call-pill" style="background:var(--ok-soft);color:#0b6a44">${icon('cash')}<div class="grow">Наличные ${money(p.amount + p.tip)}<span>${esc(p.payer)}</span></div><button class="btn btn-sm btn-primary" data-act="cash" data-id="${p.id}" data-sum="${esc(money(p.amount + p.tip))}">Принял</button></div>`).join('')}${s.deadline_at ? `<span class="badge saffron">⏱ Спешат: до ${timeHM(s.deadline_at)}</span>` : ''}${s.orders.length ? `<div class="chip-row">${s.orders.map((o) => `<span class="badge ${o.status === 'ready' ? 'ok' : o.status === 'served' ? '' : o.status === 'cancelled' ? 'danger' : 'caution'}">№${String(o.number).padStart(3, '0')} · ${esc(o.label)}</span>`).join('')}</div>` : ''}${s.cart_count ? `<span class="small muted">В корзине: ${s.cart_count} поз. на ${money(s.cart_total)}</span>` : ''}${bill}` : `<p class="small muted">Гости откроют меню по QR на столе — стол загорится здесь.</p>`}</div>
      <div class="tcard-foot">${s ? `<button class="btn btn-ghost btn-sm" data-act="details" data-code="${esc(s.code)}">${icon('list')}Детали</button><button class="btn btn-ghost btn-sm" data-act="close" data-code="${esc(s.code)}">${icon('door')}Закрыть</button>` : joinUrl ? `<button class="btn btn-ghost btn-sm" data-act="copy-link" data-url="${esc(joinUrl)}">${icon('copy')}Ссылка стола</button>` : ''}</div></article>`;
  },
  mapTables() {
    return this.data.tables.map((t) => {
      const s = t.session;
      return { key: String(t.id), label: t.label, zone: t.zone, seats: t.seats, x: t.x, y: t.y, state: s ? 'st-' + s.state : 'free', text: this.stateText(s), guests: s ? s.participants.length : 0, people: s ? s.participants : [], calls: s ? s.calls.length + s.cash.length : 0 };
    });
  },
  mapHtml(d) {
    const mt = this.mapTables();
    if (!mt.some((t) => t.key === this.picked)) { const first = mt.find((t) => t.calls) || mt.find((t) => t.guests) || mt[0]; this.picked = first ? first.key : null; }
    const legend = HallMap.legend([['free', 'Свободен'], ['st-ordering', 'Выбирают'], ['st-waiting', 'Готовится'], ['st-ready', 'Нести к столу'], ['st-eating', 'Едят'], ['st-paid', 'Оплачено'], ['call', 'Вызов']]);
    const t = d.tables.find((x) => String(x.id) === this.picked);
    return { map: `<div class="hm-card w-map">${HallMap.html(mt, { act: 'w-pick', selected: this.picked, label: 'Карта зала' })}${legend}</div>`, selected: t ? this.cardHtml(t.label, t.zone, t.seats, t.session, t.join_url) : '' };
  },
  render() {
    const body = qs('#staff-body');
    if (!body || !this.data) return;
    const d = this.data;
    const asMap = this.view === 'map';
    const mapPart = asMap ? this.mapHtml(d) : { map: '', selected: '' };
    const busyTables = d.tables.filter((t) => t.session);
    const calls = d.tables.reduce((s, t) => s + (t.session ? t.session.calls.length : 0), 0) + d.office.reduce((s, o) => s + o.calls.length, 0);
    const guests = busyTables.reduce((s, t) => s + t.session.participants.length, 0) + d.office.reduce((s, o) => s + o.participants.length, 0);
    body.innerHTML = `<div class="floor-bar"><h1 class="section-title" style="margin-right:auto">Зал</h1><div class="seg" role="tablist" aria-label="Вид зала"><button role="tab" data-act="w-view" data-v="map" class="${asMap ? 'on' : ''}" aria-selected="${asMap}">${icon('table')}Карта</button><button role="tab" data-act="w-view" data-v="list" class="${asMap ? '' : 'on'}" aria-selected="${!asMap}">${icon('list')}Список</button></div><span class="badge jade">Занято ${busyTables.length} из ${d.tables.length}</span><span class="badge sky">Гостей ${guests}</span><span class="badge ${calls ? 'danger' : ''}">Вызовов ${calls}</span><span class="badge ${d.ready.length ? 'ok' : ''}">К выдаче ${d.ready.length}</span></div>
      ${d.ready.length ? `<div class="ready-strip">${d.ready.map((r) => `<div class="ready-chip">${icon('bell')}<span>№${String(r.number).padStart(3, '0')} · ${esc(r.table || '')}</span><button class="btn btn-sm" data-act="served" data-id="${r.id}">Подано</button></div>`).join('')}</div>` : ''}
      <div class="${asMap ? 'w-split' : ''}">${mapPart.map}<div class="floor">${asMap ? mapPart.selected : d.tables.map((t) => this.cardHtml(t.label, t.zone, t.seats, t.session, t.join_url)).join('')}${d.office.map((o) => this.cardHtml(o.title || 'Офис', 'офисная группа', 0, o, o.join_url)).join('')}</div></div>
      ${d.feed.length ? `<section class="card card-pad" style="margin-top:16px"><h2 class="panel-title">Лента событий</h2><div class="feed">${d.feed.slice(0, 12).map((e) => `<div class="feed-item"><time>${timeHM(e.ts)}</time><span>${esc(e.data.text)}</span></div>`).join('')}</div></section>` : ''}`;
  },
  async detailsSheet(code) {
    const st = await sapi('GET', `/api/waiter/sessions/${code}`);
    const names = Object.fromEntries(st.participants.map((p) => [p.id, p.name]));
    const body = `<div class="stack"><div class="row wrap">${st.participants.map((p) => `<span class="badge">${esc(p.avatar)} ${esc(p.name)}${p.allergens.length ? ' · ⚠ ' + esc(allergenNames(p.allergens)) : ''}</span>`).join('')}</div>
      <h3 class="panel-title" style="font-size:15px">Счёт</h3><div class="card">${st.bill.participants.map((r) => `<div class="list-row"><div class="grow"><b class="small">${esc(names[r.participant_id] || '')}</b><div class="tiny muted">итого ${money(r.total)} · оплачено ${money(r.paid)}</div></div>${r.overpaid ? `<button class="btn btn-sm btn-saffron" data-act="refund" data-pid="${r.participant_id}">Вернуть ${money(r.overpaid)}</button>` : `<span class="badge ${r.status === 'paid' ? 'ok' : r.due ? 'caution' : ''}">${r.due ? 'долг ' + money(r.due) : r.status === 'paid' ? 'оплачено' : '—'}</span>`}</div>`).join('')}</div>
      <h3 class="panel-title" style="font-size:15px">Заказы</h3>${st.orders.length ? st.orders.map((o) => `<div class="card card-pad"><div class="row-between"><b>№${String(o.number).padStart(3, '0')} · ${esc(o.short)}</b>${o.status === 'ready' ? `<button class="btn btn-sm btn-primary" data-act="served-in" data-id="${o.id}">Подано</button>` : ''}</div><div class="order-items" style="margin-top:8px">${o.items.map((i) => `<div class="oi ${i.status === 'cancelled' ? 'cancelled' : ''}"><span>${esc(i.emoji)}</span><span class="oi-name">${i.qty} × ${esc(i.name)} · <span class="muted small">${esc(i.participant_name)}</span></span><span class="small">${money(i.line_total)}</span></div>`).join('')}</div></div>`).join('') : '<p class="small muted">Заказов ещё нет</p>'}
      ${st.cart.items.length ? `<h3 class="panel-title" style="font-size:15px">Ещё в корзинах</h3><div class="small muted">${esc(st.cart.items.map((c) => `${c.name} ×${c.qty}`).join(', '))}</div>` : ''}</div>`;
    openSheet({ title: `${st.session.title || 'Стол'} · ${st.session.code}`, size: 'lg', body, actions: {
      async refund(el, e, sheet) { await busy(el, async () => { const r = await sapi('POST', `/api/waiter/sessions/${code}/refund`, { participant_id: el.dataset.pid }); toast(`Возврат ${money(r.amount)} оформлен`, 'success'); sheet.close(); await Waiter.load(); }); },
      async 'served-in'(el, e, sheet) { await busy(el, async () => { await sapi('POST', `/api/waiter/orders/${el.dataset.id}/served`); sheet.close(); await Waiter.load(); }); },
    } });
  },
};
routes.push({ re: /^\/staff$/, view: StaffLoginView });
routes.push({ re: /^\/staff\/(kitchen|waiter|admin)$/, view: StaffView });
