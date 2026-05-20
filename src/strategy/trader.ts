import { ethers } from "ethers";
import { config } from "../config.js";
import type { TradeOpportunity, TradeResult, WalletBalance } from "../types.js";
import { formatOpportunitySummary } from "./sizer.js";

const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const EIP712_ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
};

let _provider: ethers.JsonRpcProvider | null = null;
let _wallet: ethers.Wallet | null = null;

function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(config.network.polygonRpc, {
      chainId: config.network.chainId,
      name: "polygon",
    });
  }
  return _provider;
}

function getWallet(): ethers.Wallet {
  if (!_wallet) {
    _wallet = new ethers.Wallet(config.wallet.privateKey, getProvider());
  }
  return _wallet;
}

export async function getWalletBalance(): Promise<WalletBalance> {
  try {
    const wallet = getWallet();
    const provider = getProvider();

    const [maticWei, usdc] = await Promise.all([
      provider.getBalance(wallet.address),
      getUsdcBalance(wallet.address),
    ]);

    const matic = ethers.formatEther(maticWei);
    const usdcFormatted = (Number(usdc) / 1_000_000).toFixed(2);

    return { matic: Number(matic).toFixed(4), usdc: usdcFormatted, usdcRaw: usdc };
  } catch (err) {
    console.error("[trader] Balance check error:", (err as Error).message);
    return { matic: "0.0000", usdc: "0.00", usdcRaw: 0n };
  }
}

async function getUsdcBalance(address: string): Promise<bigint> {
  try {
    const contract = new ethers.Contract(config.network.usdcAddress, USDC_ABI, getProvider());
    return await contract.balanceOf(address) as bigint;
  } catch {
    return 0n;
  }
}

export async function executeTrade(opp: TradeOpportunity): Promise<TradeResult> {
  const timestamp = new Date().toISOString();

  const bar = "─".repeat(60);
  console.log(`\n${bar}`);
  console.log(`[trader] ${config.trading.mode.toUpperCase()} | ${opp.signal}`);
  console.log(`  Market : ${opp.market.question}`);
  console.log(
    `  ${formatOpportunitySummary(
      opp.modelProbability,
      opp.marketProbability,
      opp.kellyFraction,
      opp.suggestedSizeUsd
    )}`
  );
  opp.factors.slice(0, 3).forEach((f) => console.log(`  Factor : ${f}`));

  if (config.trading.mode === "dry-run") {
    return executeDryRun(opp, timestamp);
  }

  return executeLive(opp, timestamp);
}

function executeDryRun(opp: TradeOpportunity, timestamp: string): TradeResult {
  const { modelProbability, marketProbability, suggestedSizeUsd, signal } = opp;

  const effectiveProb = signal === "BUY_YES" ? modelProbability : 1 - modelProbability;
  const price = signal === "BUY_YES" ? marketProbability : 1 - marketProbability;
  const shares = suggestedSizeUsd / price;
  const winProfit = shares - suggestedSizeUsd;
  const simulatedPnl = effectiveProb * winProfit + (1 - effectiveProb) * (-suggestedSizeUsd);

  console.log(`  [DRY-RUN] Would ${signal} $${suggestedSizeUsd.toFixed(2)} @ ${(price * 100).toFixed(1)}¢`);
  console.log(`  [DRY-RUN] Expected PnL: ${simulatedPnl >= 0 ? "+" : ""}$${simulatedPnl.toFixed(4)}`);

  return { opportunity: opp, mode: "dry-run", success: true, timestamp, simulatedPnl };
}

async function executeLive(opp: TradeOpportunity, timestamp: string): Promise<TradeResult> {
  console.log("  [LIVE] Checking USDC balance...");

  const balance = await getWalletBalance();
  const usdcAvailable = Number(balance.usdc);

  if (usdcAvailable < opp.suggestedSizeUsd) {
    const error = `Insufficient USDC: have $${usdcAvailable.toFixed(2)}, need $${opp.suggestedSizeUsd.toFixed(2)}`;
    console.error(`  [LIVE] ${error}`);
    return { opportunity: opp, mode: "live", success: false, error, timestamp };
  }

  if (!opp.token.tokenId || opp.token.tokenId === "") {
    const error = "No tokenId available for this market — cannot place order";
    console.error(`  [LIVE] ${error}`);
    return { opportunity: opp, mode: "live", success: false, error, timestamp };
  }

  try {
    console.log("  [LIVE] Building signed order...");
    const { orderId } = await buildAndSubmitOrder(opp);
    console.log(`  [LIVE] ✅ Order placed — ID: ${orderId}`);
    return { opportunity: opp, mode: "live", success: true, orderId, timestamp };
  } catch (err) {
    const error = (err as Error).message;
    console.error(`  [LIVE] ❌ Order failed: ${error}`);
    return { opportunity: opp, mode: "live", success: false, error, timestamp };
  }
}

async function buildAndSubmitOrder(opp: TradeOpportunity): Promise<{ orderId: string }> {
  const wallet = getWallet();
  const sizeUsd = opp.suggestedSizeUsd;

  const isBuyYes = opp.signal === "BUY_YES";
  const tokenId = opp.token.tokenId;
  const price = isBuyYes ? opp.marketProbability : 1 - opp.marketProbability;

  const makerAmount = BigInt(Math.round(sizeUsd * 1_000_000));
  const takerAmount = BigInt(Math.round((sizeUsd / price) * 1_000_000));

  const expiration = BigInt(Math.floor(Date.now() / 1000) + 300);
  const salt = BigInt(Math.floor(Math.random() * 1e15));

  const domain = {
    name: "Polymarket CTF Exchange",
    version: "1",
    chainId: config.network.chainId,
    verifyingContract: config.polymarket.ctfExchange,
  };

  const orderMessage = {
    salt,
    maker: wallet.address,
    signer: wallet.address,
    taker: ethers.ZeroAddress,
    tokenId: BigInt(tokenId),
    makerAmount,
    takerAmount,
    expiration,
    nonce: 0n,
    feeRateBps: 0n,
    side: 0,
    signatureType: 0,
  };

  const signature = await wallet.signTypedData(domain, EIP712_ORDER_TYPES, orderMessage);

  const orderPayload = {
    order: {
      salt: salt.toString(),
      maker: wallet.address,
      signer: wallet.address,
      taker: ethers.ZeroAddress,
      tokenId: tokenId,
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      expiration: expiration.toString(),
      nonce: "0",
      feeRateBps: "0",
      side: isBuyYes ? "BUY" : "SELL",
      signatureType: 0,
      signature,
    },
    owner: wallet.address,
    orderType: "GTD",
  };

  const res = await fetch(`${config.polymarket.clobApi}/order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "POLY_ADDRESS": wallet.address,
    },
    body: JSON.stringify(orderPayload),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CLOB rejected order: ${res.status} — ${body}`);
  }

  const data = (await res.json()) as any;
  return { orderId: data.orderID ?? data.order?.id ?? data.orderId ?? "unknown" };
}
