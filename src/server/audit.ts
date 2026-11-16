import type { FastifyRequest } from 'fastify';
import { db, schema } from './db/index.js';

/**
 * Запись в журнал. Действия с данными привязываются к текущему пространству; системные
 * (входы, управление пользователями) — `system: true`, без пространства.
 */
export function audit(
  req: FastifyRequest,
  action: string,
  opts: {
    entityType?: string;
    entityId?: number;
    details?: string;
    userId?: number;
    userEmail?: string | null;
    workspaceId?: number | null;
    system?: boolean;
  } = {},
) {
  db.insert(schema.auditLog)
    .values({
      workspaceId: opts.system ? null : (opts.workspaceId ?? req.ws?.id ?? null),
      userId: opts.userId ?? req.user?.id ?? null,
      userEmail: opts.userEmail ?? req.user?.email ?? req.user?.name ?? null,
      action,
      entityType: opts.entityType ?? null,
      entityId: opts.entityId ?? null,
      details: opts.details ?? null,
      ip: req.ip,
    })
    .run();
}
