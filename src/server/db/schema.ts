import { type AnySQLiteColumn, sqliteTable, integer, text, real, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

const now = () => Date.now();

const timestamps = {
  createdAt: integer('created_at').notNull().$defaultFn(now),
  updatedAt: integer('updated_at').notNull().$defaultFn(now).$onUpdateFn(now),
};

const billing = {
  price: real('price'),
  currency: text('currency').notNull().default('RUB'),
  billingPeriod: text('billing_period', { enum: ['month', 'year'] }).notNull().default('month'),
};

// Состояние мониторинга, общее для серверов и сайтов
const monitorState = {
  monitorEnabled: integer('monitor_enabled', { mode: 'boolean' }).notNull().default(true),
  status: text('status', { enum: ['unknown', 'up', 'down'] }).notNull().default('unknown'),
  statusChangedAt: integer('status_changed_at'),
  lastCheckAt: integer('last_check_at'),
  lastLatencyMs: integer('last_latency_ms'),
  lastError: text('last_error'),
  failCount: integer('fail_count').notNull().default(0),
};

/**
 * Пользователь системы. `role` — системная роль: `admin` управляет пользователями и системой,
 * но НЕ видит чужие пространства. Доступ к данным — только через членство в пространстве.
 * Вошедшие через модуль (вход через внешний сервис) могут быть без email и пароля.
 */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  lastWorkspaceId: integer('last_workspace_id').references((): AnySQLiteColumn => workspaces.id, { onDelete: 'set null' }),
  totpSecretEnc: text('totp_secret_enc'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  /** Шаг TOTP последнего принятого кода: тот же код второй раз не принимается */
  totpLastStep: integer('totp_last_step'),
  /** Неверные коды подряд — после пяти вход кодом закрывается на 15 минут */
  totpFailures: integer('totp_failures').notNull().default(0),
  totpFailedAt: integer('totp_failed_at'),
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  lastLoginAt: integer('last_login_at'),
  // Личный Telegram для оповещений: привязывается через бота по одноразовой ссылке
  telegramUserId: integer('telegram_user_id'),
  telegramUsername: text('telegram_username'),
  telegramLinkTokenHash: text('telegram_link_token_hash'),
  telegramLinkExpiresAt: integer('telegram_link_expires_at'),
  telegramLinkedAt: integer('telegram_linked_at'),
  ...timestamps,
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(), // sha256 от токена из cookie
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  mfaPending: integer('mfa_pending', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull().$defaultFn(now),
  expiresAt: integer('expires_at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
});

/** Рабочее пространство: всё, что видят и правят его участники */
export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  ...timestamps,
});

/**
 * Модуль, выключенный администратором системы в пространстве. Нет строки — модуль включён.
 * Права участников на модуль при выключении сохраняются в workspace_members.modules
 */
export const workspaceModules = sqliteTable(
  'workspace_modules',
  {
    workspaceId: integer('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    updatedAt: integer('updated_at').notNull().$defaultFn(now).$onUpdateFn(now),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.moduleId] })],
);

/** Системные настройки, которые меняет администратор в интерфейсе: ключ → значение */
export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull().$defaultFn(now).$onUpdateFn(now),
});

export const accessLevels = {
  infra: ['none', 'view', 'edit'] as const, // edit — правка и просмотр паролей
};

/** Уровни доступа к модулям: id модуля → уровень (например {"demo":"manage"}); нет ключа — none */
export type ModuleLevels = Record<string, string>;
const moduleLevels = () => text('modules', { mode: 'json' }).$type<ModuleLevels>().notNull().default({});

/** Участник пространства. Владелец может всё; остальным права выдаются на инфраструктуру и по модулям */
export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    isOwner: integer('is_owner', { mode: 'boolean' }).notNull().default(false),
    infraAccess: text('infra_access', { enum: accessLevels.infra }).notNull().default('none'),
    // Сохранённые уровни: у выключенного или удалённого модуля остаются и вернутся вместе с ним
    modules: moduleLevels(),
    canManageMembers: integer('can_manage_members', { mode: 'boolean' }).notNull().default(false),
    invitedBy: integer('invited_by'),
    // Темы оповещений в Telegram (JSON-массив); null — по умолчанию все доступные по правам
    notifyTopics: text('notify_topics'),
    ...timestamps,
  },
  (t) => [uniqueIndex('workspace_members_uniq').on(t.workspaceId, t.userId), index('workspace_members_user_idx').on(t.userId)],
);

