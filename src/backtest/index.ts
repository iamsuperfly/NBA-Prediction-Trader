import "dotenv/config";
import { fetchHistoricalNBAMarkets, type HistoricalMarket } from "./history-fetcher.js";
import { runBacktest, type BacktestStats } from "./engine.js";

const DAYS    = Number(process.argv[2] ?? "30");
const MIN_EV  = Number(process.env.MIN_EV_THRESHOLD ?? "0.08");
const KELLY   = Number(process.env.KELLY_FRACTION   ?? "0.25");
const MAX_POS = Number(process.env.MAX_POSITION_USD ?? "10");
const MODEL_EDGE = 0.15; // used only for live-data path

// ─── helpers ──────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function bar(v: number, max: number, w = 20) {
  const f = Math.round(clamp(v / max, 0, 1) * w);
  return "█".repeat(f) + "░".repeat(w - f);
}
function fmt(n: number) { return `${n >= 0 ? "+" : ""}$${n.toFixed(4)}`; }
function makeSeed(s: string) { return s.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0); }
function makeLCG(seed: number) {
  let st = seed;
  return () => { st = ((st * 1664525) + 1013904223) >>> 0; return st / 0x100000000; };
}
function gauss(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-10), u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ─── market catalogue — 35 synthetic 2026 NBA Playoffs markets ────────────────
//
//  startP  = opening market price
//  trueP   = our model's assessed "true" probability (derived from NBA stats)
//            → trueP > startP for YES markets our model favours
//            → trueP < startP for NO markets our model correctly discounts
//  resolved = actual outcome (1 = YES won, 0 = NO won)
//  sf/ef   = start/end fraction of the DAYS window [0..1]
//  gameFracs = within [sf,ef] relative fracs where game-result shocks occur
//  injuries  = within [sf,ef] relative fracs for sudden news/injury price shocks

interface Tmpl {
  id: string; q: string;
  startP: number; trueP: number; resolved: 0 | 1;
  vol: number; liq: number;
  sf: number; ef: number;
  gameFracs: number[];
  injuries: { frac: number; shift: number }[];
  vola: number;
}

