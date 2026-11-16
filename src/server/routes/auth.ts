import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AuthProvider } from '../../shared/types.js';
import { audit } from '../audit.js';
import { createSession, destroySession, destroyUserSessions, toSessionUser, updateUser, userWorkspaces } from '../auth.js';
import { config } from '../config.js';
import { decrypt, encrypt, hashPassword, randomToken, verifyPassword } from '../crypto.js';
import { db, schema } from '../db/index.js';
import { HttpError } from '../errors.js';
import { activeModules } from '../modules.js';
import { enqueueTelegramDirect } from '../notify.js';

const loginLimit = { rateLimit: { max: 10, timeWindow: '15 minutes' } };
// Пароль при входе в сессию (смена пароля, отключение 2FA) — счётчик на пользователя: укравший
// сессию иначе перебирал бы пароль, меняя IP
const sessionPasswordLimit = { rateLimit: { ...loginLimit.rateLimit, keyGenerator: (req: FastifyRequest) => `pw:${req.user?.id ?? req.ip}` } };

export const passwordSchema = z.string().min(10, 'Пароль не короче 10 символов').max(200);

let dummyHash: Promise<string> | null = null;

// Перебор кода 2FA: лимит по IP обходится пулом прокси, поэтому считаем неудачи на пользователя
const TOTP_MAX_FAILURES = 5;
const TOTP_LOCK_MS = 15 * 60_000;

type User = typeof schema.users.$inferSelect;

