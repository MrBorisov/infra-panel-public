import assert from 'node:assert/strict';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { bridge, db, join, makeUser, schema } from './helpers.js';

const { checkSsl, lookupDomain, runReminders } = await import('../src/server/monitor/index.js');

const DAY = 86_400_000;
/** Полдень по времени сервера: граница суток в напоминаниях — тоже по нему */
const localNoon = (base: number, plusDays = 0) => {
  const d = new Date(base + plusDays * DAY);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
};

const alice = await makeUser('Alice');

function addSite(name: string, sslExpiresAt: number) {
  return db
    .insert(schema.sites)
    .values({ workspaceId: alice.workspaceId, name, url: `https://${name}.test`, monitorEnabled: true, sslExpiresAt })
    .returning()
    .get();
}
const reminders = (siteId: number) =>
  db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.entityType, 'site'), eq(schema.events.entityId, siteId), eq(schema.events.kind, 'reminder_ssl')))
    .all();

test('истёкший SSL напоминается каждый день, а не один раз', async () => {
  const expired = Date.UTC(2026, 9, 5, 12);
  const site = addSite('expired-daily', expired);
  const day3 = localNoon(expired, 3);

  runReminders(day3);
  assert.equal(reminders(site.id).length, 1);
  assert.match(reminders(site.id)[0].message, /истёк 2026-10-05, 3 дня назад/);
  runReminders(day3 + 3_600_000);
  assert.equal(reminders(site.id).length, 1, 'в тот же день — не повторяем');

  const nextMorning = new Date(day3 + DAY);
  nextMorning.setHours(7);
  runReminders(nextMorning.getTime());
  assert.equal(reminders(site.id).length, 1, 'ночью и рано утром повтор не шлём');
  runReminders(localNoon(expired, 4));
  assert.equal(reminders(site.id).length, 2);
});

test('просроченное: неделю каждый день, потом раз в неделю, после месяца — тишина', async () => {
  const expired = Date.UTC(2026, 7, 1, 12);
  const site = addSite('expired-long', expired);
  const sentOn: number[] = [];
  for (let n = 1; n <= 40; n++) {
    const before = reminders(site.id).length;
    runReminders(localNoon(expired, n));
    if (reminders(site.id).length > before) sentOn.push(n);
  }
  assert.deepEqual(sentOn, [1, 2, 3, 4, 5, 6, 7, 8, 15, 22, 29]);
});

test('до срока — прежние пороги, по одному разу', async () => {
  const expires = Date.UTC(2026, 11, 20, 12);
  const site = addSite('soon', expires);
  for (let n = 10; n >= 0; n--) runReminders(localNoon(expires, -n));
  assert.deepEqual(
    reminders(site.id).map((e) => e.message.replace(/^.*» /, '')),
    ['истекает через 7 дней (2026-12-20)', 'истекает через 3 дня (2026-12-20)', 'истекает через 1 день (2026-12-20)', 'истекает сегодня (2026-12-20)'],
  );
});

// ── Сводка при привязке Telegram ──

let tgId = 7_000_000;
/** Привязать Telegram, как это делает бот панели; вернуть сообщения, поставленные этому чату */
async function linkTelegram(user: Awaited<ReturnType<typeof makeUser>>) {
  const { deepLink } = (await user.req('POST', '/api/me/telegram/link')).body;
  const tg = ++tgId;
  const res = await bridge('tg', 'link', { link_token: new URL(deepLink).searchParams.get('start'), tg_user_id: tg });
  assert.equal(JSON.parse(res.body).ok, true);
  return db.select().from(schema.tgQueue).where(eq(schema.tgQueue.chatId, String(tg))).all();
}
const summaryOf = (queue: { kind: string; text: string }[]) => queue.find((q) => q.kind === 'summary')?.text;

test('при привязке Telegram приходит сводка того, что горит', async () => {
  db.insert(schema.servers)
    .values({ workspaceId: alice.workspaceId, name: 'alice-box', ip: '10.0.0.1', monitorEnabled: true, status: 'down', statusChangedAt: Date.now() - 2 * 3_600_000 })
    .run();
  addSite('alice-shop', Date.now() - 3 * DAY);
  addSite('alice-fresh', Date.now() + 60 * DAY);
  addSite('alice-abandoned', Date.now() - 400 * DAY);

  const summary = summaryOf(await linkTelegram(alice));
  assert.ok(summary, 'сводка поставлена в очередь');
  assert.match(summary, /Сервер «alice-box» не работает уже 2 ч/);
  assert.match(summary, /SSL-сертификат сайта «alice-shop» истёк/);
  assert.doesNotMatch(summary, /alice-fresh/, 'далёкие сроки не шумят');
  assert.doesNotMatch(summary, /alice-abandoned/, 'просроченное больше месяца — тоже, как и в напоминаниях');
  assert.match(summary, /📁 WS Alice/);
});

test('сводка — только в пределах прав и выбранных тем', async () => {
  const bob = await makeUser('Bob');
  await join(alice, bob, { infraAccess: 'none', modules: { demo: 'view' } });
  db.insert(schema.servers).values({ workspaceId: bob.workspaceId, name: 'bob-box', ip: '10.0.0.2', monitorEnabled: true, status: 'down' }).run();
  const bobSummary = summaryOf(await linkTelegram(bob)) ?? '';
  assert.match(bobSummary, /bob-box/);
  assert.doesNotMatch(bobSummary, /alice/, 'без доступа к инфраструктуре чужое не видно');

  const carol = await makeUser('Carol');
  await join(alice, carol, { infraAccess: 'view' });
  db.update(schema.workspaceMembers)
    .set({ notifyTopics: JSON.stringify(['infra.status']) })
    .where(and(eq(schema.workspaceMembers.workspaceId, alice.workspaceId), eq(schema.workspaceMembers.userId, carol.userId)))
    .run();
  const carolSummary = summaryOf(await linkTelegram(carol)) ?? '';
  assert.match(carolSummary, /alice-box/);
  assert.doesNotMatch(carolSummary, /SSL/, 'тема сроков не выбрана');

  const dave = await makeUser('Dave');
  const daveQueue = await linkTelegram(dave);
  assert.equal(summaryOf(daveQueue), undefined, 'нечего сообщать — сводки нет');
  assert.equal(daveQueue.filter((q) => q.kind === 'test').length, 1);
});

test('ошибка проверки домена или SSL не стирает прежний срок', async () => {
  // Без сети: имя домена некорректно, адрес сайта внутренний
  const domain = db.insert(schema.domains).values({ workspaceId: alice.workspaceId, name: 'bad name', expiresAt: '2027-03-01' }).returning().get();
  await lookupDomain(domain);
  const d = db.select().from(schema.domains).where(eq(schema.domains.id, domain.id)).get()!;
  assert.deepEqual([d.expiresAt, !!d.lastLookupError, !!d.lastLookupAt], ['2027-03-01', true, true]);
  const site = db.insert(schema.sites).values({ workspaceId: alice.workspaceId, name: 'ssl', url: 'https://127.0.0.1:9/', sslExpiresAt: 1_900_000_000_000, sslIssuer: 'Old CA' }).returning().get();
  await checkSsl(site);
  const s = db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get()!;
  assert.deepEqual([s.sslExpiresAt, s.sslIssuer, !!s.sslError, !!s.sslCheckedAt], [1_900_000_000_000, 'Old CA', true, true]);
});
