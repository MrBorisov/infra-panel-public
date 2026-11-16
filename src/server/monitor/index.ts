import type { FastifyBaseLogger } from 'fastify';
import { and, eq, lt, ne } from 'drizzle-orm';
import { purgeExpiredSessions } from '../auth.js';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { collectDeadlines, deadlineTitle, OVERDUE_MAX_DAYS, type Deadline } from '../deadlines.js';
import { cleanupModules } from '../modules.js';
import { formatDuration, recordEvent, type Notice } from '../notify.js';
import { lookupDomainExpiry } from './domainLookup.js';
import { httpProbe, sslProbe, tcpProbe, type ProbeResult } from './probes.js';

type Server = typeof schema.servers.$inferSelect;
type Site = typeof schema.sites.$inferSelect;
type Logger = Pick<FastifyBaseLogger, 'error' | 'info' | 'warn'>;

const HOUR = 3_600_000;
const SSL_INTERVAL = 6 * HOUR;
const DOMAIN_INTERVAL = 24 * HOUR;
const DOMAIN_RETRY_INTERVAL = 6 * HOUR;
const REMINDERS_INTERVAL = HOUR;
const CLEANUP_INTERVAL = 24 * HOUR;

let log: Logger = console;
let timer: NodeJS.Timeout | null = null;
let ticking = false;
let domainQueueBusy = false;
let lastReminders = 0;
let lastCleanup = 0;
const inFlight = new Set<string>();

const serverTarget = (s: Server) => s.ip || s.hostname || '';
const serverKey = (s: Server) => `${serverTarget(s)}:${s.monitorPort}`;
const siteKey = (s: Site) => `${s.url}|${s.keyword ?? ''}`;

// Проверок одновременно — не больше этого: тысячи сайтов разом сделали бы из панели отражатель
// нагрузки и задушили бы соседей по серверу. Остальные дождутся следующего такта (10 с)
const MAX_PARALLEL = 20;

function runOnce(key: string, fn: () => Promise<unknown>) {
  if (inFlight.has(key) || inFlight.size >= MAX_PARALLEL) return;
  inFlight.add(key);
  fn()
    .catch((e) => log.error({ err: e, key }, 'Ошибка проверки'))
    .finally(() => inFlight.delete(key));
}

// ---------- Серверы и сайты: доступность ----------

function applyResult(type: 'server' | 'site', id: number, targetKey: string, result: ProbeResult) {
  const table = type === 'server' ? schema.servers : schema.sites;
  const current = db.select().from(table).where(eq(table.id, id)).get();
  // Пока шла проверка, объект могли удалить, отключить или поменять ему адрес
  if (!current || !current.monitorEnabled) return;
  const currentKey = type === 'server' ? serverKey(current as Server) : siteKey(current as Site);
  if (currentKey !== targetKey) return;

  const now = Date.now();
  db.insert(schema.checks).values({ entityType: type, entityId: id, ok: result.ok, latencyMs: result.latencyMs, message: result.message }).run();

  const update: Partial<Server & Site> = {
    lastCheckAt: now,
    lastLatencyMs: result.latencyMs,
    lastError: result.message,
  };
  if (type === 'site') update.lastHttpStatus = result.httpStatus ?? null;

  const path = `/${type}s/${id}`;
  const label = type === 'server' ? 'Сервер' : 'Сайт';
  const target = type === 'server' ? serverTarget(current as Server) : (current as Site).url;

  if (result.ok) {
    update.failCount = 0;
    if (current.status !== 'up') {
      update.status = 'up';
      update.statusChangedAt = now;
      if (current.status === 'down') {
        const downtime = current.statusChangedAt ? formatDuration(now - current.statusChangedAt) : '—';
        recordEvent(current.workspaceId, type, id, 'up', `${label} «${current.name}» снова доступен (простой ${downtime})`, {
          topic: 'infra.status',
          severity: 'ok',
          title: `${label} «${current.name}» снова работает`,
          body: `${target}\nПростой: ${downtime}`,
          path,
        });
      }
    }
  } else {
    update.failCount = current.failCount + 1;
    if (current.status !== 'down' && update.failCount >= config.monitor.failThreshold) {
      update.status = 'down';
      update.statusChangedAt = now;
      recordEvent(current.workspaceId, type, id, 'down', `${label} «${current.name}» недоступен: ${result.message ?? 'ошибка'}`, {
        topic: 'infra.status',
        severity: 'critical',
        title: `${label} «${current.name}» недоступен`,
        body: [target, result.message].filter(Boolean).join('\n'),
        path,
      });
    }
  }

  db.update(table).set(update).where(eq(table.id, id)).run();
}

