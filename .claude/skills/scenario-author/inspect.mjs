/*
 * inspect.mjs — разведчик селекторов для составления сценария.
 * Открывает URL и печатает интерактивные элементы (поля, кнопки, ссылки, заголовки)
 * с предложенным `target` — чтобы агент подобрал устойчивые селекторы.
 *
 * Запуск из корня репозитория:
 *   node .claude/skills/scenario-author/inspect.mjs <url> [--state auth/state.json] [--token <VALUE>] [--headed]
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const url = args.find(a => /^https?:\/\//.test(a));
if (!url) { console.error('нужен URL'); process.exit(1); }
const val = f => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const state = val('--state'), token = val('--token');

const ctxOpts = { viewport: { width: 1920, height: 1080 } };
if (state) ctxOpts.storageState = state;
else if (token) ctxOpts.storageState = { cookies: [], origins: [{ origin: new URL(url).origin, localStorage: [{ name: 'authToken', value: token }] }] };

const browser = await chromium.launch({ headless: !args.includes('--headed') });
const context = await browser.newContext(ctxOpts);
const page = await context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(2500);

const data = await page.evaluate(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  const short = s => (s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const dedupe = arr => { const seen = new Set(); return arr.filter(x => { const k = JSON.stringify(x.target); if (seen.has(k)) return false; seen.add(k); return true; }); };

  const inputs = [...document.querySelectorAll('input,textarea,select')].filter(vis).map(e => {
    const name = e.getAttribute('name'), ph = e.getAttribute('placeholder');
    return {
      kind: 'input', type: e.type || e.tagName.toLowerCase(), placeholder: ph || '', name: name || '',
      target: name ? `${e.tagName.toLowerCase()}[name="${name}"]` : ph ? `input[placeholder="${ph}"]` : e.id ? `#${e.id}` : 'input',
    };
  });
  const buttons = dedupe([...document.querySelectorAll('button,[role="button"]')].filter(vis)
    .map(e => ({ kind: 'button', text: short(e.textContent), target: { text: short(e.textContent) } })).filter(x => x.text));
  const links = dedupe([...document.querySelectorAll('a[href]')].filter(vis)
    .map(e => ({ kind: 'link', text: short(e.textContent), href: e.getAttribute('href'), target: { text: short(e.textContent) } })).filter(x => x.text)).slice(0, 30);
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(vis).map(e => ({ kind: 'heading', tag: e.tagName, text: short(e.textContent) })).filter(x => x.text).slice(0, 20);

  // подсказка про строки-элементы с id-классами (частый паттерн SPA-таблиц): [class*="id_123"]
  const idRows = [...new Set([...document.querySelectorAll('[class*="id_"]')].map(e => (e.className.match(/\bid_(\d+)\b/) || [])[1]).filter(Boolean))].slice(0, 8);

  return { title: document.title, inputs, buttons, links, headings, idRows };
});

console.log(JSON.stringify(data, null, 2));
await browser.close();
