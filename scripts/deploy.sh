#!/usr/bin/env bash
#
# Установка и выкат Infra Panel на сервер, где уже работает nginx с другими сайтами. Запускать на сервере
# под СВОИМ пользователем с sudo — не от root и не от panel:
#
#   bash /tmp/panel-deploy.sh install                 # первый раз: всё от Node до HTTPS и админа
#   bash /opt/panel/app/scripts/deploy.sh             # выкат: план, вопрос [y/N], шаги, проверки
#   bash /opt/panel/app/scripts/deploy.sh --dry-run   # что приедет и что выполнится
#
# Флаги: --yes (без вопроса), --dry-run, -h. Настройки — переменные PANEL_* ниже.
#
# ── Устройство, и почему именно такое ────────────────────────────────────
#
# * Панель живёт рядом с другими сайтами и ничего их не трогает: свой пользователь `panel`,
#   свой каталог /opt/panel, свой порт (8090), свой файл в sites-available.
# * Свой Node в /opt/panel/node. Системный Node может быть нужен другим проектам, а панели
#   нужен 24; обновлять системный — значит менять сборку чужого проекта. Скачивается с nodejs.org,
#   контрольная сумма сверяется.
# * Всё, что трогает файлы проекта, — от `panel` (через sudo -u), рестарт — sudo systemctl.
#   От root нельзя: созданные им файлы сервису недоступны.
# * Секреты недоступны чужим пользователям: .env — 600, данные — 700. Код читаем всем
#   (755), иначе этот скрипт не прочитать из-под своего пользователя.
# * `npm ci --no-audit --no-fund`: audit к реестру npm на части серверов виснет. Никогда `npm install` — он дописывает lock, и следующий выкат упрётся в него.
# * После `git merge` скрипт перезапускает сам себя из нового коммита: bash читает файл
#   по ходу исполнения, а шаги нового релиза должна выполнять новая версия скрипта.
# * «Выкачено» — коммит, на котором выкат дошёл до конца (`.git/panel_deployed`). Повтор
#   после сбоя выполнит шаги для всего недошедшего.
# * Миграции базы панель применяет сама при старте. Если они приехали, перед сборкой
#   снимается бэкап базы.
# * Рестарт — только если все шаги прошли. Правки только интерфейса (src/web) — без рестарта:
#   сервер отдаёт собранную статику с диска.
# * Проверки идут в свой nginx напрямую (--resolve на 127.0.0.1): с самого сервера
#   публичный адрес может не открываться без hairpin NAT.
# * `npm ci` и сборка — в песочнице systemd-run: они исполняют код из node_modules, а
#   scripts/ и .git этот скрипт потом исполняет с sudo. В песочнице scripts/ и .git только для
#   чтения, .env, ключ деплоя и база не видны — взломанная зависимость не станет root и не
#   уведёт ENCRYPTION_KEY (аудит 08.10.2026).
# * Юниты systemd переписываются и при выкате, если поменялся этот скрипт; прежняя версия
#   остаётся рядом с суффиксом .prev — откат одной командой (README, «Выкат и откат»).

set -Eeuo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

DOMAIN="${PANEL_DOMAIN:?задайте домен панели: PANEL_DOMAIN=panel.example.com bash $0 ...}"
APP_USER="${PANEL_USER:-panel}"
APP_HOME="${PANEL_HOME:-/opt/panel}"
REPO="${DEPLOY_REPO:-$APP_HOME/app}"
DATA_DIR="$APP_HOME/data"
NODE_DIR="$APP_HOME/node"
NODE_MAJOR="${PANEL_NODE_MAJOR:-24}"
PORT="${PANEL_PORT:-8090}"
UNIT="${PANEL_UNIT:-panel}"
GIT_URL="${PANEL_GIT_URL:-}"
REMOTE=origin
BRANCH=master
SITE_URL="https://$DOMAIN"
SITE_RESOLVE="${SITE_RESOLVE-$DOMAIN:443:127.0.0.1}"
LOCK_DIR="${LOCK_DIR:-/tmp/panel_deploy.lock}"
# Чем повышать права. Пустое — стенд без sudo (проверка скрипта на копии репозитория).
SUDO="${DEPLOY_SUDO-sudo}"

MODE=deploy
DRY_RUN=0
ASSUME_YES=0
FROM=""
TO=""
STARTED_AT=""

