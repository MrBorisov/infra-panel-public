import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', default: 'admin' },
    password: { type: 'string' },
    'reset-2fa': { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

const usage = `Команды:
  gen-key                                         сгенерировать ENCRYPTION_KEY
  create-user --email E --name N [--role admin|user] [--password P]
  reset-password --email E [--password P] [--reset-2fa]
  list-users
  backup [--out путь]                             резервная копия базы (по умолчанию data/backups/)`;

if (command === 'gen-key') {
  console.log(randomBytes(32).toString('base64'));
  process.exit(0);
}

// Подключаем базу только для команд, которым она нужна (gen-key работает без .env)
const { db, runMigrations, schema, sqlite } = await import('./db/index.js');
const { generatePassword, hashPassword } = await import('./crypto.js');
const { destroyUserSessions } = await import('./auth.js');
// Бэкап базу не меняет: иначе «бэкап перед миграциями» снимался бы уже после них
if (command !== 'backup') runMigrations();

const email = values.email?.trim().toLowerCase();

switch (command) {
  case 'create-user': {
    if (!email || !values.name) throw new Error('Нужны --email и --name');
    const role = values.role as 'admin' | 'user';
    if (!['admin', 'user'].includes(role)) throw new Error('Роль: admin (администратор системы) или user');
    const password = values.password ?? generatePassword();
    const user = db
      .insert(schema.users)
      .values({ email, name: values.name, role, passwordHash: await hashPassword(password) })
      .returning()
      .get();
    // На свежей установке «Основное» пустует — первый пользователь становится его владельцем,
    // остальные получают своё пространство
    const { createWorkspace, orphanWorkspace } = await import('./workspaces.js');
    const orphan = orphanWorkspace();
    if (orphan) {
      db.insert(schema.workspaceMembers)
        .values({ workspaceId: orphan.id, userId: user.id, isOwner: true, infraAccess: 'edit', canManageMembers: true })
        .run();
      db.update(schema.users).set({ lastWorkspaceId: orphan.id }).where(eq(schema.users.id, user.id)).run();
    } else {
      createWorkspace(`Пространство ${user.name}`, user.id);
    }
    console.log(`Пользователь создан: ${email} (${role})\nПароль: ${password}`);
    break;
  }
  case 'reset-password': {
    if (!email) throw new Error('Нужен --email');
    const user = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
    if (!user) throw new Error('Пользователь не найден');
    const password = values.password ?? generatePassword();
    db.update(schema.users)
      .set({
        passwordHash: await hashPassword(password),
        disabled: false,
        ...(values['reset-2fa'] ? { totpEnabled: false, totpSecretEnc: null } : {}),
      })
      .where(eq(schema.users.id, user.id))
      .run();
    destroyUserSessions(user.id);
    console.log(`Новый пароль для ${email}: ${password}${values['reset-2fa'] ? '\n2FA сброшена' : ''}`);
    break;
  }
  case 'list-users': {
    for (const u of db.select().from(schema.users).all()) {
      console.log(`${u.id}\t${u.email ?? `(без пароля) ${u.name}`}\t${u.role}\t2FA:${u.totpEnabled ? 'да' : 'нет'}${u.disabled ? '\tотключён' : ''}`);
    }
    break;
  }
  case 'backup': {
    // Онлайн-бэкап SQLite: безопасно делать, пока панель работает
    const { mkdirSync } = await import('node:fs');
    const path = await import('node:path');
    const { config } = await import('./config.js');
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const out = values.out ?? path.join(config.dataDir, 'backups', `panel-${stamp}.db`);
    mkdirSync(path.dirname(out), { recursive: true });
    await sqlite.backup(out);
    console.log(`Бэкап сохранён: ${out}\nПароли в нём зашифрованы: для восстановления нужен тот же ENCRYPTION_KEY`);
    break;
  }
  default:
    console.log(usage);
}
