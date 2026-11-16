import assert from 'node:assert/strict';
import { test } from 'node:test';
import { app, db, makeUser, schema } from './helpers.js';

const alice = await makeUser('Alice');
const bob = await makeUser('Bob');

const acc = (await alice.req('POST', '/api/accounts', { name: 'Hetzner' })).body;
const srv = (await alice.req('POST', '/api/servers', { name: 'web-1', accountId: acc.id, ip: '10.0.0.1' })).body;
const cred = (await alice.req('POST', '/api/credentials', { entityType: 'server', entityId: srv.id, kind: 'ssh', username: 'root', secret: 's3cret' })).body;

test('чужие данные не видны и не доступны по id', async () => {
  assert.equal((await bob.req('GET', '/api/servers')).body.length, 0);
  assert.equal((await bob.req('GET', `/api/servers/${srv.id}`)).status, 404);
  assert.equal((await bob.req('PATCH', `/api/servers/${srv.id}`, { name: 'x' })).status, 404);
  assert.equal((await bob.req('DELETE', `/api/servers/${srv.id}`)).status, 404);
  assert.equal((await bob.req('GET', `/api/credentials?entityType=server&entityId=${srv.id}`)).body.length, 0);
  assert.equal((await bob.req('POST', `/api/credentials/${cred.id}/reveal`, {})).status, 404);
  assert.equal((await bob.req('GET', `/api/monitor/server/${srv.id}`)).status, 404);
  assert.equal((await bob.req('GET', '/api/dashboard')).body.counts.servers.total, 0);
  const dom = (await alice.req('POST', '/api/domains', { name: 'alice.ru', autoLookup: false })).body;
  assert.equal((await bob.req('POST', `/api/domains/${dom.id}/lookup`)).status, 404);
  const [owner] = (await alice.req('GET', '/api/members')).body;
  assert.equal((await bob.req('DELETE', `/api/members/${owner.id}`)).status, 404);
  // Приглашение удаляется условием по пространству: чужое остаётся в силе, своё отзывается
  const inv = (await alice.req('POST', '/api/invites', { infraAccess: 'view' })).body;
  const preview = async () => (await bob.req('POST', '/api/invites/preview', { token: inv.token })).status;
  await bob.req('DELETE', `/api/invites/${inv.id}`);
  assert.equal(await preview(), 200);
  await alice.req('DELETE', `/api/invites/${inv.id}`);
  assert.equal(await preview(), 404);
});

test('нельзя сослаться на объект чужого пространства', async () => {
  assert.equal((await bob.req('POST', '/api/servers', { name: 'b', accountId: acc.id })).status, 400);
  assert.equal((await bob.req('POST', '/api/sites', { name: 's', url: 'example.com', serverId: srv.id })).status, 400);
  assert.equal((await bob.req('POST', '/api/credentials', { entityType: 'server', entityId: srv.id, kind: 'ssh' })).status, 400);
});

test('чужое пространство в заголовке — 403', async () => {
  assert.equal((await bob.req('GET', '/api/servers', undefined, alice.workspaceId)).status, 403);
});

test('приглашение: права по модулям', async () => {
  const inv = (await alice.req('POST', '/api/invites', { infraAccess: 'none', modules: { demo: 'view' } })).body;
  assert.ok(inv.token);
  assert.equal((await bob.req('POST', '/api/invites/preview', { token: inv.token })).body.workspaceName, 'WS Alice');
  assert.equal((await bob.req('POST', '/api/invites/accept', { token: inv.token })).status, 200);
  // повторно то же приглашение не работает
  assert.equal((await bob.req('POST', '/api/invites/accept', { token: inv.token })).status, 404);

  // Модуль без инфраструктуры: серверы Alice закрыты, данные модуля открыты, управление модулем — нет
  assert.equal((await bob.req('GET', '/api/servers', undefined, alice.workspaceId)).status, 403);
  assert.deepEqual((await bob.req('GET', '/api/demo/data', undefined, alice.workspaceId)).body, { workspaceId: alice.workspaceId });
  assert.equal((await bob.req('POST', '/api/demo/manage', {}, alice.workspaceId)).status, 403);
  assert.equal((await bob.req('GET', '/api/demo/data')).body.workspaceId, bob.workspaceId, 'в своём — своё');

  const members = (await alice.req('GET', '/api/members')).body;
  const bobMember = members.find((m: { userId: number }) => m.userId === bob.userId);
  await alice.req('PATCH', `/api/members/${bobMember.id}`, { infraAccess: 'view', modules: { demo: 'view' } });
  assert.equal((await bob.req('GET', '/api/servers', undefined, alice.workspaceId)).body.length, 1);
  // просмотр без права правки: пароль не открыть, менять нельзя
  assert.equal((await bob.req('POST', `/api/credentials/${cred.id}/reveal`, {}, alice.workspaceId)).status, 403);
  assert.equal((await bob.req('PATCH', `/api/servers/${srv.id}`, { name: 'x' }, alice.workspaceId)).status, 403);
  // и участниками не управляет, журнал не видит
  assert.equal((await bob.req('GET', '/api/members', undefined, alice.workspaceId)).status, 403);
  assert.equal((await bob.req('GET', '/api/audit', undefined, alice.workspaceId)).status, 403);
});

