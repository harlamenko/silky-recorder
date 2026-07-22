import fs from 'node:fs';
import path from 'node:path';
import { resolvePath, makeWorkdir } from './config.mjs';
import { authState } from './auth.mjs';
import { voiceConfig, narrationOf, prepareVoices } from './tts.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Резолвер элемента в странице по target-дескриптору (инжектится рядом с silky).
const RESOLVER_JS = `
window.__silkyResolve = (t) => {
  if (t == null) return null;
  if (typeof t === 'string') return document.querySelector(t);
  if (t.id) return document.querySelector('[class*="id_' + t.id + '"]');
  if (t.css) return document.querySelectorAll(t.css)[t.index || 0] || null;
  if (t.text) {
    const cands = [...document.querySelectorAll('body *')].filter(e => (e.textContent || '').includes(t.text));
    if (!cands.length) return null;
    let el = cands.sort((a, b) => a.getElementsByTagName('*').length - b.getElementsByTagName('*').length)[0];
    if (t.row) { for (let i = 0; i < 6 && el.parentElement; i++) { if (el.getBoundingClientRect().width > (t.rowWidth || 1000)) break; el = el.parentElement; } }
    return el;
  }
  return null;
};`;

// target-дескриптор -> Playwright Locator (для реального клика/ввода).
function locatorFor(page, t) {
  if (typeof t === 'string') return page.locator(t).first();
  if (t.id) return page.locator(`[class*="id_${t.id}"]`).first();
  if (t.css) return page.locator(t.css).nth(t.index || 0);
  if (t.text) return page.getByText(t.text, { exact: !!t.exact }).first();
  throw new Error('bad target: ' + JSON.stringify(t));
}

async function waitReady(page, ready) {
  if (!ready) return page.waitForLoadState('networkidle').catch(() => {});
  if (typeof ready === 'string') return page.waitForSelector(ready, { timeout: 45000 });
  if (ready.text) return page.waitForFunction(t => document.body.innerText.includes(t), ready.text, { timeout: 45000 });
  if (ready.selector) return page.waitForSelector(ready.selector, { timeout: 45000 });
}

// переинжект движка после полного перехода по URL (silky живёт в window и стирается навигацией)
async function ensureSilky(page, silkyJs) {
  const has = await page.evaluate(() => !!window.__silky).catch(() => false);
  if (!has) {
    await page.addScriptTag({ content: silkyJs }).catch(() => {});
    await page.addScriptTag({ content: RESOLVER_JS }).catch(() => {});
  }
}

// Ставит реплику шага в фонограмму и возвращает, сколько шаг обязан длиться из-за неё.
// Само аудио подмешивается на монтаже — в браузере ничего не звучит.
function speak(step, ctx) {
  if (!ctx.voice) return 0;
  const text = narrationOf(step);
  const clip = text && ctx.clips.get(text);
  if (!clip) return 0;
  ctx.mark('voice', { file: clip.file, durMs: clip.durMs }, ctx.voice.lead);
  return ctx.voice.lead + clip.durMs + ctx.voice.pad;
}

