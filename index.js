import http from 'node:http';
import path from "node:path"
import { stat, writeFile, readFile, mkdir } from "node:fs/promises"
import WebSocket from "faye-websocket"
import chokidar from 'chokidar';
import { styleText } from "node:util"
import fs from "fs"
import mimeTypes from "./mime.js"
import votive from "votive"
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
 * @param {VotiveConfig} config
 * @param {string} extension
 */
function findProcessor(config, extension) {
  return config.plugins
    ?.flatMap(plugin => plugin.processors || [])
    .find(processor => processor.extensions?.includes(extension) && processor.handlePreviewRequest)
}

function runDeferred(runner, config) {
  if (!runner) return
  runner().catch(e => {
    if (config.logging !== "silent") console.error(e)
  })
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
 * @callback HandlePreviewRequest
 * @param {Buffer} body - the raw file content as read from disk
 * @returns {string | Buffer}
 */


/**
 * @param {VotiveConfig & { handlePreviewRequest: HandlePreviewRequest }} config 
 */
async function startServer(config) {

  const queue = await votive({ ...config, verbose: config.logging === "verbose" })
  let { cache, runBuffers, runFetches } = await queue()

  runDeferred(runBuffers, config)
  runDeferred(runFetches, config)

  const { sourceFolder, targetFolder } = config
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST') return handleWrite(req, res, config)

    const pathInfo = route(req.url)
    const filePath = path.join(targetFolder, path.format(pathInfo))

    const contentType = mimeTypes[pathInfo.ext.toLowerCase()] || 'application/octet-stream'

    const stats = await checkFile(filePath)

    if (stats) {
      res.writeHead(200, {
        'Content-Type': contentType,
        "cache-control": "no-store"
      })

      if (stats.size < 1024 * 1024) {
        const file = await readFile(filePath)
        const processor = findProcessor(config, pathInfo.ext)
        res.end(processor ? processor.handlePreviewRequest(file) : file)
      } else {
        fs.createReadStream(filePath).pipe(res)
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(8000, () => {
    if (config.logging !== "silent") console.info(`${styleText("dim", "preview:")} ${styleText("cyan", "running on http://localhost:8000")}`);
  });

  let ws

  server.on('upgrade', (req, socket, body) => {
    ws = new WebSocket(req, socket, body)

    if (WebSocket.isWebSocket(req)) {
      ws.on('message', (e) => {
        if (e.data = "opened") {
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
