import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { cardRows, chipWindow, maxAgeMs, MIN_CARDS, opens, plan, refsInCommand, stacks, summarise } from '../hooks/register.tsx'
import type { TrackedPr } from '../types'

const CHECKS = [
  { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'CheckRun', name: 'clang-tidy (x64)', status: 'COMPLETED', conclusion: 'FAILURE' },
  { __typename: 'CheckRun', name: 'gpu', status: 'IN_PROGRESS', conclusion: null },
]

type World = {
  files: Map<string, string>
  /** The query of each `gh api graphql` call, and every other argv run. */
  graphql: string[]
  argv: string[][]
  statuses: (string | undefined)[]
  clock: ReturnType<typeof mock.clock>
  checks: unknown[]
  rateLimit: { remaining: number; resetAt: string }
  refuse: boolean
  offline: boolean
  bashStdout: string
  daemon?: (request: { prs: { key: string; maxAgeMs: number }[] }) => unknown
  daemonRequests: unknown[]
  /** `git config` remotes by name; `origin` is the cwd repo unless a test says otherwise. */
  remotes: Record<string, string>
  titles: Record<number, string>
  /** Each PR's `[base, head]` branches; unset PRs merge `pr-<n>` into main. */
  branches: Record<number, [string, string]>
  /** PR numbers GitHub does not know: their alias is null with a NOT_FOUND error, and gh exits 1. */
  missing: number[]
  /** While set, every graphql call waits for it, after calling `entered`. */
  hold?: Promise<void>
  entered?: () => void
}

// Everything outside the mod: a cache dir in memory, a git remote, gh answering GraphQL by alias, a daemon.
function world(on: On, repo = 'kinisi-robotics/kinisi_ros'): World {
  const w: World = {
    files: new Map(), graphql: [], argv: [], statuses: [], clock: mock.clock(on, { now: Date.parse('2026-10-09T12:00:00Z') }), checks: CHECKS,
    rateLimit: { remaining: 4999, resetAt: '2099-01-01T00:00:00Z' }, refuse: false, offline: false, bashStdout: '', daemonRequests: [],
    remotes: { origin: `git@github.com:${repo}.git` }, titles: {}, branches: {}, missing: [],
  }
  const ran = (stdout: string, exitCode = 0, stderr = '') =>
    ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('env.get', ($, e) => ({ value: e.name === 'CLAUDE_PR_TRACKER_DIR' ? '/cache' : undefined }))
  on('fs.read', ($, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: w.bashStdout, stderr: '', interrupted: false } }))
  on('process.run', async ($, e) => {
    w.argv.push([...e.argv])
    const [cmd, ...args] = e.argv
    if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
      const url = w.remotes[args[2] ?? '']
      return url ? ran(`${url}\n`) : ran('', 2, 'error: No such remote')
    }
    if (cmd === 'git' && args[0] === 'config') {
      return ran(Object.entries(w.remotes).map(([name, url]) => `remote.${name}.url ${url}\n`).join(''))
    }
    if (cmd === 'pr-tracker-daemon') {
      if (!w.daemon) return ran('', 127, 'not found')
      if (args[0] === 'ping') return ran('ok\n')
      const request = JSON.parse(e.init?.stdin ?? '{}')
      w.daemonRequests.push(request)
      return ran(JSON.stringify(w.daemon(request)))
    }
    if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
      const query = args.find(a => a.startsWith('query='))?.slice('query='.length) ?? ''
      w.graphql.push(query)
      w.entered?.()
      await w.hold
      if (w.refuse) return ran('', 1, 'gh: API rate limit exceeded for user ID 1. (HTTP 403)')
      if (w.offline) return ran('', 1, 'error connecting to api.github.com')
      const data: Record<string, unknown> = { rateLimit: w.rateLimit }
      const errors: unknown[] = []
      for (const m of query.matchAll(/(p\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g)) {
        const [, alias, owner, name, n] = m
        if (w.missing.includes(Number(n))) {
          data[alias!] = { pullRequest: null }
          errors.push({ type: 'NOT_FOUND', path: [alias, 'pullRequest'], message: `Could not resolve to a PullRequest with the number of ${n}.` })
          continue
        }
        data[alias!] = {
          pullRequest: {
            number: Number(n), title: w.titles[Number(n)] ?? `pr ${n}`, url: `https://github.com/${owner}/${name}/pull/${n}`,
            state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: 'APPROVED',
            baseRefName: w.branches[Number(n)]?.[0] ?? 'main', headRefName: w.branches[Number(n)]?.[1] ?? `pr-${n}`, isCrossRepository: false,
            commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: w.checks } } } }] },
          },
        }
      }
      return errors.length ? ran(JSON.stringify({ data, errors }), 1, 'gh: Could not resolve to a PullRequest') : ran(JSON.stringify({ data }))
    }
    return ran('', 1, `unexpected: ${e.argv.join(' ')}`)
  })
  return w
}

