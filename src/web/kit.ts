/**
 * API ядра для модулей интерфейса: модуль берёт из ядра только это (и типы из src/shared).
 * Границу проверяет tests/boundary.test.ts
 */
export { api, ApiError } from './api';
export { useAuth } from './auth';
export { NotFound, PageLoader } from './components/PageState';
export { fmtDate, fmtDateTime, fromNow } from './format';
export type { WebModule } from './modules';
