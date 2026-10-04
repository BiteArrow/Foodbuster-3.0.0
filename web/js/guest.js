'use strict';
const Gate = {
  ctx: null,
  form: null,
  actions: {
    'pick-intent'(el) { Gate.form.intent = el.dataset.intent; qsa('.mode-card').forEach((c) => c.classList.toggle('on', c === el)); },
    'pick-avatar'(el) { Gate.form.avatar = el.dataset.avatar; qsa('.avatar-picker button').forEach((b) => b.classList.toggle('on', b === el)); },
    'toggle-allergen'(el) { toggleIn(Gate.form.allergens, el.dataset.code); el.classList.toggle('on-danger'); el.setAttribute('aria-pressed', el.classList.contains('on-danger')); },
    'toggle-diet'(el) { toggleIn(Gate.form.diets, el.dataset.code); el.classList.toggle('on-jade'); el.setAttribute('aria-pressed', el.classList.contains('on-jade')); },
    'toggle-health'(el) {
      const box = qs('#health-box');
      const open = box.hidden;
      box.hidden = !open;
      el.setAttribute('aria-expanded', String(open));
    },
    async join(el) {
      const nameInput = qs('#join-name');
      const name = nameInput.value.trim();
      const err = qs('#join-error');
      if (!name) { err.hidden = false; err.textContent = 'Введите имя — так компания и официант поймут, чьё это блюдо'; nameInput.classList.add('invalid'); nameInput.focus(); return; }
      err.hidden = true;
      const f = Gate.form;
      const share = qs('#share-allergies');
      await busy(el, async () => {
        try {
          const body = { name, avatar: f.avatar, allergens: f.allergens, diets: f.diets };
          let res;
          if (Gate.ctx.kind === 'table') res = await api.post(`/api/t/${Gate.ctx.qrToken}/join`, { ...body, intent: f.intent, share_allergies: share ? share.checked : true });
          else res = await api.post(`/api/g/${Gate.ctx.code}/join`, body);
          store.set('profile', { name, avatar: f.avatar, allergens: f.allergens, diets: f.diets });
          Gate.enter(res, f.intent === 'group' && res.created);
        } catch (e) {
          err.hidden = false; err.textContent = e.message;
          if (e.code === 'name_taken') { nameInput.classList.add('invalid'); nameInput.focus(); }
        }
      });
    },
    recover() {
      const code = Gate.ctx.kind === 'table' ? Gate.ctx.preview.session && Gate.ctx.preview.session.code : Gate.ctx.code;
      if (!code) { toast('За этим столом пока никого нет — просто присоединитесь', 'info'); return; }
      openSheet({
        title: 'Восстановить доступ', size: 'sm',
        body: `<p class="muted small">Если вы сменили телефон или очистили браузер — введите имя, под которым сидели за столом, и 4-значный код из своего профиля.</p><div class="stack" style="margin-top:14px"><label class="field"><span class="label">Имя за столом</span><input class="input" id="rec-name" maxlength="24" autocomplete="off"></label><label class="field"><span class="label">Код восстановления</span><input class="input input-pin" id="rec-pin" inputmode="numeric" maxlength="4" pattern="[0-9]*" autocomplete="one-time-code" placeholder="••••"></label><div class="form-error" id="rec-error" hidden></div></div>`,
        foot: '<button class="btn btn-primary btn-block" data-act="do-recover">Вернуться к столу</button>',
        actions: {
          async 'do-recover'(btn, e, sheet) {
            const nm = qs('#rec-name').value.trim();
            const pin = qs('#rec-pin').value.trim();
            const er = qs('#rec-error');
            if (!nm || !/^\d{4}$/.test(pin)) { er.hidden = false; er.textContent = 'Введите имя и 4 цифры кода'; return; }
            await busy(btn, async () => {
              try { const res = await api.post(`/api/s/${code}/recover`, { name: nm, pin }); sheet.close(); Gate.enter(res, false); }
              catch (err2) { er.hidden = false; er.textContent = err2.message; }
            });
          },
        },
      });
    },
  },
  enter(res, inviteNow) {
    store.set('guest.' + res.code, { token: res.participant_token, pid: res.participant_id });
    if (Gate.ctx.kind === 'table') store.set('table.' + Gate.ctx.qrToken, { code: res.code });
    if (inviteNow) store.set('invite-once', res.code);
    Guest.start({ code: res.code, token: res.participant_token, kind: Gate.ctx.kind, qrToken: Gate.ctx.qrToken });
  },
  show(ctx) {
    Guest.active = false;
    this.ctx = ctx;
    const profile = store.get('profile', {}) || {};
    const cfg = Data.config;
    const p = ctx.preview;
    const session = p.session;
    const people = session ? session.participants : [];
    const hasPeople = people.length > 0;
    this.form = { intent: hasPeople ? 'group' : 'solo', avatar: profile.avatar || cfg.avatars[Math.floor(Math.random() * 8)], allergens: [...(profile.allergens || [])], diets: [...(profile.diets || [])] };
    const isOffice = ctx.kind === 'office';
    const closed = isOffice && session.status !== 'open';
    const title = isOffice ? session.title : p.table.label;
    const meta = isOffice
      ? `<span class="badge">${icon('users', 'ic-sm')}Офисный обед</span>${session.cutoff_at ? `<span class="badge">${icon('clock', 'ic-sm')}сбор до ${timeHM(session.cutoff_at)}</span>` : ''}${session.pickup_note ? `<span class="badge">${esc(session.pickup_note)}</span>` : ''}`
      : `<span class="badge">${esc(p.table.zone)}</span><span class="badge">${pl(p.table.seats, 'место', 'места', 'мест')}</span>`;
    const atTable = hasPeople ? `<div class="at-table">${avatarStack(people.map((x) => ({ ...x, online: true })), 6)}<div class="grow"><b>${isOffice ? 'В группе' : 'За столом'}: ${esc(people.map((x) => x.name).slice(0, 4).join(', '))}${people.length > 4 ? ` и ещё ${people.length - 4}` : ''}</b><span>Вы попадёте в общую корзину — каждый видит, кто что выбрал, а платит только за своё</span></div></div>` : '';
    const modeCards = !hasPeople && !isOffice ? `<div class="field"><span class="label">Как заказываете?</span><div class="mode-cards"><button type="button" class="mode-card on" data-act="pick-intent" data-intent="solo"><span class="mc-ic">🙋</span><b>Я один</b><span>Простой заказ на себя. Если кто-то отсканирует QR — включится режим компании</span></button><button type="button" class="mode-card" data-act="pick-intent" data-intent="group"><span class="mc-ic">👥</span><b>Мы компанией</b><span>Общая корзина, видно выбор друг друга, каждый платит за своё</span></button></div></div>` : '';
    APP.innerHTML = `<header class="topbar"><div class="topbar-in">${brandHtml(p.restaurant.name)}</div></header>
    <main class="gate" id="main"><div class="gate-card">
      <div class="gate-head"><div class="rest">${esc(p.restaurant.name)}</div><h1>${esc(title)}</h1><div class="meta">${meta}</div></div>
      <div class="gate-body">
        ${closed ? `<div class="notice danger">${icon('lock')}<span>Приём заказов в этой группе закрыт — дедлайн прошёл. Попросите организатора создать новую группу.</span></div><a class="btn btn-ghost" href="/" data-link>На главную</a>` : `
        ${atTable}
        ${modeCards}
        <label class="field"><span class="label">Как вас зовут?</span><input class="input" id="join-name" maxlength="24" value="${esc(profile.name || '')}" placeholder="Имя видно только за этим столом" autocomplete="given-name" enterkeyhint="go"></label>
        <div class="field"><span class="label">Аватар</span><div class="avatar-picker">${cfg.avatars.map((a) => `<button type="button" data-act="pick-avatar" data-avatar="${a}" class="${a === this.form.avatar ? 'on' : ''}" aria-label="Аватар ${a}">${a}</button>`).join('')}</div></div>
        <button type="button" class="collapse-btn" data-act="toggle-health" aria-expanded="${this.form.allergens.length || this.form.diets.length ? 'true' : 'false'}" aria-controls="health-box">${icon('shield')}<span>Аллергии и особое питание${this.form.allergens.length ? ` · ${this.form.allergens.length}` : ''}</span>${icon('down')}</button>
        <div id="health-box" class="stack" ${this.form.allergens.length || this.form.diets.length ? '' : 'hidden'}>
          <p class="hint">Отметьте то, что вам нельзя: меню подсветит опасные блюда, а кухня увидит пометку в заказе.</p>
          ${allergenChipsHtml(this.form.allergens)}
          ${dietChipsHtml(this.form.diets)}
          ${!isOffice ? `<label class="switch"><input type="checkbox" id="share-allergies" checked><span class="track"></span>Показывать мои аллергии компании — чтобы не заказать опасное на всех</label>` : ''}
        </div>
        <div class="form-error" id="join-error" hidden></div>
        <button class="btn btn-primary btn-lg btn-block" data-act="join">${hasPeople ? icon('users') + 'Присоединиться к компании' : isOffice ? icon('users') + 'Присоединиться к обеду' : icon('table') + 'Сесть за стол'}</button>
        <p class="hint" style="text-align:center">Без регистрации и приложения. ${session && session.code ? '<button class="link-btn" data-act="recover">Уже были здесь? Восстановить доступ</button>' : ''}</p>`}
      </div></div></main>`;
    const input = qs('#join-name');
    if (input) {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); qs('[data-act="join"]').click(); } });
      input.addEventListener('input', () => input.classList.remove('invalid'));
    }
  },
};

async function resumeOrGate({ kind, qrToken, code, token }) {
  await Data.getConfig();
  const known = kind === 'table' ? store.get('table.' + qrToken) : { code };
  if (known && known.code) {
    const creds = store.get('guest.' + known.code);
    if (creds) {
      try {
        const st = await api.get(`/api/s/${known.code}/state`, { token: creds.token });
        if (!isCurrent(token)) return;
        if (st.session.status !== 'closed' || kind === 'office') { await Guest.start({ code: known.code, token: creds.token, kind, qrToken, st }); return; }
      } catch (e) {
        if ([401, 403, 404].includes(e.status)) { store.del('guest.' + known.code); if (kind === 'table') store.del('table.' + qrToken); } else throw e;
      }
    }
  }
  const preview = kind === 'table' ? await api.get(`/api/t/${qrToken}`) : await api.get(`/api/g/${code}`);
  if (!isCurrent(token)) return;
  Gate.show({ kind, qrToken, code, preview });
}

const TableView = {
  get actions() { return Guest.active ? Guest.actions : Gate.actions; },
  async mount(qrToken, token) {
    APP.innerHTML = '<div class="boot"><div class="boot-mark">' + LOGO + '</div></div>';
    await resumeOrGate({ kind: 'table', qrToken, token });
  },
  unmount() { Guest.stop(); },
};
const OfficeView = {
  get actions() { return Guest.active ? Guest.actions : Gate.actions; },
  async mount(code, token) {
    APP.innerHTML = '<div class="boot"><div class="boot-mark">' + LOGO + '</div></div>';
    await resumeOrGate({ kind: 'office', code: code.toUpperCase(), token });
  },
  unmount() { Guest.stop(); },
};
routes.push({ re: /^\/t\/([A-Za-z0-9_-]{4,40})$/, view: TableView });
routes.push({ re: /^\/g\/([A-Za-z0-9-]{4,20})$/, view: OfficeView });

const FILTERS = [
  { id: 'safe', label: 'Подходит мне', ico: '🛡️', profile: true },
  { id: 'popular', label: 'Хиты', ico: '⭐' },
  { id: 'new', label: 'Новинки', ico: '✨' },
  { id: 'light', label: 'До 450 ккал', ico: '🥗' },
  { id: 'protein', label: 'Белок от 30 г', ico: '💪' },
  { id: 'fast', label: 'Быстро, до 10 мин', ico: '⚡' },
  { id: 'vegetarian', label: 'Вегетарианское', ico: '🥕' },
  { id: 'vegan', label: 'Веганское', ico: '🌱' },
  { id: 'halal', label: 'Халал', ico: '☪' },
  { id: 'nospicy', label: 'Не острое', ico: '🧊' },
];
const STEP_LABELS = [['submitted', 'Отправлен'], ['accepted', 'Принят'], ['cooking', 'Готовится'], ['ready', 'Готов'], ['served', 'Подан']];
const STATUS_INDEX = { submitted: 0, accepted: 1, cooking: 2, ready: 3, served: 4 };

