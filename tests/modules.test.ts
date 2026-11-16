import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { app, db, join, makeUser, schema, type Client } from './helpers.js';

const { encrypt } = await import('../src/server/crypto.js');
const { cleanupModules, installModules } = await import('../src/server/modules.js');
const { dispatch } = await import('../src/server/notify.js');
const { buildApp } = await import('../src/server/app.js');
const { demoModule, demoState } = await import('./fixtures/demo-module.js');

// Механизм модулей ядра — на демо-модуле: подключение, выключатели, сохранение прав и тем, ошибки модуля

const [alice, bob, carol, admin] = [await makeUser('Alice'), await makeUser('Bob'), await makeUser('Carol'), await makeUser('Admin')];
db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, admin.userId)).run();
db.update(schema.users).set({ telegramUserId: 801 }).where(eq(schema.users.id, bob.userId)).run();
await join(alice, bob, { infraAccess: 'view', modules: { demo: 'view' } });
await join(alice, carol, { infraAccess: 'edit', modules: { demo: 'manage' }, canManageMembers: true });

const anon = (url: string) => app.inject({ method: 'GET', url });
const current = async (u: Client, ws = alice.workspaceId) => (await u.req('GET', '/api/me', undefined, ws)).body.current;
const memberId = async (u: Client) => (await alice.req('GET', '/api/members')).body.find((m: { userId: number }) => m.userId === u.userId).id;
const setWorkspace = (enabled: boolean) => admin.req('PATCH', `/api/system/workspaces/${alice.workspaceId}/modules/demo`, { enabled });
const setSite = (enabled: boolean) => admin.req('PATCH', '/api/system/modules/demo', { enabled });
const channel = (topics: string[]) =>
  db
    .insert(schema.notifyChannels)
    .values({ workspaceId: alice.workspaceId, kind: 'discord_webhook', name: topics.join(','), secretEnc: encrypt('https://discord.com/api/webhooks/1/abc'), topics: JSON.stringify(topics) })
    .returning()
    .get();
const savedTopics = (id: number) => JSON.parse(db.select().from(schema.notifyChannels).where(eq(schema.notifyChannels.id, id)).get()!.topics);
const queued = (channelId: number) => db.select().from(schema.discordQueue).where(eq(schema.discordQueue.channelId, channelId)).all().length;

test('пути модуля: публичные — только объявленные, пользовательские — без пространства; кнопка входа и CSP', async () => {
  assert.equal((await anon('/api/demo/public')).statusCode, 200);
  assert.equal((await anon('/api/demo/me')).statusCode, 401);
  assert.equal((await anon('/api/demo/data')).statusCode, 401);
  assert.deepEqual((await anon('/api/auth/providers')).json(), [{ id: 'demo', label: 'Войти через демо', url: '/api/demo/public' }]);
  assert.match(String((await anon('/api/health')).headers['content-security-policy']), /img-src 'self' data: https:\/\/img\.demo\.test/);
  assert.deepEqual(await current(bob), { id: alice.workspaceId, name: 'WS Alice', isOwner: false, infra: 'view', manageMembers: false, modules: { demo: 'view' } });
  assert.deepEqual((await current(alice)).modules, { demo: 'manage' }, 'владелец — верхний уровень');
});

test('модуль недоступен на сервере (нет ключей) — выключен везде', async () => {
  demoState.available = false;
  try {
    assert.deepEqual((await current(bob)).modules, {});
    assert.deepEqual(await bob.req('GET', '/api/demo/data', undefined, alice.workspaceId), { status: 403, body: { error: 'Модуль Демо выключен' } });
    assert.deepEqual((await anon('/api/auth/providers')).json(), []);
    const demo = (await admin.req('GET', '/api/system/modules')).body.modules[0];
    assert.deepEqual([demo.available, demo.unavailableReason, demo.enabled], [false, 'Демо недоступно', true]);
  } finally {
    demoState.available = true;
  }
});

test('выключенный в пространстве модуль: ни маршрутов, ни тем, ни тревог; права и подписки сохраняются', async () => {
  const ch = channel(['infra.status', 'demo.alert']);
  assert.equal((await setWorkspace(false)).status, 200);
  assert.deepEqual((await current(bob)).modules, {});
  assert.equal((await bob.req('GET', '/api/demo/data', undefined, alice.workspaceId)).status, 403);
  assert.equal((await bob.req('GET', '/api/demo/data')).status, 200, 'в своём пространстве Bob модуль работает');
  const settings = (await carol.req('GET', '/api/notifications', undefined, alice.workspaceId)).body;
  assert.ok(!settings.topics.some((t: { key: string }) => t.key.startsWith('demo.')));

  dispatch(alice.workspaceId, { topic: 'demo.alert', severity: 'critical', title: 'Тревога демо' });
  assert.equal(queued(ch.id), 0, 'тревога выключенного модуля не уходит в канал');
  assert.equal(db.select().from(schema.tgQueue).where(eq(schema.tgQueue.chatId, '801')).all().length, 0, 'и участнику');

  // Правка тем, каналов и прав при выключенном модуле не теряет его настроек
  assert.equal((await bob.req('PUT', '/api/notifications/my-topics', { topics: ['infra.status'] }, alice.workspaceId)).status, 200);
  assert.equal((await alice.req('PATCH', `/api/channels/${ch.id}`, { topics: ['infra.deadline'] })).status, 200);
  assert.deepEqual(savedTopics(ch.id), ['infra.deadline', 'demo.alert']);
  assert.equal((await carol.req('PATCH', `/api/members/${await memberId(bob)}`, { infraAccess: 'edit' }, alice.workspaceId)).status, 200);
  assert.equal((await alice.req('GET', '/api/members')).body.find((m: { userId: number }) => m.userId === bob.userId).modules.demo, 'view');

  assert.equal((await setWorkspace(true)).status, 200);
  assert.equal((await current(bob)).modules.demo, 'view', 'включили — права на месте');
  assert.ok((await bob.req('GET', '/api/notifications', undefined, alice.workspaceId)).body.myTopics.includes('demo.alert'));
  dispatch(alice.workspaceId, { topic: 'demo.alert', severity: 'critical', title: 'Тревога демо 2' });
  assert.equal(queued(ch.id), 1);
  assert.equal(db.select().from(schema.tgQueue).where(eq(schema.tgQueue.chatId, '801')).all().length, 1);
});

