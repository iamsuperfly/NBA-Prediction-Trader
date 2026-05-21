import "dotenv/config";
import { config } from "./config.js";
import { scanForOpportunities } from "./strategy/scanner.js";
import { executeTrade, getWalletBalance } from "./strategy/trader.js";
import { persistSession } from "./report/logger.js";
import type { StrategyStats, TradeResult } from "./types.js";

const SESSION_ID = `session-${Date.now()}`;
const MODE: "dry-run" | "live" | "scan" = process.argv.includes("--scan-only")
  ? "scan"
  : (config.trading.mode as "dry-run" | "live");

const stats: StrategyStats = { totalScans: 0, opportunitiesFound: 0, tradesExecuted: 0, dryRunPnl: 0, startedAt: new Date().toISOString(), lastScanAt: new Date().toISOString() };
const scanOnly = process.argv.includes("--scan-only");
const tradeResults: TradeResult[] = [];

function flushSession(): void {
  persistSession({
    sessionId: SESSION_ID,
    startedAt: stats.startedAt,
    endedAt: new Date().toISOString(),
    mode: MODE,
    stats: { ...stats },
    trades: [...tradeResults],
  });
}

async function printBanner(): Promise<void> {
  const modeIcon = config.trading.mode === "dry-run" ? "DRY-RUN (simulation)" : "LIVE (real money)";
  console.log(`
╔════════════════════════════════════════════════════════════╗
║       NBA PLAYOFFS PREDICTION MARKET TRADER                ║
║         Canon + DEGA  |  Polymarket on Polygon             ║
╠════════════════════════════════════════════════════════════╣
║  Mode     : ${modeIcon.padEnd(46)}║
║  Wallet   : ${config.wallet.address.padEnd(46)}║
╠════════════════════════════════════════════════════════════╣
║  Strategy : EV > +8% | 25% fractional Kelly               ║
║  Min EV   : +${(config.trading.minEvThreshold * 100).toFixed(0).padEnd(44)}%║
║  Max size : $${String(config.trading.maxPositionUsd).padEnd(45)}║
║  Min liq  : $${String(config.trading.minLiquidityUsd).padEnd(45)}║
╚════════════════════════════════════════════════════════════╝
`);
  if (config.trading.mode === "live") {
    console.log("⚠️  LIVE TRADING — real USDC will be spent. Ctrl-C to abort.\n");
    await sleep(3000);
  }
  if (!scanOnly) {
    getWalletBalance().then((b) => {
      if (b.usdc !== "N/A") console.log(`[wallet] USDC: $${b.usdc} | MATIC: ${b.matic}`);
    }).catch(() => {});
  }
}

async function runScan(): Promise<void> {
  stats.totalScans++;
  stats.lastScanAt = new Date().toISOString();
  const ts = new Date().toLocaleTimeString();
  console.log(`\n${"═".repeat(62)}\n[${ts}] SCAN #${stats.totalScans}\n${"═".repeat(62)}`);

  const opportunities = await scanForOpportunities();
  stats.opportunitiesFound += opportunities.length;

  if (opportunities.length === 0) {
    console.log("[scanner] No opportunities meet EV ≥ +8% threshold right now.\n         (Markets are efficiently priced — waiting for mispricing.)");
    flushSession();
    return;
  }

  console.log(`\n[scanner] ${opportunities.length} opportunit${opportunities.length === 1 ? "y" : "ies"} found:\n`);
  opportunities.forEach((opp, i) => {
    console.log(`  ${(i + 1).toString().padStart(2)}. [${opp.signal}] ${opp.market.question.slice(0, 55)}`);
    console.log(`      EV +${(opp.expectedValue * 100).toFixed(1)}% | Kelly ${(opp.kellyFraction * 100).toFixed(1)}% | Size $${opp.suggestedSizeUsd.toFixed(2)} | Conf ${(opp.confidence * 100).toFixed(0)}% | $${(opp.market.liquidityNum / 1000).toFixed(0)}k liq`);
    opp.factors.slice(0, 2).forEach((f) => console.log(`         ${f}`));
    console.log("");
  });

  if (scanOnly) {
    console.log("[scan-only] Run pnpm dry-run to simulate trades, or pnpm live for real trades.");
    flushSession();
    return;
  }

  for (const opp of opportunities.slice(0, 3)) {
    if (!opp.market.acceptingOrders && config.trading.mode === "live") {
      console.log(`[trader] Market not accepting orders: ${opp.market.question.slice(0, 50)}`);
      continue;
    }
    const result = await executeTrade(opp);
    tradeResults.push(result);
    stats.tradesExecuted++;
    if (result.simulatedPnl !== undefined) stats.dryRunPnl += result.simulatedPnl;
  }

  flushSession();
  printSessionStats();
}

function printSessionStats(): void {
  const wins = tradeResults.filter((r) => (r.simulatedPnl ?? 0) > 0).length;
  const losses = tradeResults.filter((r) => (r.simulatedPnl ?? -1) <= 0 && r.simulatedPnl !== undefined).length;
  console.log(`\n${"─".repeat(62)}\n[stats] Scans: ${stats.totalScans} | Opportunities: ${stats.opportunitiesFound} | Trades: ${stats.tradesExecuted}${config.trading.mode === "dry-run" ? ` | W/L: ${wins}/${losses} | Sim PnL: ${stats.dryRunPnl >= 0 ? "+" : ""}$${stats.dryRunPnl.toFixed(4)}` : ""}\n${"─".repeat(62)}`);
  console.log(`[report] Run pnpm report to generate REPORT.md`);
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function main(): Promise<void> {
  await printBanner();
  await runScan();
  if (!scanOnly) {
    console.log(`\n[bot] Next scan in ${config.trading.scanIntervalMs / 1000}s. Ctrl-C to stop.`);
    const iv = setInterval(runScan, config.trading.scanIntervalMs);
    process.on("SIGINT", () => {
      clearInterval(iv);
      console.log("\n[bot] Stopped.");
      flushSession();
      printSessionStats();
      process.exit(0);
    });
  }
}

main().catch((err) => { console.error("[fatal]", err); process.exit(1); });
