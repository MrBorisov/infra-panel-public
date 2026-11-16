import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit.js';
import { hasModuleLevel, updateUser, wsId } from '../auth.js';
import { config } from '../config.js';
import { decrypt, encrypt, randomToken, sha256 } from '../crypto.js';
import { db, schema } from '../db/index.js';
import { HttpError } from '../errors.js';
import { installedModules } from '../modules.js';
import { enqueueChannelTest, enqueueTelegramTest, hiddenTopics, parseTopics, topicDef, topicsForAccess, type NotifyTopic } from '../notify.js';
import { countRows, getInWorkspace } from '../queries.js';
import { enqueueTelegramSummary } from '../summary.js';
import { idParam, reqStr } from '../validation.js';

const PENDING_LIMIT = 50;

// ══ Мост для ботов (пути с завершающим слэшем) ══════════
// Расширение контракта: у сообщений своих ботов есть bot_token (и channel_id у Discord) —
// бот на VDS шлёт от имени этого бота. Нужны боты из bots/ этого репозитория.

function presented(req: FastifyRequest) {
  const header = req.headers['x-bot-token'];
  if (typeof header === 'string' && header) return header;
  const auth = req.headers.authorization;
  return auth?.startsWith('Bearer ') ? auth.slice(7) : '';
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Проверка секрета бота ДО разбора тела. Пустой секрет в настройках — мост выключен */
function botAuth(kind: 'discord' | 'telegram') {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const expected = kind === 'discord' ? config.bots.discordToken : config.bots.telegramToken;
    // Токен в query попадает в логи и историю — не принимаем
    const query = req.query as Record<string, unknown>;
    if (!expected || 'token' in query || 'bot_token' in query || !safeEqual(presented(req), expected)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    // req.ip — настоящий адрес клиента: nginx перезаписывает X-Forwarded-For, Fastify верит только локальному прокси
    const allowed = config.bots.allowedIps;
    if (allowed.length && !allowed.includes(req.ip.replace(/^::ffff:/, ''))) {
      req.log.warn({ ip: req.ip }, 'Мост: запрос с адреса не из BOT_ALLOWED_IPS');
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}

const markSentBody = z.object({
  ids: z.array(z.number().int().positive()).max(500).default([]),
  failed: z.record(z.string().regex(/^\d+$/), z.string()).default({}),
});

/** Отметить доставку; заодно обновить статус каналов — чтобы в настройках было видно, работает ли канал */
function markSent(table: typeof schema.tgQueue | typeof schema.discordQueue, body: unknown) {
  const parsed = markSentBody.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'bad params');
  const { ids, failed } = parsed.data;
  const now = Date.now();
  const failedIds = Object.keys(failed).map(Number);
  const touched = [...ids, ...failedIds];
  const channelOf = new Map(
    touched.length
      ? db
          .select({ id: table.id, channelId: table.channelId })
          .from(table)
          .where(inArray(table.id, touched))
          .all()
          .map((r) => [r.id, r.channelId])
      : [],
  );

  let marked = 0;
  if (ids.length) {
    marked += db.update(table).set({ status: 'sent', sentAt: now, error: null }).where(inArray(table.id, ids)).run().changes;
    const channels = [...new Set(ids.map((id) => channelOf.get(id)).filter((c): c is number => !!c))];
    if (channels.length) {
      db.update(schema.notifyChannels).set({ lastSentAt: now, lastError: null }).where(inArray(schema.notifyChannels.id, channels)).run();
    }
  }
  for (const [rawId, err] of Object.entries(failed)) {
    const id = Number(rawId);
    const error = String(err).slice(0, 2000);
    marked += db.update(table).set({ status: 'failed', error }).where(eq(table.id, id)).run().changes;
    const channelId = channelOf.get(id);
    if (channelId) {
      db.update(schema.notifyChannels).set({ lastError: error.slice(0, 500), lastErrorAt: now }).where(eq(schema.notifyChannels.id, channelId)).run();
    }
  }
  return { marked };
}

/** chat id для Telegram: числа — числом (как ждёт бот), @канал — строкой */
const chatIdValue = (chatId: string) => (/^-?\d+$/.test(chatId) ? Number(chatId) : chatId);

function botBridgeRoutes(app: FastifyInstance) {
  const discord = { onRequest: botAuth('discord') };
  const telegram = { onRequest: botAuth('telegram') };

  app.get('/api/v1/bot/pending/', discord, async () =>
    db
      .select()
      .from(schema.discordQueue)
      .where(eq(schema.discordQueue.status, 'pending'))
      .orderBy(asc(schema.discordQueue.createdAt))
      .limit(PENDING_LIMIT)
      .all()
      .map((m) => ({
        id: m.id,
        embed_data: JSON.parse(m.embed),
        ...(m.webhookUrlEnc ? { webhook_url: decrypt(m.webhookUrlEnc) } : {}),
        ...(m.botTokenEnc ? { bot_token: decrypt(m.botTokenEnc), channel_id: m.target } : {}),
      })),
  );

  app.post('/api/v1/bot/mark-sent/', discord, async (req) => markSent(schema.discordQueue, req.body));

  app.get('/api/v1/tg/pending/', telegram, async () =>
    db
      .select()
      .from(schema.tgQueue)
      .where(eq(schema.tgQueue.status, 'pending'))
      .orderBy(asc(schema.tgQueue.createdAt))
      .limit(PENDING_LIMIT)
      .all()
      .map((m) => ({
        id: m.id,
        tg_user_id: chatIdValue(m.chatId),
        text: m.text,
        ...(m.botTokenEnc ? { bot_token: decrypt(m.botTokenEnc) } : {}),
      })),
  );

  app.post('/api/v1/tg/mark-sent/', telegram, async (req) => markSent(schema.tgQueue, req.body));

  // Бот панели получил /start <token> — привязываем Telegram к пользователю
  app.post('/api/v1/tg/link/', telegram, async (req, reply) => {
    const parsed = z
      .object({ link_token: z.string().min(10).max(200), tg_user_id: z.number().int().positive(), tg_username: z.string().max(100).nullish() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, reason: 'bad_params' });
    const { link_token, tg_user_id, tg_username } = parsed.data;
    const user = db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.telegramLinkTokenHash, sha256(link_token)), gt(schema.users.telegramLinkExpiresAt, Date.now())))
      .get();
    if (!user) return { ok: false, reason: 'expired' };
    updateUser(user.id, {
      telegramUserId: tg_user_id,
      telegramUsername: tg_username ?? null,
      telegramLinkedAt: Date.now(),
      telegramLinkTokenHash: null,
      telegramLinkExpiresAt: null,
    });
    enqueueTelegramTest(tg_user_id);
    // Что горит прямо сейчас: прошлые оповещения при привязке не досылаются
    enqueueTelegramSummary(user.id, tg_user_id);
    return { ok: true };
  });
}