# Правки без сборки и рестарта: документы, CI, скрипты, Docker-вариант развёртывания.
NO_BUILD_RE='(\.md$|^docs/|^\.github/|^\.claude/|^scripts/|^Dockerfile$|^docker-compose\.yml$|^Caddyfile$|^\.dockerignore$|^\.env\.example$|^\.gitignore$)'
# Правки, которым нужна сборка, но не рестарт: интерфейс отдаётся с диска (и интерфейс модулей).
NO_RESTART_RE="($NO_BUILD_RE|^src/web/|^src/modules/[^/]+/web/|^src/modules/web\.ts$)"
DEPS_RE='^package(-lock)?\.json$'
MIGRATIONS_RE='^drizzle/'

# ── Вывод и обёртки ──────────────────────────────────────────────────────

say()  { printf '%s\n' "$*"; }
step() { printf '\n── %s\n' "$*"; }
warn() { printf 'ВНИМАНИЕ: %s\n' "$*" >&2; }
die()  { printf '\nСТОП: %s\n' "$*" >&2; exit 1; }

# Команды проекта — от его владельца и со своим Node в PATH.
as_app() {
    if [ -n "$SUDO" ]; then
        "$SUDO" -u "$APP_USER" -H env PATH="$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin" "$@"
    else
        env PATH="$NODE_DIR/bin:$PATH" "$@"
    fi
}
root() { if [ -n "$SUDO" ]; then "$SUDO" "$@"; else "$@"; fi; }
git_app() { as_app git -C "$REPO" "$@"; }
short() { git_app rev-parse --short "$1"; }
# Через here-string, не через pipe: с pipefail ранний выход grep -q даёт SIGPIPE у printf.
matches() { grep -qE "$2" <<<"$1"; }

# Все строки из списка подходят под регулярку? Пустые строки не в счёт. Код grep 1 — все подходят,
# 2 — ошибка (опечатка в регулярке): «не подходят», лишняя сборка лучше пропущенной.
# Через `|| rc=$?`: под set -e голый код 1 оборвал бы скрипт, если позвать функцию не из if.
all_match() { local rc=0; grep -qvE -e "$2" -e '^$' <<<"$1" || rc=$?; [ "$rc" -eq 1 ]; }

