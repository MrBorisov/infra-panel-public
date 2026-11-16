import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Окружение задаётся ДО импорта модулей сервера: config читает его при загрузке
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'panel-test-'));
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.MONITOR_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.PUBLIC_URL = 'https://panel.test';
export const BRIDGE_TOKENS = { tg: 'tg-bot-secret', bot: 'discord-bot-secret' };
process.env.BOT_API_TOKEN = BRIDGE_TOKENS.bot;
process.env.TG_BOT_API_TOKEN = BRIDGE_TOKENS.tg;
process.env.TELEGRAM_BOT_USERNAME = 'panel_test_bot';

/** Подмена fetch: совпадение по origin+path; остальное — 404 */
type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
const routes: { endpoint: string; handler: Handler }[] = [];
export function mockFetch(endpoint: string, handler: Handler) {
  routes.unshift({ endpoint, handler });
}
export const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { status: 200, ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const route = routes.find((r) => r.endpoint === `${url.origin}${url.pathname}`);
  return route ? route.handler(url, init) : new Response('not found', { status: 404 });
}) as typeof fetch;

const { runMigrations, db, schema } = await import('../src/server/db/index.js');
const { buildApp } = await import('../src/server/app.js');
const { hashPassword } = await import('../src/server/crypto.js');
const { createWorkspace } = await import('../src/server/workspaces.js');

/**
 * Модули приложения в тестах: по умолчанию демо-модуль (тесты ядра не зависят от настоящих),
 * TEST_MODULES=none — одно ядро (tests/use/no-modules.ts), installed — подключённые в src/modules/server.ts
 * (тесты модулей). Задаётся импортом-побочным эффектом до helpers
 */
async function testModules() {
  if (process.env.TEST_MODULES === 'none') return [];
  if (process.env.TEST_MODULES === 'installed') return (await import('../src/modules/server.js')).serverModules;
  return [(await import('./fixtures/demo-module.js')).demoModule];
}

runMigrations();
export const app = await buildApp({ modules: await testModules() });
export { db, schema };

/** Запрос бота с VDS к мосту /api/v1/{tg,bot}/* со своим секретом: с телом — POST, без — GET */
export const bridge = (kind: 'tg' | 'bot', op: string, payload?: object, remoteAddress?: string) =>
  app.inject({ method: payload ? 'POST' : 'GET', url: `/api/v1/${kind}/${op}/`, headers: { 'x-bot-token': BRIDGE_TOKENS[kind] }, payload, remoteAddress });

export interface Client {
  userId: number;
  workspaceId: number;
  /** cookie сессии — для запросов мимо req(), например переходов браузера */
  cookie: string;
  req: (method: string, url: string, body?: unknown, ws?: number) => Promise<{ status: number; body: any }>;
}

let n = 0;
/** Пользователь со своим пространством и залогиненной сессией */
export async function makeUser(name: string): Promise<Client> {
  const email = `${name.toLowerCase()}-${++n}@test.local`;
  const password = 'test-password-123';
  const user = db.insert(schema.users).values({ email, name, passwordHash: await hashPassword(password) }).returning().get();
  const ws = createWorkspace(`WS ${name}`, user.id);
  // У каждого свой адрес: лимит попыток входа считается по IP, а пользователей в файле бывает много
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: `198.51.100.${n % 250}` });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  return {
    userId: user.id,
    workspaceId: ws.id,
    cookie,
    req: async (method, url, body, wsOverride) => {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: { cookie, 'x-workspace': String(wsOverride ?? ws.id) },
        ...(body !== undefined ? { payload: body as object } : {}),
      });
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    },
  };
}

/** Вступить в пространство владельца с такими правами (приглашение создаёт владелец) */
export async function join(owner: Client, user: Client, perms: { infraAccess: string; modules?: Record<string, string>; canManageMembers?: boolean }) {
  const token = (await owner.req('POST', '/api/invites', perms)).body.token;
  assert.equal((await user.req('POST', '/api/invites/accept', { token })).status, 200);
}
