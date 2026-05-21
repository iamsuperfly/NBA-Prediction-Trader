import "dotenv/config";

const GAMMA_API = process.env.POLYMARKET_GAMMA_API ?? "https://gamma-api.polymarket.com";
const CLOB_API  = process.env.POLYMARKET_CLOB_API  ?? "https://clob.polymarket.com";

const NBA_KEYWORDS = [
  "NBA Finals", "NBA Championship", "NBA Playoffs",
  "NBA Conference", "win the 2026 NBA", "win the 2025 NBA",
  "NBA Eastern", "NBA Western",
];

const NBA_MATCH = [
  "nba","finals","thunder","cavaliers","knicks","spurs","lakers","celtics",
  "warriors","nuggets","pacers","heat","bucks","suns","clippers","timberwolves",
  "hawks","grizzlies","pelicans","championship","eastern conference","western conference",
];

export interface HistoricalMarket {
  conditionId: string;
  question: string;
  resolution: number | null;
  endDate: string;
  volumeNum: number;
  liquidityNum: number;
  priceHistory: PricePoint[];
}

export interface PricePoint {
  ts: number;
  date: string;
  price: number;
}

async function fetchJson<T>(url: string, retries = 2): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      return res.json() as Promise<T>;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

function isNBAMarket(q: string): boolean {
  const lower = q.toLowerCase();
  return NBA_MATCH.some((kw) => lower.includes(kw));
}

export async function fetchHistoricalNBAMarkets(days = 30): Promise<HistoricalMarket[]> {
  const endTs   = Math.floor(Date.now() / 1000);
  const startTs = endTs - days * 86400;

  const markets: HistoricalMarket[] = [];
  const seen = new Set<string>();

  for (const kw of NBA_KEYWORDS) {
    try {
      const url = `${GAMMA_API}/markets?closed=true&limit=100&keyword=${encodeURIComponent(kw)}`;
      const data = await fetchJson<any>(url);
      const items: any[] = Array.isArray(data) ? data : (data.data ?? data.results ?? []);

      for (const m of items) {
        const conditionId: string = m.conditionId ?? m.condition_id ?? "";
        if (!conditionId || seen.has(conditionId)) continue;

        const q: string = m.question ?? m.title ?? "";
        if (!isNBAMarket(q)) continue;

        const endDate: string = m.endDate ?? m.end_date ?? "";
        const endEpoch = endDate ? Math.floor(new Date(endDate).getTime() / 1000) : 0;
        if (endEpoch < startTs) continue;

        seen.add(conditionId);

        const resolution = extractResolution(m);
        markets.push({
          conditionId, question: q, resolution,
          endDate, volumeNum: Number(m.volumeNum ?? m.volume ?? 0),
          liquidityNum: Number(m.liquidityNum ?? m.liquidity ?? 0),
          priceHistory: [],
        });
      }
    } catch (err) {
      console.error(`[history] gamma error (${kw}):`, (err as Error).message);
    }
  }

  console.log(`[history] Found ${markets.length} resolved NBA markets — fetching price history...`);

  const enriched = await Promise.all(
    markets.map(async (m) => {
      const history = await fetchPriceHistory(m.conditionId, startTs, endTs);
      return { ...m, priceHistory: history };
    })
  );

  return enriched.filter((m) => m.priceHistory.length >= 2);
}

function extractResolution(m: any): number | null {
  const outcomes: string[] = m.outcomes ?? [];
  const prices: any[] = m.outcomePrices ?? [];

  for (let i = 0; i < prices.length; i++) {
    const p = Number(prices[i]);
    if (p >= 0.99) return i === 0 ? 1 : 0;
    if (p <= 0.01) return i === 0 ? 0 : 1;
  }

  if (typeof m.resolution === "number") return m.resolution;
  if (m.winner !== undefined) return m.winner ? 1 : 0;
  return null;
}

async function fetchPriceHistory(
  conditionId: string,
  startTs: number,
  endTs: number
): Promise<PricePoint[]> {
  try {
    const url = `${CLOB_API}/prices-history?market=${conditionId}&startTs=${startTs}&endTs=${endTs}&interval=1d&fidelity=1440`;
    const data = await fetchJson<any>(url);
    const history: any[] = data.history ?? data.data ?? [];
    if (!Array.isArray(history) || history.length === 0) return [];

    return history.map((pt: any) => {
      const ts = Number(pt.t ?? pt.ts ?? pt.timestamp ?? 0);
      return {
        ts,
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        price: Number(pt.p ?? pt.price ?? 0.5),
      };
    }).filter((pt) => pt.price > 0 && pt.price < 1);
  } catch {
    return [];
  }
}
