# Alert bots (on a VDS abroad)

The panel was built for a hosting location where the Telegram and Discord APIs are blocked, so it sends nothing itself. It puts messages into a queue, and bots on a VDS abroad fetch them through the `/api/v1/bot/*` and `/api/v1/tg/*` bridge and send them, including on behalf of users' own bots (the `bot_token` and `channel_id` fields, see below).

Any small VDS where Telegram and Discord are reachable will do: the bots listen on no ports and only make outgoing requests — to Telegram, Discord and the panel's bridge. If other bots already live there, put these next to them, under a separate user and with separate `.env` files.

## 1. A new Telegram bot

Create a **separate** bot with [@BotFather](https://t.me/BotFather): a token can have only one `getUpdates` consumer, so a bot that already runs somewhere else will not do. Note the token and the username, e.g. `infra_panel_bot`.

## 2. Bridge secrets

Generate two secrets (on any machine):

```bash
openssl rand -hex 32   # BOT_API_TOKEN — for Discord
openssl rand -hex 32   # TG_BOT_API_TOKEN — for Telegram
```

Add to the panel's `.env` on the server (`/opt/panel/app/.env`):

```
BOT_API_TOKEN=<first secret>
TG_BOT_API_TOKEN=<second secret>
TELEGRAM_BOT_USERNAME=infra_panel_bot
BOT_ALLOWED_IPS=<VDS IP>
```

With `BOT_ALLOWED_IPS` the `/api/v1/*` bridge accepts requests only from the VDS: a leaked secret will not work from another address. Then: `sudo systemctl restart panel`.

## 3. Installing on the VDS

```bash
sudo adduser --system --group --home /opt/panel-bots panelbot
sudo mkdir -p /opt/panel-bots && sudo chown panelbot: /opt/panel-bots
# copy bots/telegram-bot.py and bots/discord-poller.py here (scp or git)
sudo -u panelbot python3 -m venv /opt/panel-bots/venv
sudo -u panelbot /opt/panel-bots/venv/bin/pip install httpx
```

`/etc/panel-bots-tg.env`:
```
TELEGRAM_BOT_TOKEN=<token from BotFather>
TG_BOT_API_TOKEN=<second secret>
PANEL_URL=https://panel.example.com
```

`/etc/panel-bots-discord.env`:
```
BOT_API_TOKEN=<first secret>
PANEL_URL=https://panel.example.com
```

**Private networks are blocked.** The units set `IPAddressDeny` on private networks (10/8, 172.16/12, 192.168/16 and others): there may be an internal network behind the VDS (a tunnel, a VPN), and the bot must not reach it even if a forged address gets into the queue. Before installing the units, check two things:

- `grep nameserver /etc/resolv.conf` — if the DNS server is in a private network (not `127.0.0.53`), add `IPAddressAllow=<its address>` to both units, otherwise the bots cannot resolve names;
- `ip route` — if the network behind a tunnel is not in a private range, add it to `IPAddressDeny`.

Permissions on the secrets, the units and start:

```bash
sudo chown root:panelbot /etc/panel-bots-*.env && sudo chmod 640 /etc/panel-bots-*.env
sudo cp panel-telegram.service panel-discord.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now panel-telegram panel-discord
journalctl -u panel-telegram -u panel-discord -f
```

**Updating.** `deploy.sh` does not touch the bots: if something changed in `bots/`, copy the files to the VDS again (if you added `IPAddressAllow` to the units, carry it over to the new ones):

```bash
scp bots/*.py bots/*.service root@<VDS>:/tmp/
```

```bash
cd /tmp && install -o panelbot -g panelbot -m 644 telegram-bot.py discord-poller.py /opt/panel-bots/ && install -m 644 panel-telegram.service panel-discord.service /etc/systemd/system/ && systemctl daemon-reload && systemctl restart panel-telegram panel-discord
```

## Checking

- In the panel: Alerts («Оповещения») → "Link Telegram" («Привязать Telegram»). The bot opens, press Start. The bot replies that the Infra Panel account is linked, and a test message arrives.
- Discord: Alerts → "Add channel" → "Discord webhook" → the channel's webhook URL → "Test message".
- If Alerts shows a "messages piling up in the queue" banner, the bot is not fetching the queue. Check `journalctl` on the VDS.
- The bridge answers `403` — one of three: the secrets on the panel server and on the VDS differ; the panel was not restarted after editing `.env` (settings are read only on start); the bots' IP is not in `BOT_ALLOWED_IPS` — then `journalctl -u panel` has a "request from an address not in BOT_ALLOWED_IPS" line with the real `ip`.
- Start in Telegram gets no reply and there is no `link ok/fail` line in `journalctl -u panel-telegram` — check that the panel's `TELEGRAM_BOT_USERNAME` is the same bot whose token is on the VDS (`getMe`), and that it has no webhook set (`getWebhookInfo`, `deleteWebhook` if needed).
- A one-off `updates loop error: The read operation timed out` is a network glitch; the bot carries on by itself.

## Users' own bots

Users add their own Telegram and Discord bots in Alerts → workspace channels (how — [README.md](../README.md), "Alerts"). Nothing extra has to be deployed for them: a queued message carries the user's bot token (`bot_token`), and the same relay sends on its behalf:
- Telegram — `sendMessage` from the user's bot. The other bot's `getUpdates` is not touched, so that bot can keep working elsewhere.
- Discord — `POST /channels/{id}/messages` with `Authorization: Bot …`. The bot must be on the server with View Channel, Send Messages and Embed Links.

Users' tokens are stored encrypted in the panel and passed to the relay over HTTPS together with the message. They never get into logs or into errors sent back to the server (`scrub`). The rejection reason ("chat not found", "Missing Access") is shown on the channel in the settings.

## Behaviour

- On 429 (rate limit), 5xx and network failures the message stays in the queue until the next round; `failed` is set only on 4xx rejections.
- Errors carry the reason from Telegram or Discord, without the URL (Telegram puts the token in the URL).
- If the panel server can reach Telegram and Discord itself, the bots can run right on it: `PANEL_URL` is then the panel's address or `http://127.0.0.1:8090` (which needs `127.0.0.1` in `BOT_ALLOWED_IPS`).