test('выключенный для сайта модуль; раздел «Модули» — только администратору', async () => {
  assert.equal((await alice.req('GET', '/api/system/modules')).status, 403);
  assert.equal((await alice.req('PATCH', '/api/system/modules/demo', { enabled: false })).status, 403);
  assert.equal((await admin.req('PATCH', '/api/system/modules/nope', { enabled: false })).status, 404);
  assert.equal((await setSite(false)).status, 200);
  assert.deepEqual((await current(alice)).modules, {});
  assert.deepEqual((await anon('/api/auth/providers')).json(), []);
  const sys = (await admin.req('GET', '/api/system/modules')).body;
  assert.deepEqual(sys.modules[0], {
    id: 'demo',
    title: 'Демо',
    description: 'Модуль для тестов ядра',
    available: true,
    unavailableReason: 'Демо недоступно',
    enabled: false,
    offWarning: 'Демо-пользователи не войдут',
    counterLabel: 'Штуки',
  });
  const ws = sys.workspaces.find((w: { id: number }) => w.id === alice.workspaceId);
  assert.deepEqual([ws.members, ws.modules.demo.enabled], [3, true]);
  assert.equal(sys.workspaces.find((w: { id: number }) => w.id === 1).modules.demo.count, 7);
  await setSite(true);
  assert.equal((await current(alice)).modules.demo, 'manage');
  assert.ok((await alice.req('GET', '/api/audit')).body.some((a: { action: string }) => a.action === 'workspace.module'));
});

test('тема удалённого модуля: рассылка её пропускает, канал с ней трогает только владелец', async () => {
  const ch = channel(['infra.status', 'gone.alert']);
  assert.doesNotThrow(() => dispatch(alice.workspaceId, { topic: 'gone.alert', severity: 'critical', title: 'Из прошлого' }));
  assert.equal(queued(ch.id), 0);
  // У Carol права на всё подключённое, но тему удалённого модуля её права не покрывают
  const seen = (await carol.req('GET', '/api/notifications', undefined, alice.workspaceId)).body.channels;
  assert.ok(!seen.some((c: { id: number }) => c.id === ch.id));
  assert.equal((await carol.req('PATCH', `/api/channels/${ch.id}`, { target: null, name: 'чужой' }, alice.workspaceId)).status, 403);
  assert.equal((await carol.req('DELETE', `/api/channels/${ch.id}`, undefined, alice.workspaceId)).status, 403);
  // Владелец правит — тема модуля сохраняется до его возвращения, но в списке её не видно
  assert.equal((await alice.req('PATCH', `/api/channels/${ch.id}`, { topics: ['infra.deadline'] })).status, 200);
  assert.deepEqual(savedTopics(ch.id), ['infra.deadline', 'gone.alert']);
  const mine = (await alice.req('GET', '/api/notifications')).body.channels.find((c: { id: number }) => c.id === ch.id);
  assert.deepEqual(mine.topics, ['infra.deadline']);
});

test('права удалённого модуля: по старой ссылке не выдаются, в списках не видны', async () => {
  const dave = await makeUser('Dave');
  const token = (await alice.req('POST', '/api/invites', { infraAccess: 'view', modules: { demo: 'view' } })).body.token;
  db.update(schema.workspaceInvites).set({ modules: { demo: 'view', gone: 'manage' } }).run();
  assert.equal((await dave.req('POST', '/api/invites/accept', { token })).status, 200);
  const row = db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, dave.userId)).all().find((m) => m.workspaceId === alice.workspaceId)!;
  assert.deepEqual(row.modules, { demo: 'view' });
  db.update(schema.workspaceMembers).set({ modules: { demo: 'view', gone: 'manage' } }).where(eq(schema.workspaceMembers.id, row.id)).run();
  assert.deepEqual((await alice.req('GET', '/api/members')).body.find((m: { userId: number }) => m.userId === dave.userId).modules, { demo: 'view' });
  assert.deepEqual((await current(dave)).modules, { demo: 'view' });
});

test('ошибка в фоновом хуке модуля не роняет ядро', () => {
  demoState.failCleanup = true;
  const before = demoState.cleanups;
  assert.doesNotThrow(() => cleanupModules(Date.now()));
  assert.equal(demoState.cleanups, before + 1);
  demoState.failCleanup = false;
});

test('описание модуля с ошибкой — отказ при запуске', async () => {
  const bad = [
    { ...demoModule, id: 'auth' },
    { ...demoModule, levels: ['view', 'manage'] },
    { ...demoModule, topics: [{ key: 'other.alert', label: 'x' }] },
    { ...demoModule, publicPaths: ['/api/servers'] },
  ];
  try {
    for (const m of bad) assert.throws(() => installModules([m]), /Модуль/, JSON.stringify(m.id));
    assert.throws(() => installModules([demoModule, demoModule]), /дважды/);
    const sneaky = { ...demoModule, routes: (a: typeof app) => a.get('/api/servers/all', async () => []) };
    await assert.rejects(buildApp({ modules: [sneaky] }), /вне \/api\/demo\//);
  } finally {
    installModules([demoModule]);
  }
});
