import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { and, eq, notInArray } from 'drizzle-orm';
import type { ModuleLevels } from './db/schema.js';
import { db, schema } from './db/index.js';
import { getSetting, setSetting } from './system.js';

/**
 * Модули — то, что подключается к ядру поверх учёта. Ядро их не импортирует:
 * список приходит при запуске (`installModules` из `buildApp`), а модуль обращается к ядру
 * только через `core.ts`. Без модулей ядро работает как обычно.
 */

type Logger = Pick<FastifyBaseLogger, 'error' | 'info' | 'warn'>;

/** Тема оповещений модуля. Ключ — с префиксом id модуля: `demo.alert` */
export interface ModuleTopic {
  key: string;
  label: string;
  emoji?: string;
  /** Предлагать по умолчанию в новом канале пространства */
  channelDefault?: boolean;
}

export interface ServerModule {
  /** Латиница; это же пространство имён путей (`/api/<id>/`) и тем (`<id>.*`) */
  id: string;
  title: string;
  description: string;
  /** Уровни доступа по возрастанию, первый — 'none' */
  levels: readonly string[];
  /** С какого уровня участник настраивает каналы оповещений; по умолчанию — верхний */
  manageLevel?: string;
  /** Модуль может работать на этом сервере — например, заданы ключи; иначе он выключен для всех */
  available?: () => boolean;
  unavailableReason?: string;
  topics?: ModuleTopic[];
  /** Типы объектов модуля в журнале событий пространства: видны только с доступом к модулю */
  eventTypes?: string[];
  /** Маршруты без входа — точные шаблоны, только под /api/<id>/ */
  publicPaths?: string[];
  /** Маршруты уровня пользователя, без пространства — префиксы, только под /api/<id>/ */
  userPaths?: string[];
  /** Источники картинок для CSP */
  imgSrc?: string[];
  routes: (app: FastifyInstance) => void;
  /** Фоновая работа: запускается вместе с сервером */
  start?: (log: Logger) => void;
  stop?: () => void;
  /** Уборка старого — раз в час из планировщика ядра */
  cleanup?: (now: number) => void;
  /** Кнопка входа на странице входа; к адресу добавляется ?invite=<токен> */
  loginProvider?: { label: string; url: string };
  admin?: {
    /** Счётчик по пространствам для раздела «Модули», например число подключённых объектов модуля */
    counter?: { label: string; count: () => Map<number, number> };
    /** Что сломается при выключении для всего сайта; null — ничего */
    offWarning?: () => string | null;
  };
}

const ID_RE = /^[a-z][a-z0-9]*$/;
// Имена, занятые ядром: пути /api/<id>/ и темы <id>.* не должны с ними пересекаться
const RESERVED = new Set(['infra', 'api', 'auth', 'me', 'system', 'users', 'workspaces', 'workspace', 'members', 'invites', 'v1']);

let installed: ServerModule[] = [];
let log: Logger = console;

/** Подключить модули. Ошибка в описании модуля — сразу при запуске, а не в работе */
export function installModules(list: ServerModule[]) {
  const ids = new Set<string>();
  for (const m of list) {
    const fail = (why: string) => {
      throw new Error(`Модуль ${m.id}: ${why}`);
    };
    if (!ID_RE.test(m.id) || RESERVED.has(m.id)) fail('недопустимый id');
    if (ids.has(m.id)) fail('подключён дважды');
    ids.add(m.id);
    if (m.levels[0] !== 'none' || m.levels.length < 2 || new Set(m.levels).size !== m.levels.length) fail('уровни должны начинаться с none');
    if (m.manageLevel && !m.levels.includes(m.manageLevel)) fail(`неизвестный уровень ${m.manageLevel}`);
    const prefix = `/api/${m.id}/`;
    for (const p of [...(m.publicPaths ?? []), ...(m.userPaths ?? [])]) if (!p.startsWith(prefix)) fail(`путь ${p} вне ${prefix}`);
    for (const t of m.topics ?? []) if (!t.key.startsWith(`${m.id}.`)) fail(`тема ${t.key} без префикса ${m.id}.`);
  }
  installed = [...list];
}

