import http from 'node:http';
import os from "node:os"
import path from "node:path"
import { stat, writeFile, readFile, mkdir } from "node:fs/promises"
import WebSocket from "faye-websocket"
import chokidar from 'chokidar';
import { styleText } from "node:util"
import fs from "fs"
import mimeTypes from "./mime.js"
import votive from "votive"
import { cleanupDatabase } from "votive/internals"
import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'

/** @import {VotiveConfig} from "votive" */

let cache

function parseURL(url) {
  try {
    return new URL(url)
  } catch (e) {
    try {
      return new URL(url, "thismessage:/")
    } catch (e) {
      null
    }
  }
}

async function checkFile(filePath) {
  try {
    return await stat(filePath)
  } catch (e) {
    return false
  }
}

function route(url) {
  const urlInfo = parseURL(url)
  const pathInfo = path.parse(urlInfo.pathname.slice(1))

  delete pathInfo.base

  if (!pathInfo.ext) pathInfo.ext = ".html"
  if (!pathInfo.name) pathInfo.name = "index"

  return pathInfo
}

/**
 * Finds the processor (if any) that both claims `extension` and declares
 * `hook` - multiple processors can share an extension for unrelated
 * build-time reasons, so matching on extension alone isn't enough.
 * @param {VotiveConfig} config
 * @param {string} extension
 * @param {"handlePreviewRequest" | "handlePreviewError"} hook
 */
function findProcessor(config, extension, hook) {
  return config.plugins
    ?.flatMap(plugin => plugin.processors || [])
    .find(processor => processor.extensions?.includes(extension) && processor[hook])
}

/**
 * A named action a plugin registers on its top-level `commands` object
 * (sibling to `processors`, not nested under one - a command isn't
 * scoped to a file extension). `notify` pushes a progress update back to
 * whoever triggered the command; a synchronous or single-step command
 * can just never call it. See tasks/deploy-hook.md for the design this
 * came out of.
 * @callback CommandHandler
 * @param {any} payload
 * @param {{ config: VotiveConfig, notify: (message: object) => void }} context
 * @returns {Promise<any> | any}
 */

/**
 * Finds a registered command by name across every plugin - same
 * flattening findProcessor does for processors, one level up (commands
 * aren't extension-scoped).
 * @param {VotiveConfig} config
 * @param {string} name
 * @returns {CommandHandler | undefined}
 */
function findCommand(config, name) {
  return config.plugins
    ?.flatMap(plugin => plugin.commands ? Object.entries(plugin.commands) : [])
    .find(([commandName]) => commandName === name)
    ?.[1]
}

/**
 * Runs a registered command directly - no server, no WS, no browser
 * required. This is the whole point of commands being "just a function
 * a plugin registered": a CLI entry point can call this directly for a
 * one-shot/CI use (e.g. an automated deploy), reusing the exact same
 * handler a live "Publish" button in a GUI would trigger over WS (see
 * handleCommand below) - two invocation paths, one implementation.
 * @param {VotiveConfig} config
 * @param {string} name
 * @param {any} payload
 * @param {(message: object) => void} [notify]
 */
async function runCommand(config, name, payload, notify = () => {}) {
  const handler = findCommand(config, name)
  if (!handler) throw new Error(`No command registered: "${name}"`)
  return handler(payload, { config, notify })
}

function runDeferred(runner, config) {
  if (!runner) return
  runner().catch(e => {
    if (config.logging !== "silent") console.error(e)
  })
}

/** @returns {string[]} every non-internal IPv4 address this machine has */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(address => address && address.family === "IPv4" && !address.internal)
    .map(address => address.address)
}

/**
 * Serves an already-existing file with `status`, running its extension's
 * handlePreviewRequest if one is registered. Shared by the normal-response
 * and 404-fallback paths so they can't drift from each other - a
 * fallback page (e.g. 404.html) goes through the exact same handling a
 * normal page would, live-reload script injection included.
 * @param {import("node:http").ServerResponse} res
 * @param {string} filePath
 * @param {string} extension
 * @param {import("node:fs").Stats} stats
 * @param {number} status
 * @param {VotiveConfig} config
 */
async function respondWithFile(res, filePath, extension, stats, status, config) {
  const contentType = mimeTypes[extension.toLowerCase()] || 'application/octet-stream'
  res.writeHead(status, { 'Content-Type': contentType, "cache-control": "no-store" })

  if (stats.size < 1024 * 1024) {
    const file = await readFile(filePath)
    const processor = findProcessor(config, extension, "handlePreviewRequest")
    res.end(processor ? processor.handlePreviewRequest(file) : file)
  } else {
    fs.createReadStream(filePath).pipe(res)
  }
}

/**
 * @param {import("node:http").IncomingMessage} req
 */
