import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { app, db, makeUser, schema } from './helpers.js';

// Сессия — cookie sid
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '').match(/(?:^|,)\s*(sid=[^;]+)/)?.[1] ?? '';
const inject = (method: 'GET' | 'POST', url: string, payload?: object, cookie = '') =>
  app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });
const me = async (cookie: string) => JSON.parse((await inject('GET', '/api/me', undefined, cookie)).body);

const alice = await makeUser('Alice');
const invite = async (perms: object = { infraAccess: 'view' }) => (await alice.req('POST', '/api/invites', perms)).body.token as string;

test('регистрация по приглашению: аккаунт, своё пространство и вступление', async () => {
  const token = await invite();
  const preview = await inject('POST', '/api/invites/preview', { token });
  assert.equal(preview.statusCode, 200, 'приглашение видно до входа');
  assert.equal(JSON.parse(preview.body).workspaceName, 'WS Alice');
  assert.equal((await inject('POST', '/api/invites/accept', { token })).statusCode, 401, 'вступить без входа нельзя');

  const short = await inject('POST', '/api/invites/register', { token, name: 'Carol', email: 'carol@test.local', password: 'short' });
  assert.equal(short.statusCode, 400);

  const res = await inject('POST', '/api/invites/register', { token, name: 'Carol', email: 'Carol@Test.local', password: 'carol-password-1' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(res.body).workspace.id, alice.workspaceId);
  const m = await me(cookieOf(res));
  assert.equal(m.user.email, 'carol@test.local');
  assert.equal(m.current.id, alice.workspaceId, 'открывается пространство, куда пригласили');
  assert.equal(m.current.infra, 'view');
  assert.equal(m.workspaces.length, 2, 'плюс своё пространство');

  // Ссылка одноразовая: второй аккаунт по ней не завести
  const again = await inject('POST', '/api/invites/register', { token, name: 'Dave', email: 'dave@test.local', password: 'dave-password-1' });
  assert.equal(again.statusCode, 404);
  assert.equal(db.select().from(schema.users).where(eq(schema.users.email, 'dave@test.local')).get(), undefined);

  const login = await inject('POST', '/api/auth/login', { email: 'carol@test.local', password: 'carol-password-1' });
  assert.equal(login.statusCode, 200, 'входит своим паролем');
});

test('регистрация на занятый email не тратит приглашение', async () => {
  const token = await invite();
  const res = await inject('POST', '/api/invites/register', { token, name: 'Dup', email: 'carol@test.local', password: 'dup-password-12' });
  assert.equal(res.statusCode, 400);
  assert.equal((await inject('POST', '/api/invites/preview', { token })).statusCode, 200);
});

test('без приглашения зарегистрироваться нельзя', async () => {
  const res = await inject('POST', '/api/invites/register', { token: 'not-a-real-token-123', name: 'X', email: 'x@test.local', password: 'x-password-123' });
  assert.equal(res.statusCode, 404);
});

test('права модуля в приглашении: в предпросмотре и у вступившего; незнакомый модуль или уровень — 400', async () => {
  assert.equal((await alice.req('POST', '/api/invites', { infraAccess: 'none', modules: { nope: 'view' } })).status, 400);
  assert.equal((await alice.req('POST', '/api/invites', { infraAccess: 'none', modules: { demo: 'admin' } })).status, 400);
  const token = await invite({ infraAccess: 'none', modules: { demo: 'view' } });
  assert.deepEqual(JSON.parse((await inject('POST', '/api/invites/preview', { token })).body).modules, { demo: 'view' });
  const res = await inject('POST', '/api/invites/register', { token, name: 'Erin', email: 'erin@test.local', password: 'erin-password-1' });
  const m = await me(cookieOf(res));
  assert.deepEqual([m.current.infra, m.current.modules], ['none', { demo: 'view' }]);
});

test('регистраций за сутки — не больше потолка на всю панель', async () => {
  const { REGISTER_LIMIT } = await import('../src/server/routes/workspaces.js');
  const saved = REGISTER_LIMIT.perDay;
  REGISTER_LIMIT.perDay = db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'user.register')).all().length + 1;
  try {
    // Заведённый администратором аккаунт потолок не расходует
    db.insert(schema.users).values({ email: 'by-admin@test.local', name: 'by-admin', role: 'user' }).run();
    const reg = async (name: string) =>
      app.inject({ method: 'POST', url: '/api/invites/register', remoteAddress: '203.0.113.150', payload: { token: await invite(), name, email: `${name}@test.local`, password: 'limit-password-1' } });
    assert.equal((await reg('first')).statusCode, 200);
    const over = await reg('second');
    assert.equal(over.statusCode, 429);
    assert.equal(db.select().from(schema.users).where(eq(schema.users.email, 'second@test.local')).get(), undefined);
  } finally {
    REGISTER_LIMIT.perDay = saved;
  }
});
