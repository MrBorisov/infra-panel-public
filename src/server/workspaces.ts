import type { FastifyRequest } from 'fastify';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { InfraAccess, ModuleLevels } from '../shared/types.js';
import { audit } from './audit.js';
import { infraLevel, toAccess } from './auth.js';
import { sha256 } from './crypto.js';
import { db, schema } from './db/index.js';
import { HttpError } from './errors.js';
import { installedModules, levelRank, getModule } from './modules.js';

/** Новое пространство, где пользователь — владелец */
export function createWorkspace(name: string, ownerId: number) {
  return db.transaction((tx) => {
    const ws = tx.insert(schema.workspaces).values({ name }).returning().get();
    tx.insert(schema.workspaceMembers)
      .values({ workspaceId: ws.id, userId: ownerId, isOwner: true, infraAccess: 'edit', canManageMembers: true })
      .run();
    tx.update(schema.users).set({ lastWorkspaceId: ws.id }).where(eq(schema.users.id, ownerId)).run();
    return ws;
  });
}

export function isMember(workspaceId: number, userId: number) {
  return !!db
    .select({ id: schema.workspaceMembers.id })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)))
    .get();
}

/** Права для журнала: «инфраструктура: view, demo: manage, управляет участниками» */
export function describePerms(p: { infraAccess: InfraAccess; modules: ModuleLevels; canManageMembers: boolean }) {
  const modules = Object.entries(p.modules).map(([id, level]) => `, ${getModule(id)?.title ?? id}: ${level}`);
  return `инфраструктура: ${p.infraAccess}${modules.join('')}${p.canManageMembers ? ', управляет участниками' : ''}`;
}

/** Уровни подключённых модулей (с незнакомыми ключами и уровнями — без них): то, что можно выдать */
export function knownModuleLevels(levels: ModuleLevels): ModuleLevels {
  return Object.fromEntries(
    installedModules()
      .filter((m) => levelRank(m, levels[m.id]) > 0)
      .map((m) => [m.id, levels[m.id]]),
  );
}

/** Не больше ли `wanted` по каждому модулю, чем `mine` (сохранённые уровни выдающего) */
export const modulesWithin = (wanted: ModuleLevels, mine: ModuleLevels) =>
  installedModules().every((m) => levelRank(m, wanted[m.id]) <= levelRank(m, mine[m.id]));

type Invite = typeof schema.workspaceInvites.$inferSelect;

/**
 * Приглашение действует, пока его создатель вправе выдать такие права. Иначе удалённый или
 * пониженный управляющий вернулся бы по своей же сохранённой ссылке — с паролями.
 */
export function creatorCanGrant(invite: Invite) {
  if (!invite.createdBy) return false;
  const m = db
    .select()
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, invite.workspaceId), eq(schema.workspaceMembers.userId, invite.createdBy)))
    .get();
  if (!m) return false;
  if (m.isOwner) return true;
  if (!m.canManageMembers || invite.canManageMembers) return false;
  return infraLevel(invite.infraAccess) <= infraLevel(m.infraAccess) && modulesWithin(invite.modules, m.modules);
}

/** Убрать неиспользованные приглашения участника: его удалили, он вышел или ему сменили права */
export function revokeInvitesBy(workspaceId: number, userId: number) {
  db.delete(schema.workspaceInvites)
    .where(
      and(eq(schema.workspaceInvites.workspaceId, workspaceId), eq(schema.workspaceInvites.createdBy, userId), isNull(schema.workspaceInvites.usedAt)),
    )
    .run();
}

/** Действующее приглашение по токену из ссылки: не использовано, не истекло, создатель вправе */
export function findInvite(token: string) {
  const found = db
    .select({ invite: schema.workspaceInvites, ws: schema.workspaces })
    .from(schema.workspaceInvites)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceInvites.workspaceId))
    .where(
      and(
        eq(schema.workspaceInvites.tokenHash, sha256(token)),
        isNull(schema.workspaceInvites.usedAt),
        gt(schema.workspaceInvites.expiresAt, Date.now()),
      ),
    )
    .get();
  return found && creatorCanGrant(found.invite) ? found : undefined;
}

export type FoundInvite = NonNullable<ReturnType<typeof findInvite>>;

/**
 * Вступить по приглашению: пользователь становится участником с правами из приглашения,
 * и пространство открывается следующим. Вызов внутри внешней транзакции откатывается вместе с ней.
 */
