import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { audit } from '../audit.js';
import { infraEditor, infraViewer, wsId } from '../auth.js';
import { db, schema } from '../db/index.js';
import { HttpError } from '../errors.js';
import { countRows, getInWorkspace, inWorkspace } from '../queries.js';
import { entitySchemas, idParam, parsePatch, type EntityPath } from '../validation.js';
import { assertRefsInWorkspace } from '../workspaces.js';

const entityRegistry = {
  accounts: { table: schema.accounts, type: 'account', label: 'Аккаунт' },
  servers: { table: schema.servers, type: 'server', label: 'Сервер' },
  hostings: { table: schema.hostings, type: 'hosting', label: 'Хостинг' },
  domains: { table: schema.domains, type: 'domain', label: 'Домен' },
  sites: { table: schema.sites, type: 'site', label: 'Сайт' },
} as const;

type Row = Record<string, unknown> & { id: number; name: string; workspaceId: number };

// Сколько объектов может быть в пространстве: серверы и сайты проверяются с нашего сервера,
// домены — через RDAP/WHOIS, и без потолка одно пространство нагружало бы всех
export const ENTITY_LIMITS: Record<EntityPath, number> = { accounts: 1000, servers: 300, hostings: 500, domains: 2000, sites: 300 };

// Поля-ссылки каждой сущности: куда указывают
const refFields: Record<EntityPath, { field: string; path: EntityPath }[]> = {
  accounts: [],
  servers: [{ field: 'accountId', path: 'accounts' }],
  hostings: [{ field: 'accountId', path: 'accounts' }],
  domains: [
    { field: 'registrarAccountId', path: 'accounts' },
    { field: 'dnsAccountId', path: 'accounts' },
  ],
  sites: [
    { field: 'domainId', path: 'domains' },
    { field: 'serverId', path: 'servers' },
    { field: 'hostingId', path: 'hostings' },
  ],
};

// Если поменялось то, что проверяет мониторинг, сбрасываем статус, и планировщик проверит заново
const monitorResetFields: Partial<Record<EntityPath, string[]>> = {
  servers: ['ip', 'hostname', 'monitorPort', 'monitorEnabled'],
  sites: ['url', 'keyword', 'monitorEnabled'],
};

function prepareValues(path: EntityPath, values: Record<string, unknown>, before?: Row) {
  const out = { ...values };
  const resetOn = monitorResetFields[path];
  if (before && resetOn?.some((f) => f in out && out[f] !== before[f])) {
    Object.assign(out, { status: 'unknown', failCount: 0, lastCheckAt: null, lastError: null, statusChangedAt: null });
    if (path === 'sites') Object.assign(out, { sslCheckedAt: null, lastHttpStatus: null });
  }
  if (path === 'domains') {
    if ('expiresAt' in out && (!before || out.expiresAt !== before.expiresAt)) {
      out.expiresSource = out.expiresAt ? 'manual' : null;
    }
    if (before && 'name' in out && out.name !== before.name) Object.assign(out, { lastLookupAt: null, lastLookupError: null });
  }
  return out;
}

export function entityRoutes(app: FastifyInstance) {
  for (const [path, def] of Object.entries(entityRegistry) as [EntityPath, (typeof entityRegistry)[EntityPath]][]) {
    // Таблицы разные, а операции одинаковые, поэтому типизируем обобщённо
    const table = def.table as typeof schema.accounts;
    const inputSchema = entitySchemas[path];

    const getRow = (workspaceId: number, id: number) => getInWorkspace(table, workspaceId, id, def.label) as Row;

    const checkRefs = (workspaceId: number, values: Record<string, unknown>) =>
      assertRefsInWorkspace(
        workspaceId,
        refFields[path].filter((r) => r.field in values).map((r) => ({ path: r.path, id: values[r.field] })),
      );

    app.get(`/api/${path}`, infraViewer, async (req) =>
      db.select().from(table).where(eq(table.workspaceId, wsId(req))).orderBy(asc(table.name)).all(),
    );

    app.get(`/api/${path}/:id`, infraViewer, async (req) => getRow(wsId(req), idParam.parse(req.params).id));

    app.post(`/api/${path}`, infraEditor, async (req) => {
      const workspaceId = wsId(req);
      // Лимит — на владельца по всем его пространствам: иначе 20 своих пространств давали бы 20 лимитов
      const wm = schema.workspaceMembers;
      const owner = db.select({ id: wm.userId }).from(wm).where(and(eq(wm.workspaceId, workspaceId), eq(wm.isOwner, true)));
      const owned = db.select({ id: wm.workspaceId }).from(wm).where(and(eq(wm.isOwner, true), inArray(wm.userId, owner)));
      if (countRows(table, inArray(table.workspaceId, owned)) >= ENTITY_LIMITS[path]) {
        throw new HttpError(400, `У владельца пространства может быть не больше ${ENTITY_LIMITS[path]} объектов этого вида во всех его пространствах`);
      }
      const values = prepareValues(path, inputSchema.parse(req.body));
      checkRefs(workspaceId, values);
      const row = db
        .insert(table)
        .values({ ...values, workspaceId } as never)
        .returning()
        .get() as Row;
      audit(req, 'entity.create', { entityType: def.type, entityId: row.id, details: row.name });
      return row;
    });

    app.patch(`/api/${path}/:id`, infraEditor, async (req) => {
      const workspaceId = wsId(req);
      const { id } = idParam.parse(req.params);
      const before = getRow(workspaceId, id);
      const values = prepareValues(path, parsePatch(inputSchema, req.body), before);
      checkRefs(workspaceId, values);
      if (Object.keys(values).length) db.update(table).set(values as never).where(inWorkspace(table, workspaceId, id)).run();
      audit(req, 'entity.update', { entityType: def.type, entityId: id, details: `${before.name}: ${Object.keys(values).join(', ')}` });
      return getRow(workspaceId, id);
    });

    app.delete(`/api/${path}/:id`, infraEditor, async (req) => {
      const workspaceId = wsId(req);
      const { id } = idParam.parse(req.params);
      const row = getRow(workspaceId, id);
      db.transaction((tx) => {
        tx.delete(schema.credentials)
          .where(
            and(
              eq(schema.credentials.workspaceId, workspaceId),
              eq(schema.credentials.entityType, def.type),
              eq(schema.credentials.entityId, id),
            ),
          )
          .run();
        if (def.type === 'server' || def.type === 'site') {
          tx.delete(schema.checks)
            .where(and(eq(schema.checks.entityType, def.type), eq(schema.checks.entityId, id)))
            .run();
        }
        tx.delete(table).where(inWorkspace(table, workspaceId, id)).run();
      });
      audit(req, 'entity.delete', { entityType: def.type, entityId: id, details: row.name });
      return { ok: true };
    });
  }
}
