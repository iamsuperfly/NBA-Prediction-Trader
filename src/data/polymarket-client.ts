import { config } from "../config.js";
import type { PolymarketMarket, PolymarketToken, PolymarketOrderBook } from "../types.js";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polymarket API ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

export async function getNBAMarkets(): Promise<PolymarketMarket[]> {
  const markets: PolymarketMarket[] = [];
  let nextCursor: string | null = null;

  do {
    const url = nextCursor
      ? `${config.polymarket.gammaApi}/markets?active=true&closed=false&tag_slug=nba&next_cursor=${nextCursor}`
      : `${config.polymarket.gammaApi}/markets?active=true&closed=false&tag_slug=nba`;

    const data = await fetchJson<any>(url);
    const items: any[] = data.data ?? data ?? [];

    for (const m of items) {
      const tokens = parseTokens(m);
      if (tokens.length < 2) continue;

      markets.push({
        conditionId: m.conditionId ?? m.condition_id ?? "",
        questionId: m.questionId ?? m.question_id ?? "",
        question: m.question ?? m.title ?? "",
        description: m.description ?? "",
        endDate: m.endDate ?? m.end_date ?? "",
        active: m.active ?? true,
        closed: m.closed ?? false,
        tokens,
        volumeNum: Number(m.volumeNum ?? m.volume ?? 0),
        liquidityNum: Number(m.liquidityNum ?? m.liquidity ?? 0),
      });
    }

    nextCursor = data.next_cursor ?? null;
    if (markets.length >= 100) break;
  } while (nextCursor);

  return markets.sort((a, b) => b.volumeNum - a.volumeNum);
}

export async function getPlayoffSeriesMarkets(): Promise<PolymarketMarket[]> {
  const all = await getNBAMarkets();
  const keywords = ["series", "advance", "win the", "champion", "finals", "conference"];
  return all.filter((m) =>
    keywords.some((kw) => m.question.toLowerCase().includes(kw))
  );
}

export async function getOrderBook(tokenId: string): Promise<PolymarketOrderBook | null> {
  try {
    const data = await fetchJson<any>(
      `${config.polymarket.clobApi}/book?token_id=${tokenId}`
    );
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
    };
  } catch (err) {
    console.error("[polymarket] order book error:", err);
    return null;
  }
}

export async function getMarketPrices(
  conditionId: string
): Promise<{ yes: number; no: number } | null> {
  try {
    const data = await fetchJson<any>(
      `${config.polymarket.clobApi}/markets/${conditionId}`
    );
    const tokens: any[] = data.tokens ?? [];
    const yes = tokens.find((t: any) => t.outcome?.toLowerCase() === "yes");
    const no = tokens.find((t: any) => t.outcome?.toLowerCase() === "no");

    if (!yes || !no) return null;
    return { yes: Number(yes.price), no: Number(no.price) };
  } catch {
    return null;
  }
}

function parseTokens(m: any): PolymarketToken[] {
  const raw: any[] = m.tokens ?? m.clobTokenIds ?? [];

  if (raw.length > 0 && typeof raw[0] === "object" && raw[0] !== null && "price" in raw[0]) {
    return raw.map((t: any) => ({
      tokenId: t.token_id ?? t.tokenId ?? "",
      outcome: t.outcome ?? "Yes",
      price: Number(t.price ?? 0.5),
    }));
  }

  const outcomes: string[] = m.outcomes ?? ["Yes", "No"];
  const prices: number[] = m.outcomePrices
    ? (m.outcomePrices as string[]).map(Number)
    : [0.5, 0.5];

  return outcomes.map((outcome, i) => ({
    tokenId: Array.isArray(raw) && typeof raw[i] === "string" ? raw[i] as string : "",
    outcome,
    price: prices[i] ?? 0.5,
  }));
}
