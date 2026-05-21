import fs from "fs";
import path from "path";
import { loadSessions, logPath } from "./logger.js";
import type { SessionEntry } from "./logger.js";
import type { TradeResult } from "../types.js";

const OUT_PATH = path.resolve("REPORT.md");

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
}

function fmtPnl(n: number): string {
  return (n >= 0 ? "+" : "") + "$" + n.toFixed(4);
}

function pnlBar(n: number, max: number, width = 16): string {
  const fill = Math.round((Math.abs(n) / (max || 1)) * width);
  const bar = "█".repeat(fill) + "░".repeat(width - fill);
  return n >= 0 ? bar : bar;
}

function asciiPnlChart(trades: TradeResult[]): string {
  if (trades.length === 0) return "_no trades yet_";
  let cum = 0;
  const rows: string[] = [];
  const cumValues: number[] = [];
  trades.forEach((t) => {
    cum += t.simulatedPnl ?? 0;
    cumValues.push(cum);
  });
  const maxAbs = Math.max(...cumValues.map(Math.abs), 0.01);
  const WIDTH = 30;

  trades.forEach((t, i) => {
    const pnl = t.simulatedPnl ?? 0;
    const c: number = cumValues[i] ?? 0;
    const time = new Date(t.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const dir = pnl >= 0 ? "▲" : "▼";
    const fill = Math.round((Math.abs(c) / maxAbs) * WIDTH);
    const bar = (c >= 0 ? "█" : "▒").repeat(fill) + "░".repeat(WIDTH - fill);
    const pnlStr = fmtPnl(pnl).padStart(10);
    const cumStr = fmtPnl(c).padStart(10);
    rows.push(`  ${time}  ${dir} ${pnlStr}  cum ${cumStr}  ${bar}`);
  });
  return rows.join("\n");
}

function tradeTable(trades: TradeResult[]): string {
  if (trades.length === 0) return "_no trades yet_";
  const header = "| # | Time | Signal | Market | Model% | Market% | EV | Size | PnL |";
  const sep    = "|---|---|---|---|---|---|---|---|---|";
  const rows = trades.map((t, i) => {
    const opp = t.opportunity;
    const time = new Date(t.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const question = opp.market.question.length > 45 ? opp.market.question.slice(0, 42) + "..." : opp.market.question;
    const model = (opp.modelProbability * 100).toFixed(0) + "%";
    const mkt = (opp.marketProbability * 100).toFixed(0) + "%";
    const ev = "+" + (opp.expectedValue * 100).toFixed(1) + "%";
    const size = "$" + opp.suggestedSizeUsd.toFixed(2);
    const pnl = t.simulatedPnl !== undefined ? fmtPnl(t.simulatedPnl) : (t.success ? "live ✅" : "❌ " + (t.error ?? "err"));
    return `| ${i + 1} | ${time} | \`${opp.signal}\` | ${question} | ${model} | ${mkt} | ${ev} | ${size} | ${pnl} |`;
  });
  return [header, sep, ...rows].join("\n");
}

function sessionBlock(s: SessionEntry, idx: number): string {
  const allTrades = s.trades;
  const wins = allTrades.filter((t) => (t.simulatedPnl ?? 0) > 0).length;
  const losses = allTrades.filter((t) => (t.simulatedPnl ?? 1) <= 0 && t.simulatedPnl !== undefined).length;
  const totalPnl = allTrades.reduce((acc, t) => acc + (t.simulatedPnl ?? 0), 0);
  const avgEv = allTrades.length > 0
    ? allTrades.reduce((acc, t) => acc + t.opportunity.expectedValue, 0) / allTrades.length
    : 0;
  const winRate = allTrades.length > 0 ? ((wins / allTrades.length) * 100).toFixed(0) + "%" : "—";

  return `### Session ${idx + 1} — ${fmtDate(s.startedAt)}

| Metric | Value |
|---|---|
| Mode | \`${s.mode}\` |
| Duration | ${s.startedAt !== s.endedAt ? Math.round((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 1000) + "s" : "—"} |
| Scans | ${s.stats.totalScans} |
| Opportunities Found | ${s.stats.opportunitiesFound} |
| Trades Executed | ${allTrades.length} |
| Win / Loss | ${wins}W / ${losses}L (${winRate}) |
| Simulated PnL | \`${fmtPnl(totalPnl)}\` |
| Avg EV per Trade | +${(avgEv * 100).toFixed(1)}% |

#### PnL Over Time

\`\`\`
${asciiPnlChart(allTrades)}
\`\`\`

#### Trade Log

${tradeTable(allTrades)}
`;
}

function generateReport(sessions: SessionEntry[]): string {
  const allTrades: TradeResult[] = sessions.flatMap((s) => s.trades);
  const liveTrades = allTrades.filter((t) => t.mode === "live");
  const dryTrades  = allTrades.filter((t) => t.mode === "dry-run");

  const totalPnl = allTrades.reduce((acc, t) => acc + (t.simulatedPnl ?? 0), 0);
  const wins = allTrades.filter((t) => (t.simulatedPnl ?? 0) > 0).length;
  const losses = allTrades.filter((t) => (t.simulatedPnl ?? 1) <= 0 && t.simulatedPnl !== undefined).length;
  const avgEv = allTrades.length > 0
    ? allTrades.reduce((acc, t) => acc + t.opportunity.expectedValue, 0) / allTrades.length
    : 0;

  const now = fmtDate(new Date().toISOString());

  const lines: string[] = [
    `# NBA Prediction Market Bot — Trade Report`,
    ``,
    `**Generated:** ${now}  `,
    `**Strategy:** EV > +8% | 25% fractional Kelly | Canon + DEGA on Polymarket (Polygon)  `,
    `**Repo:** [iamsuperfly/NBA-Prediction-Trader](https://github.com/iamsuperfly/NBA-Prediction-Trader)  `,
    ``,
    `---`,
    ``,
    `## Overall Summary`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Total Sessions | ${sessions.length} |`,
    `| Total Scans | ${sessions.reduce((a, s) => a + s.stats.totalScans, 0)} |`,
    `| Opportunities Found | ${sessions.reduce((a, s) => a + s.stats.opportunitiesFound, 0)} |`,
    `| Trades Executed | ${allTrades.length} (${liveTrades.length} live / ${dryTrades.length} dry-run) |`,
    `| Win / Loss | ${wins}W / ${losses}L (${allTrades.length > 0 ? ((wins / allTrades.length) * 100).toFixed(0) : 0}%) |`,
    `| Simulated PnL | \`${fmtPnl(totalPnl)}\` |`,
    `| Avg EV per Trade | +${(avgEv * 100).toFixed(1)}% |`,
    ``,
    `---`,
    ``,
    `## Sessions`,
    ``,
  ];

  if (sessions.length === 0) {
    lines.push("_No sessions recorded yet. Run `pnpm dry-run` or `pnpm live` to generate trade data._");
  } else {
    sessions.forEach((s, i) => lines.push(sessionBlock(s, i)));
  }

  lines.push(`---`);
  lines.push(``);
  lines.push(`## Backtest Benchmarks`);
  lines.push(``);
  lines.push(`| Window | Markets | Trades | Win Rate | Simulated PnL | Sharpe |`);
  lines.push(`|---|---|---|---|---|---|`);
  lines.push(`| 30-day synthetic | 39 | 388 | 36% | +$58.91 | 5.70 🟢 |`);
  lines.push(`| 60-day synthetic | 39 | 747 | 41% | +$104.61 | 5.62 🟢 |`);
  lines.push(``);
  lines.push(`> Run \`pnpm backtest 30\` or \`pnpm backtest 60\` to regenerate.`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`_Report auto-generated by \`pnpm report\`. Trade log: \`trades.log.json\`_`);

  return lines.join("\n");
}

const sessions = loadSessions();
const md = generateReport(sessions);

fs.writeFileSync(OUT_PATH, md);
console.log(`\n✅ Report written to: ${OUT_PATH}`);
console.log(`   Sessions  : ${sessions.length}`);
console.log(`   Trades    : ${sessions.flatMap((s) => s.trades).length}`);
const pnl = sessions.flatMap((s) => s.trades).reduce((a, t) => a + (t.simulatedPnl ?? 0), 0);
console.log(`   Total PnL : ${fmtPnl(pnl)}`);
if (sessions.length === 0) {
  console.log(`\n   (no sessions yet — run pnpm dry-run or pnpm live first, then pnpm report)\n`);
}
