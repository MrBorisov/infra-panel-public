import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  // Таблицы ядра и модулей; цепочка миграций одна — drizzle/
  schema: ['./src/server/db/schema.ts', './src/modules/*/server/schema.ts'],
  out: './drizzle',
});