/** Ссылка-приглашение в пространство с заранее заданными правами */
export const workspaceInvites = sqliteTable('workspace_invites', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: integer('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  infraAccess: text('infra_access', { enum: accessLevels.infra }).notNull().default('none'),
  modules: moduleLevels(),
  canManageMembers: integer('can_manage_members', { mode: 'boolean' }).notNull().default(false),
  note: text('note'),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  usedBy: integer('used_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull().$defaultFn(now),
});

const workspaceRef = () => integer('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' });

/** Аккаунт у провайдера: регистратор, VPS-хостер, хостинг сайтов, DNS и т. п. */
export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  provider: text('provider'),
  url: text('url'),
  notes: text('notes'),
  ...timestamps,
});

export const servers = sqliteTable('servers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  description: text('description'),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  ip: text('ip'),
  hostname: text('hostname'),
  os: text('os'),
  location: text('location'),
  plan: text('plan'),
  ...billing,
  paidUntil: text('paid_until'),
  monitorPort: integer('monitor_port').notNull().default(22),
  notes: text('notes'),
  ...monitorState,
  ...timestamps,
});

/** Хостинг сайтов (shared/виртуальный хостинг) */
export const hostings = sqliteTable('hostings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  plan: text('plan'),
  ...billing,
  paidUntil: text('paid_until'),
  notes: text('notes'),
  ...timestamps,
});

export const domains = sqliteTable(
  'domains',
  {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  registrarAccountId: integer('registrar_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  dnsAccountId: integer('dns_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  expiresAt: text('expires_at'),
  expiresSource: text('expires_source', { enum: ['manual', 'rdap', 'whois'] }),
  autoRenew: integer('auto_renew', { mode: 'boolean' }).notNull().default(false),
  ...billing,
  autoLookup: integer('auto_lookup', { mode: 'boolean' }).notNull().default(true),
  lastLookupAt: integer('last_lookup_at'),
  lastLookupError: text('last_lookup_error'),
  notes: text('notes'),
  ...timestamps,
  },
  // Один и тот же домен могут вести разные пространства
  (t) => [uniqueIndex('domains_workspace_name_uniq').on(t.workspaceId, t.name)],
);

export const sites = sqliteTable('sites', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: workspaceRef(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  domainId: integer('domain_id').references(() => domains.id, { onDelete: 'set null' }),
  serverId: integer('server_id').references(() => servers.id, { onDelete: 'set null' }),
  hostingId: integer('hosting_id').references(() => hostings.id, { onDelete: 'set null' }),
  stack: text('stack'),
  path: text('path'),
  keyword: text('keyword'),
  notes: text('notes'),
  ...monitorState,
  lastHttpStatus: integer('last_http_status'),
  sslExpiresAt: integer('ssl_expires_at'),
  sslIssuer: text('ssl_issuer'),
  sslCheckedAt: integer('ssl_checked_at'),
  sslError: text('ssl_error'),
  ...timestamps,
});

/** Доступы (логины/пароли/ключи), прикрепляются к любой сущности */
export const credentials = sqliteTable(
  'credentials',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: workspaceRef(),
    entityType: text('entity_type', { enum: ['account', 'server', 'hosting', 'domain', 'site'] }).notNull(),
    entityId: integer('entity_id').notNull(),
    kind: text('kind').notNull(),
    title: text('title'),
    address: text('address'),
    port: integer('port'),
    username: text('username'),
    secretEnc: text('secret_enc'),
    passworkUrl: text('passwork_url'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [index('credentials_entity_idx').on(t.entityType, t.entityId)],
);

/** История проверок (для графиков и аптайма) */
export const checks = sqliteTable(
  'checks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entityType: text('entity_type', { enum: ['server', 'site'] }).notNull(),
    entityId: integer('entity_id').notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    latencyMs: integer('latency_ms'),
    message: text('message'),
    createdAt: integer('created_at').notNull().$defaultFn(now),
  },
  (t) => [index('checks_entity_idx').on(t.entityType, t.entityId, t.createdAt)],
);

/** События: падения, восстановления, напоминания */
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: workspaceRef(),
    entityType: text('entity_type').notNull(),
    entityId: integer('entity_id').notNull(),
    kind: text('kind').notNull(),
    message: text('message').notNull(),
    createdAt: integer('created_at').notNull().$defaultFn(now),
  },
  (t) => [index('events_created_idx').on(t.createdAt), index('events_workspace_idx').on(t.workspaceId, t.createdAt)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // null — системные события (входы, управление пользователями)
    workspaceId: integer('workspace_id'),
    userId: integer('user_id'),
    userEmail: text('user_email'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: integer('entity_id'),
    details: text('details'),
    ip: text('ip'),
    createdAt: integer('created_at').notNull().$defaultFn(now),
  },
  (t) => [index('audit_created_idx').on(t.createdAt)],
);

