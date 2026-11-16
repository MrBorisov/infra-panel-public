import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit.js';
import { createSession, infraLevel, modulesIn, requireMembersAdmin, requireOwner, toSessionUser, updateUser, userWorkspaces, wsId } from '../auth.js';
import { config } from '../config.js';
import { hashPassword, randomToken, sha256 } from '../crypto.js';
import { db, schema } from '../db/index.js';
import { HttpError, notFound } from '../errors.js';
import { getModule, installedModules, storedLevel, topLevel } from '../modules.js';
import { countRows, getInWorkspace, inWorkspace } from '../queries.js';
import { idParam, reqStr } from '../validation.js';
import {
  acceptInvite,
  createWorkspace,
  creatorCanGrant,
  describePerms,
  findInvite,
  isMember,
  knownModuleLevels,
  modulesWithin,
  purgeChannelQueues,
  registerUser,
  revokeInvitesBy,
} from '../workspaces.js';
import { passwordSchema } from './auth.js';

const DAY = 86_400_000;
const MAX_OWNED_WORKSPACES = 20;
// Регистраций по ссылкам за сутки на всю панель (заведённых администратором не считаем): у каждого свои пространства и лимиты, и без потолка
// приглашения самому себе (по цепочке аккаунтов) обходили бы лимит объектов владельца
export const REGISTER_LIMIT = { perDay: 50 };

/** Уровни по модулям из запроса: только подключённые модули и их уровни */
const modulesSchema = z
  .record(z.string(), z.string())
  .default({})
  .superRefine((v, ctx) => {
    for (const [id, level] of Object.entries(v)) {
      const m = getModule(id);
      if (!m) ctx.addIssue({ code: 'custom', path: [id], message: `Неизвестный модуль ${id}` });
      else if (!m.levels.includes(level)) ctx.addIssue({ code: 'custom', path: [id], message: `Неизвестный уровень ${level}` });
    }
  });

const permsSchema = z.object({
  infraAccess: z.enum(schema.accessLevels.infra),
  // Модули, которых нет в запросе, не меняются: права выключенного модуля не затираются
  modules: modulesSchema,
  canManageMembers: z.boolean().default(false),
});
type Perms = z.infer<typeof permsSchema>;

/**
 * Защита от повышения прав: не-владелец раздаёт не больше, чем есть у него самого,
 * и не может назначать других управляющих участниками. Сравниваем с сохранёнными правами,
 * а не с действующими: при выключенном модуле его права и не теряются, и не растут.
 */
function assertCanGrant(req: FastifyRequest, perms: Perms) {
  if (req.ws!.isOwner) return;
  if (perms.canManageMembers) throw new HttpError(403, 'Назначать управляющих может только владелец');
  const me = db
    .select()
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, wsId(req)), eq(schema.workspaceMembers.userId, req.user!.id)))
    .get()!;
  if (infraLevel(perms.infraAccess) > infraLevel(me.infraAccess) || !modulesWithin(perms.modules, me.modules)) {
    throw new HttpError(403, 'Нельзя выдать больше прав, чем есть у вас');
  }
}

const getMember = (workspaceId: number, memberId: number) => getInWorkspace(schema.workspaceMembers, workspaceId, memberId, 'Участник');

