import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { duckExpr } from '../src/build.mjs';

// Замеряет громкость (дБ) участка ровного тона, пропущенного через кривую приглушения.
function rmsDb(expr, from, to) {
  const r = spawnSync(ffmpegStatic, ['-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=14',
    '-af', `volume='${expr}':eval=frame,atrim=${from}:${to},astats=measure_perchannel=none`,
    '-f', 'null', '-'], { encoding: 'utf8' });
  const m = (r.stderr || '').match(/RMS level dB:\s*(-?[\d.]+)/);
  assert.ok(m, 'ffmpeg не принял выражение приглушения:\n' + r.stderr);
  return +m[1];
}

test('музыка приглушается ровно на время реплики и возвращается после', () => {
  const expr = duckExpr([{ at: 3, durMs: 3000 }], 0.25, 300);
  const before = rmsDb(expr, 0.5, 2.5);
  const during = rmsDb(expr, 3.4, 5.6);
  const after = rmsDb(expr, 7, 9);

  assert.ok(Math.abs(before - after) < 0.2, `до и после речи громкость должна совпадать: ${before} / ${after}`);
  // duck=0.25 — это −12 дБ; допуск на края окна замера.
  assert.ok(Math.abs((before - during) - 12) < 0.6, `под голосом ожидалось −12 дБ, получено −${(before - during).toFixed(1)}`);
});

test('несколько реплик приглушают каждая свой участок, между ними музыка возвращается', () => {
  const expr = duckExpr([{ at: 2, durMs: 2000 }, { at: 8, durMs: 2000 }], 0.5, 300);
  const gap = rmsDb(expr, 5.5, 7.5);
  const first = rmsDb(expr, 2.4, 3.6);
  const second = rmsDb(expr, 8.4, 9.6);

  assert.ok(Math.abs(first - second) < 0.2, `обе реплики должны приглушать одинаково: ${first} / ${second}`);
  // duck=0.5 — это −6 дБ.
  assert.ok(Math.abs((gap - first) - 6) < 0.6, `под голосом ожидалось −6 дБ, получено −${(gap - first).toFixed(1)}`);
});

test('соседние реплики не складываются в двойное приглушение', () => {
  // Две реплики впритык: сумма трапеций могла бы дать провал глубже заданного.
  const expr = duckExpr([{ at: 2, durMs: 2000 }, { at: 4.1, durMs: 2000 }], 0.25, 300);
  const solo = rmsDb(duckExpr([{ at: 2, durMs: 2000 }], 0.25, 300), 2.4, 3.6);
  const seam = rmsDb(expr, 3.9, 4.3);

  assert.ok(seam - solo > -0.5, `на стыке реплик приглушение не должно углубляться: ${seam} против ${solo}`);
});
