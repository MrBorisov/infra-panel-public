import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { app, db, makeUser, schema } from './helpers.js';

const user = await makeUser('Tom');
const { email } = db.select().from(schema.users).where(eq(schema.users.id, user.userId)).get()!;
const setup = (await user.req('POST', '/api/me/totp/setup')).body;
const totp = new TOTP({ secret: Secret.fromBase32(setup.secret), digits: 6, period: 30, algorithm: 'SHA1' });
const code = (offsetSteps = 0) => totp.generate({ timestamp: Date.now() + offsetSteps * 30_000 });
assert.equal((await user.req('POST', '/api/me/totp/enable', { code: code() })).status, 200);

let ip = 0;
/** Вход паролем → полувход, ждущий кода 2FA */
async function halfLogin() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'test-password-123' },
    remoteAddress: `203.0.113.${++ip}`,
  });
  assert.equal(JSON.parse(res.body).mfaRequired, true);
  return String(res.headers['set-cookie']).split(';')[0];
}
const sendCode = (cookie: string, c: string) =>
  app.inject({ method: 'POST', url: '/api/auth/totp', headers: { cookie }, payload: { code: c }, remoteAddress: `203.0.113.${++ip}` });
const forgetSteps = () => db.update(schema.users).set({ totpLastStep: null }).where(eq(schema.users.id, user.userId)).run();

test('один и тот же код 2FA второй раз не принимается', async () => {
  forgetSteps();
  const c = code();
  assert.equal((await sendCode(await halfLogin(), c)).statusCode, 200);
  assert.equal((await sendCode(await halfLogin(), c)).statusCode, 401, 'подсмотренный код уже не годится');
});

test('после пяти неверных кодов вход кодом закрыт и владельца предупреждают', async () => {
  // Повтор кода в прошлом тесте — тоже неудача; начинаем с чистого счётчика
  db.update(schema.users).set({ telegramUserId: 424242, totpFailures: 0, totpFailedAt: null }).where(eq(schema.users.id, user.userId)).run();
  const cookie = await halfLogin();
  // Каждый код — со своего IP: лимит по IP такой перебор не ловит
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push((await sendCode(cookie, '000000')).statusCode);
  assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
  assert.equal((await sendCode(cookie, code(1))).statusCode, 401, 'полувход после блокировки закрыт');

  forgetSteps();
  assert.equal((await sendCode(await halfLogin(), code(1))).statusCode, 429, 'и с верным кодом — 15 минут ждать');
  const warning = db.select().from(schema.tgQueue).where(eq(schema.tgQueue.chatId, '424242')).all();
  assert.equal(warning.length, 1);
  assert.match(warning[0].text, /неверных кодов 2FA/);

  // Через 15 минут счётчик начинается заново
  db.update(schema.users).set({ totpFailedAt: Date.now() - 16 * 60_000 }).where(eq(schema.users.id, user.userId)).run();
  forgetSteps();
  assert.equal((await sendCode(await halfLogin(), code())).statusCode, 200);
});

test('время входа ставит полный вход, а не полувход до кода 2FA', async () => {
  const lastLoginAt = () => db.select().from(schema.users).where(eq(schema.users.id, user.userId)).get()!.lastLoginAt;
  db.update(schema.users).set({ lastLoginAt: null }).where(eq(schema.users.id, user.userId)).run();
  forgetSteps();
  const cookie = await halfLogin();
  assert.equal(lastLoginAt(), null, 'пароль без кода — ещё не вход');
  assert.equal((await sendCode(cookie, code())).statusCode, 200);
  assert.ok(lastLoginAt(), 'вход после кода 2FA');
});

test('отключение 2FA: пароль не перебрать — после 10 попыток 429', async () => {
  const statuses: number[] = [];
  // Каждая попытка — с нового IP: счётчик на пользователя, а не на адрес
  for (let i = 0; i < 11; i++) {
    const res = await app.inject({ method: 'POST', url: '/api/me/totp/disable', headers: { cookie: user.cookie }, payload: { password: `wrong-${i}` }, remoteAddress: `203.0.113.${30 + i}` });
    statuses.push(res.statusCode);
  }
  assert.deepEqual([statuses[0], statuses.at(-1)], [400, 429]);
});
