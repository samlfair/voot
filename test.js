import startServer from "./index.js"

/** @import {VotiveConfig} from "votive" */

/** @type {VotiveConfig} */
const config = {
  sourceFolder: ".",
  destinationFolder: "output"
}

startServer([], config)