export function workspaceRoutes(app: FastifyInstance) {
  // ── Пространства ──────────────────────────────────────────────────────

  app.get('/api/workspaces', async (req) => userWorkspaces(req.user!.id));

  app.post('/api/workspaces', async (req) => {
    const { name } = z.object({ name: reqStr(100) }).parse(req.body);
    // Пространства не множатся без счёта: у каждого свои квоты на объекты и каналы
    const owned = userWorkspaces(req.user!.id).filter((w) => w.isOwner).length;
    if (owned >= MAX_OWNED_WORKSPACES) throw new HttpError(400, `Своих пространств может быть не больше ${MAX_OWNED_WORKSPACES}`);
    const ws = createWorkspace(name, req.user!.id);
    audit(req, 'workspace.create', { workspaceId: ws.id, details: name });
    return userWorkspaces(req.user!.id).find((w) => w.id === ws.id);
  });

  // Запомнить выбранное пространство, чтобы на другом устройстве открылось оно же
  app.post('/api/workspaces/:id/select', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!userWorkspaces(req.user!.id).some((w) => w.id === id)) throw notFound('Пространство');
    updateUser(req.user!.id, { lastWorkspaceId: id });
    return { ok: true };
  });

  app.patch('/api/workspace', { preHandler: requireOwner }, async (req) => {
    const { name } = z.object({ name: reqStr(100) }).parse(req.body);
    db.update(schema.workspaces).set({ name }).where(eq(schema.workspaces.id, wsId(req))).run();
    audit(req, 'workspace.rename', { details: name });
    return { ok: true };
  });

  // Удаление стирает все данные пространства (каскадом) — требуем ввести название
  app.delete('/api/workspace', { preHandler: requireOwner }, async (req) => {
    const { confirmName } = z.object({ confirmName: z.string() }).parse(req.body);
    const ws = req.ws!;
    if (confirmName.trim() !== ws.name) throw new HttpError(400, 'Название не совпадает');
    db.transaction((tx) => {
      purgeChannelQueues(tx, ws.id);
      tx.delete(schema.workspaces).where(eq(schema.workspaces.id, ws.id)).run();
    });
    audit(req, 'workspace.delete', { details: ws.name, system: true });
    return { ok: true };
  });

  // ── Участники ─────────────────────────────────────────────────────────

  const manager = { preHandler: requireMembersAdmin };

  app.get('/api/members', manager, async (req) =>
    db
      .select({
        id: schema.workspaceMembers.id,
        userId: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        isOwner: schema.workspaceMembers.isOwner,
        infraAccess: schema.workspaceMembers.infraAccess,
        modules: schema.workspaceMembers.modules,
        canManageMembers: schema.workspaceMembers.canManageMembers,
        totpEnabled: schema.users.totpEnabled,
        lastLoginAt: schema.users.lastLoginAt,
        createdAt: schema.workspaceMembers.createdAt,
      })
      .from(schema.workspaceMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .where(eq(schema.workspaceMembers.workspaceId, wsId(req)))
      .orderBy(desc(schema.workspaceMembers.isOwner), schema.users.name)
      .all()
      .map((m) => ({ ...m, modules: knownModuleLevels(m.modules) })),
  );

  app.patch('/api/members/:id', manager, async (req) => {
    const { id } = idParam.parse(req.params);
    const workspaceId = wsId(req);
    const member = getMember(workspaceId, id);
    if (member.isOwner) throw new HttpError(400, 'Права владельца не меняются — он может всё');
    if (member.userId === req.user!.id) throw new HttpError(400, 'Свои права менять нельзя');
    if (member.canManageMembers && !req.ws!.isOwner) throw new HttpError(403, 'Права управляющего меняет только владелец');
    const perms = permsSchema.parse(req.body);
    assertCanGrant(req, perms);
    const modules = { ...member.modules, ...perms.modules };
    db.update(schema.workspaceMembers).set({ ...perms, modules }).where(eq(schema.workspaceMembers.id, id)).run();
    // Его ссылки выданы под старые права — отзываем, пусть создаст новые
    revokeInvitesBy(workspaceId, member.userId);
    audit(req, 'member.update', { entityType: 'user', entityId: member.userId, details: describePerms({ ...perms, modules: knownModuleLevels(modules) }) });
    return { ok: true };
  });

  app.delete('/api/members/:id', manager, async (req) => {
    const { id } = idParam.parse(req.params);
    const member = getMember(wsId(req), id);
    if (member.isOwner) throw new HttpError(400, 'Владельца удалить нельзя — сначала передайте владение');
    if (member.canManageMembers && !req.ws!.isOwner) throw new HttpError(403, 'Управляющего удаляет только владелец');
    db.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.id, id)).run();
    revokeInvitesBy(member.workspaceId, member.userId);
    audit(req, 'member.remove', { entityType: 'user', entityId: member.userId });
    return { ok: true };
  });

  // Выйти из пространства самому
  app.post('/api/workspace/leave', async (req) => {
    const ws = req.ws!;
    if (ws.isOwner) throw new HttpError(400, 'Владелец не может выйти — передайте владение или удалите пространство');
    db.delete(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.userId, req.user!.id)))
      .run();
    revokeInvitesBy(ws.id, req.user!.id);
    audit(req, 'member.leave');
    return { ok: true };
  });

  app.post('/api/members/:id/make-owner', { preHandler: requireOwner }, async (req) => {
    const { id } = idParam.parse(req.params);
    const workspaceId = wsId(req);
    const member = getMember(workspaceId, id);
    const mine = and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, req.user!.id));
    const me = db.select().from(schema.workspaceMembers).where(mine).get()!;
    // Бывший владелец остаётся управляющим со всеми правами: верхний уровень во всех модулях
    const modules = { ...me.modules, ...Object.fromEntries(installedModules().map((m) => [m.id, topLevel(m)])) };
    db.transaction((tx) => {
      tx.update(schema.workspaceMembers).set({ isOwner: false, infraAccess: 'edit', modules, canManageMembers: true }).where(mine).run();
      tx.update(schema.workspaceMembers).set({ isOwner: true }).where(eq(schema.workspaceMembers.id, member.id)).run();
    });
    audit(req, 'member.make_owner', { entityType: 'user', entityId: member.userId });
    return { ok: true };
  });

  // ── Приглашения ───────────────────────────────────────────────────────

  app.get('/api/invites', manager, async (req) =>
    db
      .select()
      .from(schema.workspaceInvites)
      .where(
        and(
          eq(schema.workspaceInvites.workspaceId, wsId(req)),
          isNull(schema.workspaceInvites.usedAt),
          gt(schema.workspaceInvites.expiresAt, Date.now()),
        ),
      )
      .orderBy(desc(schema.workspaceInvites.id))
      .all()
      // Ссылки создателя, который больше не вправе их выдать, не действуют — и в списке не нужны
      .filter(creatorCanGrant)
      .map((i) => ({
        id: i.id,
        infraAccess: i.infraAccess,
        modules: knownModuleLevels(i.modules),
        canManageMembers: i.canManageMembers,
        note: i.note,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      })),
  );

  app.post('/api/invites', manager, async (req) => {
    const body = permsSchema
      .extend({ note: z.string().trim().max(200).optional(), ttlDays: z.number().int().min(1).max(30).default(7) })
      .parse(req.body);
    assertCanGrant(req, body);
    const token = randomToken(24);
    const invite = db
      .insert(schema.workspaceInvites)
      .values({
        workspaceId: wsId(req),
        tokenHash: sha256(token),
        infraAccess: body.infraAccess,
        modules: knownModuleLevels(body.modules),
        canManageMembers: body.canManageMembers,
        note: body.note || null,
        createdBy: req.user!.id,
        expiresAt: Date.now() + body.ttlDays * DAY,
      })
      .returning({ id: schema.workspaceInvites.id })
      .get();
    const perms = describePerms({ ...body, modules: knownModuleLevels(body.modules) });
    audit(req, 'invite.create', { entityId: invite.id, details: `${perms}${body.note ? `; ${body.note}` : ''}` });
    // Сам токен показываем один раз: в базе только его хеш
    return { id: invite.id, url: `${config.publicUrl || ''}/invite/${token}`, token };
  });

  app.delete('/api/invites/:id', manager, async (req) => {
    const { id } = idParam.parse(req.params);
    db.delete(schema.workspaceInvites).where(inWorkspace(schema.workspaceInvites, wsId(req), id)).run();
    audit(req, 'invite.revoke', { entityId: id });
    return { ok: true };
  });

  const tokenBody = z.object({ token: z.string().min(10).max(200) });
  const inviteGone = () => new HttpError(404, 'Приглашение не найдено, уже использовано или истекло');

  // Что за приглашение — показать до вступления. Доступно и без входа: ссылка сама пропуск
  app.post('/api/invites/preview', async (req) => {
    const found = findInvite(tokenBody.parse(req.body).token);
    if (!found) throw inviteGone();
    const { invite, ws } = found;
    return {
      workspaceName: ws.name,
      infraAccess: invite.infraAccess,
      // Права в модулях, работающих в этом пространстве
      modules: Object.fromEntries(modulesIn(ws.id).map((m) => [m.id, storedLevel(m, invite.modules)])),
      canManageMembers: invite.canManageMembers,
      alreadyMember: !!req.user && !req.mfaPending && isMember(ws.id, req.user.id),
    };
  });

  app.post('/api/invites/accept', async (req) => {
    const found = findInvite(tokenBody.parse(req.body).token);
    if (!found) throw inviteGone();
    return acceptInvite(req, found, req.user!);
  });

  // Регистрация по email только по приглашению: без ссылки аккаунт заводит администратор системы
  app.post('/api/invites/register', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const body = tokenBody
      .extend({ name: reqStr(100), email: z.email('Некорректный email').trim().toLowerCase(), password: passwordSchema })
      .parse(req.body);
    const found = findInvite(body.token);
    if (!found) throw inviteGone();
    const registered = and(eq(schema.auditLog.action, 'user.register'), gt(schema.auditLog.createdAt, Date.now() - DAY));
    if (countRows(schema.auditLog, registered) >= REGISTER_LIMIT.perDay) {
      throw new HttpError(429, 'Слишком много регистраций за сутки — попробуйте завтра или попросите администратора завести аккаунт');
    }
    if (db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, body.email)).get()) {
      throw new HttpError(400, 'Пользователь с таким email уже есть — войдите им');
    }
    const passwordHash = await hashPassword(body.password);
    const { user, access } = registerUser(req, { email: body.email, name: body.name, passwordHash }, found);
    audit(req, 'user.register', { userId: user.id, userEmail: user.email, details: `по приглашению в «${found.ws.name}»`, system: true });
    createSession(reply, req, user.id, false);
    return { user: toSessionUser(user), workspace: access };
  });
}