function makeTotp(label: string, secretBase32: string) {
  return new TOTP({
    issuer: config.appName,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

/**
 * Принять код 2FA: верный и ещё не использованный. Шаг принятого кода запоминаем — иначе
 * подсмотренный или перехваченный код годился бы ещё ~90 секунд.
 */
function acceptTotp(user: User, code: string) {
  if (!user.totpSecretEnc) return false;
  const totp = makeTotp(user.email ?? user.name, decrypt(user.totpSecretEnc));
  const delta = totp.validate({ token: code.replace(/\s/g, ''), window: 1 });
  if (delta === null) return false;
  const step = totp.counter() + delta;
  if (user.totpLastStep !== null && step <= user.totpLastStep) return false;
  updateUser(user.id, { totpLastStep: step, totpFailures: 0, totpFailedAt: null });
  return true;
}

const totpLocked = (user: User) =>
  user.totpFailures >= TOTP_MAX_FAILURES && !!user.totpFailedAt && Date.now() - user.totpFailedAt < TOTP_LOCK_MS;

function getUser(id: number) {
  const user = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!user) throw new HttpError(404, 'Пользователь не найден');
  return user;
}

export function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', { config: loginLimit }, async (req, reply) => {
    const body = z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).parse(req.body);
    const user = db.select().from(schema.users).where(eq(schema.users.email, body.email)).get();

    // Даже для несуществующего пользователя считаем хеш, чтобы время ответа не выдавало email.
    // Хеш от случайной строки, и без своего пароля вход не пройдёт: иначе к пользователю с email,
    // но без пароля входили бы известным «паролем заглушки»
    dummyHash ??= hashPassword(randomToken());
    const ok = await verifyPassword(body.password, user?.passwordHash ?? (await dummyHash));

    if (!user || !user.passwordHash || !ok || user.disabled) {
      audit(req, 'login.failed', { details: body.email, userId: user?.id, userEmail: body.email, system: true });
      throw new HttpError(401, 'Неверный email или пароль');
    }

    if (user.totpEnabled) {
      createSession(reply, req, user.id, true);
      return { mfaRequired: true };
    }

    createSession(reply, req, user.id, false);
    audit(req, 'login', { userId: user.id, userEmail: user.email, system: true });
    return { user: toSessionUser(user) };
  });

  app.post('/api/auth/totp', { config: loginLimit }, async (req, reply) => {
    const { code } = z.object({ code: z.string().min(6).max(10) }).parse(req.body);
    const user = getUser(req.user!.id);
    if (totpLocked(user)) throw new HttpError(429, 'Слишком много неверных кодов — вход закрыт на 15 минут');
    if (!acceptTotp(user, code)) {
      const fresh = !user.totpFailedAt || Date.now() - user.totpFailedAt >= TOTP_LOCK_MS;
      const failures = fresh ? 1 : user.totpFailures + 1;
      updateUser(user.id, { totpFailures: failures, totpFailedAt: Date.now() });
      audit(req, 'login.totp_failed', { system: true });
      if (failures < TOTP_MAX_FAILURES) throw new HttpError(401, 'Неверный код');
      // Пароль, похоже, знает кто-то ещё: закрываем полувход и говорим владельцу
      destroySession(req, reply);
      audit(req, 'login.totp_locked', { system: true });
      if (user.telegramUserId) {
        enqueueTelegramDirect(
          user.telegramUserId,
          `⚠️ ${config.appName}: ${TOTP_MAX_FAILURES} неверных кодов 2FA подряд, вход закрыт на 15 минут. Если это не вы — ваш пароль известен кому-то ещё, смените его.`,
        );
      }
      throw new HttpError(429, 'Слишком много неверных кодов — вход закрыт на 15 минут');
    }
    // Меняем сессию целиком, чтобы токен «полувхода» не стал полноценным
    destroySession(req, reply);
    createSession(reply, req, user.id, false);
    audit(req, 'login', { system: true });
    return { user: toSessionUser(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession(req, reply);
    return { ok: true };
  });

  // Кнопки входа через модули для страницы входа — до входа, поэтому публично
  app.get('/api/auth/providers', async (): Promise<AuthProvider[]> =>
    activeModules().flatMap((m) => (m.loginProvider ? [{ id: m.id, ...m.loginProvider }] : [])),
  );

  app.get('/api/me', async (req) => ({ user: req.user, workspaces: userWorkspaces(req.user!.id), current: req.ws }));

  app.post('/api/me/password', { config: sessionPasswordLimit }, async (req) => {
    const body = z.object({ current: z.string(), next: passwordSchema }).parse(req.body);
    const user = getUser(req.user!.id);
    if (!user.passwordHash) throw new HttpError(400, 'У вас вход без пароля — пароль не используется');
    if (!(await verifyPassword(body.current, user.passwordHash))) throw new HttpError(400, 'Текущий пароль неверен');
    updateUser(user.id, { passwordHash: await hashPassword(body.next) });
    destroyUserSessions(user.id, req.sessionId);
    audit(req, 'user.password_changed', { entityType: 'user', entityId: user.id, system: true });
    return { ok: true };
  });

  app.post('/api/me/totp/setup', async (req) => {
    const user = getUser(req.user!.id);
    if (user.totpEnabled) throw new HttpError(400, '2FA уже включена');
    const secret = new Secret({ size: 20 }).base32;
    updateUser(user.id, { totpSecretEnc: encrypt(secret) });
    const uri = makeTotp(user.email ?? user.name, secret).toString();
    return { uri, secret, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  });

  app.post('/api/me/totp/enable', async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.body);
    const user = getUser(req.user!.id);
    if (!acceptTotp(user, code)) throw new HttpError(400, 'Неверный код, попробуйте ещё раз');
    updateUser(user.id, { totpEnabled: true });
    // Другие сессии вошли без второго фактора — завершаем, пусть войдут с кодом
    destroyUserSessions(user.id, req.sessionId);
    audit(req, 'user.totp_enabled', { entityType: 'user', entityId: user.id, system: true });
    return { ok: true };
  });

  app.post('/api/me/totp/disable', { config: sessionPasswordLimit }, async (req) => {
    // Без пароля (вход через модуль) подтверждаем текущим кодом 2FA
    const { password, code } = z.object({ password: z.string().optional(), code: z.string().optional() }).parse(req.body);
    const user = getUser(req.user!.id);
    const confirmed = user.passwordHash ? !!password && (await verifyPassword(password, user.passwordHash)) : !!code && acceptTotp(user, code);
    if (!confirmed) throw new HttpError(400, user.passwordHash ? 'Неверный пароль' : 'Неверный код');
    updateUser(user.id, { totpEnabled: false, totpSecretEnc: null });
    audit(req, 'user.totp_disabled', { entityType: 'user', entityId: user.id, system: true });
    return { ok: true };
  });
}
