import { config } from "../config.js";

export function computeEdge(modelProb: number, marketProb: number): number {
  return modelProb - marketProb;
}

export function computeKelly(modelProb: number, marketProb: number): number {
  if (marketProb <= 0 || marketProb >= 1) return 0;

  const b = (1 - marketProb) / marketProb;
  const p = modelProb;
  const q = 1 - p;

  const fullKelly = (b * p - q) / b;

  const fractional = Math.max(0, fullKelly) * config.trading.kellyFraction;
  return Math.min(fractional, 0.25);
}

export function computePositionSize(
  kelly: number,
  bankrollUsd: number,
  maxPositionUsd: number
): number {
  const raw = kelly * bankrollUsd;
  return Math.min(raw, maxPositionUsd, bankrollUsd * 0.1);
}

export function computeExpectedValue(
  modelProb: number,
  marketProb: number,
  positionUsd: number
): number {
  const winPayoff = positionUsd * (1 / marketProb - 1);
  const lossPayoff = -positionUsd;
  return modelProb * winPayoff + (1 - modelProb) * lossPayoff;
}

export function formatOpportunitySummary(
  modelProb: number,
  marketProb: number,
  kelly: number,
  positionUsd: number
): string {
  const edge = computeEdge(modelProb, marketProb);
  const ev = computeExpectedValue(modelProb, marketProb, positionUsd);

  return [
    `Model: ${(modelProb * 100).toFixed(1)}%`,
    `Market: ${(marketProb * 100).toFixed(1)}%`,
    `Edge: ${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%`,
    `Kelly%: ${(kelly * 100).toFixed(1)}%`,
    `Size: $${positionUsd.toFixed(2)}`,
    `EV: $${ev >= 0 ? "+" : ""}${ev.toFixed(3)}`,
  ].join(" | ");
}
