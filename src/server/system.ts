import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';

/** Системная настройка из интерфейса администратора; null — не задана */
export function getSetting(key: string) {
  return db.select({ value: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, key)).get()?.value ?? null;
}

export function setSetting(key: string, value: string) {
  db.insert(schema.systemSettings).values({ key, value }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value } }).run();
}
