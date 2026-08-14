export type MemoryWriteConfig = {
  memory?: {
    disable_write?: boolean
  }
}

export function isMemoryWriteEnabled(cfg: MemoryWriteConfig | undefined): boolean {
  return cfg?.memory?.disable_write !== true
}
