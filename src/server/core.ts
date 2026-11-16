/**
 * API ядра для модулей. Модуль берёт из ядра только это (и таблицы из db/schema.ts): так видно,
 * на что он опирается. Границу проверяет tests/boundary.test.ts
 */
export { audit } from './audit.js';
export { createSession, hasModuleLevel, requireModule, userWorkspaces, wsId } from './auth.js';
export { config } from './config.js';
export { decrypt, encrypt, randomToken, sha256 } from './crypto.js';
export { db, schema } from './db/index.js';
export { HttpError, notFound } from './errors.js';
export { moduleOn, moduleWorkspaceIds, type ModuleTopic, type ServerModule } from './modules.js';
export { recordEvent, type Notice } from './notify.js';
export { countByWorkspace, countRows, recentEvents } from './queries.js';
export { acceptInvite, createWorkspace, findInvite, isMember, registerUser } from './workspaces.js';