// ══ Личный Telegram ═══════════════════════════════════════════════════════

function telegramRoutes(app: FastifyInstance) {
  app.post('/api/me/telegram/link', async (req) => {
    if (!config.bots.telegramBotUsername || !config.bots.telegramToken) {
      throw new HttpError(400, 'Telegram-бот панели не настроен: задайте TELEGRAM_BOT_USERNAME и TG_BOT_API_TOKEN');
    }
    const token = randomToken(24);
    const expiresAt = Date.now() + config.bots.telegramLinkTtlMin * 60_000;
    updateUser(req.user!.id, { telegramLinkTokenHash: sha256(token), telegramLinkExpiresAt: expiresAt });
    return { deepLink: `https://t.me/${config.bots.telegramBotUsername}?start=${token}`, expiresAt };
  });

  app.post('/api/me/telegram/unlink', async (req) => {
    updateUser(req.user!.id, { telegramUserId: null, telegramUsername: null, telegramLinkedAt: null });
    audit(req, 'user.telegram_unlinked', { system: true });
    return { ok: true };
  });

  app.post('/api/me/telegram/test', { config: testLimit }, async (req) => {
    const u = db.select({ tg: schema.users.telegramUserId }).from(schema.users).where(eq(schema.users.id, req.user!.id)).get();
    if (!u?.tg) throw new HttpError(400, 'Telegram не привязан');
    enqueueTelegramTest(u.tg);
    return { ok: true };
  });
}

// ══ Каналы пространства: свои боты и вебхуки ══════════════════════════════

/** Настраивать каналы пространства может тот, у кого есть право правки инфраструктуры или управления модулем */
function canManageChannels(req: FastifyRequest) {
  const ws = req.ws!;
  return ws.isOwner || ws.infra === 'edit' || installedModules().some((m) => hasModuleLevel(ws, m.id, m.manageLevel ?? m.levels[m.levels.length - 1]));
}

