import http from 'node:http';
import path from "node:path"
import { watch } from "node:fs"
import { stat, readFile, mkdir } from "node:fs/promises"
import WebSocket from "faye-websocket"
import chokidar from 'chokidar';
import { styleText } from "node:util"
import fs from "fs"
import mimeTypes from "./mime.js"
import votive from "votive"

import clientScript from "./client.js"

function parseURL(url) {
  try {
    return new URL(url)
  } catch (e) {
    return new URL(url, "thismessage:/")
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

// async function startServer({ inputDir, cacheDir, plugins, database, outputDir }) {
async function startServer(config) {
  const { sourceFolder, destinationFolder } = config
  const server = http.createServer(async (req, res) => {
    const pathInfo = route(req.url)

    const filePath = path.join(destinationFolder, path.format(pathInfo))

    if (req.method === 'GET') {
      // Sending dev assets
      // if (pathInfo.ext && pathInfo.ext !== ".html" && false) {
      //   const [url] = req.url.split("?")
      //   return
      //   const result = database.output.getOutputByURLPath(url)
      //   if (result) {
      //     res.writeHead(200, { 'Content-Type': 'text/plain', 'cache-control': 'no-store' })
      //     res.end(result.data)
      //   } else {
      //     res.writeHead(404);
      //     res.end();
      //   }
      // } else {
      // const script = clientScript()
      // const splitHTML = result.data.split("</head>")
      // const injectedHTML = splitHTML.splice(1, 0, script)
      // const joinedHTML = splitHTML.join("")

      const contentType = mimeTypes[pathInfo.ext.toLowerCase()] || 'application/octet-stream'

      const stats = await checkFile(filePath)

      if (stats) {
        res.writeHead(200, {
          'Content-Type': contentType,
          // 'Content-Length': stats.size,
          "cache-control": "no-store"
        })

        if (stats.size < 1024 * 1024) {
          if (pathInfo.ext === ".html") {
            const file = await readFile(filePath, "utf-8")
            const fileSplit = file.split("</head>")
            fileSplit.splice(1, 0, clientScript())
            const html = fileSplit.join("")
            res.end(html)
          } else {
            const file = await readFile(filePath)
            res.end(file)
          }
        } else {
          fs.createReadStream(filePath).pipe(res)
        }
      } else {
        res.writeHead(404);
        res.end();
        // }
      }
    }
  });

  server.listen(8000, () => {
    console.log(`${styleText("dim", "Vowel:")} ${styleText("blue", "http://localhost:8000")}`);
  });

  let ws

  server.on('upgrade', (req, socket, body) => {
    ws = new WebSocket(req, socket, body)

    if (WebSocket.isWebSocket(req)) {
      ws.on('message', (e) => {
        if (e.data = "opened") {
          console.log("Socket opened")
        } else {
          ws.send("Message received")
        }
      })

      ws.on('close', (e) => {
        console.log('close', e.code, e.reason)
        ws = null
      })
    }
  })

  const cache = await votive(config)

  // One-liner for current directory
  chokidar.watch(sourceFolder, {
    ignored: (path, stats) => {
      return path.startsWith(destinationFolder)
        || path.startsWith("node_modules")
        || path.match(/^\.\w/)
    }
  }).on('all', async (event, filePath) => {
    console.log(`${styleText("dim", "Watching:")} ${styleText("yellow", filePath)}`)
    const source = cache.getSource(filePath)
    // TODO: Read all updated files
    if (source && source.destination) {
      const { ext } = path.parse(source.destination)
      if (ext === ".html") {
        await votive(config, cache)
        const file = await readFile(path.join(destinationFolder, source.destination), "utf-8")
        const filePath = (new URL(source.destination, "thismessage:/")).pathname
        if (ws) ws.send(JSON.stringify({ message: "refresh", payload: { path: filePath, data: file } }))
      }
    }
  });
}


export default startServer
