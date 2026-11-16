import { plural } from '../shared/text.js';
import type { Deadline as PublicDeadline } from '../shared/types.js';
import { db, schema } from './db/index.js';

export type Deadline = PublicDeadline & { workspaceId: number };

const DAY = 86_400_000;
/** Дольше месяца просроченное молчит и в напоминаниях, и в сводке: брошенный домен не должен писать вечно */
export const OVERDUE_MAX_DAYS = 30;

export function daysUntil(date: string, now = Date.now()) {
  const today = new Date(now);
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((Date.parse(date) - todayUtc) / DAY);
}

/** Сроки пространства (или всех пространств для напоминаний): домены, SSL, оплата серверов и хостинга */
export function collectDeadlines(workspaceId?: number, now = Date.now()): Deadline[] {
  const out: Deadline[] = [];
  // Страница объекта — /<тип>s/<id>: /domains/1, /sites/2, /servers/3, /hostings/4
  const add = (kind: Deadline['kind'], entityType: Deadline['entityType'], r: { id: number; workspaceId: number; name: string }, date: string, autoRenew?: boolean) =>
    out.push({ workspaceId: r.workspaceId, kind, entityType, entityId: r.id, name: r.name, date, path: `/${entityType}s/${r.id}`, autoRenew, daysLeft: daysUntil(date, now) });
  const only = <T extends { workspaceId: number }>(rows: T[]) => (workspaceId ? rows.filter((r) => r.workspaceId === workspaceId) : rows);

  for (const d of only(db.select().from(schema.domains).all())) if (d.expiresAt) add('domain', 'domain', d, d.expiresAt, d.autoRenew);
  for (const s of only(db.select().from(schema.sites).all())) {
    if (s.sslExpiresAt && s.monitorEnabled) add('ssl', 'site', s, new Date(s.sslExpiresAt).toISOString().slice(0, 10));
  }
  for (const s of only(db.select().from(schema.servers).all())) if (s.paidUntil) add('server_payment', 'server', s, s.paidUntil);
  for (const h of only(db.select().from(schema.hostings).all())) if (h.paidUntil) add('hosting_payment', 'hosting', h, h.paidUntil);
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

const days = (n: number) => `${n} ${plural(n, ['день', 'дня', 'дней'])}`;

function whenText(d: Deadline) {
  if (d.daysLeft < 0) return `истёк ${d.date}, ${days(-d.daysLeft)} назад`;
  if (d.daysLeft === 0) return `истекает сегодня (${d.date})`;
  return `истекает через ${days(d.daysLeft)} (${d.date})`;
}

/** Текст о сроке — один и в напоминании, и в сводке при привязке Telegram */
export function deadlineTitle(d: Deadline) {
  switch (d.kind) {
    case 'domain':
      return `Домен ${d.name} ${whenText(d)}`;
    case 'ssl':
      return `SSL-сертификат сайта «${d.name}» ${whenText(d)}`;
    case 'server_payment':
      return `Оплата сервера «${d.name}»: срок ${whenText(d)}`;
    case 'hosting_payment':
      return `Оплата хостинга «${d.name}»: срок ${whenText(d)}`;
  }
}