export const installedModules = () => installed;
export const setModulesLogger = (l: Logger) => (log = l);
export const getModule = (id: string) => installed.find((m) => m.id === id);

// ── Уровни доступа ───────────────────────────────────────────────────────

export const topLevel = (m: ServerModule) => m.levels[m.levels.length - 1];
/** Место уровня в списке; незнакомый уровень — как none */
export const levelRank = (m: ServerModule, level: string | undefined) => Math.max(0, m.levels.indexOf(level ?? 'none'));
/** Сохранённый уровень участника: незнакомое значение (модуль сменил уровни) — none */
export const storedLevel = (m: ServerModule, stored: ModuleLevels) => m.levels[levelRank(m, stored[m.id])];

// ── Включён ли модуль ────────────────────────────────────────────────────

const switchKey = (id: string) => `module.${id}.enabled`;

/** Флаг администратора «модуль для всего сайта» — без учёта available() */
export const moduleSwitchedOn = (id: string) => getSetting(switchKey(id)) !== 'false';
export const setModuleSwitch = (id: string, on: boolean) => setSetting(switchKey(id), String(on));

function available(m: ServerModule) {
  try {
    return m.available?.() ?? true;
  } catch (e) {
    log.error({ err: e }, `Модуль ${m.id}: ошибка available()`);
    return false;
  }
}

/** Модуль работает на сайте: подключён, может работать и не выключен администратором */
export function moduleOn(id: string) {
  const m = getModule(id);
  return !!m && available(m) && moduleSwitchedOn(id);
}

/** Модули, работающие на сайте */
export const activeModules = () => installed.filter((m) => available(m) && moduleSwitchedOn(m.id));

/** Выключенные в пространствах модули: workspace_id → id модулей. Одним запросом */
export function disabledModules() {
  const out = new Map<number, Set<string>>();
  const rows = db.select().from(schema.workspaceModules).where(eq(schema.workspaceModules.enabled, false)).all();
  for (const r of rows) out.set(r.workspaceId, (out.get(r.workspaceId) ?? new Set()).add(r.moduleId));
  return out;
}

/** Подзапрос: id пространств, где модуль не выключен (на сайте модуль проверяется отдельно) */
export const moduleWorkspaceIds = (id: string) =>
  db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(
      notInArray(
        schema.workspaces.id,
        db
          .select({ id: schema.workspaceModules.workspaceId })
          .from(schema.workspaceModules)
          .where(and(eq(schema.workspaceModules.moduleId, id), eq(schema.workspaceModules.enabled, false))),
      ),
    );

export function setWorkspaceModule(workspaceId: number, id: string, enabled: boolean) {
  db.insert(schema.workspaceModules)
    .values({ workspaceId, moduleId: id, enabled })
    .onConflictDoUpdate({ target: [schema.workspaceModules.workspaceId, schema.workspaceModules.moduleId], set: { enabled } })
    .run();
}

// ── Хуки ─────────────────────────────────────────────────────────────────

/** Хук модуля в работе: его ошибка пишется в лог и не роняет ядро */
export function safely<T>(m: ServerModule, what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    log.error({ err: e }, `Модуль ${m.id}: ошибка в ${what}`);
    return fallback;
  }
}

export function startModules(logger: Logger) {
  log = logger;
  for (const m of installed) if (m.start) safely(m, 'start', () => m.start!(logger), undefined);
}

export function stopModules() {
  for (const m of installed) if (m.stop) safely(m, 'stop', () => m.stop!(), undefined);
}

export function cleanupModules(now: number) {
  for (const m of installed) if (m.cleanup) safely(m, 'cleanup', () => m.cleanup!(now), undefined);
}
