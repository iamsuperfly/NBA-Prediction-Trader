import { getPlayoffSeriesMarkets, getNBAMarkets, getMarketPrices } from "../data/polymarket-client.js";
import { predictGame, predictSeries } from "./predictor.js";
import { computeKelly, computeEdge } from "./sizer.js";
import { getPlayoffStandings, getPlayoffGames } from "../data/nba-client.js";
import { config } from "../config.js";
import type { TradeOpportunity, PolymarketMarket } from "../types.js";

export async function scanForOpportunities(): Promise<TradeOpportunity[]> {
  console.log("[scanner] Fetching live Polymarket NBA markets...");

  const [seriesMarkets, gameMarkets, standings, todaysGames] = await Promise.all([
    getPlayoffSeriesMarkets().catch(() => []),
    getNBAMarkets().catch(() => []),
    getPlayoffStandings().catch(() => []),
    getPlayoffGames().catch(() => []),
  ]);

  const opportunities: TradeOpportunity[] = [];

  console.log(`[scanner] Found ${seriesMarkets.length} series markets, ${gameMarkets.length} game markets`);
  console.log(`[scanner] Today's games: ${todaysGames.length}`);

  for (const game of todaysGames.filter((g) => g.status === "scheduled").slice(0, 5)) {
    const matchingMarket = gameMarkets.find((m) =>
      (m.question.toLowerCase().includes(game.homeTeam.name.toLowerCase()) ||
        m.question.toLowerCase().includes(game.homeTeam.abbreviation.toLowerCase())) &&
      (m.question.toLowerCase().includes(game.awayTeam.name.toLowerCase()) ||
        m.question.toLowerCase().includes(game.awayTeam.abbreviation.toLowerCase()))
    );

    if (!matchingMarket) continue;

    try {
      const prediction = await predictGame(game);
      const prices = await getMarketPrices(matchingMarket.conditionId);
      if (!prices) continue;

      const homeToken = matchingMarket.tokens.find((t) =>
        t.outcome.toLowerCase().includes(game.homeTeam.name.toLowerCase()) ||
        t.outcome.toLowerCase() === "yes"
      );
      if (!homeToken) continue;

      const marketProb = prices.yes;
      const modelProb = prediction.homeWinProbability;
      const edge = computeEdge(modelProb, marketProb);

      if (Math.abs(edge) >= config.trading.minEdgeThreshold) {
        const signal = edge > 0 ? "BUY_YES" : "BUY_NO";
        const effectiveProb = signal === "BUY_YES" ? modelProb : 1 - modelProb;
        const effectiveMarketProb = signal === "BUY_YES" ? marketProb : prices.no;
        const kelly = computeKelly(effectiveProb, effectiveMarketProb);
        const sizeUsd = Math.min(kelly * config.trading.maxPositionUsd, config.trading.maxPositionUsd);

        opportunities.push({
          market: matchingMarket,
          token: homeToken,
          modelProbability: modelProb,
          marketProbability: marketProb,
          edge,
          kellyFraction: kelly,
          suggestedSizeUsd: sizeUsd,
          signal,
          reasoning: [
            `Game: ${game.awayTeam.abbreviation} @ ${game.homeTeam.abbreviation}`,
            ...prediction.factors,
            `Model: ${(modelProb * 100).toFixed(1)}% | Market: ${(marketProb * 100).toFixed(1)}%`,
            `Edge: ${(edge * 100).toFixed(1)}% | Kelly: ${(kelly * 100).toFixed(1)}%`,
            `Confidence: ${(prediction.confidence * 100).toFixed(0)}%`,
          ].join(" | "),
        });
      }
    } catch (err) {
      console.error(`[scanner] Error processing game ${game.id}:`, err);
    }
  }

  for (const market of seriesMarkets.slice(0, 20)) {
    try {
      const prices = await getMarketPrices(market.conditionId);
      if (!prices) continue;

      const teams = extractTeamsFromQuestion(market.question);
      if (!teams) continue;

      const prediction = await predictSeries(teams.team1, teams.team2, standings);

      const yesToken = market.tokens.find((t) => t.outcome.toLowerCase() === "yes");
      if (!yesToken) continue;

      const edge = computeEdge(prediction.winProbability, prices.yes);

      if (Math.abs(edge) >= config.trading.minEdgeThreshold && prediction.confidence >= 0.5) {
        const signal = edge > 0 ? "BUY_YES" : "BUY_NO";
        const effectiveProb = signal === "BUY_YES" ? prediction.winProbability : 1 - prediction.winProbability;
        const effectiveMarketProb = signal === "BUY_YES" ? prices.yes : prices.no;
        const kelly = computeKelly(effectiveProb, effectiveMarketProb);
        const sizeUsd = Math.min(kelly * config.trading.maxPositionUsd, config.trading.maxPositionUsd);

        opportunities.push({
          market,
          token: yesToken,
          modelProbability: prediction.winProbability,
          marketProbability: prices.yes,
          edge,
          kellyFraction: kelly,
          suggestedSizeUsd: sizeUsd,
          signal,
          reasoning: [
            `Series: ${market.question}`,
            ...prediction.factors,
            `Model: ${(prediction.winProbability * 100).toFixed(1)}% | Market: ${(prices.yes * 100).toFixed(1)}%`,
            `Edge: ${(edge * 100).toFixed(1)}% | Confidence: ${(prediction.confidence * 100).toFixed(0)}%`,
          ].join(" | "),
        });
      }
    } catch (err) {
      console.error(`[scanner] Error processing series market:`, err);
    }
  }

  return opportunities.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
}

function extractTeamsFromQuestion(question: string): { team1: string; team2: string } | null {
  const patterns = [
    /(\w+(?:\s+\w+)?)\s+vs\.?\s+(\w+(?:\s+\w+)?)/i,
    /Will the (\w+(?:\s+\w+)?) (?:beat|defeat|eliminate) the (\w+(?:\s+\w+)?)/i,
    /(\w+(?:\s+\w+)?) (?:to win|to advance|to beat) (?:the )?(\w+(?:\s+\w+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (match?.[1] && match[2]) {
      return { team1: match[1].trim(), team2: match[2].trim() };
    }
  }
  return null;
}