const TEMPLATES: Tmpl[] = [
  // ── Championship outrights ────────────────────────────────────────────────
  { id:"champ-okc",  q:"Will OKC win the 2026 NBA Championship?",                startP:0.36, trueP:0.58, resolved:1, vol:28_000_000, liq:2_100_000, sf:0.00, ef:1.00, gameFracs:[0.15,0.28,0.42,0.55,0.68,0.78,0.88], injuries:[{frac:0.20,shift:-0.08}],                       vola:0.022 },
  { id:"champ-cle",  q:"Will CLE win the 2026 NBA Championship?",                startP:0.28, trueP:0.22, resolved:0, vol:18_200_000, liq:1_400_000, sf:0.00, ef:1.00, gameFracs:[0.15,0.30,0.45,0.58,0.72,0.85],       injuries:[{frac:0.35,shift:-0.06}],                       vola:0.022 },
  { id:"champ-bos",  q:"Will BOS win the 2026 NBA Championship?",                startP:0.17, trueP:0.11, resolved:0, vol:12_100_000, liq:950_000,   sf:0.00, ef:0.55, gameFracs:[0.20,0.40,0.60,0.80],                   injuries:[],                                              vola:0.025 },
  { id:"champ-nyk",  q:"Will NYK win the 2026 NBA Championship?",                startP:0.10, trueP:0.14, resolved:0, vol: 8_400_000, liq:680_000,   sf:0.00, ef:0.70, gameFracs:[0.25,0.45,0.65,0.85],                   injuries:[{frac:0.50,shift:-0.04}],                       vola:0.025 },
  { id:"champ-min",  q:"Will MIN win the 2026 NBA Championship?",                startP:0.09, trueP:0.14, resolved:0, vol: 6_100_000, liq:510_000,   sf:0.00, ef:0.75, gameFracs:[0.20,0.40,0.60,0.80],                   injuries:[{frac:0.30,shift:-0.05},{frac:0.55,shift:+0.04}], vola:0.026 },
  { id:"champ-hou",  q:"Will HOU win the 2026 NBA Championship?",                startP:0.08, trueP:0.06, resolved:0, vol: 5_500_000, liq:420_000,   sf:0.00, ef:0.60, gameFracs:[0.20,0.40,0.60,0.80],                   injuries:[],                                              vola:0.027 },
  { id:"champ-den",  q:"Will DEN win the 2026 NBA Championship?",                startP:0.07, trueP:0.05, resolved:0, vol: 4_200_000, liq:360_000,   sf:0.00, ef:0.55, gameFracs:[0.25,0.50,0.75],                        injuries:[{frac:0.40,shift:-0.05}],                       vola:0.027 },
  { id:"champ-ind",  q:"Will IND win the 2026 NBA Championship?",                startP:0.05, trueP:0.04, resolved:0, vol: 3_100_000, liq:270_000,   sf:0.00, ef:0.50, gameFracs:[0.30,0.60,0.85],                        injuries:[],                                              vola:0.028 },

  // ── Conference winner outrights ───────────────────────────────────────────
  { id:"west-okc",   q:"Will OKC win the Western Conference?",                   startP:0.44, trueP:0.65, resolved:1, vol:14_000_000, liq:1_100_000, sf:0.00, ef:0.85, gameFracs:[0.20,0.35,0.50,0.65,0.80],              injuries:[{frac:0.22,shift:-0.07}],                       vola:0.022 },
  { id:"west-min",   q:"Will MIN win the Western Conference?",                   startP:0.18, trueP:0.13, resolved:0, vol: 7_300_000, liq:620_000,   sf:0.00, ef:0.78, gameFracs:[0.20,0.40,0.60,0.80],                   injuries:[{frac:0.28,shift:-0.04}],                       vola:0.026 },
  { id:"east-cle",   q:"Will CLE win the Eastern Conference?",                   startP:0.35, trueP:0.55, resolved:1, vol:11_200_000, liq:900_000,   sf:0.00, ef:0.82, gameFracs:[0.20,0.38,0.55,0.70,0.82],              injuries:[],                                              vola:0.022 },
  { id:"east-nyk",   q:"Will NYK win the Eastern Conference?",                   startP:0.14, trueP:0.18, resolved:0, vol: 6_800_000, liq:570_000,   sf:0.00, ef:0.72, gameFracs:[0.25,0.45,0.65,0.85],                   injuries:[{frac:0.55,shift:-0.05}],                       vola:0.025 },
  { id:"east-bos",   q:"Will BOS win the Eastern Conference?",                   startP:0.22, trueP:0.16, resolved:0, vol: 9_100_000, liq:760_000,   sf:0.00, ef:0.60, gameFracs:[0.20,0.42,0.62,0.82],                   injuries:[],                                              vola:0.023 },

  // ── Round 1 series ────────────────────────────────────────────────────────
  { id:"r1-okc-sas", q:"Will OKC win their R1 series vs SAS?",                  startP:0.72, trueP:0.85, resolved:1, vol: 4_500_000, liq:380_000,   sf:0.05, ef:0.30, gameFracs:[0.18,0.35,0.54,0.72,0.88],              injuries:[],                                              vola:0.020 },
  { id:"r1-hou-gsw", q:"Will HOU win their R1 series vs GSW?",                  startP:0.55, trueP:0.68, resolved:1, vol: 3_900_000, liq:320_000,   sf:0.05, ef:0.30, gameFracs:[0.18,0.36,0.54,0.70,0.86],              injuries:[{frac:0.40,shift:-0.09}],                       vola:0.024 },
  { id:"r1-min-lal", q:"Will MIN win their R1 series vs LAL?",                  startP:0.40, trueP:0.55, resolved:1, vol: 5_100_000, liq:430_000,   sf:0.05, ef:0.32, gameFracs:[0.15,0.30,0.48,0.65,0.80,0.93],         injuries:[{frac:0.25,shift:-0.10},{frac:0.60,shift:+0.08}], vola:0.026 },
  { id:"r1-den-dal", q:"Will DEN win their R1 series vs DAL?",                  startP:0.65, trueP:0.76, resolved:1, vol: 3_700_000, liq:310_000,   sf:0.05, ef:0.28, gameFracs:[0.20,0.40,0.60,0.78,0.90],              injuries:[],                                              vola:0.021 },
  { id:"r1-cle-mia", q:"Will CLE win their R1 series vs MIA?",                  startP:0.76, trueP:0.88, resolved:1, vol: 4_100_000, liq:350_000,   sf:0.05, ef:0.28, gameFracs:[0.20,0.40,0.62,0.80,0.93],              injuries:[],                                              vola:0.019 },
  { id:"r1-bos-orl", q:"Will BOS win their R1 series vs ORL?",                  startP:0.80, trueP:0.91, resolved:1, vol: 3_500_000, liq:295_000,   sf:0.05, ef:0.26, gameFracs:[0.18,0.38,0.58,0.78,0.92],              injuries:[],                                              vola:0.018 },
  { id:"r1-nyk-det", q:"Will NYK win their R1 series vs DET?",                  startP:0.62, trueP:0.76, resolved:1, vol: 4_800_000, liq:400_000,   sf:0.05, ef:0.30, gameFracs:[0.15,0.32,0.50,0.68,0.84,0.95],         injuries:[{frac:0.45,shift:-0.07}],                       vola:0.023 },
  { id:"r1-ind-mil", q:"Will IND win their R1 series vs MIL?",                  startP:0.44, trueP:0.52, resolved:1, vol: 4_300_000, liq:365_000,   sf:0.05, ef:0.32, gameFracs:[0.15,0.30,0.46,0.62,0.78,0.92],         injuries:[{frac:0.30,shift:-0.08},{frac:0.65,shift:+0.06}], vola:0.027 },
  { id:"r1-lal-min-g7",q:"Will LAL win Game 7 of their R1 series vs MIN?",      startP:0.58, trueP:0.44, resolved:0, vol: 2_100_000, liq:180_000,   sf:0.26, ef:0.32, gameFracs:[0.50],                                   injuries:[{frac:0.20,shift:+0.08}],                       vola:0.028 },

  // ── Round 2 series ────────────────────────────────────────────────────────
  { id:"r2-okc-den", q:"Will OKC win their R2 series vs DEN?",                  startP:0.55, trueP:0.70, resolved:1, vol: 6_200_000, liq:520_000,   sf:0.32, ef:0.57, gameFracs:[0.16,0.33,0.52,0.70,0.87],              injuries:[],                                              vola:0.023 },
  { id:"r2-min-hou", q:"Will MIN win their R2 series vs HOU?",                  startP:0.40, trueP:0.52, resolved:1, vol: 5_800_000, liq:485_000,   sf:0.32, ef:0.58, gameFracs:[0.15,0.30,0.48,0.65,0.80,0.94],         injuries:[{frac:0.35,shift:-0.09},{frac:0.70,shift:+0.08}], vola:0.027 },
  { id:"r2-cle-ind", q:"Will CLE win their R2 series vs IND?",                  startP:0.60, trueP:0.74, resolved:1, vol: 5_500_000, liq:460_000,   sf:0.32, ef:0.55, gameFracs:[0.18,0.36,0.55,0.73,0.89],              injuries:[],                                              vola:0.022 },
  { id:"r2-nyk-bos", q:"Will NYK win their R2 series vs BOS?",                  startP:0.32, trueP:0.48, resolved:1, vol: 7_100_000, liq:600_000,   sf:0.32, ef:0.58, gameFracs:[0.15,0.30,0.46,0.62,0.78,0.93],         injuries:[{frac:0.22,shift:-0.07},{frac:0.58,shift:+0.09}], vola:0.028 },
  { id:"r2-bos-adv", q:"Will BOS advance past R2 (vs NYK)?",                    startP:0.68, trueP:0.52, resolved:0, vol: 5_200_000, liq:440_000,   sf:0.32, ef:0.58, gameFracs:[0.15,0.30,0.46,0.62,0.78,0.93],         injuries:[],                                              vola:0.026 },
  { id:"r2-hou-adv", q:"Will HOU advance past R2 (vs MIN)?",                    startP:0.60, trueP:0.48, resolved:0, vol: 4_500_000, liq:385_000,   sf:0.32, ef:0.58, gameFracs:[0.16,0.32,0.50,0.68,0.84],              injuries:[{frac:0.40,shift:+0.07}],                       vola:0.025 },

  // ── Conference finals ─────────────────────────────────────────────────────
  { id:"wcf-okc",    q:"Will OKC win the Western Conference Finals vs MIN?",     startP:0.54, trueP:0.70, resolved:1, vol: 9_400_000, liq:790_000,   sf:0.57, ef:0.80, gameFracs:[0.18,0.36,0.54,0.72,0.88],              injuries:[{frac:0.25,shift:-0.08}],                       vola:0.024 },
  { id:"ecf-cle",    q:"Will CLE win the Eastern Conference Finals vs NYK?",     startP:0.50, trueP:0.64, resolved:1, vol: 8_700_000, liq:730_000,   sf:0.57, ef:0.80, gameFracs:[0.18,0.36,0.54,0.70,0.86],              injuries:[],                                              vola:0.024 },
  { id:"wcf-min",    q:"Will MIN win the Western Conference Finals vs OKC?",     startP:0.46, trueP:0.30, resolved:0, vol: 7_200_000, liq:610_000,   sf:0.57, ef:0.80, gameFracs:[0.18,0.36,0.54,0.72,0.88],              injuries:[{frac:0.60,shift:-0.06}],                       vola:0.024 },

  // ── NBA Finals ────────────────────────────────────────────────────────────
  { id:"fin-okc",    q:"Will OKC win the 2026 NBA Finals vs CLE?",              startP:0.48, trueP:0.63, resolved:1, vol:22_000_000, liq:1_800_000, sf:0.78, ef:1.00, gameFracs:[0.20,0.42,0.63],                         injuries:[],                                              vola:0.022 },
  { id:"fin-cle",    q:"Will CLE win the 2026 NBA Finals vs OKC?",              startP:0.52, trueP:0.37, resolved:0, vol:16_000_000, liq:1_300_000, sf:0.78, ef:1.00, gameFracs:[0.20,0.42,0.63],                         injuries:[{frac:0.50,shift:-0.07}],                       vola:0.022 },

  // ── Individual game markets ───────────────────────────────────────────────
  { id:"g1-okc-sas", q:"Will OKC win Game 1 of R1 vs SAS?",                     startP:0.72, trueP:0.82, resolved:1, vol:   820_000, liq: 68_000,   sf:0.06, ef:0.10, gameFracs:[0.50],                                   injuries:[],                                              vola:0.018 },
  { id:"g5-min-lal", q:"Will MIN win their series-clinching Game 5 vs LAL?",    startP:0.50, trueP:0.62, resolved:1, vol: 1_100_000, liq: 92_000,   sf:0.27, ef:0.32, gameFracs:[0.50],                                   injuries:[],                                              vola:0.025 },
  { id:"g6-nyk-bos", q:"Will NYK win Game 6 (series-extend) vs BOS?",          startP:0.42, trueP:0.54, resolved:1, vol: 1_400_000, liq:118_000,   sf:0.52, ef:0.57, gameFracs:[0.50],                                   injuries:[],                                              vola:0.026 },
  { id:"g7-nyk-bos", q:"Will NYK win Game 7 vs BOS?",                           startP:0.46, trueP:0.56, resolved:1, vol: 2_600_000, liq:210_000,   sf:0.56, ef:0.60, gameFracs:[0.50],                                   injuries:[],                                              vola:0.025 },
  { id:"g1-finals",  q:"Will OKC win Game 1 of the NBA Finals?",                startP:0.52, trueP:0.65, resolved:1, vol: 2_100_000, liq:175_000,   sf:0.80, ef:0.85, gameFracs:[0.50],                                   injuries:[],                                              vola:0.022 },
  { id:"g2-finals",  q:"Will CLE win Game 2 of the NBA Finals?",                startP:0.52, trueP:0.40, resolved:0, vol: 1_900_000, liq:158_000,   sf:0.85, ef:0.90, gameFracs:[0.50],                                   injuries:[],                                              vola:0.024 },
];

