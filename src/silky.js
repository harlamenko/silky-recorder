/*
 * silky.js — in-browser "silky smooth" tutorial layer.
 *
 * Инжектится в любую страницу (через расширение Claude-in-Chrome или DevTools).
 * Даёт: плавный синтетический курсор с easing, рябь на кликах,
 * зум-«камеру» к точке клика, посимвольный ввод, субтитры и тайтл-карту.
 *
 * ВАЖНО: плавность (rAF + CSS-переходы) рендерится ТОЛЬКО когда вкладка
 * на переднем плане/видима. В фоновой/скрытой вкладке анимация заморожена
 * (сработает watchdog и просто доведёт до финала мгновенно). Поэтому
 * запись всегда идёт по видимому окну Chrome — как и требует любой рекордер.
 *
 * Все анимационные методы возвращают Promise. Вызывать через top-level await:
 *   await __silky.moveToEl('#login'); await __silky.clickEl('#login');
 * НЕ оборачивать всю цепочку в async-IIFE и возвращать её — REPL расширения
 * не дожидается возвращённого промиса. Пиши плоско с await и голым выражением.
 */
(() => {
  if (window.__silky && window.__silky._teardown) window.__silky._teardown();

  const S = {};
  const root = document.documentElement;
  const now = () => performance.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const EASE = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2); // easeInOutCubic

  const CFG = {
    cursorSize: 26,
    moveDur: 700,
    zoomDur: 650,
    typeCps: 16,      // символов в секунду
    rippleColor: 'rgba(255,138,0,.95)',
  };
  S.config = CFG;

  // ---------- стили ----------
  const style = document.createElement('style');
  style.id = '__silky_style';
  style.textContent = `
    #__silky_cursor{position:fixed;left:0;top:0;width:${CFG.cursorSize}px;height:${CFG.cursorSize}px;
      z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px);
      filter:drop-shadow(0 2px 4px rgba(0,0,0,.4));will-change:left,top;}
    #__silky_cursor.click{transform:translate(-3px,-2px) scale(.8);transition:transform .12s ease;}
    .__silky_ripple{position:fixed;z-index:2147483646;pointer-events:none;border-radius:50%;
      border:2.5px solid ${CFG.rippleColor};width:12px;height:12px;left:0;top:0;
      animation:__silky_rip .55s cubic-bezier(.3,0,.2,1) forwards;}
    @keyframes __silky_rip{from{transform:translate(-50%,-50%) scale(.4);opacity:.95}
      to{transform:translate(-50%,-50%) scale(4.5);opacity:0}}
    #__silky_caption{position:fixed;left:50%;bottom:6%;transform:translateX(-50%) translateY(28px);
      z-index:2147483647;pointer-events:none;max-width:70vw;padding:16px 26px;border-radius:14px;
      background:rgba(20,20,24,.86);color:#fff;font:500 22px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
      text-align:center;opacity:0;transition:opacity .42s ease,transform .42s cubic-bezier(.2,.7,.2,1);
      backdrop-filter:blur(8px);box-shadow:0 8px 30px rgba(0,0,0,.35);}
    #__silky_caption.show{opacity:1;transform:translateX(-50%) translateY(0);}
    #__silky_title{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;
      flex-direction:column;gap:14px;background:radial-gradient(120% 120% at 50% 40%,#2a2d3a,#0e0f14);
      color:#fff;opacity:0;transition:opacity .5s ease;pointer-events:none;text-align:center;padding:5vw;}
    #__silky_title.show{opacity:1;}
    /* Цвет и рамки задаём на самих h1/p, а не наследуем от карточки: сайт-хозяин почти всегда
       стилизует свои заголовки, и его правило на элементе перебивает наследование (у Википедии
       карточка так получала тёмный текст и чужое подчёркивание). */
    #__silky_title h1{font:700 clamp(28px,5vw,64px)/1.1 system-ui,sans-serif;margin:0;letter-spacing:-.02em;
      color:#fff;border:0;padding:0;background:none;text-shadow:none;}
    #__silky_title p{font:400 clamp(15px,2vw,22px)/1.4 system-ui,sans-serif;margin:0;opacity:.75;
      color:#fff;border:0;padding:0;background:none;text-shadow:none;}
    body{will-change:transform;}`;
  document.head.appendChild(style);

  // ---------- курсор ----------
  const cur = document.createElement('div');
  cur.id = '__silky_cursor';
  cur.innerHTML = `<svg viewBox="0 0 28 28" width="${CFG.cursorSize}" height="${CFG.cursorSize}">
    <path d="M4 2l0 20 5-4.7 3.2 7.2 3.6-1.6-3.2-7 6.8 0z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  root.appendChild(cur);
  S._pos = { x: Math.round(innerWidth * 0.5), y: Math.round(innerHeight * 0.55) };
  cur.style.left = S._pos.x + 'px';
  cur.style.top = S._pos.y + 'px';

  // ---------- движение курсора (rAF + watchdog) ----------
  S.moveTo = (x, y, dur = CFG.moveDur) => new Promise(res => {
    const sx = S._pos.x, sy = S._pos.y, t0 = now();
    let done = false;
    const finish = () => { if (done) return; done = true;
      cur.style.left = x + 'px'; cur.style.top = y + 'px'; S._pos = { x, y }; res(); };
    (function step() {
      if (done) return;
      const p = Math.min(1, (now() - t0) / dur), e = EASE(p);
      const nx = sx + (x - sx) * e, ny = sy + (y - sy) * e;
      cur.style.left = nx + 'px'; cur.style.top = ny + 'px'; S._pos = { x: nx, y: ny };
      p < 1 ? requestAnimationFrame(step) : finish();
    })();
    setTimeout(finish, dur + 200); // watchdog: гарантирует resolve даже если rAF на паузе
  });

  // ---------- рябь клика ----------
  S.ripple = (x, y) => {
    const r = document.createElement('div');
    r.className = '__silky_ripple';
    r.style.left = x + 'px'; r.style.top = y + 'px';
    root.appendChild(r);
    setTimeout(() => r.remove(), 560);
    cur.classList.add('click');
    setTimeout(() => cur.classList.remove('click'), 150);
  };

  // ---------- клик по координате (реальный dispatch) ----------
  S.clickAt = async (x, y, { dur = CFG.moveDur, settle = 250 } = {}) => {
    await S.moveTo(x, y, dur);
    S.ripple(x, y);
    if (S.audio) S.audio.click();
    await sleep(100);
    const el = document.elementFromPoint(x, y);
    if (el) {
      const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new MouseEvent('mouseup', o));
      el.dispatchEvent(new MouseEvent('click', o));
    }
    await sleep(settle);
    return el ? el.tagName : null;
  };

  // ---------- селекторные хелперы ----------
  const centre = sel => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { el, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), r };
  };
  S.moveToEl = async (sel, dur = CFG.moveDur) => {
    const c = centre(sel); if (!c) throw new Error('silky: элемент не найден — ' + sel);
    await S.moveTo(c.x, c.y, dur); return c.x + ',' + c.y;
  };
  S.clickEl = async (sel, opt) => {
    const c = centre(sel); if (!c) throw new Error('silky: элемент не найден — ' + sel);
    return S.clickAt(c.x, c.y, opt);
  };

  // ---------- ввод (работает и с управляемыми React/Vue input) ----------
  S.type = async (sel, text, { cps = CFG.typeCps } = {}) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) throw new Error('silky: элемент не найден — ' + sel);
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    let v = el.value || '';
    for (const ch of text) {
      v += ch;
      setter ? setter.call(el, v) : (el.value = v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (S.audio) S.audio.key();
      await sleep(1000 / cps);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return v;
  };

  // ---------- зум-«камера» ----------
  S.zoomTo = (x, y, scale = 1.8, dur = CFG.zoomDur) => {
    const ox = Math.round(scrollX + x), oy = Math.round(scrollY + y);
    document.body.style.transition = `transform ${dur}ms cubic-bezier(.4,0,.2,1)`;
    document.body.style.transformOrigin = ox + 'px ' + oy + 'px';
    document.body.style.transform = 'scale(' + scale + ')';
    return sleep(dur);
  };
  S.zoomToEl = (sel, scale = 1.8, dur = CFG.zoomDur) => {
    const c = centre(sel); if (!c) throw new Error('silky: элемент не найден — ' + sel);
    return S.zoomTo(c.x, c.y, scale, dur);
  };
  S.zoomReset = (dur = CFG.zoomDur) => {
    document.body.style.transition = `transform ${dur}ms cubic-bezier(.4,0,.2,1)`;
    document.body.style.transform = 'scale(1)';
    return sleep(dur);
  };

  // ---------- субтитры ----------
  const cap = document.createElement('div');
  cap.id = '__silky_caption';
  root.appendChild(cap);
  S.caption = async (text, holdMs = 0) => {
    // явная смена тоста: если показан — увести старый, затем привести новый
    if (cap.classList.contains('show')) { cap.classList.remove('show'); await sleep(430); }
    cap.textContent = text;
    cap.classList.add('show');
    await sleep(430); // появление
    if (holdMs) { await sleep(holdMs); cap.classList.remove('show'); await sleep(430); }
  };
  S.captionHide = async () => { cap.classList.remove('show'); await sleep(350); };

  // ---------- тайтл-карта ----------
  const title = document.createElement('div');
  title.id = '__silky_title';
  title.innerHTML = '<h1></h1><p></p>';
  root.appendChild(title);
  S.titleCard = async (h, sub = '', holdMs = 2200) => {
    title.querySelector('h1').textContent = h;
    title.querySelector('p').textContent = sub;
    title.classList.add('show');
    await sleep(holdMs);
    title.classList.remove('show');
    await sleep(500);
  };

  // ---------- АУДИО: клики, набор, фоновая музыка (Web Audio, синтез) ----------
  // Всё синтезируется в браузере — без внешних файлов и копирайта. OBS пишет Desktop
  // Audio, поэтому эти звуки попадают в запись. Для разблокировки звука (autoplay policy)
  // вызови один раз __silky.audio.resume() — желательно после реального жеста на странице.
  S.audio = (() => {
    let ctx, master, sfx, musicBus, lp, musicTimer = null, chordIdx = 0;
    const A = { on: { click: true, key: true, music: true } };

    A.init = () => {
      if (ctx) return ctx;
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
      sfx = ctx.createGain(); sfx.gain.value = 0.5; sfx.connect(master);
      lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1900;
      musicBus = ctx.createGain(); musicBus.gain.value = 0.11; lp.connect(musicBus); musicBus.connect(master);
      return ctx;
    };
    A.resume = async () => { A.init(); if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} } return ctx.state; };
    A.setVolume = ({ master: m, sfx: s, music: mu } = {}) => {
      A.init();
      if (m != null) master.gain.value = m;
      if (s != null) sfx.gain.value = s;
      if (mu != null) musicBus.gain.value = mu;
    };

    // мягкий «клик»: питч-блип с быстрым спадом
    A.click = () => {
      if (!ctx || !A.on.click) return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(920, t); o.frequency.exponentialRampToValueAtTime(430, t + 0.05);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      o.connect(g); g.connect(sfx); o.start(t); o.stop(t + 0.12);
    };

    // тихий «тик» клавиши: короткий отфильтрованный шум, лёгкий рандом высоты
    A.key = () => {
      if (!ctx || !A.on.key) return;
      const t = ctx.currentTime, dur = 0.03;
      const buf = ctx.createBuffer(1, Math.max(1, (ctx.sampleRate * dur) | 0), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.2);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 1700 + Math.random() * 900; bp.Q.value = 0.7;
      const g = ctx.createGain(); g.gain.value = 0.08;
      src.connect(bp); bp.connect(g); g.connect(sfx); src.start(t);
    };

    // тёплая эмбиент-петля (I–V–vi–IV в C): мягкие пэды + лёгкий колокольчик
    const CHORDS = [
      { bass: 130.81, mid: [261.63, 329.63, 392.00] }, // C  (I)   — нейтральный мажор, без минора
      { bass: 174.61, mid: [261.63, 349.23, 440.00] }, // F  (IV)
      { bass: 130.81, mid: [261.63, 329.63, 392.00] }, // C  (I)
      { bass: 196.00, mid: [293.66, 392.00, 493.88] }, // G  (V)
    ];
    const CHORD_DUR = 4.0;
    const playChord = () => {
      if (!ctx || !A.on.music) return;
      const t = ctx.currentTime;
      const ch = CHORDS[chordIdx % CHORDS.length]; chordIdx++;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, t);
      cg.gain.exponentialRampToValueAtTime(1.0, t + 0.9);
      cg.gain.setValueAtTime(1.0, t + CHORD_DUR - 1.3);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + CHORD_DUR);
      cg.connect(lp);
      const voices = [{ f: ch.bass, type: 'sine', g: 0.5 }, ...ch.mid.map(f => ({ f, type: 'triangle', g: 0.16 }))];
      voices.forEach(v => {
        const o = ctx.createOscillator(); o.type = v.type; o.frequency.value = v.f;
        const g = ctx.createGain(); g.gain.value = v.g;
        o.connect(g); g.connect(cg); o.start(t); o.stop(t + CHORD_DUR + 0.1);
      });
    };
    A.startMusic = () => { A.init(); if (musicTimer || !A.on.music) return; playChord(); musicTimer = setInterval(playChord, (CHORD_DUR - 0.4) * 1000); };
    A.stopMusic = () => { if (musicTimer) { clearInterval(musicTimer); musicTimer = null; } };

    A.destroy = () => { A.stopMusic(); if (ctx) { try { ctx.close(); } catch (e) {} ctx = null; } };
    return A;
  })();

  // ---------- уборка ----------
  S._teardown = () => {
    document.body.style.transition = '';
    document.body.style.transform = '';
    document.body.style.transformOrigin = '';
    [cur, style, cap, title].forEach(n => n.remove());
    document.querySelectorAll('.__silky_ripple').forEach(n => n.remove());
    if (S.audio) S.audio.destroy();
    delete window.__silky;
  };

  window.__silky = S;
  return { ok: true, api: Object.keys(S).filter(k => !k.startsWith('_') && k !== 'config') };
})()
