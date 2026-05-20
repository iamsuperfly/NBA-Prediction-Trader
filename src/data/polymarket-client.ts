import { config } from "../config.js";
import type { PolymarketMarket, PolymarketToken, PolymarketOrderBook } from "../types.js";

const NBA_TEAM_KEYWORDS = [
  "hawks", "celtics", "nets", "hornets", "bulls", "cavaliers", "mavericks",
  "nuggets", "pistons", "warriors", "rockets", "pacers", "clippers", "lakers",
  "grizzlies", "heat", "bucks", "timberwolves", "pelicans", "knicks", "thunder",
  "magic", "76ers", "suns", "blazers", "kings", "spurs", "raptors", "jazz", "wizards",
  "nba", "finals", "playoff", "championship", "eastern conference", "western conference",
];

async function fetchJson<T>(url: string, retries = 2): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      return res.json() as Promise<T>;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

export async function getNBAMarkets(): Promise<PolymarketMarket[]> {
  const [gammaMarkets, clobMarkets] = await Promise.allSettled([
    fetchNBAMarketsFromGamma(),
    fetchNBAMarketsFromClob(),
  ]);

  const allById = new Map<string, PolymarketMarket>();

  if (gammaMarkets.status === "fulfilled") {
    for (const m of gammaMarkets.value) allById.set(m.conditionId, m);
  }

  if (clobMarkets.status === "fulfilled") {
    for (const m of clobMarkets.value) {
      if (!allById.has(m.conditionId) || allById.get(m.conditionId)!.tokens.length === 0) {
        allById.set(m.conditionId, m);
      }
    }
  }

  return [...allById.values()]
    .filter(
      (m) =>
        m.active &&
        !m.closed &&
        m.tokens.length >= 2 &&
        m.tokens.some((t) => t.tokenId !== "") &&
        m.volumeNum >= config.trading.minVolumeUsd
    )
    .sort((a, b) => b.volumeNum - a.volumeNum);
}

async function fetchNBAMarketsFromGamma(): Promise<PolymarketMarket[]> {
  const keywords = ["NBA", "basketball"];
  const results: PolymarketMarket[] = [];

  for (const kw of keywords) {
    try {
      const data = await fetchJson<any>(
        `${config.polymarket.gammaApi}/markets?active=true&closed=false&limit=100&keyword=${encodeURIComponent(kw)}`
      );
      const items: any[] = data.data ?? (Array.isArray(data) ? data : []);
      for (const m of items) {
        if (isNBAQuestion(m.question ?? m.title ?? "")) {
          const parsed = parseGammaMarket(m);
          if (parsed) results.push(parsed);
        }
      }
    } catch (err) {
      console.error(`[polymarket] gamma fetch error (${kw}):`, (err as Error).message);
    }
  }
  return dedup(results);
}

async function fetchNBAMarketsFromClob(): Promise<PolymarketMarket[]> {
  try {
    const results: PolymarketMarket[] = [];
    let nextCursor = "";
    let page = 0;

    do {
      const url = nextCursor
        ? `${config.polymarket.clobApi}/markets?active=true&limit=100&next_cursor=${nextCursor}`
        : `${config.polymarket.clobApi}/markets?active=true&limit=100`;

      const data = await fetchJson<any>(url);
      const items: any[] = data.data ?? [];

      for (const m of items) {
        if (!isNBAQuestion(m.question ?? "")) continue;
        if (m.closed || !m.active) continue;
        const parsed = parseClobMarket(m);
        if (parsed) results.push(parsed);
      }

      nextCursor = data.next_cursor ?? "";
      page++;
    } while (nextCursor && page < 10 && results.length < 200);

    return results;
  } catch (err) {
    console.error("[polymarket] CLOB fetch error:", (err as Error).message);
    return [];
  }
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
  const seriesKw = ["series", "advance", "win the", "championship", "finals", "conference", "beat"];
  return all.filter((m) =>
    seriesKw.some((kw) => m.question.toLowerCase().includes(kw))
  );
}

