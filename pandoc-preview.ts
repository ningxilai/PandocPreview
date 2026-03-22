import { join, basename } from "https://deno.land/std/path/mod.ts"
import { ensureDir, ensureSymlink } from "https://deno.land/std/fs/mod.ts"
import { DenoBridge } from "https://deno.land/x/denobridge@0.0.1/mod.ts"

const bridge = new DenoBridge(
  Deno.args[0],
  Deno.args[1],
  Deno.args[2],
  messageDispatcher,
)

const globalTmp = "/dev/shm"
const sessionDir = join(globalTmp, `preview-${Deno.pid}`)

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
let httpServer: Deno.HttpServer | null = null

function log(msg: string) {
  bridge.evalInEmacs(`(message "[pandoc-preview] ${msg.replace(/"/g, '\\"')}")`)
}

async function messageDispatcher(message: string) {
  try {
    const parsed = JSON.parse(message)
    const [cmd, ...args] = parsed[1] as [string, ...unknown[]]
    switch (cmd) {
      case "init": {
        rootDir = args[0] as string
        filePath = args[1] as string
        log(`init: rootDir=${rootDir} file=${filePath}`)
        const hash = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-1",
              new TextEncoder().encode(rootDir),
            ),
          ),
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 12)
        tempDir = join(sessionDir, hash)
        await ensureDir(tempDir)
        log(`tempDir=${tempDir}`)
        for await (const entry of Deno.readDir(rootDir)) {
          if (entry.name.startsWith(".")) continue
          try {
            await ensureSymlink(join(rootDir, entry.name), join(tempDir, entry.name))
          } catch (e) {
            log(`symlink error: ${entry.name} ${(e as Error).message}`)
          }
        }
        break
      }
      case "render": {
        renderArgs = JSON.parse(args[0] as string) as string[][]
        watchRx = new RegExp(args[1] as string)
        log(`render: cmd=${JSON.stringify(renderArgs[0])}`)
        await doRender()
        const files: string[] = []
        for await (const entry of Deno.readDir(tempDir)) {
          files.push(entry.name)
        }
        log(`render done, files: ${files.join(", ")}`)
        startWatcher()
        httpServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, httpHandler)
        const addr = httpServer.addr as Deno.NetAddr
        bridge.evalInEmacs(
          `(pandoc-preview--on-server-ready ${addr.port})`,
        )
        break
      }
      case "sync": {
        const name = basename(args[0] as string)
        try {
          await Deno.remove(join(tempDir, name))
        } catch {}
        await Deno.writeTextFile(join(tempDir, name), args[1] as string)
        scheduleRender()
        break
      }
      case "stop": {
        await cleanup()
        break
      }
    }
  } catch (e) {
    log(`error: ${(e as Error).message}`)
  }
}

async function cleanup() {
  if (watcher) {
    watcher.close()
    watcher = null
  }
  if (httpServer) {
    await httpServer.shutdown()
    httpServer = null
  }
  try {
    await Deno.remove(sessionDir, { recursive: true })
  } catch {}
}

try {
  Deno.addSignalListener("SIGINT", async () => {
    await cleanup()
    Deno.exit(0)
  })
} catch {}
try {
  Deno.addSignalListener("SIGTERM", async () => {
    await cleanup()
    Deno.exit(0)
  })
} catch {}
try {
  Deno.addSignalListener("SIGHUP", async () => {
    await cleanup()
    Deno.exit(0)
  })
} catch {}

async function runCmd(exe: string, args: string[], cwd: string) {
  const { success, stderr } = await new Deno.Command(exe, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output()
  return { success, stderr: new TextDecoder().decode(stderr).trim() }
}

async function doRender() {
  if (!Array.isArray(renderArgs) || renderArgs.length === 0) return
  rendering = true
  renderPending = false
  try {
    for (const args of renderArgs) {
      if (!Array.isArray(args) || args.length === 0) continue
      log(`run: ${args.join(" ")} in ${tempDir}`)
      const { success, stderr } = await runCmd(args[0], args.slice(1), tempDir)
      if (!success) {
        log(`render error: ${stderr}`)
        bridge.evalInEmacs(
          `(pandoc-preview--on-render-error ${JSON.stringify(stderr.split("\n").pop() || stderr)})`,
        )
        rendering = false
        return
      }
    }
    renderVersion++
    await Deno.writeTextFile(join(tempDir, ".render-version"), String(renderVersion))
  } catch (e) {
    log(`doRender exception: ${(e as Error).message}`)
  }
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
          if (event.paths.some((p) => rx.test(p) && !p.includes("/."))) {
            for (const p of event.paths) {
              if (rx.test(p) && !p.includes("/.")) {
                try {
                  const content = await Deno.readTextFile(p)
                  const target = join(tempDir, basename(p))
                  try {
                    await Deno.remove(target)
                  } catch {}
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
  if (path === "/__pv")
    return new Response(String(renderVersion), {
      headers: { "Cache-Control": "no-cache" },
    })
  const base = basename(filePath).replace(/\.\w+$/, "")
  const cands =
    path === "/"
      ? [base + ".html", base, "index.html"]
      : [path, path + ".html", path.slice(0, -5)]
  for (const c of cands) {
    try {
      let content = await Deno.readTextFile(join(tempDir, c))
      log(`http: ${path} -> ${c}`)
      if (c.endsWith(".html") || !c.includes(".")) {
        content = content
          .replace(/<\/?root>/g, "")
          .replace("</head>", RELOAD + "</head>")
      }
      const ext = (c.split(".").pop() || "").toLowerCase()
      const ct: Record<string, string> = {
        html: "text/html",
        css: "text/css",
        js: "text/javascript",
        png: "image/png",
        jpg: "image/jpeg",
        svg: "image/svg+xml",
      }
      return new Response(content, {
        headers: { "Content-Type": ct[ext] || "text/html; charset=utf-8" },
      })
    } catch {}
  }
  log(`http: ${path} NOT FOUND (tried: ${cands.join(", ")})`)
  return new Response("Not found", { status: 404 })
}