usage() { sed -n '3,10p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; }

preflight() {
    [ "$(id -u)" -ne 0 ] || die "не от root: файлы, созданные root, сервису недоступны. Запусти от своего пользователя с sudo."
    if [ -n "$SUDO" ]; then
        [ "$(id -un)" != "$APP_USER" ] || die "не от $APP_USER: у него нет sudo. Запусти от своего пользователя."
        say "Пароль sudo — для команд от $APP_USER, установки и рестарта."
        "$SUDO" -v
    fi
}

# ── Замок от второго запуска ─────────────────────────────────────────────
# Каталог, а не flock: mkdir атомарен. PID после exec не меняется — новая версия скрипта
# узнаёт свой замок.

take_lock() {
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        echo $$ > "$LOCK_DIR/pid"
        return 0
    fi
    local pid
    pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    [ "$pid" != "$$" ] || return 0
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        die "уже идёт другой выкат (pid $pid)."
    fi
    rm -rf "${LOCK_DIR:?}"
    mkdir "$LOCK_DIR"
    echo $$ > "$LOCK_DIR/pid"
}

release_lock() { rm -rf "${LOCK_DIR:?}"; }

# ── Что выкачено ─────────────────────────────────────────────────────────

deployed_file() { printf '%s/panel_deployed\n' "$(git_app rev-parse --absolute-git-dir)"; }
deploy_log() { printf '%s/panel_deploy.log\n' "$(git_app rev-parse --absolute-git-dir)"; }

deployed_commit() {
    local f
    f="$(deployed_file)"
    if as_app test -s "$f" && git_app cat-file -e "$(as_app cat "$f")^{commit}" 2>/dev/null; then
        as_app cat "$f"
    else
        git_app rev-parse HEAD
    fi
}

mark_deployed() { printf '%s\n' "$1" | as_app tee "$(deployed_file)" >/dev/null; }

log_result() {
    local line
    line="$(date -u '+%Y-%m-%d %H:%M:%S') UTC $(id -un) $1"
    printf '%s\n' "$line" | as_app tee -a "$(deploy_log)" >/dev/null || warn "не записал строку в $(deploy_log)"
    say ""
    say "$line"
}

STAGE="steps"
on_error() {
    # Упавшая команда в конвейере (`… | tail`) вызывает ловушку дважды: в подоболочке
    # и в основной. Сообщение — только из основной.
    [ "$BASH_SUBSHELL" -eq 0 ] || return 0
    if [ "$MODE" = install ]; then
        printf '\nСТОП: шаг выше упал (строка %s). Поправь причину и запусти install снова — сделанные шаги не повторятся.\n' "$1" >&2
    elif [ "$STAGE" = "steps" ]; then
        printf '\nСТОП: шаг выше упал (строка %s). Сервис НЕ перезапущен и работает на прежнем коде, на диске уже %s. Поправить причину и запустить deploy.sh снова — шаги повторятся с %s.\n' "$1" "$(short "$TO")" "$(short "$FROM")" >&2
    else
        printf '\nСТОП: рестарт не прошёл (строка %s). Состояние: systemctl status %s\n' "$1" "$UNIT" >&2
    fi
}

# ── Общие шаги ───────────────────────────────────────────────────────────

# Команда в каталоге проекта от $APP_USER — в песочнице: писать можно в код (node_modules, dist),
# но не в scripts/ и .git; .env, ключ деплоя и данные не видны. С «data» (бэкап) — наоборот:
# писать только в данные, код только читать: собранный в песочнице dist вне её не исполняется.
# Дальше — аргументы команды ($1, $2… внутри неё). Без systemd-run — как раньше.
in_sandbox() {
    local cmd="$1" mode="${2:-}"
    shift
    [ $# -gt 0 ] && shift
    if [ -z "$SUDO" ] || ! command -v systemd-run >/dev/null; then
        as_app bash -c "cd '$REPO' && $cmd" _ "$@"
        return
    fi
    local rw="$REPO $APP_HOME/.npm $APP_HOME/.cache" ro="$REPO/scripts $REPO/.git" hidden="-$REPO/.env -$APP_HOME/.ssh -$DATA_DIR"
    if [ "$mode" = data ]; then
        rw="$DATA_DIR" ro="$REPO" hidden="-$APP_HOME/.ssh"
    fi
    as_app mkdir -p "$APP_HOME/.npm" "$APP_HOME/.cache"
    root systemd-run --quiet --wait --pipe --collect \
        --uid="$APP_USER" --gid="$APP_USER" \
        -p WorkingDirectory="$REPO" \
        -p NoNewPrivileges=true -p PrivateTmp=true -p PrivateDevices=true \
        -p ProtectSystem=strict -p ProtectHome=true \
        -p ReadWritePaths="$rw" -p ReadOnlyPaths="$ro" -p InaccessiblePaths="$hidden" \
        --setenv=HOME="$APP_HOME" --setenv=PATH="$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin" \
        bash -c "$cmd" _ "$@"
}

npm_ci() {
    step "Зависимости: npm ci"
    in_sandbox "npm ci --no-audit --no-fund"
    # better-sqlite3 собирается из исходников; если npm не дал выполнить его сборку,
    # сервис упадёт на старте — лучше узнать сейчас.
    in_sandbox "node -e \"new (require('better-sqlite3'))(':memory:')\"" \
        || die "модуль better-sqlite3 не собрался. Нужны build-essential и python3; затем: sudo -u $APP_USER -H bash -c 'cd $REPO && PATH=$NODE_DIR/bin:\$PATH npm rebuild better-sqlite3'"
}

build() {
    step "Сборка: npm run build"
    in_sandbox "npm run build" | tail -n 3
}

backup_db() {
    if as_app test -f "$REPO/dist/server/cli.js" && as_app test -f "$DATA_DIR/panel.db"; then
        step "Бэкап базы перед миграциями"
        in_sandbox "node dist/server/cli.js backup --out '$DATA_DIR/backups/pre-deploy-$(date -u +%Y%m%d-%H%M%S).db'" data
    fi
}

restart_unit() {
    step "Рестарт: $UNIT"
    root systemctl restart "$UNIT"
}

fetch() {
    local path="$1" out="$2" code
    # Пустой SITE_RESOLVE — без --resolve.
    code="$(curl -sS -m 15 -o "$out" -w '%{http_code}' ${SITE_RESOLVE:+--resolve "$SITE_RESOLVE"} "$SITE_URL$path" 2>/dev/null)" || true
    printf '%s\n' "${code:-000}"
}

post_checks() {
    local restarted="$1" problems=0 tmp code entry errors
    step "Проверки"

    if systemctl is-active --quiet "$UNIT"; then
        say "  ок   $UNIT active"
    else
        say "  !!   $UNIT НЕ active — sudo journalctl -u $UNIT -n 50"
        problems=$((problems + 1))
    fi

    # Сервис поднимается секунду-другую — ждём первый 200.
    code=000
    for _ in $(seq 1 30); do
        code="$(fetch /api/health /dev/null)"
        [ "$code" != 200 ] || break
        sleep 1
    done
    if [ "$code" = 200 ]; then
        say "  ок   /api/health → 200"
    else
        say "  !!   /api/health → $code (ждал 30 с) — nginx, сертификат или сервис"
        problems=$((problems + 1))
    fi

    tmp="$(mktemp -d)"
    code="$(fetch / "$tmp/index.html")"
    entry="$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' "$tmp/index.html" 2>/dev/null | head -n 1 || true)"
    if [ "$code" = 200 ] && [ -n "$entry" ] && [ "$(fetch "$entry" /dev/null)" = 200 ]; then
        say "  ок   / и $entry → 200"
    else
        say "  !!   главная или её бандл не отдаются (/ → $code, бандл «${entry:-нет ссылки}») — сборка"
        problems=$((problems + 1))
    fi
    rm -rf "${tmp:?}"

    # Без входа API обязан ответить 401: 502 — сервис лежит, 404 — потерян маршрут.
    code="$(fetch /api/me /dev/null)"
    if [ "$code" = 401 ]; then
        say "  ок   /api/me без входа → 401"
    else
        say "  !!   /api/me без входа → $code, ждали 401"
        problems=$((problems + 1))
    fi

    if [ "$restarted" -eq 1 ]; then
        # Логи сервиса — JSON pino: ошибки с "level":50, падения с "level":60.
        errors="$(root journalctl -u "$UNIT" --since "$STARTED_AT" -o cat --no-pager 2>/dev/null | grep -cE '"level":(50|60)' || true)"
        if [ "${errors:-0}" -eq 0 ]; then
            say "  ок   журнал $UNIT с $STARTED_AT — ошибок нет"
        else
            say "  !!   в журнале $UNIT с $STARTED_AT ошибок: $errors — sudo journalctl -u $UNIT --since '$STARTED_AT'"
            problems=$((problems + 1))
        fi
    fi
    return "$problems"
}

# ══ Установка ════════════════════════════════════════════════════════════

install_node() {
    step "Node.js $NODE_MAJOR в $NODE_DIR"
    if [ -x "$NODE_DIR/bin/node" ] && "$NODE_DIR/bin/node" -v | grep -q "^v$NODE_MAJOR\."; then
        say "  уже стоит $("$NODE_DIR/bin/node" -v)"
        return 0
    fi
    local arch base tmp file
    case "$(uname -m)" in
        x86_64) arch=x64 ;;
        aarch64) arch=arm64 ;;
        *) die "архитектура $(uname -m) не поддержана" ;;
    esac
    base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
    tmp="$(mktemp -d)"
    # -4: на части серверов IPv6 наружу не работает
    curl -fsSL -4 "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
    file="$(grep -oE "node-v[0-9.]+-linux-$arch\.tar\.xz" "$tmp/SHASUMS256.txt" | head -n 1)"
    [ -n "$file" ] || die "не нашёл сборку Node $NODE_MAJOR для linux-$arch"
    say "  качаю $file"
    curl -fsSL -4 "$base/$file" -o "$tmp/$file"
    (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "контрольная сумма $file не сошлась"
    root rm -rf "$NODE_DIR"
    root mkdir -p "$NODE_DIR"
    root tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1 --no-same-owner
    rm -rf "${tmp:?}"
    say "  поставил $("$NODE_DIR/bin/node" -v)"
}

