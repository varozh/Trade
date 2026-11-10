# BingX Futures MCP Server

MCP‑сервер для бессрочных фьючерсов BingX (USDT‑M): рыночные данные, баланс, позиции, ордера, история и торговля.

## Установка

```bash
cd D:\002_BASE\Trade
npm install
```

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `BINGX_API_KEY` | — | API Key |
| `BINGX_SECRET_KEY` | — | Secret Key |
| `BINGX_DEMO` | `true` | `true` — демо‑счёт (VST), `false` — реальный счёт |
| `BINGX_ENABLE_TRADING` | `false` | разрешить инструменты, которые меняют счёт (ордера, плечо, закрытие) |
| `BINGX_MAX_NOTIONAL_USDT` | нет | лимит объёма одного ордера в USDT |
| `BINGX_MAX_LEVERAGE` | нет | лимит плеча |

По умолчанию сервер работает **на демо‑счёте, торговля выключена**. Сначала проверьте всё на демо.

## Проверка связи

```powershell
$env:BINGX_API_KEY="..."; $env:BINGX_SECRET_KEY="..."; npm run check
```

## Сканер рынка

Тренд (EMA20/50 на 4ч и 1д), RSI, ATR, funding и диапазон за 30 дней по списку фьючерсов, плюс подсказка по сетапу. Нужны только публичные данные, ключи не требуются.

```bash
npm run scan                    # список избранного (WATCHLIST в scripts/scan.js)
npm run scan -- BTC ETH SOL     # свои тикеры
npm run scan -- --json          # вывод в JSON
```

Как добавлять и удалять токены в списке: [Инструкция по добавлению новых токенов/watchlist.md](<Инструкция по добавлению новых токенов/watchlist.md>).

## Отправка сканера во ВКонтакте по расписанию (VPS)

Скрипт отправляет короткую сводку от имени сообщества: только монеты с сигналом, сгруппированные по типу сетапа. Полная таблица в мессенджере не читается.

```bash
npm run scan -- --vk-dry        # показать сообщение, ничего не отправляя
npm run scan:vk                 # просканировать и отправить (берёт ключи из .env)
```

### Подготовка ВК (один раз)

1. В сообществе: «Управление → Сообщения» — включить. «Работа с API → Ключи доступа» — ключ с правом «Сообщения сообщества».
2. Напишите сообществу любое сообщение со своей страницы. Без этого ВК не даст сообществу писать вам.

### Установка на VPS (Ubuntu/Debian)

```bash
# Node.js 22 (нужен >= 20.6 для --env-file)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

git clone https://github.com/varozh/Trade.git ~/trade
cd ~/trade && npm install

nano .env                            # вписать строки VK_TOKEN=... и VK_USER_ID=...
npm run vk:users                     # если id неизвестен: покажет VK_USER_ID (нужен только VK_TOKEN)
npm run scan:vk                      # проверка: сообщение должно прийти в ВК
```

### Расписание (cron)

`crontab -e` и добавить строку (время сервера обычно UTC, проверьте командой `date`):

```cron
# каждые 4 часа в :05, после закрытия 4h-свечи
5 */4 * * * cd $HOME/trade && /usr/bin/node --env-file=.env scripts/scan.js --vk >> scan.log 2>&1
```

Другие варианты: `0 6 * * *` — раз в день в 06:00 UTC (09:00 МСК), `0 * * * *` — каждый час.

Обновить код на сервере: `cd ~/trade && git pull`.

## Подключение к Claude Code

```bash
claude mcp add bingx --scope user -e BINGX_API_KEY=ВАШ_КЛЮЧ -e BINGX_SECRET_KEY=ВАШ_СЕКРЕТ -e BINGX_DEMO=true -e BINGX_ENABLE_TRADING=false -e BINGX_MAX_NOTIONAL_USDT=100 -e BINGX_MAX_LEVERAGE=5 -- node D:\002_BASE\Trade\src\server.js
```

## Подключение к Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bingx": {
      "command": "node",
      "args": ["D:\\002_BASE\\Trade\\src\\server.js"],
      "env": {
        "BINGX_API_KEY": "ВАШ_КЛЮЧ",
        "BINGX_SECRET_KEY": "ВАШ_СЕКРЕТ",
        "BINGX_DEMO": "true",
        "BINGX_ENABLE_TRADING": "false",
        "BINGX_MAX_NOTIONAL_USDT": "100",
        "BINGX_MAX_LEVERAGE": "5"
      }
    }
  }
}
```

## Инструменты

**Рынок (без ключей):** `get_price`, `get_ticker_24h`, `get_klines`, `get_orderbook`, `get_funding_rate`, `get_contract_info`

**Счёт (только чтение):** `get_status`, `get_balance`, `get_positions`, `get_open_orders`, `get_order`, `get_order_history`, `get_trade_fills`, `get_income_history`, `get_leverage`, `get_margin_type`, `get_position_mode`

**Торговля (нужен `BINGX_ENABLE_TRADING=true`):**
- `open_position` — вход в LONG/SHORT, market/limit, плечо, SL/TP
- `close_position` — полное или частичное закрытие
- `set_stop_loss_take_profit` — SL/TP на открытую позицию
- `set_leverage`, `set_margin_type`
- `place_order` — произвольный ордер (стоп, трейлинг и т.д.)
- `cancel_order`, `cancel_all_orders`

Поддерживаются оба режима позиций: hedge (LONG/SHORT отдельно) и one‑way.

## Безопасность

- Для API‑ключа не включайте право на вывод средств и привяжите ключ к своему IP.
- Не коммитьте ключи: `.env` уже в `.gitignore`.
- Торговые инструменты помечены как destructive, поэтому клиент MCP запрашивает подтверждение перед каждым вызовом.
