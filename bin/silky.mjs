#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { resolvePath } from '../src/config.mjs';
import { record } from '../src/runner.mjs';
import { build } from '../src/build.mjs';
import { runLogin } from '../src/auth.mjs';

const [, , cmd, arg, ...rest] = process.argv;
const flags = new Set(rest);

function loadScenario(p) {
  if (!p) throw new Error('укажи файл сценария: silky <cmd> <scenario.json>');
  const file = resolvePath(p, process.cwd());
  const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { scenario, name: path.basename(file).replace(/\.json$/, '') };
}

(async () => {
  if (cmd === 'login') {
    const { scenario } = loadScenario(arg);
    await runLogin(scenario.meta);
    return;
  }
  if (cmd === 'record') {
    const { scenario, name } = loadScenario(arg);
    const t0 = Date.now();
    console.log(`● Запись: ${scenario.meta.title || name}`);
    const rec = await record(scenario, { verbose: flags.has('--verbose') || flags.has('-v'), headed: flags.has('--headed') });
    console.log('● Монтаж звука (музыка + клики/клавиши)…');
    const out = build(rec, { name });
    fs.rmSync(rec.work, { recursive: true, force: true });
    console.log(`✓ Готово за ${((Date.now() - t0) / 1000).toFixed(0)}с → ${out}`);
    return;
  }
  console.log(`silky-recorder — запись «шёлковых» видео-туториалов по сценарию

  silky login  <scenario.json>   войти в аккаунт один раз (сохранить сессию)
  silky record <scenario.json>   записать ролик по сценарию
                 --headed        показать браузер (по умолчанию headless/фон)
                 -v, --verbose   печатать шаги

  Формат сценария — scenarios/FORMAT.md`);
})().catch(e => { console.error('✗', e.message); process.exit(1); });