const Guest = {
  active: false, code: null, token: null, kind: 'table', qrToken: null,
  st: null, menu: null, view: 'menu', panel: 'cart', q: '', search: null, filters: new Set(), hideDanger: false,
  feed: [], live: null, ticker: null, recs: [], prevOrders: null, presenceKey: '', presenceTimer: null,
  refreshing: false, refreshAgain: false, observer: null, activeCat: null, lastProfileKey: '', liveState: 'online', titleTimer: null,

  get me() { return this.st && this.st.me; },
  get company() { return this.st && this.st.session.mode === 'company'; },
  get profile() { return (this.me && this.me.allergens) || []; },
  person(id) { return this.st.participants.find((p) => p.id === id); },
  nameOf(id) { const p = this.person(id); return p ? p.name : 'гость'; },
  myQty(itemId) { return this.st.cart.items.filter((c) => c.mine && c.menu_item_id === itemId).reduce((s, c) => s + c.qty, 0); },
  editable() { return this.st.session.status === 'open'; },

  async start({ code, token, kind, qrToken, st }) {
    this.stop();
    Object.assign(this, { active: true, code, token, kind, qrToken, view: 'menu', q: '', search: null, filters: new Set(), feed: [], recs: [], prevOrders: null, presenceKey: '', activeCat: null });
    const [menu, state] = await Promise.all([Data.getMenu(), st ? Promise.resolve(st) : api.get(`/api/s/${code}/state`, { token })]);
    this.menu = menu;
    this.panel = 'cart';
    this.st = null;
    this.renderShell();
    this.apply(state, { first: true });
    this.live = new Live(`/api/s/${code}/events?token=${encodeURIComponent(token)}`, (ev) => this.onEvent(ev), (s) => this.setLive(s)).start();
    this.ticker = setInterval(() => this.tick(), 1000);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.loadRecs();
    if (store.get('invite-once') === code) { store.del('invite-once'); setTimeout(() => this.actions.invite(), 400); }
  },
  stop() {
    if (this.live) this.live.stop();
    this.live = null;
    clearInterval(this.ticker);
    clearInterval(this.titleTimer);
    if (this.observer) this.observer.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.active = false;
  },
  onVisibility() {
    if (!Guest.active) return;
    if (document.visibilityState === 'visible') { Guest.refresh(); clearInterval(Guest.titleTimer); document.title = 'Foodbuster — общий стол без хаоса'; }
  },
  setLive(state) {
    this.liveState = state;
    const el = qs('#g-live');
    if (el) { el.className = 'live-dot' + (state === 'online' ? '' : ' warn'); el.textContent = state === 'online' ? 'В сети' : 'Переподключение…'; }
    if (state === 'online') this.refresh();
  },
  onEvent(ev) {
    if (!this.active) return;
    if (ev.type === 'presence') {
      const p = this.st && this.person(ev.data.participant_id);
      if (p) { p.online = ev.data.online || p.is_me; p.viewing = ev.data.viewing; this.renderHeader(); this.patchDynamic(); if (this.panel === 'table') this.renderSide(); }
      return;
    }
    if (ev.type === 'menu') { Data.getMenu(true).then((m) => { this.menu = m; this.renderMenu(); this.refresh(); }).catch(() => {}); return; }
    if (ev.type === 'state') {
      const d = ev.data || {};
      if (d.text && d.actor_id !== (this.me && this.me.id)) {
        this.pushFeed(d.text);
        if (!['profile'].includes(d.reason)) toast(d.text, d.reason === 'closed' ? 'warn' : 'info', { icon: d.reason === 'joined' ? 'users' : d.reason === 'order' || d.reason === 'status' || d.reason === 'item' ? 'utensils' : 'info', ms: 2600 });
      }
      this.scheduleRefresh();
      return;
    }
    if (ev.type === 'poll') this.refresh();
  },
  scheduleRefresh: debounce(() => Guest.refresh(), 120),
  async refresh() {
    if (!this.active) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    try {
      const st = await api.get(`/api/s/${this.code}/state`, { token: this.token });
      if (this.active) this.apply(st);
    } catch (e) {
      if (e.status === 401 || e.status === 403) { store.del('guest.' + this.code); toast(e.message, 'error'); setTimeout(() => route(), 800); }
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) { this.refreshAgain = false; this.refresh(); }
    }
  },
  pushFeed(text) { this.feed.unshift({ text, at: new Date(clock.now()).toISOString() }); this.feed = this.feed.slice(0, 30); },
  apply(st, { first = false } = {}) {
    clock.sync(st.server_time);
    const prev = this.st;
    this.st = st;
    if (st.session.status === 'closed') { this.renderClosed(); return; }
    const orders = new Map(st.orders.map((o) => [o.id, o.status]));
    if (this.prevOrders && !first) {
      for (const o of st.orders) {
        const before = this.prevOrders.get(o.id);
        if (before && before !== 'ready' && o.status === 'ready') this.celebrate(o);
      }
    }
    this.prevOrders = orders;
    if (prev && prev.session.mode !== st.session.mode && st.session.mode === 'company' && !first) this.pushFeed('Включён режим компании');
    if (!this.company && this.panel === 'table') this.panel = 'cart';
    const profileKey = this.profile.join(',') + '|' + ((this.me && this.me.diets) || []).join(',');
    if (!qs('#g-header')) this.renderShell();
    this.renderHeader();
    if (profileKey !== this.lastProfileKey || first) { this.lastProfileKey = profileKey; this.renderProfile(); this.renderMenu(); }
    else this.patchDynamic();
    this.renderSide();
    this.renderNav();
    if (prev && prev.cart.my_count !== st.cart.my_count) this.loadRecsSoon();
  },
  celebrate(order) {
    vibrate([200, 100, 200, 100, 300]);
    WaitGame.orderReady(order.number);
    toast(`Заказ №${String(order.number).padStart(3, '0')} готов — несём к столу!`, 'success', { ms: 6000, icon: 'bell' });
    if (document.visibilityState !== 'visible') {
      let on = false;
      clearInterval(this.titleTimer);
      this.titleTimer = setInterval(() => { on = !on; document.title = on ? '🔔 Заказ готов!' : 'Foodbuster'; }, 1000);
    }
  },
  presence(kind, ref) {
    const key = kind + ':' + (ref ?? '');
    if (key === this.presenceKey) return;
    this.presenceKey = key;
    clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => {
      if (!this.active || !this.company) return;
      api.post(`/api/s/${this.code}/presence`, { kind, ref: ref == null ? null : String(ref) }, { token: this.token }).catch(() => {});
    }, 500);
  },
  loadRecsSoon: debounce(() => Guest.loadRecs(), 1200),
  async loadRecs() {
    try {
      const res = await api.get(`/api/s/${this.code}/recommendations`, { token: this.token });
      if (!this.active) return;
      this.recs = res.items;
      this.renderRecs();
      if (this.panel === 'cart') this.renderSide();
    } catch (e) { this.recs = []; }
  },
  async mutate(method, path, body, opts = {}) {
    const res = await api.req(method, `/api/s/${this.code}${path}`, { body, token: this.token, ...opts });
    if (res && res.state) this.apply(res.state);
    return res;
  },
  tick() {
    const now = clock.now();
    qsa('[data-countdown]').forEach((el) => {
      const left = new Date(el.dataset.countdown).getTime() - now;
      el.textContent = left >= 0 ? mmss(left) : '+' + mmss(-left);
      const box = el.closest('.eta-box');
      if (box) box.classList.toggle('late', left < 0);
    });
    qsa('[data-left]').forEach((el) => {
      const left = new Date(el.dataset.left).getTime() - now;
      el.textContent = left > 0 ? (left > 3600000 ? `${Math.floor(left / 3600000)} ч ${Math.round((left % 3600000) / 60000)} мин` : `${Math.ceil(left / 60000)} мин`) : 'время вышло';
    });
  },

  renderShell() {
    APP.innerHTML = `<div class="g-app" data-view="menu">
      <header class="g-header"><div class="g-header-in" id="g-header"></div></header>
      <div class="g-layout">
        <nav class="g-rail" id="g-rail" aria-label="Категории меню"></nav>
        <main class="g-main" id="main">
          <div class="search-box" role="search">${icon('search')}<input id="g-search" class="input" type="search" placeholder="Блюдо, продукт или «без глютена до 500 ккал»" autocomplete="off" enterkeyhint="search" aria-label="Поиск по меню, составу, аллергенам и калориям"><button class="clear" data-act="search-clear" aria-label="Очистить поиск" hidden>${icon('x')}</button></div>
          <div id="g-understood"></div>
          <div class="filters chip-scroll" id="g-filters" aria-label="Быстрые фильтры"></div>
          <div class="mobile-cats"><div class="chip-scroll" id="g-cats" aria-label="Категории"></div></div>
          <div id="g-profile"></div>
          <div id="g-recs"></div>
          <div id="g-menu"></div>
        </main>
        <aside class="g-side" id="g-side" aria-label="Стол, корзина и счёт">
          <div class="g-side-tabs" id="g-side-tabs" role="tablist"></div>
          <div class="g-side-body" id="g-side-body"></div>
          <div class="g-side-foot" id="g-side-foot"></div>
        </aside>
      </div>
      <nav class="bottom-nav" id="g-nav" aria-label="Разделы"></nav>
    </div>`;
    const input = qs('#g-search');
    input.value = this.q;
    input.addEventListener('input', () => this.onSearch(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  },
  onSearch(value) {
    this.q = value;
    qs('[data-act="search-clear"]').hidden = !value;
    if (!value.trim()) { this.search = null; this.renderMenu(); this.presence('category', this.activeCat); return; }
    this.runSearch(value);
  },
  runSearch: debounce(async function runSearch(value) {
    try {
      const res = await api.get('/api/menu/search?q=' + encodeURIComponent(value));
      if (Guest.q !== value) return;
      Guest.search = res;
      Guest.renderMenu();
      Guest.presence('search', value.trim());
    } catch (e) { showError(e); }
  }, 220),

  renderHeader() {
    const st = this.st;
    const s = st.session;
    const me = this.me;
    const people = st.participants;
    const label = s.kind === 'office' ? 'Офис' : (s.table ? s.table.label : 'Стол');
    const sub = s.kind === 'office'
      ? (s.status === 'locked' ? 'Приём закрыт' : s.cutoff_at ? `Сбор: ещё <span data-left="${esc(s.cutoff_at)}"></span>` : 'Офисный обед')
      : `${esc(s.table ? s.table.zone : '')}`;
    const myCall = st.calls.some((c) => c.participant_id === (me && me.id));
    qs('#g-header').innerHTML = `
      <div class="g-tent"><span class="g-tent-num">${esc(label)}</span><div class="g-tent-meta hide-sm"><b class="ellipsis">${esc(s.kind === 'office' ? s.title : Data.config.restaurant.name)}</b><span>${sub}</span></div></div>
      <button class="g-mode" data-act="${this.company ? 'go-panel' : 'invite'}" data-panel="table" aria-label="${this.company ? 'Компания' : 'Пригласить'}">${avatarStack(people, 4, 'sm')}<span class="lbl">${this.company ? `Компания · ${people.length}` : 'Один гость'}</span></button>
      <div class="g-actions">
        <span id="g-live" class="live-dot hide-sm ${this.liveState === 'online' ? '' : 'warn'}">${this.liveState === 'online' ? 'В сети' : 'Переподключение…'}</span>
        ${s.kind === 'table' ? `<button class="icon-btn labeled" data-act="waiter" aria-label="Позвать официанта" title="Позвать официанта">${icon('bell')}<span class="btn-lbl">Официант</span>${myCall ? '<i class="dot"></i>' : ''}</button>` : ''}
        <button class="icon-btn labeled" data-act="invite" aria-label="Пригласить за стол" title="Пригласить">${icon('qr')}<span class="btn-lbl">Пригласить</span></button>
        ${me ? `<button class="me-btn" data-act="profile" aria-label="Мой профиль">${avatar(me, 'sm')}<span class="ellipsis hide-sm">${esc(me.name)}</span>${me.allergens.length ? '<span class="badge danger">' + me.allergens.length + '</span>' : ''}</button>` : ''}
      </div>`;
    this.tick();
  },

  passesFilters(item) {
    const f = this.filters;
    const lv = levelFor(item.allergens, item.traces, this.profile).level;
    if (this.hideDanger && lv === 'danger') return false;
    if (f.has('safe') && (lv === 'danger' || lv === 'caution')) return false;
    if (f.has('popular') && !item.popular) return false;
    if (f.has('new') && !item.new) return false;
    if (f.has('light') && item.kcal > 450) return false;
    if (f.has('protein') && item.protein < 30) return false;
    if (f.has('fast') && item.cook_minutes > 10) return false;
    if (f.has('vegetarian') && !item.diets.some((d) => d === 'vegetarian' || d === 'vegan')) return false;
    if (f.has('vegan') && !item.diets.includes('vegan')) return false;
    if (f.has('halal') && !item.diets.some((d) => ['halal', 'vegetarian', 'vegan'].includes(d))) return false;
    if (f.has('nospicy') && item.diets.includes('spicy')) return false;
    const myDiets = (this.me && this.me.diets) || [];
    if (f.has('safe') && myDiets.includes('vegan') && !item.diets.includes('vegan')) return false;
    return true;
  },
  renderProfile() {
    const me = this.me;
    if (!me) return;
    const names = [...me.allergens.map((a) => Data.allergen(a).short), ...me.diets.map((d) => Data.diet(d).name.toLowerCase())];
    qs('#g-profile').innerHTML = me.allergens.length || me.diets.length
      ? `<div class="profile-strip has"><span class="ps-ic">🛡️</span><div class="ps-main"><b>Мой профиль: ${esc(names.join(', '))}</b><span>Опасные блюда помечены красным, отметка уйдёт на кухню</span></div><label class="switch"><input type="checkbox" id="hide-danger" ${this.hideDanger ? 'checked' : ''}><span class="track"></span>Скрыть опасные</label><button class="btn btn-ghost btn-sm" data-act="profile">Изменить</button></div>`
      : `<div class="profile-strip"><span class="ps-ic">🛡️</span><div class="ps-main"><b>Есть аллергия или особое питание?</b><span>Отметьте — подсветим опасные блюда и предупредим повара</span></div><button class="btn btn-soft btn-sm" data-act="profile">Указать</button></div>`;
    const hd = qs('#hide-danger');
    if (hd) hd.addEventListener('change', () => { this.hideDanger = hd.checked; this.renderMenu(); });
    qs('#g-filters').innerHTML = FILTERS.filter((f) => !f.profile || me.allergens.length || me.diets.length).map((f) => `<button class="chip ${this.filters.has(f.id) ? 'on' : ''}" data-act="filter" data-id="${f.id}" aria-pressed="${this.filters.has(f.id)}"><span class="ico">${f.ico}</span>${esc(f.label)}</button>`).join('');
  },
  renderRecs() {
    const box = qs('#g-recs');
    if (!box) return;
    const list = this.recs.filter((r) => { const it = this.menu.byId.get(r.id); return it && it.available; }).slice(0, 6);
    if (!list.length || this.search || this.filters.size || !this.editable()) { box.innerHTML = ''; return; }
    const hasCart = this.st.cart.my_count > 0;
    box.innerHTML = `<section class="recs" aria-label="Рекомендации"><div class="recs-head"><h3>${icon('sparkles')}${hasCart ? 'К вашему заказу' : 'Советуем начать с'}</h3></div><div class="recs-row">${list.map((r) => { const it = this.menu.byId.get(r.id); return `<div class="rec" data-act="open-dish" data-id="${it.id}" role="button" tabindex="0">${dishArt(it, 'rec-art')}<div class="rec-main"><b>${esc(it.name)}</b><span>${esc(r.reason)}</span><span>${money(it.price)} · ${fmt0(it.kcal)} ккал</span></div><button class="rec-add" data-act="add" data-id="${it.id}" aria-label="Добавить ${esc(it.name)}">${icon('plus')}</button></div>`; }).join('')}</div></section>`;
  },
  dishCard(item, reason) {
    const lv = levelFor(item.allergens, item.traces, this.profile);
    const badges = [];
    if (lv.level === 'danger') badges.push(`<span class="badge danger">⚠ ${esc(allergenNames(lv.danger))}</span>`);
    else if (lv.level === 'caution') badges.push(`<span class="badge caution">Следы: ${esc(allergenNames(lv.caution))}</span>`);
    else if (lv.level === 'safe') badges.push('<span class="badge ok">✓ Подходит вам</span>');
    if (item.popular) badges.push('<span class="badge white">⭐ Хит</span>');
    if (item.new) badges.push('<span class="badge saffron">Новинка</span>');
    const diets = item.diets.map((d) => Data.diet(d)).map((d) => `<span title="${esc(d.name)}">${d.icon}</span>`).join('');
    const cls = ['dish', lv.level === 'danger' ? 'is-danger' : '', item.available ? '' : 'is-off'].join(' ');
    return `<article class="${cls}" data-act="open-dish" data-id="${item.id}" data-dish="${item.id}" tabindex="0" role="button" aria-label="${esc(item.name)}, ${money(item.price)}">
      ${dishArt(item, 'dish-art', `<div class="dish-badges">${badges.join('')}</div><span class="badge white dish-time">${icon('clock', 'ic-sm')}${item.cook_minutes} мин</span><div class="dish-watch" data-watch="${item.id}" hidden></div>`)}
      <div class="dish-body">
        <div class="dish-name">${esc(item.name)}</div>
        <div class="dish-sub"><span>${item.weight_g ? item.weight_g + (item.category_code === 'drinks' || item.category_code === 'coffee' ? ' мл' : ' г') : ''}</span>${diets ? `<span>${diets}</span>` : ''}${item.allergens.length && lv.level === 'none' ? `<span>· ${esc(allergenNames(item.allergens.slice(0, 3)))}${item.allergens.length > 3 ? '…' : ''}</span>` : ''}</div>
        <p class="dish-desc clamp-2">${esc(item.description)}</p>
        ${reason ? `<div class="dish-flags"><span class="badge sky">${icon('search', 'ic-sm')}${esc(reason)}</span></div>` : ''}
        ${macroBar(item)}
        <div class="dish-foot"><span class="dish-price">${money(item.price)}</span><div class="dish-ctl" data-ctl="${item.id}">${this.dishCtl(item)}</div></div>
      </div></article>`;
  },
  dishCtl(item) {
    if (!item.available) return '<span class="badge">Закончилось</span>';
    if (!this.editable()) return '';
    const qty = this.myQty(item.id);
    const danger = levelFor(item.allergens, item.traces, this.profile).level === 'danger';
    if (qty > 0) return `<div class="stepper"><button data-act="dec-dish" data-id="${item.id}" aria-label="Убрать одну порцию">${icon('minus', 'ic-sm')}</button><span class="val">${qty}</span><button data-act="add" data-id="${item.id}" aria-label="Добавить ещё">${icon('plus', 'ic-sm')}</button></div>`;
    return `<button class="add-btn ${danger ? 'danger' : ''}" data-act="add" data-id="${item.id}" aria-label="Добавить ${esc(item.name)}">${icon('plus')}</button>`;
  },
  watchers(itemId) {
    const st = this.st;
    const viewers = st.participants.filter((p) => !p.is_me && p.online && p.viewing && p.viewing.kind === 'dish' && p.viewing.id === itemId);
    const holders = [...new Set(st.cart.items.filter((c) => !c.mine && c.menu_item_id === itemId).map((c) => c.participant_id))].map((id) => this.person(id)).filter(Boolean);
    if (viewers.length) return { people: viewers, text: viewers.length === 1 ? `${viewers[0].name} смотрит` : `смотрят ${viewers.length}` };
    if (holders.length) return { people: holders, text: holders.length === 1 ? `в корзине: ${holders[0].name}` : `в корзинах: ${holders.length}` };
    return null;
  },
  patchDynamic() {
    if (!this.st) return;
    qsa('[data-dish]').forEach((card) => {
      const item = this.menu.byId.get(Number(card.dataset.dish));
      if (!item) return;
      card.classList.toggle('mine', this.myQty(item.id) > 0);
      const ctl = card.querySelector('[data-ctl]');
      const html = this.dishCtl(item);
      if (ctl && ctl.dataset.html !== html) { ctl.innerHTML = html; ctl.dataset.html = html; }
      const watch = card.querySelector('[data-watch]');
      const w = this.company ? this.watchers(item.id) : null;
      if (watch) { watch.hidden = !w; if (w) watch.innerHTML = `${avatarStack(w.people, 2, 'xs')}<span>${esc(w.text)}</span>`; }
    });
  },
  visibleItems() {
    let items = this.menu.items;
    let reasons = new Map();
    if (this.search && !this.search.empty) {
      const order = new Map(this.search.results.map((r, i) => [r.id, i]));
      reasons = new Map(this.search.results.map((r) => [r.id, r.reason]));
      items = items.filter((i) => order.has(i.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
    }
    items = items.filter((i) => this.passesFilters(i));
    return { items, reasons };
  },
  renderMenu() {
    if (!this.st || !qs('#g-menu')) return;
    const { items, reasons } = this.visibleItems();
    const flat = (this.search && !this.search.empty) || this.filters.size || this.hideDanger;
    const und = qs('#g-understood');
    und.innerHTML = this.search && !this.search.empty ? `<div class="search-understood"><span>Понял запрос как:</span>${this.search.chips.map((c) => `<span class="badge ${c.kind === 'allergen' || c.kind === 'exclude' ? 'danger' : c.kind === 'text' ? 'sky' : 'jade'}">${esc(c.text)}</span>`).join('')}</div>` : '';
    const cats = this.menu.categories.filter((c) => this.menu.items.some((i) => i.category_code === c.code));
    let html;
    if (flat) {
      html = `<div class="results-head"><h2>${items.length ? `Найдено ${pl(items.length, 'блюдо', 'блюда', 'блюд')}` : 'Ничего не найдено'}</h2>${this.filters.size || this.search ? '<button class="btn btn-ghost btn-sm" data-act="reset-filters">Сбросить фильтры</button>' : ''}</div>`;
      html += items.length ? `<div class="dish-grid">${items.map((i) => this.dishCard(i, reasons.get(i.id))).join('')}</div>` : `<div class="empty"><div class="empty-art">🔎</div><h3>Таких блюд нет</h3><p>Попробуйте «курица», «без молока», «до 500 ккал», «белок от 30» или уберите часть фильтров.</p></div>`;
    } else {
      html = cats.map((c) => {
        const list = items.filter((i) => i.category_code === c.code);
        if (!list.length) return '';
        return `<section class="cat-section" id="cat-${esc(c.code)}" data-cat="${esc(c.code)}"><div class="cat-title"><h2>${esc(c.emoji)} ${esc(c.name)}</h2><span>${list.length}</span></div><div class="dish-grid">${list.map((i) => this.dishCard(i)).join('')}</div></section>`;
      }).join('');
    }
    qs('#g-menu').innerHTML = html;
    const catButtons = (cls) => cats.map((c) => `<button class="${cls} ${this.activeCat === c.code ? 'on' : ''}" data-act="goto-cat" data-cat="${esc(c.code)}">${esc(c.emoji)} ${esc(c.name)}${cls === '' ? `<span class="cnt">${this.menu.items.filter((i) => i.category_code === c.code).length}</span>` : ''}</button>`).join('');
    qs('#g-rail').innerHTML = flat ? '' : `<div class="rail-title">Меню · ${this.menu.items.length}</div>${catButtons('')}`;
    qs('#g-cats').innerHTML = flat ? '' : catButtons('chip');
    qs('#g-cats').parentElement.hidden = flat;
    this.renderRecs();
    this.patchDynamic();
    this.observeCats();
  },
  observeCats() {
    if (this.observer) this.observer.disconnect();
    if (!('IntersectionObserver' in window)) return;
    this.observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      const code = visible.target.dataset.cat;
      if (code === this.activeCat) return;
      this.activeCat = code;
      qsa('[data-act="goto-cat"]').forEach((b) => b.classList.toggle('on', b.dataset.cat === code));
      const chip = qs(`#g-cats [data-cat="${CSS.escape(code)}"]`);
      if (chip && chip.parentElement.scrollWidth > chip.parentElement.clientWidth) chip.parentElement.scrollTo({ left: chip.offsetLeft - 20, behavior: 'smooth' });
      if (this.view === 'menu') this.presence('category', code);
    }, { rootMargin: '-120px 0px -60% 0px', threshold: 0 });
    qsa('.cat-section').forEach((s) => this.observer.observe(s));
  },

  tabs() {
    const st = this.st;
    const active = st.orders.filter((o) => ['submitted', 'accepted', 'cooking', 'ready'].includes(o.status));
    const ready = active.some((o) => o.status === 'ready');
    const myDue = (st.bill.participants.find((r) => r.participant_id === this.me.id) || {}).due || 0;
    const list = [
      { id: 'cart', label: 'Корзина', ic: 'bag', badge: st.cart.count || '', cls: st.cart.warnings ? 'warn' : '' },
    ];
    if (this.company) list.push({ id: 'table', label: 'Компания', ic: 'users', badge: st.participants.length > 1 ? st.participants.length : '' });
    list.push({ id: 'orders', label: 'Заказ', ic: 'clock', badge: active.length || '', cls: ready ? 'ok' : 'warn' });
    list.push({ id: 'bill', label: 'Счёт', ic: 'receipt', badge: myDue ? '•' : '', cls: 'warn' });
    return list;
  },
  renderNav() {
    const tabs = this.tabs();
    qs('#g-side-tabs').innerHTML = tabs.map((t) => `<button role="tab" aria-selected="${this.panel === t.id}" class="${this.panel === t.id ? 'on' : ''}" data-act="side-tab" data-panel="${t.id}">${esc(t.label)}${t.badge ? `<span class="count ${t.cls || ''}">${t.badge}</span>` : ''}</button>`).join('');
    const nav = qs('#g-nav');
    nav.style.setProperty('--cols', tabs.length + 1);
    nav.innerHTML = `<button class="${this.view === 'menu' ? 'on' : ''}" data-act="nav" data-panel="menu">${icon('grid')}<span class="lbl">Меню</span></button>` + tabs.map((t) => `<button class="${this.view === 'panel' && this.panel === t.id ? 'on' : ''}" data-act="nav" data-panel="${t.id}">${icon(t.ic)}<span class="lbl">${esc(t.label)}</span>${t.badge ? `<span class="bn-badge ${t.cls || ''}">${t.badge}</span>` : ''}</button>`).join('');
  },
  renderSide() {
    const body = qs('#g-side-body');
    if (!body || !this.st) return;
    const scroll = body.scrollTop;
    const out = { cart: () => this.cartPanel(), table: () => this.companyPanel(), orders: () => this.ordersPanel(), bill: () => this.billPanel() }[this.panel]();
    body.innerHTML = out.body;
    const foot = qs('#g-side-foot');
    foot.innerHTML = out.foot || '';
    foot.hidden = !out.foot;
    body.scrollTop = scroll;
    this.tick();
    const ready = qs('#ready-toggle');
    if (ready) ready.addEventListener('change', () => this.mutate('PATCH', '/me', { ready: ready.checked }).catch((e) => { ready.checked = !ready.checked; showError(e); }));
  },

  lineHtml(c) {
    const item = this.menu.byId.get(c.menu_item_id);
    const art = item ? dishArt(item, 'line-art') : `<div class="line-art cat-other">${esc(c.emoji)}</div>`;
    const opts = c.options.map((o) => o.choice).join(', ');
    const holders = 1 + c.shared_with.length;
    const tags = [];
    if (c.shared_with.length) tags.push(`<span class="badge plum">на ${holders}: ${money(Math.ceil(c.line_total / holders))} с каждого</span>`);
    for (const w of c.warnings) if (w.level === 'danger') tags.push(`<span class="badge danger">⚠ ${esc(allergenNames(w.danger))} · ${esc(w.participant_id === this.me.id ? 'вам' : w.name)}</span>`);
    for (const w of c.warnings) if (w.level === 'caution') tags.push(`<span class="badge caution">следы ${esc(allergenNames(w.caution))} · ${esc(w.participant_id === this.me.id ? 'вам' : w.name)}</span>`);
    if (c.unavailable) tags.push('<span class="badge danger">Закончилось — удалите</span>');
    else if (c.price_changed) tags.push(`<span class="badge">цена зафиксирована, в меню сейчас ${money(c.price_now)}</span>`);
    const danger = c.warnings.some((w) => w.level === 'danger');
    const ctl = c.mine && this.editable()
      ? `<div class="stepper"><button data-act="line-qty" data-line="${c.id}" data-delta="-1" aria-label="Меньше">${icon(c.qty === 1 ? 'trash' : 'minus', 'ic-sm')}</button><span class="val">${c.qty}</span><button data-act="line-qty" data-line="${c.id}" data-delta="1" aria-label="Больше">${icon('plus', 'ic-sm')}</button></div><button class="line-edit" data-act="edit-line" data-line="${c.id}">${icon('edit', 'ic-sm')}Изменить</button>`
      : `<span class="small muted">× ${c.qty}</span>`;
    return `<div class="line ${danger ? 'warn' : ''} ${c.unavailable ? 'off' : ''}">${art}<div class="line-main"><div class="line-name">${esc(c.name)}</div><div class="line-meta">${opts ? esc(opts) + ' · ' : ''}${money(c.unit_price)} · ${fmt0(c.kcal)} ккал</div>${c.note ? `<div class="line-note">«${esc(c.note)}»</div>` : ''}${tags.length ? `<div class="line-tags">${tags.join('')}</div>` : ''}</div><div class="line-side"><span class="line-price">${money(c.line_total)}</span>${ctl}</div></div>`;
  },
  personStatus(p) {
    if (p.is_me) return p.ready ? 'вы готовы ✓' : 'это вы';
    if (p.ready) return 'выбрал(а) ✓';
    if (!p.online) return 'не в сети';
    if (p.viewing) return (p.viewing.kind === 'dish' ? 'смотрит ' : p.viewing.kind === 'search' ? 'ищет ' : 'в разделе ') + '«' + p.viewing.label + '»';
    return 'выбирает';
  },
  cartPanel() {
    const st = this.st;
    const me = this.me;
    const items = st.cart.items;
    let body = '';
    if (st.session.status === 'locked') body += `<div class="notice">${icon('lock')}<span>Дедлайн группы прошёл — приём заказов закрыт${st.session.auto_submitted_at ? ', всё отправлено на кухню автоматически' : ''}.</span></div>`;
    if (!items.length) {
      body += `<div class="empty"><div class="empty-art">🧺</div><h3>Корзина пуста</h3><p>${this.company ? 'Выберите блюдо — компания сразу увидит его в общей корзине.' : 'Выберите блюдо в меню — цена зафиксируется в момент добавления.'}</p><button class="btn btn-soft" data-act="nav" data-panel="menu">${icon('grid')}Открыть меню</button></div>`;
    } else if (!this.company) {
      body += items.map((c) => this.lineHtml(c)).join('');
    } else {
      const order = [me, ...st.participants.filter((p) => !p.is_me)];
      body += order.map((p) => {
        const person = st.participants.find((x) => x.id === p.id);
        const mine = items.filter((c) => c.participant_id === p.id);
        return `<div class="person-block"><div class="person-head">${avatar(person, 'sm', { offline: !person.online })}<div class="grow"><b>${esc(person.name)}${person.role === 'host' ? ' · хозяин стола' : ''}</b><span class="sub">${esc(this.personStatus(person))}</span></div><span class="sum">${money(person.cart_total)}</span></div>${mine.length ? mine.map((c) => this.lineHtml(c)).join('') : `<p class="small muted" style="padding:4px 0 2px 38px">${person.is_me ? 'Вы пока ничего не добавили' : 'Пока ничего не выбрал(а)'}</p>`}</div>`;
      }).join('');
    }
    if (items.length) {
      const myLines = items.filter((c) => c.mine);
      body += `<hr class="divider" style="margin:14px 0"><div class="totals">${this.company ? `<div class="t-row"><span>Мои позиции · ${myLines.reduce((s, c) => s + c.qty, 0)}</span><span>${money(st.cart.my_total)}</span></div>` : ''}<div class="t-row t-big"><span>${this.company ? 'Корзина стола' : 'Итого в корзине'}</span><span>${money(st.cart.total)}</span></div>${st.session.service_percent ? `<div class="t-row small"><span>Обслуживание ${fmt1(st.session.service_percent)}% добавится в счёт</span><span></span></div>` : ''}</div>`;
    }
    if (me) {
      const n = me.nutrition;
      if (n.kcal > 0) body += `<div style="margin-top:14px"><div class="small muted" style="margin-bottom:6px">Моё КБЖУ за визит, с учётом общих блюд</div><div class="nutri"><div><b>${fmt0(n.kcal)}</b><span>ккал</span></div><div><b>${fmt0(n.protein)}</b><span>белки, г</span></div><div><b>${fmt0(n.fat)}</b><span>жиры, г</span></div><div><b>${fmt0(n.carbs)}</b><span>углев., г</span></div></div></div>`;
    }
    const recs = this.recs.filter((r) => { const it = this.menu.byId.get(r.id); return it && it.available; }).slice(0, 3);
    if (recs.length && this.editable() && items.length) {
      body += `<div style="margin-top:16px"><div class="small muted" style="margin-bottom:8px">Часто добавляют к такому заказу</div><div class="stack" style="gap:8px">${recs.map((r) => { const it = this.menu.byId.get(r.id); return `<div class="rec" style="flex:none;width:100%" data-act="open-dish" data-id="${it.id}" role="button" tabindex="0">${dishArt(it, 'rec-art')}<div class="rec-main"><b>${esc(it.name)}</b><span>${esc(r.reason)} · ${money(it.price)}</span></div><button class="rec-add" data-act="add" data-id="${it.id}" aria-label="Добавить">${icon('plus')}</button></div>`; }).join('')}</div></div>`;
    }
    let foot = '';
    if (items.length && this.editable()) {
      if (!this.company) {
        foot = `<button class="btn btn-primary btn-lg btn-block" data-act="submit" data-scope="mine">${icon('utensils')}Отправить на кухню · <span class="price-tag">${money(st.cart.my_total)}</span></button>`;
      } else {
        const waiting = st.participants.filter((p) => !p.is_me && !p.ready && p.cart_count > 0);
        foot = `<div class="stack" style="gap:10px"><div class="ready-bar"><div class="grow"><b>${me.ready ? 'Вы готовы ✓' : 'Я всё выбрал(а)'}</b><span>${waiting.length ? 'Ещё выбирают: ' + esc(waiting.map((p) => p.name).join(', ')) : 'Все с позициями готовы'}</span></div><label class="switch"><input type="checkbox" id="ready-toggle" ${me.ready ? 'checked' : ''}><span class="track"></span><span class="sr-only">Я готов</span></label></div><div class="row"><button class="btn btn-ghost grow" data-act="submit" data-scope="mine" ${st.cart.my_count ? '' : 'disabled'}>Мои · ${st.cart.my_count}</button><button class="btn btn-primary grow" data-act="submit" data-scope="table">${icon('utensils')}Весь стол · ${money(st.cart.total)}</button></div></div>`;
      }
    }
    return { body, foot };
  },
  ringSvg() {
    const people = this.st.participants;
    const n = people.length;
    const cx = 170; const cy = 158; const R = 118;
    const seats = people.map((p, i) => {
      const a = (-90 + (360 / Math.max(n, 1)) * i) * Math.PI / 180;
      const x = cx + R * Math.cos(a); const y = cy + R * Math.sin(a);
      const stroke = p.ready ? '#20b26b' : p.online ? p.color : '#b8c3bb';
      return `<g class="seat" transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><circle r="25" fill="${p.online ? '#fff' : '#f1f4f0'}"/><circle r="25" class="seat-ring" stroke="${stroke}" ${p.online ? '' : 'stroke-dasharray="4 4"'}/><text class="seat-emoji" text-anchor="middle" dy="8" ${p.online ? '' : 'opacity=".5"'}>${esc(p.avatar)}</text><text class="seat-name" text-anchor="middle" y="${y > cy + 20 ? 44 : -34}">${esc(p.is_me ? 'Вы' : p.name.length > 10 ? p.name.slice(0, 9) + '…' : p.name)}${p.ready ? ' ✓' : ''}</text>${p.cart_count ? `<g transform="translate(19,-19)"><circle r="10" fill="#0e6b57"/><text text-anchor="middle" dy="4" font-size="11" font-weight="800" fill="#fff">${p.cart_count}</text></g>` : ''}</g>`;
    }).join('');
    const total = this.st.cart.total + this.st.bill.grand_total;
    const readyCount = people.filter((p) => p.ready).length;
    return `<svg class="ring-svg" viewBox="0 0 340 330" role="img" aria-label="Стол: ${n} участников"><circle cx="${cx}" cy="${cy}" r="82" class="table-top"/><circle cx="${cx}" cy="${cy}" r="66" class="table-inner"/><text x="${cx}" y="${cy - 2}" text-anchor="middle" class="center-sum">${esc(money(total))}</text><text x="${cx}" y="${cy + 20}" text-anchor="middle" class="center-sub">${esc(pl(n, 'гость', 'гостя', 'гостей'))} · готовы ${readyCount}</text>${seats}</svg>`;
  },
  deadlineCard() {
    const s = this.st.session;
    if (s.kind !== 'table' || s.status !== 'open') return '';
    if (!s.deadline_at) return `<div class="deadline-card"><span style="font-size:22px">⏱️</span><div class="grow"><b>Ограничено время?</b><span>Скажите, к которому часу нужно уйти — кухня увидит срочность</span></div><button class="btn btn-ghost btn-sm" data-act="deadline">Указать</button></div>`;
    const deadline = new Date(s.deadline_at).getTime();
    const active = this.st.orders.filter((o) => ['submitted', 'accepted', 'cooking'].includes(o.status));
    const etaMs = Math.max(0, ...active.map((o) => (o.eta_at ? new Date(o.eta_at).getTime() : clock.now() + (o.eta_predicted || 15) * 60000)));
    let cls = 'ok'; let text = 'Успеваете: заказ будет готов заранее';
    if (!active.length) text = 'Кухня видит, к которому часу вам нужно уйти';
    else if (etaMs > deadline) { cls = 'late'; text = 'Не успеваем к этому времени — позовите официанта, подскажем быстрые блюда'; }
    else if (deadline - etaMs < 10 * 60000) { cls = 'risk'; text = 'Впритык — меньше 10 минут запаса'; }
    return `<div class="deadline-card ${cls}"><span style="font-size:22px">⏱️</span><div class="grow"><b>Уйти к ${timeHM(s.deadline_at)} · осталось <span data-left="${esc(s.deadline_at)}"></span></b><span>${esc(text)}</span></div><button class="btn btn-ghost btn-sm" data-act="deadline">Изменить</button></div>`;
  },
  companyPanel() {
    const st = this.st;
    const s = st.session;
    let body = `<div class="ring-wrap">${this.ringSvg()}</div>`;
    body += `<div class="invite-card"><img src="${esc(s.qr_url)}" alt="QR для приглашения" width="92" height="92"><div class="grow"><b>${s.kind === 'office' ? 'Позовите коллег' : 'Позовите друзей за стол'}</b><span>${s.kind === 'office' ? 'Отправьте ссылку в рабочий чат' : 'Пусть отсканируют QR на столе или откроют ссылку'}</span><button class="btn btn-saffron btn-sm" data-act="invite">${icon('share', 'ic-sm')}Пригласить</button></div></div>`;
    body += '<div class="people">' + st.participants.map((p) => {
      const lines = st.cart.items.filter((c) => c.participant_id === p.id || c.shared_with.includes(p.id));
      const statusBadge = { paid: '<span class="badge ok">Оплачено ✓</span>', pending: '<span class="badge caution">Оплата в процессе</span>', partial: '<span class="badge caution">Частично</span>', unpaid: '<span class="badge">Не оплачено</span>', empty: '' }[p.bill_status] || '';
      return `<div class="pcard ${p.is_me ? 'me' : ''}"><div class="pcard-head">${avatar(p, '', { offline: !p.online, dot: p.online && !p.is_me })}<div class="grow"><b>${esc(p.name)}${p.is_me ? ' (вы)' : ''}${p.role === 'host' ? ' · хозяин' : ''}</b><span>${p.online ? (p.ready ? 'выбрал(а) и готов(а) ✓' : 'в сети') : 'не в сети'}</span></div>${statusBadge}</div>${p.viewing && !p.is_me && p.online ? `<span class="viewing">${icon('eye', 'ic-sm')}<span>${p.viewing.kind === 'dish' ? 'Смотрит ' + esc(p.viewing.emoji || '') + ' ' + esc(p.viewing.label) : p.viewing.kind === 'search' ? 'Ищет «' + esc(p.viewing.label) + '»' : 'Смотрит ' + esc(p.viewing.label)}</span></span>` : ''}${lines.length ? `<div class="pcard-items">${lines.map((c) => `<span class="${c.participant_id !== p.id ? 'shared' : ''}">${esc(c.emoji)} ${esc(c.name)}${c.qty > 1 ? ' ×' + c.qty : ''}${c.participant_id !== p.id ? ' · общее' : ''}</span>`).join('')}</div>` : ''}${p.allergens.length ? `<div class="pcard-items">${p.allergens.map((a) => `<span style="background:var(--pome-soft);color:var(--pome-deep)">${Data.allergen(a).icon} без: ${esc(Data.allergen(a).short)}</span>`).join('')}</div>` : ''}<div class="pcard-foot"><span>${pl(p.cart_count, 'позиция', 'позиции', 'позиций')} в корзине</span>${p.cart_kcal ? `<span>· ${fmt0(p.cart_kcal)} ккал</span>` : ''}<span class="sum">${money(p.cart_total + p.bill_total)}</span></div></div>`;
    }).join('') + '</div>';
    body += `<div style="margin-top:14px">${this.deadlineCard()}</div>`;
    if (this.feed.length) body += `<div style="margin-top:16px"><div class="small muted">Что происходит за столом</div><div class="feed">${this.feed.slice(0, 12).map((f) => `<div class="feed-item"><time>${timeHM(f.at)}</time><span>${esc(f.text)}</span></div>`).join('')}</div></div>`;
    return { body, foot: '' };
  },
  ordersPanel() {
    const st = this.st;
    const s = st.session;
    let body = this.deadlineCard();
    if (body) body = `<div style="margin-bottom:12px">${body}</div>`;
    if (!st.orders.length) {
      body += `<div class="empty"><div class="empty-art">👨‍🍳</div><h3>Заказов пока нет</h3><p>Соберите корзину и отправьте на кухню — здесь появится живой статус и таймер готовности.</p>${st.cart.count ? `<button class="btn btn-primary" data-act="side-tab" data-panel="cart">${icon('bag')}К корзине · ${st.cart.count}</button>` : ''}</div>`;
    } else {
      const waiting = st.orders.filter((o) => ['submitted', 'accepted', 'cooking'].includes(o.status));
      if (waiting.length) body += `<button class="game-card" data-act="game"><span class="game-card-art" aria-hidden="true">🍳🎯</span><span class="grow"><b>Пока готовится — поиграйте</b><span>Ловите ингредиенты своего заказа и не берите то, на что у вас аллергия</span></span>${icon('right')}</button>`;
      body += [...st.orders].reverse().map((o) => this.orderCard(o)).join('');
    }
    const foot = s.kind === 'table' && s.status !== 'closed' ? `<button class="btn btn-ghost btn-block" data-act="waiter">${icon('bell')}Позвать официанта</button>` : '';
    return { body, foot };
  },
  orderCard(o) {
    const idx = STATUS_INDEX[o.status] ?? -1;
    const num = String(o.number).padStart(3, '0');
    let eta;
    if (o.status === 'submitted') eta = `<div class="eta-box wait"><div class="eta-num">${icon('clock', 'ic-lg')}</div><div class="eta-sub"><b>Ждём, когда кухня примет заказ</b>Обычно готовим ≈ ${o.eta_predicted || 15} мин после принятия</div></div>`;
    else if (o.status === 'accepted' || o.status === 'cooking') eta = `<div class="eta-box"><div class="eta-num" data-countdown="${esc(o.eta_at)}">--:--</div><div class="eta-sub"><b>${o.status === 'cooking' ? 'Готовится' : 'Принят кухней'} · будет к ${timeHM(o.eta_at)}</b>Готово ${o.items_done} из ${o.items_total} позиций</div></div>`;
    else if (o.status === 'ready') eta = `<div class="eta-box done"><div class="eta-num">${icon('bell', 'ic-lg')}</div><div class="eta-sub"><b>Готов — официант несёт к ${s_or(this.st)}</b>Приготовлен в ${timeHM(o.ready_at)}</div></div>`;
    else if (o.status === 'served') eta = `<div class="eta-box done" style="background:var(--surface-3);color:var(--ink)"><div class="eta-num" style="color:var(--ok)">${icon('check', 'ic-lg')}</div><div class="eta-sub" style="color:var(--muted)"><b style="color:var(--ink)">Подан в ${timeHM(o.served_at)}</b>Приятного аппетита!</div></div>`;
    else eta = `<div class="notice danger">${icon('alert')}<span>Заказ отменён: ${esc(o.cancel_reason || 'рестораном')}</span></div>`;
    const timeline = o.status === 'cancelled' ? '' : `<div class="timeline" aria-label="Статус: ${esc(o.label)}">${STEP_LABELS.map(([k, label], i) => `<div class="tl-step ${i < idx || (i === idx && (k === 'served' || k === 'ready')) ? 'done' : i === idx ? 'now' : ''}"><i></i><span>${label}</span></div>`).join('')}</div>`;
    const items = o.items.map((it) => {
      const st = it.status === 'cancelled' ? `<span class="badge danger" title="${esc(it.cancel_reason)}">отменено</span>` : it.status === 'ready' || it.status === 'served' ? `<span class="badge ok">${icon('check', 'ic-sm')}</span>` : it.status === 'cooking' ? '<span class="badge caution">готовится</span>' : '';
      return `<div class="oi ${it.status === 'cancelled' ? 'cancelled' : ''}"><span>${esc(it.emoji)}</span><span class="oi-name">${it.qty > 1 ? it.qty + ' × ' : ''}${esc(it.name)}${this.company ? ` <span class="muted small">· ${esc(it.participant_id === this.me.id ? 'вы' : it.participant_name)}</span>` : ''}</span>${st}</div>${it.status === 'cancelled' && it.cancel_reason ? `<div class="tiny muted" style="padding-left:28px">${esc(it.cancel_reason)} — сумма снята со счёта</div>` : ''}`;
    }).join('');
    const mine = o.items.some((it) => it.participant_id === this.me.id && it.status !== 'cancelled');
    return `<div class="order ${o.status === 'ready' ? 'is-ready' : ''} ${o.status === 'cancelled' ? 'is-cancelled' : ''}"><div class="order-head"><div><b>Заказ №${num}</b>${o.batch > 1 ? ' <span class="badge sky">дозаказ</span>' : ''}<br><span>${timeHM(o.created_at)} · отправил(а) ${esc(o.submitted_by_name || 'гость')}</span></div><span class="badge ${o.status === 'ready' ? 'ok' : o.status === 'cancelled' ? 'danger' : 'ink'}">${esc(o.short)}</span></div>${eta}${timeline}<div class="order-items">${items}</div>${o.status === 'served' && mine && this.editable() ? `<button class="btn btn-soft btn-sm" data-act="repeat" data-order="${o.id}">${icon('refresh', 'ic-sm')}Повторить мои блюда</button>` : ''}</div>`;
  },
  billPanel() {
    const st = this.st;
    const b = st.bill;
    const me = this.me;
    const meRow = b.participants.find((r) => r.participant_id === me.id) || { due: 0, total: 0, paid: 0, overpaid: 0, lines: [] };
    let body = '';
    if (!b.grand_total) {
      body = `<div class="empty"><div class="empty-art">🧾</div><h3>Счёт пока пуст</h3><p>Счёт появится, когда заказ уйдёт на кухню. Каждый оплатит только свои блюда, общие — делятся поровну до тиына.</p>${st.cart.count ? `<button class="btn btn-soft" data-act="side-tab" data-panel="cart">В корзине ${money(st.cart.total)} — отправить</button>` : ''}</div>`;
      return { body, foot: '' };
    }
    const paidPct = Math.min(100, (b.paid_total / b.grand_total) * 100);
    const pendPct = Math.min(100 - paidPct, (b.pending_total / b.grand_total) * 100);
    body += `<div class="bill-hero"><div class="bh-top"><div><span>${this.company ? 'Счёт стола' : 'Ваш счёт'}</span><b>${money(b.grand_total)}</b></div><div style="text-align:right"><span>Осталось</span><b style="font-size:20px">${money(b.due_total)}</b></div></div><div class="paybar" role="img" aria-label="Оплачено ${Math.round(paidPct)}%"><i class="paid" style="width:${paidPct}%"></i><i class="pend" style="width:${pendPct}%"></i></div><div class="bh-legend"><span><i style="background:#34d399"></i>оплачено ${money(b.paid_total)}</span>${b.pending_total ? `<span><i style="background:var(--saffron)"></i>в процессе ${money(b.pending_total)}</span>` : ''}<span>блюда ${money(b.items_total)} + обслуживание ${money(b.service_total)}</span></div></div>`;
    const rows = this.company ? [meRow, ...b.participants.filter((r) => r.participant_id !== me.id)] : [meRow];
    body += '<div class="bill-rows">' + rows.filter((r) => r.total > 0 || r.paid > 0).map((r) => {
      const p = this.person(r.participant_id);
      const chip = { paid: '<span class="badge ok">оплачено ✓</span>', pending: '<span class="badge caution">ожидает</span>', partial: '<span class="badge caution">частично</span>', unpaid: '<span class="badge">не оплачено</span>' }[r.status] || '';
      const lines = r.lines.map((l) => `<div class="bill-line"><span>${esc(l.emoji)} ${esc(l.name)}${l.qty > 1 ? ' ×' + l.qty : ''}${l.shared_count > 1 ? ` <span class="muted">· 1/${l.shared_count}</span>` : ''}</span><span>${money(l.amount)}</span></div>`).join('');
      return `<div class="bill-row ${r.participant_id === me.id ? 'me open' : ''}"><button class="bill-row-head" data-act="toggle-bill-row" aria-expanded="${r.participant_id === me.id}">${avatar(p, 'sm')}<div class="grow"><b>${esc(p.is_me ? 'Вы' : p.name)}</b><span>${r.due ? 'к оплате ' + money(r.due) : r.overpaid ? 'переплата ' + money(r.overpaid) + ' — вернёт официант' : 'всё закрыто'}</span></div><div class="amt">${money(r.total)}<br>${chip}</div></button><div class="bill-row-body">${lines}<div class="bill-line"><span>Обслуживание ${fmt1(st.session.service_percent)}%</span><span>${money(r.service)}</span></div>${r.paid ? `<div class="bill-line"><span>Оплачено</span><span>−${money(r.paid)}</span></div>` : ''}</div></div>`;
    }).join('') + '</div>';
    const pending = st.payments.filter((p) => p.payer_id === me.id && ['pending', 'awaiting_cash'].includes(p.status));
    if (pending.length) body += `<div class="stack" style="margin-top:14px;gap:8px">${pending.map((p) => `<div class="notice actions">${icon('clock')}<span>${p.status === 'awaiting_cash' ? `Ждём официанта: наличные ${money(p.amount + p.tip)}` : `Оплата ${esc(p.method_title)} на ${money(p.amount + p.tip)} не подтверждена`}</span>${p.status === 'pending' ? `<button class="btn btn-sm btn-primary" data-act="resume-pay" data-pay="${p.id}">Продолжить</button>` : ''}<button class="btn btn-sm btn-ghost" data-act="cancel-pay" data-pay="${p.id}">Отменить</button></div>`).join('')}</div>`;
    const paidList = st.payments.filter((p) => p.status === 'paid');
    if (paidList.length) body += `<div style="margin-top:16px"><div class="small muted" style="margin-bottom:6px">Оплаты</div>${paidList.map((p) => `<div class="bill-line"><span>${p.kind === 'refund' ? '↩ Возврат' : esc(p.payer_name)} · ${esc(p.method_title)}${p.tip ? ' · чаевые ' + money(p.tip) : ''}</span><span>${money(p.amount + p.tip)}</span></div>`).join('')}</div>`;
    const othersDue = b.participants.filter((r) => r.participant_id !== me.id && r.due > 0);
    let foot;
    if (meRow.due > 0) foot = `<div class="stack" style="gap:8px"><button class="btn btn-primary btn-lg btn-block" data-act="pay" data-for="me">${icon('card')}Оплатить мою часть · <span class="price-tag">${money(meRow.due)}</span></button>${othersDue.length ? `<button class="btn btn-ghost btn-block" data-act="pay" data-for="others">${icon('heart')}Оплатить и за других</button>` : ''}</div>`;
    else if (othersDue.length) foot = `<div class="stack" style="gap:8px"><div class="notice ok">${icon('check')}<span>Ваша часть оплачена</span></div><button class="btn btn-ghost btn-block" data-act="pay" data-for="others">${icon('heart')}Угостить: оплатить за других</button></div>`;
    else foot = `<div class="stack" style="gap:8px"><div class="notice ok">${icon('check')}<span>${b.due_total || b.pending_total ? 'Ваша часть закрыта' : 'Счёт стола полностью оплачен'}</span></div><button class="btn btn-ghost btn-block" data-act="receipt">${icon('receipt')}Электронный чек</button></div>`;
    return { body, foot };
  },

  renderClosed() {
    this.stop();
    const st = this.st;
    const b = st.bill;
    const me = st.me;
    APP.innerHTML = `<header class="topbar"><div class="topbar-in">${brandHtml(Data.config.restaurant.name)}</div></header><main class="closed-screen" id="main"><div class="card card-pad stack" style="gap:16px;text-align:center"><div class="success-burst"><div class="tick">${icon('check')}</div></div><h1 style="font-size:26px">Спасибо, что были у нас!</h1><p class="muted">${esc(st.session.title || 'Стол')} закрыт${st.session.closed_at ? ' в ' + timeHM(st.session.closed_at) : ''}. ${b.grand_total ? `Счёт стола — ${money(b.grand_total)}.` : ''}</p>${me && b.grand_total ? `<div class="notice ok" style="text-align:left">${icon('receipt')}<span>Ваша часть: ${money((b.participants.find((r) => r.participant_id === me.id) || {}).total || 0)}</span></div>` : ''}<div class="row" style="justify-content:center;flex-wrap:wrap">${b.grand_total ? `<button class="btn btn-ghost" data-act="receipt">${icon('receipt')}Электронный чек</button>` : ''}${this.kind === 'table' ? `<button class="btn btn-primary" data-act="new-visit">${icon('table')}Новый заказ за этим столом</button>` : '<a class="btn btn-primary" href="/" data-link>На главную</a>'}</div></div></main>`;
    this.active = true;
  },
};
const s_or = (st) => (st.session.kind === 'office' ? 'выдаче' : 'вашему столу');

Object.assign(Guest, {
  setView(view, panel) {
    this.view = view;
    if (panel) this.panel = panel;
    const app = qs('.g-app');
    if (app) app.dataset.view = view;
    this.renderSide();
    this.renderNav();
    if (window.innerWidth <= 900) window.scrollTo({ top: 0 });
    this.presence(view === 'menu' ? 'category' : 'tab', view === 'menu' ? this.activeCat : this.panel);
  },
  conflictsFor(item, choices, sharedIds) {
    const { contains, traces } = effectiveAllergens(item, choices);
    const out = [];
    const ids = [this.me.id, ...sharedIds];
    for (const id of ids) {
      const p = this.person(id);
      if (!p) continue;
      const lv = levelFor(contains, traces, p.allergens || []);
      if (lv.level === 'danger') out.push({ name: p.is_me ? 'вас' : p.name, codes: lv.danger });
    }
    return out;
  },
  async addToCart(item, { qty = 1, options = {}, note = '', shared = [], choices = defaultChoices(item), confirmDanger = true } = {}) {
    if (!item.available) throw new ApiError(409, 'off', `«${item.name}» сейчас закончилось`);
    const conflicts = this.conflictsFor(item, choices, shared);
    if (conflicts.length && confirmDanger) {
      const ok = await confirmBox({ title: 'В блюде есть аллерген', html: `<div class="notice danger">${icon('alert')}<span>«${esc(item.name)}» содержит: ${conflicts.map((c) => `<b>${esc(allergenNames(c.codes))}</b> — опасно для ${esc(c.name)}`).join('; ')}.</span></div><p class="muted small" style="margin-top:10px">Если всё равно добавить — кухня увидит пометку об аллергии в заказе.</p>`, ok: 'Всё равно добавить', danger: true });
      if (!ok) return false;
    }
    await this.mutate('POST', '/cart', { menu_item_id: item.id, qty, options, note, shared_with: shared });
    toast(`Добавлено: ${item.name}`, 'success', { ms: 1800 });
    qsa('#g-nav .bn-badge, #g-side-tabs .count').forEach((b) => { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); });
    return true;
  },
  dishSheet(id) {
    const item = this.menu.byId.get(Number(id));
    if (!item) return;
    this.presence('dish', item.id);
    const sel = {};
    for (const g of item.options) sel[g.id] = g.type === 'single' && g.required ? [g.choices[0].id] : [];
    const state = { qty: 1, shared: [] };
    const others = this.company ? this.st.participants.filter((p) => !p.is_me) : [];
    const chosen = () => item.options.flatMap((g) => g.choices.filter((c) => sel[g.id].includes(c.id)).map((c) => ({ group_id: g.id, group: g.name, ...c })));
    const totals = () => {
      const ch = chosen();
      const sum = (key) => Math.max(0, (item[key] || 0) + ch.reduce((s, c) => s + (c[key] || 0), 0));
      return { price: item.price + ch.reduce((s, c) => s + c.price, 0), kcal: Math.round(sum('kcal')), protein: sum('protein'), fat: sum('fat'), carbs: sum('carbs'), weight: Math.round(sum('weight_g')), ...effectiveAllergens(item, ch) };
    };
    const verdict = (t) => {
      const lv = levelFor(t.contains, t.traces, this.profile);
      if (lv.level === 'danger') return `<div class="notice danger">${icon('alert')}<span><b>Содержит ${esc(allergenNames(lv.danger))}</b> — это есть в вашем профиле. Лучше выбрать другое блюдо или уточнить у официанта.</span></div>`;
      if (lv.level === 'caution') return `<div class="notice">${icon('alert')}<span>Возможны следы: <b>${esc(allergenNames(lv.caution))}</b>. При сильной аллергии уточните у официанта.</span></div>`;
      if (lv.level === 'safe') return `<div class="notice ok">${icon('shield')}<span>Подходит под ваш профиль аллергий</span></div>`;
      return '';
    };
    const allergenBlock = (t) => {
      const chip = (c, kind) => `<span class="badge ${this.profile.includes(c) ? 'danger' : kind === 'traces' ? 'caution' : ''}">${Data.allergen(c).icon} ${esc(Data.allergen(c).name)}</span>`;
      return `${t.contains.length ? `<div class="small muted">Содержит</div><div class="allergen-list">${t.contains.map((c) => chip(c, 'contains')).join('')}</div>` : '<div class="badge ok">Аллергены из списка 14 не отмечены</div>'}${t.traces.length ? `<div class="small muted">Возможны следы</div><div class="allergen-list">${t.traces.map((c) => chip(c, 'traces')).join('')}</div>` : ''}`;
    };
    const delta = (now, base, digits = 0) => { const d = Math.round((now - base) * 10 ** digits) / 10 ** digits; return d ? `<i class="delta ${d < 0 ? 'down' : 'up'}">${d > 0 ? '+' : '−'}${digits ? fmt1(Math.abs(d)) : fmt0(Math.abs(d))}</i>` : ''; };
    const facts = (t) => `<div class="fact kcal"><b>${fmt0(t.kcal)}</b>${delta(t.kcal, item.kcal)}<span>ккал</span></div><div class="fact"><b>${fmt1(t.protein)}</b>${delta(t.protein, item.protein, 1)}<span>белки, г</span></div><div class="fact"><b>${fmt1(t.fat)}</b>${delta(t.fat, item.fat, 1)}<span>жиры, г</span></div><div class="fact"><b>${fmt1(t.carbs)}</b>${delta(t.carbs, item.carbs, 1)}<span>углев., г</span></div><div class="fact"><b>${t.weight || '—'}</b>${item.weight_g ? delta(t.weight, item.weight_g) : ''}<span>${item.category_code === 'drinks' || item.category_code === 'coffee' ? 'мл' : 'г'}</span></div>`;
    const shareChip = (p) => {
      const lv = levelFor(totals().contains, totals().traces, p.allergens || []);
      return `<button type="button" class="share-person ${state.shared.includes(p.id) ? 'on' : ''} ${lv.level === 'danger' ? 'warn' : ''}" data-act="ds-share" data-pid="${p.id}" aria-pressed="${state.shared.includes(p.id)}" ${lv.level === 'danger' ? `title="Опасно для ${esc(p.name)}: ${esc(allergenNames(lv.danger))}"` : ''}>${avatar(p, 'xs')}${esc(p.name)}${lv.level === 'danger' ? ' ⚠' : ''}</button>`;
    };
    const optionCard = (g, c) => {
      const on = sel[g.id].includes(c.id);
      const extra = [c.price ? (c.price > 0 ? '+' : '−') + money(Math.abs(c.price)) : '', c.kcal ? (c.kcal > 0 ? '+' : '−') + Math.abs(c.kcal) + ' ккал' : '', c.weight_g ? (c.weight_g > 0 ? '+' : '−') + Math.abs(c.weight_g) + ' г' : ''].filter(Boolean).join(' · ');
      const alg = [...(c.add_allergens || []).map((a) => '+' + Data.allergen(a).short), ...(c.remove_allergens || []).map((a) => 'без ' + Data.allergen(a).short)].join(', ');
      return `<button type="button" class="check-card ${g.type === 'single' ? 'radio' : ''} ${on ? 'on' : ''}" data-act="ds-opt" data-g="${esc(g.id)}" data-c="${esc(c.id)}" role="${g.type === 'single' ? 'radio' : 'checkbox'}" aria-checked="${on}"><span class="mark">${icon('check')}</span><span class="cc-main"><span class="cc-title">${esc(c.name)}</span>${extra || alg ? `<span class="cc-sub">${esc([extra, alg].filter(Boolean).join(' · '))}</span>` : ''}</span></button>`;
    };
    const t0 = totals();
    const lv0 = levelFor(item.allergens, item.traces, this.profile);
    const badges = [lv0.level === 'danger' ? `<span class="badge danger">⚠ ${esc(allergenNames(lv0.danger))}</span>` : '', item.popular ? '<span class="badge white">⭐ Хит</span>' : '', item.new ? '<span class="badge saffron">Новинка</span>' : '', ...item.diets.map((d) => `<span class="badge white">${Data.diet(d).icon} ${esc(Data.diet(d).name)}</span>`)].join('');
    const body = `${dishArt(item, 'dish-hero', `<div class="dish-badges">${badges}</div>`)}
      <div class="row-between" style="align-items:flex-start"><div><div class="num" style="font-size:24px;font-weight:600">${money(item.price)}</div><div class="small muted">${item.weight_g ? item.weight_g + (item.category_code === 'drinks' || item.category_code === 'coffee' ? ' мл · ' : ' г · ') : ''}готовим ≈ ${item.cook_minutes} мин · ${esc(item.category_name)}</div></div>${this.company ? `<span id="ds-watch">${(() => { const w = this.watchers(item.id); return w ? `<span class="viewing">${avatarStack(w.people, 2, 'xs')}<span>${esc(w.text)}</span></span>` : ''; })()}</span>` : ''}</div>
      <p style="margin-top:10px">${esc(item.description)}</p>
      <div class="sheet-section" style="margin-top:16px"><h3>Пищевая ценность на порцию</h3><div class="facts" id="ds-facts">${facts(t0)}</div><div class="daily" id="ds-daily">≈ ${Math.round((t0.kcal / 2000) * 100)}% дневной нормы при 2000 ккал</div></div>
      <div class="sheet-section"><h3>Аллергены</h3><div id="ds-verdict">${verdict(t0)}</div><div class="stack" style="gap:8px" id="ds-allergens">${allergenBlock(t0)}</div><p class="tiny muted">Состав указан рестораном. При тяжёлой аллергии обязательно предупредите официанта: перекрёстный контакт на кухне возможен.</p></div>
      ${item.ingredients.length ? `<div class="sheet-section"><h3>Состав</h3><div class="ingredients">${item.ingredients.map((i) => `<span>${esc(i)}</span>`).join('')}</div></div>` : ''}
      ${item.available && this.editable() ? `${item.options.map((g) => `<div class="sheet-section opt-group"><div class="opt-group-head"><b>${esc(g.name)}</b><span>${g.id === 'without' ? 'КБЖУ и выход пересчитаются сразу' : g.type === 'single' ? (g.required ? 'выберите один' : 'один на выбор') : `до ${g.max} на выбор`}</span></div><div class="opt-list">${g.choices.map((c) => optionCard(g, c)).join('')}</div></div>`).join('')}
      ${others.length ? `<div class="sheet-section"><h3>Разделить с компанией</h3><p class="small muted">Стоимость поделится поровну до тиына — каждый увидит свою долю в счёте.</p><div class="share-list" id="ds-share">${others.map(shareChip).join('')}</div></div>` : ''}
      <div class="sheet-section"><h3>Комментарий повару</h3><textarea class="textarea" id="ds-note" maxlength="200" placeholder="Например: без кинзы, соус отдельно, подать вместе с супом"></textarea></div>` : ''}`;
    const footHtml = () => {
      if (!item.available) return '<div class="notice grow">Блюдо закончилось — загляните в похожие позиции</div>';
      if (!this.editable()) return '<div class="notice grow">Приём заказов закрыт</div>';
      const t = totals();
      const danger = this.conflictsFor(item, chosen(), state.shared).length;
      return `<div class="stepper"><button data-act="ds-qty" data-d="-1" ${state.qty <= 1 ? 'disabled' : ''} aria-label="Меньше">${icon('minus', 'ic-sm')}</button><span class="val" id="ds-qty">${state.qty}</span><button data-act="ds-qty" data-d="1" aria-label="Больше">${icon('plus', 'ic-sm')}</button></div><button class="btn ${danger ? 'btn-danger' : 'btn-primary'} grow" data-act="ds-add">${icon('plus')}Добавить · <span class="price-tag">${money(t.price * state.qty)}</span></button>`;
    };
    const refresh = (sheet) => {
      const t = totals();
      qs('#ds-facts', sheet.el).innerHTML = facts(t);
      qs('#ds-daily', sheet.el).textContent = `≈ ${Math.round((t.kcal / 2000) * 100)}% дневной нормы при 2000 ккал`;
      qs('#ds-verdict', sheet.el).innerHTML = verdict(t);
      qs('#ds-allergens', sheet.el).innerHTML = allergenBlock(t);
      const sh = qs('#ds-share', sheet.el);
      if (sh) sh.innerHTML = others.map(shareChip).join('');
      sheet.setFoot(footHtml());
    };
    openSheet({
      title: item.name, size: 'lg', body, foot: footHtml(),
      onClose: () => this.presence(this.view === 'menu' ? 'category' : 'tab', this.view === 'menu' ? this.activeCat : this.panel),
      actions: {
        'ds-opt'(el, e, sheet) {
          const g = item.options.find((x) => x.id === el.dataset.g);
          const cid = el.dataset.c;
          if (g.type === 'single') sel[g.id] = (sel[g.id][0] === cid && !g.required) ? [] : [cid];
          else if (sel[g.id].includes(cid)) sel[g.id] = sel[g.id].filter((x) => x !== cid);
          else if (sel[g.id].length < g.max) sel[g.id] = [...sel[g.id], cid];
          else { toast(`В «${g.name}» можно выбрать не больше ${g.max}`, 'warn'); return; }
          qsa(`[data-act="ds-opt"][data-g="${CSS.escape(g.id)}"]`, sheet.el).forEach((b) => { const on = sel[g.id].includes(b.dataset.c); b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
          refresh(sheet);
        },
        'ds-share'(el, e, sheet) { toggleIn(state.shared, el.dataset.pid); refresh(sheet); },
        'ds-qty'(el, e, sheet) { state.qty = Math.max(1, Math.min(Data.config.limits.max_qty, state.qty + Number(el.dataset.d))); sheet.setFoot(footHtml()); },
        async 'ds-add'(el, e, sheet) {
          const note = qs('#ds-note', sheet.el);
          await busy(el, async () => {
            const ok = await Guest.addToCart(item, { qty: state.qty, options: sel, note: note ? note.value.trim() : '', shared: state.shared, choices: chosen() });
            if (ok) sheet.close();
          });
        },
      },
    });
  },
  lineSheet(lineId) {
    const line = this.st.cart.items.find((c) => c.id === lineId);
    if (!line) return;
    const state = { qty: line.qty, shared: [...line.shared_with] };
    const others = this.company ? this.st.participants.filter((p) => !p.is_me) : [];
    const share = () => others.map((p) => `<button type="button" class="share-person ${state.shared.includes(p.id) ? 'on' : ''}" data-act="ls-share" data-pid="${p.id}" aria-pressed="${state.shared.includes(p.id)}">${avatar(p, 'xs')}${esc(p.name)}</button>`).join('');
    const foot = () => `<button class="btn btn-danger-soft" data-act="ls-remove">${icon('trash')}Удалить</button><button class="btn btn-primary grow" data-act="ls-save">Сохранить · ${money(line.unit_price * state.qty)}</button>`;
    openSheet({
      title: line.name,
      body: `<div class="stack"><div class="row">${dishArt(this.menu.byId.get(line.menu_item_id) || line, 'line-art')}<div class="grow"><b>${esc(line.name)}</b><div class="small muted">${esc(line.options.map((o) => o.choice).join(', ') || 'Без модификаторов')} · ${money(line.unit_price)}</div></div></div><div class="row-between"><span class="label">Количество</span><div class="stepper"><button data-act="ls-qty" data-d="-1" aria-label="Меньше">${icon('minus', 'ic-sm')}</button><span class="val" id="ls-qty">${state.qty}</span><button data-act="ls-qty" data-d="1" aria-label="Больше">${icon('plus', 'ic-sm')}</button></div></div><label class="field"><span class="label">Комментарий повару</span><textarea class="textarea" id="ls-note" maxlength="200">${esc(line.note)}</textarea></label>${others.length ? `<div class="field"><span class="label">Разделить с</span><div class="share-list" id="ls-share">${share()}</div><span class="hint">Сумма делится поровну, каждый увидит свою долю.</span></div>` : ''}<p class="tiny muted">Чтобы поменять модификаторы, удалите позицию и добавьте блюдо заново.</p></div>`,
      foot: foot(),
      actions: {
        'ls-qty'(el, e, sheet) { state.qty = Math.max(1, Math.min(Data.config.limits.max_qty, state.qty + Number(el.dataset.d))); qs('#ls-qty', sheet.el).textContent = state.qty; sheet.setFoot(foot()); },
        'ls-share'(el, e, sheet) { toggleIn(state.shared, el.dataset.pid); qs('#ls-share', sheet.el).innerHTML = share(); },
        async 'ls-save'(el, e, sheet) { await busy(el, async () => { await Guest.mutate('PATCH', '/cart/' + line.id, { qty: state.qty, note: qs('#ls-note', sheet.el).value.trim(), shared_with: state.shared }); sheet.close(); toast('Позиция обновлена', 'success', { ms: 1600 }); }); },
        async 'ls-remove'(el, e, sheet) { await busy(el, async () => { await Guest.mutate('DELETE', '/cart/' + line.id); sheet.close(); toast(`Удалено: ${line.name}`, 'info', { ms: 1600 }); }); },
      },
    });
  },
  submitSheet(scope) {
    const st = this.st;
    const lines = scope === 'mine' ? st.cart.items.filter((c) => c.mine) : st.cart.items;
    if (!lines.length) { toast('В корзине нет ваших позиций', 'warn'); return; }
    const off = lines.filter((c) => c.unavailable);
    if (off.length) { toast(`Уберите закончившиеся блюда: ${off.map((c) => c.name).join(', ')}`, 'error'); this.setView(window.innerWidth <= 900 ? 'panel' : this.view, 'cart'); return; }
    const total = lines.reduce((s, c) => s + c.line_total, 0);
    const waiting = scope === 'table' ? st.participants.filter((p) => !p.is_me && !p.ready && p.cart_count > 0) : [];
    const idem = uid();
    const send = async (confirm, sheet, btn) => {
      try {
        const res = await this.mutate('POST', '/orders', { scope, confirm_allergens: confirm, kitchen_note: qs('#sub-note', sheet.el).value.trim() }, { idem: confirm ? idem + '-c' : idem });
        sheet.close();
        toast(`Заказ №${String(res.order.number).padStart(3, '0')} отправлен на кухню`, 'success', { icon: 'utensils' });
        this.setView(window.innerWidth <= 900 ? 'panel' : 'menu', 'orders');
      } catch (e) {
        if (e.code === 'allergen_confirmation_required') {
          const list = (e.details && e.details.conflicts) || [];
          const ok = await confirmBox({ title: 'Подтвердите аллергены', html: `<div class="notice danger">${icon('alert')}<span>В заказе есть блюда с аллергенами из профилей гостей:</span></div><div class="stack" style="gap:6px;margin-top:10px">${list.map((c) => `<div class="row"><span class="badge danger">⚠ ${esc(c.allergens.join(', '))}</span><span class="small"><b>${esc(c.item)}</b> — ${esc(c.participant)}</span></div>`).join('')}</div><p class="small muted" style="margin-top:10px">Повар увидит красную пометку на каждой такой позиции.</p>`, ok: 'Отправить с пометкой', danger: true });
          if (ok) await busy(btn, () => send(true, sheet, btn));
        } else throw e;
      }
    };
    openSheet({
      title: scope === 'table' ? 'Отправить заказ стола' : 'Отправить мой заказ',
      body: `<div class="stack"><div class="stack" style="gap:6px">${lines.map((c) => `<div class="row"><span>${esc(c.emoji)}</span><span class="grow ellipsis">${c.qty > 1 ? c.qty + ' × ' : ''}${esc(c.name)}${this.company ? ` <span class="muted small">· ${esc(c.mine ? 'вы' : this.nameOf(c.participant_id))}</span>` : ''}</span><span class="num small">${money(c.line_total)}</span></div>`).join('')}</div><hr class="divider"><div class="row-between"><b>Итого</b><b class="num">${money(total)}</b></div>${waiting.length ? `<div class="notice">${icon('clock')}<span>Ещё выбирают: ${esc(waiting.map((p) => p.name).join(', '))}. Их позиции из корзины тоже уйдут на кухню — или отправьте только свои.</span></div>` : ''}<label class="field"><span class="label">Комментарий для кухни</span><textarea class="textarea" id="sub-note" maxlength="200" placeholder="Например: подать всё одновременно, мы торопимся"></textarea></label><p class="tiny muted">Цены зафиксированы в момент добавления. Обслуживание ${fmt1(st.session.service_percent)}% добавится в счёт.</p></div>`,
      foot: `<button class="btn btn-ghost" data-close>Ещё выбираю</button><button class="btn btn-primary" data-act="sub-send">${icon('utensils')}Отправить на кухню</button>`,
      actions: { async 'sub-send'(el, e, sheet) { await busy(el, () => send(false, sheet, el)); } },
    });
  },
  paySheet(forWhom) {
    const st = this.st;
    const me = this.me;
    const rows = st.bill.participants.filter((r) => r.due > 0);
    if (!rows.length) { toast('Оплачивать нечего', 'info'); return; }
    const selected = new Set(forWhom === 'others' ? rows.map((r) => r.participant_id) : rows.filter((r) => r.participant_id === me.id).map((r) => r.participant_id));
    const state = { tip: 0, method: 'kaspi' };
    const amount = () => rows.filter((r) => selected.has(r.participant_id)).reduce((s, r) => s + r.due, 0);
    const tipAmount = () => (state.method === 'cash' ? 0 : Math.round((amount() * state.tip) / 100));
    const body = () => `<div class="sheet-section"><h3>За кого платите</h3><div class="stack" style="gap:8px">${rows.map((r) => { const p = this.person(r.participant_id); const on = selected.has(r.participant_id); return `<button type="button" class="check-card ${on ? 'on' : ''}" data-act="pay-who" data-pid="${r.participant_id}" role="checkbox" aria-checked="${on}"><span class="mark">${icon('check')}</span>${avatar(p, 'sm')}<span class="cc-main"><span class="cc-title">${esc(p.is_me ? 'Моя часть' : p.name)}</span><span class="cc-sub">${r.lines.length} ${plural(r.lines.length, 'позиция', 'позиции', 'позиций')} + обслуживание</span></span><span class="cc-side">${money(r.due)}</span></button>`; }).join('')}</div></div>
      <div class="sheet-section"><h3>Чаевые официанту</h3><div class="seg block">${Data.config.tip_presets.map((t) => `<button type="button" data-act="pay-tip" data-pct="${t}" class="${state.tip === t ? 'on' : ''}" ${state.method === 'cash' ? 'disabled' : ''}>${t ? t + '%' : 'Без чаевых'}</button>`).join('')}</div>${state.method === 'cash' ? '<span class="hint">Наличные чаевые можно оставить официанту лично</span>' : ''}</div>
      <div class="sheet-section"><h3>Способ оплаты</h3><div class="stack" style="gap:8px"><button type="button" class="pay-method ${state.method === 'kaspi' ? 'on' : ''}" data-act="pay-method" data-m="kaspi"><span class="pm-ic pm-kaspi">K</span><span class="grow"><b>Kaspi QR</b><span>Сканируете QR в приложении Kaspi.kz</span></span></button><button type="button" class="pay-method ${state.method === 'card' ? 'on' : ''}" data-act="pay-method" data-m="card"><span class="pm-ic pm-card">${icon('card')}</span><span class="grow"><b>Банковская карта</b><span>Visa, Mastercard, Apple Pay</span></span></button><button type="button" class="pay-method ${state.method === 'cash' ? 'on' : ''}" data-act="pay-method" data-m="cash"><span class="pm-ic pm-cash">${icon('cash')}</span><span class="grow"><b>Наличными официанту</b><span>Официант получит уведомление и подойдёт</span></span></button></div></div>
      <div class="totals" style="margin-top:16px"><div class="t-row"><span>К оплате</span><span>${money(amount())}</span></div>${tipAmount() ? `<div class="t-row"><span>Чаевые ${state.tip}%</span><span>${money(tipAmount())}</span></div>` : ''}<div class="t-row t-big"><span>Итого</span><span>${money(amount() + tipAmount())}</span></div></div>`;
    const foot = () => `<button class="btn btn-primary btn-lg btn-block" data-act="pay-go" ${amount() ? '' : 'disabled'}>${state.method === 'cash' ? icon('cash') + 'Позвать официанта за наличными' : icon('lock') + 'Оплатить · <span class="price-tag">' + money(amount() + tipAmount()) + '</span>'}</button>`;
    const redraw = (sheet) => { const sc = sheet.body.scrollTop; sheet.setBody(body()); sheet.body.scrollTop = sc; sheet.setFoot(foot()); };
    const idem = uid();
    openSheet({
      title: 'Оплата', body: body(), foot: foot(),
      actions: {
        'pay-who'(el, e, sheet) { const id = el.dataset.pid; if (selected.has(id)) selected.delete(id); else selected.add(id); redraw(sheet); },
        'pay-tip'(el, e, sheet) { state.tip = Number(el.dataset.pct); redraw(sheet); },
        'pay-method'(el, e, sheet) { state.method = el.dataset.m; redraw(sheet); },
        async 'pay-go'(el, e, sheet) {
          await busy(el, async () => {
            const res = await Guest.mutate('POST', '/payments', { beneficiaries: [...selected], method: state.method, tip_percent: state.method === 'cash' ? 0 : state.tip }, { idem });
            sheet.close();
            Guest.checkoutSheet(res.payment);
          });
        },
      },
    });
  },
  checkoutSheet(payment) {
    const total = payment.amount + payment.tip;
    const c = payment.checkout || {};
    if (payment.method === 'cash') {
      openSheet({ title: 'Наличными', size: 'sm', body: `<div class="stack" style="text-align:center;align-items:center"><div class="empty-art" style="width:72px;height:72px;border-radius:24px;background:var(--ok-soft);display:grid;place-items:center;font-size:34px">💵</div><h3 style="font-size:24px" class="num">${money(total)}</h3><p class="muted">Официант получил уведомление и подойдёт к столу. Когда он примет наличные, статус обновится у всех за столом.</p></div>`, foot: '<button class="btn btn-primary btn-block" data-close>Понятно</button>' });
      return;
    }
    const body = payment.method === 'kaspi'
      ? `<div class="checkout-qr"><img src="/api/qr.svg?text=${encodeURIComponent(c.payload || '')}" alt="QR для оплаты Kaspi" width="210" height="210"><b class="num" style="font-size:24px">${money(total)}</b><p class="small muted" style="text-align:center">Откройте Kaspi.kz → «Сканировать QR» и подтвердите платёж.</p></div><div class="notice info">${icon('info')}<span>${esc(c.hint || 'Демо-режим')}</span></div>`
      : `<div class="card-visual"><div class="row-between"><b>Foodbuster Pay</b><span>${icon('card')}</span></div><div class="cv-num">•••• •••• •••• 2026</div><div class="row-between"><span>${esc(Guest.me.name)}</span><b class="num">${money(total)}</b></div></div><div class="notice info" style="margin-top:14px">${icon('info')}<span>${esc(c.hint || 'Демо-режим')}</span></div>`;
    openSheet({
      title: c.title || 'Оплата', size: 'sm', body,
      foot: `<button class="btn btn-ghost" data-act="co-cancel">Отменить</button><button class="btn btn-primary" data-act="co-confirm">${icon('check')}${payment.method === 'kaspi' ? 'Я оплатил(а)' : 'Подтвердить оплату'}</button>`,
      actions: {
        async 'co-confirm'(el, e, sheet) {
          await busy(el, async () => {
            await Guest.mutate('POST', `/payments/${payment.payment_id}/confirm`);
            vibrate(60);
            sheet.setTitle('Оплачено');
            sheet.setBody(`<div class="stack" style="text-align:center;align-items:center"><div class="success-burst"><div class="tick">${icon('check')}</div></div><h3 class="num" style="font-size:28px">${money(total)}</h3><p class="muted">Платёж прошёл. Вся компания уже видит, что ваша часть закрыта.</p></div>`);
            sheet.setFoot(`<button class="btn btn-ghost" data-act="receipt">${icon('receipt')}Чек</button><button class="btn btn-primary" data-close>Готово</button>`);
          });
        },
        async 'co-cancel'(el, e, sheet) { await busy(el, async () => { await Guest.mutate('POST', `/payments/${payment.payment_id}/cancel`); sheet.close(); toast('Оплата отменена', 'info'); }); },
      },
    });
  },
  receiptHtml() {
    const st = this.st;
    const b = st.bill;
    const rows = b.participants.filter((r) => r.total > 0);
    const when = new Date(clock.now()).toLocaleString('ru-RU', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
    return `<div class="receipt"><div style="text-align:center"><b style="font-size:16px">${esc(Data.config.restaurant.name)}</b><div class="muted small">${esc(Data.config.restaurant.city)} · ${esc(st.session.title || '')} · ${esc(when)}</div><div class="muted tiny">Сессия ${esc(st.session.code)}</div></div><div class="r-sep"></div>${rows.map((r) => { const p = this.person(r.participant_id); return `<div class="r-line"><b>${esc(p ? p.name : 'Гость')}</b><b>${money(r.total)}</b></div>${r.lines.map((l) => `<div class="r-line"><span>${esc(l.name)}${l.qty > 1 ? ' ×' + l.qty : ''}${l.shared_count > 1 ? ' (1/' + l.shared_count + ')' : ''}</span><span>${money(l.amount)}</span></div>`).join('')}<div class="r-line muted"><span>Обслуживание</span><span>${money(r.service)}</span></div>`; }).join('<div class="r-sep"></div>')}<div class="r-sep"></div><div class="r-line"><span>Блюда</span><span>${money(b.items_total)}</span></div><div class="r-line"><span>Обслуживание ${fmt1(st.session.service_percent)}%</span><span>${money(b.service_total)}</span></div><div class="r-line"><b>Итого</b><b>${money(b.grand_total)}</b></div>${st.payments.filter((p) => p.status === 'paid').map((p) => `<div class="r-line muted"><span>${p.kind === 'refund' ? 'Возврат' : esc(p.payer_name) + ' · ' + esc(p.method_title)}${p.tip ? ' + чаевые ' + money(p.tip) : ''}</span><span>${p.kind === 'refund' ? '−' : ''}${money(p.amount + p.tip)}</span></div>`).join('')}<div class="r-line"><span>Осталось оплатить</span><span>${money(b.due_total)}</span></div><p class="tiny muted" style="margin-top:10px;text-align:center">НДС включён в стоимость блюд. Электронный чек сформирован Foodbuster.</p></div>`;
  },
});

Guest.actions = {
  game() {
    const st = Guest.st;
    const emojis = [...new Set(st.orders.filter((o) => ['submitted', 'accepted', 'cooking'].includes(o.status)).flatMap((o) => o.items.map((i) => i.emoji)))];
    const order = st.orders.filter((o) => o.eta_at && ['accepted', 'cooking'].includes(o.status)).sort((a, b) => (a.eta_at < b.eta_at ? 1 : -1))[0];
    WaitGame.open({ emojis, allergens: Guest.profile, etaAt: order ? order.eta_at : null });
  },
  nav(el) { const p = el.dataset.panel; if (p === 'menu') Guest.setView('menu'); else Guest.setView('panel', p); },
  'side-tab'(el) { Guest.setView(window.innerWidth <= 900 ? 'panel' : Guest.view, el.dataset.panel); },
  'go-panel'(el) { Guest.setView(window.innerWidth <= 900 ? 'panel' : Guest.view, el.dataset.panel); },
  filter(el) {
    const id = el.dataset.id;
    if (Guest.filters.has(id)) Guest.filters.delete(id); else Guest.filters.add(id);
    el.classList.toggle('on', Guest.filters.has(id));
    el.setAttribute('aria-pressed', Guest.filters.has(id));
    Guest.renderMenu();
  },
  'reset-filters'() { Guest.filters.clear(); Guest.hideDanger = false; Guest.q = ''; Guest.search = null; const s = qs('#g-search'); if (s) s.value = ''; qs('[data-act="search-clear"]').hidden = true; Guest.renderProfile(); Guest.renderMenu(); },
  'search-clear'() { const s = qs('#g-search'); s.value = ''; Guest.onSearch(''); s.focus(); },
  'goto-cat'(el) { const sec = qs('#cat-' + CSS.escape(el.dataset.cat)); if (sec) { if (Guest.view !== 'menu') Guest.setView('menu'); sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
  'open-dish'(el) { Guest.dishSheet(Number(el.dataset.id)); },
  async add(el) {
    const item = Guest.menu.byId.get(Number(el.dataset.id));
    if (!item) return;
    await busy(el, () => Guest.addToCart(item));
  },
  async 'dec-dish'(el) {
    const lines = Guest.st.cart.items.filter((c) => c.mine && c.menu_item_id === Number(el.dataset.id));
    const line = lines[lines.length - 1];
    if (!line) return;
    await busy(el, () => Guest.mutate('PATCH', '/cart/' + line.id, { qty: line.qty - 1 }));
  },
  async 'line-qty'(el) {
    const line = Guest.st.cart.items.find((c) => c.id === el.dataset.line);
    if (!line) return;
    await busy(el, () => Guest.mutate('PATCH', '/cart/' + line.id, { qty: Math.min(Data.config.limits.max_qty, line.qty + Number(el.dataset.delta)) }));
  },
  'edit-line'(el) { Guest.lineSheet(el.dataset.line); },
  submit(el) { Guest.submitSheet(el.dataset.scope); },
  async repeat(el) { await busy(el, async () => { const res = await Guest.mutate('POST', `/orders/${el.dataset.order}/repeat`); toast(`Добавлено в корзину: ${pl(res.added, 'позиция', 'позиции', 'позиций')}`, 'success'); Guest.setView(window.innerWidth <= 900 ? 'panel' : Guest.view, 'cart'); }); },
  'toggle-bill-row'(el) { const row = el.closest('.bill-row'); row.classList.toggle('open'); el.setAttribute('aria-expanded', row.classList.contains('open')); },
  pay(el) { Guest.paySheet(el.dataset.for); },
  'resume-pay'(el) { const p = Guest.st.payments.find((x) => x.id === el.dataset.pay); if (p) Guest.checkoutSheet({ payment_id: p.id, amount: p.amount, tip: p.tip, method: p.method, checkout: { title: p.method_title, payload: `https://pay.kaspi.kz/pay/demo?ref=${p.provider_ref}&amount=${Math.round((p.amount + p.tip) / 100)}`, hint: 'Демо-режим: настоящий платёж не списывается' } }); },
  async 'cancel-pay'(el) { await busy(el, async () => { await Guest.mutate('POST', `/payments/${el.dataset.pay}/cancel`); toast('Оплата отменена', 'info'); }); },
  receipt() {
    openSheet({
      title: 'Электронный чек', body: Guest.receiptHtml(),
      foot: `<button class="btn btn-ghost" data-act="print-receipt">${icon('print')}Распечатать или PDF</button><button class="btn btn-primary" data-close>Закрыть</button>`,
      actions: { 'print-receipt'() { PRINT_ROOT.innerHTML = `<div class="print-ticket" style="max-width:120mm">${Guest.receiptHtml()}</div>`; window.print(); } },
    });
  },
  'new-visit'() { store.del('guest.' + Guest.code); if (Guest.qrToken) store.del('table.' + Guest.qrToken); Guest.active = false; route(); },
  invite() {
    const s = Guest.st.session;
    openSheet({
      title: s.kind === 'office' ? 'Позвать коллег' : 'Пригласить за стол', size: 'sm',
      body: `<div class="stack" style="align-items:center;text-align:center"><img src="${esc(s.qr_url)}" alt="QR-код приглашения" width="240" height="240" style="width:240px;height:240px;border-radius:18px;border:1px solid var(--line)"><p class="muted small">${s.kind === 'office' ? 'Отправьте ссылку в рабочий чат: каждый выберет обед сам, а в дедлайн заказ уйдёт на кухню.' : 'Это тот же QR, что стоит на столе. Все, кто его откроет, попадут в общую корзину — со вторым гостем включится режим компании.'}</p><div class="input" style="word-break:break-all;text-align:left;font-size:13.5px;min-height:0">${esc(s.join_url)}</div></div>`,
      foot: `<button class="btn btn-ghost" data-act="inv-copy">${icon('copy')}Копировать</button><button class="btn btn-primary" data-act="inv-share">${icon('share')}Поделиться</button>`,
      actions: { 'inv-copy'() { copyText(s.join_url); }, 'inv-share'() { shareLink(s.join_url, 'Присоединяйся к заказу в Foodbuster'); } },
    });
  },
  waiter() {
    const st = Guest.st;
    let reason = 'question';
    const mine = st.calls.filter((c) => c.participant_id === Guest.me.id);
    const reasons = Object.entries(Data.config.call_reasons);
    const body = () => `${mine.length ? `<div class="notice ok" style="margin-bottom:12px">${icon('check')}<span>Официант уже получил ваш вызов: ${esc(mine.map((c) => c.label.toLowerCase()).join(', '))}</span></div>` : ''}<div class="stack" style="gap:8px">${reasons.map(([k, v]) => `<button type="button" class="check-card radio ${k === reason ? 'on' : ''}" data-act="w-reason" data-r="${k}" role="radio" aria-checked="${k === reason}"><span class="mark">${icon('check')}</span><span class="cc-main"><span class="cc-title">${esc(v)}</span></span></button>`).join('')}</div>`;
    openSheet({
      title: 'Позвать официанта', size: 'sm', body: body(),
      foot: `<button class="btn btn-primary btn-block" data-act="w-send">${icon('bell')}Позвать</button>`,
      actions: {
        'w-reason'(el, e, sheet) { reason = el.dataset.r; sheet.setBody(body()); },
        async 'w-send'(el, e, sheet) { await busy(el, async () => { await Guest.mutate('POST', '/calls', { reason }); sheet.close(); toast('Официант получил вызов', 'success', { icon: 'bell' }); }); },
      },
    });
  },
  deadline() {
    const s = Guest.st.session;
    openSheet({
      title: 'Ограничено время?', size: 'sm',
      body: `<p class="muted small">Укажите, через сколько вам нужно уйти — кухня увидит срочность в тикете, а вы — успевает ли заказ.</p><div class="grid-3" style="margin-top:14px">${[15, 20, 30, 45, 60, 90].map((m) => `<button class="btn btn-ghost" data-act="dl-set" data-m="${m}">через ${m} мин</button>`).join('')}</div>${s.deadline_at ? `<p class="small" style="margin-top:12px">Сейчас: уйти к <b>${timeHM(s.deadline_at)}</b></p>` : ''}`,
      foot: s.deadline_at ? '<button class="btn btn-danger-soft btn-block" data-act="dl-clear">Снять ограничение</button>' : '',
      actions: {
        async 'dl-set'(el, e, sheet) { await busy(el, async () => { await Guest.mutate('POST', '/deadline', { minutes: Number(el.dataset.m) }); sheet.close(); toast('Кухня видит, что вы спешите', 'success', { icon: 'clock' }); }); },
        async 'dl-clear'(el, e, sheet) { await busy(el, async () => { await Guest.mutate('POST', '/deadline', { minutes: null }); sheet.close(); }); },
      },
    });
  },
  profile() {
    const me = Guest.me;
    const draft = { name: me.name, avatar: me.avatar, allergens: [...me.allergens], diets: [...me.diets], share: me.share_allergies };
    const sheet = openSheet({
      title: 'Мой профиль',
      body: `<div class="stack"><div class="row">${avatar(me, 'lg')}<div class="grow"><b style="font-size:17px">${esc(me.name)}</b><div class="small muted">${me.role === 'host' ? 'Хозяин стола' : 'Гость'} · ${esc(Guest.st.session.title || '')}</div></div></div>
        <label class="field"><span class="label">Имя</span><input class="input" id="pf-name" maxlength="24" value="${esc(me.name)}"></label>
        <div class="field"><span class="label">Аватар</span><div class="avatar-picker">${Data.config.avatars.map((a) => `<button type="button" data-act="pf-avatar" data-avatar="${a}" class="${a === draft.avatar ? 'on' : ''}" aria-label="Аватар ${a}">${a}</button>`).join('')}</div></div>
        <div class="field"><span class="label">Мне нельзя</span>${allergenChipsHtml(draft.allergens, 'pf-allergen')}</div>
        <div class="field"><span class="label">Питание</span>${dietChipsHtml(draft.diets, 'pf-diet')}</div>
        <label class="switch"><input type="checkbox" id="pf-share" ${draft.share ? 'checked' : ''}><span class="track"></span>Показывать мои аллергии компании</label>
        <div class="notice info">${icon('lock')}<span>Код восстановления: <b class="num">${esc(me.recovery_pin)}</b>. Если смените телефон — введите имя и этот код на экране входа за этим столом.</span></div>
        <button class="link-btn" style="color:var(--pome-deep)" data-act="pf-leave">${icon('door')}Выйти из группы</button></div>`,
      foot: '<button class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary" data-act="pf-save">Сохранить</button>',
      actions: {
        'pf-avatar'(el) { draft.avatar = el.dataset.avatar; qsa('[data-act="pf-avatar"]', sheet.el).forEach((b) => b.classList.toggle('on', b === el)); },
        'pf-allergen'(el) { toggleIn(draft.allergens, el.dataset.code); el.classList.toggle('on-danger'); el.setAttribute('aria-pressed', el.classList.contains('on-danger')); },
        'pf-diet'(el) { toggleIn(draft.diets, el.dataset.code); el.classList.toggle('on-jade'); el.setAttribute('aria-pressed', el.classList.contains('on-jade')); },
        async 'pf-save'(el) {
          const name = qs('#pf-name', sheet.el).value.trim();
          if (!name) { toast('Введите имя', 'warn'); return; }
          await busy(el, async () => {
            await Guest.mutate('PATCH', '/me', { name, avatar: draft.avatar, allergens: draft.allergens, diets: draft.diets, share_allergies: qs('#pf-share', sheet.el).checked });
            store.set('profile', { name, avatar: draft.avatar, allergens: draft.allergens, diets: draft.diets });
            sheet.close();
            toast('Профиль сохранён — меню пересчитано под ваши аллергии', 'success');
          });
        },
        async 'pf-leave'(el) {
          const ok = await confirmBox({ title: 'Выйти из группы?', text: 'Ваши позиции в корзине будут удалены. Выйти можно, пока у вас нет отправленных на кухню блюд.', ok: 'Выйти', danger: true });
          if (!ok) return;
          await busy(el, async () => {
            await api.post(`/api/s/${Guest.code}/leave`, {}, { token: Guest.token });
            store.del('guest.' + Guest.code);
            if (Guest.qrToken) store.del('table.' + Guest.qrToken);
            sheet.close();
            toast('Вы вышли из группы', 'info');
            Guest.stop();
            go('/');
          });
        },
      },
    });
  },
};
