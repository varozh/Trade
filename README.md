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
