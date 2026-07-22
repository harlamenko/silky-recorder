import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { resolvePath, ensureDir } from './config.mjs';

const FFMPEG = (ffmpegStatic && fs.existsSync(ffmpegStatic)) ? ffmpegStatic : 'ffmpeg';

// Кривая громкости музыки под голосом. Реплики известны по секундам, поэтому приглушаем
// точно по ним, а не компрессором «по уровню сигнала»: результат воспроизводим и не зависит
// от того, насколько громко получился синтез. На каждую реплику — трапеция с плавными краями.
export function duckExpr(segments, duck, rampMs) {
  const r = Math.max(0.05, rampMs / 1000);
  const humps = segments.map(({ at, durMs }) => {
    const s = (at - r).toFixed(3), e = (at + durMs / 1000 + r).toFixed(3);
    return `clip(min((t-${s})/${r}\\,(${e}-t)/${r})\\,0\\,1)`;
  });
  return `1-${(1 - duck).toFixed(3)}*min(1\\,${humps.join('+')})`;
}

// rec = { video, events, sceneStart, meta } из runner.record()
export function build(rec, opts = {}) {
  const { video, events, sceneStart, meta, voice } = rec;
  const trim = Math.max(0, sceneStart / 1000 - 0.25);         // убрать лид-ин загрузки
  const music = meta.music || {}, sfx = meta.sfx || {};
  const musicFile = resolvePath(music.file || 'assets/music.mp3');
  const clickFile = resolvePath(sfx.click || 'assets/click.wav');
  const keyFile = resolvePath(sfx.key || 'assets/key.wav');
  const musicVol = music.vol ?? 0.85, musicStart = music.start ?? 0;
  const clickVol = sfx.clickVol ?? 0.34, keyVol = sfx.keyVol ?? 0.17;
  const out = resolvePath(meta.out || `out/${opts.name || 'tutorial'}.mp4`);
  ensureDir(path.dirname(out));

  const clicks = events.filter(e => e.type === 'click').map(e => Math.max(0, e.t / 1000 - trim));
  const keys = events.filter(e => e.type === 'key').map(e => Math.max(0, e.t / 1000 - trim));
  const said = events
    .filter(e => e.type === 'voice' && fs.existsSync(e.file))
    .map(e => ({ file: e.file, at: Math.max(0, e.t / 1000 - trim), durMs: e.durMs }));

  const inputs = ['-ss', String(trim), '-i', video];
  const idx = {}; let n = 1;
  const hasMusic = fs.existsSync(musicFile);
  const hasClick = fs.existsSync(clickFile) && clicks.length;
  const hasKey = fs.existsSync(keyFile) && keys.length;
  if (hasMusic) { inputs.push('-stream_loop', '-1'); if (musicStart > 0) inputs.push('-ss', String(musicStart)); inputs.push('-i', musicFile); idx.music = n++; }
  if (hasClick) { inputs.push('-i', clickFile); idx.click = n++; }
  if (hasKey) { inputs.push('-i', keyFile); idx.key = n++; }
  said.forEach(s => { inputs.push('-i', s.file); s.idx = n++; });

  const fc = [], labels = [];
  if (hasMusic) {
    const duck = said.length ? `,volume='${duckExpr(said, voice.duck, voice.ramp)}':eval=frame` : '';
    fc.push(`[${idx.music}:a]aformat=channel_layouts=mono:sample_rates=48000,volume=${musicVol}${duck}[music]`);
    labels.push('[music]');
  }
  said.forEach((s, i) => {
    fc.push(`[${s.idx}:a]aformat=channel_layouts=mono:sample_rates=48000,adelay=${Math.round(s.at * 1000)}:all=1,volume=${voice.vol}[v${i}]`);
    labels.push(`[v${i}]`);
  });
  if (hasClick) {
    fc.push(`[${idx.click}:a]aformat=channel_layouts=mono:sample_rates=48000,asplit=${clicks.length}${clicks.map((_, i) => `[c${i}]`).join('')}`);
    clicks.forEach((tt, i) => { const ms = Math.round(tt * 1000); fc.push(`[c${i}]adelay=${ms},volume=${clickVol}[cd${i}]`); labels.push(`[cd${i}]`); });
  }
  if (hasKey) {
    fc.push(`[${idx.key}:a]aformat=channel_layouts=mono:sample_rates=48000,asplit=${keys.length}${keys.map((_, i) => `[k${i}]`).join('')}`);
    keys.forEach((tt, i) => { const ms = Math.round(tt * 1000); fc.push(`[k${i}]adelay=${ms},volume=${keyVol}[kd${i}]`); labels.push(`[kd${i}]`); });
  }

  const args = ['-y', '-hide_banner', '-loglevel', 'error', ...inputs];
  if (labels.length) {
    fc.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[mix]`);
    fc.push(`[mix]alimiter=limit=0.9[aout]`);
    args.push('-filter_complex', fc.join(';'), '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '160k');
  } else {
    args.push('-map', '0:v', '-an');
  }
  args.push('-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-shortest', out);

  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error('ffmpeg упал:\n' + (r.stderr || r.error));
  return out;
}
