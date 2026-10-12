import { atom, read, update } from 'claude-code'
import type { CommandPresentation, EngineInterface as Engine, Register, RenderSurface } from 'claude-code'

import type { FetchRequest, FetchResponse, TrackedPr } from '../types'
import { answerOf, asFetchResponse, batchQuery, dueKeys, holdOf, parseBatch, parseState, recordBatch, repoFromRemotes } from './fetcher.ts'

export { summarise } from './fetcher.ts'

const PANE = 'pr-tracker'
const POLL_MS = 60_000
/** How stale an open PR with no running checks may get before it is fetched again. */
const QUIET_POLL_MS = 5 * 60_000
const MAX_BACKOFF_MS = 60 * 60_000
/** With the pane closed and no prompt or Bash call for IDLE_MS, healthy PRs poll IDLE_FACTOR times slower. */
const IDLE_MS = 10 * 60_000
const IDLE_FACTOR = 5
/** Newly named PRs wait this long so the ones named close together share one fetch. */
const GATHER_MS = 1_000
/** A PR this close to due counts as due, so a poll tick landing just short of it is not skipped. */
const TICK_SLACK_MS = 5_000
/** The terminal width from which the fullscreen layout docks a pane beside the transcript. */
const DOCK_COLUMNS = 110
/** Below this many body columns the pane drops its cards and header for one line per PR. */
const MINIMAL_COLUMNS = 48

const prs = atom({ plugin: 'pr-tracker', key: 'prs' } as const, [] as TrackedPr[])
const chipOffset = atom({ plugin: 'pr-tracker', key: 'chipOffset' } as const, 0)

type Ref = { repo?: string; number: number }

const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g
const PR_VERB =
  /\bgh\s+pr\s+(?:view|checks|merge|ready|edit|comment|diff|review|reopen|close)\s+#?(\d+)\b/g
const PR_CREATE = /\bgh\s+pr\s+create\b/
const REPO_FLAG = /(?:\s-R|\s--repo)[\s=]+([\w.-]+\/[\w.-]+)/

/** The PRs a shell command names: pull URLs, and numbers given to `gh pr <verb>`. */
export function refsInCommand(command: string): Ref[] {
  const repo = REPO_FLAG.exec(command)?.[1]
  const refs: Ref[] = []
  for (const m of command.matchAll(PR_URL)) refs.push({ repo: m[1], number: Number(m[2]) })
  for (const m of command.matchAll(PR_VERB)) refs.push({ repo, number: Number(m[1]) })
  return refs
}

/** A `/prs add` argument: `123`, `#123`, `owner/name#123` or a pull URL. */
export function refFromArg(arg: string): Ref | undefined {
  const url = [...arg.matchAll(PR_URL)][0]
  if (url) return { repo: url[1], number: Number(url[2]) }
  const m = /^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/.exec(arg.trim())
  return m ? { repo: m[1], number: Number(m[2]) } : undefined
}

let cwdRepo: string | undefined
let refreshing = false
let requestsPerHour = 60
/** The daemon command when it answered `ping` at session start; otherwise the built-in coordinator fetches. */
let daemonCommand: string | undefined
/** This session's name on the shared lock. */
const lockOwner = Math.random().toString(36).slice(2)
/** Set while the budget or GitHub holds fetches back. */
let limited: { until: number; reason: string } | undefined
let lastActivity = 0
/** Whether a clickable summary under the prompt stands in for the status line. */
let summaryInHint = false
/** The terminal's layout as last seen, for presses that come with no `presentation`. */
let terminalLayout: CommandPresentation | undefined

/** The cwd's GitHub repo as gh resolves it, from git's own config, which costs no API request. */
async function resolveRepo($: Engine, repo?: string): Promise<string | undefined> {
  if (repo) return repo
  if (cwdRepo) return cwdRepo
  try {
    const r = await $.process.run(['git', 'config', '--get-regexp', '^remote\\.'], { timeoutMs: 5_000 })
    if (r.exitCode === 0) cwdRepo = repoFromRemotes(r.stdout)
  } catch {
    cwdRepo = undefined
  }
  return cwdRepo
}

function blank(repo: string, number: number): TrackedPr {
  return {
    key: `${repo}#${number}`, repo, number, title: '', url: `https://github.com/${repo}/pull/${number}`,
    state: 'UNKNOWN', isDraft: false, mergeable: 'UNKNOWN', review: '',
    pass: 0, fail: 0, pending: 0, skipped: 0, failing: [], running: [], checkedAt: 0,
  }
}