// The session starting: the mod registers /prs, starts polling and probes for a daemon.
async function start($: Engine, on: On, w: World) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__pr-tracker__${e.name}` } }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

// A Bash call, then the second in which newly named PRs are gathered into one fetch.
async function bash($: Engine, w: World, command: string) {
  await $.tool.call({ tool: 'Bash', command })
  await w.clock.advance(1_000)
  await w.clock.settle()
}

// A Bash call that names PR 12371 of the cwd's repo.
async function trackOne($: Engine, on: On): Promise<World> {
  const w = world(on)
  await bash($, w, 'gh pr checks 12371')
  return w
}

// The engine's pane bookkeeping, answered from a set of open ids.
function panes(on: On, surfaces: string[] = ['terminal']) {
  const open = new Set<string>()
  on('session.surfaces', () => ({ value: surfaces as never }))
  on('ui.open', ($, e) => {
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id })) as never }))
  return open
}

test('a gh pr command run through Bash is tracked and its CI tally reaches the status line', async ($, on) => {
  const w = await trackOne($, on)
  expect(w.statuses.at(-1)).toBe('PRs 1 open · 1 failing · 1 running')
})

test('the pane draws a tracked PR with its failing check on each surface', async ($, on) => {
  await trackOne($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'pr-tracker', surface, component: 'Pane', requestId: 'pr-tracker',
      props: { title: 'Pull requests', isFocused: false } as never,
    })
    expect((await ui.find({ text: /#12371/ }))?.text).toContain('#12371')
    expect((await ui.find({ text: /clang-tidy \(x64\)/ }))?.text).toContain('clang-tidy (x64)')
  }
})

test('commands name PRs by URL or by the number given to a gh pr verb, nothing else', () => {
  expect(refsInCommand('gh pr merge 12371 --squash')).toEqual([{ repo: undefined, number: 12371 }])
  expect(refsInCommand('gh pr view 5 -R a/b')).toEqual([{ repo: 'a/b', number: 5 }])
  expect(refsInCommand('open https://github.com/o/r/pull/9')).toEqual([{ repo: 'o/r', number: 9 }])
  expect(refsInCommand('gh pr list --limit 30')).toEqual([])
  expect(refsInCommand('gh run view 37802490225')).toEqual([])
})

test('commit statuses and check runs land in the same buckets', () => {
  expect(
    summarise([
      { state: 'SUCCESS', context: 'ci/a' },
      { state: 'PENDING', context: 'ci/b' },
      { state: 'ERROR', context: 'ci/c' },
      { name: 'x', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { name: 'y', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { name: 'z', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
    ]),
  ).toEqual({ pass: 2, fail: 2, pending: 1, skipped: 1, failing: ['ci/c', 'z'], running: ['ci/b'] })
})

function pr(number: number, over: Partial<TrackedPr> = {}): TrackedPr {
  return {
    key: `o/r#${number}`, repo: 'o/r', number, title: `pr ${number}`, url: '', state: 'OPEN', isDraft: false,
    mergeable: 'MERGEABLE', review: '', pass: 3, fail: 0, pending: 0, skipped: 0, failing: [], running: [],
    checkedAt: 1, ...over,
  }
}

test('the layout fits a tall pane and keeps every PR, scrolling, in a short one', () => {
  const live = [1, 2, 3, 4, 5, 6].map(n => pr(n, n === 4 ? { fail: 1, failing: ['lint'] } : {}))
  const settled = [pr(7, { state: 'MERGED' }), pr(8, { state: 'MERGED' })]
  const all = live.reduce((n, p) => n + cardRows(p), 3) + 2 + settled.length
  expect(plan(live, settled, all).full.size).toBe(6)
  expect(plan(live, settled, all).height).toBeLessThanOrEqual(all)
  for (const rows of [4, 8, 12, 20]) {
    const l = plan(live, settled, rows)
    expect(l.full.size).toBeGreaterThanOrEqual(MIN_CARDS)
    expect([...l.full].slice(0, MIN_CARDS)).toEqual(['o/r#4', 'o/r#1'])
    expect(l.height).toBe(
      3 + live.reduce((n, p) => n + (l.full.has(p.key) ? cardRows(p) : 1), 0) +
        (l.doneLines === 'list' ? 2 + settled.length : 2),
    )
  }
  expect(plan(live, settled, 8).height).toBeGreaterThan(8)
  expect(plan(live, settled, 20, 2).height).toBe(plan(live, settled, 20).height + 2)
})

