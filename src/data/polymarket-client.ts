import { config } from "../config.js";
import type { PolymarketMarket, PolymarketToken, PolymarketOrderBook } from "../types.js";

const NBA_GAMMA_KEYWORDS = [
  "NBA Finals",
  "NBA Championship",
  "NBA Conference",
  "NBA Playoffs",
  "NBA Eastern",
  "NBA Western",
  "win the 2026 NBA",
  "NBA 2026",
];

const NBA_MATCH_KEYWORDS = [
  "nba", "finals", "thunder", "cavaliers", "knicks", "spurs", "lakers",
  "celtics", "warriors", "nuggets", "pacers", "heat", "bucks", "suns",
  "clippers", "timberwolves", "hawks", "grizzlies", "pelicans", "nets",
  "hornets", "bulls", "pistons", "rockets", "magic", "76ers", "blazers",
  "kings", "raptors", "jazz", "wizards", "playoff", "championship",
  "eastern conference", "western conference",
];

async function fetchJson<T>(url: string, retries = 2): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      return res.json() as Promise<T>;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

export async function getNBAMarkets(): Promise<PolymarketMarket[]> {
  const gammaMarkets = await fetchNBAMarketsFromGamma();

  const resolved = await Promise.all(
    gammaMarkets.map((m) => enrichWithClobTokens(m))
  );

  return resolved
    .filter(
      (m) =>
        m.active &&
        !m.closed &&
        m.liquidityNum >= config.trading.minLiquidityUsd &&
        m.volumeNum >= config.trading.minVolumeUsd
    )
    .sort((a, b) => b.volumeNum - a.volumeNum);
}

async function fetchNBAMarketsFromGamma(): Promise<PolymarketMarket[]> {
  const results: PolymarketMarket[] = [];
  const seen = new Set<string>();

  for (const kw of NBA_GAMMA_KEYWORDS) {
    try {
      const url = `${config.polymarket.gammaApi}/markets?active=true&closed=false&limit=100&keyword=${encodeURIComponent(kw)}`;
      const data = await fetchJson<any>(url);
      const items: any[] = Array.isArray(data) ? data : (data.data ?? data.results ?? []);

      for (const m of items) {
        const q: string = m.question ?? m.title ?? "";
        if (!isNBAMarket(q)) continue;
        const parsed = parseGammaMarket(m);
        if (!parsed || seen.has(parsed.conditionId)) continue;
        seen.add(parsed.conditionId);
        results.push(parsed);
      }
    } catch (err) {
      console.error(`[polymarket] gamma error (${kw}):`, (err as Error).message);
    }
  }

  console.log(`[polymarket] Gamma found ${results.length} NBA markets`);
  return results;
}

async function enrichWithClobTokens(market: PolymarketMarket): Promise<PolymarketMarket> {
  if (market.tokens.length > 0 && market.tokens.some((t) => t.tokenId !== "")) {
    return market;
  }
  try {
    const clobMarket = await fetchJson<any>(
      `${config.polymarket.clobApi}/markets/${market.conditionId}`
    );
    const enriched = parseClobMarket(clobMarket);
    if (enriched && enriched.tokens.length > 0) {
      return {
        ...market,
        tokens: enriched.tokens,
        acceptingOrders: enriched.acceptingOrders,
        minimumTickSize: enriched.minimumTickSize,
        minimumOrderSize: enriched.minimumOrderSize,
      };
    }
  } catch {}
  return market;
}

export async function getMarketWithTokens(conditionId: string): Promise<PolymarketMarket | null> {
  try {
    const data = await fetchJson<any>(`${config.polymarket.clobApi}/markets/${conditionId}`);
    return parseClobMarket(data);
  } catch {
    return null;
  }
}

export async function getOrderBook(tokenId: string): Promise<PolymarketOrderBook | null> {
  if (!tokenId) return null;
  try {
    const data = await fetchJson<any>(`${config.polymarket.clobApi}/book?token_id=${tokenId}`);
    const bids: any[] = data.bids ?? [];
    const asks: any[] = data.asks ?? [];
    const bestBid = bids.length > 0 ? Number(bids[0]!.price) : 0;
    const bestAsk = asks.length > 0 ? Number(asks[0]!.price) : 1;
    return {
      market: data.market ?? "",
      asset_id: tokenId,
      bids,
      asks,
      best_bid: bestBid,
      best_ask: bestAsk,
      spread: bestAsk - bestBid,
      midpoint: (bestBid + bestAsk) / 2,
    };
  } catch {
    return null;
  }
}

