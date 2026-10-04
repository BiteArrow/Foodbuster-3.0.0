'use strict';
const FOOD_EMOJI = ['🍽', '🥘', '🍚', '🥟', '🍜', '🍲', '🥣', '🥗', '🥙', '🌯', '🍝', '🍕', '🍔', '🌭', '🥪', '🍗', '🍖', '🥩', '🍢', '🔥', '🐟', '🍣', '🍤', '🦐', '🥦', '🥕', '🍅', '🍆', '🫑', '🥔', '🍟', '🧀', '🥚', '🍳', '🥞', '🧇', '🥐', '🫓', '🍩', '🍰', '🍮', '🍫', '🍨', '🍯', '🥮', '🍓', '🫐', '🍋', '🥭', '🍊', '🥥', '🥛', '☕', '🍵', '🫖', '🧃', '🥤', '🍶'];
const AUDIT_LABELS = {
  login: 'Вход сотрудника', dish_created: 'Новое блюдо', dish_updated: 'Изменено блюдо', stop_list: 'В стоп-лист', back_in_stock: 'Снова в продаже',
  dish_archived: 'Блюдо в архиве', dish_deleted: 'Блюдо удалено', dish_restored: 'Блюдо восстановлено', dish_photo: 'Новое фото блюда', dish_photo_removed: 'Фото удалено',
  category_saved: 'Категория сохранена', category_deleted: 'Категория удалена', categories_reordered: 'Порядок категорий', table_saved: 'Стол сохранён', layout_saved: 'Расстановка зала',
  qr_rotated: 'QR стола перевыпущен', restaurant_updated: 'Настройки ресторана', demo_reset: 'Сброс демо-данных', joined: 'Гость сел за стол',
  office_created: 'Создан офисный обед', recovered: 'Доступ восстановлен', profile_updated: 'Гость обновил профиль', left: 'Гость вышел',
  deadline_set: 'Гости спешат', waiter_called: 'Вызов официанта', order_submitted: 'Заказ отправлен', order_status: 'Статус заказа', eta_adjusted: 'Изменено время',
  item_status: 'Статус позиции', payment_created: 'Создан платёж', payment_paid: 'Оплачено', payment_cancelled: 'Платёж отменён', cash_confirmed: 'Приняты наличные',
  refund: 'Возврат переплаты', call_resolved: 'Вызов закрыт', session_closed: 'Стол закрыт', office_cutoff: 'Дедлайн офисного обеда', catalog_seeded: 'Создан каталог',
};
const ROLE_RU = { admin: 'админ', kitchen: 'кухня', waiter: 'официант', system: 'система', scheduler: 'планировщик', seed: 'система' };

