import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { resolvePath, ensureDir } from './config.mjs';

const FFMPEG = (ffmpegStatic && fs.existsSync(ffmpegStatic)) ? ffmpegStatic : 'ffmpeg';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Синтез идёт через тот же сервис, что и «Прочитать вслух» в браузере Edge.
// Сервис неофициальный и иногда меняется — отсюда ретраи, кэш и внятная подсказка в ошибке.
const HINT = 'Сервис озвучки (Microsoft Edge Read Aloud) недоступен или изменился.\n' +
  '  Проверьте интернет и повторите; уже озвученные реплики берутся из кэша и заново не запрашиваются.\n' +
  '  Если не чинится — обновите пакет: npm i node-edge-tts@latest';

export const VOICE_DEFAULTS = {
  name: 'ru-RU-SvetlanaNeural',
  rate: '+0%',                              // темп речи
  pitch: '+0Hz',                            // высота голоса
  gain: '+0%',                              // громкость самого синтеза
  format: 'audio-24khz-96kbitrate-mono-mp3',  // 48 кГц сервис не отдаёт — запрос уходит в таймаут
  timeout: 15000,                             // мс на одну реплику
  vol: 1,                                   // громкость дорожки голоса в миксе
  duck: 0.25,                               // до какой доли приглушать музыку под голосом
  ramp: 300,                                // мс на приглушение музыки и возврат
  lead: 150,                                // мс тишины перед репликой
  pad: 400,                                 // мс тишины после реплики
  cache: 'voice',                           // папка кэша озвучки
};

export function voiceConfig(meta) {
  return meta?.voice ? { ...VOICE_DEFAULTS, ...meta.voice } : null;
}

// Что произносится на шаге. Правило одно: озвучивается `text` шага,
// а `say` его переопределяет (`"say": false` — промолчать на этом шаге).
export function narrationOf(step) {
  if (step.say === false) return null;
  if (typeof step.say === 'string') return step.say.trim() || null;
  if (['caption', 'title', 'outro', 'say'].includes(step.type)) return (step.text || '').trim() || null;
  return null;
}

function cacheKey(text, v) {
  const id = JSON.stringify([text, v.name, v.rate, v.pitch, v.gain, v.format]);
  return crypto.createHash('sha1').update(id).digest('hex').slice(0, 16);
}

// Длительность реплики меряем тем же ffmpeg, что и монтирует ролик, — лишней зависимости не нужно.
function probeMs(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = (r.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) throw new Error('не удалось измерить длительность файла озвучки: ' + file);
  return Math.round((+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000);
}

async function synth(text, v, dir) {
  const key = cacheKey(text, v);
  const mp3 = path.join(dir, key + '.mp3');
  const side = path.join(dir, key + '.json');

  if (fs.existsSync(mp3) && fs.existsSync(side)) {
    const hit = JSON.parse(fs.readFileSync(side, 'utf8'));
    if (hit.durMs > 0) return { file: mp3, durMs: hit.durMs, cached: true };
  }

  const { EdgeTTS } = await import('node-edge-tts');
  const tts = new EdgeTTS({
    voice: v.name, rate: v.rate, pitch: v.pitch, volume: v.gain,
    outputFormat: v.format, timeout: v.timeout,
  });

  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await tts.ttsPromise(text, mp3);
      const durMs = probeMs(mp3);
      fs.writeFileSync(side, JSON.stringify({ text, voice: v.name, rate: v.rate, durMs }, null, 2));
      return { file: mp3, durMs, cached: false };
    } catch (e) {
      last = e?.message || String(e);   // библиотека отклоняет промис строкой, а не Error
      fs.rmSync(mp3, { force: true });
      if (attempt < 3) await sleep(700 * attempt);
    }
  }
  throw new Error(`не удалось озвучить «${text.slice(0, 50)}…»: ${last}\n  ${HINT}`);
}

// Озвучиваем весь сценарий ДО открытия браузера: тогда длительность речи известна заранее
// и задаёт паузы в записи, а сеть не может отвалиться на середине ролика.
export async function prepareVoices(scenario, v, onProgress = () => {}) {
  const texts = [...new Set(scenario.steps.map(narrationOf).filter(Boolean))];
  const clips = new Map();
  if (!texts.length) return { clips, total: 0, fresh: 0 };

  const dir = ensureDir(resolvePath(v.cache));
  let done = 0, fresh = 0;
  const queue = texts.slice();

  const worker = async () => {
    for (let text = queue.shift(); text !== undefined; text = queue.shift()) {
      const clip = await synth(text, v, dir);
      clips.set(text, clip);
      if (!clip.cached) fresh++;
      onProgress(++done, texts.length, text);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, texts.length) }, worker));

  return { clips, total: texts.length, fresh };
}

// Каталог голосов того же сервиса. Нужен, чтобы не искать имя голоса по форумам.
export function listVoices() {
  const url = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list' +
    '?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0' };
  return new Promise((ok, fail) => {
    https.get(url, { headers }, res => {
      if (res.statusCode !== 200) { res.resume(); return fail(new Error(`каталог голосов вернул ${res.statusCode}. ${HINT}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => { try { ok(JSON.parse(body)); } catch (e) { fail(new Error('каталог голосов не разобрался: ' + e.message)); } });
    }).on('error', e => fail(new Error(`каталог голосов недоступен: ${e.message}\n  ${HINT}`)));
  });
}
