import type { HistoricalMarket, PricePoint } from "./history-fetcher.js";

export interface BacktestConfig {
  minEvThreshold: number;
  kellyFraction: number;
  maxPositionUsd: number;
  modelEdgePct: number;
}

export interface DailySnapshot {
  date: string;
  marketQuestion: string;
  marketPrice: number;
  modelProb: number;
  ev: number;
  signal: "BUY_YES" | "BUY_NO" | "SKIP";
  sizeUsd: number;
  pnl: number | null;
  resolution: number | null;
}

export interface BacktestStats {
  totalMarkets: number;
  marketsWithHistory: number;
  totalSnapshots: number;
  tradedSnapshots: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgEv: number;
  sharpe: number;
  maxDrawdown: number;
  dailyPnl: Record<string, number>;
  snapshots: DailySnapshot[];
}

function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }

function computeModelProb(marketPrice: number, cfg: BacktestConfig): number {
  const logOdds = Math.log(marketPrice / (1 - marketPrice));
  const biasedLogOdds = logOdds + cfg.modelEdgePct;
  return clamp(sigmoid(biasedLogOdds) * 0.9 + 0.05, 0.05, 0.95);
}

function computeEV(modelProb: number, marketPrice: number): number {
  return (modelProb - marketPrice) / marketPrice;
}

function computeKelly(modelProb: number, marketPrice: number, fraction: number): number {
  const b = (1 - marketPrice) / marketPrice;
  const kelly = (modelProb * b - (1 - modelProb)) / b;
  return clamp(kelly * fraction, 0, 1);
}

function computeSharpe(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const n = dailyReturns.length;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / n;
  const variance = dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(252);
}

function computeMaxDrawdown(cumPnl: number[]): number {
  let peak = 0;
  let maxDd = 0;
  for (const v of cumPnl) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

export function runBacktest(
  markets: HistoricalMarket[],
  cfg: BacktestConfig
): BacktestStats {
  const snapshots: DailySnapshot[] = [];
  const dailyPnl: Record<string, number> = {};

  for (const market of markets) {
    if (market.priceHistory.length === 0) continue;
    const resolution = market.resolution;

    for (const pt of market.priceHistory) {
      const marketPrice = pt.price;
      const modelProb = computeModelProb(marketPrice, cfg);
      const yesEv = computeEV(modelProb, marketPrice);
      const noEv  = computeEV(1 - modelProb, 1 - marketPrice);
      const bestEv = Math.max(yesEv, noEv);

      let signal: "BUY_YES" | "BUY_NO" | "SKIP" = "SKIP";
      let effectiveModelProb = modelProb;
      let effectiveMarketPrice = marketPrice;

      if (yesEv >= noEv && yesEv >= cfg.minEvThreshold) {
        signal = "BUY_YES";
      } else if (noEv > yesEv && noEv >= cfg.minEvThreshold) {
        signal = "BUY_NO";
        effectiveModelProb = 1 - modelProb;
        effectiveMarketPrice = 1 - marketPrice;
      }

      let sizeUsd = 0;
      let pnl: number | null = null;

      if (signal !== "SKIP") {
        const kelly = computeKelly(effectiveModelProb, effectiveMarketPrice, cfg.kellyFraction);
        sizeUsd = clamp(kelly * cfg.maxPositionUsd, 0, cfg.maxPositionUsd);

        if (resolution !== null && sizeUsd > 0) {
          const didWin = signal === "BUY_YES" ? resolution === 1 : resolution === 0;
          const shares = sizeUsd / effectiveMarketPrice;
          pnl = didWin ? shares - sizeUsd : -sizeUsd;
          dailyPnl[pt.date] = (dailyPnl[pt.date] ?? 0) + pnl;
        }
      }

      snapshots.push({
        date: pt.date,
        marketQuestion: market.question,
        marketPrice,
        modelProb,
        ev: bestEv,
        signal,
        sizeUsd,
        pnl,
        resolution,
      });
    }
  }

  const traded = snapshots.filter((s) => s.signal !== "SKIP");
  const resolved = traded.filter((s) => s.pnl !== null);
  const wins = resolved.filter((s) => (s.pnl ?? 0) > 0).length;
  const losses = resolved.filter((s) => (s.pnl ?? 0) <= 0).length;
  const totalPnl = resolved.reduce((sum, s) => sum + (s.pnl ?? 0), 0);
  const avgEv = traded.length > 0
    ? traded.reduce((sum, s) => sum + s.ev, 0) / traded.length
    : 0;

  const sortedDates = Object.keys(dailyPnl).sort();
  const dailyReturns = sortedDates.map((d) => dailyPnl[d]!);
  const cumPnl: number[] = [];
  let running = 0;
  for (const r of dailyReturns) { running += r; cumPnl.push(running); }

  return {
    totalMarkets: markets.length,
    marketsWithHistory: markets.filter((m) => m.priceHistory.length >= 2).length,
    totalSnapshots: snapshots.length,
    tradedSnapshots: traded.length,
    wins,
    losses,
    winRate: resolved.length > 0 ? wins / resolved.length : 0,
    totalPnl,
    avgEv,
    sharpe: computeSharpe(dailyReturns),
    maxDrawdown: computeMaxDrawdown(cumPnl),
    dailyPnl,
    snapshots,
  };
}
