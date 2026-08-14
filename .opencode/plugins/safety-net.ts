import type { Plugin } from "@opencode-ai/plugin"
import { resolve as pathResolve, normalize } from "node:path"
import { realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"

const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "ksh", "dash", "fish", "csh", "tcsh"])

function tokenizeShell(command: string): string[][] {
  const segments: string[][] = []
  let current: string[] = []
  let i = 0
  while (i < command.length) {
    const ch = command[i]
    if (ch === " " || ch === "\t") { i++; continue }
    if (ch === "\n") { if (current.length) { segments.push(current); current = [] } i++; continue }
    if (ch === "#" && (i === 0 || command[i - 1] === " ")) break
    if (ch === "(" && command[i + 1] === ")") { i += 2; continue }
    const op = matchOp(command, i)
    if (op) { if (current.length) { segments.push(current); current = [] } i += op.length; continue }
    if (ch === '"' || ch === "'" || ch === "`") { const q = readQuote(command, i); current.push(q.val); i = q.end; continue }
    let tok = ""
    while (i < command.length) {
      const c = command[i]
      if (c === " " || c === "\t" || c === "\n") break
      if (c === "(" || c === ")") break
      if (c === '"' || c === "'" || c === "`") { const q = readQuote(command, i); tok += q.val; i = q.end; continue }
      const op2 = matchOp(command, i); if (op2 && tok) break; if (op2) break
      tok += c; i++
    }
    if (tok) current.push(tok)
  }
  if (current.length) segments.push(current)
  return segments
}

function matchOp(cmd: string, i: number): string | null {
  if (cmd[i] === "|") return cmd[i + 1] === "|" ? "||" : cmd[i + 1] === "&" ? "|&" : "|"
  if (cmd[i] === "&") return cmd[i + 1] === "&" ? "&&" : "&"
  if (cmd[i] === ";") return ";"
  return null
}

function readQuote(cmd: string, start: number): { val: string; end: number } {
  const q = cmd[start]; let val = "", i = start + 1, esc = false
  while (i < cmd.length) {
    const c = cmd[i]
    if (esc) { val += c; esc = false; i++; continue }
    if (c === "\\") { esc = true; i++; continue }
    if (c === q) return { val, end: i + 1 }
    val += c; i++
  }
  return { val: q + val, end: i }
}

const getBasename = (t: string) => t.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") ?? t

function matchLong(token: string, opt: string): boolean {
  const n = token.split("=", 1)[0] ?? token
  return n.length >= 4 && opt.startsWith(n) && n.startsWith("--") && n.slice(2).length >= 2
}

function shortOpts(tokens: readonly string[], withVal?: ReadonlySet<string>): Set<string> {
  const r = new Set<string>(); let pastDD = false
  for (const t of tokens) {
    if (t === "--") { pastDD = true; continue }; if (pastDD) continue
    if (t.startsWith("-") && !t.startsWith("--") && t.length > 1) {
      for (let j = 1; j < t.length; j++) {
        const c = t[j]; if (!c || !/[a-zA-Z]/.test(c)) break
        const o = `-${c}`; r.add(o); if (withVal?.has(o)) break
      }
    }
  }
  return r
}

function splitDD(tokens: readonly string[]) {
  const i = tokens.indexOf("--")
  return i === -1 ? { idx: -1, before: tokens, after: [] as readonly string[] } : { idx: i, before: tokens.slice(0, i), after: tokens.slice(i + 1) }
}

function gitSubcmd(tokens: readonly string[]): { sub: string | null; rest: string[] } {
  if (!tokens.length) return { sub: null, rest: [] }
  if (getBasename(tokens[0] ?? "").toLowerCase() !== "git") return { sub: null, rest: [] }
  let i = 1
  while (i < tokens.length) {
    const t = tokens[i]; if (!t) break
    if (t === "--") { const n = tokens[i + 1]; return n && !n.startsWith("-") ? { sub: n, rest: tokens.slice(i + 2) } : { sub: null, rest: tokens.slice(i + 1) } }
    if (t.startsWith("-")) { i++; continue }
    return { sub: t, rest: tokens.slice(i + 1) }
  }
  return { sub: null, rest: [] }
}