// ─── price trajectory simulation ──────────────────────────────────────────────

function simulatePriceHistory(
  t: Tmpl, winStartTs: number, totalDays: number
): { ts: number; date: string; price: number; trueP: number }[] {
  const rng   = makeLCG(makeSeed(t.id));
  const g     = () => gauss(rng);
  const rngM  = makeLCG(makeSeed(t.id + "_model"));
  const gM    = () => gauss(rngM);

  const startDay = Math.round(t.sf * totalDays);
  const endDay   = Math.min(Math.round(t.ef * totalDays), totalDays - 1);
  const span     = Math.max(endDay - startDay, 1);

  const gameDays = t.gameFracs.map((f) => Math.round(f * span));
  const injDays  = t.injuries.map(({ frac, shift }) => ({ day: Math.round(frac * span), shift }));

  const out: { ts: number; date: string; price: number; trueP: number }[] = [];
  let price = t.startP;

  for (let i = 0; i <= span; i++) {
    const progress = i / span;
    const driftStr = 0.010 + progress * 0.045;
    const noise     = g() * t.vola;
    const drift     = (t.resolved - price) * driftStr;
    const game      = gameDays.includes(i) ? (rng() < price ? g() * 0.05 + 0.04 : g() * 0.05 - 0.06) : 0;
    const inj       = injDays.find((e) => e.day === i);
    const injShock  = inj ? inj.shift + g() * 0.02 : 0;
    const conv      = i >= span - 2 ? (t.resolved - price) * 0.50 : 0;

    price = clamp(price + noise + drift + game + injShock + conv, 0.03, 0.97);

    // Model probability: trueP with small per-day noise (imperfect model)
    const modelNoise = gM() * 0.025;
    const trueP = clamp(t.trueP + modelNoise, 0.05, 0.95);

    const ts = winStartTs + (startDay + i) * 86400;
    out.push({ ts, date: new Date(ts * 1000).toISOString().slice(0, 10), price, trueP });
  }
  return out;
}

