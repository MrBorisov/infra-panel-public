# Боты оповещений (на зарубежной VDS)

Из РФ API Telegram и Discord недоступны, поэтому панель ничего не отправляет сама. Она кладёт сообщения в очередь, а боты на зарубежной VDS забирают их через мост `/api/v1/bot/*` и `/api/v1/tg/*` и отправляют, в том числе от имени своих ботов пользователей (поля `bot_token` и `channel_id`, см. ниже).

Подойдёт любая небольшая VDS за пределами РФ: боты не слушают порты, только ходят наружу — в Telegram, Discord и мост панели. Если там уже живут другие боты, ставьте эти рядом, под отдельным пользователем и в отдельных файлах `.env`.

## 1. Новый Telegram-бот

Создайте **отдельного** бота у [@BotFather](https://t.me/BotFather): у одного токена может быть только один потребитель `getUpdates`, поэтому бот, который уже работает где-то ещё, не подойдёт. Запомните токен и username, например `infra_panel_bot`.

## 2. Секреты моста

Сгенерируйте два секрета (на любой машине):

```bash
openssl rand -hex 32   # BOT_API_TOKEN — для Discord
openssl rand -hex 32   # TG_BOT_API_TOKEN — для Telegram
```

В `.env` панели на сервере (`/opt/panel/app/.env`) добавьте:

```
BOT_API_TOKEN=<первый секрет>
TG_BOT_API_TOKEN=<второй секрет>
TELEGRAM_BOT_USERNAME=infra_panel_bot
BOT_ALLOWED_IPS=<IP VDS>
```

С `BOT_ALLOWED_IPS` мост `/api/v1/*` принимает запросы только с VDS: утёкший секрет не сработает с другого адреса. После этого: `sudo systemctl restart panel`.

## 3. Установка на VDS

```bash
sudo adduser --system --group --home /opt/panel-bots panelbot
sudo mkdir -p /opt/panel-bots && sudo chown panelbot: /opt/panel-bots
# скопировать сюда bots/telegram-bot.py и bots/discord-poller.py (scp или git)
sudo -u panelbot python3 -m venv /opt/panel-bots/venv
sudo -u panelbot /opt/panel-bots/venv/bin/pip install httpx
```

`/etc/panel-bots-tg.env`:
```
TELEGRAM_BOT_TOKEN=<токен от BotFather>
TG_BOT_API_TOKEN=<второй секрет>
PANEL_URL=https://panel.example.com
```

`/etc/panel-bots-discord.env`:
```
BOT_API_TOKEN=<первый секрет>
PANEL_URL=https://panel.example.com
```

**Запрет частных сетей.** В юнитах стоит `IPAddressDeny` на частные сети (10/8, 172.16/12, 192.168/16 и др.): за VDS может быть внутренняя сеть (туннель, VPN), и бот не должен туда ходить, даже если в очередь попадёт подставной адрес. Перед установкой юнитов проверьте две вещи:

- `grep nameserver /etc/resolv.conf` — если DNS-сервер из частной сети (не `127.0.0.53`), добавьте в оба юнита `IPAddressAllow=<его адрес>`, иначе боты не смогут резолвить имена;
- `ip route` — если сеть за туннелем не из частных диапазонов, допишите её в `IPAddressDeny`.

Права на секреты, юниты и запуск:

```bash
sudo chown root:panelbot /etc/panel-bots-*.env && sudo chmod 640 /etc/panel-bots-*.env
sudo cp panel-telegram.service panel-discord.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now panel-telegram panel-discord
journalctl -u panel-telegram -u panel-discord -f
```

**Обновление.** `deploy.sh` ботов не трогает: если в `bots/` что-то поменялось, скопируйте файлы на VDS заново (если в юниты дописывали `IPAddressAllow`, перенесите его в новые):

```bash
scp bots/*.py bots/*.service root@<VDS>:/tmp/
```

```bash
cd /tmp && install -o panelbot -g panelbot -m 644 telegram-bot.py discord-poller.py /opt/panel-bots/ && install -m 644 panel-telegram.service panel-discord.service /etc/systemd/system/ && systemctl daemon-reload && systemctl restart panel-telegram panel-discord
```

## Проверка

- В панели: «Оповещения» → «Привязать Telegram». Откроется бот, нажмите «Start». Бот ответит «✅ Аккаунт Infra Panel привязан», и придёт тестовое сообщение.
- Discord: «Оповещения» → «Добавить канал» → «Discord-вебхук» → ссылка вебхука канала → «Тестовое сообщение».
- Если в «Оповещениях» появилась плашка «В очереди скопились сообщения», значит бот не забирает очередь. Смотрите `journalctl` на VDS.
- Мост отвечает `403` — одно из трёх: секреты на сервере панели и на VDS не совпадают; панель не перезапущена после правки `.env` (настройки читаются только при старте); IP ботов нет в `BOT_ALLOWED_IPS` — тогда в `journalctl -u panel` есть «Мост: запрос с адреса не из BOT_ALLOWED_IPS» с настоящим `ip`.
- Start в Telegram без ответа и без строки `link ok/fail` в `journalctl -u panel-telegram` — проверьте, что `TELEGRAM_BOT_USERNAME` панели — тот же бот, чей токен на VDS (`getMe`), и что на нём не висит вебхук (`getWebhookInfo`, при нужде `deleteWebhook`).
- Разовое `updates loop error: The read operation timed out` — сетевой сбой, бот продолжает сам.

## Свои боты пользователей

Своих Telegram- и Discord-ботов пользователи добавляют в «Оповещения» → «Каналы пространства» (как — [README.md](../README.md), «Оповещения»). Отдельно разворачивать для них ничего не нужно: в сообщении из очереди приходит токен бота пользователя (`bot_token`), и этот же посредник отправляет от его имени:
- Telegram — `sendMessage` от бота пользователя. `getUpdates` чужого бота не трогается, поэтому бот может параллельно работать где-то ещё.
- Discord — `POST /channels/{id}/messages` с `Authorization: Bot …`. Бот должен быть на сервере с правами View Channel, Send Messages, Embed Links.

Токены пользователей хранятся в панели в зашифрованном виде и передаются посреднику по HTTPS вместе с сообщением. В логи и в ошибки, которые уходят на сервер, они не попадают (`scrub`). Причина отказа («chat not found», «Missing Access») видна у канала в настройках.

## Поведение

- При 429 (rate limit), 5xx и сетевых сбоях сообщение остаётся в очереди до следующего круга; `failed` — только при отказах 4xx.
- В ошибке — причина от Telegram или Discord, без URL (в URL Telegram живёт токен).
- Если сервер панели сам достаёт до Telegram и Discord (хостинг не в РФ), ботов можно запустить прямо на нём: `PANEL_URL` тогда — адрес панели или `http://127.0.0.1:8090` (с ним в `BOT_ALLOWED_IPS` нужен `127.0.0.1`).
