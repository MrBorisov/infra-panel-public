import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { bridge, db, makeUser, schema } from './helpers.js';

const { dispatch } = await import('../src/server/notify.js');

const owner = await makeUser('Owner');
const other = await makeUser('Other');

const TG_TOKEN = '7012345678:AAEhBP0av28m9Bh9kRzZx3E0ZtZp8Xyzabc';
// Поддельный токен собран из частей: целиком сканер секретов GitHub принимает его за настоящий
const DC_TOKEN = ['MTEyMzQ1Njc4OTAxMjM0NTY3OA', 'GhIjKl', 'abcdefghijklmnopqrstuvwxyz012345'].join('.');

test('проверка формата токенов и адресов', async () => {
  const bad = [
    { kind: 'telegram_bot', name: 'tg', secret: 'не токен', target: '-1001234567890', topics: ['demo.alert'] },
    { kind: 'telegram_bot', name: 'tg', secret: TG_TOKEN, target: 'чат', topics: ['demo.alert'] },
    { kind: 'discord_bot', name: 'dc', secret: DC_TOKEN, target: '123', topics: ['demo.alert'] },
    { kind: 'discord_webhook', name: 'wh', secret: 'https://evil.example/hook', topics: ['demo.alert'] },
  ];
  for (const body of bad) assert.equal((await owner.req('POST', '/api/channels', body)).status, 400, JSON.stringify(body));
});

test('свои боты получают сообщения по своим темам', async () => {
  const tg = await owner.req('POST', '/api/channels', { kind: 'telegram_bot', name: 'Корпа TG', secret: TG_TOKEN, target: '-1001234567890', topics: ['demo.alert'] });
  const dc = await owner.req('POST', '/api/channels', { kind: 'discord_bot', name: 'Корпа DC', secret: DC_TOKEN, target: '112233445566778899', topics: ['demo.alert', 'demo.info'] });
  assert.equal(tg.status, 200);
  assert.equal(dc.status, 200);

  dispatch(owner.workspaceId, { topic: 'demo.alert', severity: 'critical', title: 'Атака на Jita - Home' });
  dispatch(owner.workspaceId, { topic: 'demo.info', severity: 'warning', title: 'Топливо' });

  const tgRows = db.select().from(schema.tgQueue).where(eq(schema.tgQueue.channelId, tg.body.id)).all();
  assert.equal(tgRows.length, 1);
  assert.equal(tgRows[0].chatId, '-1001234567890');
  const dcRows = db.select().from(schema.discordQueue).where(eq(schema.discordQueue.channelId, dc.body.id)).all();
  assert.equal(dcRows.length, 2);

  // Мост отдаёт боту на VDS токен своего бота и куда слать
  const tgPending = (await bridge('tg', 'pending')).json();
  const mine = tgPending.find((m: { id: number }) => m.id === tgRows[0].id);
  assert.equal(mine.bot_token, TG_TOKEN);
  assert.equal(mine.tg_user_id, -1001234567890);
  const dcPending = (await bridge('bot', 'pending')).json();
  const dcItem = dcPending.find((m: { id: number }) => m.id === dcRows[0].id);
  assert.equal(dcItem.bot_token, DC_TOKEN);
  assert.equal(dcItem.channel_id, '112233445566778899');
  assert.equal(dcItem.webhook_url, undefined);

  // Итог доставки виден у канала
  await bridge('tg', 'mark-sent', { ids: [], failed: { [String(tgRows[0].id)]: 'Bad Request: chat not found' } });
  await bridge('bot', 'mark-sent', { ids: [dcRows[0].id] });
  const list = (await owner.req('GET', '/api/notifications')).body.channels as { id: number; lastError: string | null; lastSentAt: number | null; where: string }[];
  const tgCh = list.find((c) => c.id === tg.body.id)!;
  const dcCh = list.find((c) => c.id === dc.body.id)!;
  assert.match(tgCh.lastError!, /chat not found/);
  assert.ok(dcCh.lastSentAt);
  // Секрет наружу не отдаётся
  assert.ok(!JSON.stringify(list).includes(TG_TOKEN) && !JSON.stringify(list).includes(DC_TOKEN));
  assert.match(tgCh.where, /^бот 7012345678 → чат -1001234567890$/);
});

test('каналы чужого пространства недоступны', async () => {
  const id = (await owner.req('GET', '/api/notifications')).body.channels[0].id;
  assert.equal((await other.req('PATCH', `/api/channels/${id}`, { name: 'x' })).status, 404);
  assert.equal((await other.req('DELETE', `/api/channels/${id}`)).status, 404);
  assert.equal((await other.req('POST', `/api/channels/${id}/test`, {})).status, 404);
});

test('удаление канала убирает неотправленное вместе с токеном', async () => {
  const ch = (await owner.req('GET', '/api/notifications')).body.channels[0];
  await owner.req('POST', `/api/channels/${ch.id}/test`, {});
  const pendingIds = [
    ...db.select().from(schema.tgQueue).where(eq(schema.tgQueue.channelId, ch.id)).all(),
    ...db.select().from(schema.discordQueue).where(eq(schema.discordQueue.channelId, ch.id)).all(),
  ]
    .filter((m) => m.status === 'pending')
    .map((m) => m.id);
  assert.ok(pendingIds.length > 0);
  await owner.req('DELETE', `/api/channels/${ch.id}`);
  // Ищем по id, а не по channel_id: его обнуляет внешний ключ
  const left = [...db.select().from(schema.tgQueue).all(), ...db.select().from(schema.discordQueue).all()].filter(
    (m) => pendingIds.includes(m.id) && m.status === 'pending' && m.botTokenEnc,
  );
  assert.equal(left.length, 0);
});

test('удаление пространства убирает неотправленное его каналов, а отправленное и чужое оставляет', async () => {
  const gone = await makeUser('Gone');
  const tg = await gone.req('POST', '/api/channels', { kind: 'telegram_bot', name: 'TG', secret: TG_TOKEN, target: '-1001234567890', topics: ['demo.alert'] });
  const dc = await gone.req('POST', '/api/channels', { kind: 'discord_bot', name: 'DC', secret: DC_TOKEN, target: '112233445566778899', topics: ['demo.alert'] });
  for (const ws of [gone.workspaceId, gone.workspaceId, owner.workspaceId]) dispatch(ws, { topic: 'demo.alert', severity: 'critical', title: 'Атака' });
  const [sent] = db.select().from(schema.tgQueue).where(eq(schema.tgQueue.channelId, tg.body.id)).all();
  db.update(schema.tgQueue).set({ status: 'sent' }).where(eq(schema.tgQueue.id, sent.id)).run();
  // Ключ — очередь и id: channel_id после удаления обнулит внешний ключ
  const queued = () => [...db.select().from(schema.tgQueue).all().map((m) => ({ ...m, key: `tg${m.id}` })), ...db.select().from(schema.discordQueue).all().map((m) => ({ ...m, key: `dc${m.id}` }))];
  const pending = queued().filter((m) => m.status === 'pending');
  const mine = pending.filter((m) => [tg.body.id, dc.body.id].includes(m.channelId));
  assert.deepEqual([mine.length, pending.length > mine.length], [3, true]);

  assert.equal((await gone.req('DELETE', '/api/workspace', { confirmName: 'WS Gone' })).status, 200);
  const left = new Set(queued().map((m) => m.key));
  assert.deepEqual(pending.filter((m) => !left.has(m.key)), mine, 'ушло неотправленное его каналов, и только оно');
  assert.ok(left.has(`tg${sent.id}`), 'отправленное осталось');
});
