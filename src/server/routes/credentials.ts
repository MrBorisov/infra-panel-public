import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit.js';
import { infraEditor, infraViewer, wsId } from '../auth.js';
import { decrypt, encrypt } from '../crypto.js';
import { db, schema } from '../db/index.js';
import { notFound } from '../errors.js';
import { getInWorkspace, inWorkspace } from '../queries.js';
import { assertSshFields, credentialEntityTypes, credentialSchema, idParam, parsePatch } from '../validation.js';
import { assertRefsInWorkspace } from '../workspaces.js';

type CredentialRow = typeof schema.credentials.$inferSelect;

const typeToPath = { account: 'accounts', server: 'servers', hosting: 'hostings', domain: 'domains', site: 'sites' } as const;

/** Наружу секрет не отдаём, только признак его наличия */
function toPublic({ secretEnc, ...rest }: CredentialRow) {
  return { ...rest, hasSecret: !!secretEnc };
}

const getCredential = (workspaceId: number, id: number) => getInWorkspace(schema.credentials, workspaceId, id, 'Доступ');

function describe(c: Pick<CredentialRow, 'kind' | 'title' | 'username' | 'entityType' | 'entityId'>) {
  return `${c.kind}${c.title ? ` «${c.title}»` : ''}${c.username ? ` ${c.username}` : ''} → ${c.entityType}#${c.entityId}`;
}

export function credentialRoutes(app: FastifyInstance) {
  app.get('/api/credentials', infraViewer, async (req) => {
    const q = z
      .object({ entityType: z.enum(credentialEntityTypes), entityId: z.coerce.number().int().positive() })
      .parse(req.query);
    return db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.workspaceId, wsId(req)),
          eq(schema.credentials.entityType, q.entityType),
          eq(schema.credentials.entityId, q.entityId),
        ),
      )
      .orderBy(asc(schema.credentials.kind), asc(schema.credentials.id))
      .all()
      .map(toPublic);
  });

  app.post('/api/credentials', infraEditor, async (req) => {
    const workspaceId = wsId(req);
    const { secret, clearSecret: _, ...values } = credentialSchema.parse(req.body);
    assertSshFields(values.kind, values.address, values.username);
    // Доступ можно прикрепить только к объекту своего пространства
    assertRefsInWorkspace(workspaceId, [{ path: typeToPath[values.entityType], id: values.entityId }]);
    const row = db
      .insert(schema.credentials)
      .values({ ...values, workspaceId, secretEnc: secret ? encrypt(secret) : null })
      .returning()
      .get();
    audit(req, 'credential.create', { entityType: 'credential', entityId: row.id, details: describe(row) });
    return toPublic(row);
  });

  app.patch('/api/credentials/:id', infraEditor, async (req) => {
    const workspaceId = wsId(req);
    const { id } = idParam.parse(req.params);
    const before = getCredential(workspaceId, id);
    const { secret, clearSecret, entityType: _t, entityId: _i, ...values } = parsePatch(credentialSchema, req.body);
    assertSshFields(
      values.kind ?? before.kind,
      values.address !== undefined ? values.address : before.address,
      values.username !== undefined ? values.username : before.username,
    );
    const patch: Partial<typeof schema.credentials.$inferInsert> = { ...values };
    if (secret) patch.secretEnc = encrypt(secret);
    else if (clearSecret) patch.secretEnc = null;
    if (Object.keys(patch).length) db.update(schema.credentials).set(patch).where(inWorkspace(schema.credentials, workspaceId, id)).run();
    audit(req, 'credential.update', {
      entityType: 'credential',
      entityId: id,
      details: `${describe(before)}${secret ? ' (пароль изменён)' : clearSecret ? ' (пароль удалён)' : ''}`,
    });
    return toPublic(getCredential(workspaceId, id));
  });

  app.delete('/api/credentials/:id', infraEditor, async (req) => {
    const workspaceId = wsId(req);
    const { id } = idParam.parse(req.params);
    const row = getCredential(workspaceId, id);
    db.delete(schema.credentials).where(inWorkspace(schema.credentials, workspaceId, id)).run();
    audit(req, 'credential.delete', { entityType: 'credential', entityId: id, details: describe(row) });
    return { ok: true };
  });

  // Каждый просмотр пароля попадает в журнал
  app.post('/api/credentials/:id/reveal', infraEditor, async (req) => {
    const { id } = idParam.parse(req.params);
    const row = getCredential(wsId(req), id);
    if (!row.secretEnc) throw notFound('Пароль');
    audit(req, 'credential.reveal', { entityType: 'credential', entityId: id, details: describe(row) });
    return { secret: decrypt(row.secretEnc) };
  });
}
