import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Граница ядра и модулей: ядро не импортирует модули (кроме точек запуска), модуль берёт из ядра
// только его API (core.ts для сервера, kit.ts для интерфейса), таблицы ядра и общее из src/shared

const ROOT = path.resolve('src');
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'tests' ? [] : files(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

/** Относительные импорты файла — пути от src/, без расширения */
function imports(file: string) {
  const text = readFileSync(file, 'utf8');
  const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
  return specs.map((s) => rel(path.resolve(path.dirname(file), s)).replace(/\.(js|ts|tsx)$/, ''));
}

const all = files(ROOT).map((f) => ({ file: rel(f), imports: imports(f) }));
// Точки запуска подключают реестры модулей — больше никто в ядре
const ENTRY_POINTS: Record<string, string> = { 'server/index.ts': 'modules/server', 'web/main.tsx': 'modules/web' };

test('ядро не импортирует модули', () => {
  const bad = all
    .filter((f) => !f.file.startsWith('modules/'))
    .flatMap((f) => f.imports.filter((i) => i.startsWith('modules/') && ENTRY_POINTS[f.file] !== i).map((i) => `${f.file} → ${i}`));
  assert.deepEqual(bad, []);
});

test('модуль берёт из ядра только его API и не трогает другие модули', () => {
  const allowed = (i: string) => ['server/core', 'server/db/schema', 'web/kit'].includes(i) || i.startsWith('shared/');
  const bad = all
    .filter((f) => /^modules\/[^/]+\//.test(f.file))
    .flatMap((f) => {
      const own = f.file.split('/').slice(0, 2).join('/') + '/';
      return f.imports.filter((i) => !i.startsWith(own) && !allowed(i)).map((i) => `${f.file} → ${i}`);
    });
  assert.deepEqual(bad, []);
});

test('общий код (src/shared) не тянет сервер и интерфейс в рантайме', () => {
  const bad = all
    .filter((f) => f.file.startsWith('shared/'))
    .flatMap((f) => {
      const text = readFileSync(path.join(ROOT, f.file), 'utf8');
      return [...text.matchAll(/^import\s+(?!type\b)[^;]*from\s+['"](\.[^'"]+)['"]/gm)].map((m) => `${f.file} → ${m[1]}`);
    });
  assert.deepEqual(bad, []);
});
