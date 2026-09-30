/**
 * opencode-mcp-watchdog — keep MCP servers healthy without sidecars.
 *
 * Opencode core owns MCP processes. This plugin only status-checks via the
 * core API, reconnects failures, and toasts a summary.
 */
import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin"
import type { McpStatus } from "@opencode-ai/sdk"
import { setupV2 } from "./v2.js"

type Client = PluginInput["client"]
type StatusMap = Record<string, McpStatus>

const STARTUP_DELAY_MS = 8000
const DEDUP_WINDOW_MS = 15000
const TOAST_DURATION_MS = 5000

const KNOWN_STATES = new Set(["connected", "failed", "needs_auth", "needs_client_registration", "disabled"])

let lastRun = 0

/** Extract a one-line message from an unknown caught value. */
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Fetch the current MCP server map from opencode core.
 * @throws {Error} when the probe errors or returns an unexpected shape.
 */
async function getStatuses(client: Client): Promise<StatusMap> {
  const { data, error } = await client.mcp.status()
  if (error) throw new Error(`mcp.status failed: ${JSON.stringify(error)}`)
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("mcp.status returned an unexpected shape")
  return data
}

async function showToast(
  client: Client,
  body: {
    title?: string
    message: string
    variant: "info" | "success" | "warning" | "error"
    duration?: number
  },
): Promise<void> {
  try {
    await client.tui.showToast({ body })
  } catch {
    // No TUI attached (serve/web/headless) — log the summary instead.
    log(client, "info", `${body.title}: ${body.message}`)
  }
}

