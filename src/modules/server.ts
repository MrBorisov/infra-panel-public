import type { ServerModule } from '../server/modules.js';

/**
 * Модули, подключённые к серверу. Подключить модуль — импортировать его описание и добавить в список;
 * убрать — убрать строку (и его папку): ядро соберётся и заработает без него. Миграции — общие в drizzle/
 */
export const serverModules: ServerModule[] = [];