const allowedTopics = (req: FastifyRequest): NotifyTopic[] => topicsForAccess(req.ws!);

/**
 * Канал видит и меняет тот, чьи права покрывают все его темы. Иначе участник с правами только
 * на модуль перенаправил бы канал с тревогами по серверам в свой чат. Темы сравниваются как есть:
 * тему выключенного или удалённого модуля не покрывают ничьи права, кроме владельца
 */
function canTouchChannel(req: FastifyRequest, ch: typeof schema.notifyChannels.$inferSelect) {
  const allowed = allowedTopics(req);
  return req.ws!.isOwner || (parseTopics(ch.topics) ?? []).every((t) => allowed.includes(t));
}

const MAX_CHANNELS = 20;

// Тестовые кнопки шлют через общих ботов: без лимита ими забивали бы очередь всем пространствам
const testLimit = { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `test:${req.user?.id ?? req.ip}` } };

const DISCORD_WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const TELEGRAM_TOKEN_RE = /^\d{5,}:[\w-]{30,}$/;
const TELEGRAM_CHAT_RE = /^(-?\d{5,}|@[A-Za-z][A-Za-z0-9_]{4,})$/;
const DISCORD_TOKEN_RE = /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/;
const DISCORD_CHANNEL_RE = /^\d{17,20}$/;

/** Формат секрета и адреса для каждого вида канала — ошибки по-человечески */
const CHANNEL_RULES = {
  telegram_bot: {
    secret: [TELEGRAM_TOKEN_RE, 'Токен Telegram-бота выглядит как 123456789:AAE… (выдаёт @BotFather)'],
    target: [TELEGRAM_CHAT_RE, 'Chat ID — число (у групп и каналов -100…) или @имя публичного канала'],
  },
  discord_bot: {
    secret: [DISCORD_TOKEN_RE, 'Токен Discord-бота: Developer Portal → Bot → Reset Token'],
    target: [DISCORD_CHANNEL_RE, 'ID канала Discord — число из 17–20 цифр (ПКМ по каналу → Копировать ID)'],
  },
  discord_webhook: {
    secret: [DISCORD_WEBHOOK_RE, 'Нужна ссылка вебхука Discord: https://discord.com/api/webhooks/…'],
    target: null,
  },
} as const satisfies Record<(typeof schema.channelKinds)[number], { secret: readonly [RegExp, string]; target: readonly [RegExp, string] | null }>;

function checkSecret(kind: keyof typeof CHANNEL_RULES, secret: string) {
  const [re, msg] = CHANNEL_RULES[kind].secret;
  if (!re.test(secret)) throw new HttpError(400, msg);
}

function checkTarget(kind: keyof typeof CHANNEL_RULES, target: string | null | undefined) {
  const rule = CHANNEL_RULES[kind].target;
  if (!rule) return null;
  if (!target || !rule[0].test(target)) throw new HttpError(400, rule[1]);
  return target;
}

