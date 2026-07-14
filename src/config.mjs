import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ~/x -> $HOME/x ; относительные -> от корня репо ; абсолютные как есть
export function resolvePath(p, base = ROOT) {
  if (!p) return p;
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  if (path.isAbsolute(p)) return p;
  return path.resolve(base, p);
}

// временная рабочая папка (кросс-платформенно, чистится вызывающим)
export function makeWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'silky-'));
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
