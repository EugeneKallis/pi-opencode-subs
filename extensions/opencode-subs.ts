import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PROVIDER = "opencode-go";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "opencode-subs.json");
const FOOTER_KEY = "opencode-subs";

const POLL_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 12_000;
const USAGE_API_URL = "https://opencode.ai/zen/go/v1/usage";
const DASHBOARD_URL = (id: string) => `https://opencode.ai/workspace/${id}/go`;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

const QUOTA_ERROR_RE = /\b429\b|rate.?limit|too many requests|quota|usage limit|limit reached/i;
const ROTATION_DEDUP_MS = 5_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Workspace {
  workspace_id: string;
  workspace_api_key: string;
  auth_cookie?: string;
}

interface SubsConfig {
  _active?: string;
  [name: string]: Workspace | string | undefined;
}

interface UsageWindow {
  usagePercent: number;
  resetInSec: number;
  usageDollars?: number;
  limitDollars?: number;
}

interface UsageData {
  rolling: UsageWindow | null;
  weekly: UsageWindow | null;
  monthly: UsageWindow | null;
  source?: "api" | "scrape";
  error?: string;
  stale?: boolean;
  warning?: string;
  fetchedAt?: number;
}

// ─── Config helpers ─────────────────────────────────────────────────────────

function loadConfig(): SubsConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as SubsConfig;
  } catch {
    return {};
  }
}

function saveConfig(config: SubsConfig): void {
  const dir = join(homedir(), ".pi", "agent");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
  const data = JSON.stringify(config, null, 2);
  writeFileSync(tmp, data, { mode: 0o600 });
  writeFileSync(CONFIG_PATH, readFileSync(tmp), { mode: 0o600 });
}

function isWorkspaceEntry(value: unknown): value is Workspace {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Workspace).workspace_api_key === "string" &&
    (value as Workspace).workspace_api_key.length > 0
  );
}

function getWorkspaces(config: SubsConfig): Record<string, Workspace> {
  const out: Record<string, Workspace> = {};
  for (const [name, value] of Object.entries(config)) {
    if (name.startsWith("_")) continue;
    if (isWorkspaceEntry(value)) out[name] = value;
  }
  return out;
}

function getActiveName(config: SubsConfig): string | undefined {
  const workspaces = getWorkspaces(config);
  if (config._active && workspaces[config._active]) return config._active;
  const names = Object.keys(workspaces);
  if (names.length > 0) {
    config._active = names[0];
    saveConfig(config);
    return names[0];
  }
  return undefined;
}

function setActiveName(config: SubsConfig, name: string): void {
  const workspaces = getWorkspaces(config);
  if (!workspaces[name]) return;
  config._active = name;
  saveConfig(config);
}

function applyActiveWorkspace(
  config: SubsConfig,
  modelRegistry: ExtensionContext["modelRegistry"],
): string | undefined {
  const workspaces = getWorkspaces(config);
  const active = getActiveName(config);
  if (!active) {
    modelRegistry.authStorage.removeRuntimeApiKey(PROVIDER);
    return undefined;
  }
  const ws = workspaces[active];
  modelRegistry.authStorage.setRuntimeApiKey(PROVIDER, ws.workspace_api_key);
  return active;
}

function rotateToNextWorkspace(config: SubsConfig): string | undefined {
  const workspaces = getWorkspaces(config);
  const names = Object.keys(workspaces);
  if (names.length === 0) return undefined;
  const active = getActiveName(config);
  const idx = active ? names.indexOf(active) : -1;
  const next = names[(idx + 1) % names.length];
  setActiveName(config, next);
  return next;
}

// ─── Usage fetching ─────────────────────────────────────────────────────────

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeApiUsage(raw: unknown): UsageData {
  const cast = raw as Record<string, any> | null | undefined;
  const pick = (key: string): UsageWindow | null => {
    const w = cast?.[key];
    if (!w || typeof w !== "object") return null;
    const pct = Number(w.usagePercent);
    const rst = Number(w.resetInSec);
    if (!Number.isFinite(pct) || !Number.isFinite(rst)) return null;
    return {
      usagePercent: pct,
      resetInSec: Math.max(0, Math.floor(rst)),
      usageDollars: Number.isFinite(Number(w.usageDollars)) ? Number(w.usageDollars) : undefined,
      limitDollars: Number.isFinite(Number(w.limitDollars)) ? Number(w.limitDollars) : undefined,
    };
  };
  return {
    rolling: pick("rolling5h"),
    weekly: pick("weekly"),
    monthly: pick("monthly"),
    source: "api",
    fetchedAt: Date.now(),
  };
}