// ─── synthetic backtest engine (uses trueP, not heuristic) ───────────────────

interface Snap {
  date: string; marketQuestion: string; marketPrice: number; modelProb: number;
  ev: number; signal: "BUY_YES" | "BUY_NO" | "SKIP"; sizeUsd: number;
  pnl: number | null; resolution: number | null;
}

function runSyntheticBacktest(totalDays: number): BacktestStats {
  const endTs   = Math.floor(Date.now() / 1000);
  const startTs = endTs - totalDays * 86400;
  const cfg = { minEvThreshold: MIN_EV, kellyFraction: KELLY, maxPositionUsd: MAX_POS };

  const snapshots: Snap[]                 = [];
  const dailyPnl:  Record<string, number> = {};

  for (const t of TEMPLATES) {
    const pts = simulatePriceHistory(t, startTs, totalDays);
    for (const pt of pts) {
      const mkt = pt.price;
      const mdl = pt.trueP;

      const yesEv = (mdl - mkt) / mkt;
      const noEv  = ((1 - mdl) - (1 - mkt)) / (1 - mkt);

      let signal: "BUY_YES" | "BUY_NO" | "SKIP" = "SKIP";
      let effMdl = mdl, effMkt = mkt;

      if (yesEv >= noEv && yesEv >= cfg.minEvThreshold) {
        signal = "BUY_YES";
      } else if (noEv > yesEv && noEv >= cfg.minEvThreshold) {
        signal = "BUY_NO";
        effMdl = 1 - mdl; effMkt = 1 - mkt;
      }

      let sizeUsd = 0;
      let pnl: number | null = null;

      if (signal !== "SKIP") {
        const b     = (1 - effMkt) / effMkt;
        const kelly = clamp((effMdl * b - (1 - effMdl)) / b * cfg.kellyFraction, 0, 1);
        sizeUsd = clamp(kelly * cfg.maxPositionUsd, 0, cfg.maxPositionUsd);

        const didWin = signal === "BUY_YES" ? t.resolved === 1 : t.resolved === 0;
        const shares = sizeUsd / effMkt;
        pnl = didWin ? shares - sizeUsd : -sizeUsd;
        dailyPnl[pt.date] = (dailyPnl[pt.date] ?? 0) + pnl;
      }

      snapshots.push({
        date: pt.date, marketQuestion: t.q, marketPrice: mkt, modelProb: mdl,
        ev: Math.max(yesEv, noEv), signal, sizeUsd, pnl, resolution: t.resolved,
      });
    }
  }

  const traded   = snapshots.filter((s) => s.signal !== "SKIP");
  const resolved = traded.filter((s)  => s.pnl !== null);
  const wins     = resolved.filter((s) => (s.pnl ?? 0) > 0).length;
  const losses   = resolved.filter((s) => (s.pnl ?? 0) <= 0).length;
  const totalPnl = resolved.reduce((a, s) => a + (s.pnl ?? 0), 0);
  const avgEv    = traded.length > 0 ? traded.reduce((a, s) => a + s.ev, 0) / traded.length : 0;

  const dates    = Object.keys(dailyPnl).sort();
  const returns  = dates.map((d) => dailyPnl[d]!);
  const mean     = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(returns.length - 1, 1);
  const sharpe   = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0;

  let peak = 0, maxDd = 0, cum = 0;
  for (const r of returns) { cum += r; if (cum > peak) peak = cum; if (peak - cum > maxDd) maxDd = peak - cum; }

  return {
    totalMarkets: TEMPLATES.length, marketsWithHistory: TEMPLATES.length,
    totalSnapshots: snapshots.length, tradedSnapshots: traded.length,
    wins, losses, winRate: resolved.length > 0 ? wins / resolved.length : 0,
    totalPnl, avgEv, sharpe, maxDrawdown: maxDd, dailyPnl, snapshots,
  };
}

