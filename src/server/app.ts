import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerAuth } from './auth.js';
import { HttpError } from './errors.js';
import { installModules, setModulesLogger, type ServerModule } from './modules.js';
import { authRoutes } from './routes/auth.js';
import { credentialRoutes } from './routes/credentials.js';
import { entityRoutes } from './routes/entities.js';
import { monitorRoutes } from './routes/monitor.js';
import { notificationRoutes } from './routes/notifications.js';
import { systemRoutes } from './routes/system.js';
import { toolRoutes } from './routes/tools.js';
import { userRoutes } from './routes/users.js';
import { workspaceRoutes } from './routes/workspaces.js';

/**
 * Приложение с подключёнными модулями. Список модулей приходит снаружи (src/modules/server.ts
 * в index.ts, свой набор в тестах): ядро модули не импортирует и без них работает
 */
export async function buildApp({ modules }: { modules: ServerModule[] }) {
  installModules(modules);
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Доверяем только прокси с локальных адресов (nginx на этой машине, Caddy в сети Docker).
    // С `true` IP клиента брался из самого левого адреса X-Forwarded-For, а его клиент
    // подставляет сам — так обходилось ограничение попыток входа и подделывался IP в журнале.
    trustProxy: ['loopback', 'uniquelocal'],
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Картинки модулей с внешних серверов — из их описания
        imgSrc: ["'self'", 'data:', ...modules.flatMap((m) => m.imgSrc ?? [])],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, { global: false });

  setModulesLogger(app.log);
  registerAuth(app);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {};
      for (const issue of err.issues) fields[issue.path.join('.')] ??= issue.message;
      const first = err.issues[0];
      return reply.code(400).send({ error: first ? `${first.path.join('.') || 'Данные'}: ${first.message}` : 'Ошибка проверки', fields });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    const e = err as Error & { code?: string; statusCode?: number };
    if (e.code?.startsWith('SQLITE_CONSTRAINT_UNIQUE')) return reply.code(400).send({ error: 'Такая запись уже существует' });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    req.log.error({ err }, 'Необработанная ошибка');
    return reply.code(500).send({ error: 'Внутренняя ошибка сервера' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  authRoutes(app);
  userRoutes(app);
  workspaceRoutes(app);
  entityRoutes(app);
  credentialRoutes(app);
  monitorRoutes(app);
  notificationRoutes(app);
  systemRoutes(app);
  toolRoutes(app);
  registerModuleRoutes(app, modules);

  // Собранный фронтенд + SPA-фолбэк на index.html
  const webDir = path.resolve('./dist/web');
  const hasWeb = existsSync(path.join(webDir, 'index.html'));
  if (hasWeb) await app.register(fastifyStatic, { root: webDir, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !hasWeb || req.method !== 'GET') {
      return reply.code(404).send({ error: 'Не найдено' });
    }
    return reply.sendFile('index.html');
  });

  return app;
}

/** Маршруты модуля — только в его пространстве имён /api/<id>/: так он не перекроет пути ядра */
function registerModuleRoutes(app: FastifyInstance, modules: ServerModule[]) {
  let current: ServerModule | null = null;
  app.addHook('onRoute', (route) => {
    if (current && !route.url.startsWith(`/api/${current.id}/`)) {
      throw new Error(`Модуль ${current.id}: маршрут ${route.url} вне /api/${current.id}/`);
    }
  });
  for (const m of modules) {
    current = m;
    m.routes(app);
  }
  current = null;
}
