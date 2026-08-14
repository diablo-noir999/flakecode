import { Effect } from "effect"
import { join } from "path"
import { mkdir, readFile, rename, unlink, writeFile, open } from "fs/promises"
import { readFileSync } from "fs"
import { Log } from "@/util/log"

const log = Log.create({ service: "cron-lock" })

export type LockInfo = {
  pid: number
  startedAt: number
  identity?: string
}

const PROC_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000)

export const getLockFilePath = (dir?: string) => join(dir ?? process.cwd(), ".mimocode", ".cron-lock")

const parseLockInfo = (raw: string): LockInfo | null => {
  const obj = Effect.runSync(
    Effect.try({ try: () => JSON.parse(raw) as Record<string, unknown>, catch: () => null }).pipe(
      Effect.orElseSucceed(() => null),
    ),
  )
  if (obj === null) return null
  if (typeof obj.pid !== "number") return null
  if (typeof obj.startedAt !== "number") return null
  const out: LockInfo = { pid: obj.pid, startedAt: obj.startedAt }
  if (typeof obj.identity === "string") out.identity = obj.identity
  return out
}

const readPidStartJiffies = (pid: number): number | null => {
  if (process.platform !== "linux") return null
  return Effect.runSync(
    Effect.try({
      try: () => {
        const raw = readFileSync(`/proc/${pid}/stat`, "utf-8")
        const lastParen = raw.lastIndexOf(")")
        if (lastParen < 0) return null as number | null
        const rest = raw.slice(lastParen + 2).split(/\s+/)
        const jiffies = parseInt(rest[19] ?? "", 10)
        return Number.isFinite(jiffies) ? jiffies : null
      },
      catch: () => null as number | null,
    }).pipe(Effect.orElseSucceed(() => null as number | null)),
  )
}

const readUptimeMs = (): number | null => {
  if (process.platform !== "linux") return null
  return Effect.runSync(
    Effect.try({
      try: () => {
        const raw = readFileSync("/proc/uptime", "utf-8")
        const first = raw.split(/\s+/)[0]
        const sec = parseFloat(first ?? "")
        return Number.isFinite(sec) ? Math.floor(sec * 1000) : null
      },
      catch: () => null as number | null,
    }).pipe(Effect.orElseSucceed(() => null as number | null)),
  )
}

let selfStartJiffies: number | null | undefined = undefined
const getSelfStartJiffies = (): number | null => {
  if (selfStartJiffies === undefined) selfStartJiffies = readPidStartJiffies(process.pid)
  return selfStartJiffies
}

let cachedMsPerJiffy: number | null | undefined = undefined
const getMsPerJiffy = (): number | null => {
  if (cachedMsPerJiffy !== undefined) return cachedMsPerJiffy
  const selfJiffies = getSelfStartJiffies()
  const uptimeMs = readUptimeMs()
  if (selfJiffies === null || uptimeMs === null || selfJiffies < 1) {
    cachedMsPerJiffy = null
    return null
  }
  const bootTimeMs = Date.now() - uptimeMs
  const selfStartMsAfterBoot = PROC_STARTED_AT - bootTimeMs
  if (selfStartMsAfterBoot < 1) {
    cachedMsPerJiffy = null
    return null
  }
  cachedMsPerJiffy = selfStartMsAfterBoot / selfJiffies
  return cachedMsPerJiffy
}

const isPidAlive = (pid: number, lockStartedAtMs: number): boolean => {
  try {
    process.kill(pid, 0)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    return code === "EPERM"
  }
  const otherJiffies = readPidStartJiffies(pid)
  const msPerJiffy = getMsPerJiffy()
  const uptimeMs = readUptimeMs()
  if (otherJiffies === null || msPerJiffy === null || uptimeMs === null) return true

  const bootTimeMs = Date.now() - uptimeMs
  const otherStartedAtMs = bootTimeMs + otherJiffies * msPerJiffy

  return Math.abs(otherStartedAtMs - lockStartedAtMs) <= 2_000
}

const writeLockExclusive = (path: string, info: LockInfo) =>
  Effect.tryPromise({
    try: async () => {
      const fh = await open(path, "wx").catch((e: NodeJS.ErrnoException) => {
        if (e.code === "EEXIST") return null
        throw e
      })
      if (fh === null) return "exists" as const
      await fh.writeFile(JSON.stringify(info))
      await fh.close()
      return "created" as const
    },
    catch: () => "error" as const,
  }).pipe(Effect.orElseSucceed(() => "error" as const))

const overwriteLock = (path: string, info: LockInfo) =>
  Effect.tryPromise({
    try: async () => {
      const tmp = `${path}.tmp.${process.pid}`
      await writeFile(tmp, JSON.stringify(info))
      await rename(tmp, path)
      const raw = await readFile(path, "utf-8").catch(() => "")
      const round = parseLockInfo(raw)
      return round !== null && round.pid === process.pid && round.startedAt === PROC_STARTED_AT
    },
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false))

const readLockFile = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf-8"),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null as string | null))

export const tryAcquireSchedulerLock = (opts?: { dir?: string; lockIdentity?: string }) =>
  Effect.gen(function* () {
    const path = getLockFilePath(opts?.dir)
    yield* Effect.tryPromise({
      try: () => mkdir(join(path, ".."), { recursive: true }),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined))

    const self: LockInfo = {
      pid: process.pid,
      startedAt: PROC_STARTED_AT,
      ...(opts?.lockIdentity ? { identity: opts.lockIdentity } : {}),
    }

    const createResult = yield* writeLockExclusive(path, self)
    if (createResult === "created") {
      log.debug("acquired (fresh)", { pid: self.pid })
      return true
    }
    if (createResult === "error") {
      log.debug("acquire failed (unexpected fs error)")
      return false
    }

    const raw = yield* readLockFile(path)
    if (raw === null) {
      const ow = yield* overwriteLock(path, self)
      return ow
    }

    const existing = parseLockInfo(raw)
    if (existing === null) {
      log.debug("malformed lock; taking over")
      const ow = yield* overwriteLock(path, self)
      return ow
    }

    if (existing.pid === process.pid && existing.startedAt === PROC_STARTED_AT) {
      log.debug("already owned by self (idempotent)")
      return true
    }

    if (!isPidAlive(existing.pid, existing.startedAt)) {
      log.debug("previous owner dead or recycled; taking over", { deadPid: existing.pid })
      const ow = yield* overwriteLock(path, self)
      return ow
    }

    log.debug("lock held by live process", { pid: existing.pid })
    return false
  })

export const releaseSchedulerLock = (opts?: { dir?: string }) =>
  Effect.gen(function* () {
    const path = getLockFilePath(opts?.dir)
    const raw = yield* readLockFile(path)
    if (raw === null) return
    const existing = parseLockInfo(raw)
    if (existing === null) return
    if (existing.pid !== process.pid) return
    yield* Effect.tryPromise({
      try: () => unlink(path),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined))
    log.debug("released", { pid: process.pid })
  })