const CKOUT_SW = new Set(["-b", "-B", "-U"])
const SWITCH_SW = new Set(["-c", "-C"])

function analyzeGit(tokens: readonly string[]): string | null {
  const { sub, rest } = gitSubcmd(tokens)
  if (!sub) return null
  const { before } = splitDD(rest)
  const so = shortOpts(before)

  switch (sub.toLowerCase()) {
    case "checkout": {
      if (before.some(t => matchLong(t, "--force")) || so.has("-f"))
        return "git checkout --force discards uncommitted changes. Use 'git stash' first."
      for (const t of rest) {
        if (t === "-b" || t === "-B" || t === "--orphan") return null
        if (matchLong(t, "--pathspec-from-file"))
          return "git checkout --pathspec-from-file can overwrite multiple files. Use 'git stash' first."
      }
      const { idx } = splitDD(rest)
      if (idx !== -1) return before.some(t => !t.startsWith("-"))
        ? "git checkout <ref> -- <path> overwrites working tree. Use 'git stash' first."
        : "git checkout -- discards uncommitted changes. Use 'git stash' first."
      return null
    }
    case "switch":
      if (before.some(t => matchLong(t, "--discard-changes")))
        return "git switch --discard-changes discards uncommitted changes. Use 'git stash' first."
      return before.some(t => matchLong(t, "--force")) || shortOpts(before, SWITCH_SW).has("-f")
        ? "git switch --force discards uncommitted changes. Use 'git stash' first." : null
    case "restore": {
      let hasStaged = false
      for (const t of rest) {
        if (t === "--help" || t === "--version") return null
        if (t === "--worktree" || t === "-W") return "git restore --worktree explicitly discards working tree changes. Use 'git stash' first."
        if (t === "--staged" || t === "-S") hasStaged = true
      }
      return hasStaged ? null : "git restore discards uncommitted changes. Use 'git stash' first, or use --staged to only unstage."
    }
    case "reset": {
      let r: string | null = null
      for (const t of rest) {
        if (matchLong(t, "--hard")) { r = "git reset --hard destroys all uncommitted changes permanently. Use 'git stash' first."; break }
        if (matchLong(t, "--merge")) { r = "git reset --merge can lose uncommitted changes. Use 'git stash' first."; break }
      }
      return r
    }
    case "clean":
      for (const t of rest) if (t === "-n" || matchLong(t, "--dry-run")) return null
      return rest.some(t => matchLong(t, "--force")) || shortOpts(rest.filter(t => t !== "--")).has("-f")
        ? "git clean -f removes untracked files permanently. Use 'git clean -n' to preview first." : null
    case "push":
      return rest.some(t => matchLong(t, "--force")) || shortOpts(rest.filter(t => t !== "--")).has("-f")
        ? "git push --force destroys remote history. Use --force-with-lease for safer force push." : null
    case "branch": {
      const hasDel = so.has("-D") || so.has("-d") || before.some(t => matchLong(t, "--delete"))
      const hasF = so.has("-D") || so.has("-f") || before.some(t => matchLong(t, "--force"))
      return hasDel && hasF ? "git branch -D force-deletes without merge check. Use -d for safe delete." : null
    }
    case "rebase": return before.some(t => matchLong(t, "--abort"))
      ? "git rebase --abort discards rebase conflict resolutions. Use 'git status' first." : null
    case "merge": return before.some(t => matchLong(t, "--abort"))
      ? "git merge --abort discards merge conflict resolutions. Use 'git status' first." : null
    case "tag": return so.has("-d") || before.some(t => matchLong(t, "--delete"))
      ? "git tag -d permanently deletes tags." : null
    case "reflog": return rest[0] === "delete" ? "git reflog delete removes recovery history." : null
    case "stash":
      for (const t of rest) {
        if (t === "drop") return "git stash drop permanently deletes stashed changes. Consider 'git stash list' first."
        if (t === "clear") return "git stash clear deletes ALL stashed changes permanently."
      }
      return null
    case "worktree":
      return before.includes("remove") && (before.some(t => matchLong(t, "--force")) || so.has("-f"))
        ? "git worktree remove --force can delete uncommitted changes. Remove --force flag." : null
    default: return null
  }
}

