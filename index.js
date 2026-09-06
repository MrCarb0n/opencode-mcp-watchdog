import { tool } from "@opencode-ai/plugin"

// Opencode core owns MCP processes. This plugin only status-checks via the
// core API, reconnects failures, and toasts a summary. No sidecars.

const STARTUP_DELAY_MS = 8000
const DEDUP_WINDOW_MS = 15000
const TOAST_DURATION_MS = 5000

let lastRun = 0

async function getStatuses(client) {
  const { data, error } = await client.mcp.status()
  if (error) throw new Error(`mcp.status failed: ${JSON.stringify(error)}`)
  return data ?? {}
}

async function showToast(client, body) {
  try {
    await client.tui.showToast({ body })
  } catch {
    // No TUI attached (serve/web/headless) — status tool still works.
  }
}

function shorten(err, max = 80) {
  const s = String(err).replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function logError(client, message) {
  try {
    Promise.resolve(
      client.app.log({ body: { service: "mcp-watchdog", level: "error", message } }),
    ).catch(() => {})
  } catch {
    // Logging must never break the plugin.
  }
}

function summarize(healed, after) {
  const names = Object.keys(after)
  const ok = names.filter((n) => after[n]?.status === "connected").length
  const failed = names.filter((n) => after[n]?.status === "failed")
  const needsAuth = names.filter(
    (n) => after[n]?.status === "needs_auth" || after[n]?.status === "needs_client_registration",
  )
  const disabled = names.filter((n) => after[n]?.status === "disabled")
  const recovered = healed.filter((n) => after[n]?.status === "connected")
  return { total: names.length, ok, failed, needsAuth, disabled, recovered }
}

async function runCheck(client, reason, { quiet = false } = {}) {
  const before = await getStatuses(client)
  const failedNames = Object.entries(before)
    .filter(([, s]) => s?.status === "failed")
    .map(([name]) => name)
  const settled = await Promise.allSettled(failedNames.map((name) => client.mcp.connect({ path: { name } })))
  const healed = []
  const connectErrors = {}
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") healed.push(failedNames[i])
    else connectErrors[failedNames[i]] = r.reason?.message ?? String(r.reason)
  })
  const after = await getStatuses(client).catch(() => before)
  const sum = summarize(healed, after)
  sum.errors = Object.fromEntries(sum.failed.map((n) => [n, after[n]?.error ?? connectErrors[n] ?? ""]))

  const bits = [`${sum.ok}/${sum.total} connected`]
  if (sum.recovered.length) bits.push(`reconnected: ${sum.recovered.join(", ")}`)
  if (sum.failed.length)
    bits.push(
      `failed: ${sum.failed.map((n) => (sum.errors[n] ? `${n} (${shorten(sum.errors[n])})` : n)).join(", ")}`,
    )
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

let inFlight = null

// Dedup + join in-flight runs; the cooldown starts when a run completes.
async function checkAndHeal(client, reason, opts) {
  if (inFlight) return inFlight
  if (Date.now() - lastRun < DEDUP_WINDOW_MS) return null
  inFlight = runCheck(client, reason, opts).finally(() => {
    lastRun = Date.now()
    inFlight = null
  })
  return inFlight
}

function formatStatus(statuses) {
  const entries = Object.entries(statuses)
  if (!entries.length) return "No MCP servers configured."
  return entries
    .map(([name, s]) => {
      const icon =
        s.status === "connected" ? "✓" : s.status === "disabled" ? "○" : s.status === "failed" ? "✗" : "⚠"
      const extra = s.error ? ` — ${s.error}` : ""
      return `  ${icon} ${name} - ${s.status}${extra}`
    })
    .join("\n")
}

export const McpWatchdog = async ({ client }) => {
  // Opencode itself triggers this on every startup.
  setTimeout(() => {
    checkAndHeal(client, "startup").catch((e) => logError(client, `startup check failed: ${e.message}`))
  }, STARTUP_DELAY_MS)

  return {
    event: async ({ event }) => {
      if (event.type === "server.connected") {
        await checkAndHeal(client, "server.connected").catch((e) =>
          logError(client, `check failed: ${e.message}`),
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
          if (args.action === "status") return formatStatus(await getStatuses(client))
          const r = await checkAndHeal(client, "manual")
          if (!r) return "Check ran recently — see toast for status."
          const failing = r.failed.map((n) => (r.errors[n] ? `  ✗ ${n} — ${r.errors[n]}` : `  ✗ ${n}`)).join("\n")
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
