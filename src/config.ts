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
    address: optional("WALLET_ADDRESS", "0xce16A1A0D39C564fb0479699662e4c5AEB042f11"),
    privateKey: required("WALLET_PRIVATE_KEY"),
  },
  network: {
    polygonRpc: optional("POLYGON_RPC_URL", "https://polygon-rpc.com"),
    chainId: 137,
    usdcAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  },
  polymarket: {
    clobApi: optional("POLYMARKET_CLOB_API", "https://clob.polymarket.com"),
    gammaApi: optional("POLYMARKET_GAMMA_API", "https://gamma-api.polymarket.com"),
    ctfExchange: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
    negRiskCtfExchange: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  },
  nba: {
    espnApi: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba",
  },
  trading: {
    mode: optional("TRADING_MODE", "dry-run") as "dry-run" | "live",
    maxPositionUsd: Number(optional("MAX_POSITION_USD", "10")),
    kellyFraction: Number(optional("KELLY_FRACTION", "0.25")),
    minEvThreshold: Number(optional("MIN_EV_THRESHOLD", "0.08")),
    minLiquidityUsd: Number(optional("MIN_LIQUIDITY_USD", "1000")),
    minVolumeUsd: Number(optional("MIN_VOLUME_USD", "50000")),
    scanIntervalMs: Number(optional("SCAN_INTERVAL_MS", "60000")),
  },
} as const;

export type TradingMode = typeof config.trading.mode;
