import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, eq, lt, ne } from 'drizzle-orm';
import type { InfraAccess, SessionUser, WorkspaceAccess } from '../shared/types.js';
import { config } from './config.js';
import { randomToken, sha256 } from './crypto.js';
import { db, schema } from './db/index.js';
import { HttpError } from './errors.js';
import { activeModules, disabledModules, getModule, installedModules, levelRank, storedLevel, topLevel, type ServerModule } from './modules.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionId: string | null;
    ws: WorkspaceAccess | null;
    /** Пароль введён, код 2FA ещё нет */
    mfaPending: boolean;
  }
}

// В проде — с префиксом __Host-: такую cookie не поставить с соседнего поддомена (для браузера
// это тот же сайт) и не подменить ею сессию. Префикс требует Secure,
// поэтому в разработке по http — просто sid
const COOKIE = config.cookieSecure ? '__Host-sid' : 'sid';
const INFRA_LEVEL: Record<InfraAccess, number> = { none: 0, view: 1, edit: 2 };

// Публичное — только явно: пути ядра здесь, пути модулей — их publicPaths (точные, под /api/<id>/)
const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/providers',
  '/api/health',
  // По ссылке-приглашению: посмотреть и зарегистрироваться до входа
  '/api/invites/preview',
  '/api/invites/register',
]);
const isPublic = (path: string) => PUBLIC_PATHS.has(path) || installedModules().some((m) => m.publicPaths?.includes(path));
const MFA_PENDING_PATHS = new Set(['/api/auth/totp', '/api/auth/logout']);
// Запросы уровня пользователя, а не пространства; у модулей — их userPaths
const NO_WORKSPACE_PREFIXES = ['/api/me', '/api/auth/', '/api/workspaces', '/api/invites/', '/api/users', '/api/system/'];
const noWorkspacePath = (path: string) =>
  [...NO_WORKSPACE_PREFIXES, ...installedModules().flatMap((m) => m.userPaths ?? [])].some((p) => underPrefix(path, p));