ensure_user() {
    step "Пользователь $APP_USER и каталог $APP_HOME"
    if id "$APP_USER" >/dev/null 2>&1; then
        say "  пользователь уже есть"
    else
        root adduser --system --group --home "$APP_HOME" --shell /bin/bash "$APP_USER"
    fi
    root mkdir -p "$APP_HOME"
    root chown "$APP_USER:$APP_USER" "$APP_HOME"
    root chmod 755 "$APP_HOME"
    as_app mkdir -p "$DATA_DIR"
    as_app chmod 700 "$DATA_DIR"
}

ensure_repo() {
    [ -n "$GIT_URL" ] || die "задайте адрес репозитория: PANEL_GIT_URL=git@github.com:<вы>/infra-panel.git (или https://…)"
    step "Код: $GIT_URL"
    local key="$APP_HOME/.ssh/id_ed25519" known="$APP_HOME/.ssh/known_hosts"
    as_app mkdir -p "$APP_HOME/.ssh"
    as_app chmod 700 "$APP_HOME/.ssh"
    if as_app test -f "$key"; then
        say "  ключ деплоя уже есть"
    else
        as_app ssh-keygen -q -t ed25519 -N "" -C "$APP_USER@$(hostname)" -f "$key"
        say "  создал ключ деплоя"
    fi
    if ! as_app ssh-keygen -F github.com -f "$known" >/dev/null 2>&1; then
        ssh-keyscan -t ed25519 github.com 2>/dev/null | as_app tee -a "$known" >/dev/null
        say "  отпечаток github.com: $(as_app ssh-keygen -lf "$known" | awk '/github/ {print $2; exit}')"
        say "  сверить: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints"
    fi

    if as_app test -d "$REPO/.git"; then
        say "  репозиторий уже склонирован в $REPO"
        return 0
    fi
    until as_app git ls-remote "$GIT_URL" HEAD >/dev/null 2>&1; do
        say ""
        say "Нет доступа к $GIT_URL. Добавь ключ в GitHub → репозиторий → Settings → Deploy keys"
        say "(только чтение, «Allow write access» не ставить):"
        say ""
        as_app cat "$key.pub"
        say ""
        [ -t 0 ] || die "нет терминала — добавь ключ и запусти install снова."
        read -r -p "Добавил — Enter, чтобы проверить ещё раз (Ctrl+C — выйти) " _
    done
    as_app git clone --quiet --branch "$BRANCH" "$GIT_URL" "$REPO"
    say "  склонировал в $REPO"
}

