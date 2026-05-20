import { config } from "../config.js";

export function computeEdge(modelProb: number, marketProb: number): number {
  return modelProb - marketProb;
}

export function computeExpectedValue(
  modelProb: number,
  marketProb: number
): number {
  if (marketProb <= 0 || marketProb >= 1) return 0;
  const odds = 1 / marketProb;
  const netOdds = odds - 1;
  return modelProb * netOdds - (1 - modelProb);
}

export function computeKelly(modelProb: number, marketProb: number): number {
  if (marketProb <= 0 || marketProb >= 1) return 0;
  if (modelProb <= 0 || modelProb >= 1) return 0;

  const b = (1 - marketProb) / marketProb;
  const p = modelProb;
  const q = 1 - p;

  const fullKelly = (b * p - q) / b;
  if (fullKelly <= 0) return 0;

  return Math.min(fullKelly * config.trading.kellyFraction, 0.25);
}

export function computePositionSize(
  kelly: number,
  bankrollUsd: number
): number {
  const raw = kelly * bankrollUsd;
  return Math.min(raw, config.trading.maxPositionUsd, bankrollUsd * 0.1);
}

export function meetsEvThreshold(
  modelProb: number,
  marketProb: number
): boolean {
  const ev = computeExpectedValue(modelProb, marketProb);
  return ev >= config.trading.minEvThreshold;
}

export function formatOpportunitySummary(
  modelProb: number,
  marketProb: number,
  kelly: number,
  positionUsd: number
): string {
  const edge = computeEdge(modelProb, marketProb);
  const ev = computeExpectedValue(modelProb, marketProb);
  const evMeetsThreshold = ev >= config.trading.minEvThreshold;

  return [
    `Model ${(modelProb * 100).toFixed(1)}% | Market ${(marketProb * 100).toFixed(1)}%`,
    `Edge ${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%`,
    `EV ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}% ${evMeetsThreshold ? "✓" : "✗ (below 8%)"}`,
    `Kelly ${(kelly * 100).toFixed(1)}% | Size $${positionUsd.toFixed(2)}`,
  ].join(" | ");
}