async function fetchUsageApi(apiKey: string): Promise<UsageData | null> {
  try {
    const resp = await fetchWithTimeout(
      USAGE_API_URL,
      { headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT } },
      FETCH_TIMEOUT_MS,
    );
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return null;
    const json = await resp.json();
    return normalizeApiUsage(json);
  } catch {
    return null;
  }
}

// Dashboard-scrape regexes (SolidJS SSR hydration). Mirrors pi-go-bars/core.ts.
const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
function windowRegex(name: string) {
  return [
    new RegExp(
      String.raw`${name}:\$R\[\d+\]=\{[^}]*usagePercent:${NUM}[^}]*resetInSec:${NUM}[^}]*\}`,
    ),
    new RegExp(
      String.raw`${name}:\$R\[\d+\]=\{[^}]*resetInSec:${NUM}[^}]*usagePercent:${NUM}[^}]*\}`,
    ),
  ];
}
const [RE_ROLLING_PCT, RE_ROLLING_RST] = windowRegex("rollingUsage");
const [RE_WEEKLY_PCT, RE_WEEKLY_RST] = windowRegex("weeklyUsage");
const [RE_MONTHLY_PCT, RE_MONTHLY_RST] = windowRegex("monthlyUsage");

function parseWindow(html: string, rePct: RegExp, reRst: RegExp): UsageWindow | null {
  let m = rePct.exec(html);
  if (m) {
    const usagePercent = Number(m[1]);
    const resetInSec = Number(m[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec: Math.max(0, Math.floor(resetInSec)) };
    }
  }
  m = reRst.exec(html);
  if (m) {
    const resetInSec = Number(m[1]);
    const usagePercent = Number(m[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec: Math.max(0, Math.floor(resetInSec)) };
    }
  }
  return null;
}

function parseDashboard(html: string): UsageData {
  const rolling = parseWindow(html, RE_ROLLING_PCT, RE_ROLLING_RST);
  const weekly = parseWindow(html, RE_WEEKLY_PCT, RE_WEEKLY_RST);
  const monthly = parseWindow(html, RE_MONTHLY_PCT, RE_MONTHLY_RST);
  const looksValid = html.includes("rollingUsage") || html.includes("weeklyUsage") || html.includes("monthlyUsage");
  if (!rolling && !weekly && !monthly && looksValid) {
    return {
      rolling: null,
      weekly: null,
      monthly: null,
      source: "scrape",
      error: "Dashboard layout changed — update opencode-subs",
      fetchedAt: Date.now(),
    };
  }
  return { rolling, weekly, monthly, source: "scrape", fetchedAt: Date.now() };
}

async function fetchUsageScrape(workspaceId: string, authCookie: string): Promise<UsageData> {
  const resp = await fetchWithTimeout(
    DASHBOARD_URL(workspaceId),
    {
      headers: {
        Cookie: `auth=${authCookie}`,
        "User-Agent": USER_AGENT,
      },
    },
    FETCH_TIMEOUT_MS,
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const finalUrl = resp.url;
  if (!finalUrl.includes(`/workspace/${workspaceId}/go`)) {
    throw new Error("session expired or invalid auth cookie");
  }
  const html = await resp.text();
  return parseDashboard(html);
}

async function fetchUsageForWorkspace(ws: Workspace): Promise<UsageData> {
  // 1. Try the future-first Bearer API endpoint.
  const api = await fetchUsageApi(ws.workspace_api_key);
  if (api) return api;

  // 2. Fall back to dashboard scrape if we have a cookie + workspace id.
  if (ws.workspace_id && ws.auth_cookie) {
    try {
      return await fetchUsageScrape(ws.workspace_id, ws.auth_cookie);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        rolling: null,
        weekly: null,
        monthly: null,
        error: msg,
        fetchedAt: Date.now(),
      };
    }
  }

  return {
    rolling: null,
    weekly: null,
    monthly: null,
    error: ws.workspace_id
      ? "Add auth_cookie or wait for OpenCode /zen/go/v1/usage API"
      : "Add workspace_id to fetch usage",
    fetchedAt: Date.now(),
  };
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0 && h > 0) return `${d}d ${h}h`;
  if (d > 0) return `${d}d`;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

