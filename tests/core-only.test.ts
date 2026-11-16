import './use/no-modules.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { app, db, join, makeUser, schema } from './helpers.js';

const { dispatch } = await import('../src/server/notify.js');

// Ядро без единого модуля: всё, что связано с учётом, работает; путей и прав модулей нет

const alice = await makeUser('Alice');
const bob = await makeUser('Bob');
const admin = await makeUser('Admin');
db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, admin.userId)).run();

test('вход, пространство и права — без модулей', async () => {
  const me = (await alice.req('GET', '/api/me')).body;
  assert.deepEqual(me.current, { id: alice.workspaceId, name: 'WS Alice', isOwner: true, infra: 'edit', manageMembers: true, modules: {} });
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/auth/providers' })).json(), []);
  // Пути модулей не публичные и не существуют: без входа — 401, со входом — 404
  for (const url of ['/api/eve/login', '/api/eve/callback', '/api/eve/status', '/api/demo/public']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
  }
  assert.equal((await alice.req('GET', '/api/eve/corps')).status, 404);
});

test('учёт и мониторинг работают', async () => {
  const acc = await alice.req('POST', '/api/accounts', { name: 'Hetzner' });
  const srv = await alice.req('POST', '/api/servers', { name: 'web-1', accountId: acc.body.id, ip: '203.0.113.10' });
  assert.equal(srv.status, 200);
  const dash = (await alice.req('GET', '/api/dashboard')).body;
  assert.equal(dash.counts.servers.total, 1);
  db.insert(schema.events).values({ workspaceId: alice.workspaceId, entityType: 'eve_corp', entityId: 1, kind: 'x', message: 'событие удалённого модуля' }).run();
  assert.ok(!(await alice.req('GET', '/api/dashboard')).body.events.some((e: { message: string }) => e.message.includes('удалённого')));
});

test('приглашения: права только на инфраструктуру; права модуля — 400', async () => {
  assert.equal((await alice.req('POST', '/api/invites', { infraAccess: 'view', modules: { eve: 'view' } })).status, 400);
  await join(alice, bob, { infraAccess: 'view' });
  const preview = (await alice.req('GET', '/api/members')).body.find((m: { userId: number }) => m.userId === bob.userId);
  assert.deepEqual([preview.infraAccess, preview.modules], ['view', {}]);
  assert.equal((await bob.req('GET', '/api/servers', undefined, alice.workspaceId)).body.length, 1);
});

test('оповещения: только темы ядра; темы модулей не принимаются и не рассылаются', async () => {
  const s = (await alice.req('GET', '/api/notifications')).body;
  assert.deepEqual(
    s.topics.map((t: { key: string }) => t.key),
    ['infra.status', 'infra.deadline'],
  );
  assert.equal((await alice.req('POST', '/api/channels', { kind: 'discord_webhook', name: 'x', secret: 'https://discord.com/api/webhooks/1/abc', topics: ['eve.attack'] })).status, 400);
  const ok = await alice.req('POST', '/api/channels', { kind: 'discord_webhook', name: 'infra', secret: 'https://discord.com/api/webhooks/1/abc', topics: ['infra.status'] });
  assert.equal(ok.status, 200);
  dispatch(alice.workspaceId, { topic: 'infra.status', severity: 'critical', title: 'web-1 упал' });
  dispatch(alice.workspaceId, { topic: 'eve.attack', severity: 'critical', title: 'Атака' });
  assert.equal(db.select().from(schema.discordQueue).where(eq(schema.discordQueue.channelId, ok.body.id)).all().length, 1);
});

test('раздел «Модули» пуст, но работает', async () => {
  const sys = await admin.req('GET', '/api/system/modules');
  assert.equal(sys.status, 200);
  assert.deepEqual(sys.body.modules, []);
  assert.ok(sys.body.workspaces.some((w: { id: number; modules: object }) => w.id === alice.workspaceId && Object.keys(w.modules).length === 0));
  assert.equal((await admin.req('PATCH', '/api/system/modules/eve', { enabled: false })).status, 404);
});
