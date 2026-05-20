export interface NBAGame {
  id: number;
  date: string;
  homeTeam: NBATeam;
  awayTeam: NBATeam;
  homeScore?: number;
  awayScore?: number;
  status: "scheduled" | "in_progress" | "final";
  period?: number;
  time?: string;
}

export interface NBATeam {
  id: number;
  name: string;
  fullName: string;
  abbreviation: string;
  wins: number;
  losses: number;
  winPct: number;
}

export interface NBAStandings {
  team: NBATeam;
  conference: "East" | "West";
  seed: number;
  playoffBound: boolean;
}

export interface PolymarketMarket {
  conditionId: string;
  questionId: string;
  question: string;
  description: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  tokens: PolymarketToken[];
  volumeNum: number;
  liquidityNum: number;
}

export interface PolymarketToken {
  tokenId: string;
  outcome: string;
  price: number;
}

export interface PolymarketOrderBook {
  market: string;
  asset_id: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  best_bid: number;
  best_ask: number;
  spread: number;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface TradeOpportunity {
  market: PolymarketMarket;
  token: PolymarketToken;
  modelProbability: number;
  marketProbability: number;
  edge: number;
  kellyFraction: number;
  suggestedSizeUsd: number;
  signal: "BUY_YES" | "BUY_NO" | "SKIP";
  reasoning: string;
}

export interface TradeResult {
  opportunity: TradeOpportunity;
  mode: "dry-run" | "live";
  success: boolean;
  orderId?: string;
  error?: string;
  timestamp: string;
  simulatedPnl?: number;
}

export interface StrategyStats {
  totalScans: number;
  opportunitiesFound: number;
  tradesExecuted: number;
  dryRunPnl: number;
  startedAt: string;
  lastScanAt: string;
}
