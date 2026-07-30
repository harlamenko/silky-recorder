import test from 'node:test';
import assert from 'node:assert/strict';
import { frameTimeline } from '../src/build.mjs';

const f = (file, ts) => ({ file, ts });

test('кадр показывается от своего таймстампа до следующего', () => {
  const tl = frameTimeline([f('a', 1000), f('b', 1020), f('c', 1050)], 1000, 1100);
  assert.deepEqual(tl.map(x => x.file), ['a', 'b', 'c']);
  assert.ok(Math.abs(tl[0].dur - 0.02) < 1e-9);
  assert.ok(Math.abs(tl[1].dur - 0.03) < 1e-9);
});

test('последний кадр держится до конца записи', () => {
  const tl = frameTimeline([f('a', 1000), f('b', 1020)], 1000, 2020);
  assert.ok(Math.abs(tl[1].dur - 1.0) < 1e-9, 'хвост после последнего кадра — его длительность');
});

test('лид-ин загрузки схлопывается: до t0 остаётся один стартовый кадр', () => {
  const tl = frameTimeline([f('load1', 0), f('load2', 500), f('scene', 1200)], 1000, 1500);
  assert.deepEqual(tl.map(x => x.file), ['load2', 'scene']);
  // стартовый кадр начинается в t0, а не в своём таймстампе
  assert.ok(Math.abs(tl[0].dur - 0.2) < 1e-9, `ожидалось 0.2с, получено ${tl[0].dur}`);
});

test('первый кадр после t0 не ломает раскладку', () => {
  const tl = frameTimeline([f('a', 1100), f('b', 1200)], 1000, 1300);
  assert.deepEqual(tl.map(x => x.file), ['a', 'b']);
});

test('кадры с одинаковым таймстампом получают минимальную длительность, а не нулевую', () => {
  const tl = frameTimeline([f('a', 1000), f('b', 1000)], 1000, 1000);
  assert.ok(tl.every(x => x.dur > 0));
});