/**
 * How stale a PR may be before it is due: undefined once a merged or closed PR has been fetched.
 * A PR whose fetches keep failing backs off from POLL_MS, doubling up to MAX_BACKOFF_MS; while
 * `idle`, healthy PRs wait IDLE_FACTOR times longer.
 */
export function maxAgeMs(p: TrackedPr, idle = false): number | undefined {
  if (p.failures && p.state === 'UNKNOWN') return Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** (p.failures - 1))
  if (p.checkedAt === 0 || p.state === 'UNKNOWN') return POLL_MS
  if (p.state === 'MERGED' || p.state === 'CLOSED') return undefined
  return (p.pending > 0 ? POLL_MS : QUIET_POLL_MS) * (idle ? IDLE_FACTOR : 1)
}

const GH_TIMEOUT_MS = 30_000
/** Outlasts a gh call, so a live holder never loses the lock mid-fetch. */
const LEASE_MS = 45_000

async function cacheDir($: Engine): Promise<string> {
  const own = await $.env.get('CLAUDE_PR_TRACKER_DIR')
  if (own) return own
  const local = await $.env.get('LOCALAPPDATA')
  if (local) return `${local}/claude-pr-tracker`
  const xdg = await $.env.get('XDG_CACHE_HOME')
  if (xdg) return `${xdg}/claude-pr-tracker`
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  return `${home}/.cache/claude-pr-tracker`
}

async function readJson($: Engine, path: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return undefined
  }
}

/** The shared state file: empty when missing, `corrupt` when it exists but does not parse (mid-write). */
async function readShared($: Engine, path: string): Promise<ReturnType<typeof parseState> | 'corrupt'> {
  let text: string
  try {
    text = await $.fs.read(path)
  } catch {
    return parseState(undefined)
  }
  try {
    return parseState(JSON.parse(text))
  } catch {
    return 'corrupt'
  }
}

let coordinatorTail: Promise<unknown> = Promise.resolve()

/**
 * The built-in coordinator: every session on the machine shares one request budget and one cache of
 * PR results through files in the cache dir. Only `$.fs` and `gh` are used, so it runs on Linux,
 * macOS and Windows alike. Within a session fetches queue; across sessions the lock is a lease
 * written then read back, not an atomic primitive, so two sessions racing for it can both fetch.
 * Each applies its batch to the state it re-reads just before writing, so a race costs a request,
 * and a state file caught mid-write is never taken for an empty one.
 */
function viaCoordinator($: Engine, request: FetchRequest): Promise<FetchResponse> {
  const run = coordinatorTail.then(() => coordinate($, request))
  coordinatorTail = run.catch(() => undefined)
  return run
}

