import { recordEvent, requireModule, wsId, type ServerModule } from '../../src/server/core.js';

/**
 * Демо-модуль для тестов ядра: ядро проверяется на нём, а не на настоящем модуле, — тогда тесты ядра не
 * зависят от того, какие модули подключены. Импортирует ядро только через core.ts, как настоящий.
 * Грузится из helpers после настройки окружения
 */
/** Что тест может переключить: доступность (как ключи в .env), падение в фоновом хуке */
export const demoState = { available: true, cleanups: 0, failCleanup: false };

export const demoModule: ServerModule = {
  id: 'demo',
  title: 'Демо',
  description: 'Модуль для тестов ядра',
  levels: ['none', 'view', 'manage'],
  available: () => demoState.available,
  unavailableReason: 'Демо недоступно',
  topics: [
    { key: 'demo.alert', label: 'Тревоги демо', emoji: '🧪', channelDefault: true },
    { key: 'demo.info', label: 'Новости демо' },
  ],
  eventTypes: ['demo_thing'],
  publicPaths: ['/api/demo/public'],
  userPaths: ['/api/demo/me'],
  imgSrc: ['https://img.demo.test'],
  routes(app) {
    app.get('/api/demo/public', async () => ({ ok: true }));
    app.get('/api/demo/me', async (req) => ({ userId: req.user!.id }));
    app.get('/api/demo/data', { preHandler: requireModule('demo', 'view') }, async (req) => ({ workspaceId: wsId(req) }));
    app.post('/api/demo/manage', { preHandler: requireModule('demo', 'manage', 'Нужно право управления демо') }, async (req) => {
      recordEvent(wsId(req), 'demo_thing', 1, 'made', 'Демо-событие');
      return { ok: true };
    });
  },
  cleanup() {
    demoState.cleanups++;
    if (demoState.failCleanup) throw new Error('демо: уборка упала');
  },
  loginProvider: { label: 'Войти через демо', url: '/api/demo/public' },
  admin: {
    counter: { label: 'Штуки', count: () => new Map([[1, 7]]) },
    offWarning: () => 'Демо-пользователи не войдут',
  },
};
