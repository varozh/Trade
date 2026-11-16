# Сообщение в Telegram через бота (VPS)

Скрипт `scripts/tg-hello.js` отправляет «привет» (или любой текст) в Telegram. Он отдельный: без новых зависимостей, со своими переменными в `.env` и своим логом, поэтому сканер и ВК-рассылку не задевает.

## 1. Создать бота

1. В Telegram открыть **@BotFather** → `/newbot`.
2. Ввести имя бота и username (должен заканчиваться на `bot`).
3. BotFather пришлёт токен вида `123456789:AAH...` (HTTP API) — это `TG_BOT_TOKEN`. Никому его не показывайте.
4. Найти своего бота по username и нажать **Start**. Без этого бот не сможет писать вам первым.

Для группы: добавить бота в группу и написать в ней любое сообщение. Если бот не видит сообщения — в BotFather `/setprivacy` → бот → `Disable`, затем написать снова.

## 2. Настроить на сервере

```bash
cd ~/trade && git pull               # подтянуть скрипт
cp .env .env.bak                     # резервная копия
nano .env                            # ДОПИСАТЬ в конец: TG_BOT_TOKEN=123456789:AAH...
npm run tg:chat-id                   # покажет TG_CHAT_ID=... (если пусто — напишите боту /start и повторите)
nano .env                            # ДОПИСАТЬ: TG_CHAT_ID=...
npm run tg:hello                     # должно прийти «привет»
```

Пример конца `.env` (старые строки не трогать; без пробелов вокруг `=` и без кавычек):

```
TG_BOT_TOKEN=123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxx
TG_CHAT_ID=987654321
```

Свой текст: `node --env-file=.env scripts/tg-hello.js "сервер жив"`.

Ошибки:
- `chat not found` — не нажат **Start** у бота.
- зависает / ошибка сети — хостинг блокирует `api.telegram.org`. Проверка: `curl -sI https://api.telegram.org | head -1`.

## 3. По расписанию (необязательно)

```bash
crontab -l > ~/crontab.bak           # сохранить текущие задачи
crontab -e
```

**Дописать** строку в конец, существующие не трогать:

```cron
# каждый день в 06:00 UTC (09:00 МСК)
0 6 * * * cd $HOME/trade && /usr/bin/node --env-file=.env scripts/tg-hello.js >> tg.log 2>&1
```

Проверить: `crontab -l` — должны быть и старые строки, и новая. Откатить: `crontab ~/crontab.bak`.
