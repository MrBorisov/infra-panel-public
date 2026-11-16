import type { FastifyBaseLogger } from 'fastify';
import { and, eq, isNotNull } from 'drizzle-orm';
import { plural } from '../shared/text.js';
import type { WorkspaceAccess } from '../shared/types.js';
import { config } from './config.js';
import { db, schema } from './db/index.js';
import { modulesIn, toAccess } from './auth.js';
import { installedModules, type ServerModule } from './modules.js';

let log: Pick<FastifyBaseLogger, 'error' | 'info' | 'warn'> = console;
export const setNotifyLogger = (l: typeof log) => (log = l);

// ── Темы ─────────────────────────────────────────────────────────────────

/** Тема оповещений: module — 'infra' (ядро) или id модуля, group — заголовок в настройках */
export interface TopicDef {
  key: string;
  module: string;
  group: string;
  label: string;
  emoji?: string;
  channelDefault: boolean;
}

/** Ключ темы — строка с префиксом модуля: 'infra.status', 'demo.alert'. Темы модулей — в их описании */
export type NotifyTopic = string;

const CORE_TOPICS: TopicDef[] = [
  { key: 'infra.status', module: 'infra', group: 'Инфраструктура', label: 'Серверы и сайты: падения и восстановления', channelDefault: false },
  { key: 'infra.deadline', module: 'infra', group: 'Инфраструктура', label: 'Сроки: домены, SSL, оплата', emoji: '⏰', channelDefault: false },
];

/** Все известные темы: ядра и подключённых модулей */
export function allTopics(): TopicDef[] {
  const fromModules = installedModules().flatMap((m) =>
    (m.topics ?? []).map((t) => ({ ...t, module: m.id, group: m.title, channelDefault: !!t.channelDefault })),
  );
  return [...CORE_TOPICS, ...fromModules];
}

export const topicDef = (key: string) => allTopics().find((t) => t.key === key);
/** Модуль темы по префиксу ключа — и у темы удалённого модуля, которой уже нет в списке */
const topicModule = (key: string) => topicDef(key)?.module ?? key.split('.')[0];

/** Темы, доступные по правам в пространстве: ядра — с правом на инфраструктуру, модулей — с уровнем не none */
export function topicsForAccess(ws: WorkspaceAccess): NotifyTopic[] {
  return allTopics()
    .filter((t) => (t.module === 'infra' ? ws.infra !== 'none' : (ws.modules[t.module] ?? 'none') !== 'none'))
    .map((t) => t.key);
}

/** Темы, на которые подписан участник: выбранные им (null — все), но не шире его прав и модулей пространства */
export function memberTopics(access: WorkspaceAccess, saved: string | null): NotifyTopic[] {
  const allowed = topicsForAccess(access);
  const chosen = parseTopics(saved) ?? allowed;
  return allowed.filter((t) => chosen.includes(t));
}

/**
 * Сохранённые темы модулей, которые в пространстве не работают (выключены или удалены из кода).
 * Их не видно, но при правке тем терять их нельзя: вернутся вместе с модулем. null — подписан на всё
 */
export function hiddenTopics(saved: NotifyTopic[] | null, ws: WorkspaceAccess): NotifyTopic[] {
  return (saved ?? allTopics().map((t) => t.key)).filter((t) => {
    const module = topicModule(t);
    return module !== 'infra' && !(module in ws.modules);
  });
}

/** Сохранённый список тем как есть, с темами удалённых модулей: их права проверяют потребители */
export function parseTopics(raw: string | null): NotifyTopic[] | null {
  if (!raw) return null;
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : null;
  } catch {
    return null;
  }
}

// ── Сообщение ────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'warning' | 'info' | 'ok';

export interface Notice {
  topic: NotifyTopic;
  severity: Severity;
  title: string;
  body?: string;
  /** Путь в панели, например /servers/3 — превратится в ссылку с ?ws= */
  path?: string;
}

const EMOJI: Record<Severity, string> = { critical: '🔴', warning: '⚠️', info: 'ℹ️', ok: '🟢' };
const COLOR: Record<Severity, number> = { critical: 0xe03131, warning: 0xf08c00, info: 0x4c6ef5, ok: 0x2f9e44 };

export function panelUrl(path: string | undefined, workspaceId: number) {
  if (!path || !config.publicUrl) return null;
  return `${config.publicUrl}${path}${path.includes('?') ? '&' : '?'}ws=${workspaceId}`;
}

function emojiFor(n: Notice) {
  return n.severity === 'ok' ? EMOJI.ok : (topicDef(n.topic)?.emoji ?? EMOJI[n.severity]);
}

/** Telegram — обычный текст без parse_mode, как шлют боты из bots/ */
function renderTelegram(n: Notice, workspaceName: string, url: string | null) {
  return [`${emojiFor(n)} ${n.title}`, n.body, url, `📁 ${workspaceName}`].filter(Boolean).join('\n');
}

/** Discord — embed, бот отправляет его вебхуком как {"embeds":[embed]} */
function renderDiscord(n: Notice, workspaceName: string, url: string | null) {
  return {
    title: `${emojiFor(n)} ${n.title}`.slice(0, 256),
    ...(n.body ? { description: n.body.slice(0, 4000) } : {}),
    ...(url ? { url } : {}),
    color: COLOR[n.severity],
    footer: { text: `${config.appName} · ${workspaceName}` },
    timestamp: new Date().toISOString(),
  };
}

