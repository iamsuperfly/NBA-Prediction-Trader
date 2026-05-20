import { ethers } from "ethers";
import { config } from "../config.js";
import type { TradeOpportunity, TradeResult } from "../types.js";
import { formatOpportunitySummary } from "./sizer.js";

let _wallet: ethers.Wallet | null = null;

function getWallet(): ethers.Wallet {
  if (!_wallet) {
    const provider = new ethers.JsonRpcProvider(config.network.polygonRpc);
    _wallet = new ethers.Wallet(config.wallet.privateKey, provider);
  }
  return _wallet;
}

export async function getWalletBalance(): Promise<{ matic: string; usdcApprox: string }> {
  try {
    const wallet = getWallet();
    const balanceWei = await wallet.provider!.getBalance(wallet.address);
    const matic = ethers.formatEther(balanceWei);
    const maticPrice = 0.4;
    const usdcApprox = (Number(matic) * maticPrice).toFixed(2);
    return { matic: Number(matic).toFixed(4), usdcApprox };
  } catch (err) {
    console.error("[trader] Balance check error:", err);
    return { matic: "0.0000", usdcApprox: "0.00" };
  }
}

export async function executeTrade(
  opportunity: TradeOpportunity
): Promise<TradeResult> {
  const timestamp = new Date().toISOString();

  console.log(`\n${"─".repeat(60)}`);
  console.log(`[trader] ${config.trading.mode.toUpperCase()} — ${opportunity.signal}`);
  console.log(`  Market : ${opportunity.market.question}`);
  console.log(`  Token  : ${opportunity.token.outcome} (${opportunity.token.tokenId.slice(0, 12)}...)`);
  console.log(
    `  ${formatOpportunitySummary(
      opportunity.modelProbability,
      opportunity.marketProbability,
      opportunity.kellyFraction,
      opportunity.suggestedSizeUsd
    )}`
  );
  console.log(`  Reason : ${opportunity.reasoning}`);

  if (config.trading.mode === "dry-run") {
    const simulatedPnl = simulatePnl(opportunity);
    console.log(`  [DRY-RUN] Simulated PnL: $${simulatedPnl >= 0 ? "+" : ""}${simulatedPnl.toFixed(4)}`);
    return {
      opportunity,
      mode: "dry-run",
      success: true,
      timestamp,
      simulatedPnl,
    };
  }

  try {
    console.log("  [LIVE] Submitting order to Polymarket CLOB...");

    const orderPayload = buildOrderPayload(opportunity);
    const res = await fetch(`${config.polymarket.clobApi}/order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "POLY_ADDRESS": config.wallet.address,
      },
      body: JSON.stringify(orderPayload),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CLOB order rejected: ${res.status} ${body}`);
    }

    const data = (await res.json()) as { orderID?: string; order?: { id: string } };
    const orderId = data.orderID ?? data.order?.id ?? "unknown";

    console.log(`  [LIVE] Order placed — ID: ${orderId}`);

    return {
      opportunity,
      mode: "live",
      success: true,
      orderId,
      timestamp,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`  [LIVE] Order failed: ${error}`);
    return {
      opportunity,
      mode: "live",
      success: false,
      error,
      timestamp,
    };
  }
}

function buildOrderPayload(opportunity: TradeOpportunity): Record<string, unknown> {
  const isBuyYes = opportunity.signal === "BUY_YES";
  const price = isBuyYes
    ? opportunity.market.tokens.find((t) => t.outcome.toLowerCase() === "yes")?.price
    : opportunity.market.tokens.find((t) => t.outcome.toLowerCase() === "no")?.price;

  return {
    tokenID: opportunity.token.tokenId,
    price: price ?? opportunity.marketProbability,
    size: opportunity.suggestedSizeUsd,
    side: "BUY",
    feeRateBps: 0,
    type: "GTD",
    expiration: Math.floor(Date.now() / 1000) + 300,
    maker: config.wallet.address,
  };
}

function simulatePnl(opportunity: TradeOpportunity): number {
  const { modelProbability, marketProbability, suggestedSizeUsd, signal } = opportunity;
  const prob = signal === "BUY_YES" ? modelProbability : 1 - modelProbability;
  const price = signal === "BUY_YES" ? marketProbability : 1 - marketProbability;
  const shares = suggestedSizeUsd / price;
  const winProfit = shares - suggestedSizeUsd;
  const lossLoss = -suggestedSizeUsd;
  return prob * winProfit + (1 - prob) * lossLoss;
}
