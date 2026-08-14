import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useKV } from "../context/kv"
import { useToast } from "../ui/toast"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Global } from "@opencode-ai/core/global"
import { createResource, onCleanup } from "solid-js"
import path from "path"
import os from "os"
import fs from "fs/promises"

const BG_DIR = path.join(Global.Path.config, "backgrounds")
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"])
const NONE_VALUE = "__mimocode_image_none__"
const IMPORT_VALUE = "__mimocode_image_import__"

async function listBackgrounds() {
  await fs.mkdir(BG_DIR, { recursive: true }).catch(() => {})
  const items = await fs.readdir(BG_DIR).catch(() => [] as string[])
  return items
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
}

function expandHome(p: string) {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

export function DialogImageList() {
  const dialog = useDialog()
  const kv = useKV()
  const toast = useToast()
  const [files] = createResource(listBackgrounds)
  const initial = kv.get("background_image")
  let confirmed = false

  onCleanup(() => {
    if (!confirmed) kv.set("background_image", initial)
  })

  const importImage = async () => {
    const raw = await DialogPrompt.show(dialog, "Import Background Image", {
      placeholder: "Enter image path (~/path/to/image.png)",
    })
    if (raw === null) return
    const src = expandHome(raw.trim().replace(/^['"]|['"]$/g, ""))
    if (!src) return
    if (!IMAGE_EXT.has(path.extname(src).toLowerCase())) {
      toast.show({ message: "Invalid image format", variant: "error" })
      return
    }
    if (!(await Bun.file(src).exists())) {
      toast.show({ message: "File not found", variant: "error" })
      return
    }
    await fs.mkdir(BG_DIR, { recursive: true })
    const base = path.basename(src)
    const dst = path.join(BG_DIR, base)
    await fs.copyFile(src, dst).catch((err) => {
      toast.show({ message: String(err), variant: "error" })
      throw err
    })
    kv.set("background_image", base)
    toast.show({ message: "Background image imported", variant: "info" })
  }

  const options = (): DialogSelectOption<string>[] => {
    const list: DialogSelectOption<string>[] = [
      {
        title: "+ Import new image...",
        value: IMPORT_VALUE,
        onSelect: () => {
          void importImage()
        },
      },
    ]
    for (const f of files() ?? []) list.push({ title: f, value: f })
    list.push({ title: "None (no background)", value: NONE_VALUE })
    return list
  }

  return (
    <DialogSelect
      title="Background Images"
      options={options()}
      current={initial}
      onMove={(opt) => {
        if (opt.value === IMPORT_VALUE) return
        if (opt.value === NONE_VALUE) {
          kv.set("background_image", undefined)
          return
        }
        kv.set("background_image", opt.value)
      }}
      onSelect={(opt) => {
        if (opt.value === IMPORT_VALUE) return
        if (opt.value === NONE_VALUE) {
          kv.set("background_image", undefined)
        } else {
          kv.set("background_image", opt.value)
        }
        confirmed = true
        dialog.clear()
      }}
    />
  )
}
