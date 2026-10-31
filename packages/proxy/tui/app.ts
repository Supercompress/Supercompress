/**
 * SuperCompress OpenTUI app — live usage + real CLI commands.
 */
import {
  Box,
  Input,
  InputRenderableEvents,
  ScrollBox,
  Select,
  SelectRenderableEvents,
  Text,
  createCliRenderer,
  type InputRenderable,
  type KeyEvent,
  type ScrollBoxRenderable,
  type SelectOption,
  type SelectRenderable,
  type TextRenderable,
} from "@opentui/core"
import {
  BG,
  BRAND,
  BRAND_INK,
  BRAND_SOFT,
  ERR,
  INK,
  MUTED,
  OK,
  PANEL,
  RULE,
  WARN,
  fmt,
  meterBar,
} from "./theme.ts"
import {
  BILLING_URL,
  VERSION,
  beginConnect,
  detectAgents,
  emptyUsage,
  fetchAccount,
  fetchUsage,
  formatAccountLog,
  formatAgentsLog,
  formatPluginLog,
  formatUsageLog,
  installPlugin,
  loadConfig,
  mcpCheck,
  pollConnect,
  proxyStatus,
  saveApiKey,
  startProxy,
  stopProxy,
  usageNotice,
  type UsageSnap,
} from "./sc.ts"

const COMMANDS: SelectOption[] = [
  { name: "usage", description: "Plan, quota, savings by agent" },
  { name: "billing", description: "Upgrade / add credits · billing link" },
  { name: "account", description: "Whoami · linked key · recent activity" },
  { name: "connect", description: "Link this machine in the browser" },
  { name: "setup", description: "Connect + install MCP + hooks" },
  { name: "plugin", description: "Refresh MCP / hooks / instructions" },
  { name: "agents", description: "Detected coding agents" },
  { name: "status", description: "Local proxy health" },
  { name: "start", description: "Start optional local proxy" },
  { name: "stop", description: "Stop local proxy" },
  { name: "mcp-check", description: "Verify MCP server tools" },
  { name: "quit", description: "Leave" },
]

const MENU_KEYS = [
  { name: "up", action: "move-up" as const },
  { name: "k", action: "move-up" as const },
  { name: "down", action: "move-down" as const },
  { name: "j", action: "move-down" as const },
  { name: "up", shift: true, action: "move-up-fast" as const },
  { name: "down", shift: true, action: "move-down-fast" as const },
  { name: "enter", action: "select-current" as const },
  { name: "return", action: "select-current" as const },
  { name: "linefeed", action: "select-current" as const },
]

const AGENT_SLOTS = 6

type Mode = "menu" | "input"

function isConfirmKey(key: KeyEvent) {
  if (key.ctrl || key.meta) return false
  const name = String(key.name || "").toLowerCase()
  if (name === "return" || name === "enter" || name === "linefeed") return true
  const seq = key.sequence || key.raw || ""
  return seq === "\r" || seq === "\n" || seq === "\r\n"
}

function hintLine(mode: Mode, connecting: boolean, busy: boolean) {
  if (busy) return "working…                                          esc cancel     ctrl+c quit"
  if (connecting || mode === "input") {
    return "paste sc_… + enter   ·   wait for browser   ·   esc cancel   ctrl+c quit"
  }
  return "↑↓ / j k   enter run   r refresh   c connect   q quit"
}

