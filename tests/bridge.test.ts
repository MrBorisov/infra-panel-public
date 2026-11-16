import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { app, BRIDGE_TOKENS, bridge, db, makeUser, schema } from './helpers.js';

const { encrypt } = await import('../src/server/crypto.js');
const { dispatch } = await import('../src/server/notify.js');

// Мост ботов на VDS и личный Telegram — ядро, от модулей не зависят

const alice = await makeUser('Alice');
db.update(schema.users).set({ telegramUserId: 555 }).where(eq(schema.users.id, alice.userId)).run();
db.insert(schema.notifyChannels)
  .values({
    workspaceId: alice.workspaceId,
    kind: 'discord_webhook',
    name: 'infra',
    secretEnc: encrypt('https://discord.com/api/webhooks/1/abc'),
    topics: JSON.stringify(['infra.status']),
  })
  .run();
for (const title of ['web-1 упал', 'web-2 упал', 'db-1 упал', 'web-1 поднялся']) dispatch(alice.workspaceId, { topic: 'infra.status', severity: 'critical', title });

test('мост ботов: контракт', async () => {
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });
  assert.equal((await get('/api/v1/tg/pending/')).statusCode, 403);
  assert.equal((await get('/api/v1/tg/pending/', { 'x-bot-token': 'wrong' })).statusCode, 403);
  assert.equal((await get(`/api/v1/tg/pending/?token=${BRIDGE_TOKENS.tg}`)).statusCode, 403);
  assert.equal((await get('/api/v1/tg/pending/', { 'x-bot-token': BRIDGE_TOKENS.bot })).statusCode, 403);

  const pending = (await get('/api/v1/tg/pending/', { authorization: `Bearer ${BRIDGE_TOKENS.tg}` })).json();
  assert.equal(pending.length, 4);
  assert.deepEqual(Object.keys(pending[0]).sort(), ['id', 'text', 'tg_user_id']);

  const bot = (await bridge('bot', 'pending')).json();
  assert.equal(bot[0].webhook_url, 'https://discord.com/api/webhooks/1/abc');
  assert.ok(bot[0].embed_data.title);

  const mark = await bridge('tg', 'mark-sent', { ids: [pending[0].id, pending[1].id], failed: { [String(pending[2].id)]: 'Forbidden: bot was blocked' } });
  assert.deepEqual(mark.json(), { marked: 3 });
  assert.equal((await bridge('tg', 'pending')).json().length, 1);
});

test('привязка Telegram через бота', async () => {
  const { deepLink } = (await alice.req('POST', '/api/me/telegram/link', {})).body;
  const token = new URL(deepLink).searchParams.get('start');
  assert.match(deepLink, /^https:\/\/t\.me\/panel_test_bot\?start=/);
  const link = (payload: object) => bridge('tg', 'link', payload);
  assert.deepEqual((await link({ link_token: 'x'.repeat(20), tg_user_id: 777 })).json(), { ok: false, reason: 'expired' });
  assert.equal((await link({ link_token: token })).statusCode, 400);
  assert.deepEqual((await link({ link_token: token, tg_user_id: 777, tg_username: 'alice' })).json(), { ok: true });
  assert.equal(db.select().from(schema.users).where(eq(schema.users.id, alice.userId)).get()!.telegramUserId, 777);
  // одноразовая
  assert.deepEqual((await link({ link_token: token, tg_user_id: 888 })).json(), { ok: false, reason: 'expired' });
});

test('повторная тревога с тем же текстом уходит снова: сервер мог упасть второй раз', async () => {
  const bob = await makeUser('Bob');
  db.update(schema.users).set({ telegramUserId: 9001 }).where(eq(schema.users.id, bob.userId)).run();
  const down = { topic: 'infra.status', severity: 'critical', title: 'Сервер «prod» недоступен' } as const;
  dispatch(bob.workspaceId, down);
  dispatch(bob.workspaceId, down);
  assert.equal(db.select().from(schema.tgQueue).where(eq(schema.tgQueue.chatId, '9001')).all().length, 2);
});
