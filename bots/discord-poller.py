#!/usr/bin/env python3
"""
Discord-поллер Infra Panel — запускается на зарубежной VDS.

Discord заблокирован в РФ, поэтому панель не постит напрямую. Этот
скрипт раз в POLL_INTERVAL секунд:
  1. забирает pending-уведомления через /api/v1/bot/pending/
  2. постит каждое в его Discord webhook — или, если у сообщения есть `bot_token`,
     от имени бота пользователя в канал `channel_id` (REST API, бот должен быть на сервере
     с правами View Channel, Send Messages, Embed Links)
  3. помечает результат через /api/v1/bot/mark-sent/

Конфигурация через переменные окружения:
  PANEL_URL      — базовый URL панели (https://panel.example.com)
  BOT_API_TOKEN  — общий секрет (то же значение, что в .env панели)
  POLL_INTERVAL  — период опроса в секундах (по умолчанию 30)

Зависимости: httpx  (pip install httpx)
"""

import asyncio
import os
import re
import sys
from datetime import datetime, timezone

import httpx

PANEL_URL = os.environ.get("PANEL_URL", "").rstrip("/")
BOT_TOKEN = os.environ.get("BOT_API_TOKEN", "")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))

# Токен — в заголовке, а не в query string: query оседает в access-логах
# nginx и в любом прокси по пути.
AUTH_HEADERS = {"X-Bot-Token": BOT_TOKEN}


def log(msg: str):
    print(f"[{datetime.now(timezone.utc).isoformat()}] {msg}", flush=True)


def scrub(err, webhook_url: str = "", bot_token: str = "") -> str:
    """
    Убирает секреты из текста ошибки перед логом и отправкой на сервер.

    **URL вебхука Discord — это и есть секрет**: кто им владеет, тот пишет в
    канал. А httpx кладёт полный URL в текст исключения, и дальше он уходил
    в journald на VDS и полем `failed` обратно на сервер, оседая в
    `NotificationQueue.error`.

    Маскируем двумя способами. Точным — по значению вебхука текущего
    уведомления, оно известно на месте. И по форме URL: вебхуки приходят с
    сервера, их список заранее неизвестен, а в текст ошибки может попасть
    не только тот, что обрабатывается сейчас.

    Ровно эта же ошибка уже случалась с `X-Bot-Token` в query string
    в боте, от которого взят этот, после чего токены пришлось ротировать.
    """
    text = str(err)
    if webhook_url:
        text = text.replace(webhook_url, "<webhook>")
    for secret in (BOT_TOKEN, bot_token):
        if secret:
            text = text.replace(secret, "***")
    # .../api/webhooks/<id>/<секрет> — гасим хвост, оставляя id для разбора.
    text = re.sub(r"(/api/webhooks/\d+/)[\w-]+", r"\1***", text)
    return text


class RetryLater(Exception):
    """Временный сбой — 429, 5xx или сеть: сообщение остаётся в очереди до следующего круга.
    shortcut: без счётчика попыток, вечно недоставимое ждёт в pending; счётчик — если такое появится."""


#: Куда можно слать: только Discord. Сервер проверяет то же самое, но за VDS может быть
#: внутренняя сеть (туннель, VPN), и подставной адрес из моста не должен превратиться в запрос туда
WEBHOOK_RE = re.compile(r"^https://(?:ptb\.|canary\.)?(?:discord|discordapp)\.com/api/webhooks/\d+/[\w-]+$")
#: Упоминания (@everyone и т. п.) из названий серверов и структур не срабатывают
NO_MENTIONS = {"parse": []}


async def send_discord(client: httpx.AsyncClient, n: dict):
    """Постит один embed — вебхуком или своим ботом в канал. Бросает при HTTP-ошибке."""
    payload = {"embeds": [n["embed_data"]], "allowed_mentions": NO_MENTIONS}
    if n.get("bot_token"):
        if not str(n.get("channel_id", "")).isdigit():
            raise RuntimeError("неверный ID канала")
        r = await client.post(
            f"https://discord.com/api/v10/channels/{n['channel_id']}/messages",
            headers={"Authorization": f"Bot {n['bot_token']}"},
            json=payload,
            timeout=10,
        )
    else:
        if not WEBHOOK_RE.match(n.get("webhook_url") or ""):
            raise RuntimeError("неверный адрес вебхука")
        r = await client.post(n["webhook_url"], json=payload, timeout=10)
    if r.status_code == 429:
        raise RetryLater(r.headers.get("retry-after", "5"))
    if r.status_code >= 500:
        raise RetryLater("5")
    if r.status_code >= 400:
        # Причина от Discord («Missing Access», «Unknown Channel») — её увидят в настройках канала
        try:
            msg = r.json().get("message") or r.text[:200]
        except ValueError:
            msg = r.text[:200]
        raise RuntimeError(f"Discord {r.status_code}: {msg}")


async def poll_once(client: httpx.AsyncClient):
    # 1. Забрать pending.
    r = await client.get(
        f"{PANEL_URL}/api/v1/bot/pending/",
        headers=AUTH_HEADERS, timeout=15,
    )
    r.raise_for_status()
    notifications = r.json()
    if not notifications:
        return

    sent_ids: list[int] = []
    failed: dict[str, str] = {}

    #: Кто получил 429 в этом круге (вебхук или бот): ждёт только он, остальные каналы идут дальше
    limited: set[str] = set()
    for n in notifications:
        key = n.get("webhook_url") or f"bot:{n.get('bot_token')}"
        if key in limited:
            continue
        try:
            await send_discord(client, n)
            sent_ids.append(n["id"])
            log(f"  ✓ sent #{n['id']}")
        except (RetryLater, httpx.TransportError) as e:
            # Таймаут или 5xx — не повод навсегда терять тревогу: следующим кругом
            limited.add(key)
            log(f"  … retry later #{n['id']}: {scrub(e, n.get('webhook_url', ''), n.get('bot_token', ''))}")
        except Exception as e:  # noqa: BLE001 — логируем любую ошибку доставки
            failed[str(n["id"])] = scrub(e, n.get("webhook_url", ""), n.get("bot_token", ""))[:500]
            log(f"  ✗ failed #{n['id']}: {scrub(e, n.get('webhook_url', ''), n.get('bot_token', ''))}")

    # 2. Отчитаться серверу.
    if sent_ids or failed:
        await client.post(
            f"{PANEL_URL}/api/v1/bot/mark-sent/",
            headers=AUTH_HEADERS,
            json={"ids": sent_ids, "failed": failed},
            timeout=15,
        )


async def main():
    if not BOT_TOKEN or not PANEL_URL:
        log("FATAL: BOT_API_TOKEN / PANEL_URL не заданы в окружении")
        sys.exit(1)

    log(f"Bot started, polling {PANEL_URL} every {POLL_INTERVAL}s")
    async with httpx.AsyncClient() as client:
        while True:
            try:
                await poll_once(client)
            except Exception as e:  # noqa: BLE001 — цикл не должен падать
                log(f"polling error: {scrub(e)}")
            await asyncio.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    asyncio.run(main())
