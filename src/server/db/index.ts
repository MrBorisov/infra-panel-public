import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import * as schema from './schema.js';

mkdirSync(config.dataDir, { recursive: true });

export const sqlite = new Database(path.join(config.dataDir, 'panel.db'));
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });

/**
 * Миграции идут с выключенными внешними ключами: пересборка таблицы (CREATE __new → DROP →
 * RENAME) с включёнными ключами выполнила бы ON DELETE у ссылающихся таблиц. Внутри
 * транзакции мигратора PRAGMA не действует, поэтому выключаем снаружи и проверяем после.
 */
export function runMigrations() {
  sqlite.pragma('foreign_keys = OFF');
  try {
    migrate(db, { migrationsFolder: path.resolve('./drizzle') });
    const broken = sqlite.pragma('foreign_key_check') as unknown[];
    if (broken.length) throw new Error(`После миграций нарушены внешние ключи: ${JSON.stringify(broken.slice(0, 5))}`);
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
}

export { schema };