export async function getGameMarkets(): Promise<PolymarketMarket[]> {
  const all = await getNBAMarkets();
  const gameKw = ["game", "vs.", "vs ", " @ ", "tonight", "match"];
  return all.filter((m) =>
    gameKw.some((kw) => m.question.toLowerCase().includes(kw))
  );
}

function isNBAQuestion(q: string): boolean {
  const lower = q.toLowerCase();
  return NBA_TEAM_KEYWORDS.some((kw) => lower.includes(kw));
}

function parseGammaMarket(m: any): PolymarketMarket | null {
  const conditionId: string = m.conditionId ?? m.condition_id ?? "";
  if (!conditionId) return null;

  const tokens = extractTokens(m);
  return {
    conditionId,
    questionId: m.questionId ?? m.question_id ?? "",
    question: m.question ?? m.title ?? "",
    description: m.description ?? "",
    endDate: m.endDate ?? m.end_date ?? "",
    active: m.active ?? true,
    closed: m.closed ?? false,
    acceptingOrders: m.acceptingOrders ?? m.accepting_orders ?? false,
    tokens,
    volumeNum: Number(m.volumeNum ?? m.volume ?? 0),
    liquidityNum: Number(m.liquidityNum ?? m.liquidity ?? 0),
    minimumTickSize: Number(m.minimumTickSize ?? 0.01),
    minimumOrderSize: Number(m.minimumOrderSize ?? 15),
  };
}

function parseClobMarket(m: any): PolymarketMarket | null {
  const conditionId: string = m.condition_id ?? m.conditionId ?? "";
  if (!conditionId) return null;

  const tokens = extractTokens(m);
  return {
    conditionId,
    questionId: m.question_id ?? m.questionId ?? "",
    question: m.question ?? "",
    description: m.description ?? "",
    endDate: m.end_date ?? m.endDate ?? "",
    active: m.active ?? true,
    closed: m.closed ?? false,
    acceptingOrders: m.accepting_orders ?? m.acceptingOrders ?? false,
    tokens,
    volumeNum: Number(m.volume_num ?? m.volumeNum ?? m.volume ?? 0),
    liquidityNum: Number(m.liquidity_num ?? m.liquidityNum ?? m.liquidity ?? 0),
    minimumTickSize: Number(m.minimum_tick_size ?? m.minimumTickSize ?? 0.01),
    minimumOrderSize: Number(m.minimum_order_size ?? m.minimumOrderSize ?? 15),
  };
}

function extractTokens(m: any): PolymarketToken[] {
  const rawTokens: any[] = m.tokens ?? [];
  if (rawTokens.length > 0 && typeof rawTokens[0] === "object" && rawTokens[0] !== null) {
    const withPrices = rawTokens.filter((t: any) => "price" in t || "outcome" in t);
    if (withPrices.length > 0) {
      return withPrices.map((t: any) => ({
        tokenId: t.token_id ?? t.tokenId ?? "",
        outcome: t.outcome ?? "Unknown",
        price: Number(t.price ?? 0.5),
      }));
    }
  }

  const outcomes: string[] = m.outcomes ?? m.outcome_prices ? Object.keys(m.outcome_prices ?? {}) : ["Yes", "No"];
  const prices: number[] = m.outcomePrices
    ? (Array.isArray(m.outcomePrices) ? m.outcomePrices : Object.values(m.outcomePrices)).map(Number)
    : [0.5, 0.5];

  const clobIds: string[] = Array.isArray(m.clobTokenIds) ? m.clobTokenIds : [];

  return outcomes.map((outcome, i) => ({
    tokenId: typeof rawTokens[i] === "string" ? (rawTokens[i] as string) : (clobIds[i] ?? ""),
    outcome,
    price: prices[i] ?? 0.5,
  }));
}

function dedup(markets: PolymarketMarket[]): PolymarketMarket[] {
  const seen = new Set<string>();
  return markets.filter((m) => {
    if (seen.has(m.conditionId)) return false;
    seen.add(m.conditionId);
    return true;
  });
}