// ── Рассылка ─────────────────────────────────────────────────────────────

/** Кому из участников пространства слать в Telegram: привязан TG, есть права на модуль, подписан на тему */
function telegramRecipients(ws: { id: number; name: string }, topic: NotifyTopic, modules: ServerModule[]) {
  const rows = db
    .select({ tgUserId: schema.users.telegramUserId, member: schema.workspaceMembers })
    .from(schema.workspaceMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(and(eq(schema.workspaceMembers.workspaceId, ws.id), isNotNull(schema.users.telegramUserId), eq(schema.users.disabled, false)))
    .all();
  const out = new Set<number>();
  for (const { tgUserId, member } of rows) {
    if (tgUserId && memberTopics(toAccess(ws, member, modules), member.notifyTopics).includes(topic)) out.add(tgUserId);
  }
  return [...out];
}

/** Ставит сообщение в очереди Telegram и Discord пространства */
export function dispatch(workspaceId: number, notice: Notice) {
  const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get();
  if (!ws) return;
  // Тема неизвестна или её модуль в пространстве не работает — тревога не уходит ни участникам, ни в каналы
  const def = topicDef(notice.topic);
  if (!def) return log.warn(`Оповещение с неизвестной темой ${notice.topic} пропущено`);
  const modules = modulesIn(workspaceId);
  if (def.module !== 'infra' && !modules.some((m) => m.id === def.module)) return;
  const url = panelUrl(notice.path, workspaceId);

  const text = renderTelegram(notice, ws.name, url);
  for (const tgUserId of telegramRecipients(ws, notice.topic, modules)) {
    db.insert(schema.tgQueue).values({ chatId: String(tgUserId), text }).run();
  }

  // Каналы пространства: свой Telegram-бот, свой Discord-бот, Discord-вебхук
  const embed = JSON.stringify(renderDiscord(notice, ws.name, url));
  const channels = db
    .select()
    .from(schema.notifyChannels)
    .where(and(eq(schema.notifyChannels.workspaceId, workspaceId), eq(schema.notifyChannels.enabled, true)))
    .all();
  for (const ch of channels) {
    if (!(parseTopics(ch.topics) ?? []).includes(notice.topic)) continue;
    enqueueForChannel(ch, { text, embed });
  }
}

type Channel = typeof schema.notifyChannels.$inferSelect;

/** Поставить сообщение в очередь канала: секреты — снимком, бот на VDS шлёт туда, куда сказано */
function enqueueForChannel(ch: Channel, msg: { text: string; embed: string }, kind = 'alert') {
  if (ch.kind === 'telegram_bot') {
    db.insert(schema.tgQueue).values({ channelId: ch.id, chatId: ch.target ?? '', botTokenEnc: ch.secretEnc, text: msg.text, kind }).run();
  } else if (ch.kind === 'discord_bot') {
    db.insert(schema.discordQueue).values({ channelId: ch.id, botTokenEnc: ch.secretEnc, target: ch.target, embed: msg.embed, kind }).run();
  } else {
    db.insert(schema.discordQueue).values({ channelId: ch.id, webhookUrlEnc: ch.secretEnc, embed: msg.embed, kind }).run();
  }
}

/** Пишет событие в журнал пространства и, если передано сообщение, рассылает его */
export function recordEvent(workspaceId: number, entityType: string, entityId: number, kind: string, message: string, notice?: Notice) {
  db.insert(schema.events).values({ workspaceId, entityType, entityId, kind, message }).run();
  if (!notice) return;
  try {
    dispatch(workspaceId, notice);
  } catch (e) {
    log.error({ err: e }, 'Не удалось поставить уведомление в очередь');
  }
}

/** Личное служебное сообщение (безопасность) — мимо тем и прав, только самому пользователю */
export function enqueueTelegramDirect(tgUserId: number, text: string) {
  db.insert(schema.tgQueue).values({ chatId: String(tgUserId), text, kind: 'security' }).run();
}

/** Тестовые сообщения из настроек */
export function enqueueTelegramTest(tgUserId: number) {
  db.insert(schema.tgQueue)
    .values({ chatId: String(tgUserId), text: `✅ ${config.appName}: Telegram привязан, оповещения будут приходить сюда.`, kind: 'test' })
    .run();
}

export function enqueueChannelTest(ch: Channel, workspaceName: string) {
  const notice: Notice = { topic: 'infra.status', severity: 'ok', title: `Тестовое сообщение`, body: `Канал «${ch.name}» работает.` };
  enqueueForChannel(ch, { text: renderTelegram(notice, workspaceName, null), embed: JSON.stringify(renderDiscord(notice, workspaceName, null)) }, 'test');
}

// ── Мелочи для текста ────────────────────────────────────────────────────

export function formatDuration(ms: number) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} ч ${min % 60} мин`;
  const d = Math.floor(h / 24);
  return `${d} ${plural(d, ['день', 'дня', 'дней'])} ${h % 24} ч`;
}