export function buildTree() {
  const agentLines = Array.from({ length: AGENT_SLOTS }, (_, i) =>
        Text({
          id: `agent-${i}`,
          content: " ",
          fg: MUTED,
          wrapMode: "none",
        }),
  )

  return Box(
    {
      flexDirection: "column",
      padding: 1,
      gap: 0,
      width: "100%",
      height: "100%",
      backgroundColor: BG,
    },
    Box(
      {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        flexShrink: 0,
        marginBottom: 0,
      },
      Box(
        { flexDirection: "row", gap: 1, alignItems: "center", flexShrink: 0 },
        Box(
          { backgroundColor: BRAND, paddingLeft: 1, paddingRight: 1, border: false },
          Text({ content: "◆", fg: "#ffffff", wrapMode: "none" }),
        ),
        Text({ id: "hdr-title", content: "SuperCompress", fg: BRAND_INK, wrapMode: "none" }),
        Text({ id: "hdr-ver", content: `v${VERSION}`, fg: MUTED, wrapMode: "none" }),
      ),
      Text({ id: "hdr-email", content: "not linked", fg: MUTED, wrapMode: "none" }),
    ),
    Text({
      id: "hdr-tag",
      content: "cut agent context · keep the answer",
      fg: MUTED,
      wrapMode: "none",
      marginBottom: 1,
    }),
    Box(
      {
        flexDirection: "row",
        gap: 1,
        width: "100%",
        flexGrow: 0,
        flexShrink: 0,
        marginBottom: 1,
      },
      Box(
        {
          borderStyle: "rounded",
          borderColor: BRAND,
          backgroundColor: PANEL,
          padding: 1,
          flexDirection: "column",
          gap: 0,
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 38,
        },
        Text({ id: "u-label", content: "USAGE  ·  THIS MONTH", fg: BRAND, wrapMode: "none" }),
        Text({ id: "u-stats", content: "— in     — saved", fg: INK, wrapMode: "none" }),
        Text({ id: "u-meter", content: `${meterBar(0)}   —`, fg: MUTED, wrapMode: "none" }),
        Text({ id: "u-plan", content: "plan  —", fg: MUTED, wrapMode: "none" }),
        Text({ id: "u-notice", content: "", fg: WARN, wrapMode: "word", visible: false }),
        Text({ id: "u-billing", content: `Upgrade / add credits: ${BILLING_URL}`, fg: BRAND, wrapMode: "word", selectable: true, visible: false }),
        Text({ content: "─".repeat(36), fg: RULE, wrapMode: "none" }),
        Text({ content: "AGENTS", fg: BRAND, wrapMode: "none" }),
        ...agentLines,
      ),
      Box(
        { flexDirection: "column", gap: 0, width: 36, flexShrink: 0 },
        Text({ content: "COMMANDS", fg: BRAND, wrapMode: "none" }),
        Select({
          id: "cli-menu",
          width: 36,
          height: 12,
          options: COMMANDS,
          backgroundColor: PANEL,
          selectedBackgroundColor: BRAND_SOFT,
          selectedTextColor: INK,
          descriptionColor: MUTED,
          showDescription: true,
          wrapSelection: true,
          border: true,
          borderStyle: "rounded",
          borderColor: RULE,
          keyBindings: MENU_KEYS,
          keyAliasMap: { enter: "return", return: "enter" },
        }),
      ),
    ),
    Text({ id: "log-label", content: "OUTPUT", fg: BRAND, wrapMode: "none" }),
    ScrollBox(
      {
        id: "log-box",
        borderStyle: "rounded",
        borderColor: RULE,
        backgroundColor: PANEL,
        flexGrow: 1,
        minHeight: 6,
        stickyScroll: true,
        stickyStart: "bottom",
        scrollX: false,
        scrollY: true,
        padding: 1,
      },
      Text({
        id: "log-text",
        content: "loading live usage…",
        fg: INK,
        wrapMode: "word",
        selectable: true,
      }),
    ),
    Input({
      id: "key-input",
      width: "100%",
      height: 0,
      placeholder: "paste sc_… API key here, or wait for browser link",
      backgroundColor: PANEL,
      focusedBackgroundColor: BRAND_SOFT,
      textColor: INK,
      cursorColor: BRAND,
      placeholderColor: MUTED,
      maxLength: 200,
    }),
    Text({
      id: "hint",
      content: hintLine("menu", false, false),
      fg: MUTED,
      wrapMode: "none",
      height: 1,
      flexShrink: 0,
      marginTop: 1,
    }),
  )
}