function maskWebhook(url: string) {
  const m = url.match(/webhooks\/(\d+)\//);
  return m ? `…/webhooks/${m[1]}/•••` : '•••';
}

/** Что показать о канале, не раскрывая секрет */
function describeChannel(ch: typeof schema.notifyChannels.$inferSelect) {
  const secret = decrypt(ch.secretEnc);
  const where =
    ch.kind === 'discord_webhook'
      ? maskWebhook(secret)
      : ch.kind === 'telegram_bot'
        ? `бот ${secret.split(':')[0]} → чат ${ch.target}`
        : `канал ${ch.target}`;
  return {
    id: ch.id,
    kind: ch.kind,
    name: ch.name,
    target: ch.target,
    where,
    // Темы удалённых модулей не показываем, но при правке они сохраняются
    topics: (parseTopics(ch.topics) ?? []).filter((t) => topicDef(t)),
    enabled: ch.enabled,
    lastSentAt: ch.lastSentAt,
    lastError: ch.lastError,
    lastErrorAt: ch.lastErrorAt,
  };
}

function workspaceNotificationRoutes(app: FastifyInstance) {
  app.get('/api/notifications', async (req) => {
    const workspaceId = wsId(req);
    const me = db
      .select({ member: schema.workspaceMembers, user: schema.users })
      .from(schema.workspaceMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, req.user!.id)))
      .get()!;
    const allowed = allowedTopics(req);
    const manage = canManageChannels(req);
    const channels = manage
      ? db
          .select()
          .from(schema.notifyChannels)
          .where(eq(schema.notifyChannels.workspaceId, workspaceId))
          .orderBy(asc(schema.notifyChannels.name))
          .all()
          .filter((ch) => canTouchChannel(req, ch))
      : [];
    // Очередь — только своих каналов: общий счётчик выдавал активность чужих пространств
    const ids = channels.map((c) => c.id);
    const pending = (table: typeof schema.tgQueue | typeof schema.discordQueue) =>
      ids.length ? countRows(table, and(eq(table.status, 'pending'), inArray(table.channelId, ids))) : 0;
    // И свои личные сообщения через бота панели — по ним тоже видно, забирает ли бот очередь
    const personalPending = me.user.telegramUserId
      ? countRows(schema.tgQueue, and(eq(schema.tgQueue.status, 'pending'), eq(schema.tgQueue.chatId, String(me.user.telegramUserId)), isNull(schema.tgQueue.botTokenEnc)))
      : 0;
    return {
      topics: allowed.map((key) => {
        const { label, group, module, channelDefault } = topicDef(key)!;
        return { key, label, group, module, channelDefault };
      }),
      myTopics: (parseTopics(me.member.notifyTopics) ?? allowed).filter((t) => topicDef(t)),
      telegram: {
        botConfigured: !!(config.bots.telegramBotUsername && config.bots.telegramToken),
        linked: !!me.user.telegramUserId,
        username: me.user.telegramUsername,
      },
      // Через мост идут и свои боты: без секретов моста доставки не будет
      bridge: { telegram: !!config.bots.telegramToken, discord: !!config.bots.discordToken },
      canManageChannels: manage,
      channels: channels.map(describeChannel),
      // Сколько ждёт отправки: если растёт — бот на VDS не забирает очередь
      queue: manage ? { telegramPending: pending(schema.tgQueue) + personalPending, discordPending: pending(schema.discordQueue) } : null,
    };
  });

  app.put('/api/notifications/my-topics', async (req) => {
    const { topics } = z.object({ topics: z.array(z.string()) }).parse(req.body);
    const allowed = allowedTopics(req);
    const mine = and(eq(schema.workspaceMembers.workspaceId, wsId(req)), eq(schema.workspaceMembers.userId, req.user!.id));
    const chosen = topics.filter((t) => allowed.includes(t));
    // Темы модулей, которые здесь сейчас не работают, сохраняются: вернутся вместе с модулем
    const saved = db.select({ topics: schema.workspaceMembers.notifyTopics }).from(schema.workspaceMembers).where(mine).get()!;
    chosen.push(...hiddenTopics(parseTopics(saved.topics), req.ws!));
    db.update(schema.workspaceMembers).set({ notifyTopics: JSON.stringify(chosen) }).where(mine).run();
    return { topics: chosen };
  });

  const requireChannels = async (req: FastifyRequest) => {
    if (!req.ws || !canManageChannels(req)) throw new HttpError(403, 'Нет прав настраивать оповещения пространства');
  };
  const cleanTopics = (req: FastifyRequest, topics: string[]) => topics.filter((t) => allowedTopics(req).includes(t));
  /** Канал пространства, который этому участнику можно трогать */
  const touchableChannel = (req: FastifyRequest, id: number) => {
    const ch = getInWorkspace(schema.notifyChannels, wsId(req), id, 'Канал');
    if (!canTouchChannel(req, ch)) throw new HttpError(403, 'У канала есть темы, на которые у вас нет прав, — его настраивает владелец');
    return ch;
  };

  const channelBody = z.object({
    kind: z.enum(schema.channelKinds),
    name: reqStr(100),
    secret: reqStr(500),
    target: z.string().trim().max(100).nullish(),
    topics: z.array(z.string()).min(1, 'Выберите хотя бы одну тему'),
    enabled: z.boolean().default(true),
  });

  app.post('/api/channels', { preHandler: requireChannels }, async (req) => {
    const body = channelBody.parse(req.body);
    const count = countRows(schema.notifyChannels, eq(schema.notifyChannels.workspaceId, wsId(req)));
    if (count >= MAX_CHANNELS) throw new HttpError(400, `Каналов в пространстве может быть не больше ${MAX_CHANNELS}`);
    checkSecret(body.kind, body.secret);
    const target = checkTarget(body.kind, body.target);
    const topics = cleanTopics(req, body.topics);
    if (!topics.length) throw new HttpError(400, 'Нет тем, доступных по вашим правам');
    const ch = db
      .insert(schema.notifyChannels)
      .values({
        workspaceId: wsId(req),
        kind: body.kind,
        name: body.name,
        secretEnc: encrypt(body.secret),
        target,
        topics: JSON.stringify(topics),
        enabled: body.enabled,
        createdBy: req.user!.id,
      })
      .returning({ id: schema.notifyChannels.id })
      .get();
    audit(req, 'channel.create', { entityType: 'channel', entityId: ch.id, details: `${body.kind}: ${body.name}` });
    return { id: ch.id };
  });

  app.patch('/api/channels/:id', { preHandler: requireChannels }, async (req) => {
    const { id } = idParam.parse(req.params);
    const ch = touchableChannel(req, id);
    const body = channelBody.omit({ kind: true }).partial().parse(req.body);
    const patch: Partial<typeof schema.notifyChannels.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.secret) {
      checkSecret(ch.kind, body.secret);
      patch.secretEnc = encrypt(body.secret);
    }
    if (body.target !== undefined) patch.target = checkTarget(ch.kind, body.target);
    if (body.topics) {
      const hidden = hiddenTopics(parseTopics(ch.topics) ?? [], req.ws!);
      patch.topics = JSON.stringify([...cleanTopics(req, body.topics), ...hidden]);
    }
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    // Новые настройки — старый итог доставки уже ни о чём не говорит
    if (body.secret || body.target !== undefined) Object.assign(patch, { lastError: null, lastErrorAt: null });
    db.update(schema.notifyChannels).set(patch).where(eq(schema.notifyChannels.id, ch.id)).run();
    audit(req, 'channel.update', { entityType: 'channel', entityId: id, details: `${ch.name}${body.secret ? ' (токен изменён)' : ''}` });
    return { ok: true };
  });

  app.delete('/api/channels/:id', { preHandler: requireChannels }, async (req) => {
    const { id } = idParam.parse(req.params);
    const ch = touchableChannel(req, id);
    // Сначала очередь: удаление канала обнулит channel_id (ON DELETE SET NULL), и неотправленное
    // со снимком токена потом уже не найти — оно ушло бы от имени удалённого канала
    db.transaction((tx) => {
      tx.delete(schema.tgQueue).where(and(eq(schema.tgQueue.status, 'pending'), eq(schema.tgQueue.channelId, ch.id))).run();
      tx.delete(schema.discordQueue).where(and(eq(schema.discordQueue.status, 'pending'), eq(schema.discordQueue.channelId, ch.id))).run();
      tx.delete(schema.notifyChannels).where(eq(schema.notifyChannels.id, ch.id)).run();
    });
    audit(req, 'channel.delete', { entityType: 'channel', entityId: id, details: ch.name });
    return { ok: true };
  });

  app.post('/api/channels/:id/test', { preHandler: requireChannels, config: testLimit }, async (req) => {
    const { id } = idParam.parse(req.params);
    const ch = touchableChannel(req, id);
    enqueueChannelTest(ch, req.ws!.name);
    return { ok: true };
  });

  // Последние ошибки доставки по каналам пространства — чтобы понять, почему не приходит
  app.get('/api/notifications/failures', { preHandler: requireChannels }, async (req) => {
    const ids = db
      .select()
      .from(schema.notifyChannels)
      .where(eq(schema.notifyChannels.workspaceId, wsId(req)))
      .all()
      .filter((c) => canTouchChannel(req, c))
      .map((c) => c.id);
    if (!ids.length) return [];
    const pick = (table: typeof schema.tgQueue | typeof schema.discordQueue) =>
      db
        .select({ id: table.id, channelId: table.channelId, error: table.error, createdAt: table.createdAt })
        .from(table)
        .where(and(eq(table.status, 'failed'), inArray(table.channelId, ids)))
        .orderBy(desc(table.id))
        .limit(20)
        .all();
    return [...pick(schema.tgQueue), ...pick(schema.discordQueue)].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
  });
}

export function notificationRoutes(app: FastifyInstance) {
  botBridgeRoutes(app);
  telegramRoutes(app);
  workspaceNotificationRoutes(app);
}
