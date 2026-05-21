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


import clientScript from "./client.js"

let cache

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

  const queue = await votive(config)

  const { sourceFolder, destinationFolder } = config
  const server = http.createServer(async (req, res) => {
    const now = performance.now() % 100
    const pathInfo = route(req.url)

    const filePath = path.join(destinationFolder, path.format(pathInfo))
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
            await mkdir(dir, { recursive: true })

          }
        }

        const homePath = path.join(parsedPath, "home.md")
        await writeFile(homePath, `# ${formData.foldername}`, { encoding: "utf-8" })
      }

      cache = await queue()
    }


    // Unusued guard
    if (req.method) {
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
            const fileSplit = file.split("</body>")
            const script = await import("./client.js")
            fileSplit.splice(1, 0, `<script>${script.default.toString()}\n\nopenSocket()</script>`)
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
    console.info(`${styleText("dim", "Vowel:")} ${styleText("blue", "http://localhost:8000")}`);
  });

  let ws

  server.on('upgrade', (req, socket, body) => {
    ws = new WebSocket(req, socket, body)

    if (WebSocket.isWebSocket(req)) {
      ws.on('message', (e) => {
        if (e.data = "opened") {
          console.info(`${styleText("dim", "client:")} ${styleText("cyan", "connection opened")}`)
        } else {
          ws.send("Message received")
        }
      })

      ws.on('close', (e) => {
        console.info(`${styleText("dim", "client:")} ${styleText("cyan", "connection closed")}`)
        ws = null
      })
    }
  })

  cache = await queue()

  chokidar.watch(destinationFolder, {})
    .on("change", async (filePath, stats) => {
      console.info(`${styleText("dim", `change:`)} ${styleText("blue", filePath)}`)
      const file = await readFile(filePath, "utf-8")
      const destinationPath = (new URL(filePath, "thismessage:/")).pathname
      if (ws) ws.send(JSON.stringify({ message: "filechange", payload: { path: destinationPath, data: file } }))
    })

  chokidar.watch(sourceFolder, {
    ignored: (path, stats) => {
      return path.startsWith(destinationFolder)
        || path.startsWith("node_modules")
        || path.match(/^\.\w/)
    }
  }).on('all', async (event, filePath) => {
    console.info(`${styleText("dim", `${event}:`)} ${styleText("yellow", filePath)}`)
    const source = cache.source.get(filePath)
    // TODO: Read all updated files
    if (source && source.destination) {
      const { ext } = path.parse(source.path)
      if (ext === ".md" || ext === ".css") {
        cache = await queue()
        const file = await readFile(path.join(destinationFolder, source.destination), "utf-8")
        const filePath = (new URL(source.destination, "thismessage:/")).pathname
        // if (ws) ws.send(JSON.stringify({ message: "refresh", payload: { path: filePath, data: file } }))
      }
    }
  });
}


export default startServer