test('tracked PRs group into stacks by base and head branch, bottom first, the most urgent stack first', () => {
  const on = (n: number, base: string, over: Partial<TrackedPr> = {}) => pr(n, { baseRefName: base, headRefName: `b${n}`, ...over })
  const numbers = (groups: TrackedPr[][]) => groups.map(g => g.map(p => p.number))
  expect(numbers(stacks([on(9, 'main'), on(3, 'b2'), on(1, 'main'), on(2, 'b1')]))).toEqual([[9], [1, 2, 3]])
  expect(numbers(stacks([on(9, 'main'), on(3, 'b2', { fail: 1 }), on(1, 'main'), on(2, 'b1')]))).toEqual([[1, 2, 3], [9]])
  expect(numbers(stacks([on(1, 'main'), on(5, 'b1'), on(4, 'b1')]))).toEqual([[1, 4, 5]])
  expect(numbers(stacks([on(1, 'main', { repo: 'x/y', key: 'x/y#1' }), on(2, 'b1')]))).toEqual([[1], [2]])
  expect(numbers(stacks([on(1, 'main', { isCrossRepository: true }), on(2, 'b1')]))).toEqual([[1], [2]])
  expect(numbers(stacks([on(1, 'b2'), on(2, 'b1')]))).toHaveLength(1)
  expect(numbers(stacks([on(3, 'b1'), on(1, 'b2'), on(2, 'b1')]))[0]?.toSorted()).toEqual([1, 2, 3])
  expect(numbers(stacks([on(1, 'main', { repo: 'O/R' }), on(2, 'b1')]))).toEqual([[1, 2]])
  expect(numbers(stacks([pr(1), pr(2)]))).toEqual([[1], [2]])
})

