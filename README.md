# Infra Panel

A self-hosted panel for keeping track of your infrastructure. It stores VPSes, web hosting, sites, domains, provider accounts and the credentials for them. It watches server and site availability, plus domain, SSL certificate and payment due dates. Alerts go to Telegram and Discord. Every user has their own workspace and can share access to it.

> The user interface, the alert texts and the code comments are in Russian. UI labels below are given in English with the original Russian label in quotes, e.g. Settings («Настройки»).

## Features

- **Objects and links.** Provider account (registrar, VPS, hosting, DNS) → server / hosting / domain → site. A site card shows its domain and server or hosting, a domain card shows its registrar and DNS, a server card shows the sites on it.
- **Credentials.** Logins, passwords, SSH keys and API tokens can be attached to any object. Passwords are stored encrypted in the database (AES-256-GCM). A ready `ssh -p … user@host` command is copied in one click. Each credential can link to an entry in an external password manager (Passwork).
- **Monitoring.**
  - servers: TCP port check (22 by default);
  - sites: HTTP status, response time and, optionally, a keyword that must be on the page;
  - SSL certificates: expiry date;
  - domains: expiry date via RDAP, and via WHOIS for .ru/.рф/.su.
- **Due dates.** Server and hosting payments, domain and SSL expiry. The "Mark as paid" («Отметить оплату») button moves the date by a month or a year. Reminders arrive 7, 3 and 1 day before and on the day (domains also 30 days before). Overdue items are reminded again: daily for the first week (not before 9 a.m. server time), then weekly, and they stop after a month.
- **Workspaces and delegation.** Every user has their own workspace with servers, sites, domains and passwords. The owner invites others with a one-time link (a newcomer can also sign up with email through it) and grants rights **separately** for the infrastructure (none / view / edit and passwords) and for each installed module, plus the right to manage members. For example, a colleague can see the inventory without seeing server passwords. A member manager cannot grant more rights than they have and cannot appoint other managers.
- **Alerts.** Personal Telegram with chosen topics (after linking, the bot sends a summary of what is down and which dates are close) and workspace channels: your own Telegram bot, your own Discord bot or a Discord webhook. Messages go only to people with rights to the relevant data. See "Alerts" below.
- **Security.** 2FA (TOTP) and an audit log that records every password view. The system administrator manages users but cannot enter other people's workspaces. Workspace isolation is covered by tests (`npm test`).
- **Quick entry.** The form opens from the header, from search (`⌘K` / `Ctrl+K` / `/`) and from related lists on a card. A related object can be created straight from a dropdown ("+ Create"), and login and password are entered in the same form. Autofill: site URL → name, domain and server (via DNS), hostname → IP, provider → link to its control panel. "Save and add another" keeps the chosen links and currency. Domains can be pasted as a list: duplicates are marked and expiry dates are fetched automatically.

## Stack

Node.js 24+, TypeScript, Fastify, SQLite (better-sqlite3 + Drizzle), React + Mantine. It runs as a single app with a single database file.

## Deploying with Docker

You need a server with Docker and a domain whose A record points to it.

```bash
git clone https://github.com/MrBorisov/infra-panel-public.git infra-panel && cd infra-panel
cp .env.example .env
openssl rand -base64 32   # put the result into ENCRYPTION_KEY
nano .env                 # DOMAIN, PUBLIC_URL and bots — see "Settings (.env)"
docker compose up -d --build
```

Caddy issues the HTTPS certificate for `DOMAIN` by itself.

First administrator:

```bash
docker compose exec app node dist/server/cli.js create-user --email you@example.com --name "Name" --role admin
```

The command prints a generated password. Sign in, change the password and enable 2FA in Settings («Настройки»). The first user becomes the owner of the "Main" («Основное») workspace, everyone else gets their own. Invite people to your workspace via Members («Участники») → Invite («Пригласить»). With the link a person signs in to their account or creates a new one (email and password) and joins the workspace right away. Without a link, accounts are created by the system administrator (Users, «Пользователи»).

Update:

```bash
git pull && docker compose up -d --build
```

Database migrations are applied automatically on start.

## Deploying next to other sites (without Docker)

If nginx already serves other sites on the server, the Docker setup does not fit: Caddy would take ports 80 and 443. For this case there is `scripts/deploy.sh`: its own Node 24 in `/opt/panel/node` (the system Node is left alone), a `panel` user, a service on `127.0.0.1:8090`, an nginx site, a certbot certificate and a nightly backup.