async function readJSONBody(req) {
  const chunks = []
  await pipeline(req, new Writable({
    write(chunk, _, cb) {
      chunks.push(chunk)
      cb()
    }
  }))
  return JSON.parse(Buffer.concat(chunks).toString())
}

/**
 * Resolves `filePath` against `sourceFolder`, rejecting anything that
 * would escape it - a leading `../`, a `../` buried in the middle, or an
 * absolute path (which `path.resolve` would otherwise happily let
 * override the base entirely).
 * @param {string} sourceFolder
 * @param {string} filePath
 * @returns {string | null}
 */
function resolveSourcePath(sourceFolder, filePath) {
  const root = path.resolve(sourceFolder)
  const resolved = path.resolve(root, filePath)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

/**
 * Generic write endpoint for plugin clients: `{ type: "file" | "folder",
 * filePath: string, data?: string }`. Writes go straight to disk - votive's
 * own sourceFolder watcher (see the chokidar.watch(sourceFolder, ...)
 * below) picks up the result the same way it picks up any other edit, so
 * there's no separate rebuild trigger to call here.
 *
 * Only ever reachable when the server is loopback-only - see
 * isNetworkFacing in startServer(). Writing arbitrary files under
 * sourceFolder with zero auth is fine when the only thing that can reach
 * this port is something already running on the same machine; it stops
 * being fine the moment the server is reachable from the LAN. Rather than
 * add real auth, the two capabilities are just mutually exclusive for now
 * (tasks/local-network-serving.md) - network access disables this
 * endpoint entirely instead of leaving it exposed.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {VotiveConfig} config
 */
async function handleWrite(req, res, config) {
  function fail(status, error) {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error }))
  }

  let payload
  try {
    payload = await readJSONBody(req)
  } catch (e) {
    return fail(400, "invalid JSON body")
  }

  const { type, filePath, data } = payload || {}

  if (type !== "file" && type !== "folder") return fail(400, 'type must be "file" or "folder"')
  if (typeof filePath !== "string" || !filePath) return fail(400, "filePath is required")

  const resolved = resolveSourcePath(config.sourceFolder, filePath)
  if (!resolved) return fail(403, "filePath must stay within sourceFolder")

  try {
    if (type === "folder") {
      await mkdir(resolved, { recursive: true })
    } else {
      await mkdir(path.dirname(resolved), { recursive: true })
      await writeFile(resolved, data ?? "", { encoding: "utf-8" })
    }
  } catch (e) {
    console.error(e)
    return fail(500, "write failed")
  }

  res.writeHead(200, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ path: path.relative(config.sourceFolder, resolved) }))
}

/**
 * Dispatches one `{ action: "command", id, command, payload }` WS message:
 * runs the named command (see runCommand) and streams the result back
 * over the same socket, `id` threaded through every frame so a client
 * with more than one command in flight (or just several clicks) can tell
 * which response belongs to which request.
 *
 * Same caution as handleWrite, arguably more: a command can do anything
 * a plugin author wired it to do, including something as consequential
 * as a production deploy - disabled while network-facing for the exact
 * same reason (tasks/local-network-serving.md, tasks/deploy-hook.md).
 *
 * No concurrency handling here on purpose - if the same command (or two
 * different ones) can't safely run at once, that's the command's own
 * problem to guard against, not something votive/voot assumes on a
 * plugin author's behalf.
 * @param {import("faye-websocket").WebSocket} ws
 * @param {{ id: any, command: string, payload: any }} envelope
 * @param {VotiveConfig} config
 * @param {boolean} isNetworkFacing
 */
async function handleCommand(ws, envelope, config, isNetworkFacing) {
  const { id, command, payload } = envelope

  function send(frame) {
    ws.send(JSON.stringify({ id, ...frame }))
  }

  if (isNetworkFacing) {
    send({ status: "error", message: "commands are disabled while serving on the network" })
    return
  }

  try {
    const data = await runCommand(config, command, payload, send)
    send({ status: "ok", data })
  } catch (e) {
    send({ status: "error", message: e?.message || String(e) })
  }
}

/**
 * @callback HandlePreviewRequest
 * @param {Buffer} body - the raw file content as read from disk
 * @returns {string | Buffer}
 */

/**
 * Called when the requested target doesn't exist on disk, letting a
 * plugin supply a fallback target to serve instead - e.g. vowel's
 * synthesized 404.html. The returned path is resolved and served through
 * the exact same path a normal request takes (including running that
 * target's own handlePreviewRequest, if it has one), just with a 404
 * status instead of 200. Returning nothing (or a path that also doesn't
 * exist) falls back to an empty 404 body.
 * @callback HandlePreviewError
 * @param {import("node:path").ParsedPath} pathInfo - the route that was requested but not found
 * @returns {string | undefined}
 */