export function acceptInvite(req: FastifyRequest, { invite, ws }: FoundInvite, user: { id: number; email: string | null; name: string }) {
  if (isMember(ws.id, user.id)) throw new HttpError(400, 'Вы уже участник этого пространства');
  const member = db.transaction((tx) => {
    // Помечаем использованным условием на usedAt: второй одновременный запрос ничего не обновит
    const used = tx
      .update(schema.workspaceInvites)
      .set({ usedAt: Date.now(), usedBy: user.id })
      .where(and(eq(schema.workspaceInvites.id, invite.id), isNull(schema.workspaceInvites.usedAt)))
      .run();
    if (used.changes === 0) throw new HttpError(409, 'Приглашение уже использовано');
    const m = tx
      .insert(schema.workspaceMembers)
      .values({
        workspaceId: ws.id,
        userId: user.id,
        infraAccess: invite.infraAccess,
        // Только подключённые модули: права удалённого модуля по старой ссылке не всплывут
        modules: knownModuleLevels(invite.modules),
        canManageMembers: invite.canManageMembers,
        invitedBy: invite.createdBy,
      })
      .returning()
      .get();
    tx.update(schema.users).set({ lastWorkspaceId: ws.id }).where(eq(schema.users.id, user.id)).run();
    return m;
  });
  audit(req, 'invite.accept', {
    workspaceId: ws.id,
    entityId: invite.id,
    userId: user.id,
    userEmail: user.email ?? user.name,
    details: describePerms({ ...invite, modules: knownModuleLevels(invite.modules) }),
  });
  return toAccess(ws, member);
}

/**
 * Новый пользователь со своим пространством, по приглашению — сразу и участник. Одной транзакцией:
 * если приглашение успели использовать, пользователь не создаётся (ссылка одноразовая).
 * Регистрация по email и вход через модуль заводят пользователей только так
 */
export function registerUser(
  req: FastifyRequest,
  values: { name: string; email?: string | null; passwordHash?: string | null },
  invite?: FoundInvite,
) {
  return db.transaction(() => {
    const user = db.insert(schema.users).values({ ...values, role: 'user' }).returning().get();
    createWorkspace(`Пространство ${user.name}`, user.id);
    return { user, access: invite ? acceptInvite(req, invite, user) : null };
  });
}

const refTables = {
  accounts: schema.accounts,
  servers: schema.servers,
  hostings: schema.hostings,
  domains: schema.domains,
  sites: schema.sites,
} as const;

/**
 * Связанные объекты обязаны лежать в том же пространстве: иначе через accountId чужого
 * пространства можно было бы привязаться к его данным.
 */
export function assertRefsInWorkspace(workspaceId: number, refs: { path: keyof typeof refTables; id: unknown }[]) {
  const byTable = new Map<keyof typeof refTables, number[]>();
  for (const r of refs) {
    if (typeof r.id !== 'number') continue;
    byTable.set(r.path, [...(byTable.get(r.path) ?? []), r.id]);
  }
  for (const [path, ids] of byTable) {
    const table = refTables[path] as typeof schema.accounts;
    const found = db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.workspaceId, workspaceId), inArray(table.id, ids)))
      .all().length;
    if (found !== new Set(ids).size) throw new HttpError(400, 'Связанный объект не найден в этом пространстве');
  }
}

/** Пространство без участников — например «Основное» на свежей установке */
export function orphanWorkspace() {
  return db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .leftJoin(schema.workspaceMembers, eq(schema.workspaceMembers.workspaceId, schema.workspaces.id))
    .where(isNull(schema.workspaceMembers.id))
    .get();
}

type Tx = Pick<BetterSQLite3Database<typeof schema>, 'select' | 'delete'>;

/**
 * Перед удалением пространства — неотправленное по его каналам. Каскад обнулит channel_id,
 * и сообщения со снимком токена ушли бы от ботов удалённого пространства.
 */
export function purgeChannelQueues(tx: Tx, workspaceId: number) {
  const channelIds = tx.select({ id: schema.notifyChannels.id }).from(schema.notifyChannels).where(eq(schema.notifyChannels.workspaceId, workspaceId));
  tx.delete(schema.tgQueue).where(and(eq(schema.tgQueue.status, 'pending'), inArray(schema.tgQueue.channelId, channelIds))).run();
  tx.delete(schema.discordQueue).where(and(eq(schema.discordQueue.status, 'pending'), inArray(schema.discordQueue.channelId, channelIds))).run();
}