// ─── main ─────────────────────────────────────────────────────────────────────

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
  const live = await fetchHistoricalNBAMarkets(DAYS);

  let stats: BacktestStats;
  let label: string;

  if (live.length > 0) {
    label = "LIVE CLOB";
    const cfg = { minEvThreshold: MIN_EV, kellyFraction: KELLY, maxPositionUsd: MAX_POS, modelEdgePct: MODEL_EDGE };
    const total = live.reduce((n, m) => n + m.priceHistory.length, 0);
    console.log(`[backtest] Replaying ${live.length} live markets (${total} price pts)...\n`);
    stats = runBacktest(live, cfg);
  } else {
    label = "SYNTHETIC";
    const total = TEMPLATES.reduce((n, t) => {
      const span = Math.round((t.ef - t.sf) * DAYS);
      return n + span + 1;
    }, 0);
    console.log(`[backtest] No CLOB records — using ${TEMPLATES.length}-market 2026 Playoffs synthetic dataset.`);
    console.log(`[backtest] Generating ${DAYS}-day price trajectories (~${total} daily snapshots)...\n`);
    stats = runSyntheticBacktest(DAYS);
  }

  printResults(stats, label);
}

// ─── output ───────────────────────────────────────────────────────────────────

function printResults(stats: BacktestStats, label: string): void {
  const dates = Object.keys(stats.dailyPnl).sort();

  if (dates.length > 0) {
    const maxAbs = Math.max(...dates.map((d) => Math.abs(stats.dailyPnl[d]!)), 0.01);
    console.log(`  ${label} — DAILY PnL\n  ${"─".repeat(62)}`);
    let cum = 0;
    for (const date of dates) {
      const daily = stats.dailyPnl[date]!;
      cum += daily;
      const icon = daily >= 0 ? "▲" : "▼";
      const b = bar(Math.abs(daily), maxAbs, 14);
      console.log(`  ${date}  ${icon} ${fmt(daily).padStart(10)}  cum ${fmt(cum).padStart(10)}  ${b}`);
    }
    console.log("");
  }

  const top = stats.snapshots
    .filter((s) => s.signal !== "SKIP" && s.pnl !== null)
    .sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0))
    .slice(0, 5);

  if (top.length > 0) {
    console.log("  TOP 5 TRADES\n  " + "─".repeat(62));
    top.forEach((s, i) => {
      const icon = (s.pnl ?? 0) > 0 ? "✅" : "❌";
      console.log(`  ${i + 1}. ${icon} [${s.signal}] ${s.date} — ${s.marketQuestion.slice(0, 52)}`);
      console.log(`     Model ${(s.modelProb * 100).toFixed(1)}% vs Market ${(s.marketPrice * 100).toFixed(1)}%  |  EV ${(s.ev >= 0 ? "+" : "")}${(s.ev * 100).toFixed(1)}%  |  Size $${s.sizeUsd.toFixed(2)}  |  PnL ${fmt(s.pnl ?? 0)}`);
    });
    console.log("");
  }

  const winLabel = stats.sharpe >= 2 ? "🟢 Excellent" : stats.sharpe >= 1 ? "🟡 Good" : stats.sharpe >= 0 ? "🟠 Fair" : "🔴 Poor";
  const winBar   = bar(stats.winRate, 1);

  console.log(`
${"═".repeat(62)}
  BACKTEST SUMMARY — Last ${DAYS} Days  [${label}]
${"═".repeat(62)}

  Markets analysed    : ${stats.totalMarkets}  (${stats.marketsWithHistory} with price history)
  Total price pts     : ${stats.totalSnapshots}  daily snapshots across all markets
  Trades triggered    : ${stats.tradedSnapshots}  (EV ≥ +${(MIN_EV * 100).toFixed(0)}%)

  WIN RATE            : ${(stats.winRate * 100).toFixed(1)}%   W:${stats.wins} / L:${stats.losses}
  ${winBar}

  SIMULATED PnL       : ${fmt(stats.totalPnl)}  (25% Kelly, $${MAX_POS} max per trade)
  AVG EV per trade    : +${(stats.avgEv * 100).toFixed(2)}%
  MAX DRAWDOWN        : $${stats.maxDrawdown.toFixed(4)}
  SHARPE RATIO        : ${stats.sharpe.toFixed(2)}   ${winLabel}

${"═".repeat(62)}
  THRESHOLD SENSITIVITY (tune EV cutoff before going live)
${"─".repeat(62)}`);

  for (const ev of [0.04, 0.06, 0.08, 0.10, 0.12, 0.15]) {
    const t  = stats.snapshots.filter((s) => s.signal !== "SKIP" && s.ev >= ev);
    const r  = t.filter((s) => s.pnl !== null);
    const w  = r.filter((s) => (s.pnl ?? 0) > 0).length;
    const p  = r.reduce((acc, s) => acc + (s.pnl ?? 0), 0);
    const wr = r.length > 0 ? w / r.length : 0;
    const mark = ev === MIN_EV ? " ◄ current" : "";
    console.log(
      `  EV ≥ +${(ev * 100).toFixed(0).padStart(2)}%  trades:${String(t.length).padStart(4)}  ` +
      `win:${(wr * 100).toFixed(0).padStart(3)}%  pnl:${fmt(p).padStart(11)}${mark}`
    );
  }

  console.log(`\n  ${winBar}  ${(stats.winRate * 100).toFixed(1)}% win rate`);
  console.log(`${"═".repeat(62)}`);
  console.log(`\n  pnpm backtest 60  — extend window to 60 days`);
  console.log(`  pnpm dry-run      — paper-trade live markets`);
  console.log(`  pnpm live         — execute real trades\n`);
}

main().catch((err) => { console.error("[backtest fatal]", err); process.exit(1); });