/**
 * `host`: which interface to bind - defaults to loopback-only
 * ("127.0.0.1"). Passing anything else (most commonly "0.0.0.0", all
 * interfaces) opts into serving the LAN, and disables the write endpoint
 * for as long as the server runs - see handleWrite's doc comment and
 * isNetworkFacing below.
 * @param {VotiveConfig & { handlePreviewRequest: HandlePreviewRequest, host?: string }} config
 */
async function startServer(config) {

  const host = config.host || "127.0.0.1"
  const isNetworkFacing = host !== "127.0.0.1" && host !== "localhost"

  const queue = await votive({ ...config, verbose: config.logging === "verbose" })
  let { cache, runBuffers, runFetches } = await queue()

  runDeferred(runBuffers, config)
  runDeferred(runFetches, config)

  // A full stat() pass over every target - unlike runBuffers()/
  // runFetches(), its cost doesn't shrink to ~0 when nothing changed, so
  // this runs once at startup rather than on every edit (see
  // cleanupDatabase.js for what it actually checks/fixes).
  runDeferred(async () => cleanupDatabase(config, cache), config)

  const { sourceFolder, targetFolder } = config
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      if (isNetworkFacing) {
        res.writeHead(403, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "the write endpoint is disabled while serving on the network" }))
        return
      }
      return handleWrite(req, res, config)
    }

    const pathInfo = route(req.url)
    const filePath = path.join(targetFolder, path.format(pathInfo))
    const stats = await checkFile(filePath)

    if (stats) return respondWithFile(res, filePath, pathInfo.ext, stats, 200, config)

    const errorProcessor = findProcessor(config, pathInfo.ext, "handlePreviewError")
    const fallbackPath = errorProcessor?.handlePreviewError(pathInfo)
    const fallbackFilePath = fallbackPath && path.join(targetFolder, fallbackPath)
    const fallbackStats = fallbackFilePath && await checkFile(fallbackFilePath)

    if (fallbackStats) return respondWithFile(res, fallbackFilePath, path.extname(fallbackPath), fallbackStats, 404, config)

    res.writeHead(404)
    res.end()
  });

  server.listen(8000, host, () => {
    if (config.logging === "silent") return
    console.info(`${styleText("dim", "preview:")} ${styleText("cyan", "running on http://localhost:8000")}`)
    if (!isNetworkFacing) return
    for (const address of lanAddresses()) {
      console.info(`${styleText("dim", "preview:")} ${styleText("cyan", `also on http://${address}:8000`)}`)
    }
    console.info(`${styleText("dim", "preview:")} ${styleText("yellow", "write endpoint disabled while serving on the network")}`)
  });

  let ws

  server.on('upgrade', (req, socket, body) => {
    ws = new WebSocket(req, socket, body)

    if (WebSocket.isWebSocket(req)) {
      ws.on('message', (e) => {
        let envelope
        try {
          envelope = JSON.parse(e.data)
        } catch (err) {
          envelope = null
        }

        if (envelope && envelope.action === "command") {
          handleCommand(ws, envelope, config, isNetworkFacing)
          return
        }

        if (e.data === "opened") {
          if (config.logging === "verbose") console.info(`${styleText("dim", "preview: ")} ${styleText("cyan", "connection opened")}`)
        } else {
          ws.send("Message received")
        }
      })

      ws.on('close', (e) => {
        if (config.logging === "verbose") console.info(`${styleText("dim", "preview: ")} ${styleText("cyan", "connection closed")}`)
        ws = null
      })
    }
  })

  chokidar.watch(targetFolder, {})
    .on("change", async (filePath) => {
      if (config.logging === "verbose") console.info(`${styleText("dim", `watching:`)} ${styleText("yellow", "change " + filePath)}`)
      if (!ws) return

      const targetPath = path.relative(targetFolder, filePath)
      const target = cache.target.get(targetPath)
      if (!target) return

      const fileStats = await checkFile(filePath)
      const data = target.data ?? (fileStats && fileStats.size < 1024 * 1024
        ? await readFile(filePath, "utf-8").catch(() => null)
        : null)

      ws.send(JSON.stringify({ ...target, data }))
    })

  chokidar.watch(sourceFolder, {
    ignored: (path, stats) => {
      return path.startsWith(targetFolder)
        || path.startsWith("node_modules")
        || path.match(/^\.\w/)
    }
  }).on('all', async (event, filePath) => {
    if (config.logging === "verbose") console.info(`${styleText("dim", `watching:`)} ${styleText("yellow", event + " " + filePath)}`)

    // Awaited: this is the foreground rebuild for the file that just
    // changed, and the whole point is to write its output promptly.
    const result = await queue()
    cache = result.cache

    // Not awaited: any buffer/fetch work this edit turned up (e.g. a
    // newly-added video, a bare URL) must not delay the *next* edit's
    // own queue() call - see runDeferred above and
    // tasks/voot-unawaited-deferred-race.md.
    runDeferred(result.runBuffers, config)
    runDeferred(result.runFetches, config)
  });
}


export default startServer
export { runCommand }
