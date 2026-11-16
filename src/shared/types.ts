// Только типы, общие для сервера и интерфейса: импорт схемы стирается, и серверный код в бандл
// фронтенда не попадает. Общие функции — в text.ts и password.ts
import type * as schema from '../server/db/schema';

export type Account = typeof schema.accounts.$inferSelect;
export type Server = typeof schema.servers.$inferSelect;
export type Hosting = typeof schema.hostings.$inferSelect;
export type Domain = typeof schema.domains.$inferSelect;
export type Site = typeof schema.sites.$inferSelect;
export type AuditEntry = typeof schema.auditLog.$inferSelect;
export type EventEntry = typeof schema.events.$inferSelect;

export type Credential = Omit<typeof schema.credentials.$inferSelect, 'secretEnc'> & { hasSecret: boolean };
export type CredentialKind = 'panel' | 'ssh' | 'sftp' | 'ftp' | 'admin' | 'db' | 'email' | 'api' | 'other';

export type SystemRole = 'admin' | 'user';
export type InfraAccess = 'none' | 'view' | 'edit';
/** Уровни доступа к модулям: id модуля → уровень, например {"demo":"manage"}; нет ключа — none */
export type ModuleLevels = Record<string, string>;

export interface SessionUser {
  id: number;
  email: string | null;
  name: string;
  role: SystemRole;
  totpEnabled: boolean;
  hasPassword: boolean;
  telegramLinked: boolean;
  telegramUsername: string | null;
}

/** Права пользователя в пространстве — действующие. Владелец может всё */
export interface WorkspaceAccess {
  id: number;
  name: string;
  isOwner: boolean;
  infra: InfraAccess;
  manageMembers: boolean;
  /** Модули, работающие в пространстве, с уровнем участника. Выключенного модуля здесь нет */
  modules: ModuleLevels;
}

/** Раздел «Модули» у администратора системы: модули на сайте и в пространствах */
export interface SystemModules {
  modules: {
    id: string;
    title: string;
    description: string;
    /** Может работать на этом сервере (например, заданы ключи); иначе — почему нет */
    available: boolean;
    unavailableReason: string | null;
    /** Флаг администратора для всего сайта */
    enabled: boolean;
    /** Что сломается при выключении для сайта */
    offWarning: string | null;
    /** Подпись счётчика по пространствам, например «Корпорации» */
    counterLabel: string | null;
  }[];
  workspaces: {
    id: number;
    name: string;
    owner: string | null;
    members: number;
    modules: Record<string, { enabled: boolean; count: number | null }>;
  }[];
}

/** Кнопка входа через модуль на странице входа */
export interface AuthProvider {
  id: string;
  label: string;
  url: string;
}

export interface MeResponse {
  user: SessionUser;
  workspaces: WorkspaceAccess[];
  current: WorkspaceAccess | null;
}

export interface UserRow {
  id: number;
  email: string | null;
  name: string;
  role: SystemRole;
  totpEnabled: boolean;
  disabled: boolean;
  lastLoginAt: number | null;
  createdAt: number;
}

export interface MemberRow {
  id: number;
  userId: number;
  name: string;
  email: string | null;
  isOwner: boolean;
  infraAccess: InfraAccess;
  /** Сохранённые уровни по модулям */
  modules: ModuleLevels;
  canManageMembers: boolean;
  totpEnabled: boolean;
  lastLoginAt: number | null;
  createdAt: number;
}

export interface InviteRow {
  id: number;
  infraAccess: InfraAccess;
  modules: ModuleLevels;
  canManageMembers: boolean;
  note: string | null;
  expiresAt: number;
  createdAt: number;
}

export type ChannelKind = 'telegram_bot' | 'discord_bot' | 'discord_webhook';

export interface NotifyChannel {
  id: number;
  kind: ChannelKind;
  name: string;
  target: string | null;
  where: string;
  topics: string[];
  enabled: boolean;
  lastSentAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface NotificationsSettings {
  /** module — 'infra' или id модуля; group — заголовок группы тем */
  topics: { key: string; label: string; group: string; module: string; channelDefault: boolean }[];
  myTopics: string[];
  telegram: { botConfigured: boolean; linked: boolean; username: string | null };
  bridge: { telegram: boolean; discord: boolean };
  canManageChannels: boolean;
  channels: NotifyChannel[];
  queue: { telegramPending: number; discordPending: number } | null;
}

export type EntityPath = 'accounts' | 'servers' | 'hostings' | 'domains' | 'sites';
export type EntityType = 'account' | 'server' | 'hosting' | 'domain' | 'site';
export type AnyEntity = Account | Server | Hosting | Domain | Site;

export interface Deadline {
  kind: 'domain' | 'ssl' | 'server_payment' | 'hosting_payment';
  entityType: 'domain' | 'site' | 'server' | 'hosting';
  entityId: number;
  name: string;
  date: string; // YYYY-MM-DD
  daysLeft: number;
  path: string;
  autoRenew?: boolean;
}

export interface Dashboard {
  down: { type: 'server' | 'site'; id: number; name: string; target: string | null; since: number | null; error: string | null }[];
  deadlines: Deadline[];
  costs: Record<string, number>;
  counts: {
    servers: { total: number; monitored: number; up: number; down: number };
    sites: { total: number; monitored: number; up: number; down: number };
    domains: number;
    hostings: number;
    accounts: number;
  };
  events: EventEntry[];
}

export interface MonitorData {
  checks: { ok: boolean; latencyMs: number | null; message: string | null; createdAt: number }[];
  events: EventEntry[];
  uptime: { day: number | null; week: number | null; month: number | null };
}

export interface Settings {
  monitorEnabled: boolean;
  checkIntervalSec: number;
  failThreshold: number;
  publicUrl: string;
}
