/**
 * opencode-mcp-watchdog — OpenCode v2 entrypoint.
 *
 * Dual v1/v2 plugin (see-image pattern): index.ts default-exports one object
 * carrying both `server` (v1 factory) and `setup` (this v2 function). Each
 * runtime validates only the member it understands.
 *
 * v2 sandbox notes (as of `@opencode/plugin` 2.0.20):
 * - `ctx.mcp` exposes `list()` but NOT per-server `connect()` — a config
 *   `reload()` (respawns managed servers) is the heal path.
 * - No toast API for server plugins — summaries go to the server log via
 *   `console` (best effort, never throws).
 * - `ctx.event.subscribe()` yields the live event stream; subscribe in the
 *   background so `setup` resolves promptly.
 */

type StatusMap = Record<string, { status?: string; error?: string }>

const STARTUP_DELAY_MS = 8000
const DEDUP_WINDOW_MS = 15000

const KNOWN_STATES = new Set(["connected", "failed", "needs_auth", "needs_client_registration", "disabled"])

let lastRun = 0

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function log(level: "info" | "warn" | "error", message: string): void {
  try {
    // biome-ignore lint/suspicious/noConsole: only feedback channel v2 server plugins have
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info
    fn(`[mcp-watchdog] ${message}`)
  } catch {
    // Logging must never break the plugin.
  }
}

function shorten(err: unknown, max = 80): string {
  const s = String(err).replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Fetch the MCP server map. Tolerates SDK-style {data,error} wrappers. */
async function getStatuses(mcp: any): Promise<StatusMap> {
  const out = await mcp.list()
  const data = out && typeof out === "object" && "data" in out && !("status" in out) ? out.data : out
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("mcp.list returned an unexpected shape")
  return data as StatusMap
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

function statusError(s: { status?: string; error?: string } | undefined): string {
  if (s?.status === "failed" || s?.status === "needs_client_registration") return s.error ?? ""
  return ""
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

function summarizeText(sum: Summary): string {
  const bits = [`${sum.ok}/${sum.total} connected`]
  if (sum.stale) bits.push("status refresh failed, showing last-known")
  if (sum.recovered.length) bits.push(`reconnected: ${sum.recovered.join(", ")}`)
  if (sum.failed.length)
    bits.push(
      `failed: ${sum.failed.map((n) => (sum.errors[n] ? `${n} (${shorten(sum.errors[n])})` : n)).join(", ")}`,
    )
  if (sum.other.length)
    bits.push(`other: ${sum.other.map((n) => `${n} (unknown state)`).join(", ")}`)
  if (sum.needsAuth.length) bits.push(`needs auth: ${sum.needsAuth.join(", ")}`)
  if (sum.disabled.length) bits.push(`disabled: ${sum.disabled.join(", ")}`)
  return bits.join(" · ")
}

export async function setupV2(ctx: any): Promise<(() => void) | void> {
  const mcp = ctx?.mcp
  if (!mcp || typeof mcp.list !== "function") return

  let active = true
  let inFlight: Promise<Summary | null> | null = null

  async function runCheck(reason: string, { quiet = false } = {}): Promise<Summary> {
    const before = await getStatuses(mcp)
    const failedNames = Object.entries(before)
      .filter(([, s]) => s?.status === "failed")
      .map(([name]) => name)
    const healed: string[] = []
    if (failedNames.length) {
      // v2 exposes no per-server connect(); a config reload respawns managed servers.
      if (typeof mcp.reload === "function") await mcp.reload()
      healed.push(...failedNames)
    }
    let stale = false
    let after = before
    try {
      after = await getStatuses(mcp)
    } catch {
      stale = true
    }
    const base = summarize(healed, after)
    const sum: Summary = {
      ...base,
      stale,
      errors: Object.fromEntries(base.failed.map((n) => [n, statusError(after[n]) || ""])),
    }
    if (!quiet || sum.recovered.length || sum.failed.length) {
      log(sum.failed.length ? "warn" : "info", `MCP watchdog (${reason}): ${summarizeText(sum)}`)
    }
    return sum
  }

  async function checkAndHeal(
    reason: string,
    opts?: { quiet?: boolean },
    { force = false } = {},
  ): Promise<Summary | null> {
    if (inFlight) return inFlight
    if (!force && Date.now() - lastRun < DEDUP_WINDOW_MS) return null
    inFlight = runCheck(reason, opts).finally(() => {
      lastRun = Date.now()
      inFlight = null
    })
    return inFlight
  }

  if (ctx?.tool?.transform) {
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "mcp_watchdog",
        description: "Show MCP server statuses, reload failed servers",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["status", "reconnect"],
              description: "status lists servers, reconnect reloads failed ones",
            },
          },
          additionalProperties: false,
        },
        execute: async (args: any) => {
          if (args?.action === "reconnect") {
            const r = await checkAndHeal("manual", undefined, { force: true }).catch(
              (e: unknown) => ({ probeError: e }) as const,
            )
            if (!r) return { content: "Check already running — retry in a few seconds." }
            if ("probeError" in r)
              return {
                content: `Status probe failed (${shorten(errMessage(r.probeError))}). Servers may still be starting — retry in a few seconds.`,
              }
            const failing = r.failed
              .map((n) => (r.errors[n] ? `  ✗ ${n} — ${shorten(r.errors[n], 200)}` : `  ✗ ${n}`))
              .join("\n")
            return {
              content:
                `Reloaded: ${r.recovered.join(", ") || "none"}\n` +
                `Still failing: ${r.failed.length ? `\n${failing}` : "none"}\n` +
                `Needs auth: ${r.needsAuth.join(", ") || "none"}`,
            }
          }
          try {
            return { content: formatStatus(await getStatuses(mcp)) }
          } catch (e) {
            return {
              content: `Status probe failed (${shorten(errMessage(e))}). Servers may still be starting — retry in a few seconds.`,
            }
          }
        },
      })
    })
  }

  if (ctx?.event?.subscribe) {
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe()) {
          if (!active) break
          const type = (event as any)?.type
          if (type === "server.connected") {
            await checkAndHeal("server.connected").catch(() => {})
          } else if (type === "session.error") {
            await checkAndHeal("session.error", { quiet: true }).catch(() => {})
          }
        }
      } catch {
        // Stream ended; fail open.
      }
    })()
  }

  const timer = setTimeout(() => {
    if (active) checkAndHeal("startup", { quiet: true }).catch((e) => log("error", `startup check failed: ${errMessage(e)}`))
  }, STARTUP_DELAY_MS)

  return () => {
    active = false
    clearTimeout(timer)
  }
}