test('управляющий не выдаёт больше прав, чем у него', async () => {
  const members = (await alice.req('GET', '/api/members')).body;
  const bobMember = members.find((m: { userId: number }) => m.userId === bob.userId);
  await alice.req('PATCH', `/api/members/${bobMember.id}`, { infraAccess: 'view', modules: { demo: 'view' }, canManageMembers: true });

  const tooMuch = await bob.req('POST', '/api/invites', { infraAccess: 'edit' }, alice.workspaceId);
  assert.equal(tooMuch.status, 403);
  const moduleTooMuch = await bob.req('POST', '/api/invites', { infraAccess: 'none', modules: { demo: 'manage' } }, alice.workspaceId);
  assert.equal(moduleTooMuch.status, 403, 'и в модуле не больше своего');
  const manager = await bob.req('POST', '/api/invites', { infraAccess: 'view', canManageMembers: true }, alice.workspaceId);
  assert.equal(manager.status, 403);
  const ok = await bob.req('POST', '/api/invites', { infraAccess: 'view', modules: { demo: 'view' } }, alice.workspaceId);
  assert.equal(ok.status, 200);
  // себе права не меняет, владельца не трогает
  assert.equal((await bob.req('PATCH', `/api/members/${bobMember.id}`, { infraAccess: 'edit', modules: { demo: 'manage' } }, alice.workspaceId)).status, 400);
  const owner = members.find((m: { isOwner: boolean }) => m.isOwner);
  assert.equal((await bob.req('DELETE', `/api/members/${owner.id}`, undefined, alice.workspaceId)).status, 400);
});

test('один домен в разных пространствах', async () => {
  assert.equal((await alice.req('POST', '/api/domains', { name: 'shared.ru', autoLookup: false })).status, 200);
  assert.equal((await bob.req('POST', '/api/domains', { name: 'shared.ru', autoLookup: false })).status, 200);
  assert.equal((await bob.req('POST', '/api/domains', { name: 'shared.ru', autoLookup: false })).status, 400);
});

test('журнал пространства видит только своё', async () => {
  const log = (await alice.req('GET', '/api/audit')).body as { workspaceId: number }[];
  assert.ok(log.length > 0);
  assert.ok(log.every((e) => e.workspaceId === alice.workspaceId));
  assert.equal((await alice.req('GET', '/api/audit?scope=system')).status, 403, 'системный — только администратору системы');
});

test('журнал событий объекта и дашборда — только своего пространства, новые первыми', async () => {
  const ev = (workspaceId: number, entityType: string, message: string) => ({ workspaceId, entityType, entityId: srv.id, kind: 'test', message });
  db.insert(schema.events)
    .values([ev(alice.workspaceId, 'server', 'первое'), ev(alice.workspaceId, 'site', 'сайт с тем же id'), ev(bob.workspaceId, 'server', 'чужое'), ev(alice.workspaceId, 'server', 'последнее')])
    .run();
  const messages = async (url: string) => (await alice.req('GET', url)).body.events.map((e: { message: string }) => e.message);
  assert.deepEqual(await messages(`/api/monitor/server/${srv.id}`), ['последнее', 'первое']);
  assert.deepEqual(await messages('/api/dashboard'), ['последнее', 'сайт с тем же id', 'первое']);
});

test('без заголовка открывается пространство, выбранное последним; без пространств — no_workspace', async () => {
  const current = async () => (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: bob.cookie } })).json().current?.id;
  // «WS Alice» первое по имени: Bob выбирает его, затем своё
  for (const id of [alice.workspaceId, bob.workspaceId]) {
    assert.equal((await bob.req('POST', `/api/workspaces/${id}/select`)).status, 200);
    assert.equal(await current(), id);
  }
  assert.equal((await alice.req('POST', `/api/workspaces/${bob.workspaceId}/select`)).status, 404, 'чужое не выбрать');

  const nomad = await makeUser('Nomad');
  assert.equal((await nomad.req('DELETE', '/api/workspace', { confirmName: 'WS Nomad' })).status, 200);
  // Без пространства: запросы пространства — 403 no_workspace, уровня пользователя (NO_WORKSPACE_PREFIXES) — как обычно
  const status = async (url: string) => (await nomad.req('GET', url)).status;
  assert.deepEqual([await status('/api/servers'), await status('/api/system/x'), await status('/api/demo/me'), await status('/api/demo/data')], [403, 404, 200, 403]);
});

test('своё по id правится и удаляется', async () => {
  assert.equal((await alice.req('PATCH', `/api/credentials/${cred.id}`, { username: 'admin' })).body.username, 'admin');
  assert.equal((await alice.req('PATCH', `/api/servers/${srv.id}`, { name: 'web-2' })).body.name, 'web-2');
  assert.equal((await alice.req('POST', `/api/credentials/${cred.id}/reveal`, {})).body.secret, 's3cret');
  assert.equal((await alice.req('DELETE', `/api/credentials/${cred.id}`)).status, 200);
  assert.equal((await alice.req('POST', `/api/credentials/${cred.id}/reveal`, {})).status, 404);
  assert.equal((await alice.req('DELETE', `/api/servers/${srv.id}`)).status, 200);
  assert.equal((await alice.req('GET', `/api/servers/${srv.id}`)).status, 404);
});