test('the pane lists a stack bottom first under a header naming it, and the classic row keeps it together', async ($, on) => {
  panes(on)
  const w = world(on, 'o/r')
  w.branches = { 31: ['b32', 'b31'], 32: ['main', 'b32'], 33: ['b31', 'b33'], 34: ['b32', 'b34'] }
  await bash($, w, 'gh pr view 33 && gh pr view 40 && gh pr view 34 && gh pr view 31 && gh pr view 32')
  const order = (text: string) => [32, 31, 33, 34, 40].map(n => text.indexOf(`#${n}`)).filter(i => i >= 0)
  const dock = await $.ui.mount({
    plugin: 'pr-tracker', surface: 'terminal', component: 'Pane', requestId: 'pr-tracker',
    props: { title: 'Pull requests', isFocused: false, placement: 'dock', bodyColumns: 80, scroll: { offset: 0, bodyRows: 80 } } as never,
  })
  const chain = '#32 → #31 → #33, #32 → #34'
  expect((await dock.find({ text: /stack on main/ }))?.text).toContain(`stack on main: ${chain}`)
  const body = ((await dock.find({ text: /Pull requests/ }))?.text ?? '').split(chain)[1] ?? ''
  expect(order(body)).toEqual([...order(body)].sort((a, b) => a - b))
  expect(order(body)).toHaveLength(5)
  await dock.unmount()
  const narrow = await $.ui.mount({
    plugin: 'pr-tracker', surface: 'terminal', component: 'Pane', requestId: 'pr-tracker',
    props: { title: 'Pull requests', isFocused: false, placement: 'dock', bodyColumns: 40 } as never,
  })
  expect((await narrow.find({ text: /PRs/ }))?.text).toMatch(/┌[^#├└]*#32[^#]*├[^#]*#31[^#]*├[^#]*#33[^#]*└[^#]*#34[^┌├└]*#40/)
  await narrow.unmount()
  const row = await $.ui.mount({
    plugin: 'pr-tracker', surface: 'terminal', component: 'Pane', requestId: 'pr-tracker',
    props: { title: 'Pull requests', isFocused: false, placement: 'inline', bodyColumns: 200 } as never,
    viewport: { columns: 204, rows: 40, isFullscreen: false },
  })
  const chips = (await row.find({ text: /PRs/ }))?.text ?? ''
  expect(chips).toMatch(/#32[^#]*→[^#]*#31[^#]*→[^#]*#33[^#]*→[^#]*#34/)
  expect(chips).not.toMatch(/→[^#]*#40/)
})

test('a short pane keeps every PR, the first two as cards, and says it scrolls', async ($, on) => {
  const w = world(on, 'o/r')
  await bash($, w, [1, 2, 3, 4, 5, 6].map(n => `gh pr view ${n}`).join(' && '))

  // A card ends in its `checked` footer; the outermost match holds the whole pane's text.
  const cards = async (ui: { find: (q: { text: RegExp }) => Promise<{ text?: string } | undefined> }) =>
    ((await ui.find({ text: /Pull requests/ }))?.text ?? '').match(/checked/g)?.length ?? 0
  const mount = (rows: number) =>
    $.ui.mount({
      plugin: 'pr-tracker', surface: 'terminal', component: 'Pane', requestId: 'pr-tracker',
      props: { title: 'Pull requests', isFocused: false, scroll: { offset: 0, bodyRows: rows } } as never,
      viewport: { columns: 100, rows },
    })
  const short = await mount(10)
  expect(await cards(short)).toBe(MIN_CARDS)
  expect((await short.find({ text: /ctrl\+x tab/ }))?.text).toBeDefined()
  for (const n of [1, 2, 3, 4, 5, 6]) expect((await short.find({ text: new RegExp(`#${n}\\b`) }))?.text).toBeDefined()
  await short.unmount()
  const tall = await mount(80)
  expect(await cards(tall)).toBe(6)
  expect(await tall.find({ text: /ctrl\+x tab/ })).toBeUndefined()
})

test('inline above the prompt the pane draws its PR row, but a narrow fullscreen terminal closes it', async ($, on) => {
  const open = panes(on)
  await trackOne($, on)
  const seats = [
    ['mobile', undefined, true],
    ['terminal', { columns: 80, rows: 40, isFullscreen: false }, true],
    ['terminal', { columns: 100, rows: 40, isFullscreen: true }, false],
  ] as const
  for (const [surface, viewport, stays] of seats) {
    open.add('pr-tracker')
    const ui = await $.ui.mount({
      plugin: 'pr-tracker', surface, component: 'Pane', requestId: 'pr-tracker',
      props: { title: 'Pull requests', isFocused: false, placement: 'inline', bodyColumns: 76 } as never,
      ...(viewport ? { viewport } : {}),
    })
    expect(open.has('pr-tracker')).toBe(stays)
    expect((await ui.find({ text: /#12371/ }))?.text !== undefined).toBe(stays)
    expect(await ui.findAll({ key: 'refresh:kinisi-robotics/kinisi_ros#12371' })).toHaveLength(0)
    await ui.unmount()
  }
})

test('an attached terminal decides where the pane opens: classic mode inline, fullscreen docked from 110 columns', () => {
  const cases: [boolean, number, ('terminal' | 'desktop' | 'mobile' | 'vscode')[], boolean][] = [
    [true, 110, ['terminal'], true],
    [true, 109, ['terminal'], false],
    [false, 200, ['terminal'], true],
    [false, 80, ['terminal', 'mobile'], true],
    [false, 80, ['terminal', 'desktop'], true],
    [true, 100, ['terminal', 'desktop'], false],
    [true, 140, ['terminal', 'desktop'], true],
    [false, 80, ['desktop'], true],
    [false, 80, ['mobile'], false],
    [false, 80, ['vscode'], true],
  ]
  for (const [isFullscreen, columns, surfaces, want] of cases) {
    expect(opens({ isFullscreen, columns }, surfaces)).toBe(want)
  }
  for (const surfaces of [['terminal'], ['terminal', 'desktop']] as const) {
    expect(opens(undefined, surfaces)).toBe(false)
  }
})

test('clicking the PR summary under the prompt opens the pane and clicking it again closes it', async ($, on) => {
  const open = panes(on)
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'Text', props: {}, children: ['? for shortcuts'] }) as never)
  const w = await trackOne($, on)
  const ui = await $.ui.mount({
    plugin: 'pr-tracker', surface: 'terminal', component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    viewport: { columns: 140, rows: 40, isFullscreen: true },
  })
  expect((await ui.find({ key: 'prs-toggle' }))?.text).toContain('1 open')
  expect((await ui.find({ text: /for shortcuts/ }))?.text).toBeDefined()
  expect(w.statuses.at(-1)).toBeUndefined()
  await ui.press({ key: 'prs-toggle' })
  expect(open.has('pr-tracker')).toBe(true)
  await ui.press({ key: 'prs-toggle' })
  expect(open.has('pr-tracker')).toBe(false)
})

test('the pane untracks a PR and closes itself from its own buttons', async ($, on) => {
  const open = panes(on)
  const w = await trackOne($, on)
  open.add('pr-tracker')
  const ui = await $.ui.mount({
    plugin: 'pr-tracker', surface: 'terminal', component: 'Pane', requestId: 'pr-tracker',
    props: { title: 'Pull requests', isFocused: false, placement: 'dock', bodyColumns: 60 } as never,
  })
  await ui.press({ key: 'untrack:kinisi-robotics/kinisi_ros#12371' })
  expect(await ui.find({ text: /#12371/ })).toBeUndefined()
  expect(w.statuses.at(-1)).toBeUndefined()
  await ui.press({ key: 'close' })
  expect(open.has('pr-tracker')).toBe(false)
})

test('a narrow dock shows each PR on one line and keeps the close button', async ($, on) => {
  panes(on)
  await trackOne($, on)
  for (const [bodyColumns, cards] of [[60, 1], [40, 0]] as const) {
    const ui = await $.ui.mount({
      plugin: 'pr-tracker', surface: 'terminal', component: 'Pane', requestId: 'pr-tracker',
      props: { title: 'Pull requests', isFocused: false, placement: 'dock', bodyColumns } as never,
    })
    expect(await ui.findAll({ key: 'refresh:kinisi-robotics/kinisi_ros#12371' })).toHaveLength(cards)
    expect((await ui.find({ text: /#12371/ }))?.text).toContain('2/3')
    expect(await ui.find({ key: 'close' })).toBeDefined()
    await ui.unmount()
  }
})

test('the chip window starts at the offset, takes whole chips while they fit, and backs up to fill the row', () => {
  const widths = [10, 10, 10, 10]
  expect(chipWindow(widths, 0, 25)).toEqual({ start: 0, end: 2 })
  expect(chipWindow(widths, 2, 25)).toEqual({ start: 2, end: 4 })
  expect(chipWindow(widths, 9, 25)).toEqual({ start: 2, end: 4 })
  expect(chipWindow([10, 10, 10], 2, 35)).toEqual({ start: 0, end: 3 })
  expect(chipWindow(widths, 0, 5)).toEqual({ start: 0, end: 1 })
  expect(chipWindow([], 0, 25)).toEqual({ start: 0, end: 0 })
})

test('in classic mode the PRs sit side by side on one row and scroll sideways', async ($, on) => {
  panes(on)
  const w = world(on, 'o/r')
  await bash($, w, [11, 12, 13, 14, 15, 16].map(n => `gh pr view ${n}`).join(' && '))
  const ui = await $.ui.mount({
    plugin: 'pr-tracker', surface: 'terminal', component: 'Pane', requestId: 'pr-tracker',
    props: { title: 'Pull requests', isFocused: false, placement: 'inline', bodyColumns: 60 } as never,
    viewport: { columns: 64, rows: 40, isFullscreen: false },
  })
  const shown = async () => {
    const text = (await ui.find({ text: /PRs/ }))?.text ?? ''
    return [11, 12, 13, 14, 15, 16].filter(n => text.includes(`#${n}`))
  }
  const first = await shown()
  expect(first.length).toBeGreaterThan(0)
  expect(first.length).toBeLessThan(6)
  await ui.press({ key: 'chips-next' })
  expect((await shown())[0]).not.toBe(first[0])
  await ui.press({ key: 'chips-prev' })
  expect(await shown()).toEqual(first)
  expect(await ui.find({ key: 'close' })).toBeDefined()
  for (const n of [11, 12, 13, 14, 15, 16]) await ui.press({ key: `untrack:o/r#${n}` })
  expect((await ui.find({ text: /none tracked/ }))?.text).toBeDefined()
})

const HOUR = 3_600_000

function cached(w: World, entries: Record<string, { fetchedAt: number; title: string }>, more: object = {}) {
  const prs = Object.fromEntries(Object.entries(entries).map(([key, { fetchedAt, title }]) => {
    const [repo, n] = key.split('#')
    return [key, {
      fetchedAt,
      data: {
        title, url: `https://github.com/${repo}/pull/${n}`, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
        review: '', pass: 1, fail: 0, pending: 0, skipped: 0, failing: [], running: [],
      },
    }]
  }))
  w.files.set('/cache/state.json', JSON.stringify({ version: 1, requests: [], pausedUntil: 0, prs, ...more }))
}

test('every PR a command names is fetched in one gh call, with no other GitHub request', async ($, on) => {
  const w = world(on, 'o/r')
  await bash($, w, [1, 2, 3, 4, 5, 6].map(n => `gh pr view ${n}`).join(' && '))
  expect(w.graphql).toHaveLength(1)
  for (const n of [1, 2, 3, 4, 5, 6]) expect(w.graphql[0]).toContain(`pullRequest(number: ${n})`)
  expect(w.argv.filter(a => a[0] === 'gh' && a[1] !== 'api')).toEqual([])
})

test('a PR another session fetched recently is reused, and a lock another session holds fetches nothing', async ($, on) => {
  const w = world(on, 'o/r')
  cached(w, { 'o/r#5': { fetchedAt: w.clock.now(), title: 'from elsewhere' } })
  await bash($, w, 'gh pr view 5')
  expect(w.graphql).toHaveLength(0)
  const ui = await $.ui.mount({
    plugin: 'pr-tracker', surface: 'terminal', component: 'Pane', requestId: 'pr-tracker',
    props: { title: 'Pull requests', isFocused: false, placement: 'dock', bodyColumns: 80 } as never,
  })
  expect((await ui.find({ text: /from elsewhere/ }))?.text).toBeDefined()
  w.files.set('/cache/lock.json', JSON.stringify({ owner: 'another session', until: w.clock.now() + HOUR }))
  await bash($, w, 'gh pr view 6')
  expect(w.graphql).toHaveLength(0)
})

test('the hourly budget is shared through the cache and refills as requests age out', { options: { requestsPerHour: 2 } }, async ($, on) => {
  const w = world(on, 'o/r')
  await start($, on, w)
  const now = w.clock.now()
  w.files.set('/cache/state.json', JSON.stringify({ version: 1, requests: [now - 50 * 60_000, now - 40 * 60_000], pausedUntil: 0, prs: {} }))
  await bash($, w, 'gh pr view 7')
  expect(w.graphql).toHaveLength(0)
  await w.clock.advance(9 * 60_000)
  expect(w.graphql).toHaveLength(0)
  await w.clock.advance(2 * 60_000)
  expect(w.graphql).toHaveLength(1)
})

test('GitHub running out or refusing pauses fetching until its reset', async ($, on) => {
  const w = world(on, 'o/r')
  panes(on).add('pr-tracker')
  await start($, on, w)
  w.rateLimit = { remaining: 0, resetAt: new Date(w.clock.now() + 10 * 60_000).toISOString() }
  await bash($, w, 'gh pr view 8')
  expect(w.graphql).toHaveLength(1)
  const ui = await $.ui.mount({
    plugin: 'pr-tracker', surface: 'terminal', component: 'Pane', requestId: 'pr-tracker',
    props: { title: 'Pull requests', isFocused: false, placement: 'dock', bodyColumns: 80 } as never,
  })
  expect((await ui.find({ text: /gh paused 10m/ }))?.text).toBeDefined()
  await ui.unmount()
  w.rateLimit = { remaining: 4999, resetAt: '2099-01-01T00:00:00Z' }
  await w.clock.advance(9 * 60_000)
  expect(w.graphql).toHaveLength(1)
  await w.clock.advance(60_000)
  expect(w.graphql).toHaveLength(2)
  w.refuse = true
  await w.clock.advance(60_000)
  expect(w.graphql).toHaveLength(3)
  w.refuse = false
  await w.clock.advance(13 * 60_000)
  expect(w.graphql).toHaveLength(3)
  await w.clock.advance(2 * 60_000)
  expect(w.graphql).toHaveLength(4)
})

test('a running PR is refetched each minute, a quiet one every five', async ($, on) => {
  const w = world(on, 'o/r')
  await start($, on, w)
  await bash($, w, 'gh pr view 9')
  await w.clock.advance(61_000)
  expect(w.graphql).toHaveLength(2)
  w.checks = [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }]
  await w.clock.advance(60_000)
  expect(w.graphql).toHaveLength(3)
  await w.clock.advance(3 * 60_000)
  expect(w.graphql).toHaveLength(3)
  await w.clock.advance(2 * 60_000 + 1000)
  expect(w.graphql).toHaveLength(4)
})

test('a daemon that answers ping takes every fetch', async ($, on) => {
  const w = world(on, 'o/r')
  w.daemon = request => ({
    prs: Object.fromEntries(request.prs.map(({ key }) => [key, {
      fetchedAt: w.clock.now(),
      data: {
        title: 'via daemon', url: '', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', review: '',
        pass: 1, fail: 0, pending: 0, skipped: 0, failing: [], running: [],
      },
    }])),
  })
  await start($, on, w)
  await bash($, w, 'gh pr view 10')
  expect(w.graphql).toHaveLength(0)
  expect(w.daemonRequests).toEqual([{ version: 1, requestsPerHour: 60, prs: [{ key: 'o/r#10', maxAgeMs: 55_000 }] }])
  const ui = await $.ui.mount({
    plugin: 'pr-tracker', surface: 'terminal', component: 'Pane', requestId: 'pr-tracker',
    props: { title: 'Pull requests', isFocused: false, placement: 'dock', bodyColumns: 80 } as never,
  })
  expect((await ui.find({ text: /via daemon/ }))?.text).toBeDefined()
})

test('the PR gh pr create prints is tracked without asking GitHub which it was', async ($, on) => {
  const w = world(on, 'o/r')
  w.bashStdout = 'https://github.com/o/r/pull/77\n'
  await bash($, w, 'gh pr create --fill')
  expect(w.graphql).toHaveLength(1)
  expect(w.graphql[0]).toContain('pullRequest(number: 77)')
  expect(w.argv.filter(a => a[0] === 'gh' && a[1] !== 'api')).toEqual([])
})

test('a batch with an unknown PR and a title about rate limits keeps its results and pauses nothing', async ($, on) => {
  const w = world(on, 'o/r')
  await start($, on, w)
  w.titles[5] = 'Fix rate limit handling'
  w.missing = [999]
  await bash($, w, 'gh pr view 5 && gh pr view 999')
  const state = JSON.parse(w.files.get('/cache/state.json') ?? '{}')
  expect(state.pausedUntil).toBe(0)
  expect(state.prs['o/r#5'].data.title).toBe('Fix rate limit handling')
  expect(state.prs['o/r#999'].error).toContain('Could not resolve')
  await w.clock.advance(60_000)
  expect(w.graphql).toHaveLength(2)
})

test("one session's fetches never overlap, so neither's results or request are lost", async ($, on) => {
  const w = world(on, 'o/r')
  let release = () => {}
  w.hold = new Promise(resolve => (release = resolve))
  const inFlight = new Promise<void>(resolve => (w.entered = resolve))
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 1' })
  void w.clock.advance(1_000)
  await inFlight
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 2' })
  void w.clock.advance(1_000)
  // Room for the second fetch to reach gh, were it not queued behind the first.
  for (let i = 0; i < 50; i++) await w.clock.advance(0)
  expect(w.graphql).toHaveLength(1)
  release()
  await w.clock.settle()
  const state = JSON.parse(w.files.get('/cache/state.json') ?? '{}')
  expect(Object.keys(state.prs).sort()).toEqual(['o/r#1', 'o/r#2'])
  expect(state.requests).toHaveLength(w.graphql.length)
})

test('in a fork checkout the repo gh resolves to is tracked, not origin', async ($, on) => {
  const w = world(on, 'me/fork')
  w.remotes = { origin: 'git@github.com:me/fork.git', upstream: 'https://github.com/o/r.git' }
  await bash($, w, 'gh pr checks 5')
  expect(w.graphql[0]).toContain('repository(owner: "o", name: "r") { pullRequest(number: 5)')
})

test('a daemon reply that is not a FetchResponse falls back to the built-in coordinator', async ($, on) => {
  const w = world(on, 'o/r')
  w.daemon = () => ({ error: 'x' })
  await start($, on, w)
  await bash($, w, 'gh pr view 10')
  expect(w.daemonRequests).toHaveLength(1)
  expect(w.graphql).toHaveLength(1)
})

test('how stale a PR may get: a minute while unknown or running, five quiet, longer after failures or when idle', () => {
  const base = {
    key: 'o/r#1', repo: 'o/r', number: 1, title: '', url: '', state: 'UNKNOWN', isDraft: false, mergeable: 'UNKNOWN',
    review: '', pass: 0, fail: 0, pending: 0, skipped: 0, failing: [], running: [],
  }
  const MIN = 60_000
  expect(maxAgeMs({ ...base, checkedAt: 0 })).toBe(MIN)
  expect(maxAgeMs({ ...base, checkedAt: 5, error: 'timeout', failures: 1 })).toBe(MIN)
  expect(maxAgeMs({ ...base, checkedAt: 5, error: 'not found', failures: 3 })).toBe(4 * MIN)
  expect(maxAgeMs({ ...base, checkedAt: 5, error: 'not found', failures: 20 })).toBe(60 * MIN)
  expect(maxAgeMs({ ...base, state: 'OPEN', checkedAt: 5, pending: 1 })).toBe(MIN)
  expect(maxAgeMs({ ...base, state: 'OPEN', checkedAt: 5 })).toBe(5 * MIN)
  expect(maxAgeMs({ ...base, state: 'OPEN', checkedAt: 5, pending: 1 }, true)).toBe(5 * MIN)
  expect(maxAgeMs({ ...base, state: 'OPEN', checkedAt: 5 }, true)).toBe(25 * MIN)
  expect(maxAgeMs({ ...base, state: 'MERGED', checkedAt: 5 })).toBeUndefined()
})

test('PRs named by commands within a second of each other are fetched in one request', async ($, on) => {
  const w = world(on, 'o/r')
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 21' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr checks 22' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 23' })
  await w.clock.advance(1_000)
  await w.clock.settle()
  expect(w.graphql).toHaveLength(1)
  for (const n of [21, 22, 23]) expect(w.graphql[0]).toContain(`pullRequest(number: ${n})`)
})

test('while gh cannot reach GitHub at all, a new PR keeps being tried every minute', async ($, on) => {
  const w = world(on, 'o/r')
  panes(on).add('pr-tracker')
  await start($, on, w)
  w.offline = true
  await bash($, w, 'gh pr view 41')
  await w.clock.advance(5 * 60_000)
  expect(w.graphql).toHaveLength(6)
})

test('a PR GitHub cannot find is retried less and less often', async ($, on) => {
  const w = world(on, 'o/r')
  await start($, on, w)
  w.missing = [404]
  await bash($, w, 'gh pr view 404')
  await w.clock.advance(16 * 60_000)
  // Every minute would be 17 fetches; backing off 1, 2, 4, 8 minutes makes 5.
  expect(w.graphql).toHaveLength(5)
})

test('with the pane closed and nothing happening for ten minutes, polling slows down', async ($, on) => {
  const w = world(on, 'o/r')
  panes(on)
  await start($, on, w)
  await bash($, w, 'gh pr view 31')
  await w.clock.advance(10 * 60_000)
  const busy = w.graphql.length
  expect(busy).toBeGreaterThanOrEqual(9)
  await w.clock.advance(3 * 60_000)
  expect(w.graphql).toHaveLength(busy)
  await w.clock.advance(3 * 60_000)
  expect(w.graphql).toHaveLength(busy + 1)
})

test('a skill tracks and untracks PRs through the track_prs tool, with no request of its own', async ($, on) => {
  const w = world(on, 'o/r')
  await start($, on, w)
  const tracked = await $.tool.call({
    tool: 'mcp__pr-tracker__track_prs',
    prs: ['51', 'a/b#52', 'https://github.com/c/d/pull/53', 'not a pr'],
  } as never)
  expect(tracked.text).toContain('o/r#51, a/b#52, c/d#53')
  expect(tracked.text).toContain('not a pr')
  await w.clock.advance(1_000)
  await w.clock.settle()
  expect(w.graphql).toHaveLength(1)
  for (const n of [51, 52, 53]) expect(w.graphql[0]).toContain(`pullRequest(number: ${n})`)
  expect(w.statuses.at(-1)).toBe('PRs 3 open · 3 failing · 3 running')
  await $.tool.call({ tool: 'mcp__pr-tracker__track_prs', prs: ['a/b#52', 'c/d#53'], untrack: true } as never)
  expect(w.statuses.at(-1)).toBe('PRs 1 open · 1 failing · 1 running')
})