function hasRF(tokens: readonly string[]): boolean {
  let r = false, f = false
  for (const t of tokens) {
    if (t === "--") break
    if (t === "-r" || t === "-R" || t === "--recursive") r = true
    else if (t === "-f" || t === "--force") f = true
    else if (t.startsWith("-") && !t.startsWith("--")) { if (t.includes("r") || t.includes("R")) r = true; if (t.includes("f")) f = true }
  }
  return r && f
}

const normPath = (p: string) => { let n = normalize(p); return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n }

function analyzeRm(tokens: readonly string[], cwd?: string): string | null {
  if (!hasRF(tokens)) return null
  const home = process.env.HOME ?? homedir()
  const targets: string[] = []
  let pastDD = false
  for (let i = 1; i < tokens.length; i++) { const t = tokens[i]; if (!t) continue; if (t === "--") { pastDD = true; continue }; if (pastDD || !t.startsWith("-")) targets.push(t) }

  for (const raw of targets) {
    const t = raw.trim()
    if (t === "/" || t === "/*" || t === "~" || t === "~/" || t === "~/*" || t.startsWith("~/") || t === "$HOME" || t === "$HOME/" || t === "$HOME/*" || t === "${HOME}" || t === "${HOME}/" || t === "${HOME}/*")
      return "rm -rf targeting root or home directory is extremely dangerous and always blocked."
    if (t.split(/[\\/]+/).includes("..")) { /* not temp */ }
    else if (t === "/tmp" || t.startsWith("/tmp/") || t === "/var/tmp" || t.startsWith("/var/tmp/")) continue
    else { const sysTmp = normPath(tmpdir()), n = normPath(t); if (n.startsWith(sysTmp + "/") || n === sysTmp) continue }
    if (t === "$TMPDIR" || t.startsWith("$TMPDIR/") || t === "${TMPDIR}" || t.startsWith("${TMPDIR}/")) continue
    if (t.includes("$") || t.includes("`"))
      return "rm -rf target contains shell variables that cannot be verified safely. Use literal paths within cwd, /tmp, /var/tmp, or $TMPDIR."
    if (cwd) {
      try {
        const h = cwd; let isHome = false
        try { isHome = normPath(h) === normPath(home) } catch { /* */ }
        if (isHome) return "rm -rf in home directory is dangerous. Change to a project directory first."
        const resolved = pathResolve(cwd, t), real = normPath(realpathSync(cwd)), nr = normPath(resolved)
        if (nr === real || nr.startsWith(real + "/")) continue
      } catch { /* fall through */ }
    }
    return "rm -rf outside cwd is blocked. Use explicit paths within the current directory, or delete manually."
  }
  return null
}

const FIND_VAL = new Set(["-amin", "-anewer", "-atime", "-cmin", "-cnewer", "-ctime", "-exec", "-execdir", "-fprint", "-fprintf", "-fstype", "-gid", "-group", "-ilname", "-iname", "-inum", "-ipath", "-iregex", "-links", "-lname", "-mmin", "-mtime", "-name", "-newer", "-newerXY", "-path", "-perm", "-printf", "-regex", "-samefile", "-size", "-type", "-uid", "-used", "-user", "-wholename", "-xtype"])

