import "dotenv/config";
import { config } from "./config.js";
import { scanForOpportunities } from "./strategy/scanner.js";
import { executeTrade, getWalletBalance } from "./strategy/trader.js";
import type { StrategyStats, TradeResult } from "./types.js";

const stats: StrategyStats = {
  totalScans: 0,
  opportunitiesFound: 0,
  tradesExecuted: 0,
  dryRunPnl: 0,
  startedAt: new Date().toISOString(),
  lastScanAt: new Date().toISOString(),
};

const scanOnly = process.argv.includes("--scan-only");
const tradeResults: TradeResult[] = [];

async function printBanner(): Promise<void> {
  const balance = await getWalletBalance();
  const mode = config.trading.mode.toUpperCase();
  const modeIcon = config.trading.mode === "dry-run" ? "🔵 DRY-RUN" : "🔴 LIVE";

  console.log(`
╔════════════════════════════════════════════════════════════╗
║       NBA PLAYOFFS PREDICTION MARKET TRADER                ║
║         Canon + DEGA  |  Polymarket on Polygon             ║
╠════════════════════════════════════════════════════════════╣
║  Mode     : ${modeIcon.padEnd(46)}║
║  Wallet   : ${config.wallet.address.padEnd(46)}║
║  USDC     : $${balance.usdc.padEnd(45)}║
║  MATIC    : ${balance.matic.padEnd(46)}║
╠════════════════════════════════════════════════════════════╣
║  Strategy Parameters                                       ║
║  Min EV   : +${(config.trading.minEvThreshold * 100).toFixed(0).padEnd(44)}%║
║  Kelly    : ${(config.trading.kellyFraction * 100).toFixed(0).padEnd(44)}% fractional║
║  Max size : $${String(config.trading.maxPositionUsd).padEnd(45)}║
║  Min liq  : $${String(config.trading.minLiquidityUsd).padEnd(45)}║
║  Interval : ${(config.trading.scanIntervalMs / 1000).toFixed(0).padEnd(43)}s║
╚════════════════════════════════════════════════════════════╝
`);

  if (config.trading.mode === "live") {
    console.log("⚠️  LIVE TRADING MODE — real USDC will be spent.");
    console.log("   Ctrl-C to abort. Continuing in 5 seconds...\n");
    await sleep(5000);
  }
}

async function runScan(): Promise<void> {
  stats.totalScans++;
  stats.lastScanAt = new Date().toISOString();

  const ts = new Date().toLocaleTimeString();
  console.log(`\n${"═".repeat(62)}`);
  console.log(`[${ts}] SCAN #${stats.totalScans}`);
  console.log(`${"═".repeat(62)}`);

  const opportunities = await scanForOpportunities();
  stats.opportunitiesFound += opportunities.length;

  if (opportunities.length === 0) {
    console.log("[scanner] No opportunities meet EV ≥ +8% threshold.");
    return;
  }

  console.log(`\n[scanner] ${opportunities.length} opportunit${opportunities.length === 1 ? "y" : "ies"} found:\n`);
  opportunities.forEach((opp, i) => {
    const evStr = `EV +${(opp.expectedValue * 100).toFixed(1)}%`;
    const sizeStr = `$${opp.suggestedSizeUsd.toFixed(2)}`;
    const liqStr = `$${(opp.market.liquidityNum / 1000).toFixed(0)}k liq`;
    console.log(`  ${(i + 1).toString().padStart(2)}. [${opp.signal}] ${opp.market.question.slice(0, 55)}`);
    console.log(`      ${evStr} | Kelly ${(opp.kellyFraction * 100).toFixed(1)}% | Size ${sizeStr} | ${liqStr} | Conf ${(opp.confidence * 100).toFixed(0)}%\n`);
  });

  if (scanOnly) {
    console.log("[scan-only] Skipping trade execution.");
    return;
  }

  const top = opportunities.slice(0, 3);
  for (const opp of top) {
    if (!opp.market.acceptingOrders && config.trading.mode === "live") {
      console.log(`[trader] Market not accepting orders: ${opp.market.question.slice(0, 50)}`);
      continue;
    }

    const result = await executeTrade(opp);
    tradeResults.push(result);
    stats.tradesExecuted++;
    if (result.simulatedPnl !== undefined) {
      stats.dryRunPnl += result.simulatedPnl;
    }
  }

  printSessionStats();
}

function printSessionStats(): void {
  const wins = tradeResults.filter((r) => (r.simulatedPnl ?? 0) > 0).length;
  const losses = tradeResults.filter((r) => (r.simulatedPnl ?? 0) <= 0 && r.simulatedPnl !== undefined).length;

  console.log(`\n${"─".repeat(62)}`);
  console.log("[stats] Session Summary");
  console.log(`  Scans           : ${stats.totalScans}`);
  console.log(`  Opportunities   : ${stats.opportunitiesFound}`);
  console.log(`  Trades          : ${stats.tradesExecuted}`);
  if (config.trading.mode === "dry-run") {
    console.log(`  Simulated W/L   : ${wins}W / ${losses}L`);
    console.log(`  Simulated PnL   : ${stats.dryRunPnl >= 0 ? "+" : ""}$${stats.dryRunPnl.toFixed(4)}`);
  }
  console.log(`  Started         : ${stats.startedAt}`);
  console.log(`${"─".repeat(62)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  await printBanner();
  await runScan();

  if (!scanOnly) {
    console.log(`\n[bot] Next scan in ${config.trading.scanIntervalMs / 1000}s. Ctrl-C to stop.`);
    const interval = setInterval(runScan, config.trading.scanIntervalMs);
    process.on("SIGINT", () => {
      clearInterval(interval);
      console.log("\n[bot] Shutting down...");
      printSessionStats();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
