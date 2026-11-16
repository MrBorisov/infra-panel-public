import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { app, bridge, db, join, makeUser, schema } from './helpers.js';

const { config } = await import('../src/server/config.js');
const { ENTITY_LIMITS } = await import('../src/server/routes/entities.js');

// Второй заход аудита безопасности 08.10.2026: квоты, сброс пароля админом, мост по IP, сессии

test('квоты: объекты, свои пространства, каналы', async () => {
  const u = await makeUser('Quota');
  const saved = ENTITY_LIMITS.servers;
  ENTITY_LIMITS.servers = 2;
  try {
    assert.equal((await u.req('POST', '/api/servers', { name: 's1' })).status, 200);
    assert.equal((await u.req('POST', '/api/servers', { name: 's2' })).status, 200);
    const over = await u.req('POST', '/api/servers', { name: 's3' });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /не больше 2/);
    // Второе своё пространство лимит не удваивает
    const second = (await u.req('POST', '/api/workspaces', { name: 'second' })).body.id;
    assert.equal((await u.req('POST', '/api/servers', { name: 's4' }, second)).status, 400);
  } finally {
    ENTITY_LIMITS.servers = saved;
  }

  const created: number[] = [];
  for (let i = 0; i < 25; i++) created.push((await u.req('POST', '/api/workspaces', { name: `ws ${i}` })).status);
  assert.equal(created.filter((s) => s === 200).length, 18, 'своё и «second» уже есть, ещё 18 — и хватит');
  assert.equal(created.at(-1), 400);

  const channel = (i: number) =>
    u.req('POST', '/api/channels', { kind: 'discord_webhook', name: `c${i}`, secret: `https://discord.com/api/webhooks/1${i}/abc`, topics: ['infra.status'] });
  for (let i = 0; i < 20; i++) assert.equal((await channel(i)).status, 200);
  assert.equal((await channel(20)).status, 400);
});

test('«Проверить сейчас» — не чаще 20 раз в минуту', async () => {
  const u = await makeUser('Runner');
  const s = (await u.req('POST', '/api/servers', { name: 'r', ip: '127.0.0.1' })).body;
  const statuses: number[] = [];
  for (let i = 0; i < 22; i++) statuses.push((await u.req('POST', `/api/monitor/server/${s.id}/run`)).status);
  assert.equal(statuses.filter((x) => x === 200).length, 20);
  assert.equal(statuses.at(-1), 429);
});

test('сброс пароля админом виден владельцу и самому пользователю', async () => {
  const admin = await makeUser('Root');
  db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, admin.userId)).run();
  const owner = await makeUser('Owner');
  db.update(schema.users).set({ telegramUserId: 515151 }).where(eq(schema.users.id, owner.userId)).run();

  const res = await admin.req('PATCH', `/api/users/${owner.userId}`, { password: 'new-password-123', resetTotp: true });
  assert.equal(res.status, 200);
  const journal = db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.workspaceId, owner.workspaceId), eq(schema.auditLog.action, 'user.reset_by_admin')))
    .all();
  assert.equal(journal.length, 1, 'запись в журнале его пространства');
  assert.match(journal[0].details ?? '', /пароль и 2FA/);
  const tg = db.select().from(schema.tgQueue).where(eq(schema.tgQueue.chatId, '515151')).all();
  assert.equal(tg.length, 1);
  assert.match(tg[0].text, /администратор системы Root сбросил вам пароль и 2FA/);
});

test('удаление пользователя: владельца пространства с участниками — нельзя, очередь его каналов чистится', async () => {
  const admin = await makeUser('Sysop');
  db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, admin.userId)).run();
  const [boss, member] = [await makeUser('Boss'), await makeUser('Member')];
  await join(boss, member, { infraAccess: 'none' });
  assert.equal((await admin.req('DELETE', `/api/users/${boss.userId}`)).status, 400, 'сначала передать владение');
  const ch = await member.req('POST', '/api/channels', { kind: 'discord_webhook', name: 'c', secret: 'https://discord.com/api/webhooks/9/abc', topics: ['infra.status'] });
  assert.equal((await member.req('POST', `/api/channels/${ch.body.id}/test`)).status, 200);
  const pending = () => db.select().from(schema.discordQueue).where(eq(schema.discordQueue.status, 'pending')).all().length;
  const before = pending();
  assert.equal((await admin.req('DELETE', `/api/users/${member.userId}`)).status, 200);
  assert.equal(pending(), before - 1, 'неотправленное его канала удалено');
});

