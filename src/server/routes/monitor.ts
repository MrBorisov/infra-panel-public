import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { hasModuleLevel, infraEditor, infraViewer, wsId } from '../auth.js';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { collectDeadlines } from '../deadlines.js';
import { HttpError } from '../errors.js';
import { installedModules } from '../modules.js';
import { checkServer, checkSite, checkSsl, lookupDomain } from '../monitor/index.js';
import { countRows, getInWorkspace, inWorkspace, recentEvents } from '../queries.js';
import { idParam } from '../validation.js';

const HOUR = 3_600_000;

// Объекты ядра в журнале событий; события модулей — их eventTypes, только с доступом к модулю
const CORE_EVENT_TYPES = ['server', 'site', 'domain', 'hosting', 'account'];

/** Какие события видит участник: белый список, чтобы события удалённого модуля никому не утекли */
function visibleEventTypes(req: FastifyRequest) {
  const fromModules = installedModules().flatMap((m) => (hasModuleLevel(req.ws, m.id, m.levels[1]) ? (m.eventTypes ?? []) : []));
  return [...CORE_EVENT_TYPES, ...fromModules];
}

function uptime(entityType: 'server' | 'site', entityId: number, since: number) {
  const row = db
    .select({ total: sql<number>`count(*)`, ok: sql<number>`coalesce(sum(${schema.checks.ok}), 0)` })
    .from(schema.checks)
    .where(and(eq(schema.checks.entityType, entityType), eq(schema.checks.entityId, entityId), gte(schema.checks.createdAt, since)))
    .get();
  return row && row.total > 0 ? (row.ok / row.total) * 100 : null;
}

export function monitorRoutes(app: FastifyInstance) {
  // «Проверить сейчас» — не сканер: без лимита им перебирали бы порты и дёргали WHOIS
  const manualLimit = { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `run:${req.user?.id ?? req.ip}` } };
  const params = z.object({ type: z.enum(['server', 'site']), ...idParam.shape });

  app.get('/api/monitor/:type/:id', infraViewer, async (req) => {
    const { type, id } = params.parse(req.params);
    const workspaceId = wsId(req);
    // Объект должен быть из своего пространства — иначе по id читалась бы чужая история
    if (type === 'server') getInWorkspace(schema.servers, workspaceId, id, 'Сервер');
    else getInWorkspace(schema.sites, workspaceId, id, 'Сайт');
    const now = Date.now();
    const checks = db
      .select({ ok: schema.checks.ok, latencyMs: schema.checks.latencyMs, message: schema.checks.message, createdAt: schema.checks.createdAt })
      .from(schema.checks)
      .where(and(eq(schema.checks.entityType, type), eq(schema.checks.entityId, id), gte(schema.checks.createdAt, now - 24 * HOUR)))
      .orderBy(schema.checks.createdAt)
      .all();
    return {
      checks,
      events: recentEvents(workspaceId, 30, eq(schema.events.entityType, type), eq(schema.events.entityId, id)),
      uptime: {
        day: uptime(type, id, now - 24 * HOUR),
        week: uptime(type, id, now - 7 * 24 * HOUR),
        month: uptime(type, id, now - 30 * 24 * HOUR),
      },
    };
  });

  app.post('/api/monitor/:type/:id/run', { ...infraEditor, config: manualLimit }, async (req) => {
    const { type, id } = params.parse(req.params);
    const workspaceId = wsId(req);
    if (type === 'server') {
      const server = getInWorkspace(schema.servers, workspaceId, id, 'Сервер');
      if (!server.monitorEnabled) throw new HttpError(400, 'Мониторинг для сервера выключен');
      if (!server.ip && !server.hostname) throw new HttpError(400, 'Не указан IP или hostname');
      await checkServer(server);
      return getInWorkspace(schema.servers, workspaceId, id, 'Сервер');
    }
    const site = getInWorkspace(schema.sites, workspaceId, id, 'Сайт');
    if (!site.monitorEnabled) throw new HttpError(400, 'Мониторинг для сайта выключен');
    await Promise.all([checkSite(site), checkSsl(site)]);
    return getInWorkspace(schema.sites, workspaceId, id, 'Сайт');
  });

  app.post('/api/domains/:id/lookup', { ...infraEditor, config: manualLimit }, async (req) => {
    const { id } = idParam.parse(req.params);
    const workspaceId = wsId(req);
    const domain = getInWorkspace(schema.domains, workspaceId, id, 'Домен');
    await lookupDomain(domain);
    return db.select().from(schema.domains).where(inWorkspace(schema.domains, workspaceId, id)).get();
  });

  app.get('/api/dashboard', infraViewer, async (req) => {
    const workspaceId = wsId(req);
    const servers = db.select().from(schema.servers).where(eq(schema.servers.workspaceId, workspaceId)).all();
    const sites = db.select().from(schema.sites).where(eq(schema.sites.workspaceId, workspaceId)).all();
    const hostings = db.select().from(schema.hostings).where(eq(schema.hostings.workspaceId, workspaceId)).all();
    const domains = db.select().from(schema.domains).where(eq(schema.domains.workspaceId, workspaceId)).all();

    // Расходы приводим к месяцу, отдельно по каждой валюте
    const costs: Record<string, number> = {};
    for (const item of [...servers, ...hostings, ...domains]) {
      if (!item.price) continue;
      const monthly = item.billingPeriod === 'year' ? item.price / 12 : item.price;
      costs[item.currency] = (costs[item.currency] ?? 0) + monthly;
    }

    const monitored = <T extends { monitorEnabled: boolean; status: string }>(list: T[]) => ({
      total: list.length,
      monitored: list.filter((x) => x.monitorEnabled).length,
      up: list.filter((x) => x.monitorEnabled && x.status === 'up').length,
      down: list.filter((x) => x.monitorEnabled && x.status === 'down').length,
    });

    return {
      down: [
        ...servers.filter((s) => s.monitorEnabled && s.status === 'down').map((s) => ({ type: 'server' as const, id: s.id, name: s.name, target: s.ip || s.hostname, since: s.statusChangedAt, error: s.lastError })),
        ...sites.filter((s) => s.monitorEnabled && s.status === 'down').map((s) => ({ type: 'site' as const, id: s.id, name: s.name, target: s.url, since: s.statusChangedAt, error: s.lastError })),
      ],
      deadlines: collectDeadlines(workspaceId).filter((d) => d.daysLeft <= 30),
      costs,
      counts: {
        servers: monitored(servers),
        sites: monitored(sites),
        domains: domains.length,
        hostings: hostings.length,
        accounts: countRows(schema.accounts, eq(schema.accounts.workspaceId, workspaceId)),
      },
      // События модулей — только тем, у кого есть доступ к модулю
      events: recentEvents(workspaceId, 30, inArray(schema.events.entityType, visibleEventTypes(req))),
    };
  });

  app.get('/api/settings', async () => ({
    monitorEnabled: config.monitor.enabled,
    checkIntervalSec: config.monitor.intervalSec,
    failThreshold: config.monitor.failThreshold,
    publicUrl: config.publicUrl,
  }));
}