NEW_KEY=0
ensure_env() {
    step "Настройки: $REPO/.env"
    if as_app test -f "$REPO/.env"; then
        local env_port
        env_port="$(as_app grep -E '^PORT=' "$REPO/.env" | tail -n 1 | cut -d= -f2 || true)"
        [ "$env_port" = "$PORT" ] \
            || die "в $REPO/.env PORT=${env_port:-не задан}, а скрипт настраивает $PORT (его ждёт nginx). Поправь: sudo -u $APP_USER sed -i 's/^PORT=.*/PORT=$PORT/' $REPO/.env"
        say "  уже есть — не трогаю (PORT=$PORT)"
        return 0
    fi
    local key
    key="$(openssl rand -base64 32)"
    as_app bash -c "umask 077 && cat > '$REPO/.env'" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
DATA_DIR=$DATA_DIR
PUBLIC_URL=https://$DOMAIN
APP_NAME=Infra Panel
# Ключ шифрования паролей. Потеряешь — сохранённые пароли не расшифровать. Копия — в Passwork.
ENCRYPTION_KEY=$key
# Оповещения: боты на зарубежной VDS забирают очереди через мост (bots/README.md).
# Секреты: openssl rand -hex 32; затем sudo systemctl restart $UNIT
BOT_API_TOKEN=
TG_BOT_API_TOKEN=
TELEGRAM_BOT_USERNAME=
EOF
    NEW_KEY=1
    say "  создал, ключ шифрования сгенерирован"
}

# Записать файл root'ом, только если содержимое изменилось. Возвращает 0, если записал.
put_file() {
    local dest="$1" tmp
    tmp="$(mktemp)"
    cat > "$tmp"
    if root cmp -s "$tmp" "$dest" 2>/dev/null; then
        rm -f "$tmp"
        return 1
    fi
    # Прежняя версия — рядом: если новый юнит не поднимется, откат одной командой (README, «Выкат и откат»)
    if root test -f "$dest"; then root cp -p "$dest" "$dest.prev"; fi
    root install -m 644 "$tmp" "$dest"
    rm -f "$tmp"
    say "  записал $dest"
    return 0
}

# DNS-серверы из частных сетей (из resolv.conf) — строкой IPAddressAllow, иначе IPAddressDeny
# ниже отрезал бы панели поиск адресов. Заглушка systemd-resolved 127.0.0.53 сюда не попадает
private_dns_allow() {
    local conf=${1:-/etc/resolv.conf} ns out=""
    for ns in $(awk '$1 == "nameserver" {print $2}' "$conf" 2>/dev/null); do
        ns=${ns%%%*} # fe80::1%eth0 → fe80::1
        if [[ $ns =~ ^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|[fF][cCdD]|[fF][eE][89abAB]) ]]; then
            out+=" $ns"
        fi
    done
    if [ -n "$out" ]; then echo "IPAddressAllow=${out# }"; fi
}

hardening() {
    cat <<EOF
# Писать можно только в свои данные; систему и домашние каталоги сервис не видит.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR
# Ключ деплоя сервису не нужен: взлом панели не должен уводить доступ к репозиторию
InaccessiblePaths=-$APP_HOME/.ssh
# Новые файлы (база, бэкапы) — только для владельца
UMask=0077
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
# AF_NETLINK — список своих адресов (os.networkInterfaces) для запрета внутренних адресов в
# мониторинге. MemoryDenyWriteExecute не ставить: V8 пишет исполняемый код (JIT)
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
$(private_net_rules)
EOF
}

