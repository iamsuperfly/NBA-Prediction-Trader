import {
  getPlayoffSeriesMarkets,
  getGameMarkets,
  getMarketWithTokens,
  getOrderBook,
} from "../data/polymarket-client.js";
import { predictGame, predictSeries } from "./predictor.js";
import { computeKelly, computeExpectedValue, meetsEvThreshold } from "./sizer.js";
import { getPlayoffStandings, getPlayoffGames } from "../data/nba-client.js";
import { config } from "../config.js";
import type { TradeOpportunity, PolymarketMarket, PolymarketToken } from "../types.js";

export async function scanForOpportunities(): Promise<TradeOpportunity[]> {
  console.log("[scanner] Starting market scan...");

  const [seriesMarkets, gameMarkets, standings, todaysGames] = await Promise.all([
    getPlayoffSeriesMarkets().catch((e) => { console.error("[scanner] series markets:", e.message); return []; }),
    getGameMarkets().catch((e) => { console.error("[scanner] game markets:", e.message); return []; }),
    getPlayoffStandings().catch((e) => { console.error("[scanner] standings:", e.message); return []; }),
    getPlayoffGames().catch((e) => { console.error("[scanner] games:", e.message); return []; }),
  ]);

  console.log(
    `[scanner] ${seriesMarkets.length} series markets | ${gameMarkets.length} game markets | ${todaysGames.length} today's games`
  );

  const opportunities: TradeOpportunity[] = [];

  const scheduledGames = todaysGames.filter((g) => g.status === "scheduled").slice(0, 8);
  for (const game of scheduledGames) {
    try {
      const market = matchGameMarket(game.homeTeam.abbreviation, game.awayTeam.abbreviation, gameMarkets);
      if (!market) continue;

      const resolvedMarket = market.tokens.some((t) => t.tokenId !== "")
        ? market
        : await getMarketWithTokens(market.conditionId) ?? market;

      if (!passesLiquidityFilter(resolvedMarket)) {
        console.log(`[scanner] Skipping low liquidity: ${resolvedMarket.question.slice(0, 50)}`);
        continue;
      }

      const yesToken = resolvedMarket.tokens.find((t) => t.outcome.toLowerCase() === "yes");
      const noToken = resolvedMarket.tokens.find((t) => t.outcome.toLowerCase() === "no");

      let yesPrice = yesToken?.price ?? 0;
      let noPrice = noToken?.price ?? 0;

      if (yesToken?.tokenId) {
        const ob = await getOrderBook(yesToken.tokenId);
        if (ob) {
          yesPrice = ob.midpoint > 0 ? ob.midpoint : yesPrice;
          noPrice = 1 - yesPrice;
        }
      }

      if (yesPrice <= 0 || yesPrice >= 1) continue;

      const prediction = await predictGame(game);
      const homeModelProb = prediction.homeWinProbability;

      const opp = evaluateOpportunity(
        resolvedMarket,
        yesToken ?? resolvedMarket.tokens[0]!,
        homeModelProb,
        yesPrice,
        prediction.confidence,
        prediction.factors,
        `Game: ${game.awayTeam.abbreviation} @ ${game.homeTeam.abbreviation}`
      );

      if (opp) opportunities.push(opp);
    } catch (err) {
      console.error(`[scanner] Error processing game ${game.id}:`, (err as Error).message);
    }
  }

  const processedSeries = new Set<string>();
  for (const market of seriesMarkets.slice(0, 30)) {
    try {
      if (processedSeries.has(market.conditionId)) continue;
      processedSeries.add(market.conditionId);

      if (!passesLiquidityFilter(market)) continue;

      const teams = extractTeamPair(market.question);
      if (!teams) continue;

      const resolvedMarket = market.tokens.some((t) => t.tokenId !== "")
        ? market
        : await getMarketWithTokens(market.conditionId) ?? market;

      const yesToken = resolvedMarket.tokens.find((t) => t.outcome.toLowerCase() === "yes");
      const noToken = resolvedMarket.tokens.find((t) => t.outcome.toLowerCase() === "no");

      let yesPrice = yesToken?.price ?? 0;
      if (yesToken?.tokenId) {
        const ob = await getOrderBook(yesToken.tokenId);
        if (ob) yesPrice = ob.midpoint > 0 ? ob.midpoint : yesPrice;
      }
      if (yesPrice <= 0 || yesPrice >= 1) continue;

      const prediction = await predictSeries(teams.team1, teams.team2, standings);
      if (prediction.confidence < 0.45) continue;

      const opp = evaluateOpportunity(
        resolvedMarket,
        yesToken ?? resolvedMarket.tokens[0]!,
        prediction.winProbability,
        yesPrice,
        prediction.confidence,
        prediction.factors,
        `Series: ${market.question.slice(0, 60)}`
      );

      if (opp) opportunities.push(opp);
    } catch (err) {
      console.error("[scanner] Series market error:", (err as Error).message);
    }
  }

  const ranked = opportunities.sort((a, b) => b.expectedValue - a.expectedValue);
  console.log(`[scanner] Found ${ranked.length} opportunities above EV +${(config.trading.minEvThreshold * 100).toFixed(0)}% threshold`);
  return ranked;
}

