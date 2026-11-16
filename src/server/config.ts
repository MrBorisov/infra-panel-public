import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '127.0.0.1',
  dataDir: env.DATA_DIR ?? './data',
  encryptionKey: env.ENCRYPTION_KEY ?? '',
  appName: env.APP_NAME ?? 'Infra Panel',
  publicUrl: (env.PUBLIC_URL ?? '').replace(/\/$/, ''),
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
  sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 24 * 7),
  monitor: {
    enabled: env.MONITOR_ENABLED !== 'false',
    intervalSec: Number(env.CHECK_INTERVAL_SEC ?? 60),
    failThreshold: Number(env.FAIL_THRESHOLD ?? 2),
    retentionDays: Number(env.CHECKS_RETENTION_DAYS ?? 30),
    // Проверять внутренние адреса (127.0.0.1, 10.x, 192.168.x…). Только если все пользователи
    // свои: иначе мониторинг — окно во внутреннюю сеть сервера (monitor/netguard.ts)
    allowPrivate: env.MONITOR_ALLOW_PRIVATE === 'true',
  },
  // Мост к ботам на зарубежной VDS : боты забирают очереди сами
  bots: {
    discordToken: env.BOT_API_TOKEN ?? '',
    telegramToken: env.TG_BOT_API_TOKEN ?? '',
    telegramBotUsername: (env.TELEGRAM_BOT_USERNAME ?? '').replace(/^@/, ''),
    telegramLinkTtlMin: Number(env.TG_LINK_TOKEN_EXPIRE_MIN ?? 15),
    // С каких адресов принимать мост (IP VDS через запятую). Пусто — с любых: мост отдаёт
    // расшифрованные токены ботов, и утёкший секрет без этого списка работает откуда угодно
    allowedIps: (env.BOT_ALLOWED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  },
};
