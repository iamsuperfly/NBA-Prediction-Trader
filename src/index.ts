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

async function printBanner(): Promise<void> {
  const balance = await getWalletBalance();
  console.log(`
╔══════════════════════════════════════════════════════════╗
║        NBA PLAYOFFS PREDICTION MARKET TRADER             ║
║                  Powered by Canon + DEGA                 ║
╠══════════════════════════════════════════════════════════╣
║  Mode     : ${config.trading.mode.padEnd(44)}║
║  Wallet   : ${config.wallet.address.padEnd(44)}║
║  Balance  : ${`${balance.matic} MATIC (~$${balance.usdcApprox})`?.padEnd(44) ?? "".padEnd(44)}║
║  Max Size : $${String(config.trading.maxPositionUsd).padEnd(43)}║
║  Kelly    : ${`${(config.trading.kellyFraction * 100).toFixed(0)}% fractional`?.padEnd(44) ?? "".padEnd(44)}║
║  Min Edge : ${`${(config.trading.minEdgeThreshold * 100).toFixed(0)}%`?.padEnd(44) ?? "".padEnd(44)}║
╚══════════════════════════════════════════════════════════╝
  `);
}

async function runScan(): Promise<void> {
  stats.totalScans++;
  stats.lastScanAt = new Date().toISOString();

  console.log(`\n[${new Date().toLocaleTimeString()}] Scan #${stats.totalScans} starting...`);

  const opportunities = await scanForOpportunities();
  stats.opportunitiesFound += opportunities.length;

  if (opportunities.length === 0) {
    console.log("[scanner] No opportunities found above edge threshold.");
    return;
  }

  console.log(`\n[scanner] ${opportunities.length} opportunit${opportunities.length === 1 ? "y" : "ies"} found:\n`);
  opportunities.forEach((opp, i) => {
    console.log(
      `  ${i + 1}. ${opp.signal} ${opp.market.question.slice(0, 60)}...`
    );
    console.log(
      `     Edge: ${(opp.edge * 100).toFixed(1)}% | Size: $${opp.suggestedSizeUsd.toFixed(2)} | Vol: $${(opp.market.volumeNum / 1000).toFixed(0)}k`
    );
  });

  if (scanOnly) {
    console.log("\n[scan-only] Skipping trade execution.");
    return;
  }

  const top = opportunities.slice(0, 3);
  const results: TradeResult[] = [];

  for (const opp of top) {
    if (opp.market.liquidityNum < 500) {
      console.log(`[trader] Skipping low-liquidity market ($${opp.market.liquidityNum.toFixed(0)})`);
      continue;
    }
    const result = await executeTrade(opp);
    results.push(result);
    stats.tradesExecuted++;
    if (result.simulatedPnl !== undefined) {
      stats.dryRunPnl += result.simulatedPnl;
    }
  }

  printStats(results);
}

function printStats(latest: TradeResult[]): void {
  const successCount = latest.filter((r) => r.success).length;
  console.log(`
[stats] Session Summary
  Scans          : ${stats.totalScans}
  Opportunities  : ${stats.opportunitiesFound}
  Trades         : ${stats.tradesExecuted}
  Latest batch   : ${successCount}/${latest.length} executed
  Dry-run PnL    : $${stats.dryRunPnl >= 0 ? "+" : ""}${stats.dryRunPnl.toFixed(4)}
  Running since  : ${stats.startedAt}
  `);
}

async function main(): Promise<void> {
  await printBanner();

  if (config.trading.mode === "live") {
    console.log("⚠️  LIVE TRADING MODE — real funds at risk. Ctrl-C to abort. Starting in 5s...");
    await new Promise((r) => setTimeout(r, 5000));
  }

  await runScan();

  if (!scanOnly) {
    console.log(
      `\n[bot] Next scan in ${config.trading.scanIntervalMs / 1000}s. Ctrl-C to stop.`
    );
    setInterval(runScan, config.trading.scanIntervalMs);
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
