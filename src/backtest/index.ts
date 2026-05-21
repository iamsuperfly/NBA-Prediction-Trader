import "dotenv/config";
import { fetchHistoricalNBAMarkets } from "./history-fetcher.js";
import { runBacktest, type BacktestStats } from "./engine.js";

const DAYS = Number(process.argv[2] ?? "30");
const MIN_EV   = Number(process.env.MIN_EV_THRESHOLD ?? "0.08");
const KELLY    = Number(process.env.KELLY_FRACTION   ?? "0.25");
const MAX_POS  = Number(process.env.MAX_POSITION_USD ?? "10");
const MODEL_EDGE_PCT = 0.15;

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function bar(val: number, max: number, width = 20): string {
  const filled = Math.round(clamp(val / max, 0, 1) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
function fmtPnl(n: number): string {
  return `${n >= 0 ? "+" : ""}$${n.toFixed(4)}`;
}

async function main(): Promise<void> {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║       NBA PREDICTION MARKET BACKTESTER                     ║
║         Canon + DEGA  |  Polymarket Historical Data        ║
╠════════════════════════════════════════════════════════════╣
║  Window   : Last ${String(DAYS).padEnd(41)}days║
║  EV thresh: +${(MIN_EV * 100).toFixed(0).padEnd(45)}%║
║  Kelly    : ${(KELLY * 100).toFixed(0).padEnd(45)}%║
║  Max size : $${String(MAX_POS).padEnd(45)}║
╚════════════════════════════════════════════════════════════╝
`);

  console.log(`[backtest] Fetching last ${DAYS} days of NBA Polymarket history...`);
  const markets = await fetchHistoricalNBAMarkets(DAYS);

  if (markets.length === 0) {
    console.log("[backtest] No resolved NBA markets found via CLOB price-history.");
    console.log("           Running synthetic stress-test on known 2025 NBA markets...\n");
    runSyntheticBacktest();
    return;
  }

  console.log(`[backtest] Replaying strategy over ${markets.length} markets...\n`);
  const stats = runBacktest(markets, { minEvThreshold: MIN_EV, kellyFraction: KELLY, maxPositionUsd: MAX_POS, modelEdgePct: MODEL_EDGE_PCT });
  printLiveResults(stats);
}

function runSyntheticBacktest(): void {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  SYNTHETIC BACKTEST — Known 2025 NBA Playoffs Markets");
  console.log("══════════════════════════════════════════════════════════════\n");

  const scenarios = [
    { label: "OKC win NBA Finals",      modelProb: 0.62, marketProb: 0.51, resolved: 1 },
    { label: "CLE win NBA Finals",      modelProb: 0.40, marketProb: 0.35, resolved: 0 },
    { label: "NYK win NBA Finals",      modelProb: 0.30, marketProb: 0.28, resolved: 0 },
    { label: "OKC win West Conference", modelProb: 0.71, marketProb: 0.60, resolved: 1 },
    { label: "CLE win East Conference", modelProb: 0.58, marketProb: 0.48, resolved: 1 },
    { label: "OKC win series vs MIN",   modelProb: 0.65, marketProb: 0.55, resolved: 1 },
    { label: "SAS win NBA Finals",      modelProb: 0.12, marketProb: 0.14, resolved: 0 },
    { label: "IND win East",            modelProb: 0.38, marketProb: 0.44, resolved: 0 },
    { label: "OKC cover spread G1",     modelProb: 0.60, marketProb: 0.51, resolved: 1 },
    { label: "MIN advance vs DAL",      modelProb: 0.55, marketProb: 0.47, resolved: 0 },
  ];

  type Row = { label: string; ev: number; signal: "BUY_YES" | "BUY_NO" | "SKIP"; sizeUsd: number; pnl: number };
  const rows: Row[] = [];
  let wins = 0, losses = 0;

  for (const s of scenarios) {
    const yesEv = (s.modelProb - s.marketProb) / s.marketProb;
    const noEv  = ((1 - s.modelProb) - (1 - s.marketProb)) / (1 - s.marketProb);
    const bestEv = Math.max(yesEv, noEv);

    let signal: "BUY_YES" | "BUY_NO" | "SKIP" = "SKIP";
    let effModel = s.modelProb, effMarket = s.marketProb;

    if (yesEv >= noEv && yesEv >= MIN_EV) {
      signal = "BUY_YES";
    } else if (noEv > yesEv && noEv >= MIN_EV) {
      signal = "BUY_NO";
      effModel = 1 - s.modelProb;
      effMarket = 1 - s.marketProb;
    }

    if (signal === "SKIP") { rows.push({ label: s.label, ev: bestEv, signal, sizeUsd: 0, pnl: 0 }); continue; }

    const b = (1 - effMarket) / effMarket;
    const kelly = clamp((effModel * b - (1 - effModel)) / b * KELLY, 0, 1);
    const sizeUsd = clamp(kelly * MAX_POS, 0, MAX_POS);
    const shares = sizeUsd / effMarket;
    const didWin = signal === "BUY_YES" ? s.resolved === 1 : s.resolved === 0;
    const pnl = didWin ? shares - sizeUsd : -sizeUsd;
    if (pnl > 0) wins++; else losses++;
    rows.push({ label: s.label, ev: bestEv, signal, sizeUsd, pnl });
  }

  console.log("  #  Signal    Market                              EV       Size     PnL");
  console.log("  " + "─".repeat(78));
  rows.forEach((r, i) => {
    const icon = r.signal === "SKIP" ? "⏭️ " : r.pnl > 0 ? "✅" : "❌";
    const evStr = `${r.ev >= MIN_EV ? "+" : ""}${(r.ev * 100).toFixed(1)}%`;
    const pnlStr = r.signal !== "SKIP" ? fmtPnl(r.pnl) : "—";
    const sizeStr = r.signal !== "SKIP" ? `$${r.sizeUsd.toFixed(2)}` : "—";
    console.log(`  ${String(i + 1).padStart(2)}. [${r.signal.padEnd(7)}] ${icon} ${r.label.slice(0, 36).padEnd(36)} ${evStr.padStart(7)}  ${sizeStr.padStart(6)}  ${pnlStr}`);
  });

  const traded = rows.filter((r) => r.signal !== "SKIP");
  const totalPnl = traded.reduce((s, r) => s + r.pnl, 0);
  const avgEv = traded.length > 0 ? traded.reduce((s, r) => s + r.ev, 0) / traded.length : 0;
  const dailyR = traded.map((r) => r.pnl);
  const mean = dailyR.reduce((a, b) => a + b, 0) / (dailyR.length || 1);
  const variance = dailyR.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(dailyR.length - 1, 1);
  const sharpe = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0;
  let peak = 0, maxDd = 0, running = 0;
  for (const r of traded) { running += r.pnl; if (running > peak) peak = running; if (peak - running > maxDd) maxDd = peak - running; }
  const winRate = traded.length > 0 ? wins / traded.length : 0;

  const synSnapshots = rows.map((r) => ({
    date: "2025-06-01", marketQuestion: r.label,
    marketPrice: 0.5, modelProb: 0.5 + (r.ev / 2),
    ev: r.ev, signal: r.signal, sizeUsd: r.sizeUsd,
    pnl: r.signal !== "SKIP" ? r.pnl : null, resolution: r.signal !== "SKIP" ? (r.pnl > 0 ? 1 : 0) : null,
  }));

  printSummary({
    wins, losses, winRate, totalPnl, avgEv, sharpe, maxDrawdown: maxDd,
    totalMarkets: scenarios.length, marketsWithHistory: scenarios.length,
    totalSnapshots: scenarios.length, tradedSnapshots: traded.length,
    dailyPnl: {}, snapshots: synSnapshots,
  });
}

function printLiveResults(stats: BacktestStats): void {
  const sortedDates = Object.keys(stats.dailyPnl).sort();
  if (sortedDates.length > 0) {
    console.log("  DATE         DAILY PnL    CUMULATIVE");
    console.log("  " + "─".repeat(50));
    let cum = 0;
    for (const date of sortedDates) {
      const daily = stats.dailyPnl[date]!;
      cum += daily;
      console.log(`  ${date}  ${daily >= 0 ? "▲" : "▼"} ${fmtPnl(daily).padStart(10)}  ${fmtPnl(cum).padStart(10)}`);
    }
    console.log("");
  }

  const top5 = stats.snapshots
    .filter((s) => s.signal !== "SKIP" && s.pnl !== null)
    .sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0))
    .slice(0, 5);

  if (top5.length > 0) {
    console.log("  TOP 5 TRADES:");
    top5.forEach((s, i) => {
      console.log(`  ${i + 1}. ${(s.pnl ?? 0) > 0 ? "✅" : "❌"} [${s.signal}] ${s.date} | ${s.marketQuestion.slice(0, 48)}`);
      console.log(`     EV +${(s.ev * 100).toFixed(1)}% | Size $${s.sizeUsd.toFixed(2)} | PnL ${fmtPnl(s.pnl ?? 0)}`);
    });
    console.log("");
  }

  printSummary(stats);
}

function printSummary(stats: {
  wins: number; losses: number; winRate: number; totalPnl: number; avgEv: number;
  sharpe: number; maxDrawdown: number; totalMarkets: number; marketsWithHistory: number;
  totalSnapshots: number; tradedSnapshots: number; dailyPnl: Record<string, number>; snapshots: any[];
}): void {
  const winRateBar = bar(stats.winRate, 1);
  const sharpeLabel = stats.sharpe >= 2 ? "🟢 Excellent" : stats.sharpe >= 1 ? "🟡 Good" : stats.sharpe >= 0 ? "🟠 Fair" : "🔴 Poor";

  console.log(`
${"═".repeat(62)}
  BACKTEST SUMMARY — Last ${DAYS} Days
${"═".repeat(62)}

  Markets analysed    : ${stats.totalMarkets} (${stats.marketsWithHistory} with price history)
  Price snapshots     : ${stats.totalSnapshots}
  Trades triggered    : ${stats.tradedSnapshots}  (EV ≥ +${(MIN_EV * 100).toFixed(0)}%)

  WIN RATE            : ${(stats.winRate * 100).toFixed(1)}%  W:${stats.wins} L:${stats.losses}
  ${winRateBar}

  SIMULATED PnL       : ${fmtPnl(stats.totalPnl)}
  AVG EV per trade    : +${(stats.avgEv * 100).toFixed(2)}%
  MAX DRAWDOWN        : $${stats.maxDrawdown.toFixed(4)}
  SHARPE RATIO        : ${stats.sharpe.toFixed(2)}  ${sharpeLabel}

${"═".repeat(62)}
  THRESHOLD SENSITIVITY
${"─".repeat(62)}`);

  for (const evCutoff of [0.04, 0.06, 0.08, 0.10, 0.12, 0.15]) {
    const t = stats.snapshots.filter((s) => s.signal !== "SKIP" && s.ev >= evCutoff);
    const r = t.filter((s) => s.pnl !== null);
    const w = r.filter((s) => (s.pnl ?? 0) > 0).length;
    const pnl = r.reduce((sum, s) => sum + (s.pnl ?? 0), 0);
    const wr = r.length > 0 ? w / r.length : 0;
    const marker = evCutoff === MIN_EV ? " ◄ current" : "";
    console.log(`  EV ≥ +${(evCutoff * 100).toFixed(0).padStart(2)}%  trades:${String(t.length).padStart(3)}  win:${(wr * 100).toFixed(0).padStart(3)}%  pnl:${fmtPnl(pnl).padStart(10)}${marker}`);
  }

  console.log(`${"═".repeat(62)}`);
  console.log(`\n  Run pnpm dry-run  to paper-trade live markets`);
  console.log(`  Run pnpm live     to execute real trades (fund wallet first)\n`);
}

main().catch((err) => { console.error("[backtest fatal]", err); process.exit(1); });
