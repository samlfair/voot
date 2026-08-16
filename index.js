import http from 'node:http';
import queryString from 'node:querystring'
import path from "node:path"
import { stat, writeFile, readFile, mkdir } from "node:fs/promises"
import WebSocket from "faye-websocket"
import chokidar from 'chokidar';
import { styleText } from "node:util"
import fs from "fs"
import mimeTypes from "./mime.js"
import votive from "votive"
import { writeFileSync } from "node:fs"
import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'

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
 * Finds the processor (if any) that both claims this extension and
 * declares a `handlePreviewRequest` hook - multiple processors can share
 * an extension for unrelated build-time reasons (e.g. a `readURL`-only
 * processor), so matching on extension alone isn't enough to find the one
 * voot actually wants here.
 * @param {import("votive").VotiveConfig} config
 * @param {string} extension
 */
function findProcessor(config, extension) {
  return config.plugins
    ?.flatMap(plugin => plugin.processors || [])
    .find(processor => processor.extensions?.includes(extension) && processor.handlePreviewRequest)
}

/*
  runBuffers()/runFetches() do the slow part (analyzing a video, fetching
  a URL) and then trigger their own rebuild once done - see wrapRunner in
  votive/lib/bundle.js. That slow work never touches votive's build
  queue, so firing it here and moving on immediately (not awaiting it)
  never delays a foreground rebuild triggered by an unrelated file edit -
  see tasks/voot-unawaited-deferred-race.md. Still fire-and-forget, so
  errors need a .catch or a failed fetch/buffer would surface as an
  unhandled rejection.
*/
function runDeferred(runner, config) {
  if (!runner) return
  runner().catch(e => {
    if (config.logging !== "silent") console.error(e)
  })
}

// async function startServer({ inputDir, cacheDir, plugins, database, outputDir }) {
async function startServer(config) {

  const queue = await votive({ ...config, verbose: config.logging === "verbose" })
  let { cache, runBuffers, runFetches } = await queue()

  runDeferred(runBuffers, config)
  runDeferred(runFetches, config)

  const { sourceFolder, targetFolder } = config
  const server = http.createServer(async (req, res) => {
    const now = performance.now() % 100
    const pathInfo = route(req.url)

    const filePath = path.join(targetFolder, path.format(pathInfo))
    if (req.method === 'POST') {

      const chunks = []
      await pipeline(req, new Writable({
        write(chunk, _, cb) {
          chunks.push(chunk)
          cb()
        }
      }))

      const body = Buffer.concat(chunks).toString()
      const formData = queryString.parse(body)
      const refererPath = (new URL(req.headers.referer)).pathname.slice(1)
      if (formData.action === "addpage") {
        const parsedPath = path.parse(path.join(refererPath, formData.pagename))

        const formattedPath = path.format({
          name: formData.pagename || "untitled",
          ext: ".md",
          dir: parsedPath.dir
        })

        /* FIXME this will fail if the parent is an md file rather than a folder */

        const written = await writeFile(formattedPath, `# ${formData.pagename}`, { encoding: "utf-8" })
      } else if (formData.action === "addfolder") {
        const parsedPath = path.normalize(path.join(refererPath, formData.foldername || "untitled"))

        const dirs = parsedPath.split(path.sep)

        for (const [index, segment] of dirs.entries()) {
          const dir = path.join(...dirs.slice(0, index + 1))
          try {
            const stats = await stat(dir)
            if (stats.isFile) throw new Error()
          } catch (e) {
            try {
              await mkdir(dir, { recursive: true })
            } catch (e) {
              console.error(e)
            }
          }
        }

        const homePath = path.join(parsedPath, "home.md")
        await writeFile(homePath, `# ${formData.foldername}`, { encoding: "utf-8" })
      }
    }

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

      // The database only stores a target's own text content if some
      // processor's readFile/writeFile populated it (see the `data` column
      // in createDatabase.js) - nothing does yet for html. Fall back to
      // what's actually on disk so the client still has real content to
      // work with, same source today's code always used.
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
