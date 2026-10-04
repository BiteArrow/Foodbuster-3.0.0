'use strict';
const NotFoundView = {
  actions: {},
  mount() {
    APP.innerHTML = `<header class="topbar"><div class="topbar-in">${brandHtml()}</div></header><main id="main" class="notfound"><h1>404</h1><h2 class="mt-10">Такой страницы нет</h2><p class="muted notfound-text">Проверьте ссылку или отсканируйте QR-код на столе ещё раз.</p><a class="btn btn-primary" href="/" data-link>На главную</a></main>`;
  },
};

const LANDING_NAV = [['tables', 'Столы и QR', 'table'], ['how', 'Что решаем', 'sparkles'], ['flow', 'Как это работает', 'list'], ['office', 'Офисный обед', 'users']];

const LandingView = {
  ov: null, live: null, slide: 0, officeMinutes: 45, accessKey: '', tab: 'map', picked: null, find: '',
  actions: {
    'carousel-prev'() { LandingView.scrollTo(LandingView.slide - 1); },
    'carousel-next'() { LandingView.scrollTo(LandingView.slide + 1); },
    'carousel-dot'(el) { LandingView.scrollTo(Number(el.dataset.i)); },
    'stage-tab'(el) { LandingView.setTab(el.dataset.tab); },
    'map-pick'(el) { LandingView.pick(el.dataset.key); },
    'map-sit'() { const t = LandingView.pickedTable(); if (t && t.join_path) go(t.join_path); },
    'map-qr'() { LandingView.setTab('qr', LandingView.ov.tables.indexOf(LandingView.pickedTable())); },
    'find-pick'(el) { LandingView.pick(el.dataset.key); },
    'demo-table'() {
      const tables = (LandingView.ov.tables || []).filter((t) => t.join_path);
      const free = tables.find((t) => !t.guests) || tables[0];
      if (free) go(free.join_path);
    },
    menu() {
      openSheet({
        title: 'Foodbuster', size: 'sm', cls: 'nav-sheet',
        body: `<nav class="nav-list" aria-label="Разделы">${LANDING_NAV.map(([id, label, ic]) => `<button class="nav-item" data-act="nav-go" data-to="${id}">${icon(ic)}<span>${label}</span>${icon('right', 'ic-sm')}</button>`).join('')}</nav>`,
        foot: `<button class="btn btn-primary btn-block" data-act="nav-sit">${icon('table')}Сесть за демо-стол</button>`,
        actions: {
          'nav-go'(el, e, sheet) { sheet.close(); setTimeout(() => { const target = qs('#' + el.dataset.to); if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 260); },
          'nav-sit'(el, e, sheet) { sheet.close(); LandingView.actions['demo-table'](); },
        },
      });
    },
    'office-minutes'(el) { LandingView.officeMinutes = Number(el.dataset.min); qsa('[data-act="office-minutes"]').forEach((b) => b.classList.toggle('on', b === el)); },
    async 'office-create'(el) {
      const form = qs('#office-form');
      const name = form.name.value.trim();
      const err = qs('#office-error');
      if (!name) { err.hidden = false; err.textContent = 'Введите своё имя — коллеги увидят, кто собирает обед'; form.name.focus(); return; }
      err.hidden = true;
      await busy(el, async () => {
        const profile = store.get('profile', {});
        const res = await api.post('/api/office', { title: form.title.value.trim() || 'Офисный обед', name, avatar: profile.avatar || null, cutoff_minutes: LandingView.officeMinutes, pickup_note: form.pickup.value.trim(), allergens: profile.allergens || [], diets: profile.diets || [] });
        store.set('guest.' + res.code, { token: res.participant_token, pid: res.participant_id });
        store.set('profile', { ...profile, name });
        store.set('invite-once', res.code);
        go('/g/' + res.code);
      });
    },
    'copy-base'() { copyText(LandingView.ov.access.base); },
  },
  async mount(token) {
    APP.innerHTML = `<header class="topbar"><div class="topbar-in">${brandHtml()}</div></header><main class="page" id="main"><div class="hero"><div class="stack"><div class="skeleton sk-120"></div><div class="skeleton sk-60"></div></div><div class="skeleton sk-stage"></div></div></main>`;
    const [cfg, ov] = await Promise.all([Data.getConfig(), api.get('/api/public/overview')]);
    if (!isCurrent(token)) return;
    this.cfg = cfg; this.ov = ov; this.slide = 0; this.tab = 'map'; this.find = '';
    this.picked = String((ov.tables.find((t) => !t.guests) || ov.tables[0] || {}).id);
    this.accessKey = this.keyOf(ov.access);
    this.render();
    this.live = new Live('/api/public/events', (ev) => this.onEvent(ev), () => {}).start();
  },
  unmount() { if (this.live) this.live.stop(); this.live = null; },
  keyOf(access) { return (access.base || '') + '|' + (access.mode || ''); },
  onEvent: debounce(async function onEvent(ev) {
    if (!['tables', 'access', 'poll'].includes(ev.type) || View !== LandingView) return;
    try {
      const ov = await api.get('/api/public/overview');
      if (View !== LandingView) return;
      const changedAccess = LandingView.keyOf(ov.access) !== LandingView.accessKey;
      LandingView.ov = ov;
      LandingView.accessKey = LandingView.keyOf(ov.access);
      LandingView.renderLive(changedAccess);
      if (changedAccess && ov.access.public) toast('Публичная ссылка готова — QR-коды обновлены', 'success');
    } catch (e) { /* next event will retry */ }
  }, 300),
  many() { return this.ov.tables.length > 12; },
  pick(key) { this.picked = key; this.renderMap(); },
  scrollTo(i, behavior = 'smooth') {
    const track = qs('#qr-track');
    const cards = qsa('.tent', track);
    if (!cards.length) return;
    const index = (i + cards.length) % cards.length;
    track.scrollTo({ left: cards[index].offsetLeft - (track.clientWidth - cards[index].clientWidth) / 2, behavior });
    if (behavior === 'instant') this.markSlide(index);
  },
  markSlide(index) {
    this.slide = index;
    this.picked = String(this.ov.tables[index].id);
    qsa('#qr-dots button').forEach((d, i) => d.classList.toggle('on', i === index));
    const counter = qs('#qr-counter');
    if (counter) counter.textContent = `${index + 1} / ${this.ov.tables.length}`;
  },
  setTab(tab, index) {
    this.tab = tab;
    qsa('[data-act="stage-tab"]').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    qs('#stage-map').hidden = tab !== 'map';
    qs('#stage-qr').hidden = tab !== 'qr';
    qs('#stage-ctl').hidden = tab !== 'qr';
    qs('#stage-title').textContent = this.stageTitle();
    if (tab === 'map') this.renderMap();
    if (tab === 'qr') this.scrollTo(Math.max(0, index ?? this.ov.tables.indexOf(this.pickedTable())), 'instant');
  },
  stageTitle() { return this.tab === 'map' ? 'Выберите столик на карте зала' : `${pl(this.ov.tables.length, 'стол', 'стола', 'столов')} — у каждого свой QR`; },
  pickedTable() { return this.ov.tables.find((t) => String(t.id) === this.picked) || this.ov.tables[0]; },
  mapTables() {
    return this.ov.tables.map((t) => {
      const state = !t.guests ? 'free' : t.mode === 'company' ? 'company' : 'solo';
      const text = { free: 'свободен', solo: 'один гость', company: `компания, ${pl(t.guests, 'гость', 'гостя', 'гостей')}` }[state];
      return { key: String(t.id), label: t.label, zone: t.zone, seats: t.seats, x: t.x, y: t.y, state, text, guests: t.guests, people: t.avatars };
    });
  },
  pickHtml() {
    const t = this.pickedTable();
    if (!t) return '<div class="empty"><div class="empty-art">🪑</div><h3>Столов пока нет</h3><p>Администратор добавит их в разделе «Столы и QR».</p></div>';
    const m = this.mapTables().find((x) => x.key === String(t.id));
    const hint = { free: 'Свободен — сядьте и откройте меню', solo: 'Сидит один гость — вы будете вторым, включится режим компании', company: 'Компания за столом — присоединяйтесь к общей корзине' }[m.state];
    const qr = t.qr_url ? `<img src="${esc(t.qr_url)}?v=${encodeURIComponent(this.accessKey)}" alt="QR-код ${esc(t.label)}" width="92" height="92">` : '';
    return `<div class="hm-pick-card"><div class="hm-pick-qr">${qr}</div><div class="grow"><b>${esc(t.label)}</b><span>${esc(t.zone || 'Зал')} · ${pl(t.seats, 'место', 'места', 'мест')}</span><span class="badge ${m.state === 'free' ? 'ok' : m.state === 'solo' ? 'caution' : 'jade'}">${esc(m.text)}</span><p>${esc(hint)}</p></div></div>
      <div class="hm-pick-actions">${t.join_path ? `<button class="btn btn-primary" data-act="map-sit">${icon('table')}Сесть за этот стол</button><button class="btn btn-ghost" data-act="map-qr">${icon('qr')}QR крупнее</button>` : '<span class="muted small">QR выдаётся администратором</span>'}</div>`;
  },
  findHtml() {
    if (!this.many()) return '';
    const q = this.find.trim().toLowerCase();
    const hits = q ? this.ov.tables.filter((t) => t.label.toLowerCase().includes(q) || (t.zone || '').toLowerCase().includes(q)).slice(0, 8) : [];
    return `<div class="hm-find"><div class="search-box">${icon('search')}<input class="input" id="table-find" type="search" inputmode="search" placeholder="Номер стола или зона, например «12»" value="${esc(this.find)}" aria-label="Найти стол"></div>${q ? `<div class="chip-row hm-find-hits">${hits.length ? hits.map((t) => `<button class="chip ${String(t.id) === this.picked ? 'on' : ''}" data-act="find-pick" data-key="${t.id}">${esc(t.label)}<span class="cnt">${t.guests ? pl(t.guests, 'гость', 'гостя', 'гостей') : 'свободен'}</span></button>`).join('') : '<span class="small muted">Такого стола нет</span>'}</div>` : ''}</div>`;
  },
  renderMap() {
    const box = qs('#stage-map');
    if (!box) return;
    const typing = document.activeElement && document.activeElement.id === 'table-find';
    box.innerHTML = `${this.findHtml()}<div class="hm-card">${HallMap.html(this.mapTables(), { selected: String((this.pickedTable() || {}).id) })}${HallMap.legend([['free', 'Свободен'], ['solo', 'Один гость'], ['company', 'Компания']])}</div><div class="hm-pick" id="hm-pick">${this.pickHtml()}</div>`;
    const input = qs('#table-find');
    if (input) {
      input.addEventListener('input', debounce(() => { this.find = input.value; const hit = this.ov.tables.find((t) => t.label.toLowerCase().includes(this.find.trim().toLowerCase())); if (hit && this.find.trim()) this.picked = String(hit.id); this.renderMap(); }, 180));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.actions['map-sit'](); } });
      if (typing) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
  },
  tentHtml(t, i) {
    const base = this.ov.access.base;
    const occupancy = t.guests
      ? `<span class="badge white">${avatarStack(t.avatars.map((a) => ({ ...a, name: '' })), 3, 'xs')} ${pl(t.guests, 'гость', 'гостя', 'гостей')}</span>`
      : '<span class="badge white">Свободен</span>';
    const qr = t.qr_url ? `<img src="${esc(t.qr_url)}?v=${encodeURIComponent(this.accessKey)}" alt="QR-код ${esc(t.label)}" width="230" height="230" loading="lazy" decoding="async">` : '<div class="skeleton qr-skel"></div>';
    return `<article class="tent" aria-roledescription="слайд" aria-label="${esc(t.label)}, ${i + 1} из ${this.ov.tables.length}">
      <div class="tent-top"><div class="tent-occupancy">${occupancy}</div><div class="tent-label">${esc(t.label)}</div><div class="tent-zone">${esc(t.zone || 'Зал')} · ${pl(t.seats, 'место', 'места', 'мест')}${t.mode === 'company' ? ' · компания' : t.mode === 'solo' ? ' · один гость' : ''}</div></div>
      <div class="tent-qr">${qr}</div>
      <div class="tent-url">${t.join_path ? esc(base + t.join_path) : 'QR выдаётся администратором'}</div>
      <div class="tent-foot"><div class="tent-hint">${icon('qr', 'ic-sm')}Наведите камеру телефона на код</div>${t.join_path ? `<a class="btn btn-ghost btn-block" href="${esc(t.join_path)}" data-link>Открыть на этом устройстве</a>` : ''}</div>
    </article>`;
  },
  dotsHtml() {
    if (this.many()) return `<div class="qr-counter" id="qr-counter">${this.slide + 1} / ${this.ov.tables.length}</div>`;
    return `<div class="dots" id="qr-dots">${this.ov.tables.map((t, i) => `<button data-act="carousel-dot" data-i="${i}" class="${i === this.slide ? 'on' : ''}" aria-label="${esc(t.label)}"></button>`).join('')}</div>`;
  },
  accessHtml() {
    const a = this.ov.access;
    const t = a.tunnel || {};
    if (a.public) {
      return `<div class="access public"><div class="access-ic">${icon('globe', 'ic-lg')}</div><div class="access-main"><b>QR открываются с мобильного интернета${a.verified ? ' · адрес проверен' : ''}</b><span>${esc(a.base)}</span></div><button class="btn btn-ghost btn-sm" data-act="copy-base">${icon('copy')}Скопировать</button></div>`;
    }
    if (['starting', 'downloading'].includes(t.status)) {
      return `<div class="access pending"><div class="access-ic">${icon('refresh', 'ic-lg')}</div><div class="access-main"><b>Готовим публичную ссылку для QR…</b><span>${t.status === 'downloading' ? 'Скачиваем туннель — это разовая настройка. ' : ''}QR обновятся сами. Пока работает локальная сеть: ${esc(a.base)}</span></div></div>`;
    }
    return `<div class="access local"><div class="access-ic">${icon('wifi', 'ic-lg')}</div><div class="access-main"><b>Пока QR открываются только в Wi‑Fi этой сети</b><span>${esc(a.base)} · чтобы открывать с мобильного интернета, запустите python backend.py — публичный адрес появится сам</span></div><button class="btn btn-ghost btn-sm" data-act="copy-base">${icon('copy')}Скопировать</button></div>`;
  },
  statsHtml() {
    const ov = this.ov;
    return `<div class="hero-stat"><b class="num">${ov.dishes}</b><span>блюд с КБЖУ</span></div><div class="hero-stat"><b class="num">${this.cfg.allergens.length}</b><span>аллергенов в фильтре</span></div><div class="hero-stat"><b class="num">${ov.today.orders}</b><span>${plural(ov.today.orders, 'заказ', 'заказа', 'заказов')} сегодня</span></div><div class="hero-stat"><b class="num">${ov.today.guests_now}</b><span>${plural(ov.today.guests_now, 'гость', 'гостя', 'гостей')} за столами</span></div>`;
  },
  renderLive(changedAccess) {
    const track = qs('#qr-track');
    if (!track) return;
    const scroll = track.scrollLeft;
    track.innerHTML = this.ov.tables.map((t, i) => this.tentHtml(t, i)).join('');
    track.scrollLeft = scroll;
    qs('#qr-nav').innerHTML = this.dotsHtml();
    this.renderMap();
    qs('#access-slot').innerHTML = this.accessHtml();
    qs('#hero-stats').innerHTML = this.statsHtml();
    if (changedAccess) qsa('.tent-qr img').forEach((img) => { img.src = img.src.split('?')[0] + '?v=' + encodeURIComponent(this.accessKey); });
  },
  render() {
    const ov = this.ov;
    const guestSteps = ['Понятное меню', 'Аллергены', 'КБЖУ', 'Выбор блюда', 'Своя корзина', 'Общая корзина', 'Раздельная оплата', 'Статус кухни', 'Получение заказа'];
    const restSteps = ['Цифровой заказ', 'Без ручного ввода', 'Без ошибок передачи', 'Контроль кухни', 'Быстрее обслуживание', 'Аналитика'];
    const flow = (steps) => steps.map((s, i) => `<span class="flow-unit"><span class="flow-step"><i>${i + 1}</i>${esc(s)}</span>${i < steps.length - 1 ? `<span class="flow-arrow">${icon('right', 'ic-sm')}</span>` : ''}</span>`).join('');
    const officeSteps = [['🔗', 'Создайте группу', 'Название, дедлайн и куда привезти — 20 секунд'], ['💬', 'Киньте ссылку в чат', 'Коллеги выбирают сами, видят корзины друг друга'], ['⏰', 'Дедлайн — и всё на кухне', 'Заказ уходит автоматически, каждый платит за своё']];
    APP.innerHTML = `
    <header class="topbar"><div class="topbar-in">${brandHtml(ov.restaurant.name + ' · ' + ov.restaurant.city)}
      <nav class="topnav" aria-label="Разделы">${LANDING_NAV.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('')}</nav>
      <div class="topbar-actions"><button class="btn btn-primary btn-sm hide-sm" data-act="demo-table">${icon('table')}Сесть за стол</button><button class="icon-btn menu-btn" data-act="menu" aria-label="Меню разделов">${icon('menu')}</button></div></div></header>
    <main class="page" id="main">
      <section class="hero" id="tables">
        <div>
          <span class="hero-kicker">${icon('sparkles', 'ic-sm')}Foodbuster · ${esc(ov.restaurant.name)}</span>
          <h1 class="hero-title">Один QR на стол — и каждый платит за своё</h1>
          <p class="hero-lead">Гости открывают меню без приложения и Wi‑Fi ресторана, видят аллергены и КБЖУ, собирают общую корзину и делят счёт до тиына. Кухня получает заказ с отметками об аллергиях, а таймер честно показывает, когда принесут.</p>
          <div class="hero-cta"><button class="btn btn-primary btn-lg" data-act="demo-table">${icon('table')}Сесть за демо-стол</button><a class="btn btn-ghost btn-lg" href="#office">${icon('users')}Собрать офисный обед</a></div>
          <div class="hero-points"><span class="hero-point">${icon('check', 'ic-sm')}Без приложения и регистрации</span><span class="hero-point">${icon('check', 'ic-sm')}Мобильный интернет вместо Wi‑Fi</span><span class="hero-point">${icon('check', 'ic-sm')}Цена фиксируется при добавлении</span></div>
          <div class="hero-stats" id="hero-stats">${this.statsHtml()}</div>
        </div>
        <div class="qr-stage">
          <div class="qr-stage-head"><h2 id="stage-title">${this.stageTitle()}</h2><div class="carousel-ctl" id="stage-ctl" hidden><button class="icon-btn" data-act="carousel-prev" aria-label="Предыдущий стол">${icon('left')}</button><button class="icon-btn" data-act="carousel-next" aria-label="Следующий стол">${icon('right')}</button></div></div>
          <div class="seg block stage-tabs" role="tablist" aria-label="Выбор столика"><button role="tab" aria-selected="true" class="on" data-act="stage-tab" data-tab="map">${icon('table')}Карта зала</button><button role="tab" aria-selected="false" data-act="stage-tab" data-tab="qr">${icon('qr')}QR-коды</button></div>
          <div id="stage-map"></div>
          <div id="stage-qr" hidden>
            <div class="qr-track" id="qr-track" tabindex="0" aria-label="QR-коды столов">${ov.tables.map((t, i) => this.tentHtml(t, i)).join('')}</div>
            <div id="qr-nav">${this.dotsHtml()}</div>
          </div>
        </div>
      </section>
      <div id="access-slot">${this.accessHtml()}</div>
      <section class="band" id="how">
        <div class="band-head"><div><h2 class="section-title">Четыре боли общего заказа — и что с ними делает Foodbuster</h2><p>Цифры — из исследования команды. Каждое решение работает в этом прототипе прямо сейчас.</p></div></div>
        <div class="problems">
          <article class="problem"><div class="problem-ic ic-pome">🛡️</div><h3>Аллергены</h3><div class="p-fact num">14</div><div class="p-fact-note">аллергенов размечено у каждого блюда — «содержит» и «возможны следы»</div><p class="pain">В час пик официант не всегда помнит, есть ли арахис в соусе, а ошибка стоит очень дорого.</p><p class="fix">Личный фильтр подсвечивает опасные блюда, а отметка об аллергии уходит прямо повару в тикет.</p></article>
          <article class="problem"><div class="problem-ic ic-sky">🥗</div><h3>Слепая зона по КБЖУ</h3><div class="p-fact num">${ov.dishes}/${ov.dishes}</div><div class="p-fact-note">позиций с калориями, белками, жирами и углеводами</div><p class="pain">Гости на диете уходят без заказа, если в меню нет понятных цифр.</p><p class="fix">КБЖУ в каждой карточке, пересчёт на лету, если убрать соус или сыр, и поиск «белок от 30».</p></article>
          <article class="problem"><div class="problem-ic ic-saffron">⏱️</div><h3>Неизвестное время</h3><div class="p-fact num">ETA</div><div class="p-fact-note">кухня ставит время при принятии, таймер идёт у всех за столом</div><p class="pain">До конца перерыва 10 минут, а еду ещё даже не начали готовить.</p><p class="fix">Таймер, «Нам нужно уйти к 13:00» и мини-игра, чтобы ожидание пролетело незаметно.</p></article>
          <article class="problem"><div class="problem-ic ic-jade">🧾</div><h3>Общий чек</h3><div class="p-fact num">7–12 мин</div><div class="p-fact-note">уходит у официанта на ручной раздел счёта одного стола</div><p class="pain">Один платит за всех, а потом неделю собирает переводы.</p><p class="fix">Каждый закрывает свою часть, общие блюда делятся до тиына, можно оплатить за друга.</p></article>
        </div>
      </section>
      <section class="band" id="flow">
        <div class="band-head"><div><h2 class="section-title">Единый слой между гостем и рестораном</h2><p>Одна сессия стола связывает телефоны гостей, кухню, официанта и администратора в реальном времени.</p></div></div>
        <div class="flow"><div class="flow-lane"><h3>${icon('users')}Гость и компания</h3><div class="flow-steps">${flow(guestSteps)}</div></div><div class="flow-lane"><h3>${icon('utensils')}Ресторан</h3><div class="flow-steps">${flow(restSteps)}</div></div></div>
      </section>
      <section class="band duo" id="office">
        <div class="office">
          <h2>Офисный обед за 2 минуты</h2>
          <p>До 25% коллективных обедов срываются на этапе сбора пожеланий. Создайте группу, отправьте ссылку в чат — каждый выберет сам, а в дедлайн заказ уйдёт на кухню автоматически.</p>
          <form class="form" id="office-form" novalidate>
            <div class="grid-2"><label class="field"><span class="label">Название группы</span><input class="input" name="title" maxlength="60" value="Обед отдела" autocomplete="off"></label><label class="field"><span class="label">Ваше имя</span><input class="input" name="name" maxlength="24" placeholder="Например, Айгерим" value="${esc((store.get('profile', {}) || {}).name || '')}" autocomplete="given-name"></label></div>
            <div class="field"><span class="label">Собираем заказы ещё</span><div class="seg block">${[20, 30, 45, 60, 90].map((m) => `<button type="button" data-act="office-minutes" data-min="${m}" class="${m === this.officeMinutes ? 'on' : ''}">${m} мин</button>`).join('')}</div></div>
            <label class="field"><span class="label">Куда доставить или где забрать</span><input class="input" name="pickup" maxlength="120" placeholder="Например, офис на 5 этаже, переговорная «Алатау»" autocomplete="off"></label>
            <div class="form-error" id="office-error" hidden></div>
            <button type="button" class="btn btn-saffron btn-lg" data-act="office-create">${icon('users')}Создать группу и позвать коллег</button>
          </form>
        </div>
        <div class="office-steps">
          <h2 class="section-title">Как это выглядит у коллег</h2>
          ${officeSteps.map(([emo, title, text], i) => `<div class="office-step"><span class="office-step-ic">${emo}</span><div><b>${i + 1}. ${esc(title)}</b><span>${esc(text)}</span></div></div>`).join('')}
          <div class="notice info">${icon('info')}<span>Для офиса обслуживание 0%: каждый видит свою сумму и оплачивает её сам — Kaspi, картой или наличными.</span></div>
        </div>
      </section>
      <footer class="footer"><span>Foodbuster · ${esc(ov.restaurant.name)}, ${esc(ov.restaurant.city)}</span><span>Прототип: оплата в демо-режиме, история заказов — демонстрационная</span><a class="staff-door" href="/staff" data-link aria-label="Вход для персонала" title="Персонал">${icon('lock', 'ic-sm')}</a></footer>
    </main>`;
    qs('#office-form').addEventListener('submit', (e) => { e.preventDefault(); qs('[data-act="office-create"]').click(); });
    this.renderMap();
    const track = qs('#qr-track');
    track.addEventListener('scroll', debounce(() => {
      if (this.tab !== 'qr') return;
      const cards = qsa('.tent', track);
      const center = track.scrollLeft + track.clientWidth / 2;
      let best = 0;
      cards.forEach((c, i) => { if (Math.abs(c.offsetLeft + c.clientWidth / 2 - center) < Math.abs(cards[best].offsetLeft + cards[best].clientWidth / 2 - center)) best = i; });
      this.markSlide(best);
    }, 60));
    track.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { e.preventDefault(); this.scrollTo(this.slide + 1); } if (e.key === 'ArrowLeft') { e.preventDefault(); this.scrollTo(this.slide - 1); } });
  },
};
routes.push({ re: /^\/$/, view: LandingView });
