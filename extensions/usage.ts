export interface UsageWindow {
  usagePercent: number;
  resetInSec: number;
  usageDollars?: number;
  limitDollars?: number;
}

export interface UsageData {
  rolling: UsageWindow | null;
  weekly: UsageWindow | null;
  monthly: UsageWindow | null;
  source?: "api" | "scrape";
  error?: string;
  stale?: boolean;
  warning?: string;
  fetchedAt?: number;
}

export function normalizeApiUsage(raw: unknown): UsageData {
  const cast = raw as Record<string, any> | null | undefined;
  const usage = cast?.usage && typeof cast.usage === "object" ? cast.usage : cast;
  const pick = (key: string, legacyKey = key): UsageWindow | null => {
    const w = usage?.[key] ?? cast?.[legacyKey];
    if (!w || typeof w !== "object") return null;
    const pct = Number(w.percent ?? w.usagePercent);
    const reset = w.resetsAt ?? w.resetInSec;
    const resetInSec = typeof reset === "string"
      ? Math.ceil((Date.parse(reset) - Date.now()) / 1000)
      : Number(reset);
    if (!Number.isFinite(pct) || !Number.isFinite(resetInSec)) return null;
    return {
      usagePercent: pct,
      resetInSec: Math.max(0, Math.floor(resetInSec)),
      usageDollars: Number.isFinite(Number(w.usageDollars)) ? Number(w.usageDollars) : undefined,
      limitDollars: Number.isFinite(Number(w.limitDollars)) ? Number(w.limitDollars) : undefined,
    };
  };
  return {
    rolling: pick("rolling", "rolling5h"),
    weekly: pick("weekly"),
    monthly: pick("monthly"),
    source: "api",
    fetchedAt: Date.now(),
  };
}
