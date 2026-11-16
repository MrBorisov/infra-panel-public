import type { WebModule } from '../web/modules';

/**
 * Модули, подключённые к интерфейсу, — те же, что в src/modules/server.ts. Подключить модуль — добавить
 * его описание в список, убрать — убрать строку (и его папку): интерфейс соберётся и заработает без него
 */
export const webModules: WebModule[] = [];