async function runStep(page, step, ctx) {
  const { mark, log } = ctx;
  const t = step.target;
  const startedAt = Date.now();
  const sayMs = speak(step, ctx);
  // Карточка/зум/наведение держатся не меньше реплики: иначе голос договаривал бы «в пустоту».
  const hold = (dflt) => Math.max(step.hold ?? dflt, sayMs);

  switch (step.type) {
    case 'title': case 'outro':
      await page.evaluate(({ s, ms }) => window.__silky.titleCard(s.text, s.sub || '', ms), { s: step, ms: hold(2600) });
      break;
    case 'caption':
      await page.evaluate(s => window.__silky.caption(s.text, 0), step);
      await sleep(step.read ?? 2600);
      break;
    case 'say':
      await sleep(step.hold ?? 0);
      break;
    case 'move':
      await page.evaluate(s => { const el = window.__silkyResolve(s.target); return el && window.__silky.moveToEl(el, s.dur || 800); }, step);
      break;
    case 'click':
      await page.evaluate(s => { const el = window.__silkyResolve(s.target); return el && window.__silky.moveToEl(el, s.move || 900); }, step);
      mark('click');
      await locatorFor(page, t).click({ timeout: 15000 }).catch(e => log('click fail: ' + e.message));
      break;
    case 'type': {
      await page.evaluate(s => { const el = window.__silkyResolve(s.target); return el && window.__silky.moveToEl(el, s.move || 700); }, step);
      await locatorFor(page, t).focus().catch(() => {});
      const cps = step.cps || 4;
      for (const ch of String(step.text)) { mark('key'); await page.keyboard.type(ch); await sleep(1000 / cps); }
      break;
    }
    case 'zoom':
      await page.evaluate(async ({ s, ms }) => {
        const el = window.__silkyResolve(s.target); if (!el) return;
        const r = el.getBoundingClientRect();
        await window.__silky.zoomTo(innerWidth * (s.originX ?? 0.5), r.top + r.height / 2, s.scale || 1.4, 900);
        await new Promise(x => setTimeout(x, ms));
        await window.__silky.zoomReset(900);
      }, { s: step, ms: hold(3000) });
      break;
    case 'scroll':
      await page.evaluate(s => { const el = window.__silkyResolve(s.target); el && el.scrollIntoView({ block: s.block || 'start', behavior: 'smooth' }); }, step);
      break;
    case 'hover':
      await page.evaluate(async s => {
        const el = window.__silkyResolve(s.target); if (!el) return;
        await window.__silky.moveToEl(el, s.move || 1000);
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        if (s.zoom) { const r = el.getBoundingClientRect(); await window.__silky.zoomTo(innerWidth * (s.originX ?? 0.45), r.top + r.height / 2, s.zoom, 850); }
      }, step);
      await sleep(hold(2600));
      if (step.zoom) await page.evaluate(() => window.__silky.zoomReset(850));
      break;
    case 'key':
      mark('key');
      await page.keyboard.press(step.key || 'Enter');
      break;
    case 'wait':
      await sleep(step.ms || 1000);
      break;
    default:
      log('пропущен неизвестный шаг: ' + step.type);
  }
  if (step.after) await sleep(step.after);
  // Общее правило: шаг не заканчивается раньше, чем договорит голос.
  const left = sayMs - (Date.now() - startedAt);
  if (left > 0) await sleep(left);
}

export async function record(scenario, opts = {}) {
  const meta = scenario.meta;
  const log = opts.verbose ? (...a) => console.log('  ·', ...a) : () => {};
  const silkyJs = fs.readFileSync(resolvePath('src/silky.js'), 'utf8');

  // Озвучка — первым делом: её длительность задаёт паузы в записи,
  // а отказ сервиса должен ронять запуск до открытия браузера, а не посреди дубля.
  const voice = voiceConfig(meta);
  let clips = new Map();
  if (voice) {
    const res = await prepareVoices(scenario, voice, (done, total) => opts.onVoice?.(done, total));
    clips = res.clips;
    opts.onVoiceDone?.(res);
  }

  const state = await authState(meta);
  const work = makeWorkdir();

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1,
    recordVideo: { dir: work, size: { width: 1920, height: 1080 } },
    ...(state ? { storageState: state } : {}),
  });

  const hide = meta.hide || [];
  if (hide.length) await context.addInitScript(sel => {
    const s = document.createElement('style');
    s.textContent = sel.map(x => `${x}{display:none!important}`).join('');
    document.documentElement.appendChild(s);
  }, hide);

  const page = await context.newPage();
  const recStart = Date.now();
  const events = [];
  const mark = (type, extra = {}, offsetMs = 0) => events.push({ t: Date.now() - recStart + offsetMs, type, ...extra });
  const ctx = { mark, log, voice, clips };

  await page.goto(meta.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitReady(page, meta.readyWhen);
  await sleep(meta.settle ?? 800);
  await page.addScriptTag({ content: silkyJs });
  await page.addScriptTag({ content: RESOLVER_JS });
  const sceneStart = Date.now() - recStart;

  for (const step of scenario.steps) {
    log(step.type + (step.text ? ' — ' + step.text.slice(0, 40) : ''));
    await ensureSilky(page, silkyJs);
    await runStep(page, step, ctx);
  }

  const totalMs = Date.now() - recStart;
  await context.close();
  await browser.close();

  const webm = fs.readdirSync(work).filter(f => f.endsWith('.webm')).map(f => path.join(work, f))[0];
  return { video: webm, events, sceneStart, totalMs, work, meta, voice };
}