test('смена пароля: вход новым паролем', async () => {
  const u = await makeUser('Pass');
  assert.equal((await u.req('POST', '/api/me/password', { current: 'test-password-123', next: 'next-password-456' })).status, 200);
  const { email } = db.select().from(schema.users).where(eq(schema.users.id, u.userId)).get()!;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'next-password-456' }, remoteAddress: '203.0.113.201' });
  assert.equal(login.statusCode, 200);
});

test('мост принимает только адреса из BOT_ALLOWED_IPS', async () => {
  const pending = (remoteAddress: string) => bridge('tg', 'pending', undefined, remoteAddress);
  assert.equal((await pending('203.0.113.77')).statusCode, 200, 'пустой список — как раньше');
  config.bots.allowedIps = ['203.0.113.50'];
  try {
    assert.equal((await pending('203.0.113.77')).statusCode, 403, 'секрет верный, адрес чужой');
    assert.equal((await pending('203.0.113.50')).statusCode, 200);
  } finally {
    config.bots.allowedIps = [];
  }
});

test('включение 2FA завершает другие сессии', async () => {
  const u = await makeUser('Twofa');
  const bystander = await makeUser('Bystander');
  const { email } = db.select().from(schema.users).where(eq(schema.users.id, u.userId)).get()!;
  const other = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-123' }, remoteAddress: '203.0.113.88' });
  const otherCookie = String(other.headers['set-cookie']).split(';')[0];
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: otherCookie } })).statusCode, 200);

  const { TOTP, Secret } = await import('otpauth');
  const setup = (await u.req('POST', '/api/me/totp/setup')).body;
  const code = new TOTP({ secret: Secret.fromBase32(setup.secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();
  assert.equal((await u.req('POST', '/api/me/totp/enable', { code })).status, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: otherCookie } })).statusCode, 401, 'вошедшая без кода сессия закрыта');
  assert.equal((await u.req('GET', '/api/me')).status, 200, 'текущая остаётся');
  assert.equal((await bystander.req('GET', '/api/me')).status, 200, 'сессии других пользователей не трогаем');
});

test('выкат: ошибка grep в all_match — сборка, а не «только документы»', () => {
  // all_match и NO_BUILD_RE — из самого scripts/deploy.sh, зовём как он: из if под set -e
  const script = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8');
  const defs = [/^NO_BUILD_RE=.*$/m, /^all_match\(\) \{(.*\}$|[\s\S]*?^\}$)/m].map((re) => script.match(re)![0]).join('\n');
  const sh = `set -Eeuo pipefail\n${defs}\nif all_match "$1" "\${2:-$NO_BUILD_RE}"; then echo yes; fi`;
  const docsOnly = (list: string, re?: string) => spawnSync('bash', ['-c', sh, '_', list, ...(re ? [re] : [])], { encoding: 'utf8' }).stdout.trim() === 'yes';
  assert.deepEqual([docsOnly('README.md\ndocs/a.txt'), docsOnly(''), docsOnly('README.md\nsrc/server/app.ts')], [true, true, false]);
  assert.equal(docsOnly('README.md', '(\\.md$'), false, 'опечатка в регулярке');
});

test('выкат: DNS из частной сети — в IPAddressAllow, остальное — нет', () => {
  // private_dns_allow — из самого scripts/deploy.sh: без него IPAddressDeny отрезал бы панели DNS
  const script = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8');
  const fn = script.match(/^private_dns_allow\(\) \{[\s\S]*?^\}$/m)![0];
  const conf = ['127.0.0.53', '192.168.1.1', '8.8.8.8', '100.100.100.100', '172.32.0.1', 'fe80::1%eth0', '2001:4860::8888', '10.0.0.2'].map((ns) => `nameserver ${ns}`).join('\n');
  const run = (text: string) =>
    spawnSync('bash', ['-c', `set -Eeuo pipefail\n${fn}\nf=$(mktemp); printf '%s\n' "$1" > "$f"; private_dns_allow "$f"; rm -f "$f"`, '_', text], { encoding: 'utf8' }).stdout.trim();
  assert.equal(run(conf), 'IPAddressAllow=192.168.1.1 100.100.100.100 fe80::1 10.0.0.2');
  assert.equal(run('nameserver 127.0.0.53'), '', 'заглушка systemd-resolved — не нужна');
});
