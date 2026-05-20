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

export interface TeamForm {
  last5Wins: number;
  last10Wins: number;
  homeWinPct: number;
  awayWinPct: number;
  last5PointDiff: number;
}

export interface InjuryReport {
  teamAbbr: string;
  players: InjuredPlayer[];
  impactScore: number;
}

export interface InjuredPlayer {
  name: string;
  status: "Out" | "Doubtful" | "Questionable" | "Day-To-Day";
  position: string;
  impactWeight: number;
}

export interface SeriesState {
  team1: string;
  team2: string;
  team1Wins: number;
  team2Wins: number;
  gamesPlayed: number;
  lastWinner: string | null;
  homeTeamWinStreak: number;
}

export interface PolymarketMarket {
  conditionId: string;
  questionId: string;
  question: string;
  description: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  tokens: PolymarketToken[];
  volumeNum: number;
  liquidityNum: number;
  minimumTickSize: number;
  minimumOrderSize: number;
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
  midpoint: number;
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
  expectedValue: number;
  kellyFraction: number;
  suggestedSizeUsd: number;
  signal: "BUY_YES" | "BUY_NO" | "SKIP";
  confidence: number;
  reasoning: string;
  factors: string[];
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

export interface WalletBalance {
  matic: string;
  usdc: string;
  usdcRaw: bigint;
}
