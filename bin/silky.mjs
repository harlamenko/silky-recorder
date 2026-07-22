#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { resolvePath } from '../src/config.mjs';
import { record } from '../src/runner.mjs';
import { build } from '../src/build.mjs';
import { runLogin } from '../src/auth.mjs';
import { listVoices } from '../src/tts.mjs';

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
  if (cmd === 'voices') {
    const all = await listVoices();
    const q = (arg || '').toLowerCase();
    const rows = all
      .filter(v => !q || v.ShortName.toLowerCase().includes(q) || (v.Locale || '').toLowerCase().includes(q))
      .map(v => `  ${v.ShortName.padEnd(38)} ${v.Gender === 'Female' ? 'жен' : 'муж'}  ${(v.FriendlyName || '').replace(/^Microsoft |Online \(Natural\).*$/g, '')}`);
    console.log(rows.length
      ? `Голоса (${rows.length}${q ? ` из ${all.length}, фильтр «${arg}»` : ''}):\n` + rows.join('\n')
      : `Ничего не нашлось по фильтру «${arg}». Попробуйте код языка, напр. ru-RU.`);
    return;
  }
  if (cmd === 'record') {
    const { scenario, name } = loadScenario(arg);
    const t0 = Date.now();
    console.log(`● Запись: ${scenario.meta.title || name}`);
    const rec = await record(scenario, {
      verbose: flags.has('--verbose') || flags.has('-v'),
      headed: flags.has('--headed'),
      onVoice: (done, total) => process.stdout.write(`\r● Озвучка: ${done}/${total} реплик…`),
      onVoiceDone: ({ total, fresh }) => console.log(`\r● Озвучка: ${total} реплик готово (новых ${fresh}, из кэша ${total - fresh})`),
    });
    console.log('● Монтаж звука (голос + музыка + клики/клавиши)…');
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
  silky voices [фильтр]          список голосов для озвучки (напр. silky voices ru-RU)

  Формат сценария — scenarios/FORMAT.md`);
})().catch(e => { console.error('✗', e.message); process.exit(1); });
