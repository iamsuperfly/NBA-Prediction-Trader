import "dotenv/config";

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  wallet: {
    address: required("WALLET_ADDRESS"),
    privateKey: required("WALLET_PRIVATE_KEY"),
  },
  network: {
    polygonRpc: optional("POLYGON_RPC_URL", "https://polygon-rpc.com"),
    chainId: 137,
  },
  polymarket: {
    clobApi: optional("POLYMARKET_CLOB_API", "https://clob.polymarket.com"),
    gammaApi: "https://gamma-api.polymarket.com",
  },
  nba: {
    ballDontLieApi: "https://api.balldontlie.io/v1",
    espnApi: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba",
  },
  trading: {
    mode: optional("TRADING_MODE", "dry-run") as "dry-run" | "live",
    maxPositionUsd: Number(optional("MAX_POSITION_USD", "10")),
    kellyFraction: Number(optional("KELLY_FRACTION", "0.25")),
    minEdgeThreshold: Number(optional("MIN_EDGE_THRESHOLD", "0.03")),
    scanIntervalMs: Number(optional("SCAN_INTERVAL_MS", "60000")),
  },
} as const;

export type TradingMode = typeof config.trading.mode;
