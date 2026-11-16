import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { infraEditor } from '../auth.js';
import { isForbiddenAddress, resolveAll } from '../monitor/netguard.js';
import { normalizeDomain } from '../validation.js';

export function toolRoutes(app: FastifyInstance) {
  // Для автозаполнения в формах: IP по hostname, сервер по адресу сайта. Внутренние адреса не
  // отдаём: наружу им незачем. Поиск — тот же, что у мониторинга (resolveAll): без пула потоков
  app.get('/api/tools/resolve', infraEditor, async (req) => {
    const { host } = z.object({ host: z.string().trim().min(1).max(253) }).parse(req.query);
    const name = normalizeDomain(host);
    const records = await resolveAll(name);
    return { host: name, addresses: [...new Set(records.map((r) => r.address))].filter((a) => !isForbiddenAddress(a)) };
  });
}
