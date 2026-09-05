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

async function checkAndHeal(client, reason, { quiet = false } = {}) {
  if (Date.now() - lastRun < DEDUP_WINDOW_MS) return null
  lastRun = Date.now()

  const before = await getStatuses(client)
  const healed = []
  for (const [name, s] of Object.entries(before)) {
    if (s?.status !== "failed") continue
    try {
      const { data } = await client.mcp.connect({ path: { name } })
      if (data) healed.push(name)
    } catch {
      // Still down — reported below.
    }
  }
  const after = await getStatuses(client).catch(() => before)
  const sum = summarize(healed, after)

  const bits = [`${sum.ok}/${sum.total} connected`]
  if (sum.recovered.length) bits.push(`reconnected: ${sum.recovered.join(", ")}`)
  if (sum.failed.length) bits.push(`failed: ${sum.failed.join(", ")}`)
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

function formatStatus(statuses) {
  return Object.entries(statuses)
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
    checkAndHeal(client, "startup").catch((e) => console.log(`[mcp-watchdog] startup check failed: ${e.message}`))
  }, STARTUP_DELAY_MS)

  return {
    event: async ({ event }) => {
      if (event.type === "server.connected") {
        await checkAndHeal(client, "server.connected").catch((e) =>
          console.log(`[mcp-watchdog] check failed: ${e.message}`),
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
          return (
            `Reconnected: ${r.recovered.join(", ") || "none"}\n` +
            `Still failing: ${r.failed.join(", ") || "none"}\n` +
            `Needs auth: ${r.needsAuth.join(", ") || "none"}`
          )
        },
      }),
    },
  }
}