/** Ключи уже отправленных напоминаний, чтобы не слать повторно */
export const notificationsSent = sqliteTable('notifications_sent', {
  key: text('key').primaryKey(),
  createdAt: integer('created_at').notNull().$defaultFn(now),
});

// ══ Оповещения ═══════════════════════════════════════════════════════════
// Отправку делают боты на зарубежной VDS (из РФ API Telegram и Discord недоступны): они
// забирают очереди через /api/v1/bot/* и /api/v1/tg/*.

export const channelKinds = ['telegram_bot', 'discord_bot', 'discord_webhook'] as const;

/**
 * Канал оповещений пространства: свой Telegram-бот (токен + chat id), свой Discord-бот
 * (токен + id канала) или Discord-вебхук. Секрет (токен или адрес вебхука) — зашифрован.
 */
export const notifyChannels = sqliteTable('notify_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: workspaceRef(),
  kind: text('kind', { enum: channelKinds }).notNull(),
  name: text('name').notNull(),
  secretEnc: text('secret_enc').notNull(),
  // Куда слать: chat id Telegram (-100…, @channel) или id канала Discord; у вебхука — пусто
  target: text('target'),
  topics: text('topics').notNull(), // JSON-массив тем
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdBy: integer('created_by'),
  // Итог последней доставки — чтобы было видно, что канал работает
  lastSentAt: integer('last_sent_at'),
  lastError: text('last_error'),
  lastErrorAt: integer('last_error_at'),
  ...timestamps,
});

const queueStatus = { enum: ['pending', 'sent', 'failed'] as const };

export const tgQueue = sqliteTable(
  'tg_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channelId: integer('channel_id').references(() => notifyChannels.id, { onDelete: 'set null' }),
    // Личный Telegram (через бота панели) — id пользователя; свой бот — chat id группы/канала
    chatId: text('chat_id').notNull(),
    // Снимок токена своего бота; пусто — бот панели
    botTokenEnc: text('bot_token_enc'),
    text: text('text').notNull(),
    kind: text('kind').notNull().default('alert'),
    status: text('status', queueStatus).notNull().default('pending'),
    createdAt: integer('created_at').notNull().$defaultFn(now),
    sentAt: integer('sent_at'),
    error: text('error'),
  },
  (t) => [index('tg_queue_status_idx').on(t.status, t.createdAt)],
);

export const discordQueue = sqliteTable(
  'discord_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channelId: integer('channel_id').references(() => notifyChannels.id, { onDelete: 'set null' }),
    // Снимки: бот «тупой» и шлёт туда, куда сказано — вебхуком или своим ботом в канал
    webhookUrlEnc: text('webhook_url_enc'),
    botTokenEnc: text('bot_token_enc'),
    target: text('target'),
    embed: text('embed').notNull(),
    kind: text('kind').notNull().default('alert'),
    status: text('status', queueStatus).notNull().default('pending'),
    createdAt: integer('created_at').notNull().$defaultFn(now),
    sentAt: integer('sent_at'),
    error: text('error'),
  },
  (t) => [index('discord_queue_status_idx').on(t.status, t.createdAt)],
);
