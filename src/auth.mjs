import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { resolvePath } from './config.mjs';

/*
 * Гибкая авторизация. meta.auth:
 *   { "type": "none" }                                  — публичный сайт
 *   { "type": "state", "file": "auth/state.json" }      — залогинься 1 раз (`silky login`), переиспользуется
 *   { "type": "token", "key": "authToken", "env": "AUTH_TOKEN" } — токен в localStorage
 *   { "type": "cdp", "endpoint": "http://127.0.0.1:9222" }       — сессия из уже открытого Chrome
 */

const originOf = url => new URL(url).origin;
const DEFAULT_STATE = 'auth/state.json';

// Опции storageState для newContext (или null).
export async function authState(meta) {
  const a = meta.auth || { type: 'none' };
  if (a.type === 'none') return null;

  if (a.type === 'token') {
    const key = a.key || 'authToken';
    const value = a.value || process.env[a.env || 'AUTH_TOKEN'];
    if (!value) throw new Error(`auth token не задан (env ${a.env || 'AUTH_TOKEN'} или auth.value)`);
    return { cookies: [], origins: [{ origin: originOf(meta.url), localStorage: [{ name: key, value }] }] };
  }

  if (a.type === 'state') {
    const file = resolvePath(a.file || DEFAULT_STATE);
    if (!fs.existsSync(file)) throw new Error(`нет ${file}. Сначала: silky login <scenario>`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  if (a.type === 'cdp') {
    const { chromium } = await import('playwright');
    const endpoint = a.endpoint || 'http://127.0.0.1:9222';
    const browser = await chromium.connectOverCDP(endpoint);
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const state = await ctx.storageState();
    await browser.close(); // отсоединяемся; браузер, который мы не запускали, не закрывается
    return state;
  }

  throw new Error(`неизвестный auth.type: ${a.type}`);
}

// `silky login`: открыть браузер, дать войти, сохранить сессию.
// Завершается по Enter ИЛИ при закрытии окна браузера (сессия сохраняется в обоих случаях).
export async function runLogin(meta) {
  const { chromium } = await import('playwright');
  const file = resolvePath((meta.auth && meta.auth.file) || DEFAULT_STATE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  await page.goto(meta.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  console.log('\n  ▸ Войдите в аккаунт в открывшемся окне браузера.');
  console.log('  ▸ Затем нажмите Enter здесь ИЛИ просто закройте окно браузера.\n');

  // держим свежий снимок сессии — чтобы сохранить даже если окно закрыли
  let lastState = null;
  const snapshot = async () => { try { lastState = await context.storageState(); } catch { } };
  await snapshot();
  const timer = setInterval(snapshot, 1500);

  const closed = new Promise(res => {
    browser.on('disconnected', res);
    context.on('close', res);
    page.on('close', res);
  });
  const enter = makeEnterWaiter();
  const how = await Promise.race([enter.promise.then(() => 'enter'), closed.then(() => 'closed')]);

  clearInterval(timer);
  enter.close();                                   // освобождаем stdin, чтобы процесс завершился
  if (how === 'enter') await snapshot();           // самый свежий снимок
  if (browser.isConnected()) await browser.close().catch(() => { });

  if (lastState) {
    fs.writeFileSync(file, JSON.stringify(lastState, null, 2));
    console.log(`  ✓ Сессия сохранена: ${file}`);
  } else {
    console.log('  ✗ Не удалось получить сессию. Запустите login ещё раз и войдите до закрытия окна.');
    process.exitCode = 1;
  }
}

function makeEnterWaiter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const promise = new Promise(res => rl.on('line', () => res()));
  return { promise, close: () => { try { rl.close(); } catch { } } };
}
