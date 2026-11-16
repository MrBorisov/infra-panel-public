import net from 'node:net';
import { z } from 'zod';
import { HttpError } from './errors.js';

// Пустая строка и null означают «очистить поле»; отсутствующий ключ — «не задано»
const empty = z.union([z.null(), z.literal('')]);
const clearable = <T extends z.ZodType>(t: T) =>
  z.union([t, empty]).transform((v) => (v === '' ? null : (v as z.output<T> | null)));

const optStr = (max = 500) => clearable(z.string().trim().max(max)).optional();

export const reqStr = (max = 200) => z.string().trim().min(1, 'Обязательное поле').max(max);

export const idParam = z.object({ id: z.coerce.number().int().positive() });

const optNum = clearable(z.number().finite().nonnegative()).optional();
const optId = clearable(z.number().int().positive()).optional();
const optDate = clearable(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты YYYY-MM-DD')).optional();

const optUrl = clearable(z.string().trim().max(2000))
  .transform((v) => (v ? normalizeUrl(v) : null))
  .refine((v) => v === null || isHttpUrl(v), 'Некорректная ссылка')
  .optional();

export const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Код валюты из 3 букв');
export const billingPeriod = z.enum(['month', 'year']);

export function normalizeUrl(v: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
}

function isHttpUrl(v: string) {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Хост и пользователь для команды ssh, которую копируют в терминал: без пробелов, кавычек и
// символов оболочки, не с «-». Иначе адрес «h; curl …|sh» выполнился бы у того, кто скопировал,
// а «-oProxyCommand=…» стал бы опцией ssh
const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?';
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*\\.?$`, 'u');
const SSH_USER_RE = /^[A-Za-z0-9._+@][A-Za-z0-9._+@-]{0,99}$/;

const isIp = (v: string) => net.isIP(v.replace(/^\[(.*)\]$/, '$1')) !== 0;
const isHostname = (v: string) => v.length <= 253 && HOSTNAME_RE.test(v);

/** Адрес и логин доступа SSH/SFTP: из них собирается команда для копирования */
export function assertSshFields(kind: string, address: string | null | undefined, username: string | null | undefined) {
  if (kind !== 'ssh' && kind !== 'sftp') return;
  if (address && !isIp(address) && !isHostname(address)) {
    throw new HttpError(400, 'Адрес для SSH — имя хоста или IP, без пробелов и символов вроде ; | $ `');
  }
  if (username && !SSH_USER_RE.test(username)) {
    throw new HttpError(400, 'Логин для SSH — латиница, цифры и . _ - + @, не с дефиса');
  }
}

export function normalizeDomain(v: string) {
  return v
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
}

export const entitySchemas = {
  accounts: z.object({
    name: reqStr(),
    provider: optStr(100),
    url: optUrl,
    notes: optStr(5000),
  }),
  servers: z.object({
    name: reqStr(),
    description: optStr(2000),
    accountId: optId,
    // Запасной хост для команды ssh — те же правила, что у адреса доступа
    ip: optStr(100).refine((v) => !v || isIp(v), 'Нужен IP-адрес: 1.2.3.4 или 2001:db8::1'),
    hostname: optStr(255).refine((v) => !v || isHostname(v), 'Некорректное имя хоста'),
    os: optStr(100),
    location: optStr(100),
    plan: optStr(200),
    price: optNum,
    currency: currency.default('RUB'),
    billingPeriod: billingPeriod.default('month'),
    paidUntil: optDate,
    monitorEnabled: z.boolean().default(true),
    monitorPort: z.number().int().min(1).max(65535).default(22),
    notes: optStr(5000),
  }),
  hostings: z.object({
    name: reqStr(),
    accountId: optId,
    plan: optStr(200),
    price: optNum,
    currency: currency.default('RUB'),
    billingPeriod: billingPeriod.default('month'),
    paidUntil: optDate,
    notes: optStr(5000),
  }),
  domains: z.object({
    name: reqStr(253)
      .transform(normalizeDomain)
      .refine((v) => /^([\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,}$/u.test(v), 'Некорректное имя домена'),
    registrarAccountId: optId,
    dnsAccountId: optId,
    expiresAt: optDate,
    autoRenew: z.boolean().default(false),
    price: optNum,
    currency: currency.default('RUB'),
    billingPeriod: billingPeriod.default('year'),
    autoLookup: z.boolean().default(true),
    notes: optStr(5000),
  }),
  sites: z.object({
    name: reqStr(),
    url: z
      .string()
      .trim()
      .min(1, 'Обязательное поле')
      .transform(normalizeUrl)
      .refine(isHttpUrl, 'Некорректная ссылка'),
    domainId: optId,
    serverId: optId,
    hostingId: optId,
    stack: optStr(200),
    path: optStr(500),
    keyword: optStr(200),
    monitorEnabled: z.boolean().default(true),
    notes: optStr(5000),
  }),
} as const;

export type EntityPath = keyof typeof entitySchemas;

const credentialKinds = ['panel', 'ssh', 'sftp', 'ftp', 'admin', 'db', 'email', 'api', 'other'] as const;
export const credentialEntityTypes = ['account', 'server', 'hosting', 'domain', 'site'] as const;

export const credentialSchema = z.object({
  entityType: z.enum(credentialEntityTypes),
  entityId: z.number().int().positive(),
  kind: z.enum(credentialKinds),
  title: optStr(200),
  address: optStr(500),
  port: clearable(z.number().int().min(1).max(65535)).optional(),
  username: optStr(200),
  secret: z.string().max(20000).optional(),
  clearSecret: z.boolean().optional(),
  passworkUrl: optUrl,
  notes: optStr(5000),
});

/** Разбор PATCH: валидируем только переданные поля, дефолты не подставляем */
export function parsePatch<T extends z.ZodObject>(schema: T, body: unknown): Partial<z.infer<T>> {
  if (!body || typeof body !== 'object') return {};
  const keys = Object.keys(body).filter((k) => k in schema.shape);
  const parsed = schema.partial().parse(body) as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, parsed[k]])) as Partial<z.infer<T>>;
}
