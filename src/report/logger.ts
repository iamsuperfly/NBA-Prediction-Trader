import fs from "fs";
import path from "path";
import type { TradeResult, StrategyStats } from "../types.js";

const LOG_PATH = path.resolve("trades.log.json");

export interface SessionEntry {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  mode: "dry-run" | "live" | "scan";
  stats: StrategyStats;
  trades: TradeResult[];
}

function loadLog(): SessionEntry[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(LOG_PATH, "utf8")) as SessionEntry[];
  } catch {
    return [];
  }
}

function saveLog(entries: SessionEntry[]): void {
  fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2));
}

export function persistSession(entry: SessionEntry): void {
  const log = loadLog();
  const existing = log.findIndex((e) => e.sessionId === entry.sessionId);
  if (existing >= 0) {
    log[existing] = entry;
  } else {
    log.push(entry);
  }
  saveLog(log);
}

export function loadSessions(): SessionEntry[] {
  return loadLog();
}

export function logPath(): string {
  return LOG_PATH;
}