# Частные сети — запрет ядром, вторым слоем за netguard: ошибка в нём не откроет внутреннюю сеть.
# Петля открыта (через неё nginx и DNS 127.0.0.53), её держит только netguard. С
# MONITOR_ALLOW_PRIVATE=true в .env внутренние адреса проверять разрешили — запрет не ставим
private_net_rules() {
    if as_app grep -qsE '^MONITOR_ALLOW_PRIVATE=["'"'"']?true' "$REPO/.env"; then
        echo "# Запрета частных сетей нет: MONITOR_ALLOW_PRIVATE=true"
        return 0
    fi
    echo "IPAddressDeny=10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 fc00::/7 fe80::/10"
    private_dns_allow
}

# Записать юниты; 0 — если хоть один изменился
write_units() {
    local changed=0
    if put_file "/etc/systemd/system/$UNIT.service" <<EOF
[Unit]
Description=Infra Panel (учёт серверов, сайтов, доменов)
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$REPO
ExecStart=$NODE_DIR/bin/node dist/server/index.js
Restart=always
RestartSec=3
$(hardening)

[Install]
WantedBy=multi-user.target
EOF
    then changed=1; fi

    if put_file "/etc/systemd/system/$UNIT-backup.service" <<EOF
[Unit]
Description=Infra Panel: бэкап базы

[Service]
Type=oneshot
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$REPO
ExecStart=$NODE_DIR/bin/node dist/server/cli.js backup
ExecStartPost=/usr/bin/find $DATA_DIR/backups -name '*.db' -mtime +30 -delete
$(hardening)
EOF
    then changed=1; fi

    if put_file "/etc/systemd/system/$UNIT-backup.timer" <<EOF
[Unit]
Description=Infra Panel: бэкап базы каждую ночь

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
    then changed=1; fi
    [ "$changed" -eq 1 ]
}

ensure_units() {
    step "Сервис $UNIT и ежедневный бэкап"
    write_units || say "  без изменений"
    root systemctl daemon-reload
    root systemctl enable --quiet "$UNIT" "$UNIT-backup.timer"
    root systemctl start "$UNIT-backup.timer"
    root systemctl restart "$UNIT"
    sleep 2
    root systemctl is-active --quiet "$UNIT" || die "$UNIT не запустился: sudo journalctl -u $UNIT -n 50"
    say "  $UNIT active, слушает 127.0.0.1:$PORT"
}

ensure_nginx() {
    step "Nginx: $DOMAIN"
    local site="/etc/nginx/sites-available/$UNIT" link="/etc/nginx/sites-enabled/$UNIT"
    if root test -f "$site"; then
        root grep -q "proxy_pass http://127.0.0.1:$PORT;" "$site" \
            || die "$site уже есть, но проксирует не на 127.0.0.1:$PORT: $(root grep -m1 proxy_pass "$site" | xargs). Поправь proxy_pass или удали файл (sudo rm $site /etc/nginx/sites-enabled/$UNIT) и запусти install снова."
        say "  $site уже есть — не трогаю (certbot дописывает в него SSL)"
    else
        # X-Forwarded-For перезаписываем адресом клиента, а не дописываем: подставленный
        # клиентом заголовок не должен доезжать до панели.
        root tee "$site" >/dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    # Доступ только из доверенных сетей (офис, VPN) — раскомментировать и вписать адреса:
    # allow 203.0.113.10;
    # deny all;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
        say "  записал $site"
    fi
    [ -e "$link" ] || root ln -s "$site" "$link"
    # Битый конфиг в sites-enabled уронил бы и соседние сайты при следующем reload (например,
    # при продлении сертификата), поэтому при ошибке убираем свою ссылку.
    if ! root nginx -t 2>/dev/null; then
        root rm -f "$link"
        root nginx -t || true
        die "nginx -t не прошёл — свой сайт отключил, соседние сайты не тронуты. Поправь $site и запусти install снова."
    fi
    root systemctl reload nginx
    say "  nginx -t ок, перезагружен"
}

ensure_https() {
    step "HTTPS: $DOMAIN"
    if root test -d "/etc/letsencrypt/live/$DOMAIN"; then
        say "  сертификат уже есть"
        return 0
    fi
    getent ahostsv4 "$DOMAIN" >/dev/null \
        || die "$DOMAIN не резолвится. Добавь A-запись panel → IP сервера и запусти install снова — сделанные шаги не повторятся."
    root certbot --nginx -d "$DOMAIN" --redirect
}