function analyzeFind(tokens: readonly string[]): string | null {
  const rest = tokens.slice(1)
  let inExec = false, execD = 0
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]; if (!t) continue
    if (t === "-exec" || t === "-execdir") { inExec = true; execD++; continue }
    if (inExec && (t === ";" || t === "+")) { if (--execD === 0) inExec = false; continue }
    if (inExec) continue
    if (FIND_VAL.has(t) || /^-newer[A-Za-z]{2}$/.test(t)) { i++; continue }
    if (t === "-delete") return "find -delete permanently removes files. Use -print first to preview."
  }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "-exec" || rest[i] === "-execdir") {
      const ex = rest.slice(i + 1), semi = ex.indexOf(";"), plus = ex.indexOf("+")
      const end = semi !== -1 && plus !== -1 ? Math.min(semi, plus) : semi !== -1 ? semi : plus !== -1 ? plus : ex.length
      const cmd = ex.slice(0, end), head = getBasename(cmd[0] ?? "").toLowerCase()
      if (head === "rm" && hasRF(cmd)) return "find -exec rm -rf is dangerous. Use explicit file list instead."
    }
  }
  return null
}

function dangerousText(text: string): string | null {
  const t = text.toLowerCase(), s = t.trimStart(), echo = s.startsWith("echo ") || s.startsWith("rg ")
  const pats: Array<{ rx: RegExp; r: string; skip?: boolean }> = [
    { rx: /\brm\b[^\S\n]+(?=(?:(?!--)[^\s;&|]+[^\S\n]+)*-(?!-)[^\s;&|]*r[^\s;&|]*)[^\S\n]+(?=(?:(?!--)[^\s;&|]+[^\S\n]+)*-(?!-)[^\s;&|]*f[^\s;&|]*)/, r: "rm -rf" },
    { rx: /\bgit\s+reset\s+--hard\b/, r: "git reset --hard" },
    { rx: /\bgit\s+reset\s+--merge\b/, r: "git reset --merge" },
    { rx: /\bgit\s+clean\s+(-[^\s]*f|--force)\b/, r: "git clean -f" },
    { rx: /\bgit\s+push\b[^\n;|&]*(-f\b|--force\b)(?!-with-lease)/, r: "git push --force (use --force-with-lease instead)" },
    { rx: /\bgit\s+stash\s+(drop|clear)\b/, r: "git stash drop/clear" },
    { rx: /\bgit\s+checkout\s+--\s/, r: "git checkout --" },
    { rx: /\bgit\s+restore\b(?!.*--(staged|help))/, r: "git restore (without --staged)" },
    { rx: /\bfind\b[^\n;|&]*\s-delete\b/, r: "find -delete", skip: true },
    { rx: /\bdd\b[^\n;&|]*\bof=\/dev\/[^\s'"]+/, r: "dd to device" },
    { rx: /\bmkfs(?:\.[A-Za-z0-9_-]+)?\s+\/dev\/[^\s'"]+/, r: "mkfs on device" },
    { rx: /\bshred\b\s+/, r: "shred" },
  ]
  for (const { rx, r, skip } of pats) { if (skip && echo) continue; if (rx.test(t)) return r }
  return null
}

function analyzeCommand(command: string, cwd?: string, depth = 0): { reason: string; segment: string } | null {
  if (depth >= 10) return { reason: "Command exceeds maximum recursion depth.", segment: command }
  for (const tokens of tokenizeShell(command)) {
    if (!tokens.length) continue
    if (tokens.length === 1 && tokens[0]?.includes(" ")) {
      const r = dangerousText(tokens[0]); if (r) return { reason: r, segment: tokens.join(" ") }; continue
    }
    const r = analyzeSegment(tokens, cwd, depth); if (r) return r
  }
  return null
}

function analyzeSegment(tokens: readonly string[], cwd: string | undefined, depth: number): { reason: string; segment: string } | null {
  if (!tokens.length) return null
  const { stripped, effectiveCwd: ec } = stripEnvWrappers(tokens, cwd)
  if (!stripped.length) return null
  const head = stripped[0]; if (!head) return null
  const nh = getBasename(head).toLowerCase(), seg = stripped.join(" ")

  if (SHELL_WRAPPERS.has(nh)) {
    const dc = extractDashC(stripped)
    if (dc) { const n = analyzeCommand(dc, ec, depth + 1); return n ? { reason: n.reason, segment: seg } : null }
  }
  if (nh === "git") { const r = analyzeGit(stripped); return r ? { reason: r, segment: seg } : null }
  if (nh === "rm") { const r = analyzeRm(stripped, ec); return r ? { reason: r, segment: seg } : null }
  if (nh === "find") { const r = analyzeFind(stripped); return r ? { reason: r, segment: seg } : null }
  if (nh === "busybox" && stripped.length > 1) { const r = analyzeSegment(stripped.slice(1), ec, depth); return r ? { reason: r.reason, segment: seg } : null }
  return null
}

const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

function stripEnvWrappers(tokens: readonly string[], cwd: string | undefined): { stripped: string[]; effectiveCwd: string | undefined } {
  let i = 0, ec = cwd
  while (i < tokens.length) { const t = tokens[i]; if (!t || ENV_RE.test(t)) { i++; continue }; break }
  let stripped = tokens.slice(i)
  for (let iter = 0; iter < 20; iter++) {
    const joined = stripped.join(" ")
    let j = 0; while (j < stripped.length) { const t = stripped[j]; if (!t || ENV_RE.test(t)) { j++; continue }; break }
    stripped = stripped.slice(j)
    if (!stripped.length) break
    const h = stripped[0]?.toLowerCase()
    if (h !== "sudo" && h !== "env" && h !== "command") break
    if (h === "sudo") { const r = stripSudo(stripped); stripped = r.t; if (r.c !== undefined) ec = r.c }
    else if (h === "env") { const r = stripEnvW(stripped); stripped = r.t; if (r.c !== undefined) ec = r.c }
    else stripped = stripCmdW(stripped)
    if (stripped.join(" ") === joined) break
  }
  return { stripped, effectiveCwd: ec }
}

function extractDashC(tokens: readonly string[]): string | null {
  for (let i = 0; i < tokens.length; i++) { const t = tokens[i]; if (t === "-c" && i + 1 < tokens.length) return tokens[i + 1] ?? null; if (t?.startsWith("-c") && t.length > 2) return t.slice(2) }
  return null
}

function stripSudo(tokens: string[]): { t: string[]; c?: string } {
  let i = 1, c: string | undefined
  while (i < tokens.length) { const t = tokens[i]; if (!t) break; if (t === "--") return { t: tokens.slice(i + 1), c }; if (!t.startsWith("-")) break; if (t === "-D" || t === "--chdir") { c = tokens[i + 1]; i += 2; continue } if (t.startsWith("--chdir=")) { c = t.slice(9); i++; continue } if (t === "-i" || t === "--login") { c = undefined; i++; continue }; i++ }
  return { t: tokens.slice(i), c }
}

function stripEnvW(tokens: string[]): { t: string[]; c?: string } {
  let i = 1, c: string | undefined
  while (i < tokens.length) { const t = tokens[i]; if (!t) break; if (t === "--") return { t: tokens.slice(i + 1), c }; if (t.startsWith("-")) { i++; continue }; if (t.includes("=")) { i++; continue }; break }
  return { t: tokens.slice(i), c }
}

function stripCmdW(tokens: string[]): string[] {
  let i = 1
  while (i < tokens.length) { const t = tokens[i]; if (!t) break; if (t === "--") return tokens.slice(i + 1); if (t.startsWith("-") && !t.startsWith("--") && t.length > 1) { i++; continue }; break }
  return tokens.slice(i)
}

export const SafetyNetPlugin: Plugin = async ({ directory }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const args = output.args as Record<string, any> | undefined
      const command = args?.command
      if (typeof command !== "string" || !command.trim()) return
      const result = analyzeCommand(command, directory)
      if (result) {
        throw new Error(`[Safety Net] Blocked: ${result.reason}\nSegment: ${result.segment}`)
      }
    },
  }
}

export default SafetyNetPlugin
