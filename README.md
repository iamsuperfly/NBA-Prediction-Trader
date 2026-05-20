# NBA Playoffs Prediction Market Trader

AI-powered automated trading strategy for NBA Playoffs prediction markets on [Polymarket](https://polymarket.com) (Polygon mainnet), built for the [NBA Prediction Market Hackathon](https://dorahacks.io) using [Canon by DEGA](https://github.com/DEGAorg/canon-tui).

---

## 🏀 Strategy Overview

This bot scans live NBA Playoffs markets on Polymarket, computes a statistical edge using real NBA data, and executes trades when the model probability diverges meaningfully from market odds.

**Model inputs:**
- Season win percentage (from ESPN API)
- Last 5 / last 10 game form
- Home/away split win rates
- Playoff seeding

**Position sizing:** Fractional Kelly criterion (25% of full Kelly) capped at `MAX_POSITION_USD`.

**Supported markets:**
- Series winner markets (e.g. "Will the Celtics beat the Knicks?")
- Game winner markets (today's scheduled games)

---

## 💼 Wallet

| | Value |
|---|---|
| **Address (public)** | `0xce16A1A0D39C564fb0479699662e4c5AEB042f11` |
| **Network** | Polygon Mainnet (Chain ID 137) |
| **Token** | USDC (for Polymarket positions) |

> ⚠️ Private key is stored only in Replit Secrets (`WALLET_PRIVATE_KEY`). Never committed to git.

### How to fund

1. **From Coinbase / Binance / Kraken:** Withdraw USDC or MATIC to the address above. Select **Polygon** network (not Ethereum mainnet — different chain!).
2. **From MetaMask:** Send MATIC (for gas) and USDC to `0xce16A1A0D39C564fb0479699662e4c5AEB042f11` on Polygon network.
3. **Bridge from Ethereum:** Use the [Polygon Bridge](https://wallet.polygon.technology/polygon/bridge) to move USDC from Ethereum → Polygon.

**You need:**
- ~0.5 MATIC for gas fees (< $0.20)
- USDC for trading positions (start with $10–$50 for testing)

---

## 🚀 Quickstart

```bash
# 1. Install dependencies
pnpm install

# 2. Copy env file and fill in your values
cp .env.example .env

# 3. Dry-run (no real trades — safe to test)
pnpm dry-run

# 4. Scan only — see opportunities without trading
pnpm scan

# 5. Live trading (real funds)
pnpm live
```

Or via Canon TUI:
```bash
./canon.sh
# then type: /canon-start
```

---

## 📁 Project Structure

```
src/
├── config.ts                 # Environment config (RPC, wallet, params)
├── types.ts                  # Shared TypeScript types
├── index.ts                  # Main bot loop
├── data/
│   ├── nba-client.ts         # Live NBA data (ESPN API)
│   └── polymarket-client.ts  # Polymarket CLOB + Gamma API
└── strategy/
    ├── predictor.ts          # Statistical model (win probability)
    ├── scanner.ts            # Market scanner + opportunity finder
    ├── sizer.ts              # Kelly criterion position sizing
    └── trader.ts             # Order execution (dry-run + live)
```

---

## ⚙️ Configuration

| Variable | Default | Description |
|---|---|---|
| `TRADING_MODE` | `dry-run` | `dry-run` or `live` |
| `MAX_POSITION_USD` | `10` | Max bet size per trade in USD |
| `KELLY_FRACTION` | `0.25` | Fractional Kelly multiplier (0–1) |
| `MIN_EDGE_THRESHOLD` | `0.03` | Minimum model vs market edge to trade (3%) |
| `SCAN_INTERVAL_MS` | `60000` | How often to scan markets (ms) |
| `POLYGON_RPC_URL` | `https://polygon-rpc.com` | Polygon JSON-RPC endpoint |

---

## 📊 Status

| | |
|---|---|
| **Canon TUI** | v0.7.21 ✅ |
| **DEGA Core** | v0.1.8 ✅ |
| **Wallet** | Generated ✅ |
| **Data feeds** | ESPN NBA API + Polymarket CLOB ✅ |
| **Strategy** | Statistical model (Kelly sizing) ✅ |
| **Trading mode** | Dry-run (switch to live after funding) |

---

## 🔒 Security

- Private key stored **only** in Replit Secrets — never in code or git history
- `.env` is in `.gitignore`
- Start with `dry-run` mode and small positions when going live
- Canon's `canon.sh` launcher handles agent session isolation

---

## 🛠️ Built With

- [Canon TUI](https://github.com/DEGAorg/canon-tui) — agent TUI for prediction market automation
- [DEGA Core](https://github.com/DEGAorg/claude-code-config) — AI agent orchestration framework
- [Polymarket CLOB API](https://docs.polymarket.com) — on-chain prediction market
- [ESPN NBA API](https://site.api.espn.com/apis/site/v2/sports/basketball/nba) — live game data
- [ethers.js v6](https://docs.ethers.org/v6/) — Polygon wallet interaction
- TypeScript + Node.js 24

---

## 📝 Hackathon

Built for the **NBA Prediction Market Hackathon** on DoraHacks.
