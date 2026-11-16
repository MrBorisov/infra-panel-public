import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core';
import { db, schema } from './db/index.js';
import { notFound } from './errors.js';

/** Таблица пространства: есть и id, и workspace_id */
type Scoped = AnySQLiteTable & { id: AnySQLiteColumn; workspaceId: AnySQLiteColumn };

/** Условие «объект с этим id — в этом пространстве»: id из запроса не читается без фильтра по пространству */
export const inWorkspace = (table: Scoped, workspaceId: number, id: number) => and(eq(table.workspaceId, workspaceId), eq(table.id, id));

/** Объект пространства по id или 404 «<what> не найдена» */
export function getInWorkspace<T extends Scoped>(table: T, workspaceId: number, id: number, what: string): T['$inferSelect'] {
  const row = db.select().from(table).where(inWorkspace(table, workspaceId, id)).get();
  if (!row) throw notFound(what);
  return row as T['$inferSelect'];
}

export const countRows = (table: AnySQLiteTable, where?: SQL) => db.select({ n: sql<number>`count(*)` }).from(table).where(where).get()?.n ?? 0;

/** Сколько строк на пространство: workspace_id → число */
export function countByWorkspace(column: AnySQLiteColumn) {
  const rows = db.select({ id: column, n: sql<number>`count(*)` }).from(column.table).groupBy(column).all();
  return new Map(rows.map((r) => [r.id as number, r.n]));
}

/** Последние события журнала пространства, новые первыми; extra — дополнительные условия */
export const recentEvents = (workspaceId: number, limit: number, ...extra: (SQL | undefined)[]) =>
  db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.workspaceId, workspaceId), ...extra))
    .orderBy(desc(schema.events.id))
    .limit(limit)
    .all();
