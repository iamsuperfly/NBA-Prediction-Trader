# NBA Playoffs Prediction Market Trader

AI-powered automated trading bot for NBA Playoffs prediction markets on [Polymarket](https://polymarket.com) (Polygon mainnet). Built for the **NBA Prediction Market Hackathon** on DoraHacks using [Canon by DEGA](https://github.com/DEGAorg/canon-tui).

---

## Strategy Overview

The bot uses a **statistical value-betting approach** — it builds a model probability for each market outcome, compares it to the current market price, and only bets when the **expected value (EV) exceeds +8%**.

### Model Inputs

| Signal | Weight | Source |
|--------|--------|--------|
| Season win percentage | 30% | ESPN API (playoff games) |
| Last 10 games form | 22% | ESPN schedule |
| Last 5 games form | 18% | ESPN schedule |
| Home-court advantage | 15% | Game location |
| Point differential (L5) | 8% | ESPN schedule |
| Home/away split | 4% | ESPN schedule |
| Injury impact | 3% | ESPN injury reports |
| Series momentum | +bonus | ESPN playoff results |

### Position Sizing

Uses **25% fractional Kelly criterion**:

```
Full Kelly = (b·p − q) / b
Position  = min(25% × Full Kelly, maxPositionUsd)
```

Where `b` = decimal odds − 1, `p` = model probability, `q` = 1 − p.

### Trade Filters

A trade is only executed when **all** of the following are true:

1. **EV ≥ +8%** — `EV = p × (1/price − 1) − (1 − p)` exceeds the threshold
2. **Confidence ≥ 45%** — model has sufficient signal strength
3. **Liquidity ≥ $1,000** — enough depth to fill the order
4. **Volume ≥ $50,000** — market is active and price-discovered
5. **Market accepting orders** — CLOB is open (live mode only)

### Series Momentum

For playoff series markets, the model adds an adjustment based on:
- **Current series record** (e.g. up 2-0 → +25% log-odds boost)
- **Last game winner** (momentum, +12% log-odds)
- **Home court pattern** (alternating wins increase home team edge)
- **Must-win situations** (down 3-0 → desperation factor)

### Injury Adjustment

Key player injuries reduce the team's model probability:
- **Out** → full impact weight (PG: −12%, C/PF: −8%)
- **Doubtful** → 75% weight
- **Questionable** → 40% weight
- **Day-to-Day** → 20% weight

---

## Wallet

| | |
|---|---|
| **Address** | `0xce16A1A0D39C564fb0479699662e4c5AEB042f11` |
| **Network** | Polygon Mainnet (Chain ID 137) |
| **Trading token** | USDC (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`) |

> ⚠️ Private key is stored only in Replit Secrets (`WALLET_PRIVATE_KEY`). Never committed to git.

### How to Fund

1. **From Coinbase / Binance / Kraken** — withdraw USDC or MATIC and select **Polygon** network when sending to the address above (not Ethereum mainnet — different chain).
2. **From MetaMask** — send MATIC (for gas, ~0.5 MATIC ≈ $0.20) and USDC on Polygon network.
3. **Bridge from Ethereum** — use the [Polygon Bridge](https://wallet.polygon.technology/polygon/bridge).

**Recommended starting balance:** 0.5 MATIC (gas) + $20–$100 USDC (positions)

---

## Quickstart

```bash
# Install dependencies
pnpm install

# Copy env template
cp .env.example .env
# Fill in WALLET_PRIVATE_KEY and WALLET_ADDRESS

# Scan for opportunities — no trades executed
pnpm scan

# Dry-run — simulates trades, shows expected PnL
pnpm dry-run

# Live trading — real USDC positions (fund wallet first!)
pnpm live
```

Via Canon TUI:
```bash
./canon.sh
# Inside session: /canon-start
```

---

## Project Structure

```
src/
├── config.ts                   # Env-based configuration
├── types.ts                    # Shared TypeScript types
├── index.ts                    # Main bot loop (banner, scan, trade, stats)
├── data/
│   ├── nba-client.ts           # Live NBA data via ESPN API
│   │   ├── getPlayoffGames()   # Today's scheduled/live games
│   │   ├── getPlayoffStandings() # Conference standings + seeds
│   │   ├── getTeamForm()       # Last 5/10 games, home/away splits, point diff
│   │   ├── getInjuryReports()  # Current injury status per team
│   │   └── getSeriesState()    # Current playoff series record
│   └── polymarket-client.ts    # Polymarket CLOB + Gamma API
│       ├── getNBAMarkets()     # All active NBA markets (merged from CLOB + Gamma)
│       ├── getPlayoffSeriesMarkets() # Series/championship markets only
│       ├── getGameMarkets()    # Game-specific markets
│       ├── getOrderBook()      # Live bid/ask for a token
│       └── getMarketWithTokens() # Fetch market with token IDs + prices
└── strategy/
    ├── predictor.ts            # Statistical model — game + series predictions
    ├── scanner.ts              # Market scanner — find EV > +8% opportunities
    ├── sizer.ts                # Kelly criterion + EV computation
    └── trader.ts               # Order execution (dry-run / live + EIP-712 signing)
```

---

## Configuration

Copy `.env.example` → `.env` and fill in your values.

| Variable | Default | Description |
|---|---|---|
| `WALLET_PRIVATE_KEY` | — | **Required.** Polygon wallet private key |
| `WALLET_ADDRESS` | wallet address | Your Polygon wallet address |
| `TRADING_MODE` | `dry-run` | `dry-run` or `live` |
| `MAX_POSITION_USD` | `10` | Max position size per trade (USD) |
| `KELLY_FRACTION` | `0.25` | Fractional Kelly multiplier |
| `MIN_EV_THRESHOLD` | `0.08` | Minimum expected value to bet (8%) |
| `MIN_LIQUIDITY_USD` | `1000` | Skip markets with less liquidity |
| `MIN_VOLUME_USD` | `50000` | Skip markets with less volume |
| `SCAN_INTERVAL_MS` | `60000` | Scan frequency (milliseconds) |
| `POLYGON_RPC_URL` | polygon-rpc.com | Polygon JSON-RPC endpoint |

---

## How the Bot Loop Works

```
1. Print banner (wallet address, USDC balance, config)
2. Every SCAN_INTERVAL_MS seconds:
   a. Fetch today's scheduled NBA playoff games
   b. Fetch active NBA series markets from Polymarket
   c. For each game/series:
      - Build model probability (form, injuries, series state)
      - Fetch live market price from CLOB order book
      - Compute EV = p × (1/price − 1) − (1 − p)
      - Skip if EV < +8%
      - Compute fractional Kelly position size
   d. Execute top 3 opportunities (ranked by EV)
      - dry-run: log simulated trade + expected PnL
      - live: sign EIP-712 order → submit to Polymarket CLOB
3. Print session stats (scans, trades, simulated PnL)
```

---

## Live Trading Details

In live mode the bot:

1. Checks USDC balance — skips if insufficient
2. Fetches live order book midpoint for accurate pricing
3. Signs an EIP-712 structured order using the wallet private key
4. Submits to the Polymarket CLOB at `POST /order`
5. Logs the order ID on success

The signing uses Polymarket's CTF Exchange contract on Polygon:
`0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`

---

## Risk Disclaimer

Prediction market trading involves significant financial risk. Start with small positions and always use `dry-run` mode first to verify the strategy is behaving as expected before committing real funds.

---

## Built With

- [Canon TUI v0.7.21](https://github.com/DEGAorg/canon-tui)
- [DEGA Core v0.1.8](https://github.com/DEGAorg/claude-code-config)
- [Polymarket CLOB API](https://docs.polymarket.com)
- [ESPN NBA API](https://site.api.espn.com/apis/site/v2/sports/basketball/nba)
- [ethers.js v6](https://docs.ethers.org/v6/) — EIP-712 order signing + USDC balance
- TypeScript 5 + Node.js 24 + pnpm
