import fs from "fs"
import path from "path"

export function loadBuiltinScripts() {
  const dir = path.resolve(import.meta.dir, "builtin")
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".js"))
    .sort()
    .map((file) => ({ file, script: fs.readFileSync(path.join(dir, file), "utf8") }))
}
