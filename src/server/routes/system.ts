import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { SystemModules } from '../../shared/types.js';
import { audit } from '../audit.js';
import { requireSystemAdmin } from '../auth.js';
import { db, schema } from '../db/index.js';
import { notFound } from '../errors.js';
import { disabledModules, getModule, installedModules, moduleSwitchedOn, safely, setModuleSwitch, setWorkspaceModule } from '../modules.js';
import { countByWorkspace } from '../queries.js';
import { idParam } from '../validation.js';

/**
 * Раздел «Модули»: модули на всём сайте и в пространствах. Только администратор системы.
 * В пространства он по-прежнему не заходит: видит название, владельца и счётчики, а не данные
 */
export function systemRoutes(app: FastifyInstance) {
  const sysadmin = { preHandler: requireSystemAdmin };
  const label = (on: boolean) => (on ? 'включён' : 'выключен');
  const moduleParam = (id: string) => {
    const m = getModule(id);
    if (!m) throw notFound('Модуль');
    return m;
  };

  app.get('/api/system/modules', sysadmin, async (): Promise<SystemModules> => {
    const owners = db
      .select({ id: schema.workspaceMembers.workspaceId, name: schema.users.name, email: schema.users.email })
      .from(schema.workspaceMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .where(eq(schema.workspaceMembers.isOwner, true))
      .all();
    const owner = new Map(owners.map((o) => [o.id, o.email ?? o.name]));
    const members = countByWorkspace(schema.workspaceMembers.workspaceId);
    const modules = installedModules();
    const counters = new Map(modules.map((m) => [m.id, m.admin?.counter ? safely(m, 'admin.counter', () => m.admin!.counter!.count(), new Map<number, number>()) : null]));
    const disabled = disabledModules();
    return {
      modules: modules.map((m) => ({
        id: m.id,
        title: m.title,
        description: m.description,
        available: safely(m, 'available', () => m.available?.() ?? true, false),
        unavailableReason: m.unavailableReason ?? null,
        enabled: moduleSwitchedOn(m.id),
        offWarning: m.admin?.offWarning ? safely(m, 'admin.offWarning', () => m.admin!.offWarning!(), null) : null,
        counterLabel: m.admin?.counter?.label ?? null,
      })),
      workspaces: db
        .select()
        .from(schema.workspaces)
        .orderBy(schema.workspaces.name)
        .all()
        .map((w) => ({
          id: w.id,
          name: w.name,
          owner: owner.get(w.id) ?? null,
          members: members.get(w.id) ?? 0,
          modules: Object.fromEntries(
            modules.map((m) => {
              const counter = counters.get(m.id);
              return [m.id, { enabled: !disabled.get(w.id)?.has(m.id), count: counter ? (counter.get(w.id) ?? 0) : null }];
            }),
          ),
        })),
    };
  });

  // Весь сайт: модуль выключается целиком — вход через него, его данные, фоновые задачи и тревоги
  app.patch('/api/system/modules/:moduleId', sysadmin, async (req) => {
    const m = moduleParam(z.object({ moduleId: z.string() }).parse(req.params).moduleId);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    setModuleSwitch(m.id, enabled);
    audit(req, 'system.module', { details: `${m.title} для всего сайта ${label(enabled)}`, system: true });
    return { ok: true };
  });

  // Одно пространство: права участников на модуль сохраняются и вернутся с ним
  app.patch('/api/system/workspaces/:id/modules/:moduleId', sysadmin, async (req) => {
    const { id } = idParam.parse(req.params);
    const m = moduleParam(z.object({ moduleId: z.string() }).parse(req.params).moduleId);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).get();
    if (!ws) throw notFound('Пространство');
    setWorkspaceModule(id, m.id, enabled);
    // В журнал пространства — владелец увидит, кто и когда; и в системный
    const details = `модуль ${m.title} ${label(enabled)} администратором системы`;
    audit(req, 'workspace.module', { workspaceId: id, details });
    audit(req, 'workspace.module', { details: `«${ws.name}»: ${details}`, system: true });
    return { ok: true };
  });
}