async function coordinate($: Engine, request: FetchRequest): Promise<FetchResponse> {
  const dir = await cacheDir($)
  const statePath = `${dir}/state.json`
  const lockPath = `${dir}/lock.json`
  const now = await $.clock.now()
  const first = await readShared($, statePath)
  let state = first === 'corrupt' ? parseState(undefined) : first
  const hold = () => holdOf(state, now, requestsPerHour)
  if (first === 'corrupt' || dueKeys(state, request, now).length === 0 || hold().limitedUntil) {
    return answerOf(state, request, hold())
  }
  const lock = (await readJson($, lockPath)) as { owner?: string; until?: number } | undefined
  if (lock?.owner && lock.owner !== lockOwner && (lock.until ?? 0) > now) return answerOf(state, request, hold())
  await $.fs.write(lockPath, JSON.stringify({ owner: lockOwner, until: now + LEASE_MS }))
  if (((await readJson($, lockPath)) as { owner?: string } | undefined)?.owner !== lockOwner) {
    return answerOf(state, request, hold())
  }
  try {
    const locked = await readShared($, statePath)
    if (locked === 'corrupt') return answerOf(state, request, hold())
    state = locked
    const keys = dueKeys(state, request, now)
    if (keys.length === 0 || hold().limitedUntil) return answerOf(state, request, hold())
    let ran
    try {
      ran = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${batchQuery(keys)}`], { timeoutMs: GH_TIMEOUT_MS })
    } catch (err) {
      ran = { exitCode: 1, stdout: '', stderr: String(err).slice(0, 120) }
    }
    const latest = await readShared($, statePath)
    state = recordBatch(latest === 'corrupt' ? state : latest, parseBatch(ran, keys, now), now)
    await $.fs.write(statePath, JSON.stringify(state))
    return answerOf(state, request, hold())
  } finally {
    if (((await readJson($, lockPath)) as { owner?: string } | undefined)?.owner === lockOwner) {
      await $.fs.write(lockPath, JSON.stringify({ owner: '', until: 0 }))
    }
  }
}

/** Whether `command ping` answers, so a daemon takes the fetching. */
async function daemonAnswers($: Engine, command: string): Promise<boolean> {
  if (!command) return false
  try {
    return (await $.process.run([command, 'ping'], { timeoutMs: 2_000 })).exitCode === 0
  } catch {
    return false
  }
}

/** The daemon's answer to `request` on `command fetch`, or undefined when it fails. */
async function viaDaemon($: Engine, command: string, request: FetchRequest): Promise<FetchResponse | undefined> {
  try {
    const r = await $.process.run([command, 'fetch'], { stdin: JSON.stringify(request), timeoutMs: GH_TIMEOUT_MS + 5_000 })
    return r.exitCode === 0 ? asFetchResponse(JSON.parse(r.stdout)) : undefined
  } catch {
    return undefined
  }
}

function apply(list: TrackedPr[], response: FetchResponse): TrackedPr[] {
  return list.map(p => {
    const got = response.prs[p.key]
    if (!got || (p.checkedAt !== 0 && got.fetchedAt <= p.checkedAt)) return p
    return got.data
      ? { ...p, ...got.data, url: got.data.url || p.url, checkedAt: got.fetchedAt, error: undefined, failures: 0 }
      : { ...p, checkedAt: got.fetchedAt, error: got.error, failures: (p.failures ?? 0) + (got.transient ? 0 : 1) }
  })
}

let gathering = false
const gathered = new Set<string>()

async function track($: Engine, refs: Ref[]) {
  const added: TrackedPr[] = []
  for (const ref of refs) {
    const repo = await resolveRepo($, ref.repo)
    if (!repo || !(ref.number > 0)) continue
    const key = `${repo}#${ref.number}`
    if ((await read($, prs)).some(p => p.key === key) || added.some(p => p.key === key)) continue
    added.push(blank(repo, ref.number))
  }
  if (added.length === 0) return
  await update($, prs, list => [...list, ...added])
  for (const p of added) gathered.add(p.key)
  if (gathering) return
  gathering = true
  try {
    await $.clock.sleep(GATHER_MS)
  } finally {
    gathering = false
  }
  const keys = [...gathered]
  gathered.clear()
  await refresh($, { keys })
}

async function isIdle($: Engine, now: number) {
  // A hot reload starts the module afresh without a session.start, so no activity yet means just now.
  if (lastActivity === 0) lastActivity = now
  if (now - lastActivity < IDLE_MS) return false
  try {
    return !(await isPaneOpen($))
  } catch {
    return true
  }
}

/**
 * Fetches what is due through the fetcher: by default every tracked PR past its maxAgeMs; `keys`
 * narrows that; `force` asks for those PRs fresh, still within the budget.
 */
async function refresh($: Engine, { keys, force }: { keys?: string[]; force?: boolean } = {}) {
  if (!keys && !force && refreshing) return
  if (!keys && !force) refreshing = true
  try {
    const idle = await isIdle($, await $.clock.now())
    const request = (await read($, prs)).flatMap(p => {
      const age = force ? 0 : maxAgeMs(p, idle)
      if (age === undefined || (keys && !keys.includes(p.key))) return []
      return [{ key: p.key, maxAgeMs: Math.max(0, age - TICK_SLACK_MS) }]
    })
    if (request.length === 0) return
    const ask: FetchRequest = { version: 1, requestsPerHour, prs: request }
    let response: FetchResponse | undefined
    if (daemonCommand) response = await viaDaemon($, daemonCommand, ask)
    response ??= await viaCoordinator($, ask)
    limited = response.limitedUntil ? { until: response.limitedUntil, reason: response.reason ?? '' } : undefined
    if (force && limited) $.ui.toast(`gh is held back (${limited.reason}) for ${until(await $.clock.now(), limited.until)}.`)
    await update($, prs, list => apply(list, response))
    await showStatus($)
  } finally {
    if (!keys && !force) refreshing = false
  }
}

/** `PRs 3 open · 1 failing · 2 running` (`short`: `PRs 3 · 1✗ · 2◐`), or undefined with nothing tracked. */
function summary(list: readonly TrackedPr[], short = false): string | undefined {
  if (list.length === 0) return undefined
  const open = list.filter(p => p.state === 'OPEN')
  const failing = open.filter(p => p.fail > 0).length
  const running = open.filter(p => p.pending > 0).length
  const parts = [short ? `PRs ${open.length}` : `PRs ${open.length} open`]
  if (failing) parts.push(short ? `${failing}✗` : `${failing} failing`)
  if (running) parts.push(short ? `${running}◐` : `${running} running`)
  return parts.join(' · ')
}

async function showStatus($: Engine) {
  return $.ui.status(summaryInHint ? undefined : summary(await read($, prs)))
}

async function untrack($: Engine, drop: (p: TrackedPr) => boolean) {
  await update($, prs, list => list.filter(p => !drop(p)))
  await showStatus($)
}

type Health = 'failing' | 'conflict' | 'running' | 'green' | 'draft' | 'quiet' | 'merged' | 'closed'

/** What a PR most needs looked at, in the order the pane sorts by. */
export function health(p: TrackedPr): Health {
  if (p.state === 'MERGED') return 'merged'
  if (p.state === 'CLOSED') return 'closed'
  if (p.fail > 0) return 'failing'
  if (p.mergeable === 'CONFLICTING') return 'conflict'
  if (p.pending > 0) return 'running'
  if (p.isDraft) return 'draft'
  return p.pass > 0 ? 'green' : 'quiet'
}

const ORDER: Health[] = ['failing', 'conflict', 'running', 'green', 'draft', 'quiet', 'merged', 'closed']
const ACCENT: Record<Health, string> = {
  failing: 'error', conflict: 'error', running: 'warning', green: 'success',
  draft: 'subtle', quiet: 'inactive', merged: 'merged', closed: 'inactive',
}
const GLYPH: Record<Health, string> = {
  failing: '✗', conflict: '⚠', running: '◐', green: '✓', draft: '◌', quiet: '○', merged: '⇡', closed: '⊘',
}
const REVIEW: Record<string, [string, string]> = {
  APPROVED: ['✓ approved', 'success'],
  CHANGES_REQUESTED: ['± changes requested', 'error'],
  REVIEW_REQUIRED: ['◔ review required', 'warning'],
}

/** A bar of `width` cells split pass / fail / running / skipped, each segment at least a cell. */
export function ciBar(p: TrackedPr, width: number): { text: string; color: string }[] {
  const parts: [number, string][] = [
    [p.pass, 'success'], [p.fail, 'error'], [p.pending, 'warning'], [p.skipped, 'inactive'],
  ]
  const total = parts.reduce((n, [c]) => n + c, 0)
  if (total === 0) return []
  let cells = parts.map(([c]) => (c > 0 ? Math.max(1, Math.round((c / total) * width)) : 0))
  while (cells.reduce((a, b) => a + b, 0) > width) {
    const i = cells.indexOf(Math.max(...cells))
    cells[i] = (cells[i] ?? 1) - 1
  }
  return parts
    .map(([, color], i) => ({ text: (i === 3 ? '░' : '█').repeat(cells[i] ?? 0), color }))
    .filter(seg => seg.text.length > 0)
}

/** Rows a full card takes: border, title, status, CI, its check lines, any error, footer. */
export function cardRows(p: TrackedPr): number {
  const checks =
    p.failing.length > 0
      ? Math.min(3, p.failing.length) + (p.failing.length > 3 ? 1 : 0)
      : p.running.length > 0
        ? 1
        : 0
  return 2 + 3 + checks + (p.error ? 1 : 0) + 1
}

export type Layout = {
  /** Keys of the PRs drawn as full cards; every other open PR is one line. */
  full: Set<string>
  /** Settled PRs listed one per line, or folded into one summary line. */
  doneLines: 'list' | 'summary' | 'none'
  /** Rows the drawing takes; past `rows` the pane scrolls. */
  height: number
}

/** The most urgent PRs drawn as full cards however short the pane, the rest scrolling below. */
export const MIN_CARDS = 2

/**
 * Lays the pane out in `rows`: every open PR is at least one line and never dropped, the most
 * urgent are widened into cards while rows remain (at least MIN_CARDS of them), and a drawing
 * taller than the pane is left to the pane's own scrolling.
 */
export function plan(live: TrackedPr[], settled: TrackedPr[], rows: number): Layout {
  const HEADER = 3
  let budget = rows - HEADER - live.length
  let doneLines: Layout['doneLines'] = 'none'
  if (settled.length > 0) {
    doneLines = budget >= 2 + settled.length ? 'list' : 'summary'
    budget -= doneLines === 'list' ? 2 + settled.length : 2
  }
  const full = new Set<string>()
  let height = rows - budget
  for (const [i, p] of live.entries()) {
    const extra = cardRows(p) - 1
    if (i < MIN_CARDS || extra <= budget) {
      full.add(p.key)
      budget -= extra
      height += extra
    }
  }
  return { full, doneLines, height }
}

function until(now: number, at: number) {
  const m = Math.max(1, Math.ceil((at - now) / 60_000))
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`
}

function ago(now: number, at: number) {
  if (!at) return 'never'
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

/**
 * Whether the pane may open. Panes are session-wide and a narrow fullscreen terminal closes the pane
 * rather than seat it inline, so an attached terminal decides: classic (main screen) mode opens it
 * inline above the prompt, fullscreen docks it on the right from DOCK_COLUMNS wide. Without one, an
 * attached desktop or IDE docks it. `at` describes the terminal alone.
 */
export function opens(at: CommandPresentation | undefined, surfaces: readonly RenderSurface[]): boolean {
  if (surfaces.includes('terminal')) return at !== undefined && (!at.isFullscreen || at.columns >= DOCK_COLUMNS)
  return surfaces.some(s => s === 'desktop' || s === 'vscode')
}

/** Why the pane will not open, or undefined when it opens. */
async function openRefusal($: Engine, at: CommandPresentation | undefined): Promise<string | undefined> {
  if (opens(at, await $.session.surfaces())) return undefined
  const now = at ? `now ${at.columns}` : 'the terminal has not said how wide it is'
  return `In fullscreen the PR pane docks on the right only, from ${DOCK_COLUMNS} columns (${now}). The status line still tracks.`
}

/** Cells of the inline row outside the chips: title, both scroll buttons with counts, close. */
const INLINE_CHROME = 28

/** Cells one PR chip takes inline: glyph, `#n`, CI tally, untrack button and the gap after it. */
function chipWidth(p: TrackedPr): number {
  const ci = p.pass + p.fail + p.pending + p.skipped
  const tally = ci > 0 ? ` ${p.pass + p.fail + p.skipped}/${ci}` : ''
  return 2 + 1 + String(p.number).length + tally.length + 2 + 2
}

/**
 * The chips shown from `offset` (clamped to the list) in `room` cells: always one, then whole chips
 * while they fit; at the end of the list it backs up over earlier chips that still fit.
 */
export function chipWindow(widths: readonly number[], offset: number, room: number) {
  let start = Math.max(0, Math.min(offset, widths.length - 1))
  let end = start
  let used = 0
  while (end < widths.length && (end === start || used + (widths[end] ?? 0) <= room)) {
    used += widths[end] ?? 0
    end += 1
  }
  while (end === widths.length && start > 0 && used + (widths[start - 1] ?? 0) <= room) {
    start -= 1
    used += widths[start] ?? 0
  }
  return { start, end }
}

async function openPane($: Engine, at: CommandPresentation | undefined, focus?: true): Promise<string | undefined> {
  terminalLayout = at ?? terminalLayout
  const refused = await openRefusal($, terminalLayout)
  if (!refused) {
    await $.ui.open({ id: PANE, title: 'Pull requests', rows: 1, ...(focus ? { focus } : {}) })
  }
  return refused
}

function closePane($: Engine) {
  return $.ui.close({ id: PANE }).catch(() => undefined)
}

async function isPaneOpen($: Engine) {
  return (await $.ui.panes()).some(p => p.id === PANE)
}

export const register: Register = (on, options) => {
  requestsPerHour = Math.max(1, Number(options.requestsPerHour ?? 60))
  const daemonName = String(options.daemonCommand ?? 'pr-tracker-daemon')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prs',
      description: 'Track PRs: /prs [add <n|url> | remove <n> | clear | refresh]',
    })
    daemonCommand = (await daemonAnswers($, daemonName)) ? daemonName : undefined
    lastActivity = await $.clock.now()
    $.clock.every(POLL_MS, () => void refresh($))
    void showStatus($)
    return next(e)
  })

  on('command.run', { command: 'prs' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = rest.join(' ')
    if (verb === 'add') {
      const ref = refFromArg(arg)
      if (!ref) return { text: `Not a PR: ${arg}` }
      await track($, [ref])
      const refused = await openPane($, e.presentation)
      return { text: refused ? `Tracking ${arg}. ${refused}` : `Tracking ${arg}.` }
    }
    if (verb === 'remove') {
      const ref = refFromArg(arg)
      await untrack($, p => Boolean(ref && p.number === ref.number && (!ref.repo || p.repo === ref.repo)))
      return { text: `Stopped tracking ${arg}.` }
    }
    if (verb === 'clear') {
      await untrack($, () => true)
      return { text: 'Cleared the tracked PRs.' }
    }
    if (verb === 'refresh' || verb === '') {
      void refresh($, { force: true })
      const refused = await openPane($, e.presentation)
      if (verb) return { text: refused ? `Refreshing the tracked PRs. ${refused}` : 'Refreshing the tracked PRs.' }
      return { text: refused ?? 'PR tracker opened.' }
    }
    return { text: `Unknown: /prs ${verb}. Use add, remove, clear or refresh.` }
  })

  on('prompt.submit', async ($, e, next) => {
    lastActivity = await $.clock.now()
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    lastActivity = await $.clock.now()
    const command = e.command
    const refs = refsInCommand(command)
    if (PR_CREATE.test(command) && ran.deny === undefined && ran.isError !== true) {
      // gh pr create prints the new PR's URL, so naming it costs no API request.
      const stdout = String((ran.result as { stdout?: unknown } | undefined)?.stdout ?? '')
      for (const m of stdout.matchAll(PR_URL)) refs.push({ repo: m[1], number: Number(m[2]) })
    }
    if (refs.length > 0) void track($, refs)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = await next(e)
    const clickable = e.surface !== 'terminal' || e.viewport?.isFullscreen === true
    if (e.surface === 'terminal' && e.viewport?.isFullscreen !== undefined) {
      terminalLayout = { isFullscreen: e.viewport.isFullscreen, columns: e.viewport.columns }
    }
    const text = summary(await read($, prs), (e.viewport?.columns ?? 0) < 120)
    if (e.surface === 'terminal' && clickable !== summaryInHint) {
      summaryInHint = clickable
      void showStatus($)
    }
    if (!clickable || !text) return line
    const { Box, Button } = $.ui.resolve(e)
    const toggle = async () => {
      if (await isPaneOpen($)) return closePane($)
      const refused = await openPane($, undefined, true)
      if (refused) $.ui.toast(refused)
    }
    return (
      <Box justifyContent="space-between">
        <Box flexShrink={1}>{line}</Box>
        <Box flexShrink={0} marginLeft={1}>
          <Button key="prs-toggle" plain dimColor onPress={() => void toggle().catch(() => undefined)}>⌥ {text}</Button>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    // A fullscreen terminal reseats a docked pane inline when it narrows below DOCK_COLUMNS. Placement
    // is per surface, so only that terminal closes it; classic mode and phones draw it inline.
    const inline = e.props.placement === 'inline'
    if (inline && e.surface === 'terminal' && e.viewport?.isFullscreen === true) {
      void closePane($)
      return <Text color="inactive">In fullscreen the PR pane docks on the right only.</Text>
    }
    const list = await read($, prs)
    const now = await $.clock.now()
    const inner = Math.max(20, (e.props.bodyColumns ?? 80) - 4)
    const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

    const controls = (
      <Box>
        <Button key="refresh" plain dimColor hotkey="r" onPress={() => void refresh($, { force: true })}>refresh</Button>
        <Text>  </Text>
        <Button key="close" plain dimColor hotkey="x" role="dismiss" onPress={() => void closePane($)}>close</Button>
      </Box>
    )
    const untrackButton = (p: TrackedPr) => (
      <Button key={`untrack:${p.key}`} plain dimColor onPress={() => void untrack($, q => q.key === p.key)}>✕</Button>
    )

    if (inline) {
      const chips = [...list].sort((x, y) => ORDER.indexOf(health(x)) - ORDER.indexOf(health(y)))
      const { start, end } = chipWindow(chips.map(chipWidth), await read($, chipOffset), e.props.bodyColumns - INLINE_CHROME)
      return (
        <Box>
          <Text bold color="claude">⌥ PRs </Text>
          {start > 0 ? (
            <Button key="chips-prev" plain dimColor hotkey="h" onPress={() => void update($, chipOffset, () => start - 1)}>‹ {start}</Button>
          ) : null}
          <Box flexGrow={1}>
            {chips.length === 0 ? <Text color="inactive"> none tracked: /prs add 123</Text> : null}
            {chips.slice(start, end).map(p => {
              const kind = health(p)
              const ci = p.pass + p.fail + p.pending + p.skipped
              return (
                <Box marginLeft={1} marginRight={1} flexShrink={1}>
                  <Text wrap="truncate-end">
                    <Text color={ACCENT[kind]} bold>{GLYPH[kind]} </Text>
                    <Link href={p.url}><Text bold color={kind === 'merged' || kind === 'closed' ? 'inactive' : 'suggestion'}>#{p.number}</Text></Link>
                    {ci > 0 ? <Text color="inactive"> {p.pass + p.fail + p.skipped}/{ci}</Text> : null}
                    <Text> </Text>
                  </Text>
                  {untrackButton(p)}
                </Box>
              )
            })}
          </Box>
          {end < chips.length ? (
            <Button key="chips-next" plain dimColor hotkey="l" onPress={() => void update($, chipOffset, () => start + 1)}>{chips.length - end} ›</Button>
          ) : null}
          <Text>  </Text>
          <Button key="close" plain dimColor hotkey="x" role="dismiss" onPress={() => void closePane($)}>✕</Button>
        </Box>
      )
    }

    if (list.length === 0) {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color="claude">⌥ Pull requests</Text>
            {controls}
          </Box>
          <Text color="inactive">Nothing tracked yet.</Text>
          <Text color="inactive">Any gh pr create · view · checks · merge adds one, or /prs add 123.</Text>
        </Box>
      )
    }

    const sorted = [...list].sort((x, y) => ORDER.indexOf(health(x)) - ORDER.indexOf(health(y)))
    const live = sorted.filter(p => p.state !== 'MERGED' && p.state !== 'CLOSED')
    const settled = sorted.filter(p => p.state === 'MERGED' || p.state === 'CLOSED')
    if (e.props.bodyColumns < MINIMAL_COLUMNS) {
      const width = e.props.bodyColumns
      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold color="claude">⌥ PRs</Text>
            <Button key="close" plain dimColor hotkey="x" role="dismiss" onPress={() => void closePane($)}>✕</Button>
          </Box>
          {live.map(p => {
            const kind = health(p)
            const ci = p.pass + p.fail + p.pending + p.skipped
            const tally = ci > 0 ? ` ${p.pass + p.fail + p.skipped}/${ci}` : ''
            const room = width - String(p.number).length - tally.length - 7
            return (
              <Box justifyContent="space-between">
                <Text>
                  <Text color={ACCENT[kind]} bold>{GLYPH[kind]} </Text>
                  <Link href={p.url}><Text bold color="suggestion">#{p.number}</Text></Link>
                  {room >= 6 ? <Text> {cut(p.title || p.repo, room)}</Text> : null}
                  <Text color="inactive">{tally}</Text>
                </Text>
                {untrackButton(p)}
              </Box>
            )
          })}
          {settled.length > 0 ? (
            <Text color="inactive">{cut(`done ${settled.map(p => `${GLYPH[health(p)]}#${p.number}`).join(' ')}`, width)}</Text>
          ) : null}
        </Box>
      )
    }
    const room = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const layout = plan(live, settled, room)
    const count = (want: Health) => list.filter(p => health(p) === want).length
    const newest = Math.max(...list.map(p => p.checkedAt))
    const clearDone = (
      <Button key="clear-done" plain dimColor onPress={() => void untrack($, p => p.state === 'MERGED' || p.state === 'CLOSED')}>
        clear
      </Button>
    )
    const tally: [string, string, number][] = [
      ['✗ failing', 'error', count('failing') + count('conflict')],
      ['◐ running', 'warning', count('running')],
      ['✓ green', 'success', count('green')],
      ['◌ draft', 'subtle', count('draft') + count('quiet')],
      ['⇡ merged', 'merged', count('merged')],
    ]

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between" paddingX={1}>
          <Text bold color="claude">⌥ Pull requests</Text>
          {controls}
        </Box>
        <Box justifyContent="space-between" paddingX={1} marginBottom={1}>
          <Text>
            {tally
              .filter(([, , n]) => n > 0)
              .map(([label, color, n], i) => (
                <Text color={color}>{i ? '  ' : ''}{n} {label.split(' ')[0]} <Text color="inactive">{label.split(' ')[1]}</Text></Text>
              ))}
          </Text>
          <Text color="inactive">
            {layout.height > room ? (e.props.isFocused ? '↑↓ scroll  ' : 'ctrl+x tab ↕  ') : ''}↻ {ago(now, newest)}
            {limited && limited.until > now ? ` · gh paused ${until(now, limited.until)}` : ''}
          </Text>
        </Box>

        {live.map(p => {
          const kind = health(p)
          const ci = p.pass + p.fail + p.pending + p.skipped
          const done = p.pass + p.fail + p.skipped
          if (!layout.full.has(p.key)) {
            return (
              <Box paddingX={1} justifyContent="space-between">
                <Text>
                  <Text color={ACCENT[kind]} bold>{GLYPH[kind]} </Text>
                  <Link href={p.url}><Text bold color="suggestion">#{p.number}</Text></Link>
                  <Text> {cut(p.title || p.repo, Math.max(8, inner - String(p.number).length - 25))}</Text>
                  {ci > 0 ? <Text>  </Text> : null}
                  {ciBar(p, 8).map(seg => <Text color={seg.color}>{seg.text}</Text>)}
                  {ci > 0 ? <Text color="inactive"> {done}/{ci}</Text> : null}
                </Text>
                {untrackButton(p)}
              </Box>
            )
          }
          const review = REVIEW[p.review]
          const barWidth = Math.max(10, Math.min(32, inner - 24))
          return (
            <Box flexDirection="column" borderStyle="round" borderColor={ACCENT[kind]} paddingX={1}>
              <Text>
                <Text color={ACCENT[kind]} bold>{GLYPH[kind]} </Text>
                <Link href={p.url}><Text bold color="suggestion">#{p.number}</Text></Link>
                <Text bold> {cut(p.title || p.repo, inner - String(p.number).length - 4)}</Text>
              </Text>
              <Text>
                {p.isDraft ? <Text color="subtle">◌ draft</Text> : <Text color="success">● ready</Text>}
                {review ? <Text color={review[1]}>   {review[0]}</Text> : null}
                {p.mergeable === 'CONFLICTING' ? <Text color="error" bold>   ⚠ conflicts</Text> : null}
                {p.mergeable === 'MERGEABLE' && kind === 'green' && p.review === 'APPROVED' ? (
                  <Text color="success" bold>   ⏎ mergeable</Text>
                ) : null}
              </Text>
              {ci > 0 ? (
                <Text>
                  {ciBar(p, barWidth).map(seg => <Text color={seg.color}>{seg.text}</Text>)}
                  <Text color="inactive"> {done}/{ci} </Text>
                  <Text color="success">✓{p.pass}</Text>
                  {p.fail ? <Text color="error"> ✗{p.fail}</Text> : null}
                  {p.pending ? <Text color="warning"> ◐{p.pending}</Text> : null}
                </Text>
              ) : (
                <Text color="inactive">no checks reported</Text>
              )}
              {p.failing.slice(0, 3).map(name => <Text color="error">  ✗ {cut(name, inner - 4)}</Text>)}
              {p.failing.length > 3 ? <Text color="error">  … {p.failing.length - 3} more failing</Text> : null}
              {p.fail === 0 && p.running.length > 0 ? (
                <Text color="warning">  ◐ {cut(p.running.slice(0, 3).join(' · '), inner - 4)}{p.running.length > 3 ? ` +${p.running.length - 3}` : ''}</Text>
              ) : null}
              {p.error ? <Text color="error">  ⚠ {cut(p.error, inner - 4)}</Text> : null}
              <Box justifyContent="space-between">
                <Text color="inactive">  {cut(`${p.repo} · checked ${ago(now, p.checkedAt)} ago`, inner - 16)}</Text>
                <Box>
                  <Link href={`${p.url}/checks`}><Text color="suggestion">checks</Text></Link>
                  <Text> </Text>
                  <Button key={`refresh:${p.key}`} plain dimColor onPress={() => void refresh($, { keys: [p.key], force: true })}>↻</Button>
                  <Text> </Text>
                  {untrackButton(p)}
                </Box>
              </Box>
            </Box>
          )
        })}
        {layout.doneLines === 'list' ? (
          <Box flexDirection="column" paddingX={1} marginTop={1}>
            <Box justifyContent="space-between">
              <Text color="inactive">── done ──</Text>
              {clearDone}
            </Box>
            {settled.map(p => (
              <Box justifyContent="space-between">
                <Text>
                  <Text color={ACCENT[health(p)]}>{GLYPH[health(p)]} </Text>
                  <Link href={p.url}><Text color="inactive">#{p.number}</Text></Link>
                  <Text color="inactive" strikethrough={p.state === 'CLOSED'}> {cut(p.title, inner - 13)}</Text>
                </Text>
                {untrackButton(p)}
              </Box>
            ))}
          </Box>
        ) : null}
        {layout.doneLines === 'summary' ? (
          <Box paddingX={1} marginTop={1} justifyContent="space-between">
            <Text color="inactive">
              {cut(`── done: ${settled.map(p => `${GLYPH[health(p)]}#${p.number}`).join(' ')}`, inner - 7)}
            </Text>
            {clearDone}
          </Box>
        ) : null}
      </Box>
    )
  })
}