function shorten(err: unknown, max = 80): string {
  const s = String(err).replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

type LogLevel = "debug" | "info" | "error" | "warn"

function log(client: Client, level: LogLevel, message: string): void {
  try {
    Promise.resolve(client.app.log({ body: { service: "mcp-watchdog", level, message } })).catch(() => {})
  } catch {
    // Logging must never break the plugin.
  }
}

function logError(client: Client, message: string): void {
  log(client, "error", message)
}

interface Summary {
  total: number
  ok: number
  failed: string[]
  needsAuth: string[]
  disabled: string[]
  other: string[]
  recovered: string[]
  stale: boolean
  errors: Record<string, string>
}

/**
 * Bucket server names by state. Unknown states land in `other` so new core
 * statuses are visible instead of silently dropped.
 */
function summarize(healed: string[], after: StatusMap): Omit<Summary, "stale" | "errors"> {
  const names = Object.keys(after)
  const ok = names.filter((n) => after[n]?.status === "connected").length
  const failed = names.filter((n) => after[n]?.status === "failed")
  const needsAuth = names.filter(
    (n) => after[n]?.status === "needs_auth" || after[n]?.status === "needs_client_registration",
  )
  const disabled = names.filter((n) => after[n]?.status === "disabled")
  const other = names.filter((n) => !KNOWN_STATES.has(after[n]?.status ?? ""))
  const recovered = healed.filter((n) => after[n]?.status === "connected")
  return { total: names.length, ok, failed, needsAuth, disabled, other, recovered }
}

/** Error text carried by a failed/unregistered server status, if any. */
function statusError(s: McpStatus | undefined): string {
  if (s?.status === "failed" || s?.status === "needs_client_registration") return s.error
  return ""
}

/**
 * One check+heal pass: reconnect every `failed` server sequentially, then
 * re-read statuses.
 * @throws {Error} when the initial status probe fails (callers surface it).
 * A failed *refresh* probe instead degrades to stale last-known data.
 */
async function runCheck(client: Client, reason: string, { quiet = false } = {}): Promise<Summary> {
  const before = await getStatuses(client)
  const failedNames = Object.entries(before)
    .filter(([, s]) => s?.status === "failed")
    .map(([name]) => name)
  const healed: string[] = []
  const connectErrors: Record<string, string> = {}
  // Sequential reconnects: parallel npx spawns thundering-herd the registry
  // and trip probe timeouts; one at a time lands reliably.
  for (const name of failedNames) {
    try {
      await client.mcp.connect({ path: { name } })
      healed.push(name)
    } catch (e) {
      connectErrors[name] = errMessage(e)
    }
  }
  let stale = false
  let after = before
  try {
    after = await getStatuses(client)
  } catch {
    // Status probe itself timed out — report last-known, never as fresh.
    stale = true
  }
  const base = summarize(healed, after)
  const sum: Summary = {
    ...base,
    stale,
    errors: Object.fromEntries(base.failed.map((n) => [n, statusError(after[n]) || connectErrors[n] || ""])),
  }

  const bits = [`${sum.ok}/${sum.total} connected`]
  if (stale) bits.push("status refresh failed, showing last-known")
  if (sum.recovered.length) bits.push(`reconnected: ${sum.recovered.join(", ")}`)
  if (sum.failed.length)
    bits.push(
      `failed: ${sum.failed.map((n) => (sum.errors[n] ? `${n} (${shorten(sum.errors[n])})` : n)).join(", ")}`,
    )
  if (sum.other.length)
    bits.push(`other: ${sum.other.map((n) => `${n} (${after[n]?.status ?? "unknown"})`).join(", ")}`)
  if (sum.needsAuth.length) bits.push(`needs auth: ${sum.needsAuth.join(", ")}`)
  if (sum.disabled.length) bits.push(`disabled: ${sum.disabled.join(", ")}`)
  const variant = sum.failed.length ? "error" : sum.needsAuth.length ? "warning" : "success"

  if (!quiet || sum.recovered.length || sum.failed.length) {
    await showToast(client, {
      title: `MCP watchdog (${reason})`,
      message: bits.join(" · "),
      variant,
      duration: TOAST_DURATION_MS,
    })
  }
  return sum
}

let inFlight: Promise<Summary | null> | null = null

// Dedup + join in-flight runs; the cooldown starts when a run completes.
// force bypasses the cooldown — an explicit user reconnect always runs.
async function checkAndHeal(
  client: Client,
  reason: string,
  opts?: { quiet?: boolean },
  { force = false } = {},
): Promise<Summary | null> {
  if (inFlight) return inFlight
  if (!force && Date.now() - lastRun < DEDUP_WINDOW_MS) return null
  inFlight = runCheck(client, reason, opts).finally(() => {
    lastRun = Date.now()
    inFlight = null
  })
  return inFlight
}

function formatStatus(statuses: StatusMap): string {
  const entries = Object.entries(statuses)
  if (!entries.length) return "No MCP servers configured."
  return entries
    .map(([name, s]) => {
      const icon =
        s.status === "connected" ? "✓" : s.status === "disabled" ? "○" : s.status === "failed" ? "✗" : "⚠"
      const extra =
        s.status === "failed" || s.status === "needs_client_registration" ? ` — ${shorten(s.error)}` : ""
      return `  ${icon} ${name} - ${s.status}${extra}`
    })
    .join("\n")
}

export const McpWatchdogPlugin: Plugin = async ({ client }) => {
  // Opencode itself triggers this on every startup. Quiet when all green —
  // quiet still toasts if anything recovered or failed.
  setTimeout(() => {
    checkAndHeal(client, "startup", { quiet: true }).catch((e) =>
      logError(client, `startup check failed: ${errMessage(e)}`),
    )
  }, STARTUP_DELAY_MS)

  return {
    event: async ({ event }) => {
      if (event.type === "server.connected") {
        await checkAndHeal(client, "server.connected").catch((e) =>
          logError(client, `check failed: ${errMessage(e)}`),
        )
      }
      if (event.type === "session.error") {
        await checkAndHeal(client, "session.error", { quiet: true }).catch(() => {})
      }
    },
    tool: {
      mcp_watchdog: tool({
        description: "Show MCP server statuses, reconnect failed servers",
        args: {
          action: tool.schema
            .enum(["status", "reconnect"])
            .describe("status lists servers, reconnect reconnects failed ones"),
        },
        async execute(args) {
          if (args.action === "status") {
            try {
              return formatStatus(await getStatuses(client))
            } catch (e) {
              return `Status probe failed (${shorten(errMessage(e))}). Servers may still be starting — retry in a few seconds.`
            }
          }
          const r = await checkAndHeal(client, "manual", undefined, { force: true }).catch(
            (e: unknown) => ({ probeError: e }) as const,
          )
          if (!r) return "Check already running — see toast for status."
          if ("probeError" in r)
            return `Status probe failed (${shorten(errMessage(r.probeError))}). Servers may still be starting — retry in a few seconds.`
          const failing = r.failed
            .map((n) => (r.errors[n] ? `  ✗ ${n} — ${shorten(r.errors[n], 200)}` : `  ✗ ${n}`))
            .join("\n")
          return (
            `Reconnected: ${r.recovered.join(", ") || "none"}\n` +
            `Still failing: ${r.failed.length ? `\n${failing}` : "none"}\n` +
            `Needs auth: ${r.needsAuth.join(", ") || "none"}`
          )
        },
      }),
    },
  }
}

/** Original export name, kept for backwards compatibility. */
export const McpWatchdog = McpWatchdogPlugin

/**
 * Dual v1/v2 entrypoint (see-image pattern). v1 runtimes detect `{id, server}`
 * and call the factory; v2 runtimes decode `{id, setup}` and ignore the extra
 * `server` key. Named exports above stay for existing v1 importers.
 */
const McpWatchdogDualPlugin = {
  id: "opencode-mcp-watchdog",
  server: McpWatchdogPlugin,
  setup: setupV2,
}

export default McpWatchdogDualPlugin