function evaluateOpportunity(
  market: PolymarketMarket,
  token: PolymarketToken,
  modelProb: number,
  marketProb: number,
  confidence: number,
  factors: string[],
  label: string
): TradeOpportunity | null {
  const confidenceAdjModelProb = adjustForConfidence(modelProb, marketProb, confidence);

  const yesEv = computeExpectedValue(confidenceAdjModelProb, marketProb);
  const noEv = computeExpectedValue(1 - confidenceAdjModelProb, 1 - marketProb);

  const bestEv = Math.max(yesEv, noEv);
  const signal: "BUY_YES" | "BUY_NO" | "SKIP" =
    yesEv >= noEv && meetsEvThreshold(confidenceAdjModelProb, marketProb)
      ? "BUY_YES"
      : !meetsEvThreshold(confidenceAdjModelProb, marketProb) && meetsEvThreshold(1 - confidenceAdjModelProb, 1 - marketProb)
      ? "BUY_NO"
      : "SKIP";

  if (signal === "SKIP") return null;

  const effectiveModelProb = signal === "BUY_YES" ? confidenceAdjModelProb : 1 - confidenceAdjModelProb;
  const effectiveMarketProb = signal === "BUY_YES" ? marketProb : 1 - marketProb;

  const kelly = computeKelly(effectiveModelProb, effectiveMarketProb);
  if (kelly <= 0) return null;

  const sizeUsd = Math.min(kelly * config.trading.maxPositionUsd, config.trading.maxPositionUsd);

  const reasonParts = [
    label,
    `Model: ${(confidenceAdjModelProb * 100).toFixed(1)}% | Market: ${(marketProb * 100).toFixed(1)}%`,
    `EV: +${(bestEv * 100).toFixed(1)}% | Kelly: ${(kelly * 100).toFixed(1)}% | Size: $${sizeUsd.toFixed(2)}`,
    `Confidence: ${(confidence * 100).toFixed(0)}% | Liquidity: $${(market.liquidityNum / 1000).toFixed(0)}k | Vol: $${(market.volumeNum / 1000).toFixed(0)}k`,
    ...factors.slice(0, 3),
  ];

  return {
    market,
    token,
    modelProbability: confidenceAdjModelProb,
    marketProbability: marketProb,
    edge: computeExpectedValue(confidenceAdjModelProb, marketProb) - 0,
    expectedValue: bestEv,
    kellyFraction: kelly,
    suggestedSizeUsd: sizeUsd,
    signal,
    confidence,
    reasoning: reasonParts.join(" | "),
    factors,
  };
}

function adjustForConfidence(
  modelProb: number,
  marketProb: number,
  confidence: number
): number {
  return marketProb + (modelProb - marketProb) * confidence;
}

function passesLiquidityFilter(market: PolymarketMarket): boolean {
  return (
    market.liquidityNum >= config.trading.minLiquidityUsd &&
    market.volumeNum >= config.trading.minVolumeUsd &&
    market.active &&
    !market.closed
  );
}

function matchGameMarket(
  homeAbbr: string,
  awayAbbr: string,
  markets: PolymarketMarket[]
): PolymarketMarket | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const homeNorm = norm(homeAbbr);
  const awayNorm = norm(awayAbbr);

  return (
    markets.find((m) => {
      const q = norm(m.question);
      return q.includes(homeNorm) && q.includes(awayNorm);
    }) ?? null
  );
}

function extractTeamPair(question: string): { team1: string; team2: string } | null {
  const patterns = [
    /Will (?:the )?(.+?) (?:win|beat|defeat|eliminate|advance).+?(?:the )?(.+?)(?:\?|$)/i,
    /(.+?) (?:vs\.?|@) (.+?)(?:\?|$)/i,
    /(.+?) (?:to win|to advance).+?(?:the )?(.+?)(?:\?|$)/i,
    /(.+?) (?:series|over) (.+?)(?:\?|$)/i,
  ];

  for (const pat of patterns) {
    const m = question.match(pat);
    if (m?.[1] && m[2]) {
      const t1 = m[1].trim().replace(/^the /i, "");
      const t2 = m[2].trim().replace(/^the /i, "").replace(/\?$/, "");
      if (t1.length > 2 && t2.length > 2) {
        return { team1: t1, team2: t2 };
      }
    }
  }
  return null;
}
