#!/usr/bin/env python3
"""
Telegram-бот оповещений Infra Panel — запускается на зарубежной VDS (Telegram недоступен
с РФ-сервера, как и Discord). Два дела в одном цикле:

  1. getUpdates → на `/start <token>` привязывает пользователя через
     POST {PANEL_URL}/api/v1/tg/link/
  2. поллит {PANEL_URL}/api/v1/tg/pending/ → шлёт sendMessage → mark-sent

Сообщения каналов пространства приходят со своим `bot_token` — их бот отправляет от имени
бота пользователя (только sendMessage, getUpdates чужого бота не трогаем).

Env:
  TELEGRAM_BOT_TOKEN — токен бота от @BotFather (ТОЛЬКО на VDS). Нужен ОТДЕЛЬНЫЙ бот,
                       только для панели: у одного токена может быть один getUpdates
  PANEL_URL          — адрес панели (https://panel.example.com)
  TG_BOT_API_TOKEN   — общий секрет с сервером (тот же, что в .env панели)
  POLL_INTERVAL      — пауза между циклами, сек (по умолчанию 10)

Зависимости: httpx  (pip install httpx)
"""

import os
import re
import sys
import time
from datetime import datetime, timezone

import httpx

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
PANEL_URL = os.environ.get("PANEL_URL", "").rstrip("/")
API_TOKEN = os.environ.get("TG_BOT_API_TOKEN", "")
#: Домен в текстах бота — из того же адреса, по которому он ходит на сервер:
#: переезд сайта на другой домен — одна переменная окружения на VDS.
SITE_DOMAIN = PANEL_URL.split("://", 1)[-1]

# Токен сервера — в заголовке, а не в query string: query оседает в
# access-логах nginx и в любом прокси по пути.
AUTH_HEADERS = {"X-Bot-Token": API_TOKEN}
POLL = int(os.environ.get("POLL_INTERVAL", "10"))
TG = f"https://api.telegram.org/bot{BOT_TOKEN}"


def log(m: str):
    print(f"[{datetime.now(timezone.utc).isoformat()}] {m}", flush=True)


def scrub(err, *extra: str) -> str:
    """
    Убирает секреты из текста ошибки перед логом и отправкой на сервер.

    Токен бота по устройству Telegram API живёт В URL
    (`api.telegram.org/bot<TOKEN>/sendMessage`), а httpx кладёт полный URL в
    текст исключения: «Client error '403 Forbidden' for url
    'https://api.telegram.org/bot123:ABC.../sendMessage'». Дальше этот текст
    уходил в две стороны — в journald на VDS и полем `failed` на сервер, где
    оседал в `TelegramMessage.error` и был виден в админке. То есть токен,
    который по замыслу существует ТОЛЬКО на VDS, при первой же неудачной
    отправке оказывался в базе основного сервера.

    Неудачная отправка при этом обыденна: человек заблокировал бота — 403,
    удалил чат — 400. Хватало одного такого случая.

    Ровно эта же ошибка уже случалась с `X-Bot-Token` в query string
    в боте, от которого взят этот, после чего оба токена пришлось ротировать.
    """
    text = str(err)
    # extra — токены своих ботов пользователей: они тоже живут в URL
    for secret in (BOT_TOKEN, API_TOKEN, *extra):
        if secret:
            text = text.replace(secret, "***")
    return text


class RetryLater(Exception):
    """Временный сбой — 429, 5xx или сеть: сообщение остаётся в очереди до следующего круга.
    shortcut: без счётчика попыток, вечно недоставимое ждёт в pending; счётчик — если такое появится."""


#: Токен своего бота пользователя попадает в URL — только формат «123:abc», чтобы
#: подставной токен не увёл запрос на другой путь или хост (за VDS может быть внутренняя сеть)
TOKEN_RE = re.compile(r"^\d+:[\w-]+$")


def tg_send(client: httpx.Client, chat_id, text: str, token: str = ""):
    if token and not TOKEN_RE.match(token):
        raise RuntimeError("неверный формат токена бота")
    base = f"https://api.telegram.org/bot{token}" if token else TG
    r = client.post(f"{base}/sendMessage", json={"chat_id": chat_id, "text": text}, timeout=15)
    if r.status_code == 429:
        raise RetryLater((r.json().get("parameters") or {}).get("retry_after", 5))
    if r.status_code >= 500:
        raise RetryLater(5)
    if r.status_code >= 400:
        # Причина от Telegram («chat not found», «Unauthorized») — её увидят в настройках канала.
        # Без URL в тексте: в URL живёт токен
        try:
            desc = r.json().get("description") or r.text[:200]
        except ValueError:
            desc = r.text[:200]
        raise RuntimeError(f"Telegram {r.status_code}: {desc}")


#: Последняя ошибка getUpdates: в лог — только при смене, а не каждый круг
_updates_error = ""