ensure_admin() {
    step "Администратор"
    local users email name
    users="$(in_sandbox "node dist/server/cli.js list-users" data)"
    if [ -n "$users" ]; then
        say "  пользователи уже есть:"
        printf '%s\n' "$users" | sed 's/^/    /'
        return 0
    fi
    if [ ! -t 0 ]; then
        warn "нет терминала — первого админа создать руками: sudo -u $APP_USER -H bash -c 'cd $REPO && $NODE_DIR/bin/node dist/server/cli.js create-user --email E --name N --role admin'"
        return 0
    fi
    read -r -p "  Email первого администратора: " email
    read -r -p "  Имя: " name
    in_sandbox 'node dist/server/cli.js create-user --email "$1" --name "$2" --role admin' data "$email" "$name"
}

run_install() {
    preflight
    take_lock
    trap release_lock EXIT
    trap 'on_error $LINENO' ERR
    STARTED_AT="$(date '+%Y-%m-%d %H:%M:%S')"

    command -v nginx >/dev/null || die "nginx не установлен"
    command -v certbot >/dev/null || die "certbot не установлен"
    command -v g++ >/dev/null && command -v make >/dev/null || die "нужен build-essential: sudo apt install build-essential python3"

    # Порт занят чужим процессом — не наш сервис — значит, конфликт .
    if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN && ! systemctl is-active --quiet "$UNIT"; then
        die "порт $PORT уже занят: $(ss -ltnp "sport = :$PORT" 2>/dev/null | tail -n 1). Выбери другой: PANEL_PORT=8091 bash $SCRIPT_PATH install"
    fi

    install_node
    ensure_user
    ensure_repo
    ensure_env
    npm_ci
    build
    ensure_units
    ensure_nginx
    ensure_https
    ensure_admin
    mark_deployed "$(git_app rev-parse HEAD)"

    local problems=0
    post_checks 1 || problems=$?
    log_result "install $(short HEAD): $([ "$problems" -eq 0 ] && echo 'проверки чистые' || echo "проверок с вниманием: $problems")"

    say ""
    say "Готово: $SITE_URL"
    say "  • Войди и сразу включи 2FA: Настройки → Двухфакторная аутентификация."
    if [ "$NEW_KEY" -eq 1 ]; then
        say "  • Сохрани ключ шифрования в Passwork (без него пароли из бэкапа не расшифровать):"
        say "      sudo grep ENCRYPTION_KEY $REPO/.env"
    fi
    say "  • Оповещения: заполнить BOT_* и TELEGRAM_BOT_USERNAME в $REPO/.env (sudo -u $APP_USER nano …),"
    say "    затем sudo systemctl restart $UNIT. Подробности — README, раздел «Оповещения»."
    say "  • Бэкапы: каждую ночь в $DATA_DIR/backups, хранятся 30 дней."
    say "  • Следующие выкаты: bash $REPO/scripts/deploy.sh"
    [ "$problems" -eq 0 ] || exit 1
}

# ══ Выкат ════════════════════════════════════════════════════════════════

show_plan() {
    local from="$1" to="$2" changed
    say "Выкат $(short "$from") → $(short "$to"):"
    git_app log --oneline --no-decorate "$from..$to" | sed 's/^/  /'
    changed="$(git_app diff --name-only "$from" "$to")"
    say ""
    if all_match "$changed" "$NO_BUILD_RE"; then
        say "Только документы и скрипты — без сборки и рестарта."
        return 0
    fi
    if matches "$changed" "$MIGRATIONS_RE"; then
        say "Миграции базы: $(printf '%s\n' "$changed" | grep -E '^drizzle/[^/]+\.sql$' | sed 's:^drizzle/::' | tr '\n' ' ')"
        say "  → бэкап базы перед сборкой, применятся при старте."
    fi
    if matches "$changed" "$DEPS_RE"; then
        say "Зависимости менялись → npm ci."
    fi
    if all_match "$changed" "$NO_RESTART_RE"; then
        say "Сборка (npm run build) без рестарта — менялся только интерфейс."
    else
        say "Сборка (npm run build) → рестарт $UNIT."
    fi
}