export async function checkServer(server: Server) {
  const target = serverTarget(server);
  if (!target) return;
  const result = await tcpProbe(target, server.monitorPort);
  applyResult('server', server.id, serverKey(server), result);
}

export async function checkSite(site: Site) {
  const result = await httpProbe(site.url, site.keyword);
  applyResult('site', site.id, siteKey(site), result);
}

// ---------- SSL ----------

export async function checkSsl(site: Site) {
  const url = new URL(site.url);
  if (url.protocol !== 'https:') return;
  const now = Date.now();
  const patch = await sslProbe(url.hostname, Number(url.port) || 443).then(
    (info) => ({ sslExpiresAt: info.validTo, sslIssuer: info.issuer, sslError: info.error }),
    (e) => ({ sslError: e instanceof Error ? e.message : String(e) }),
  );
  db.update(schema.sites).set({ ...patch, sslCheckedAt: now }).where(eq(schema.sites.id, site.id)).run();
}

// ---------- Домены ----------

export async function lookupDomain(domain: typeof schema.domains.$inferSelect) {
  const now = Date.now();
  const patch = await lookupDomainExpiry(domain.name).then(
    ({ expiresAt, source }) => ({ expiresAt, expiresSource: source, lastLookupError: null }),
    (e) => ({ lastLookupError: e instanceof Error ? e.message : String(e) }),
  );
  db.update(schema.domains).set({ ...patch, lastLookupAt: now }).where(eq(schema.domains.id, domain.id)).run();
}

