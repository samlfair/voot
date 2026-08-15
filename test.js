import startServer from "./index.js"

/** @import {VotiveConfig} from "votive" */

/** @type {VotiveConfig} */
const config = {
  sourceFolder: ".",
  targetFolder: "output"
}

startServer([], config)