function fileToDataUrl(file, maxSide = 1280) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) { reject(new Error('Выберите изображение JPG, PNG или WebP')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Файл не похож на изображение'));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.86));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }
function barChart(rows, { label, value, tip, fmt, title }) {
  const W = 640; const H = 230; const padL = 52; const padB = 28; const padT = 12;
  const n = rows.length || 1;
  const max = niceMax(Math.max(0, ...rows.map(value)));
  const band = (W - padL - 4) / n;
  const barW = Math.max(3, Math.min(34, band * 0.7));
  const every = Math.ceil(n / 12);
  const grid = [0, 0.5, 1].map((f) => { const y = H - padB - f * (H - padB - padT); return `<line class="grid" x1="${padL}" x2="${W}" y1="${y}" y2="${y}"/><text class="axis" x="${padL - 8}" y="${y + 4}" text-anchor="end">${esc(fmt(max * f))}</text>`; }).join('');
  const bars = rows.map((r, i) => {
    const v = value(r);
    const h = (v / max) * (H - padB - padT);
    const x = padL + i * band + (band - barW) / 2;
    const y = H - padB - h;
    const rad = Math.min(4, barW / 2, h);
    const d = h > 0 ? `M${x},${H - padB} V${y + rad} Q${x},${y} ${x + rad},${y} H${x + barW - rad} Q${x + barW},${y} ${x + barW},${y + rad} V${H - padB} Z` : '';
    return `<g data-tip="${esc(tip(r))}"><rect class="hit" x="${padL + i * band}" y="${padT}" width="${band}" height="${H - padB - padT}"/>${d ? `<path class="bar" d="${d}"/>` : ''}${i % every === 0 ? `<text class="axis" x="${x + barW / 2}" y="${H - 9}" text-anchor="middle">${esc(label(r))}</text>` : ''}</g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" style="height:auto" role="img" aria-label="${esc(title)}">${grid}${bars}</svg>`;
}
function hbars(rows, { name, value, valueText, max }) {
  const top = max || Math.max(1, ...rows.map(value));
  return `<div class="hbars">${rows.map((r) => `<div class="hbar"><span class="hb-name">${name(r)}</span><span class="hb-val">${esc(valueText(r))}</span><span class="hb-track"><i style="width:${Math.max(2, (value(r) / top) * 100)}%"></i></span></div>`).join('')}</div>`;
}

const Admin = {
  tab: 'menu', data: null, filter: { q: '', cat: 'all', status: 'all' }, period: 7, auditOffset: 0, auditItems: [],
  tabs: [['menu', 'Меню', 'utensils'], ['categories', 'Категории', 'grid'], ['tables', 'Столы и QR', 'qr'], ['analytics', 'Аналитика', 'chart'], ['settings', 'Настройки', 'settings'], ['audit', 'Журнал', 'list']],
  async mount() {
    this.tab = store.get('admin-tab', 'menu');
    if (!this.tabs.some((t) => t[0] === this.tab)) this.tab = 'menu';
    await this.renderTab();
  },
  reload() { Admin.loadSoon(); },
  onEvent(ev) { if (ev.type === 'menu' && ['menu', 'categories'].includes(Admin.tab)) Admin.loadSoon(); if (ev.type === 'floor' && Admin.tab === 'tables') Admin.loadSoon(); },
  quietUntil: 0,
  loadSoon: debounce(() => { if (View === StaffView && StaffView.panel === Admin && !topSheet() && Date.now() > Admin.quietUntil) Admin.renderTab(); }, 400),
  shell(inner) {
    qs('#staff-body').innerHTML = `<nav class="admin-tabs" aria-label="Разделы администратора">${this.tabs.map(([id, label, ic]) => `<button class="${this.tab === id ? 'on' : ''}" data-act="admin-tab" data-tab="${id}">${icon(ic)}${label}</button>`).join('')}</nav><div id="admin-body">${inner}</div>`;
  },
  async renderTab() {
    if (!qs('#admin-body')) this.shell('<div class="skeleton" style="height:50vh"></div>');
    const fn = { menu: this.menuTab, categories: this.categoriesTab, tables: this.tablesTab, analytics: this.analyticsTab, settings: this.settingsTab, audit: this.auditTab }[this.tab];
    try { await fn.call(this); } catch (e) { qs('#admin-body').innerHTML = `<div class="notice danger">${icon('alert')}<span>${esc(e.message)}</span></div>`; }
  },
  setBody(html) { this.shell(html); },

  async menuTab() {
    this.data = await sapi('GET', '/api/admin/menu');
    this.drawMenu();
  },
  filteredItems() {
    const f = this.filter;
    return this.data.items.filter((i) => {
      if (f.cat !== 'all' && String(i.category_id) !== f.cat) return false;
      if (f.status === 'sale' && (!i.in_stock || i.archived)) return false;
      if (f.status === 'stop' && (i.in_stock || i.archived)) return false;
      if (f.status === 'archive' && !i.archived) return false;
      if (f.status !== 'archive' && f.status !== 'all' && i.archived) return false;
      if (f.q) { const q = f.q.toLowerCase(); if (!(`${i.name} ${i.description} ${i.ingredients.join(' ')}`).toLowerCase().includes(q)) return false; }
      return true;
    });
  },
  drawMenu() {
    const d = this.data;
    const items = this.filteredItems();
    const stop = d.items.filter((i) => !i.in_stock && !i.archived).length;
    const arch = d.items.filter((i) => i.archived).length;
    const catOptions = [{ value: 'all', label: 'Все категории' }, ...d.categories.map((c) => ({ value: String(c.id), label: c.name, icon: c.emoji }))];
    const row = (i) => `<div class="dt-row ${i.archived ? 'archived' : ''}">${dishArt(i, 'dt-art')}<div class="dt-name"><b>${esc(i.name)}</b><span>${i.weight_g ? i.weight_g + ' г · ' : ''}${i.cook_minutes} мин${i.options.length ? ' · модификаторы: ' + i.options.length : ''}${i.popular ? ' · хит' : ''}</span></div><span class="dt-cat small">${esc(i.category_name)}</span><span class="dt-price num">${money(i.price)}</span><span class="dt-kcal small">${fmt0(i.kcal)} ккал<br><span class="muted">${fmt0(i.protein)}/${fmt0(i.fat)}/${fmt0(i.carbs)}</span></span><span class="dt-alg">${i.allergens.map((a) => `<span title="${esc(Data.allergen(a).name)}">${Data.allergen(a).icon}</span>`).join('')}${i.traces.length ? `<span class="tiny muted" title="Возможны следы: ${esc(allergenNames(i.traces))}">+${i.traces.length}</span>` : ''}${!i.allergens.length && !i.traces.length ? '<span class="tiny muted">нет</span>' : ''}</span><span class="dt-status">${i.archived ? '<span class="badge">в архиве</span>' : `<label class="switch"><input type="checkbox" data-avail="${i.id}" ${i.in_stock ? 'checked' : ''}><span class="track"></span><span class="small">${i.in_stock ? 'В продаже' : 'Стоп'}</span></label>`}</span><span class="dt-actions">${i.archived ? `<button class="btn btn-sm btn-ghost" data-act="dish-restore" data-id="${i.id}">Вернуть</button>` : `<button class="icon-btn" data-act="dish-edit" data-id="${i.id}" aria-label="Изменить ${esc(i.name)}" title="Изменить">${icon('edit')}</button><button class="icon-btn" data-act="dish-delete" data-id="${i.id}" aria-label="Удалить ${esc(i.name)}" title="Удалить">${icon('trash')}</button>`}</span></div>`;
    this.setBody(`<div class="toolbar"><div class="search-box">${icon('search')}<input class="input" id="adm-q" type="search" placeholder="Название, описание или продукт" value="${esc(this.filter.q)}"></div>${selectBox('adm-cat', catOptions, this.filter.cat)}<div class="seg">${[['all', 'Все'], ['sale', 'В продаже'], ['stop', `Стоп · ${stop}`], ['archive', `Архив · ${arch}`]].map(([k, l]) => `<button data-act="adm-status" data-s="${k}" class="${this.filter.status === k ? 'on' : ''}">${l}</button>`).join('')}</div><button class="btn btn-primary" data-act="dish-new">${icon('plus')}Новое блюдо</button></div>
      <p class="small muted" style="margin-bottom:10px">Показано ${pl(items.length, 'блюдо', 'блюда', 'блюд')} из ${d.items.length - arch}. Изменения сразу видят гости; цены в уже собранных корзинах и заказах не меняются.</p>
      <div class="dish-table"><div class="dt-row dt-head"><span></span><span>Блюдо</span><span class="dt-cat">Категория</span><span>Цена</span><span class="dt-kcal">ККАЛ · Б/Ж/У</span><span>Аллергены</span><span>Статус</span><span></span></div>${items.map(row).join('') || '<div class="empty"><div class="empty-art">🔎</div><h3>Ничего не найдено</h3><p>Измените фильтры или создайте новое блюдо.</p></div>'}</div>`);
    const q = qs('#adm-q');
    q.addEventListener('input', debounce(() => { this.filter.q = q.value.trim(); const pos = q.selectionStart; this.drawMenu(); const nq = qs('#adm-q'); nq.focus(); nq.setSelectionRange(pos, pos); }, 250));
    qs('#admin-body').addEventListener('change', async (e) => {
      const box = e.target.closest('[data-avail]');
      if (!box) return;
      try {
        await sapi('PATCH', `/api/admin/menu/${box.dataset.avail}/availability`, { available: box.checked });
        const item = this.data.items.find((x) => x.id === Number(box.dataset.avail));
        item.in_stock = box.checked;
        box.parentElement.querySelector('.small').textContent = box.checked ? 'В продаже' : 'Стоп';
        toast(box.checked ? `«${item.name}» снова в продаже` : `«${item.name}» в стоп-листе`, 'success', { ms: 1800 });
      } catch (err) { box.checked = !box.checked; showError(err); }
    });
  },
  editor(item) {
    const cats = this.data.categories;
    const d = item ? {
      id: item.id, name: item.name, category_id: item.category_id, description: item.description, ingredients: [...item.ingredients],
      price_tenge: tiynText(item.price), weight_g: item.weight_g, kcal: item.kcal, autoKcal: Math.abs(item.kcal - Math.round(4 * item.protein + 9 * item.fat + 4 * item.carbs)) <= 1,
      protein: item.protein, fat: item.fat, carbs: item.carbs, allergens: [...item.allergens], traces: [...item.traces], diets: [...item.diets],
      cook_minutes: item.cook_minutes, emoji: item.emoji, popular: item.popular, new: item.new, available: item.in_stock, image_url: item.image_url,
      options: item.options.map((g) => ({ ...g, choices: g.choices.map((c) => ({ ...c, price_tenge: tiynText(c.price), weight_g: c.weight_g || 0 })) })),
    } : { id: null, name: '', category_id: cats[0] ? cats[0].id : null, description: '', ingredients: [], price_tenge: '', weight_g: '', kcal: 0, autoKcal: true, protein: 0, fat: 0, carbs: 0, allergens: [], traces: [], diets: [], cook_minutes: 10, emoji: '🍽', popular: false, new: true, available: true, image_url: null, options: [] };
    const media = { pending: null, remove: false };
    const catCode = () => (cats.find((c) => c.id === Number(d.category_id)) || {}).code || 'other';
    const calcKcal = () => Math.round(4 * (Number(d.protein) || 0) + 9 * (Number(d.fat) || 0) + 4 * (Number(d.carbs) || 0));
    const photo = () => {
      const src = media.pending || (!media.remove && d.image_url);
      return `<div class="photo-prev ${catClass(catCode())}">${src ? `<img src="${esc(src)}" alt="">` : esc(d.emoji)}</div><div class="stack" style="gap:8px"><div class="row wrap"><label class="btn btn-ghost btn-sm" style="cursor:pointer">${icon('image')}Загрузить фото<input type="file" accept="image/jpeg,image/png,image/webp" id="ed-file" hidden></label>${src ? `<button class="btn btn-ghost btn-sm" data-act="ed-photo-remove">${icon('trash')}Убрать фото</button>` : ''}</div><span class="hint">JPG, PNG или WebP до ${Data.config.limits.max_image_mb} МБ — уменьшим автоматически. Без фото показываем эмодзи.</span></div>`;
    };
    const tri = (a) => { const st = d.allergens.includes(a.code) ? 'contains' : d.traces.includes(a.code) ? 'traces' : ''; return `<button type="button" class="tri ${st}" data-act="ed-tri" data-code="${a.code}" aria-label="${esc(a.name)}: ${st === 'contains' ? 'содержит' : st === 'traces' ? 'возможны следы' : 'нет'}">${a.icon} ${esc(a.name)}<span class="st">${st === 'contains' ? 'содержит' : 'следы'}</span></button>`; };
    const tags = () => `${d.ingredients.map((t, i) => `<span class="tag">${esc(t)}<button type="button" data-act="ed-tag-del" data-i="${i}" aria-label="Убрать ${esc(t)}">${icon('x', 'ic-sm')}</button></span>`).join('')}<input id="ed-tag" placeholder="${d.ingredients.length ? 'Ещё продукт…' : 'Например: говядина — Enter'}" maxlength="40" enterkeyhint="enter">`;
    const kcalWarn = () => { const calc = calcKcal(); const k = d.autoKcal ? calc : Number(d.kcal) || 0; return !d.autoKcal && calc && Math.abs(k - calc) / calc > 0.15 ? `<span class="kcal-check" style="color:var(--saffron-deep)">По БЖУ получается ${calc} ккал — проверьте значение</span>` : `<span class="kcal-check muted">По БЖУ: ${calc} ккал</span>`; };
    const allergenSelect = (gi, ci, c) => selectBox(`ed-ch-alg-${gi}-${ci}`, [{ value: '', label: 'не меняет' }, ...Data.config.allergens.map((a) => ({ value: a.code, label: '+ ' + a.short, icon: a.icon }))], (c.add_allergens || [])[0] || '', { cls: 'mc-alg' });
    const mods = () => d.options.map((g, gi) => `<div class="mod-group"><div class="mod-group-head"><input class="input" data-mod="g-name" data-g="${gi}" value="${esc(g.name)}" placeholder="Название группы, например «Острота»" maxlength="40">${selectBox(`ed-gtype-${gi}`, [{ value: 'single', label: 'Один вариант' }, { value: 'multi', label: 'Несколько' }], g.type)}<button class="icon-btn" data-act="ed-group-del" data-g="${gi}" aria-label="Удалить группу">${icon('trash')}</button></div><div class="row wrap">${g.type === 'single' ? `<label class="switch"><input type="checkbox" data-mod="g-req" data-g="${gi}" ${g.required ? 'checked' : ''}><span class="track"></span><span class="small">Обязательный выбор (первый — по умолчанию)</span></label>` : `<label class="field" style="flex-direction:row;align-items:center;gap:8px"><span class="small">Можно выбрать до</span><input class="input" style="width:72px;min-height:38px" type="number" min="1" max="12" data-mod="g-max" data-g="${gi}" value="${g.max || g.choices.length}"></label>`}</div>${g.choices.map((c, ci) => `<div class="mod-choice"><input class="input" data-mod="c-name" data-g="${gi}" data-c="${ci}" value="${esc(c.name)}" placeholder="Вариант" maxlength="40"><div class="input-wrap"><input class="input" type="text" inputmode="decimal" data-mod="c-price" data-g="${gi}" data-c="${ci}" value="${esc(c.price_tenge || '0')}" aria-label="Доплата в тенге"><span class="input-suffix">₸</span></div><div class="input-wrap mc-kcal"><input class="input" type="number" step="5" data-mod="c-kcal" data-g="${gi}" data-c="${ci}" value="${c.kcal || 0}" aria-label="Калории: минус, если ингредиент убирают"><span class="input-suffix">ккал</span></div><div class="input-wrap mc-kcal"><input class="input" type="number" step="5" data-mod="c-weight" data-g="${gi}" data-c="${ci}" value="${c.weight_g || 0}" aria-label="Граммы: минус, если ингредиент убирают"><span class="input-suffix">г</span></div><button class="icon-btn" data-act="ed-choice-del" data-g="${gi}" data-c="${ci}" aria-label="Удалить вариант">${icon('x')}</button></div><div style="margin:-4px 0 4px">${allergenSelect(gi, ci, c)}</div>`).join('')}<button class="btn btn-ghost btn-sm" data-act="ed-choice-add" data-g="${gi}">${icon('plus')}Вариант</button></div>`).join('');
    const body = () => `<div class="editor">
      <section class="editor-sec"><h3>${icon('image')}Фото и вид в меню</h3><div class="photo-box" id="ed-photo">${photo()}</div><div class="emoji-grid" role="listbox" aria-label="Эмодзи блюда">${FOOD_EMOJI.map((e) => `<button type="button" data-act="ed-emoji" data-e="${e}" class="${e === d.emoji ? 'on' : ''}">${e}</button>`).join('')}</div></section>
      <section class="editor-sec"><h3>${icon('edit')}Основное</h3><div class="grid-2"><label class="field"><span class="label">Название *</span><input class="input" id="ed-name" maxlength="80" value="${esc(d.name)}" placeholder="Например, Плов чайханский"></label><div class="field"><span class="label">Категория *</span>${selectBox('ed-cat', cats.map((c) => ({ value: String(c.id), label: c.name, icon: c.emoji })), String(d.category_id))}</div></div><label class="field"><span class="label">Описание</span><textarea class="textarea" id="ed-desc" maxlength="400" placeholder="Коротко и аппетитно: из чего и как подаётся">${esc(d.description)}</textarea></label><div class="row wrap" style="gap:18px"><label class="switch"><input type="checkbox" id="ed-avail" ${d.available ? 'checked' : ''}><span class="track"></span>В продаже</label><label class="switch"><input type="checkbox" id="ed-pop" ${d.popular ? 'checked' : ''}><span class="track"></span>Хит</label><label class="switch"><input type="checkbox" id="ed-new" ${d.new ? 'checked' : ''}><span class="track"></span>Новинка</label></div></section>
      <section class="editor-sec"><h3>${icon('scale')}Цена и подача</h3><div class="grid-3"><label class="field"><span class="label">Цена *</span><div class="input-wrap"><input class="input" id="ed-price" type="text" inputmode="decimal" value="${esc(d.price_tenge)}" placeholder="3400"><span class="input-suffix">₸</span></div></label><label class="field"><span class="label">Выход</span><div class="input-wrap"><input class="input" id="ed-weight" type="number" min="0" step="10" value="${esc(d.weight_g)}" placeholder="350"><span class="input-suffix">г/мл</span></div></label><label class="field"><span class="label">Готовим *</span><div class="input-wrap"><input class="input" id="ed-cook" type="number" min="1" max="180" value="${esc(d.cook_minutes)}"><span class="input-suffix">мин</span></div></label></div></section>
      <section class="editor-sec"><h3>${icon('chart')}КБЖУ на порцию</h3><div class="grid-4"><label class="field"><span class="label">Белки, г</span><input class="input" data-macro="protein" type="number" min="0" step="0.1" value="${d.protein}"></label><label class="field"><span class="label">Жиры, г</span><input class="input" data-macro="fat" type="number" min="0" step="0.1" value="${d.fat}"></label><label class="field"><span class="label">Углеводы, г</span><input class="input" data-macro="carbs" type="number" min="0" step="0.1" value="${d.carbs}"></label><label class="field"><span class="label">Ккал</span><input class="input" id="ed-kcal" type="number" min="0" value="${d.autoKcal ? calcKcal() : d.kcal}" ${d.autoKcal ? 'disabled' : ''}></label></div><div class="row wrap"><label class="switch"><input type="checkbox" id="ed-auto" ${d.autoKcal ? 'checked' : ''}><span class="track"></span><span class="small">Считать калории по БЖУ</span></label><span id="ed-kcal-check">${kcalWarn()}</span></div></section>
      <section class="editor-sec"><h3>${icon('list')}Состав</h3><div class="tag-input" id="ed-tags">${tags()}</div><span class="hint">Продукты ищутся гостями: «курица», «без лука». Enter или запятая — добавить.</span></section>
      <section class="editor-sec"><h3>${icon('shield')}Аллергены — гостям с ними блюдо не подходит</h3><p class="hint">Одно нажатие — «содержит», второе — «возможны следы», третье — снять отметку.</p><div class="chip-row" id="ed-alg">${Data.config.allergens.map(tri).join('')}</div></section>
      <section class="editor-sec"><h3>${icon('leaf')}Питание и метки</h3><div class="chip-row" id="ed-diets">${Data.config.diets.map((x) => `<button type="button" class="chip ${d.diets.includes(x.code) ? 'on-jade' : ''}" data-act="ed-diet" data-code="${x.code}" aria-pressed="${d.diets.includes(x.code)}"><span class="ico">${x.icon}</span>${esc(x.name)}</button>`).join('')}</div></section>
      <section class="editor-sec"><h3>${icon('sparkles')}Модификаторы</h3><p class="hint">Острота, размер порции, добавки, прожарка. Добавка может добавить аллерген — гость и кухня увидят это.</p><div class="stack" id="ed-mods">${mods()}</div><button class="btn btn-soft btn-sm" style="align-self:flex-start" data-act="ed-group-add">${icon('plus')}Группа модификаторов</button></section>
      <div class="form-error" id="ed-error" hidden></div></div>`;
    const syncFields = (sheet) => {
      const el = sheet.el;
      d.name = qs('#ed-name', el).value.trim();
      d.description = qs('#ed-desc', el).value.trim();
      d.price_tenge = qs('#ed-price', el).value;
      d.weight_g = qs('#ed-weight', el).value;
      d.cook_minutes = qs('#ed-cook', el).value;
      d.available = qs('#ed-avail', el).checked;
      d.popular = qs('#ed-pop', el).checked;
      d.new = qs('#ed-new', el).checked;
      qsa('[data-macro]', el).forEach((i) => { d[i.dataset.macro] = Number(i.value) || 0; });
      d.autoKcal = qs('#ed-auto', el).checked;
      if (!d.autoKcal) d.kcal = Number(qs('#ed-kcal', el).value) || 0;
      qsa('[data-mod]', el).forEach((i) => {
        const g = d.options[Number(i.dataset.g)];
        if (!g) return;
        const c = i.dataset.c != null ? g.choices[Number(i.dataset.c)] : null;
        if (i.dataset.mod === 'g-name') g.name = i.value;
        if (i.dataset.mod === 'g-req') g.required = i.checked;
        if (i.dataset.mod === 'g-max') g.max = Number(i.value) || 1;
        if (c && i.dataset.mod === 'c-name') c.name = i.value;
        if (c && i.dataset.mod === 'c-price') c.price_tenge = i.value.trim();
        if (c && i.dataset.mod === 'c-weight') c.weight_g = Number(i.value) || 0;
        if (c && i.dataset.mod === 'c-kcal') c.kcal = Number(i.value) || 0;
      });
      const pending = qs('#ed-tag', el);
      if (pending && pending.value.trim()) { addTag(pending.value); pending.value = ''; }
    };
    const addTag = (raw) => raw.split(',').map((s) => s.trim()).filter(Boolean).forEach((t) => { if (!d.ingredients.some((x) => x.toLowerCase() === t.toLowerCase()) && d.ingredients.length < 40) d.ingredients.push(t.slice(0, 40)); });
    const redrawTags = (el) => { qs('#ed-tags', el).innerHTML = tags(); bindTag(el); const inp = qs('#ed-tag', el); inp.focus(); };
    const bindTag = (el) => {
      const inp = qs('#ed-tag', el);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); if (inp.value.trim()) { addTag(inp.value); redrawTags(el); } }
        if (e.key === 'Backspace' && !inp.value && d.ingredients.length) { d.ingredients.pop(); redrawTags(el); }
      });
      inp.addEventListener('blur', () => { if (inp.value.trim()) { addTag(inp.value); qs('#ed-tags', el).innerHTML = tags(); bindTag(el); } });
    };
    const redrawMods = (sheet) => { syncFields(sheet); qs('#ed-mods', sheet.el).innerHTML = mods(); };
    const bind = (sheet) => {
      const el = sheet.el;
      bindTag(el);
      el.addEventListener('input', (e) => {
        if (e.target.matches('[data-macro], #ed-kcal')) { syncFields(sheet); if (d.autoKcal) qs('#ed-kcal', el).value = calcKcal(); qs('#ed-kcal-check', el).innerHTML = kcalWarn(); }
      });
      el.addEventListener('change', async (e) => {
        if (e.target.id === 'ed-auto') { syncFields(sheet); const k = qs('#ed-kcal', el); k.disabled = d.autoKcal; if (d.autoKcal) k.value = calcKcal(); qs('#ed-kcal-check', el).innerHTML = kcalWarn(); }
        if (e.target.id === 'ed-file' && e.target.files[0]) {
          try { media.pending = await fileToDataUrl(e.target.files[0]); media.remove = false; qs('#ed-photo', el).innerHTML = photo(); toast('Фото будет сохранено вместе с блюдом', 'info', { ms: 1800 }); }
          catch (err) { showError(err); }
        }
      });
    };
    const validate = () => {
      if (d.name.length < 2) return 'Название — минимум 2 символа';
      if (!d.category_id) return 'Выберите категорию';
      if (toTiyn(d.price_tenge) === null || toTiyn(d.price_tenge) < 0) return 'Цена — число в тенге, например 3400 или 3400,50';
      const cook = Number(d.cook_minutes);
      if (!(cook >= 1 && cook <= 180)) return 'Время приготовления — от 1 до 180 минут';
      for (const g of d.options) {
        if (!g.name.trim()) return 'У группы модификаторов нет названия';
        if (!g.choices.length) return `В группе «${g.name}» нет вариантов`;
        if (g.choices.some((c) => !c.name.trim())) return `В группе «${g.name}» есть вариант без названия`;
        if (g.choices.some((c) => toTiyn(c.price_tenge || '0') === null)) return `В группе «${g.name}» доплата должна быть числом`;
      }
      if (d.diets.includes('vegan') && d.allergens.some((a) => ['milk', 'eggs', 'fish', 'crustaceans', 'molluscs'].includes(a))) return 'Веганское блюдо не может содержать молоко, яйца, рыбу или морепродукты';
      return null;
    };
    const payload = () => ({
      name: d.name, category_id: Number(d.category_id), description: d.description, ingredients: d.ingredients, price_tiyn: toTiyn(d.price_tenge),
      weight_g: Number(d.weight_g) || 0, kcal: d.autoKcal ? null : Number(d.kcal) || 0, protein: Number(d.protein) || 0, fat: Number(d.fat) || 0, carbs: Number(d.carbs) || 0,
      allergens: d.allergens, traces: d.traces, diets: d.diets, cook_minutes: Number(d.cook_minutes), emoji: d.emoji, popular: d.popular, new: d.new, available: d.available,
      options: d.options.map((g) => ({ id: g.id || null, name: g.name.trim(), type: g.type, required: g.type === 'single' && !!g.required, max: g.type === 'single' ? 1 : Math.max(1, Math.min(g.choices.length, Number(g.max) || g.choices.length)), choices: g.choices.map((c) => ({ id: c.id || null, name: c.name.trim(), price_tiyn: toTiyn(c.price_tenge || '0') || 0, kcal: Number(c.kcal) || 0, weight_g: Number(c.weight_g) || 0, protein: Number(c.protein) || 0, fat: Number(c.fat) || 0, carbs: Number(c.carbs) || 0, add_allergens: c.add_allergens || [], remove_allergens: c.remove_allergens || [], add_traces: c.add_traces || [] })) })),
    });
    const sheet = openSheet({
      title: item ? `Блюдо: ${item.name}` : 'Новое блюдо', size: 'xl', body: body(),
      foot: `${item ? `<button class="btn btn-danger-soft" data-act="ed-delete">${icon('trash')}Удалить</button>` : ''}<button class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary" data-act="ed-save">${icon('check')}Сохранить</button>`,
      actions: {
        'ed-emoji'(el) { d.emoji = el.dataset.e; qsa('[data-act="ed-emoji"]', sheet.el).forEach((b) => b.classList.toggle('on', b === el)); qs('#ed-photo', sheet.el).innerHTML = photo(); },
        'ed-photo-remove'() { media.pending = null; media.remove = true; qs('#ed-photo', sheet.el).innerHTML = photo(); },
        'ed-tri'(el) {
          const code = el.dataset.code;
          if (d.allergens.includes(code)) { d.allergens = d.allergens.filter((x) => x !== code); d.traces.push(code); }
          else if (d.traces.includes(code)) d.traces = d.traces.filter((x) => x !== code);
          else d.allergens.push(code);
          el.outerHTML = tri(Data.allergen(code));
        },
        'ed-diet'(el) { toggleIn(d.diets, el.dataset.code); el.classList.toggle('on-jade'); el.setAttribute('aria-pressed', d.diets.includes(el.dataset.code)); },
        'ed-tag-del'(el) { d.ingredients.splice(Number(el.dataset.i), 1); redrawTags(sheet.el); },
        'ed-group-add'() { syncFields(sheet); d.options.push({ id: null, name: '', type: 'single', required: true, max: 1, choices: [{ id: null, name: '', price_tenge: '0', kcal: 0, weight_g: 0 }, { id: null, name: '', price_tenge: '0', kcal: 0, weight_g: 0 }] }); qs('#ed-mods', sheet.el).innerHTML = mods(); },
        'ed-group-del'(el) { syncFields(sheet); d.options.splice(Number(el.dataset.g), 1); qs('#ed-mods', sheet.el).innerHTML = mods(); },
        'ed-choice-add'(el) { syncFields(sheet); const g = d.options[Number(el.dataset.g)]; if (g.choices.length >= 12) { toast('Не больше 12 вариантов', 'warn'); return; } g.choices.push({ id: null, name: '', price_tenge: '0', kcal: 0, weight_g: 0 }); redrawMods(sheet); },
        'ed-choice-del'(el) { syncFields(sheet); const g = d.options[Number(el.dataset.g)]; g.choices.splice(Number(el.dataset.c), 1); qs('#ed-mods', sheet.el).innerHTML = mods(); },
        'select:ed-cat'(value) { d.category_id = Number(value); qs('#ed-photo', sheet.el).innerHTML = photo(); },
        async 'ed-save'(el) {
          syncFields(sheet);
          const err = qs('#ed-error', sheet.el);
          const problem = validate();
          if (problem) { err.hidden = false; err.textContent = problem; err.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
          err.hidden = true;
          await busy(el, async () => {
            try {
              const res = d.id ? await sapi('PUT', `/api/admin/menu/${d.id}`, payload()) : await sapi('POST', '/api/admin/menu', payload());
              if (media.pending) await sapi('PUT', `/api/admin/menu/${res.item.id}/image`, { data_url: media.pending });
              else if (media.remove && d.image_url) await sapi('DELETE', `/api/admin/menu/${res.item.id}/image`);
              sheet.close();
              toast(d.id ? 'Блюдо сохранено — гости уже видят изменения' : 'Блюдо добавлено в меню', 'success');
              Data.getMenu(true).catch(() => {});
              await Admin.menuTab();
            } catch (e2) { err.hidden = false; err.textContent = e2.message; err.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
          });
        },
        async 'ed-delete'() { sheet.close(); await Admin.deleteDish(d.id); },
      },
    });
    sheet.el.addEventListener('select', (e) => {
      const name = e.detail.name;
      let m = name.match(/^ed-gtype-(\d+)$/);
      if (m) { syncFields(sheet); const g = d.options[Number(m[1])]; g.type = e.detail.value; if (g.type === 'multi') g.required = false; else g.max = 1; qs('#ed-mods', sheet.el).innerHTML = mods(); return; }
      m = name.match(/^ed-ch-alg-(\d+)-(\d+)$/);
      if (m) { const c = d.options[Number(m[1])].choices[Number(m[2])]; c.add_allergens = e.detail.value ? [e.detail.value] : []; }
    });
    bind(sheet);
  },
  async deleteDish(id) {
    const item = this.data.items.find((x) => x.id === Number(id));
    const ok = await confirmBox({ title: `Удалить «${item.name}»?`, text: 'Если блюдо уже заказывали, оно уйдёт в архив — история и чеки сохранятся. Из незаказанных корзин позиция удалится, гости получат уведомление.', ok: 'Удалить', danger: true });
    if (!ok) return;
    const res = await sapi('DELETE', `/api/admin/menu/${id}`);
    toast(res.mode === 'archived' ? 'Блюдо перенесено в архив' : 'Блюдо удалено', 'success');
    Data.getMenu(true).catch(() => {});
    await this.menuTab();
  },

  async categoriesTab() {
    const res = await sapi('GET', '/api/admin/categories');
    this.cats = res.items;
    this.setBody(`<div class="toolbar"><h2 class="section-title" style="margin-right:auto">Категории меню</h2><button class="btn btn-primary" data-act="cat-new">${icon('plus')}Категория</button></div><div class="card">${this.cats.map((c, i) => `<div class="list-row"><span class="emo">${esc(c.emoji)}</span><div class="grow"><b>${esc(c.name)}</b><div class="tiny muted">${pl(c.items_count, 'блюдо', 'блюда', 'блюд')}${c.active ? '' : ' · скрыта от гостей'}</div></div><button class="icon-btn" data-act="cat-move" data-i="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Выше">${icon('up')}</button><button class="icon-btn" data-act="cat-move" data-i="${i}" data-d="1" ${i === this.cats.length - 1 ? 'disabled' : ''} aria-label="Ниже">${icon('down')}</button><button class="icon-btn" data-act="cat-edit" data-id="${c.id}" aria-label="Изменить">${icon('edit')}</button><button class="icon-btn" data-act="cat-del" data-id="${c.id}" aria-label="Удалить" ${c.items_count ? `title="Сначала перенесите блюда"` : ''}>${icon('trash')}</button></div>`).join('')}</div>`);
  },
  categorySheet(cat) {
    const draft = { name: cat ? cat.name : '', emoji: cat ? cat.emoji : '🍽', active: cat ? cat.active : true };
    openSheet({
      title: cat ? 'Категория' : 'Новая категория', size: 'sm',
      body: `<div class="stack"><label class="field"><span class="label">Название</span><input class="input" id="cat-name" maxlength="40" value="${esc(draft.name)}"></label><div class="field"><span class="label">Иконка</span><div class="emoji-grid">${FOOD_EMOJI.map((e) => `<button type="button" data-act="cat-emoji" data-e="${e}" class="${e === draft.emoji ? 'on' : ''}">${e}</button>`).join('')}</div></div><label class="switch"><input type="checkbox" id="cat-active" ${draft.active ? 'checked' : ''}><span class="track"></span>Показывать гостям</label><div class="form-error" id="cat-err" hidden></div></div>`,
      foot: '<button class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary" data-act="cat-save">Сохранить</button>',
      actions: {
        'cat-emoji'(el, e, sheet) { draft.emoji = el.dataset.e; qsa('[data-act="cat-emoji"]', sheet.el).forEach((b) => b.classList.toggle('on', b === el)); },
        async 'cat-save'(el, e, sheet) {
          const name = qs('#cat-name', sheet.el).value.trim();
          const err = qs('#cat-err', sheet.el);
          if (!name) { err.hidden = false; err.textContent = 'Введите название'; return; }
          await busy(el, async () => {
            try { await sapi(cat ? 'PUT' : 'POST', cat ? `/api/admin/categories/${cat.id}` : '/api/admin/categories', { name, emoji: draft.emoji, active: qs('#cat-active', sheet.el).checked }); sheet.close(); toast('Категория сохранена', 'success'); Data.getMenu(true).catch(() => {}); await Admin.categoriesTab(); }
            catch (e2) { err.hidden = false; err.textContent = e2.message; }
          });
        },
      },
    });
  },

  async tablesTab() {
    const res = await sapi('GET', '/api/admin/tables');
    this.tables = res.items;
    this.access = res.access;
    const a = res.access;
    const limit = Data.config.limits.max_tables;
    this.setBody(`<div class="toolbar"><h2 class="section-title grow-title">Столы и QR-коды <span class="badge">${this.tables.length} из ${limit}</span></h2><button class="btn btn-ghost" data-act="tables-print">${icon('print')}<span class="hide-sm">Печать QR</span></button><button class="btn btn-ghost" data-act="tables-auto">${icon('grid')}<span class="hide-sm">Расставить ровно</span></button><button class="btn btn-soft" data-act="tables-bulk">${icon('qr')}Добавить несколько</button><button class="btn btn-primary" data-act="table-new">${icon('plus')}Стол</button></div>
      <div class="notice ${a.public ? 'ok' : 'danger'} mb-14">${icon(a.public ? 'globe' : 'wifi')}<span>${a.public ? `QR ведут на публичный адрес <b>${esc(a.base)}</b> — открываются с мобильного интернета.` : `QR сейчас ведут на <b>${esc(a.base)}</b> — это работает только в локальной сети. Запустите сервер с туннелем или задайте свой домен в «Настройках» перед печатью.`} Один QR — один стол: гости этого стола попадают в общую сессию.</span></div>
      <section class="card card-pad hm-editor"><div class="row-between hm-editor-head"><div><b>Расстановка зала</b><div class="small muted">Перетащите стол, чтобы поставить его как в зале. Нажмите на стол — изменить название, зону и число мест. Гости увидят ту же карту на главной.</div></div></div><div id="adm-map">${HallMap.html(this.mapTables(), { edit: true })}</div>${HallMap.legend([['free', 'Свободен'], ['solo', 'Один гость'], ['company', 'Компания']])}</section>
      ${this.tables.length > 8 ? `<div class="search-box tables-search">${icon('search')}<input class="input" id="tables-q" type="search" placeholder="Найти стол по номеру или зоне" value="${esc(this.tablesQ || '')}"></div>` : ''}
      <div class="qr-grid" id="qr-grid">${this.qrCards()}</div>`);
    const q = qs('#tables-q');
    if (q) q.addEventListener('input', debounce(() => { this.tablesQ = q.value; qs('#qr-grid').innerHTML = this.qrCards(); }, 160));
    this.bindMap();
  },
  qrCards() {
    const q = (this.tablesQ || '').trim().toLowerCase();
    const list = this.tables.filter((t) => !q || t.label.toLowerCase().includes(q) || (t.zone || '').toLowerCase().includes(q));
    if (!list.length) return '<div class="empty"><div class="empty-art">🔎</div><h3>Столы не найдены</h3><p>Измените запрос или добавьте стол.</p></div>';
    const base = encodeURIComponent((this.access || {}).base || '');
    return list.map((t) => `<article class="qr-card ${t.active ? '' : 'archived'}"><div class="row-between"><div><b class="num qr-card-title">${esc(t.label)}</b><div class="tiny muted">${esc(t.zone || 'без зоны')} · ${pl(t.seats, 'место', 'места', 'мест')}</div></div>${t.busy ? `<span class="badge jade">${pl(t.guests, 'гость', 'гостя', 'гостей')}</span>` : `<span class="badge">${t.active ? 'свободен' : 'выключен'}</span>`}</div><img src="${esc(t.qr_url)}?v=${base}" alt="QR ${esc(t.label)}" width="200" height="200" loading="lazy" decoding="async"><div class="url">${esc(t.join_url)}</div><div class="row wrap"><button class="btn btn-ghost btn-sm" data-act="table-edit" data-id="${t.id}">${icon('edit')}Изменить</button><button class="btn btn-ghost btn-sm" data-act="table-copy" data-url="${esc(t.join_url)}">${icon('copy')}Ссылка</button><button class="btn btn-ghost btn-sm" data-act="table-rotate" data-id="${t.id}">${icon('refresh')}Новый QR</button><button class="icon-btn" data-act="table-delete" data-id="${t.id}" aria-label="Удалить ${esc(t.label)}" title="Удалить стол">${icon('trash')}</button></div></article>`).join('');
  },
  bulkSheet(after) {
    const limit = Data.config.limits.max_tables;
    const left = Math.max(0, limit - (this.tables || []).length);
    if (!left) { toast(`Уже ${limit} столов — это максимум. Удалите лишние, чтобы добавить новые`, 'warn'); return; }
    openSheet({
      title: 'Добавить столы с QR', size: 'sm',
      body: `<form class="stack" id="bulk-form" novalidate><p class="small muted">Сразу создадим столы с уникальными QR-кодами и поставим их на свободные места карты. Сейчас можно добавить ещё <b>${left}</b> (максимум ${limit}).</p><div class="grid-2"><label class="field"><span class="label">Сколько столов</span><input class="input" name="count" type="number" min="1" max="${Math.min(100, left)}" value="${Math.min(10, left)}" inputmode="numeric"></label><label class="field"><span class="label">Мест за столом</span><input class="input" name="seats" type="number" min="1" max="40" value="4" inputmode="numeric"></label></div><div class="grid-2"><label class="field"><span class="label">Название</span><input class="input" name="prefix" maxlength="20" value="Стол"><span class="hint">Номера продолжатся: «Стол 6», «Стол 7»…</span></label><label class="field"><span class="label">Зона</span><input class="input" name="zone" maxlength="40" placeholder="Например, Терраса"></label></div><div class="form-error" id="bulk-err" hidden></div></form>`,
      foot: `<button class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary" data-act="bulk-go">${icon('qr')}Создать QR-коды</button>`,
      actions: {
        async 'bulk-go'(el, e, sheet) {
          const f = qs('#bulk-form', sheet.el);
          const err = qs('#bulk-err', sheet.el);
          const count = Number(f.count.value);
          if (!(count >= 1 && count <= Math.min(100, left))) { err.hidden = false; err.textContent = `Укажите от 1 до ${Math.min(100, left)}`; return; }
          await busy(el, async () => {
            try {
              const res = await sapi('POST', '/api/admin/tables/bulk', { count, seats: Number(f.seats.value) || 4, zone: f.zone.value.trim(), prefix: f.prefix.value.trim() || 'Стол' });
              sheet.close();
              toast(`Готово: ${pl(res.created.length, 'новый стол', 'новых стола', 'новых столов')} с QR`, 'success');
              if (after) await after();
            } catch (e2) { err.hidden = false; err.textContent = e2.message; }
          });
        },
      },
    });
  },
  mapTables() {
    return this.tables.map((t) => ({ key: String(t.id), label: t.label, zone: t.zone, seats: t.seats, x: t.x, y: t.y, state: t.busy ? (t.guests > 1 ? 'company' : 'solo') : 'free', text: '', guests: t.guests, people: [], active: t.active }));
  },
  bindMap() {
    const svg = qs('#adm-map svg');
    if (!svg) return;
    let drag = null;
    const toPct = (e) => { const r = svg.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 }; };
    svg.addEventListener('pointerdown', (e) => {
      const g = e.target.closest('.hm-table');
      if (!g) return;
      const t = this.tables.find((x) => String(x.id) === g.dataset.key);
      const p = toPct(e);
      drag = { g, t, dx: t.x - p.x, dy: t.y - p.y, moved: false, sx: e.clientX, sy: e.clientY };
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag || (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5)) return;
      drag.moved = true;
      svg.classList.add('dragging');
      const p = toPct(e);
      drag.t.x = Math.round(Math.min(94, Math.max(6, p.x + drag.dx)));
      drag.t.y = Math.round(Math.min(92, Math.max(8, p.y + drag.dy)));
      drag.g.setAttribute('transform', `translate(${((drag.t.x / 100) * HallMap.W).toFixed(1)},${((drag.t.y / 100) * HallMap.H).toFixed(1)})`);
      qs('.hm-zones', svg).innerHTML = HallMap.zonesHtml(this.mapTables());
    });
    const finish = async () => {
      if (!drag) return;
      const { t, moved } = drag;
      drag = null;
      svg.classList.remove('dragging');
      if (!moved) { this.tableSheet(t); return; }
      this.quietUntil = Date.now() + 1500;
      try { await sapi('POST', '/api/admin/tables/layout', { items: [{ id: t.id, x: t.x, y: t.y }] }); toast(`${t.label}: место сохранено`, 'success', { ms: 1400 }); }
      catch (err) { showError(err); await Admin.tablesTab(); }
    };
    svg.addEventListener('pointerup', finish);
    svg.addEventListener('pointercancel', finish);
  },
  tableSheet(t) {
    openSheet({
      title: t ? t.label : 'Новый стол', size: 'sm',
      body: `<div class="stack"><label class="field"><span class="label">Название</span><input class="input" id="tb-label" maxlength="30" value="${esc(t ? t.label : `Стол ${(this.tables || []).length + 1}`)}"></label><label class="field"><span class="label">Зона</span><input class="input" id="tb-zone" maxlength="40" value="${esc(t ? t.zone : '')}" placeholder="Терраса, у окна, VIP"></label><label class="field"><span class="label">Мест</span><input class="input" id="tb-seats" type="number" min="1" max="40" value="${t ? t.seats : 4}"></label><label class="switch"><input type="checkbox" id="tb-active" ${!t || t.active ? 'checked' : ''}><span class="track"></span>Стол обслуживается</label><div class="form-error" id="tb-err" hidden></div></div>`,
      foot: '<button class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary" data-act="tb-save">Сохранить</button>',
      actions: {
        async 'tb-save'(el, e, sheet) {
          const err = qs('#tb-err', sheet.el);
          await busy(el, async () => {
            try { await sapi(t ? 'PUT' : 'POST', t ? `/api/admin/tables/${t.id}` : '/api/admin/tables', { label: qs('#tb-label', sheet.el).value.trim(), zone: qs('#tb-zone', sheet.el).value.trim(), seats: Number(qs('#tb-seats', sheet.el).value) || 1, active: qs('#tb-active', sheet.el).checked }); sheet.close(); toast('Стол сохранён', 'success'); await Admin.tablesTab(); }
            catch (e2) { err.hidden = false; err.textContent = e2.message; }
          });
        },
      },
    });
  },

  async analyticsTab() {
    const r = await sapi('GET', `/api/admin/analytics?days=${this.period}`);
    const k = r.kpi;
    const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
    const kpis = [
      ['kpi-hero', 'Выручка', moneyShort(k.revenue), `блюда ${moneyShort(k.items_revenue)} + обслуживание ${moneyShort(k.service)}`],
      ['', 'Заказов', fmt0(k.orders), `${pl(k.sessions, 'стол', 'стола', 'столов')} · ${pl(k.guests, 'гость', 'гостя', 'гостей')}`],
      ['', 'Средний чек гостя', money(Math.round(k.avg_check_guest / 100) * 100), `стола — ${money(Math.round(k.avg_check_table / 100) * 100)}`],
      ['', 'Время отдачи', k.avg_ticket_minutes == null ? '—' : fmt1(k.avg_ticket_minutes) + ' мин', `вовремя по ETA: ${pct(k.on_time_rate)}`],
      ['', 'Раздельная оплата', `${k.split_sessions} ${plural(k.split_sessions, 'стол', 'стола', 'столов')}`, `≈ ${fmt1(k.split_minutes_saved / 60)} ч официантов сэкономлено (оценка 9 мин на стол)`],
      ['', 'Компании', pct(k.group_share), `средний размер ${fmt1(k.avg_party)} гостя`],
      ['', 'Дозаказы с телефона', pct(k.reorder_share), 'столов заказали ещё раз'],
      ['', 'Чаевые', moneyShort(k.tips), `в среднем ${fmt1(k.tip_rate * 100)}% от безнала`],
    ];
    const daily = r.daily.map((x) => ({ ...x, d: new Date(x.date + 'T00:00:00') }));
    this.setBody(`<div class="toolbar"><h2 class="section-title" style="margin-right:auto">Аналитика</h2>${r.demo_data ? '<span class="badge caution">включает демо-историю</span>' : ''}<div class="seg">${[[1, 'Сегодня'], [7, '7 дней'], [14, '14 дней'], [30, '30 дней']].map(([v, l]) => `<button data-act="period" data-v="${v}" class="${this.period === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="kpi-grid">${kpis.map(([cls, l, v, s]) => `<div class="kpi ${cls}"><span>${l}</span><b>${esc(v)}</b><small>${esc(s)}</small></div>`).join('')}</div>
      <div class="charts"><div class="chart-card"><h3>Выручка по дням</h3><div class="sub">Наведите на столбец, чтобы увидеть сумму</div>${barChart(daily, { title: 'Выручка по дням', label: (x) => x.d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'numeric' }), value: (x) => x.revenue, tip: (x) => `${x.d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}: ${money(x.revenue)}`, fmt: moneyShort })}</div>
      <div class="chart-card"><h3>Заказы по часам</h3><div class="sub">Пики нагрузки на кухню</div>${barChart(r.hours, { title: 'Заказы по часам', label: (x) => x.hour, value: (x) => x.orders, tip: (x) => `${x.hour}:00–${x.hour + 1}:00 · ${pl(x.orders, 'заказ', 'заказа', 'заказов')} · ${money(x.revenue)}`, fmt: (v) => String(Math.round(v)) })}</div></div>
      <div class="charts"><div class="chart-card"><h3>Топ-10 блюд</h3><div class="sub">По количеству порций</div>${r.top_dishes.length ? hbars(r.top_dishes, { name: (x) => `${esc(x.emoji)} ${esc(x.name)}`, value: (x) => x.qty, valueText: (x) => `${x.qty} шт · ${moneyShort(x.revenue)}` }) : '<p class="muted small" style="margin-top:12px">Пока нет заказов</p>'}</div>
      <div class="chart-card"><h3>Категории</h3><div class="sub">Доля выручки</div>${r.categories.length ? hbars(r.categories, { name: (x) => `${esc(x.emoji)} ${esc(x.name)}`, value: (x) => x.revenue, valueText: (x) => moneyShort(x.revenue) }) : '<p class="muted small" style="margin-top:12px">Пока нет заказов</p>'}<h3 style="margin-top:18px">Способы оплаты</h3>${r.payment_methods.length ? hbars(r.payment_methods, { name: (x) => esc(x.title), value: (x) => x.amount, valueText: (x) => `${x.count} · ${moneyShort(x.amount)}` }) : '<p class="muted small">Оплат пока нет</p>'}<div class="notice info" style="margin-top:16px">${icon('shield')}<span>Гостей с профилем аллергий: <b>${k.allergy_guests}</b>. Позиций с пометкой для кухни: <b>${k.allergy_flagged_items}</b>. Отменено кухней: ${k.cancelled_items}. Средняя калорийность заказа гостя: ${fmt0(k.avg_kcal_guest)} ккал.</span></div></div></div>`);
  },

  async settingsTab() {
    const [rest, sys, staff, tables] = await Promise.all([sapi('GET', '/api/admin/restaurant'), sapi('GET', '/api/admin/system'), sapi('GET', '/api/admin/staff'), sapi('GET', '/api/admin/tables')]);
    this.tables = tables.items;
    this.staff = staff.items;
    const t = sys.access.tunnel || {};
    const up = sys.uptime_s;
    const limit = Data.config.limits.max_tables;
    const providers = { cloudflared: 'Cloudflare (случайный адрес)', named: 'Свой домен через Cloudflare', serveo: 'Serveo', ssh: 'localhost.run' };
    this.setBody(`<div class="settings-grid">
      <section class="chart-card"><h3>${icon('settings')}Ресторан</h3><div class="stack mt-12"><label class="field"><span class="label">Название</span><input class="input" id="st-name" maxlength="60" value="${esc(rest.name)}"></label><label class="field"><span class="label">Город</span><input class="input" id="st-city" maxlength="40" value="${esc(rest.city)}"></label><label class="field"><span class="label">Обслуживание, %</span><div class="input-wrap"><input class="input" id="st-service" type="number" min="0" max="30" step="0.5" value="${rest.service_percent}"><span class="input-suffix">%</span></div><span class="hint">Применяется к новым столам. Для офисных обедов — 0%.</span></label><div class="form-error" id="st-err" hidden></div><button class="btn btn-primary self-start" data-act="st-save">${icon('check')}Сохранить</button></div></section>
      <section class="chart-card"><h3>${icon('qr')}Столы и QR-коды</h3><div class="qr-meter mt-12"><div class="row-between"><b class="num">${this.tables.length} из ${limit}</b><span class="small muted">столов с QR</span></div><div class="mini-bar"><i style="width:${Math.min(100, (this.tables.length / limit) * 100)}%"></i></div></div><p class="small muted mt-10">У каждого стола свой QR. Добавьте сразу пачку — коды появятся на карте зала и в печати.</p><div class="row wrap mt-12"><button class="btn btn-primary" data-act="tables-bulk">${icon('plus')}Добавить столы</button><button class="btn btn-ghost" data-act="admin-goto" data-tab="tables">${icon('table')}Карта и печать</button></div></section>
      <section class="chart-card"><h3>${icon('users')}Сотрудники</h3><p class="small muted mt-6">Вход по логину и паролю. После смены пароля старые входы этого сотрудника сразу перестают работать.</p><div class="staff-list">${this.staff.map((u) => `<div class="staff-row"><span class="staff-ic">${(ROLE_META[u.role] || {}).icon || '👤'}</span><div class="grow"><b>${esc(u.display_name || u.role_title)}</b><span class="tiny muted">логин <code>${esc(u.username)}</code> · ${u.last_login_at ? 'входил ' + new Date(u.last_login_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'ещё не входил'}</span></div><button class="btn btn-ghost btn-sm" data-act="staff-pass" data-id="${u.id}">${icon('key')}Пароль</button></div>`).join('')}</div></section>
      <section class="chart-card"><h3>${icon('globe')}Публичный адрес QR</h3><div class="stack mt-12"><div class="notice ${sys.access.public ? 'ok' : 'danger'}">${icon(sys.access.public ? 'globe' : 'wifi')}<span>${sys.access.public ? `Сейчас: <b>${esc(sys.access.base)}</b>${t.provider ? ' · ' + esc(providers[t.provider] || t.provider) : ''}${t.verified ? ' · проверен' : ''}` : `Сейчас только локальная сеть: <b>${esc(sys.access.base)}</b>`}</span></div>${t.register_url ? `<div class="notice">${icon('key')}<span>Чтобы получить адрес <b>foodbuster</b> на serveo, один раз привяжите ключ: <a href="${esc(t.register_url)}" target="_blank" rel="noopener">открыть регистрацию</a></span></div>` : ''}<details class="domain-help"><summary>Как сделать красивый постоянный адрес</summary><ol class="small"><li>Купите домен, например <b>foodbuster.kz</b>, и добавьте его в бесплатный Cloudflare.</li><li>В Cloudflare Zero Trust → Tunnels создайте туннель на <code>http://127.0.0.1:${location.port || 8097}</code> и скопируйте токен.</li><li>В файл <code>.env</code> рядом с backend.py впишите <code>FOODBUSTER_PUBLIC_URL=https://foodbuster.kz</code> и <code>FOODBUSTER_CLOUDFLARE_TUNNEL_TOKEN=…</code>, перезапустите сервер.</li><li>Без своего домена: <code>FOODBUSTER_TUNNEL=serveo</code> даст адрес вида <b>foodbuster.serveousercontent.com</b> после привязки ключа.</li></ol></details></div></section>
      <section class="chart-card"><h3>${icon('chart')}Система</h3><div class="sys-grid mt-12"><div class="sys-item"><span>Версия</span><b>Foodbuster ${esc(sys.version)} · Python ${esc(sys.python)}</b></div><div class="sys-item"><span>Работает</span><b>${Math.floor(up / 3600)} ч ${Math.floor((up % 3600) / 60)} мин</b></div><div class="sys-item"><span>База данных</span><b>${sys.db_bytes > 1048576 ? fmt1(sys.db_bytes / 1048576) + ' МБ' : Math.max(1, Math.round(sys.db_bytes / 1024)) + ' КБ'} · SQLite WAL</b></div><div class="sys-item"><span>Вебхуки POS/KDS</span><b>${sys.webhooks.configured ? `${sys.webhooks.configured} адрес · доставлено ${sys.webhooks.delivered}` : 'не настроены'}</b></div><div class="sys-item"><span>Экранов персонала онлайн</span><b>${sys.listeners.staff}</b></div><div class="sys-item"><span>Фоновые проверки</span><b>${sys.maintenance_runs}</b></div></div><p class="small muted mt-12">API и документация: <a href="/docs" target="_blank" rel="noopener">/docs</a>. Архитектура готова к PostgreSQL, Kaspi Pay / Halyk ePay и KDS-принтерам через вебхуки.</p></section>
      <section class="chart-card"><h3>${icon('refresh')}Демо-данные</h3><p class="small muted mt-6">Сброс удалит заказы и оплаты и заново создаст демо-историю и компанию за столом 4.</p><div class="row wrap mt-12"><button class="btn btn-ghost" data-act="reset" data-full="0">${icon('refresh')}Сбросить заказы, меню оставить</button><button class="btn btn-danger-soft" data-act="reset" data-full="1">${icon('trash')}Полный сброс, включая меню</button></div></section>
    </div>`);
  },

  async auditTab(more = false) {
    if (!more) { this.auditOffset = 0; this.auditItems = []; }
    const res = await sapi('GET', `/api/admin/audit?limit=60&offset=${this.auditOffset}`);
    this.auditItems = this.auditItems.concat(res.items);
    this.auditOffset += res.items.length;
    const stRu = (k) => ({ ...Object.fromEntries(STEP_LABELS), queued: 'В очереди', cancelled: 'Отменён' })[k] || k;
    const detail = (r) => { const p = r.payload || {}; return [p.name, p.number ? '№' + String(p.number).padStart(3, '0') : '', p.from && p.to ? `${stRu(p.from)} → ${stRu(p.to)}` : p.to ? stRu(p.to) : '', p.amount != null ? money(p.amount) : '', p.reason || '', p.table || ''].filter(Boolean).join(' · '); };
    this.setBody(`<div class="toolbar"><h2 class="section-title" style="margin-right:auto">Журнал действий</h2><span class="badge">${res.total} записей</span></div><div class="card">${this.auditItems.map((r) => `<div class="audit-row"><time>${new Date(r.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time><span class="badge ${r.actor_type === 'staff' ? 'ink' : r.actor_type === 'guest' ? 'sky' : ''}">${esc(ROLE_RU[r.actor] || r.actor || r.actor_type)}</span><span><b>${esc(AUDIT_LABELS[r.action] || r.action)}</b> <span class="muted">${esc(detail(r))}</span></span></div>`).join('') || '<div class="empty">Записей пока нет</div>'}</div>${this.auditOffset < res.total ? `<button class="btn btn-ghost" style="margin-top:12px" data-act="audit-more">Показать ещё</button>` : ''}`);
  },

  actions: {
    'admin-tab'(el) { Admin.tab = el.dataset.tab; store.set('admin-tab', Admin.tab); qsa('.admin-tabs button').forEach((b) => b.classList.toggle('on', b === el)); qs('#admin-body').innerHTML = '<div class="skeleton" style="height:50vh"></div>'; Admin.renderTab(); },
    'adm-status'(el) { Admin.filter.status = el.dataset.s; Admin.drawMenu(); },
    'select:adm-cat'(value) { Admin.filter.cat = value; Admin.drawMenu(); },
    'dish-new'() { Admin.editor(null); },
    'dish-edit'(el) { Admin.editor(Admin.data.items.find((x) => x.id === Number(el.dataset.id))); },
    async 'dish-delete'(el) { await Admin.deleteDish(el.dataset.id); },
    async 'dish-restore'(el) { await busy(el, async () => { await sapi('POST', `/api/admin/menu/${el.dataset.id}/restore`); toast('Блюдо вернулось в меню', 'success'); Data.getMenu(true).catch(() => {}); await Admin.menuTab(); }); },
    'cat-new'() { Admin.categorySheet(null); },
    'cat-edit'(el) { Admin.categorySheet(Admin.cats.find((c) => c.id === Number(el.dataset.id))); },
    async 'cat-del'(el) {
      const c = Admin.cats.find((x) => x.id === Number(el.dataset.id));
      if (c.items_count) { toast(`В категории ${pl(c.items_count, 'блюдо', 'блюда', 'блюд')} — перенесите их или скройте категорию`, 'warn'); return; }
      if (!(await confirmBox({ title: `Удалить «${c.name}»?`, ok: 'Удалить', danger: true }))) return;
      await sapi('DELETE', `/api/admin/categories/${c.id}`); toast('Категория удалена', 'success'); await Admin.categoriesTab();
    },
    async 'cat-move'(el) {
      const i = Number(el.dataset.i); const j = i + Number(el.dataset.d);
      const ids = Admin.cats.map((c) => c.id);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await busy(el, async () => { await sapi('POST', '/api/admin/categories/reorder', { ids }); Data.getMenu(true).catch(() => {}); await Admin.categoriesTab(); });
    },
    'table-new'() { Admin.tableSheet(null); },
    'tables-bulk'() { Admin.bulkSheet(() => (Admin.tab === 'tables' ? Admin.tablesTab() : Admin.settingsTab())); },
    async 'tables-auto'(el) {
      if (!(await confirmBox({ title: 'Расставить столы ровно?', text: 'Все столы встанут ровной сеткой. Потом любой можно перетащить.', ok: 'Расставить' }))) return;
      await busy(el, async () => { Admin.quietUntil = Date.now() + 1500; await sapi('POST', '/api/admin/tables/auto-layout'); toast('Столы расставлены', 'success'); await Admin.tablesTab(); });
    },
    async 'table-delete'(el) {
      const t = Admin.tables.find((x) => x.id === Number(el.dataset.id));
      if (!(await confirmBox({ title: `Удалить «${t.label}»?`, text: 'QR этого стола перестанет работать. Если за столом уже были заказы, он уйдёт в архив — история сохранится.', ok: 'Удалить', danger: true }))) return;
      await busy(el, async () => { const r = await sapi('DELETE', `/api/admin/tables/${t.id}`); toast(r.mode === 'archived' ? 'Стол в архиве, QR отключён' : 'Стол удалён', 'success'); await Admin.tablesTab(); });
    },
    'admin-goto'(el) { const btn = qs(`[data-act="admin-tab"][data-tab="${el.dataset.tab}"]`); if (btn) btn.click(); },
    'staff-pass'(el) { const u = Admin.staff.find((x) => x.id === Number(el.dataset.id)); passwordSheet({ title: `Пароль: ${u.display_name || u.username}`, onSave: (body) => sapi('POST', `/api/admin/staff/${u.id}/password`, body) }); },
    'table-edit'(el) { Admin.tableSheet(Admin.tables.find((t) => t.id === Number(el.dataset.id))); },
    'table-copy'(el) { copyText(el.dataset.url); },
    async 'table-rotate'(el) {
      const t = Admin.tables.find((x) => x.id === Number(el.dataset.id));
      if (!(await confirmBox({ title: `Новый QR для «${t.label}»?`, text: 'Старый QR перестанет работать — распечатайте новую карточку. Гости, уже сидящие за столом, не пострадают.', ok: 'Перевыпустить' }))) return;
      await busy(el, async () => { await sapi('POST', `/api/admin/tables/${t.id}/rotate`); toast('QR перевыпущен', 'success'); await Admin.tablesTab(); });
    },
    'tables-print'() {
      const rest = Data.config.restaurant.name;
      PRINT_ROOT.innerHTML = `<div class="print-tents">${Admin.tables.filter((t) => t.active).map((t) => `<div class="print-tent"><p>${esc(rest)}</p><h2>${esc(t.label)}</h2><img src="${esc(t.qr_url)}" alt=""><p><b>Наведите камеру — меню, общая корзина и оплата</b></p><p>Без приложения и Wi‑Fi · ${esc(t.zone)}</p></div>`).join('')}</div>`;
      const imgs = qsa('img', PRINT_ROOT);
      Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : new Promise((r) => { img.onload = r; img.onerror = r; })))).then(() => window.print());
    },
    period(el) { Admin.period = Number(el.dataset.v); Admin.analyticsTab(); },
    async 'st-save'(el) {
      const err = qs('#st-err');
      await busy(el, async () => {
        try { await sapi('PUT', '/api/admin/restaurant', { name: qs('#st-name').value.trim(), city: qs('#st-city').value.trim(), service_percent: Number(qs('#st-service').value) || 0 }); err.hidden = true; toast('Настройки сохранены', 'success'); Data.getConfig(true).catch(() => {}); }
        catch (e) { err.hidden = false; err.textContent = e.message; }
      });
    },
    async reset(el) {
      const full = el.dataset.full === '1';
      if (!(await confirmBox({ title: full ? 'Полный сброс?' : 'Сбросить заказы?', text: full ? 'Меню, категории, столы и вся история будут созданы заново. QR-коды столов изменятся.' : 'Все сессии, заказы и оплаты будут удалены, история заказов создана заново.', ok: 'Сбросить', danger: true }))) return;
      await busy(el, async () => { await sapi('POST', '/api/admin/demo/reset', { full }); await Data.getMenu(true); toast('Демо-данные пересозданы', 'success'); await Admin.settingsTab(); });
    },
    async 'audit-more'(el) { await busy(el, () => Admin.auditTab(true)); },
  },
};
