import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit.js';
import { destroyUserSessions, requireMembersAdmin, requireSystemAdmin, updateUser, userWorkspaces, wsId } from '../auth.js';
import { config } from '../config.js';
import { hashPassword } from '../crypto.js';
import { db, schema } from '../db/index.js';
import { HttpError, notFound } from '../errors.js';
import { enqueueTelegramDirect } from '../notify.js';
import { idParam } from '../validation.js';
import { createWorkspace, purgeChannelQueues } from '../workspaces.js';
import { passwordSchema } from './auth.js';

// Системная роль: admin управляет пользователями, но в чужие пространства не заходит
const roleSchema = z.enum(['admin', 'user']);

const publicColumns = {
  id: schema.users.id,
  email: schema.users.email,
  name: schema.users.name,
  role: schema.users.role,
  totpEnabled: schema.users.totpEnabled,
  disabled: schema.users.disabled,
  lastLoginAt: schema.users.lastLoginAt,
  createdAt: schema.users.createdAt,
};

function otherActiveAdmins(userId: number) {
  return db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.role, 'admin'), eq(schema.users.disabled, false), ne(schema.users.id, userId)))
    .all().length;
}

export function userRoutes(app: FastifyInstance) {
  const sysadmin = { preHandler: requireSystemAdmin };

  app.get('/api/users', sysadmin, async () => db.select(publicColumns).from(schema.users).orderBy(schema.users.name).all());

  app.post('/api/users', sysadmin, async (req) => {
    const body = z
      .object({
        email: z.email('Некорректный email').trim().toLowerCase(),
        name: z.string().trim().min(1).max(100),
        role: roleSchema,
        password: passwordSchema,
      })
      .parse(req.body);
    if (db.select().from(schema.users).where(eq(schema.users.email, body.email)).get()) {
      throw new HttpError(400, 'Пользователь с таким email уже есть');
    }
    const user = db
      .insert(schema.users)
      .values({ email: body.email, name: body.name, role: body.role, passwordHash: await hashPassword(body.password) })
      .returning(publicColumns)
      .get();
    // Своё пространство есть у каждого; в чужие — по приглашению
    createWorkspace(`Пространство ${user.name}`, user.id);
    audit(req, 'user.create', { entityType: 'user', entityId: user.id, details: `${user.email} (${user.role})`, system: true });
    return user;
  });

  app.patch('/api/users/:id', sysadmin, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        role: roleSchema.optional(),
        disabled: z.boolean().optional(),
        password: passwordSchema.optional(),
        resetTotp: z.boolean().optional(),
      })
      .parse(req.body);
    const user = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
    if (!user) throw notFound('Пользователь');

    const losingAdmin = user.role === 'admin' && ((body.role && body.role !== 'admin') || body.disabled === true);
    if (losingAdmin && otherActiveAdmins(id) === 0) throw new HttpError(400, 'Нельзя убрать последнего администратора');
    if (id === req.user!.id && (body.disabled || (body.role && body.role !== 'admin'))) {
      throw new HttpError(400, 'Нельзя понизить или отключить самого себя');
    }

    const patch: Partial<typeof schema.users.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.role !== undefined) patch.role = body.role;
    if (body.disabled !== undefined) patch.disabled = body.disabled;
    if (body.password) patch.passwordHash = await hashPassword(body.password);
    if (body.resetTotp) Object.assign(patch, { totpEnabled: false, totpSecretEnc: null, totpLastStep: null, totpFailures: 0, totpFailedAt: null });

    if (Object.keys(patch).length) updateUser(id, patch);
    if (body.password || body.disabled || body.resetTotp) destroyUserSessions(id);

    const changes = Object.keys(body).filter((k) => k !== 'password');
    if (body.password) changes.push('password');
    audit(req, 'user.update', { entityType: 'user', entityId: id, details: `${user.email ?? user.name}: ${changes.join(', ')}`, system: true });
    // Сброс пароля или 2FA — это возможность войти под человеком. Тихо так делать нельзя:
    // пишем в журнал каждого его пространства (его видят владельцы) и сообщаем ему самому
    if (id !== req.user!.id && (body.password || body.resetTotp)) {
      const what = [body.password && 'пароль', body.resetTotp && '2FA'].filter(Boolean).join(' и ');
      for (const w of userWorkspaces(id)) {
        audit(req, 'user.reset_by_admin', { workspaceId: w.id, entityType: 'user', entityId: id, details: `${user.email ?? user.name}: ${what}` });
      }
      if (user.telegramUserId) {
        enqueueTelegramDirect(
          user.telegramUserId,
          `⚠️ ${config.appName}: администратор системы ${req.user!.name} сбросил вам ${what}. Если вы об этом не просили — свяжитесь с ним и смените пароль.`,
        );
      }
    }
    return db.select(publicColumns).from(schema.users).where(eq(schema.users.id, id)).get();
  });

  app.delete('/api/users/:id', sysadmin, async (req) => {
    const { id } = idParam.parse(req.params);
    if (id === req.user!.id) throw new HttpError(400, 'Нельзя удалить самого себя');
    const user = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
    if (!user) throw notFound('Пользователь');
    if (user.role === 'admin' && otherActiveAdmins(id) === 0) throw new HttpError(400, 'Нельзя удалить последнего администратора');

    // Пространства, где он владелец: без других участников удаляются вместе с ним,
    // с участниками — сначала передать владение, иначе данные остались бы без хозяина
    const owned = db
      .select({ workspaceId: schema.workspaceMembers.workspaceId })
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.userId, id), eq(schema.workspaceMembers.isOwner, true)))
      .all();
    const blocked = owned.some(({ workspaceId }) =>
      db
        .select({ id: schema.workspaceMembers.id })
        .from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), ne(schema.workspaceMembers.userId, id)))
        .get(),
    );
    if (blocked) throw new HttpError(400, 'Пользователь владеет пространствами с другими участниками — сначала передайте владение');
    db.transaction((tx) => {
      for (const { workspaceId } of owned) {
        purgeChannelQueues(tx, workspaceId);
        tx.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).run();
      }
      tx.delete(schema.users).where(eq(schema.users.id, id)).run();
    });
    audit(req, 'user.delete', { entityType: 'user', entityId: id, details: user.email ?? user.name, system: true });
    return { ok: true };
  });

  // Журнал: системный — админу системы, журнал пространства — тем, кто управляет участниками
  app.get('/api/audit', async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(2000).default(500), scope: z.enum(['workspace', 'system']).default('workspace') })
      .parse(req.query);
    const system = q.scope === 'system';
    await (system ? requireSystemAdmin : requireMembersAdmin)(req);
    const scope = system ? isNull(schema.auditLog.workspaceId) : eq(schema.auditLog.workspaceId, wsId(req));
    return db.select().from(schema.auditLog).where(scope).orderBy(desc(schema.auditLog.id)).limit(q.limit).all();
  });
}
