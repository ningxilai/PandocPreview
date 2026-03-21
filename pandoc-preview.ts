import { join, basename } from "https://deno.land/std/path/mod.ts"
import { ensureDir, ensureSymlink } from "https://deno.land/std/fs/mod.ts"

const emacsPort = parseInt(Deno.args[1])
const globalTmp = "/dev/shm"
const sessionDir = join(globalTmp, `preview-${Deno.pid}`)

let emacsWs: WebSocket | null = null
let tempDir = ""
let rootDir = ""
let filePath = ""
let renderArgs: string[][] = []
let watchRx: RegExp | null = null
let renderTimer: number | null = null
let rendering = false
let renderPending = false
let renderVersion = 0
let watcher: Deno.FsWatcher | null = null

function sendToEmacs(msg: Record<string, unknown>) {
  if (emacsWs && emacsWs.readyState === WebSocket.OPEN) {
    emacsWs.send(JSON.stringify(msg))
  }
}

emacsWs = new WebSocket(`ws://127.0.0.1:${emacsPort}`)
emacsWs.onerror = () => {}
emacsWs.onclose = () => {}
emacsWs.onmessage = (e) => {
  if (typeof e.data === "string") handleMessage(e.data)
}

async function handleMessage(data: string) {
  try {
    const [cmd, ...args] = JSON.parse(data)
    switch (cmd) {
      case "init": {
        rootDir = args[0]
        filePath = args[1]
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(rootDir)))
        ).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 12)
        tempDir = join(sessionDir, hash)
        await ensureDir(tempDir)
        for await (const entry of Deno.readDir(rootDir)) {
          if (entry.name.startsWith(".")) continue
          try { await ensureSymlink(join(rootDir, entry.name), join(tempDir, entry.name)) } catch {}
        }
        break
      }
      case "render": {
        renderArgs = args[0]
        watchRx = new RegExp(args[1])
        await doRender()
        startWatcher()
        const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, httpHandler)
        sendToEmacs({ type: "server-ready", port: server.addr.port })
        break
      }
      case "sync": {
        const name = basename(args[0])
        try { await Deno.remove(join(tempDir, name)) } catch {}
        await Deno.writeTextFile(join(tempDir, name), args[1])
        scheduleRender()
        break
      }
      case "stop": {
        if (watcher) { watcher.close(); watcher = null }
        try { await Deno.remove(sessionDir, { recursive: true }) } catch {}
        break
      }
    }
  } catch {}
}

async function runCmd(exe: string, args: string[], cwd: string) {
  const { success, stderr } = await new Deno.Command(exe, {
    args, cwd, stdout: "piped", stderr: "piped"
  }).output()
  return { success, stderr: new TextDecoder().decode(stderr).trim() }
}

async function doRender() {
  if (renderArgs.length === 0) return
  rendering = true
  renderPending = false
  try {
    for (const args of renderArgs) {
      if (args.length === 0) continue
      const { success, stderr } = await runCmd(args[0], args.slice(1), tempDir)
      if (!success) {
        sendToEmacs({ type: "render-error", message: stderr.split("\n").pop() || stderr })
        rendering = false
        return
      }
    }
    renderVersion++
    await Deno.writeTextFile(join(tempDir, ".render-version"), String(renderVersion))
  } catch {}
  rendering = false
  if (renderPending) doRender()
}

function scheduleRender() {
  if (renderTimer !== null) clearTimeout(renderTimer)
  renderTimer = setTimeout(() => {
    if (rendering) renderPending = true
    else doRender()
  }, 300)
}

function startWatcher() {
  if (!watchRx) return
  const rx = watchRx
  try {
    watcher = Deno.watchFs(rootDir)
    ;(async () => {
      for await (const event of watcher!) {
        if (event.kind === "modify" || event.kind === "create") {
          if (event.paths.some(p => rx.test(p) && !p.includes("/."))) {
            for (const p of event.paths) {
              if (rx.test(p) && !p.includes("/.")) {
                try {
                  const content = await Deno.readTextFile(p)
                  const target = join(tempDir, basename(p))
                  try { await Deno.remove(target) } catch {}
                  await Deno.writeTextFile(target, content)
                } catch {}
              }
            }
            scheduleRender()
          }
        }
      }
    })()
  } catch {}
}

const RELOAD = `<script>(function(){var v=0;function c(){fetch("/__pv?="+Date.now()).then(function(r){return r.text()}).then(function(t){var n=+t;if(!v){v=n}if(n>v){location.reload()}}).catch(function(){})}setInterval(c,200)})()</script>`

async function httpHandler(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname
  if (path === "/__pv") return new Response(String(renderVersion), { headers: { "Cache-Control": "no-cache" } })
  const base = basename(filePath).replace(/\.\w+$/, "")
  const cands = path === "/" ? [base + ".html", base, "index.html"] : [path, path + ".html", path.slice(0, -5)]
  for (const c of cands) {
    try {
      let content = await Deno.readTextFile(join(tempDir, c))
      if (c.endsWith(".html") || !c.includes(".")) {
        content = content.replace(/<\/?root>/g, "").replace("</head>", RELOAD + "</head>")
      }
      const ext = (c.split(".").pop() || "").toLowerCase()
      const ct: Record<string, string> = { html: "text/html", css: "text/css", js: "text/javascript", png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml" }
      return new Response(content, { headers: { "Content-Type": ct[ext] || "text/html; charset=utf-8" } })
    } catch {}
  }
  return new Response("Not found", { status: 404 })
}