def handle_updates(client: httpx.Client, offset: int) -> int:
    """Обрабатывает входящие /start (привязка аккаунта)."""
    global _updates_error
    r = client.get(
        f"{TG}/getUpdates",
        params={"offset": offset, "timeout": 10, "allowed_updates": '["message"]'},
        timeout=25,
    )
    data = r.json()
    if not data.get("ok"):
        # Без лога бот молча не видел /start: 401 — токен неверный,
        # 409 — висит вебхук или этот же токен читает другой бот
        err = f"getUpdates: {data.get('error_code', r.status_code)} {data.get('description', '')}".strip()
        if err != _updates_error:
            log(scrub(err))
            _updates_error = err
        return offset
    if _updates_error:
        log("getUpdates снова работает")
        _updates_error = ""

    for upd in data.get("result", []):
        # offset — до обработки: если ответ не уходит (человек заблокировал бота), пачка
        # иначе приходила бы снова и снова, и привязка вставала бы у всех
        offset = upd["update_id"] + 1
        try:
            handle_start(client, upd)
        except Exception as e:  # noqa: BLE001 — одно сообщение не должно останавливать остальные
            log(f"update {upd['update_id']} error: {scrub(e)}")
    return offset


def handle_start(client: httpx.Client, upd: dict):
    """/start <token> — привязать Telegram к пользователю панели."""
    msg = upd.get("message") or {}
    text = (msg.get("text") or "").strip()
    frm = msg.get("from") or {}
    chat = (msg.get("chat") or {}).get("id")
    if not chat or not text.startswith("/start"):
        return

    parts = text.split(maxsplit=1)
    token = parts[1].strip() if len(parts) > 1 else ""
    if not token:
        tg_send(client, chat,
                "Привет! Это бот оповещений Infra Panel. Чтобы получать оповещения, "
                f"откройте {SITE_DOMAIN} → «Оповещения» → «Привязать Telegram».")
        return

    ok = False
    status = "нет ответа"
    try:
        lr = client.post(
            f"{PANEL_URL}/api/v1/tg/link/",
            headers=AUTH_HEADERS,
            json={"link_token": token,
                  "tg_user_id": frm.get("id"), "tg_username": frm.get("username", "")},
            timeout=15,
        )
        status = f"HTTP {lr.status_code}"
        body = lr.json()
        ok = bool(body.get("ok"))
        # reason от моста: expired — ссылка истекла, bad_params — кривой запрос
        status = f"{status} {body.get('reason') or body.get('error') or ''}".strip()
    except Exception as e:  # noqa: BLE001
        log(f"link error: {scrub(e)}")

    log(f"  link {'ok' if ok else 'fail, ' + status} for tg {frm.get('id')}")
    tg_send(client, chat,
            "✅ Аккаунт Infra Panel привязан. Буду присылать сюда оповещения."
            if ok else
            f"⚠ Ссылка привязки истекла или неверна. Получите новую на {SITE_DOMAIN} → «Оповещения».")


def deliver(client: httpx.Client):
    """Разносит исходящие алерты из очереди сервера."""
    try:
        r = client.get(f"{PANEL_URL}/api/v1/tg/pending/",
                       headers=AUTH_HEADERS, timeout=15)
        r.raise_for_status()
        items = r.json()
    except Exception as e:  # noqa: BLE001
        log(f"pending error: {scrub(e)}")
        return
    if not items:
        return

    sent, failed = [], {}
    #: Кто получил 429 в этом круге: свой бот — по токену, бот панели — по чату. Ждёт только он:
    #: раньше пауза и выход из круга задерживали тревоги всех пространств из-за одного канала
    limited: set[str] = set()
    for n in items:
        token = n.get("bot_token") or ""
        key = f"bot:{token}" if token else f"chat:{n['tg_user_id']}"
        if key in limited:
            continue
        try:
            tg_send(client, n["tg_user_id"], n["text"], token)
            sent.append(n["id"])
            log(f"  ✓ sent #{n['id']} → tg {n['tg_user_id']}")
        except (RetryLater, httpx.TransportError) as e:
            # Это и остальное для того же получателя — следующим кругом, не помечая failed:
            # таймаут или 5xx — не повод навсегда терять тревогу
            limited.add(key)
            log(f"  … retry later #{n['id']}: {scrub(e, token)}")
        except Exception as e:  # noqa: BLE001
            failed[str(n["id"])] = scrub(e, token)[:300]
            log(f"  ✗ failed #{n['id']}: {scrub(e, token)}")

    if sent or failed:
        try:
            client.post(f"{PANEL_URL}/api/v1/tg/mark-sent/",
                        headers=AUTH_HEADERS,
                        json={"ids": sent, "failed": failed}, timeout=15)
        except Exception as e:  # noqa: BLE001
            log(f"mark-sent error: {scrub(e)}")


def main():
    if not BOT_TOKEN or not API_TOKEN or not PANEL_URL:
        log("FATAL: TELEGRAM_BOT_TOKEN / TG_BOT_API_TOKEN / PANEL_URL не заданы в окружении")
        sys.exit(1)
    log(f"Telegram bot started; panel={PANEL_URL}")
    offset = 0
    with httpx.Client() as client:
        while True:
            try:
                offset = handle_updates(client, offset)
            except Exception as e:  # noqa: BLE001 — цикл не должен падать
                log(f"updates loop error: {scrub(e)}")
            try:
                deliver(client)
            except Exception as e:  # noqa: BLE001
                log(f"deliver loop error: {scrub(e)}")
            time.sleep(POLL)


if __name__ == "__main__":
    main()