phase_before_merge() {
    preflight
    as_app test -d "$REPO/.git" || die "нет репозитория в $REPO — сначала установка: bash $SCRIPT_PATH install"
    take_lock
    trap release_lock EXIT

    local branch head new deployed dirty
    branch="$(git_app symbolic-ref --quiet --short HEAD || true)"
    [ "$branch" = "$BRANCH" ] || die "на сервере ветка «${branch:-без ветки}», а выкатывается $BRANCH."
    dirty="$(git_app status --porcelain --untracked-files=no)"
    [ -z "$dirty" ] || die "на сервере незакоммиченные правки — выкат смешал бы их с релизом:
$dirty
Если это package-lock.json после npm install: git -C $REPO checkout -- package-lock.json"

    git_app fetch --quiet "$REMOTE" "$BRANCH"
    head="$(git_app rev-parse HEAD)"
    new="$(git_app rev-parse "$REMOTE/$BRANCH")"
    git_app merge-base --is-ancestor "$head" "$new" \
        || die "$BRANCH на сервере разошёлся с $REMOTE/$BRANCH — разобрать руками, скрипт не сливает."
    deployed="$(deployed_commit)"
    git_app merge-base --is-ancestor "$deployed" "$head" || deployed="$head"

    if [ "$deployed" = "$new" ]; then
        say "Нечего выкатывать: на сервере уже $(short "$new")."
        return 0
    fi
    if [ "$deployed" != "$head" ]; then
        warn "прошлый выкат не дошёл до конца: код на $(short "$head"), выкачено $(short "$deployed"). Шаги выполнятся для всего начиная с $(short "$deployed")."
    fi

    show_plan "$deployed" "$new"
    if [ "$DRY_RUN" -eq 1 ]; then
        say ""
        say "--dry-run: на сервере ничего не менял."
        return 0
    fi
    if [ "$ASSUME_YES" -eq 0 ]; then
        [ -t 0 ] || die "нет терминала для вопроса — запусти с --yes, если выкат без подтверждения задуман."
        local ans
        read -r -p "Выкатить? [y/N] " ans
        case "$ans" in
            y|Y|yes|д|Д|да) ;;
            *) die "выкат отменён, на сервере ничего не менял." ;;
        esac
    fi

    # Отметка «выкачено» — ДО merge: иначе повтор после сбоя принял бы код на диске
    # за выкаченный и пропустил бы шаги.
    mark_deployed "$deployed"
    git_app merge --ff-only --quiet "$REMOTE/$BRANCH"
    trap - EXIT
    exec env DEPLOY_REPO="$REPO" bash "$REPO/scripts/deploy.sh" --after-merge "$deployed" "$new"
}

phase_after_merge() {
    take_lock
    trap release_lock EXIT
    trap 'on_error $LINENO' ERR
    [ "$(git_app rev-parse HEAD)" = "$(git_app rev-parse "$TO")" ] \
        || die "после merge ожидался $(short "$TO"), а на диске $(short HEAD)."
    STARTED_AT="$(date '+%Y-%m-%d %H:%M:%S')"

    local changed restarted=0 problems=0 units=0
    changed="$(git_app diff --name-only "$FROM" "$TO")"

    # Юниты — из шаблонов этого скрипта: поменялся он — сверяем и пишем заново
    if matches "$changed" '^scripts/deploy\.sh$'; then
        step "Юниты systemd"
        if write_units; then
            units=1
            root systemctl daemon-reload
        else
            say "  без изменений"
        fi
    fi

    if all_match "$changed" "$NO_BUILD_RE" && [ "$units" -eq 0 ]; then
        mark_deployed "$TO"
        log_result "$(short "$FROM") → $(short "$TO"): только документы и скрипты — без шагов"
        return 0
    fi

    if matches "$changed" "$MIGRATIONS_RE"; then
        backup_db
    fi
    if matches "$changed" "$DEPS_RE" || ! as_app test -d "$REPO/node_modules"; then
        npm_ci
    fi
    all_match "$changed" "$NO_BUILD_RE" || build
    if ! all_match "$changed" "$NO_RESTART_RE" || [ "$units" -eq 1 ]; then
        STAGE="restart"
        restart_unit
        restarted=1
    fi
    trap - ERR
    mark_deployed "$TO"

    post_checks "$restarted" || problems=$?
    if [ "$problems" -eq 0 ]; then
        log_result "$(short "$FROM") → $(short "$TO"): выкачено, проверки чистые"
    else
        log_result "$(short "$FROM") → $(short "$TO"): выкачено, проверок с вниманием: $problems"
        exit 1
    fi
}

# ── Вход ─────────────────────────────────────────────────────────────────

AFTER_MERGE=0
while [ $# -gt 0 ]; do
    case "$1" in
        install) MODE=install ;;
        --dry-run) DRY_RUN=1 ;;
        --yes|-y) ASSUME_YES=1 ;;
        --after-merge)
            AFTER_MERGE=1
            FROM="${2:?--after-merge: нужен исходный коммит}"
            TO="${3:?--after-merge: нужен целевой коммит}"
            shift 2
            ;;
        -h|--help) usage; exit 0 ;;
        *) die "неизвестный аргумент: $1 (см. --help)" ;;
    esac
    shift
done

if [ "$MODE" = install ]; then
    run_install
elif [ "$AFTER_MERGE" -eq 1 ]; then
    phase_after_merge
else
    phase_before_merge
fi