function colorForPercent(value: number): "success" | "warning" | "error" {
  if (value >= 90) return "error";
  if (value >= 70) return "warning";
  return "success";
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatDetail(name: string, ws: Workspace, data: UsageData | null): string {
  if (!data) return `No usage data for ${name}.`;
  if (data.error) return `${name}: ${data.error}`;
  const elapsed = data.fetchedAt ? Math.floor((Date.now() - data.fetchedAt) / 1000) : 0;
  const render = (label: string, w: UsageWindow | null) => {
    if (!w) return `${label}: unavailable`;
    const pct = clampPercent(w.usagePercent);
    const reset = Math.max(0, w.resetInSec - elapsed);
    const dollars =
      w.usageDollars !== undefined && w.limitDollars !== undefined
        ? `  $${w.usageDollars.toFixed(2)} / $${w.limitDollars}`
        : "";
    return `${label}: ${pct}%  resets in ${formatDuration(reset)}${dollars}`;
  };
  return [
    `Workspace: ${name}`,
    `ID: ${ws.workspace_id || "(none)"}`,
    `Key: ${ws.workspace_api_key.slice(0, 8)}…`,
    render("Rolling 5h", data.rolling),
    render("Weekly", data.weekly),
    render("Monthly", data.monthly),
  ].join("\n");
}

// ─── Footer bars ────────────────────────────────────────────────────────────

interface Win {
  label: string;
  pct: number;
}

function fgToBgAnsi(fgAnsi: string): string {
  const m256 = fgAnsi.match(/\x1b\[38;5;(\d+)m/);
  if (m256) return `\x1b[48;5;${m256[1]}m`;
  const mTrue = fgAnsi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
  if (mTrue) return `\x1b[48;2;${mTrue[1]};${mTrue[2]};${mTrue[3]}m`;
  return fgAnsi.replace("[38", "[48");
}

function renderBarSegment(theme: any, pct: number, slots: number): string {
  const v = clampPercent(pct);
  const label = `${v}%`;
  const color = colorForPercent(v);
  const fg = theme.getFgAnsi(color);
  const bg = fgToBgAnsi(fg);
  // Use black text on colored background for contrast
  const labelColor = `\x1b[38;5;0m`;

  if (v === 0) {
    return theme.fg(color, label) + theme.fg("dim", "░".repeat(Math.max(0, slots - label.length)));
  }

  const filled = Math.max(label.length, Math.round((v / 100) * slots));
  const before = Math.max(0, Math.min(filled, Math.floor((filled - label.length) / 2)));
  const after = Math.max(0, filled - before - label.length);
  const empty = Math.max(0, slots - before - label.length - after);

  return (
    theme.fg(color, "█".repeat(before)) +
    bg +
    labelColor +
    theme.bold(label) +
    "\x1b[39m\x1b[49m" +
    theme.fg(color, "█".repeat(after)) +
    theme.fg("dim", "░".repeat(empty))
  );
}

function renderFooterBars(
  theme: any,
  activeName: string,
  data: UsageData | null,
  maxWidth: number,
): string {
  if (!data) return theme.fg("dim", `Go ${activeName} …`);
  if (data.error) return theme.fg("warning", `Go ${activeName} ${data.error}`);

  const wins: Win[] = [];
  if (data.rolling) wins.push({ label: "R", pct: data.rolling.usagePercent });
  if (data.weekly) wins.push({ label: "W", pct: data.weekly.usagePercent });
  if (data.monthly) wins.push({ label: "M", pct: data.monthly.usagePercent });
  if (wins.length === 0) return theme.fg("dim", `Go ${activeName}`);

  // Try a compact bar layout; fall back to plain percentages if too narrow.
  const BAR_SLOTS = 8;
  const make = (slots: number) =>
    `Go ${activeName} ` +
    wins.map((w) => `${w.label} ${renderBarSegment(theme, w.pct, slots)}`).join("  ");

  const full = make(BAR_SLOTS);
  if (visibleWidth(stripAnsi(full)) <= maxWidth) return full;

  const narrow = `Go ${activeName} ` + wins.map((w) => `${w.label}${clampPercent(w.pct)}%`).join(" · ");
  if (visibleWidth(stripAnsi(narrow)) <= maxWidth) return theme.fg("dim", narrow);

  return theme.fg("dim", `Go ${activeName}`);
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config = loadConfig();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let currentUsage: UsageData | null = null;
  let lastRotationTime = 0;
  let tuiRef: any = null;
  let footerActive = false;

  function isGoModel(model: { provider: string } | undefined | null): boolean {
    return model?.provider === PROVIDER;
  }

  async function refreshUsage(ctx: ExtensionContext) {
    const workspaces = getWorkspaces(config);
    const active = getActiveName(config);
    if (!active || !isGoModel(ctx.model)) {
      currentUsage = null;
      return;
    }
    currentUsage = await fetchUsageForWorkspace(workspaces[active]);
    tuiRef?.requestRender();
  }

  function startPolling(ctx: ExtensionContext) {
    if (pollTimer) clearInterval(pollTimer);
    if (!isGoModel(ctx.model)) return;
    void refreshUsage(ctx);
    pollTimer = setInterval(() => {
      if (!ctx.model || ctx.model.provider !== PROVIDER) {
        clearInterval(pollTimer!);
        pollTimer = null;
        return;
      }
      void refreshUsage(ctx);
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function setupFooter(ctx: ExtensionContext) {
    if (!ctx.ui) return;
    clearFooter(ctx);
    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      tuiRef = tui;
      footerActive = true;
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          // ── Line 1: cwd + branch + session name ──────────────────────────
          let pwd = ctx.sessionManager.getCwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) pwd = `${pwd} • ${sessionName}`;
          const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "…"));

          // ── Line 2: stats + bars + model ─────────────────────────────────
          let totalInput = 0,
            totalOutput = 0,
            totalCacheRead = 0,
            totalCacheWrite = 0,
            totalCost = 0;
          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              totalInput += entry.message.usage.input;
              totalOutput += entry.message.usage.output;
              totalCacheRead += entry.message.usage.cacheRead;
              totalCacheWrite += entry.message.usage.cacheWrite;
              totalCost += entry.message.usage.cost.total;
            }
          }

          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

          const statsParts: string[] = [];
          if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
          // Opencode Go is flat-rate; skip cost display.
          let contextPercentStr: string;
          const contextPercentDisplay = contextPercent === "?"
            ? `?/${formatTokens(contextWindow)}`
            : `${contextPercent}%/${formatTokens(contextWindow)}`;
          if (contextPercentValue > 90) contextPercentStr = theme.fg("error", contextPercentDisplay);
          else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", contextPercentDisplay);
          else contextPercentStr = contextPercentDisplay;
          statsParts.push(contextPercentStr);
          const statsLeft = statsParts.join(" ");

          // Model right
          const model = ctx.model;
          let rightSide = model?.id || "no-model";
          const thinkingLevel = pi.getThinkingLevel?.() ?? "off";
          if (model?.reasoning) {
            rightSide = thinkingLevel === "off" ? `${rightSide} • thinking off` : `${rightSide} • ${thinkingLevel}`;
          }
          if (footerData.getAvailableProviderCount() > 1 && model) {
            const withProvider = `(${model.provider}) ${rightSide}`;
            if (visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width) {
              rightSide = withProvider;
            }
          }

          // Stats line (left-aligned stats + right-aligned model)
          const statsVisible = visibleWidth(statsLeft);
          const modelVisible = visibleWidth(rightSide);
          const minGap = 2;
          const pad = " ".repeat(Math.max(minGap, width - statsVisible - modelVisible));
          const statsLine = statsLeft + pad + rightSide;
          const statsLineStyled = theme.fg("dim", statsLeft) + statsLine.slice(statsLeft.length);

          const lines = [pwdLine, statsLineStyled];

          // ── Bars line (dedicated row) ────────────────────────────────────
          const active = getActiveName(config);
          if (active) {
            const bars = renderFooterBars(theme, active, currentUsage, width);
            if (bars) lines.push(bars);
          }

          // ── Line 3: extension statuses ───────────────────────────────────
          const extensionStatuses = footerData.getExtensionStatuses();
          if (extensionStatuses.size > 0) {
            const sortedStatuses = Array.from(extensionStatuses.entries())
              .sort(([a]: any, [b]: any) => String(a).localeCompare(String(b)))
              .map(([, text]: any) => String(text).replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
            lines.push(truncateToWidth(sortedStatuses.join(" "), width, theme.fg("dim", "…")));
          }

          return lines;
        },
      };
    });
  }

  function clearFooter(ctx: ExtensionContext) {
    if (!footerActive) return;
    try {
      ctx.ui?.setFooter(undefined);
    } catch {
      // ignore
    }
    footerActive = false;
    tuiRef = null;
  }

  function maybeRotate(ctx: ExtensionContext): string | undefined {
    const workspaces = getWorkspaces(config);
    if (Object.keys(workspaces).length <= 1) return undefined;
    const now = Date.now();
    if (now - lastRotationTime < ROTATION_DEDUP_MS) return undefined;
    lastRotationTime = now;
    const next = rotateToNextWorkspace(config);
    if (!next) return undefined;
    applyActiveWorkspace(config, ctx.modelRegistry);
    void refreshUsage(ctx);
    return next;
  }

  pi.on("session_start", async (event, ctx) => {
    config = loadConfig();
    const active = applyActiveWorkspace(config, ctx.modelRegistry);
    if (active) {
      ctx.ui.notify?.(`OpenCode subs: active → ${active}`, "info");
      if (isGoModel(ctx.model)) {
        setupFooter(ctx);
        startPolling(ctx);
      }
    } else if (isGoModel(ctx.model)) {
      ctx.ui.notify?.("OpenCode subs: no workspaces configured. Use /go-subs add", "warning");
    }
  });

  pi.on("model_select", async (event, ctx) => {
    config = loadConfig();
    if (!isGoModel(event.model)) {
      stopPolling();
      currentUsage = null;
      clearFooter(ctx);
      return;
    }
    const active = applyActiveWorkspace(config, ctx.modelRegistry);
    if (active) {
      ctx.ui.notify?.(`OpenCode subs: active → ${active}`, "info");
      setupFooter(ctx);
      startPolling(ctx);
    }
  });

  pi.on("thinking_level_select", async (_event, _ctx) => {
    tuiRef?.requestRender();
  });

  // Auto-rotate on surfaced rate-limit errors.
  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.provider !== PROVIDER) return;
    if (message.stopReason !== "error") return;
    if (!QUOTA_ERROR_RE.test(message.errorMessage ?? "")) return;
    const next = maybeRotate(ctx);
    if (next) {
      ctx.ui.notify?.(`OpenCode subs: rate-limited → ${next}`, "info");
    } else {
      ctx.ui.notify?.("OpenCode subs: rate-limited — no other workspace", "warning");
    }
  });

  // Auto-rotate on HTTP 429 before the stream is consumed.
  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return;
    if (event.status !== 429) return;
    const next = maybeRotate(ctx);
    if (next) {
      ctx.ui.notify?.(`OpenCode subs: HTTP 429 → ${next}`, "info");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopPolling();
    currentUsage = null;
    clearFooter(ctx);
  });

  // ─── /go-subs command ────────────────────────────────────────────────────────

  pi.registerCommand("go-subs", {
    description: "Manage OpenCode Go subs: status | use <name> | next/rotate | add <name> <id> <key> [cookie] | rm <name> | setup",
    handler: async (args, ctx) => {
      config = loadConfig();
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] || "status";

      switch (sub) {
        case "status":
        case "list":
        case "ls": {
          const workspaces = getWorkspaces(config);
          const names = Object.keys(workspaces);
          const active = getActiveName(config);
          if (names.length === 0) {
            ctx.ui.notify?.("No subs configured. Use /go-subs add <name> <workspace_id> <api_key> [cookie]", "warning");
            return;
          }
          const lines = names.map((name) => {
            const marker = name === active ? "→" : " ";
            const ws = workspaces[name];
            return `${marker} ${name}: ${ws.workspace_id || "no-id"}  key ${ws.workspace_api_key.slice(0, 8)}…  cookie:${ws.auth_cookie ? "yes" : "no"}`;
          });
          let detail = "";
          if (active) {
            currentUsage = await fetchUsageForWorkspace(workspaces[active]);
            detail = `\n\n${formatDetail(active, workspaces[active], currentUsage)}`;
            tuiRef?.requestRender();
          }
          ctx.ui.notify?.(`${lines.join("\n")}${detail}`, "info");
          break;
        }

        case "use": {
          const name = parts[1];
          const workspaces = getWorkspaces(config);
          if (!name || !workspaces[name]) {
            ctx.ui.notify?.(`Unknown workspace. Available: ${Object.keys(workspaces).join(", ")}`, "warning");
            return;
          }
          setActiveName(config, name);
          applyActiveWorkspace(config, ctx.modelRegistry);
          await refreshUsage(ctx);
          ctx.ui.notify?.(`Switched to ${name}`, "info");
          break;
        }

        case "next":
        case "rotate": {
          const workspaces = getWorkspaces(config);
          if (Object.keys(workspaces).length === 0) {
            ctx.ui.notify?.("No subs configured. Use /go-subs add", "warning");
            return;
          }
          const next = rotateToNextWorkspace(config);
          if (!next) return;
          applyActiveWorkspace(config, ctx.modelRegistry);
          await refreshUsage(ctx);
          ctx.ui.notify?.(`Rotated to ${next}`, "info");
          break;
        }

        case "add": {
          const name = parts[1];
          const workspaceId = parts[2];
          const apiKey = parts[3];
          const authCookie = parts[4];
          if (!name || !workspaceId || !apiKey) {
            ctx.ui.notify?.("Usage: /go-subs add <name> <workspace_id> <api_key> [auth_cookie]", "warning");
            return;
          }
          if (name.startsWith("_")) {
            ctx.ui.notify?.("Workspace names cannot start with _", "warning");
            return;
          }
          const workspaces = getWorkspaces(config);
          workspaces[name] = {
            workspace_id: workspaceId,
            workspace_api_key: apiKey,
            ...(authCookie ? { auth_cookie: authCookie } : {}),
          };
          config = { _active: config._active, ...workspaces };
          if (!config._active) config._active = name;
          saveConfig(config);
          applyActiveWorkspace(config, ctx.modelRegistry);
          await refreshUsage(ctx);
          const _msg = `Added ${name} (${Object.keys(workspaces).length} workspace${Object.keys(workspaces).length === 1 ? "" : "s"})`;
          ctx.ui.notify?.(_msg, "info");
          break;
        }

        case "rm":
        case "remove": {
          const name = parts[1];
          const workspaces = getWorkspaces(config);
          if (!name || !workspaces[name]) {
            const _msg = `Unknown workspace. Available: ${Object.keys(workspaces).join(", ")}`;
          ctx.ui.notify?.(_msg, "warning");
            return;
          }
          delete workspaces[name];
          config = { _active: config._active, ...workspaces };
          const names = Object.keys(workspaces);
          if (config._active === name) {
            config._active = names[0];
          }
          if (names.length === 0) {
            delete config._active;
            ctx.modelRegistry.authStorage.removeRuntimeApiKey(PROVIDER);
          } else {
            applyActiveWorkspace(config, ctx.modelRegistry);
          }
          saveConfig(config);
          await refreshUsage(ctx);
          const _msg = `Removed ${name} (${names.length} left)`;
          ctx.ui.notify?.(_msg, "info");
          break;
        }

        case "setup": {
          const dir = join(homedir(), ".pi", "agent");
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          if (!existsSync(CONFIG_PATH)) {
            writeFileSync(CONFIG_PATH, "{}\n", { mode: 0o600 });
          }
          ctx.ui.notify?.(`OpenCode subs config created/verified at:\n${CONFIG_PATH}\n\nEdit it to add workspaces, then run /go-subs status.`, "info");
          break;
        }

        default: {
          ctx.ui.notify?.(
            "Usage: /go-subs [status|use <name>|next|rotate|add <name> <workspace_id> <api_key> [cookie]|rm <name>|setup]",
            "info",
          );
        }
      }
    },
  });
}