// Префикс — целый сегмент: «/api/me» не должен совпадать с «/api/members»
const underPrefix = (path: string, p: string) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`);

/**
 * Путь для решений о доступе — шаблон найденного маршрута. Сырой req.url не годится: роутер
 * декодирует %-коды, и `/%61pi/...` попадал в обработчики `/api/...` в обход проверки входа.
 */
function accessPath(req: FastifyRequest) {
  const route = req.routeOptions.url;
  if (route) return route;
  // Маршрут не найден: решаем по декодированному пути, как его видит роутер
  const raw = req.url.split('?')[0];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function sameOrigin(origin: string, host: string | undefined) {
  try {
    return new URL(origin).host === host;
  } catch {
    return false; // «Origin: null» и мусор — чужие
  }
}

export function toSessionUser(u: typeof schema.users.$inferSelect): SessionUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    totpEnabled: u.totpEnabled,
    hasPassword: !!u.passwordHash,
    telegramLinked: !!u.telegramUserId,
    telegramUsername: u.telegramUsername,
  };
}

type MemberRow = typeof schema.workspaceMembers.$inferSelect;

/** Модули, работающие в пространстве: на сайте и не выключены в нём самом */
export function modulesIn(workspaceId: number, active = activeModules(), disabled = disabledModules()) {
  const off = disabled.get(workspaceId);
  return off ? active.filter((m) => !off.has(m.id)) : active;
}

/**
 * Действующие права в пространстве. В `modules` — только работающие в нём модули: выключенного
 * не видят меню, маршруты и рассылка. Сохранённые уровни остаются в workspace_members и вернутся с модулем
 */
export function toAccess(ws: { id: number; name: string }, m: MemberRow, modules: ServerModule[] = modulesIn(ws.id)): WorkspaceAccess {
  const levels = Object.fromEntries(modules.map((mod) => [mod.id, m.isOwner ? topLevel(mod) : storedLevel(mod, m.modules)]));
  const base = { id: ws.id, name: ws.name, isOwner: m.isOwner, modules: levels };
  if (m.isOwner) return { ...base, infra: 'edit', manageMembers: true };
  return { ...base, infra: m.infraAccess, manageMembers: m.canManageMembers };
}

/** Членства пользователя вместе с пространствами, по имени пространства */
export function userMemberships(userId: number) {
  return db
    .select({ ws: schema.workspaces, m: schema.workspaceMembers })
    .from(schema.workspaceMembers)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
    .where(eq(schema.workspaceMembers.userId, userId))
    .orderBy(asc(schema.workspaces.name))
    .all();
}

/** Все пространства пользователя с его правами в каждом */
export function userWorkspaces(userId: number): WorkspaceAccess[] {
  const active = activeModules();
  const disabled = disabledModules();
  return userMemberships(userId).map(({ ws, m }) => toAccess(ws, m, modulesIn(ws.id, active, disabled)));
}

function resolveWorkspace(req: FastifyRequest, lastWorkspaceId: number | null): WorkspaceAccess | null {
  const all = userWorkspaces(req.user!.id);
  if (!all.length) return null;
  const header = Number(req.headers['x-workspace']);
  if (header) return all.find((w) => w.id === header) ?? null; // чужое пространство — нет доступа
  return all.find((w) => w.id === lastWorkspaceId) ?? all[0];
}

export function createSession(reply: FastifyReply, req: FastifyRequest, userId: number, mfaPending: boolean) {
  const token = randomToken();
  const ttlMs = mfaPending ? 10 * 60_000 : config.sessionTtlHours * 3600_000;
  db.insert(schema.sessions)
    .values({
      id: sha256(token),
      userId,
      mfaPending,
      expiresAt: Date.now() + ttlMs,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
    })
    .run();
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: Math.floor(ttlMs / 1000),
  });
  // Полувход (пароль без кода 2FA) — ещё не вход
  if (!mfaPending) updateUser(userId, { lastLoginAt: Date.now() });
}

export function destroySession(req: FastifyRequest, reply: FastifyReply) {
  if (req.sessionId) db.delete(schema.sessions).where(eq(schema.sessions.id, req.sessionId)).run();
  reply.clearCookie(COOKIE, { path: '/' });
}

export function destroyUserSessions(userId: number, exceptSessionId?: string | null) {
  const own = eq(schema.sessions.userId, userId);
  db.delete(schema.sessions).where(exceptSessionId ? and(own, ne(schema.sessions.id, exceptSessionId)) : own).run();
}

export const updateUser = (id: number, set: Partial<typeof schema.users.$inferInsert>) =>
  db.update(schema.users).set(set).where(eq(schema.users.id, id)).run();

export function purgeExpiredSessions() {
  db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, Date.now())).run();
}

export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('ws', null);
  app.decorateRequest('mfaPending', false);

  app.addHook('onRequest', async (req, reply) => {
    const path = accessPath(req);
    if (!path.startsWith('/api/')) return;
    // Мост ботов (/api/v1/bot/*, /api/v1/tg/*) проверяет свой токен сам
    if (path.startsWith('/api/v1/')) return;

    // Защита от CSRF: изменяющие запросы принимаем только со своего origin
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !sameOrigin(origin, req.headers.host)) {
        return reply.code(403).send({ error: 'Запрос с чужого origin' });
      }
    }

    const token = req.cookies[COOKIE];
    let lastWorkspaceId: number | null = null;
    if (token) {
      const id = sha256(token);
      const row = db
        .select({ session: schema.sessions, user: schema.users })
        .from(schema.sessions)
        .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
        .where(eq(schema.sessions.id, id))
        .get();
      if (row && row.session.expiresAt > Date.now() && !row.user.disabled) {
        req.sessionId = id;
        req.user = toSessionUser(row.user);
        req.mfaPending = row.session.mfaPending;
        lastWorkspaceId = row.user.lastWorkspaceId;
      }
    }

    if (isPublic(path)) return;
    if (!req.user) return reply.code(401).send({ error: 'Требуется вход' });
    if (req.mfaPending && !MFA_PENDING_PATHS.has(path)) {
      return reply.code(401).send({ error: 'Требуется код 2FA', code: 'mfa_required' });
    }
    if (req.mfaPending) return;

    req.ws = resolveWorkspace(req, lastWorkspaceId);
    if (!req.ws && !noWorkspacePath(path)) {
      return reply.code(403).send({ error: 'Нет доступа к пространству', code: 'no_workspace' });
    }
  });
}

/** id текущего пространства; маршруты пространства вызываются только после хука выше */
export function wsId(req: FastifyRequest) {
  if (!req.ws) throw new HttpError(403, 'Нет доступа к пространству');
  return req.ws.id;
}

export function requireInfra(level: Exclude<InfraAccess, 'none'>) {
  return async (req: FastifyRequest) => {
    if (!req.ws || INFRA_LEVEL[req.ws.infra] < INFRA_LEVEL[level]) {
      throw new HttpError(403, level === 'edit' ? 'Нужно право правки инфраструктуры' : 'Нет доступа к инфраструктуре');
    }
  };
}

export const infraViewer = { preHandler: requireInfra('view') };
export const infraEditor = { preHandler: requireInfra('edit') };

/** Есть ли у участника в пространстве такой уровень модуля (модуль выключен — нет) */
export function hasModuleLevel(ws: WorkspaceAccess | null, id: string, level: string) {
  const m = getModule(id);
  const have = ws?.modules[id];
  return !!m && have !== undefined && levelRank(m, have) >= levelRank(m, level) && levelRank(m, level) > 0;
}

/**
 * Маршрут модуля в пространстве: модуль работает в нём, и у участника не ниже `level`.
 * `denied` — текст отказа по правам, например «Нужно право управления EVE»
 */
export function requireModule(id: string, level: string, denied?: string) {
  return async (req: FastifyRequest) => {
    const title = getModule(id)?.title ?? id;
    if (req.ws && !(id in req.ws.modules)) throw new HttpError(403, `Модуль ${title} выключен`);
    if (!hasModuleLevel(req.ws, id, level)) throw new HttpError(403, denied ?? `Нет доступа к модулю ${title}`);
  };
}

export async function requireMembersAdmin(req: FastifyRequest) {
  if (!req.ws?.manageMembers) throw new HttpError(403, 'Нужно право управлять участниками');
}

export async function requireOwner(req: FastifyRequest) {
  if (!req.ws?.isOwner) throw new HttpError(403, 'Только для владельца пространства');
}

export async function requireSystemAdmin(req: FastifyRequest) {
  if (req.user?.role !== 'admin') throw new HttpError(403, 'Только для администратора системы');
}

export const infraLevel = (a: InfraAccess) => INFRA_LEVEL[a];