You need nginx, certbot, `build-essential`, `python3` and the domain's A record pointing to the server. Run it on the server as your own user with sudo (not as root and not as `panel`):

```bash
scp scripts/deploy.sh <server>:/tmp/panel-deploy.sh   # from your machine
PANEL_DOMAIN=panel.example.com PANEL_GIT_URL=https://github.com/MrBorisov/infra-panel-public.git bash /tmp/panel-deploy.sh install   # on the server
```

`PANEL_DOMAIN` (the panel's domain) is always required, `PANEL_GIT_URL` (where to clone from: this repository or your fork) is needed for install. Port, user and directory are `PANEL_*` variables too, see the script header. Pass the `PANEL_*` values you used at install on every deploy as well.

The script creates the `panel` user, a deploy key and a `.env` with a fresh `ENCRYPTION_KEY`. For a private repository it prints the public key: add it to the repository's Deploy keys (read-only) and press Enter. Then it clones the code, builds and starts the panel, gets the certificate and asks for the first administrator's email and name.

### Deploy and rollback

Deploys run on the server, as your own user with sudo. First the plan, then the deploy itself:

```bash
PANEL_DOMAIN=panel.example.com bash /opt/panel/app/scripts/deploy.sh --dry-run
PANEL_DOMAIN=panel.example.com bash /opt/panel/app/scripts/deploy.sh
```

The script pulls `master`, shows the plan, asks `[y/N]` and decides what to do from the changed files: docs only — nothing; `src/web/` — build without restart; migrations in `drizzle/` — a `pre-deploy-*.db` backup first; `package-lock.json` — `npm ci`; anything else — build and restart. If `deploy.sh` itself changed, the systemd units are rewritten and the old ones are kept next to them as `*.prev`. After the deploy it runs checks (unit active, `/api/health`, home page, `/api/me` without a session → 401).

To see whether a deploy finished, check that the last log line names the new commit: from outside an unfinished deploy is invisible, the old panel keeps working.

```bash
tail -n 3 /opt/panel/app/.git/panel_deploy.log
```

If a step failed before the restart, the service still runs the previous code: fix the cause and run the script again. Failure reasons are in `sudo journalctl -u panel -n 50`.

- **The service did not come up after the units changed:** `sudo cp /etc/systemd/system/panel.service.prev /etc/systemd/system/panel.service && sudo systemctl daemon-reload && sudo systemctl restart panel`.
- **Monitoring says it cannot resolve the address of every site.** The unit blocks private networks for the panel (`IPAddressDeny`) and allows a DNS server from a private network only if it was in `/etc/resolv.conf` when the unit was written. If you changed DNS, add `IPAddressAllow=<address>` to the unit and restart. With `MONITOR_ALLOW_PRIVATE=true` there is no block.
- **Rolling back code without migrations** — `git revert` the bad commit, push, deploy as usual. **With migrations** it is usually better to fix forward with a new commit. If the database must be restored: stop `panel`, restore that deploy's `pre-deploy-*.db` (see "Backups"), then `git revert`, push and deploy. Do not start the panel between restoring the database and deploying: the code on disk is still new and would apply the migrations to the old database again. Data written after the deploy is lost.

## Settings (.env)

Format: one variable per line, `KEY=value`. Quotes are optional: `KEY="value"` and `KEY=value` work the same. Spaces around `=` and at the ends of the value are trimmed.

**`#` starts a comment even without a space before it:** `SECRET=abc#def` is read as `abc`. Put values containing `#` in double quotes: `SECRET="abc#def"`.

After editing: `sudo systemctl restart panel` (or `docker compose up -d`).

| Variable | Meaning |
|---|---|
| `DOMAIN` | Docker only: the domain Caddy gets a certificate for |
| `PUBLIC_URL` | The panel's address, used in links in alerts and invites |
| `ENCRYPTION_KEY` | Key for encrypting passwords and tokens (`openssl rand -base64 32`). **Lose it and the passwords cannot be decrypted.** Keep a copy away from the server |
| `PORT`, `HOST`, `DATA_DIR` | Where to listen and where the database lives: `127.0.0.1:3000` and `./data` by default; the deploy script sets `127.0.0.1:8090` and `/opt/panel/data` |
| `APP_NAME` | Name shown in alerts and in the 2FA app |
| `CHECK_INTERVAL_SEC`, `FAIL_THRESHOLD` | How often to check servers and sites, and after how many failures in a row to consider them down (60 and 2) |
| `CHECKS_RETENTION_DAYS` | How long to keep check history (30) |
| `SESSION_TTL_HOURS` | Session lifetime (168 = a week) |
| `NODE_ENV`, `COOKIE_SECURE` | `NODE_ENV=production` (set by the Dockerfile and `deploy.sh`) turns on a `Secure` cookie named `__Host-sid`: sign-in works over HTTPS only. `COOKIE_SECURE=true`/`false` sets this explicitly |
| `LOG_LEVEL` | Log level (`info`) |
| `BOT_API_TOKEN` | Bridge secret for the Discord poller on the VDS (`openssl rand -hex 32`) |
| `TG_BOT_API_TOKEN` | Bridge secret for the Telegram bot on the VDS |
| `TELEGRAM_BOT_USERNAME` | Username of the panel's bot that users link their personal Telegram to |
| `TG_LINK_TOKEN_EXPIRE_MIN` | How many minutes a Telegram link stays valid (15) |
| `BOT_ALLOWED_IPS` | Comma-separated IPs of the bot VDS: the `/api/v1/*` bridge accepts requests only from them. Empty — from anywhere (then a leaked bridge secret works from anywhere, and the bridge hands out decrypted bot tokens) |
| `MONITOR_ENABLED` | `false` turns monitoring off (for development) |
| `MONITOR_ALLOW_PRIVATE` | `true` allows checking internal addresses (127.0.0.1, 10.x, 192.168.x…). Off by default: otherwise any user could look into the server's internal network through monitoring. Turn it on only if all users are trusted |

## Alerts (Telegram and Discord)

The panel sends nothing itself: it was built for a hosting location where the Telegram and Discord APIs are blocked. Messages wait in a queue; relay bots on a VDS abroad fetch them through the `/api/v1/*` bridge and send them, including on behalf of users' own bots. Installing the bots and the bridge secrets in the panel's `.env` — [bots/README.md](bots/README.md). If your server can reach Telegram and Discord directly, the bots can run on the same server.

**How to connect** (Alerts, «Оповещения»):
- **Personal Telegram** — "Link Telegram" («Привязать Telegram») → Start in the bot. A test message arrives, and if something is down or dates are close, a summary too.
- **Discord webhook** — in Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL. In the panel: "Add channel" → "Discord webhook", topics, then "Test message".
- **Your own Discord bot** — a token from [discord.com/developers](https://discord.com/developers/applications) (Bot → Reset Token), the bot invited to the server with View Channel, Send Messages and Embed Links; the channel ID — enable developer mode in Discord and use "Copy ID" on the channel. The bot shows as offline in Discord: it only sends.
- **Your own Telegram bot in a group or channel** — a token from @BotFather and a Chat ID: add the bot to the group (to a channel as an admin) and forward a message from there to @getidsbot; a public channel can use `@name`.

Workspace channels can be added by the owner and by members with "Edit and passwords" on the infrastructure or the right to manage a module. A channel's topics cannot be wider than the rights of the person setting it up.

## Modules

The panel core is the inventory: users and sign-in, workspaces and members, servers, sites, domains, hosting, accounts and passwords, monitoring, due dates, alerts, audit log. Everything else plugs in as modules on top of the core (`src/modules/<module>/`, registries `src/modules/server.ts` and `src/modules/web.ts`). There are no modules right now. Early migrations contain tables of a removed EVE Online module: `0002`–`0006` create them and `0007_remove_eve` drops them.

- The system administrator turns a module off in Modules («Модули»): for the whole site or for a single workspace. New workspaces get the module enabled. Members' module rights and the module's data are kept while it is off and come back when it is turned on.
- A module can also be removed from the build: delete its line in `src/modules/server.ts` and `src/modules/web.ts` and the `src/modules/<module>/` folder. The core builds and runs without it. The module's tables stay in the database until a separate migration drops them, and users who only signed in through the module cannot sign in without a password.

## Backups

Without Docker, `scripts/deploy.sh` sets up a nightly backup: every night at 03:30 server time the `panel-backup.timer` saves `panel-*.db` to `/opt/panel/data/backups/`, and files older than 30 days are deleted. Before a deploy with migrations, a `pre-deploy-*.db` is saved there as well.

Manual backup:

```bash
sudo -u panel -H bash -c 'cd /opt/panel/app && /opt/panel/node/bin/node dist/server/cli.js backup'
```

Restore (the database runs in WAL mode, so `-wal` and `-shm` are removed):

```bash
sudo systemctl stop panel
sudo -u panel bash -c 'cd /opt/panel/data && mv panel.db panel.db.broken && rm -f panel.db-wal panel.db-shm && cp backups/<file>.db panel.db'
sudo systemctl start panel
```

With Docker there is no nightly backup; take a copy by hand:

```bash
docker compose exec app node dist/server/cli.js backup --out /data/backups/panel.db
docker compose cp app:/data/backups/panel.db ./panel-$(date +%F).db
```

Passwords in the backup are encrypted, so restoring needs the same `ENCRYPTION_KEY`. Keep the key separately from the backups, for example in a password manager.

## Security

- The panel holds access to your whole infrastructure, so enable 2FA for every user.
- If possible, restrict access by IP (there is an example in `Caddyfile`, and a commented one in `/etc/nginx/sites-available/panel` written by `deploy.sh`) or keep the panel behind a VPN.
- Sessions use `HttpOnly` + `Secure` + `SameSite=Lax` cookies. Modifying requests from a foreign `Origin` are rejected. Sign-in attempts are rate-limited, and after 5 wrong 2FA codes sign-in is locked for 15 minutes, with a warning sent to Telegram.
- If the system administrator resets a user's password or 2FA (Users, «Пользователи»), it is written to the audit log of that user's workspaces and sent to them in Telegram.
- A password is revealed only by a button, hidden again after 30 seconds, and every view is logged.
- A member with "View" on the infrastructure sees the inventory but not the passwords. Only "Edit and passwords" sees passwords.

## Development

```bash
npm install
cp .env.example .env      # set ENCRYPTION_KEY: openssl rand -base64 32
npm run cli -- create-user --email admin@local.test --name Admin --role admin
npm run dev   # API on :3000, UI on http://localhost:5173
```

Tests set up their own database in a temp folder, encryption key and bridge secrets (`tests/helpers.ts`; module tests live in `src/modules/<module>/tests/`) and take the rest from the local `.env`: do not put `BOT_ALLOWED_IPS`, `MONITOR_ALLOW_PRIVATE` and the like there. Core tests run against a demo module (`tests/fixtures/demo-module.ts`), and there is a suite with no modules at all (`tests/core-only.test.ts`).

Useful commands:

| Command | What it does |
|---|---|
| `npm run typecheck` | type check |
| `npm run build` | build into `dist/` |
| `npm test` | all tests (`tests/` and `src/modules/*/tests/`) |
| `npm run db:generate` | SQL migration after a schema change (`src/server/db/schema.ts`, `src/modules/*/server/schema.ts`; table rebuilds and data moves are written by hand, see `drizzle/0003_own_bots.sql`; published migrations are never edited) |
| `npm run cli -- list-users` | list users |
| `npm run cli -- reset-password --email E [--reset-2fa]` | reset a password (and 2FA) |

Layout: `src/server/` — core API, `src/web/` — core UI, `src/shared/` — code shared by server and UI, `src/modules/` — modules (empty for now, just the registries), `drizzle/` — migrations, `bots/` — relay bots, `scripts/deploy.sh` — install and deploy without Docker, `tests/` — tests (`node:test`).

The main rule of the code is workspace isolation: every data query is filtered by workspace (`getInWorkspace`/`inWorkspace` in `src/server/queries.ts`), links between objects are checked by `assertRefsInWorkspace`, and a new data route comes with a test in `tests/tenancy.test.ts` showing that another workspace cannot see it.

## What's next

The improvement plan is in [ROADMAP.md](ROADMAP.md). Send changes as pull requests: `npm test` and `npm run typecheck` must pass.

## Who wrote it

All the code, tests and documentation of this project were written by Claude (an Anthropic model) in Claude Code. The project author, MrBorisov, set the tasks, made the decisions, reviewed the work and deployed it to their own server.

## License

© 2026 MrBorisov. Licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-or-later).

In short, in plain words (only the license text is legally binding):

- you may use, study, change and distribute the code however you like, including commercially;
- a modified version that you distribute must be released under the same license, with source code;
- the same applies if you do not distribute the program but let people use it over a network (SaaS, hosting for clients): its users must be able to get the source code of the running version, with all changes;
- there is no warranty.
