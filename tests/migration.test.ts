import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

// Миграции с переносом данных: база с миграциями до upTo включительно, данные, затем остальные — как runMigrations()

function migrateWithData(upTo: number, fill: (sqlite: Database.Database, now: number) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'panel-migration-'));
  const old = path.join(dir, 'drizzle');
  cpSync('drizzle', old, { recursive: true });
  const journalPath = path.join(old, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= upTo);
  writeFileSync(journalPath, JSON.stringify(journal));

  const sqlite = new Database(path.join(dir, 'panel.db'));
  sqlite.pragma('foreign_keys = OFF');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: old });
  const now = Date.now();
  sqlite.prepare(`INSERT INTO users (id, name, role, created_at, updated_at) VALUES (1, 'a', 'user', ?, ?), (2, 'b', 'user', ?, ?)`).run(now, now, now, now);
  sqlite.prepare(`INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (10, 'W', ?, ?)`).run(now, now);
  fill(sqlite, now);

  migrate(db, { migrationsFolder: path.resolve('drizzle') });
  assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
  return sqlite;
}

const columns = (sqlite: Database.Database, table: string) =>
  (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const json = (sqlite: Database.Database, sql: string) =>
  sqlite.prepare(sql).all().map((r) => JSON.parse(Object.values(r as object)[0] as string));

// 0006: права на EVE из столбца eve_access переехали в JSON modules, столбец ушёл. Права EVE затем убрала 0007 —
// здесь проверяем, что переезд дошёл без ошибок и прав ядра не тронул
test('0006: eve_access → modules без потери прав ядра', () => {
  const sqlite = migrateWithData(5, (sqlite, now) => {
    const member = sqlite.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, is_owner, infra_access, eve_access, can_manage_members, created_at, updated_at) VALUES (10, ?, ?, ?, ?, 0, ?, ?)`,
    );
    member.run(1, 1, 'edit', 'manage', now, now);
    member.run(2, 0, 'view', 'none', now, now);
    sqlite
      .prepare(`INSERT INTO workspace_invites (workspace_id, token_hash, infra_access, eve_access, can_manage_members, expires_at, created_at) VALUES (10, 'h1', 'none', 'view', 0, ?, ?)`)
      .run(now + 1e6, now);
  });
  assert.deepEqual(sqlite.prepare('SELECT infra_access AS a FROM workspace_members ORDER BY rowid').all(), [{ a: 'edit' }, { a: 'view' }]);
  assert.ok(!columns(sqlite, 'workspace_members').includes('eve_access') && !columns(sqlite, 'workspace_invites').includes('eve_access'));
  assert.ok(!columns(sqlite, 'workspaces').includes('eve_enabled'));
  sqlite.close();
});

// 0007: модуль EVE удалён насовсем — его таблицы, права, выключатели, темы и события уходят, чужое остаётся
test('0007: от EVE ничего не остаётся, данные ядра и других модулей целы', () => {
  const sqlite = migrateWithData(6, (sqlite, now) => {
    const member = sqlite.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, is_owner, infra_access, modules, notify_topics, can_manage_members, created_at, updated_at) VALUES (10, ?, 0, 'view', ?, ?, 0, ?, ?)`,
    );
    member.run(1, '{"eve":"manage","demo":"view"}', '["infra.status","eve.attack"]', now, now);
    member.run(2, '{}', null, now, now);
    sqlite
      .prepare(`INSERT INTO workspace_invites (workspace_id, token_hash, infra_access, modules, can_manage_members, expires_at, created_at) VALUES (10, 'h1', 'none', '{"eve":"view"}', 0, ?, ?)`)
      .run(now + 1e6, now);
    sqlite.prepare(`INSERT INTO workspace_modules (workspace_id, module_id, enabled, updated_at) VALUES (10, 'eve', 0, ?), (10, 'demo', 0, ?)`).run(now, now);
    sqlite.prepare(`INSERT INTO system_settings (key, value, updated_at) VALUES ('module.eve.enabled', 'false', ?), ('module.demo.enabled', 'false', ?)`).run(now, now);
    const channel = sqlite.prepare(`INSERT INTO notify_channels (workspace_id, kind, name, secret_enc, topics, created_at, updated_at) VALUES (10, 'discord_webhook', ?, 'x', ?, ?, ?)`);
    channel.run('mixed', '["eve.fuel","infra.status","demo.ping"]', now, now);
    channel.run('core', '["infra.status"]', now, now);
    const event = sqlite.prepare(`INSERT INTO events (workspace_id, entity_type, entity_id, kind, message, created_at) VALUES (10, ?, 1, 'x', 'm', ?)`);
    event.run('eve_corp', now);
    event.run('server', now);
  });
  const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'eve\\_%' ESCAPE '\\'`).all();
  assert.deepEqual(tables, []);
  assert.deepEqual(json(sqlite, 'SELECT modules FROM workspace_members ORDER BY rowid'), [{ demo: 'view' }, {}]);
  assert.deepEqual(json(sqlite, 'SELECT modules FROM workspace_invites'), [{}]);
  assert.deepEqual(sqlite.prepare('SELECT notify_topics AS t FROM workspace_members ORDER BY rowid').all(), [{ t: '["infra.status"]' }, { t: null }]);
  assert.deepEqual(json(sqlite, 'SELECT topics FROM notify_channels ORDER BY id'), [['infra.status', 'demo.ping'], ['infra.status']]);
  assert.deepEqual(sqlite.prepare('SELECT module_id AS m FROM workspace_modules').all(), [{ m: 'demo' }]);
  assert.deepEqual(sqlite.prepare('SELECT key FROM system_settings').all(), [{ key: 'module.demo.enabled' }]);
  assert.deepEqual(sqlite.prepare('SELECT entity_type AS t FROM events').all(), [{ t: 'server' }]);
  sqlite.close();
});