export async function getPlayoffSeriesMarkets(): Promise<PolymarketMarket[]> {
  const all = await getNBAMarkets();
  const kw = ["series", "advance", "win the", "championship", "finals", "conference", "beat"];
  return all.filter((m) => kw.some((k) => m.question.toLowerCase().includes(k)));
}

export async function getGameMarkets(): Promise<PolymarketMarket[]> {
  const all = await getNBAMarkets();
  const kw = ["game", "vs.", "vs ", " @ ", "tonight", "match"];
  return all.filter((m) => kw.some((k) => m.question.toLowerCase().includes(k)));
}

function isNBAMarket(q: string): boolean {
  const lower = q.toLowerCase();
  return NBA_MATCH_KEYWORDS.some((kw) => lower.includes(kw));
}

function parseGammaMarket(m: any): PolymarketMarket | null {
  const conditionId: string = m.conditionId ?? m.condition_id ?? "";
  if (!conditionId) return null;
  return {
    conditionId,
    questionId: m.questionId ?? m.question_id ?? "",
    question: m.question ?? m.title ?? "",
    description: m.description ?? "",
    endDate: m.endDate ?? m.end_date ?? "",
    active: m.active ?? true,
    closed: m.closed ?? false,
    acceptingOrders: m.acceptingOrders ?? m.accepting_orders ?? true,
    tokens: extractGammaTokens(m),
    volumeNum: Number(m.volumeNum ?? m.volume ?? 0),
    liquidityNum: Number(m.liquidityNum ?? m.liquidity ?? 0),
    minimumTickSize: Number(m.minimumTickSize ?? 0.01),
    minimumOrderSize: Number(m.minimumOrderSize ?? 15),
  };
}

function parseClobMarket(m: any): PolymarketMarket | null {
  const conditionId: string = m.condition_id ?? m.conditionId ?? "";
  if (!conditionId) return null;
  return {
    conditionId,
    questionId: m.question_id ?? m.questionId ?? "",
    question: m.question ?? "",
    description: m.description ?? "",
    endDate: m.end_date ?? m.endDate ?? "",
    active: m.active ?? true,
    closed: m.closed ?? false,
    acceptingOrders: m.accepting_orders ?? m.acceptingOrders ?? false,
    tokens: extractClobTokens(m),
    volumeNum: Number(m.volume_num ?? m.volumeNum ?? m.volume ?? 0),
    liquidityNum: Number(m.liquidity_num ?? m.liquidityNum ?? m.liquidity ?? 0),
    minimumTickSize: Number(m.minimum_tick_size ?? m.minimumTickSize ?? 0.01),
    minimumOrderSize: Number(m.minimum_order_size ?? m.minimumOrderSize ?? 15),
  };
}

function extractGammaTokens(m: any): PolymarketToken[] {
  const rawTokens: any[] = m.tokens ?? [];
  if (rawTokens.length > 0 && typeof rawTokens[0] === "object") {
    return rawTokens.map((t: any) => ({
      tokenId: t.token_id ?? t.tokenId ?? "",
      outcome: t.outcome ?? "Unknown",
      price: Number(t.price ?? 0.5),
    }));
  }
  return [];
}

function extractClobTokens(m: any): PolymarketToken[] {
  const rawTokens: any[] = m.tokens ?? [];
  if (rawTokens.length > 0 && typeof rawTokens[0] === "object") {
    const tokens = rawTokens.map((t: any) => ({
      tokenId: t.token_id ?? t.tokenId ?? "",
      outcome: t.outcome ?? "Unknown",
      price: Number(t.price ?? 0.5),
    }));
    if (tokens.some((t) => t.tokenId !== "")) return tokens;
  }

  const outcomes: string[] = m.outcomes ?? ["Yes", "No"];
  const prices: number[] = (() => {
    if (Array.isArray(m.outcomePrices)) return m.outcomePrices.map(Number);
    if (typeof m.outcomePrices === "object" && m.outcomePrices !== null)
      return Object.values(m.outcomePrices).map(Number);
    return [0.5, 0.5];
  })();
  const clobIds: string[] = Array.isArray(m.clobTokenIds) ? m.clobTokenIds : [];

  return outcomes.map((outcome: string, i: number) => ({
    tokenId: typeof rawTokens[i] === "string" ? (rawTokens[i] as string) : (clobIds[i] ?? ""),
    outcome,
    price: prices[i] ?? 0.5,
  }));
}
