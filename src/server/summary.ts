import { and, asc, eq } from 'drizzle-orm';
import { modulesIn, toAccess, userMemberships } from './auth.js';
import { db, schema } from './db/index.js';
import { collectDeadlines, deadlineTitle, OVERDUE_MAX_DAYS } from './deadlines.js';
import { formatDuration, memberTopics, panelUrl } from './notify.js';
import { activeModules, disabledModules } from './modules.js';

// Сроки «горят», если до них неделя и меньше — как самый ранний порог напоминаний о SSL и оплате
const SOON_DAYS = 7;
const MAX_LINES = 10;
const TG_LIMIT = 4000;

function downLines(table: typeof schema.servers | typeof schema.sites, workspaceId: number, what: string, now: number) {
  return db
    .select()
    .from(table)
    .where(and(eq(table.workspaceId, workspaceId), eq(table.monitorEnabled, true), eq(table.status, 'down')))
    .orderBy(asc(table.name))
    .all()
    .map((x) => `🔴 ${what} «${x.name}» не работает${x.statusChangedAt ? ` уже ${formatDuration(now - x.statusChangedAt)}` : ''}`);
}

/**
 * Что сейчас требует внимания — по всем пространствам пользователя, в пределах его прав и
 * выбранных тем. Оповещения уходят только в момент события: случившееся до привязки
 * Telegram иначе прошло бы мимо. Пусто — null.
 */
function telegramSummary(userId: number, now = Date.now()): string | null {
  const sections: string[] = [];
  const active = activeModules();
  const disabled = disabledModules();
  for (const { ws, m } of userMemberships(userId)) {
    const topics = memberTopics(toAccess(ws, m, modulesIn(ws.id, active, disabled)), m.notifyTopics);
    const lines: string[] = [];
    if (topics.includes('infra.status')) {
      lines.push(...downLines(schema.servers, ws.id, 'Сервер', now), ...downLines(schema.sites, ws.id, 'Сайт', now));
    }
    if (topics.includes('infra.deadline')) {
      for (const d of collectDeadlines(ws.id, now)) if (d.daysLeft <= SOON_DAYS && d.daysLeft >= -OVERDUE_MAX_DAYS) lines.push(`⏰ ${deadlineTitle(d)}`);
    }
    if (!lines.length) continue;
    const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `…и ещё ${lines.length - MAX_LINES + 1}`] : lines;
    sections.push([`📁 ${ws.name}`, ...shown, panelUrl('/', ws.id)].filter(Boolean).join('\n'));
  }
  if (!sections.length) return null;
  const text = ['📋 Сейчас требует внимания:', ...sections].join('\n\n');
  return text.length > TG_LIMIT ? `${text.slice(0, TG_LIMIT - 1)}…` : text;
}

export function enqueueTelegramSummary(userId: number, tgUserId: number) {
  const text = telegramSummary(userId);
  if (text) db.insert(schema.tgQueue).values({ chatId: String(tgUserId), text, kind: 'summary' }).run();
}
