'use strict';
const WaitGame = {
  sheet: null, raf: 0, s: null,
  open({ emojis = [], allergens = [], etaAt = null } = {}) {
    if (this.sheet && !this.sheet.closed) return;
    const good = [...new Set([...emojis, '🍅', '🥕', '🧅', '🍋', '🥬', '🍞'])].slice(0, 9);
    const bad = allergens.length ? allergens.map((a) => Data.allergen(a).icon) : ['🌶️'];
    const best = store.get('game-best', 0);
    this.sheet = openSheet({
      title: 'Пока готовится', size: 'lg', cls: 'game-sheet',
      body: `<div class="game-wrap" id="game-wrap"><canvas id="game-canvas" aria-label="Мини-игра: ловите ингредиенты тарелкой"></canvas>
        <div class="game-hud"><span class="gh-score">${icon('star', 'ic-sm')}<b id="gh-score">0</b></span><span class="gh-lives" id="gh-lives">❤️❤️❤️</span><span class="gh-eta" id="gh-eta"${etaAt ? '' : ' hidden'}>${icon('clock', 'ic-sm')}<b data-countdown="${esc(etaAt || '')}">--:--</b></span></div>
        <div class="game-overlay" id="game-overlay"><div class="go-card"><div class="go-emoji">🍳</div><h3>Ловите ингредиенты</h3><p>Ведите тарелку пальцем, мышкой или стрелками. Ловите ${good.slice(0, 4).join(' ')} и не берите ${bad.join(' ')} — ${allergens.length ? 'это ваши аллергены' : 'слишком остро'}.</p><button class="btn btn-primary btn-lg" data-act="game-start">${icon('right')}Играть</button><span class="small muted">Рекорд: <b id="gh-best">${best}</b></span></div></div></div>`,
      onClose: () => this.stop(),
      actions: { 'game-start'() { WaitGame.start(); }, 'game-orders'(el, e, sheet) { sheet.close(); Guest.setView(window.innerWidth <= 900 ? 'panel' : Guest.view, 'orders'); } },
    });
    this.s = { good, bad, items: [], parts: [], score: 0, lives: 3, running: false, t: 0, spawn: 0, shake: 0, px: 0.5, keys: {}, combo: 0, w: 0, h: 0, dpr: 1 };
    this.bind();
    this.resize();
    this.draw();
    if (typeof Guest !== 'undefined' && Guest.tick) Guest.tick();
  },
  bind() {
    const canvas = qs('#game-canvas');
    const move = (e) => { const r = canvas.getBoundingClientRect(); this.s.px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
    canvas.addEventListener('pointerdown', (e) => { move(e); canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', move);
    this.onKey = (e) => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { this.s.keys[e.key] = e.type === 'keydown'; e.preventDefault(); } };
    document.addEventListener('keydown', this.onKey);
    document.addEventListener('keyup', this.onKey);
    this.onResize = debounce(() => { this.resize(); this.draw(); }, 80);
    window.addEventListener('resize', this.onResize);
    this.onHide = () => { if (document.visibilityState !== 'visible') this.pause(); };
    document.addEventListener('visibilitychange', this.onHide);
  },
  resize() {
    const canvas = qs('#game-canvas');
    if (!canvas) return;
    const box = canvas.parentElement.getBoundingClientRect();
    const s = this.s;
    s.dpr = Math.min(2, window.devicePixelRatio || 1);
    s.w = Math.max(260, box.width);
    s.h = Math.max(280, box.height || Math.min(box.width * 1.1, window.innerHeight * 0.62));
    canvas.width = Math.round(s.w * s.dpr);
    canvas.height = Math.round(s.h * s.dpr);
    canvas.style.height = s.h + 'px';
  },
  start() {
    const s = this.s;
    Object.assign(s, { items: [], parts: [], score: 0, lives: 3, running: true, t: 0, spawn: 0, combo: 0 });
    qs('#game-overlay').hidden = true;
    this.hud();
    let last = performance.now();
    const loop = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.step(dt);
      this.draw();
      if (this.s && this.s.running) this.raf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(loop);
  },
  step(dt) {
    const s = this.s;
    s.t += dt;
    const speedUp = 1 + s.t / 45;
    if (s.keys.ArrowLeft) s.px = Math.max(0, s.px - dt * 1.4);
    if (s.keys.ArrowRight) s.px = Math.min(1, s.px + dt * 1.4);
    s.spawn -= dt;
    if (s.spawn <= 0) {
      const isBad = Math.random() < Math.min(0.42, 0.22 + s.t / 200);
      const pool = isBad ? s.bad : s.good;
      s.items.push({ x: 0.06 + Math.random() * 0.88, y: -0.08, vy: (0.22 + Math.random() * 0.14) * speedUp, spin: (Math.random() - 0.5) * 3, a: 0, e: pool[Math.floor(Math.random() * pool.length)], bad: isBad });
      s.spawn = Math.max(0.32, 0.95 - s.t / 70) * (0.7 + Math.random() * 0.6);
    }
    const plateY = 0.88;
    const plateW = 0.2;
    for (const it of s.items) {
      it.y += it.vy * dt;
      it.a += it.spin * dt;
      if (!it.hit && it.y > plateY - 0.05 && it.y < plateY + 0.03 && Math.abs(it.x - s.px) < plateW / 2 + 0.03) {
        it.hit = true;
        if (it.bad) {
          s.lives -= 1; s.combo = 0; s.shake = 0.35; vibrate(80);
          this.burst(it.x, plateY, '#d2433a', 22);
        } else {
          s.combo += 1; s.score += 1 + Math.floor(s.combo / 5);
          this.burst(it.x, plateY, ['#f2a93b', '#20b26b', '#e4572e', '#2f6fd0'][s.score % 4], 16);
        }
        this.hud();
      }
    }
    s.items = s.items.filter((it) => !it.hit && it.y < 1.1);
    for (const p of s.parts) { p.vy += 1.6 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
    s.parts = s.parts.filter((p) => p.life > 0);
    s.shake = Math.max(0, s.shake - dt);
    if (s.lives <= 0) this.over();
  },
  burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 0.15 + Math.random() * 0.45;
      this.s.parts.push({ x, y, vx: Math.cos(a) * v * 0.6, vy: Math.sin(a) * v - 0.35, life: 0.5 + Math.random() * 0.5, color, r: 2 + Math.random() * 3 });
    }
  },
  draw() {
    const canvas = qs('#game-canvas');
    if (!canvas || !this.s) return;
    const s = this.s;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    const W = s.w; const H = s.h;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#fff7ea'); g.addColorStop(1, '#f1e6d2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    if (s.shake) ctx.translate((Math.random() - 0.5) * 10 * s.shake, 0);
    ctx.strokeStyle = 'rgba(19,33,27,.06)';
    for (let y = 24; y < H; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    const size = Math.max(28, Math.min(44, W / 11));
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    for (const it of s.items) {
      ctx.save();
      ctx.translate(it.x * W, it.y * H);
      ctx.rotate(it.a);
      if (it.bad) { ctx.fillStyle = 'rgba(210,67,58,.16)'; ctx.beginPath(); ctx.arc(0, 0, size * 0.62, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillText(it.e, 0, 2);
      ctx.restore();
    }
    for (const p of s.parts) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x * W, p.y * H, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    const px = s.px * W; const py = 0.88 * H; const pw = 0.2 * W;
    ctx.fillStyle = 'rgba(19,33,27,.12)';
    ctx.beginPath(); ctx.ellipse(px, py + 14, pw / 2, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#15231d'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(px, py, pw / 2, 13, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#e4572e'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(px, py, pw / 2 - 9, 7, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  },
  hud() {
    const s = this.s;
    const score = qs('#gh-score');
    if (!score) return;
    score.textContent = s.score;
    qs('#gh-lives').textContent = '❤️'.repeat(Math.max(0, s.lives)) + '🤍'.repeat(Math.max(0, 3 - s.lives));
  },
  over() {
    const s = this.s;
    s.running = false;
    cancelAnimationFrame(this.raf);
    const best = Math.max(store.get('game-best', 0), s.score);
    store.set('game-best', best);
    this.overlay(`<div class="go-emoji">${s.score >= best && s.score ? '🏆' : '🍽️'}</div><h3>${s.score} ${plural(s.score, 'очко', 'очка', 'очков')}</h3><p>${s.score >= best && s.score ? 'Новый рекорд стола!' : `Рекорд: ${best}`}. Кухня пока колдует над заказом.</p><button class="btn btn-primary btn-lg" data-act="game-start">${icon('refresh')}Ещё раз</button>`);
  },
  overlay(html) {
    const box = qs('#game-overlay');
    if (!box) return;
    box.innerHTML = `<div class="go-card">${html}</div>`;
    box.hidden = false;
  },
  pause() {
    if (!this.s || !this.s.running) return;
    this.s.running = false;
    cancelAnimationFrame(this.raf);
    this.overlay(`<div class="go-emoji">⏸️</div><h3>Пауза</h3><p>Счёт: ${this.s.score}</p><button class="btn btn-primary btn-lg" data-act="game-start">${icon('right')}Заново</button>`);
  },
  orderReady(number) {
    if (!this.sheet || this.sheet.closed) return;
    if (this.s) { this.s.running = false; cancelAnimationFrame(this.raf); }
    this.overlay(`<div class="go-emoji">🔔</div><h3>Заказ №${String(number).padStart(3, '0')} готов!</h3><p>Официант уже несёт его к вам. Ваш счёт в игре: ${this.s ? this.s.score : 0}.</p><button class="btn btn-primary btn-lg" data-act="game-orders">${icon('utensils')}К заказу</button>`);
  },
  stop() {
    cancelAnimationFrame(this.raf);
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('keyup', this.onKey);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onHide);
    this.s = null;
    this.sheet = null;
  },
};