export async function runApp() {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    backgroundColor: BG,
    useMouse: true,
    autoFocus: false,
  })

  renderer.root.add(buildTree())

  const menu = renderer.root.findDescendantById("cli-menu") as SelectRenderable
  const detail = renderer.root.findDescendantById("log-text") as TextRenderable
  const logBox = renderer.root.findDescendantById("log-box") as ScrollBoxRenderable
  const input = renderer.root.findDescendantById("key-input") as InputRenderable
  const hint = renderer.root.findDescendantById("hint") as TextRenderable
  const hdrEmail = renderer.root.findDescendantById("hdr-email") as TextRenderable
  const uLabel = renderer.root.findDescendantById("u-label") as TextRenderable
  const uStats = renderer.root.findDescendantById("u-stats") as TextRenderable
  const uMeter = renderer.root.findDescendantById("u-meter") as TextRenderable
  const uPlan = renderer.root.findDescendantById("u-plan") as TextRenderable
  const uNotice = renderer.root.findDescendantById("u-notice") as TextRenderable
  const uBilling = renderer.root.findDescendantById("u-billing") as TextRenderable
  const agentNodes = Array.from({ length: AGENT_SLOTS }, (_, i) =>
    renderer.root.findDescendantById(`agent-${i}`),
  ) as TextRenderable[]

  if (!menu || !detail || !input || !hint) throw new Error("failed to mount TUI")

  let usage = emptyUsage()
  let mode: Mode = "menu"
  let busy = false
  let connecting = false
  let connectCode: string | null = null
  let connectTimer: ReturnType<typeof setInterval> | null = null
  let lastConfirm = 0
  const logLines: string[] = []

  function setHint() {
    hint.content = hintLine(mode, connecting, busy)
    hint.fg = busy ? WARN : MUTED
  }

  function setLog(text: string, color: string = INK) {
    logLines.length = 0
    logLines.push(...String(text).split("\n"))
    detail.content = logLines.join("\n")
    detail.fg = color
    try {
      logBox.scrollTop = logBox.scrollHeight
    } catch {}
    renderer.requestRender()
  }

  function appendLog(line: string) {
    logLines.push(line)
    if (logLines.length > 400) logLines.splice(0, logLines.length - 400)
    detail.content = logLines.join("\n")
    try {
      logBox.scrollTop = logBox.scrollHeight
    } catch {}
    renderer.requestRender()
  }

  function paintUsage(u: UsageSnap) {
    usage = u
    const notice = usageNotice(u)
    uNotice.visible = Boolean(notice)
    uBilling.visible = Boolean(notice)
    uNotice.content = notice?.message || ""
    uNotice.fg = notice?.paused ? ERR : WARN
    uBilling.content = notice?.action || ""
    hdrEmail.content = u.email
    hdrEmail.fg = u.linked && !u.error ? OK : MUTED
    uLabel.content = notice?.paused ? "COMPRESSION PAUSED" : u.unlimited ? "USAGE  ·  UNLIMITED" : "USAGE  ·  THIS MONTH"
    uLabel.fg = notice?.paused ? ERR : BRAND
    uStats.content = `${fmt(u.tokensIn)} in     ${fmt(u.tokensSaved)} saved     −${u.cutPct}%`
    uStats.fg = INK
    if (u.unlimited) {
      uMeter.content = `${meterBar(8)}   unlimited`
      uMeter.fg = OK
    } else {
      uMeter.content = `${meterBar(u.quotaPct)}   ${u.quotaPct}% used`
      uMeter.fg = u.quotaPct >= 90 ? ERR : u.quotaPct >= 80 ? WARN : OK
    }
    uPlan.content = u.error ? `⚠  ${u.error}` : `plan  ${u.plan}     ${u.requests} req`
    uPlan.fg = u.error ? WARN : MUTED
    for (let i = 0; i < AGENT_SLOTS; i++) {
      const a = u.agents[i]
      if (!a) {
        agentNodes[i].content = i === 0 ? "  no agent activity yet" : " "
        agentNodes[i].fg = MUTED
      } else {
        agentNodes[i].content = `  ${a.name.padEnd(14)} ${fmt(a.saved).padStart(6)} saved  ${String(Math.round(a.cut)).padStart(3)}%`
        agentNodes[i].fg = INK
      }
    }
    renderer.requestRender()
  }

  function showInput(on: boolean) {
    mode = on ? "input" : "menu"
    input.visible = on
    input.height = on ? 1 : 0
    if (on) {
      input.value = ""
      input.focus()
    } else {
      input.blur()
      menu.focus()
    }
    setHint()
    renderer.requestRender()
  }

  function stopConnectPoll() {
    connecting = false
    connectCode = null
    if (connectTimer) {
      clearInterval(connectTimer)
      connectTimer = null
    }
  }

  async function refreshUsage() {
    const u = await fetchUsage()
    paintUsage(u)
    return u
  }

  async function startConnect() {
    stopConnectPoll()
    const { code, url } = beginConnect()
    connectCode = code
    connecting = true
    showInput(true)
    setLog(
      [
        "CONNECT",
        "Finish sign-in in the browser to link this machine.",
        `code   ${code}`,
        `link   ${url}`,
        "",
        "Waiting for browser…  (or paste an sc_… key below)",
      ].join("\n"),
      WARN,
    )
    const started = Date.now()
    connectTimer = setInterval(async () => {
      if (!connecting || !connectCode) return
      const left = Math.max(0, 180 - Math.floor((Date.now() - started) / 1000))
      if (left <= 0) {
        stopConnectPoll()
        showInput(false)
        appendLog("✗ Timed out. Paste a key from the dashboard, or try connect again.")
        detail.fg = ERR
        setHint()
        renderer.requestRender()
        return
      }
      try {
        const secret = await pollConnect(connectCode)
        if (!secret) {
          appendLog(`… waiting (${left}s left)`)
          return
        }
        saveApiKey(secret)
        stopConnectPoll()
        showInput(false)
        appendLog("✓ Account linked.")
        detail.fg = OK
        await refreshUsage()
        setHint()
      } catch (err) {
        appendLog(`⚠ ${err instanceof Error ? err.message : String(err)}`)
      }
    }, 1500)
  }

  async function acceptApiKey(raw: string) {
    const key = raw.trim()
    if (!key.startsWith("sc_")) {
      appendLog("✗ Key should start with sc_")
      detail.fg = ERR
      return
    }
    saveApiKey(key)
    stopConnectPoll()
    showInput(false)
    setLog("✓ API key saved. Loading usage…", OK)
    await refreshUsage()
    setHint()
  }

  async function runCommand(name: string) {
    if (busy) return
    if (name === "quit") {
      stopConnectPoll()
      renderer.destroy()
      process.exit(0)
    }
    if (name === "connect") {
      await startConnect()
      return
    }

    busy = true
    setHint()
    renderer.requestRender()
    try {
      if (name === "usage") {
        const u = await refreshUsage()
        setLog(formatUsageLog(u), u.error ? WARN : INK)
      } else if (name === "billing") {
        setLog(`Upgrade / add credits\n${BILLING_URL}\n\nOpen this link to review billing and choose an upgrade.`, BRAND)
      } else if (name === "account") {
        const a = await fetchAccount()
        setLog(formatAccountLog(a), a.error ? WARN : INK)
      } else if (name === "plugin") {
        setLog("Installing MCP + hooks…", WARN)
        const result = installPlugin()
        setLog(formatPluginLog(result), OK)
        await refreshUsage()
      } else if (name === "setup") {
        if (!loadConfig()?.api_key) {
          await startConnect()
          appendLog("")
          appendLog("After link succeeds, run setup again (or plugin) to install MCP + hooks.")
          return
        }
        setLog("Setup · account already linked. Installing MCP + hooks…", WARN)
        const result = installPlugin()
        setLog(`SETUP COMPLETE\n\n${formatPluginLog(result)}`, OK)
        await refreshUsage()
      } else if (name === "agents") {
        setLog(formatAgentsLog(detectAgents()), INK)
      } else if (name === "status") {
        const [st, u] = await Promise.all([proxyStatus(), refreshUsage()])
        const lines = [
          "STATUS",
          st.running ? `✓ proxy RUNNING  localhost:${st.port}${st.version ? `  v${st.version}` : ""}` : `○ proxy STOPPED  localhost:${st.port}`,
          st.linked ? `account   ${u.email}` : "account   not linked",
          st.agents.length ? `agents    ${st.agents.join(", ")}` : "agents    (run plugin / setup)",
          u.error ? `usage     ${u.error}` : `usage     ${fmt(u.tokensSaved)} saved  −${u.cutPct}%`,
        ]
        setLog(lines.join("\n"), st.running ? OK : MUTED)
      } else if (name === "start") {
        setLog("Starting proxy…", WARN)
        const r = await startProxy()
        setLog(
          r.already
            ? `✓ Proxy already running on localhost:${r.port}`
            : `✓ Proxy healthy on localhost:${r.port} (PID ${r.pid})\n→ point agents at http://localhost:${r.port}/v1`,
          OK,
        )
      } else if (name === "stop") {
        const stopped = stopProxy()
        setLog(stopped ? "✓ Proxy stopped." : "○ Proxy was not running.", stopped ? OK : MUTED)
      } else if (name === "mcp-check") {
        setLog("Checking MCP…", WARN)
        const r = await mcpCheck()
        setLog(
          r.ok ? `✓ MCP ok\n  tools  ${r.tools.join(", ")}\n  ${r.detail}` : `✗ MCP failed\n  ${r.detail}`,
          r.ok ? OK : ERR,
        )
      } else {
        setLog(`unknown command: ${name}`, ERR)
      }
    } catch (err) {
      setLog(`✗ ${err instanceof Error ? err.message : String(err)}`, ERR)
    } finally {
      busy = false
      setHint()
      renderer.requestRender()
    }
  }

  menu.on(SelectRenderableEvents.ITEM_SELECTED, (_i: number, option: SelectOption) => {
    if (mode === "input") return
    void runCommand(option.name)
  })

  menu.onMouseDown = (event) => {
    if (mode === "input" || busy) return
    const linesPerItem = Math.max(1, (menu as unknown as { linesPerItem?: number }).linesPerItem ?? 2)
    const scrollOffset = (menu as unknown as { scrollOffset?: number }).scrollOffset ?? 0
    const localY = event.y - menu.y
    if (localY < 0 || localY >= menu.height) return
    const index = scrollOffset + Math.floor(localY / linesPerItem)
    if (index < 0 || index >= COMMANDS.length) return
    menu.setSelectedIndex(index)
    menu.selectCurrent()
    event.stopPropagation()
  }

  input.on(InputRenderableEvents.ENTER, (value: string) => {
    void acceptApiKey(String(value || ""))
  })

  input.visible = false

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    const name = String(key.name || "").toLowerCase()
    if (name === "escape" || name === "esc") {
      if (connecting || mode === "input") {
        stopConnectPoll()
        showInput(false)
        appendLog("connect cancelled")
        key.preventDefault?.()
      }
      return
    }
    if (mode === "input") return
    if (name === "q" && !key.ctrl && !key.meta) {
      void runCommand("quit")
      return
    }
    if (name === "r" && !key.ctrl && !key.meta) {
      void (async () => {
        const u = await refreshUsage()
        setLog(formatUsageLog(u), u.error ? WARN : INK)
      })()
      return
    }
    if (name === "c" && !key.ctrl && !key.meta) {
      void runCommand("connect")
      return
    }
    if (!isConfirmKey(key)) return
    const now = Date.now()
    if (now - lastConfirm < 80) return
    lastConfirm = now
    menu.focus()
    menu.selectCurrent()
    key.preventDefault?.()
  })

  menu.focus()
  setLog("loading live usage from your SuperCompress account…", MUTED)
  const u = await refreshUsage()
  setLog(
    u.linked
      ? formatUsageLog(u)
      : "Not linked yet.\n\nRun connect or setup — browser sign-in links this machine.\nThen plugin installs MCP + hooks for detected agents.",
    u.linked ? (u.error ? WARN : INK) : MUTED,
  )
  setHint()
}