/** Домены проверяем по одному: RDAP/WHOIS-серверы не любят частые запросы */
async function runDomainQueue(now: number) {
  if (domainQueueBusy) return;
  const due = db
    .select()
    .from(schema.domains)
    .where(eq(schema.domains.autoLookup, true))
    .all()
    .filter((d) => !d.lastLookupAt || now - d.lastLookupAt > (d.lastLookupError ? DOMAIN_RETRY_INTERVAL : DOMAIN_INTERVAL));
  if (!due.length) return;
  domainQueueBusy = true;
  try {
    for (const d of due) {
      await lookupDomain(d);
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    domainQueueBusy = false;
  }
}

// ---------- Напоминания о сроках ----------

const THRESHOLDS: Record<Deadline['kind'], number[]> = {
  domain: [0, 1, 3, 7, 30],
  ssl: [0, 1, 3, 7], // Let's Encrypt продлевает сам, раньше недели беспокоить незачем
  server_payment: [0, 1, 3, 7],
  hosting_payment: [0, 1, 3, 7],
};

// Просроченное напоминаем снова: первую неделю каждый день, потом раз в неделю, после месяца
// молчим — брошенный домен в учёте не должен писать вечно. Раньше «истёк» приходил один раз
// и терялся, если в тот момент Telegram ещё не был привязан.
const OVERDUE_DAILY_DAYS = 7;
// Повторы — днём, а не сразу после полуночи (час по времени сервера, как и граница суток в daysUntil)
const OVERDUE_FROM_HOUR = 9;

/** Ступень напоминания: по ней ключ в notifications_sent, одна ступень — одно сообщение */
function reminderStep(d: Deadline, now: number): string | undefined {
  if (d.daysLeft >= 0) {
    const threshold = THRESHOLDS[d.kind].find((t) => d.daysLeft <= t);
    return threshold === undefined ? undefined : String(threshold);
  }
  const overdue = -d.daysLeft;
  if (overdue > OVERDUE_MAX_DAYS || new Date(now).getHours() < OVERDUE_FROM_HOUR) return undefined;
  return overdue <= OVERDUE_DAILY_DAYS ? `overdue-d${overdue}` : `overdue-w${Math.ceil(overdue / 7)}`;
}

function reminderNotice(d: Deadline): Notice {
  const severity = d.daysLeft <= 1 ? 'critical' : 'warning';
  const body = d.kind === 'domain' && d.autoRenew ? 'Автопродление включено, проверьте баланс' : undefined;
  return { topic: 'infra.deadline', severity, path: d.path, title: deadlineTitle(d), body };
}

export function runReminders(now = Date.now()) {
  for (const d of collectDeadlines(undefined, now)) {
    const step = reminderStep(d, now);
    if (step === undefined) continue;
    const key = `${d.kind}:${d.entityId}:${d.date}:${step}`;
    const inserted = db.insert(schema.notificationsSent).values({ key }).onConflictDoNothing().run();
    if (inserted.changes === 0) continue;
    const notice = reminderNotice(d);
    recordEvent(d.workspaceId, d.entityType, d.entityId, `reminder_${d.kind}`, notice.title, notice);
  }
}

// ---------- Планировщик ----------

function cleanup(now: number) {
  db.delete(schema.checks).where(lt(schema.checks.createdAt, now - config.monitor.retentionDays * 24 * HOUR)).run();
  db.delete(schema.events).where(lt(schema.events.createdAt, now - 365 * 24 * HOUR)).run();
  db.delete(schema.notificationsSent).where(lt(schema.notificationsSent.createdAt, now - 400 * 24 * HOUR)).run();
  // Отправленное и упавшее в очередях ботов храним месяц — для разбора
  db.delete(schema.tgQueue).where(and(ne(schema.tgQueue.status, 'pending'), lt(schema.tgQueue.createdAt, now - 30 * 24 * HOUR))).run();
  db.delete(schema.discordQueue).where(and(ne(schema.discordQueue.status, 'pending'), lt(schema.discordQueue.createdAt, now - 30 * 24 * HOUR))).run();
  cleanupModules(now);
  purgeExpiredSessions();
}

function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const intervalMs = config.monitor.intervalSec * 1000;
    const isDue = (lastCheckAt: number | null) => !lastCheckAt || now - lastCheckAt >= intervalMs;

    for (const s of db.select().from(schema.servers).where(eq(schema.servers.monitorEnabled, true)).all()) {
      if (serverTarget(s) && isDue(s.lastCheckAt)) runOnce(`server:${s.id}`, () => checkServer(s));
    }
    for (const s of db.select().from(schema.sites).where(eq(schema.sites.monitorEnabled, true)).all()) {
      if (isDue(s.lastCheckAt)) runOnce(`site:${s.id}`, () => checkSite(s));
      if (s.url.startsWith('https://') && (!s.sslCheckedAt || now - s.sslCheckedAt >= SSL_INTERVAL)) {
        runOnce(`ssl:${s.id}`, () => checkSsl(s));
      }
    }

    runDomainQueue(now).catch((e) => log.error({ err: e }, 'Ошибка проверки доменов'));

    if (now - lastReminders >= REMINDERS_INTERVAL) {
      lastReminders = now;
      runReminders(now);
    }
    if (now - lastCleanup >= CLEANUP_INTERVAL) {
      lastCleanup = now;
      cleanup(now);
    }
  } catch (e) {
    log.error({ err: e }, 'Ошибка планировщика');
  } finally {
    ticking = false;
  }
}

export function startMonitor(logger: Logger) {
  log = logger;
  if (!config.monitor.enabled) {
    log.warn('Мониторинг отключён (MONITOR_ENABLED=false)');
    return;
  }
  // Первые напоминания не сразу после старта, чтобы успели обновиться SSL и сроки доменов
  lastReminders = Date.now() - REMINDERS_INTERVAL + 2 * 60_000;
  setTimeout(tick, 2000);
  timer = setInterval(tick, 10_000);
}

export function stopMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}
