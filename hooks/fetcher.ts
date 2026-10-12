import type { FetchedPr, FetchRequest, FetchResponse, PrData } from '../types'

const HOUR_MS = 3_600_000
/** How long to stop when GitHub refuses without saying when it resets. */
const REFUSED_PAUSE_MS = 15 * 60_000
/** Cached PRs nobody asked for in this long are dropped from the shared state. */
const CACHE_TTL_MS = 24 * HOUR_MS

type Check = { name?: string; context?: string; status?: string; conclusion?: string | null; state?: string }

/** Buckets a statusCheckRollup: check runs by status/conclusion, commit statuses by state. */
export function summarise(rollup: readonly Check[]) {
  const out = { pass: 0, fail: 0, pending: 0, skipped: 0, failing: [] as string[], running: [] as string[] }
  for (const c of rollup) {
    const name = c.name ?? c.context ?? '?'
    const verdict =
      c.state !== undefined
        ? c.state === 'SUCCESS'
          ? 'pass'
          : c.state === 'PENDING' || c.state === 'EXPECTED'
            ? 'pending'
            : 'fail'
        : c.status !== 'COMPLETED'
          ? 'pending'
          : c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL'
            ? 'pass'
            : c.conclusion === 'SKIPPED'
              ? 'skipped'
              : 'fail'
    out[verdict] += 1
    if (verdict === 'fail') out.failing.push(name)
    if (verdict === 'pending') out.running.push(name)
  }
  return out
}

const PR_FIELDS =
  'number title url state isDraft mergeable reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }'

/** One GraphQL query for every key (`owner/name#n`, already validated), each PR under alias `p<i>`. */
export function batchQuery(keys: readonly string[]): string {
  const parts = keys.map((key, i) => {
    const [repo = '', n = ''] = key.split('#')
    const [owner = '', name = ''] = repo.split('/')
    return `p${i}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${n}) { ${PR_FIELDS} } }`
  })
  return `query { rateLimit { remaining resetAt } ${parts.join(' ')} }`
}

type GraphqlPr = {
  title?: string; url?: string; state?: string; isDraft?: boolean; mergeable?: string; reviewDecision?: string | null
  commits?: { nodes?: { commit?: { statusCheckRollup?: { contexts?: { nodes?: Check[] } } | null } }[] }
}

function prData(pr: GraphqlPr): PrData {
  return {
    title: pr.title ?? '',
    url: pr.url ?? '',
    state: pr.state ?? 'UNKNOWN',
    isDraft: Boolean(pr.isDraft),
    mergeable: pr.mergeable ?? 'UNKNOWN',
    review: pr.reviewDecision ?? '',
    ...summarise(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []),
  }
}

/** The parts of a finished process a batch reads. */
export type Ran = { exitCode: number; stdout: string; stderr: string }

/** Reads one batch's gh output for `keys`: their results, and when GitHub wants fetching to stop until. */
export function parseBatch(r: Ran, keys: readonly string[], now: number): { prs: Record<string, FetchedPr>; pausedUntil?: number } {
  const prs: Record<string, FetchedPr> = {}
  let body: { data?: Record<string, { pullRequest?: GraphqlPr | null } | null> & { rateLimit?: { remaining?: number; resetAt?: string } }; errors?: { type?: string; path?: string[]; message?: string }[] } | undefined
  try {
    body = JSON.parse(r.stdout)
  } catch {
    body = undefined
  }
  // Judged from the response's structure: titles and check names in stdout may say "rate limit" too.
  const refused = body?.errors?.some(e => e.type === 'RATE_LIMITED') ||
    (r.exitCode !== 0 && !body && /rate limit|HTTP 403|HTTP 429/i.test(r.stderr))
  if (refused) {
    const reset = Date.parse(body?.data?.rateLimit?.resetAt ?? '')
    return { prs, pausedUntil: Number.isFinite(reset) ? reset : now + REFUSED_PAUSE_MS }
  }
  const failure = r.stderr.trim().split('\n')[0] || `gh exited ${r.exitCode}`
  for (const [i, key] of keys.entries()) {
    const pr = body?.data?.[`p${i}`]?.pullRequest
    const error = body?.errors?.find(e => e.path?.[0] === `p${i}`)?.message
    prs[key] = pr
      ? { fetchedAt: now, data: prData(pr) }
      : body?.data
        ? { fetchedAt: now, error: error ?? 'not found' }
        : { fetchedAt: now, error: failure, transient: true }
  }
  const limit = body?.data?.rateLimit
  const reset = Date.parse(limit?.resetAt ?? '')
  return { prs, pausedUntil: limit?.remaining === 0 && Number.isFinite(reset) ? reset : undefined }
}

/**
 * What every session on the machine shares through the cache dir: one request budget, GitHub's
 * pause, and the latest result for each PR.
 */
export type SharedState = { version: 1; requests: number[]; pausedUntil: number; prs: Record<string, FetchedPr> }

/** A state file's contents, or an empty state for anything unreadable. */
export function parseState(raw: unknown): SharedState {
  const s = raw as Partial<SharedState> | undefined
  return {
    version: 1,
    requests: Array.isArray(s?.requests) ? s.requests : [],
    pausedUntil: typeof s?.pausedUntil === 'number' ? s.pausedUntil : 0,
    prs: s?.prs && typeof s.prs === 'object' ? s.prs : {},
  }
}

/** The requested PRs whose shared result is older than they allow. */
export function dueKeys(s: SharedState, request: FetchRequest, now: number): string[] {
  return request.prs.filter(r => now - (s.prs[r.key]?.fetchedAt ?? -Infinity) >= r.maxAgeMs).map(r => r.key)
}

/** Why a fetch must wait, and until when; empty when one may go now. */
export function holdOf(s: SharedState, now: number, requestsPerHour: number): Partial<FetchResponse> {
  if (s.pausedUntil > now) return { limitedUntil: s.pausedUntil, reason: 'GitHub rate limit' }
  const recent = s.requests.filter(t => now - t < HOUR_MS)
  if (recent.length < requestsPerHour) return {}
  return { limitedUntil: Math.min(...recent) + HOUR_MS, reason: `${requestsPerHour} gh requests an hour` }
}

/** The shared results for the requested PRs. */
export function answerOf(s: SharedState, request: FetchRequest, extra: Partial<FetchResponse> = {}): FetchResponse {
  return { prs: Object.fromEntries(request.prs.flatMap(r => (s.prs[r.key] ? [[r.key, s.prs[r.key]!]] : []))), ...extra }
}

/** The state after one batch: its request counted, its results and any pause stored, stale entries dropped. */
export function recordBatch(s: SharedState, batch: ReturnType<typeof parseBatch>, now: number): SharedState {
  return {
    version: 1,
    requests: [...s.requests.filter(t => now - t < HOUR_MS), now],
    pausedUntil: Math.max(s.pausedUntil, batch.pausedUntil ?? 0),
    prs: Object.fromEntries(Object.entries({ ...s.prs, ...batch.prs }).filter(([, p]) => now - p.fetchedAt < CACHE_TTL_MS)),
  }
}

/** A daemon's reply when it is a FetchResponse, else undefined. */
export function asFetchResponse(raw: unknown): FetchResponse | undefined {
  const r = raw as Partial<FetchResponse> | undefined
  if (!r || typeof r !== 'object' || !r.prs || typeof r.prs !== 'object') return undefined
  if (Object.values(r.prs).some(p => !p || typeof p.fetchedAt !== 'number')) return undefined
  if (r.limitedUntil !== undefined && typeof r.limitedUntil !== 'number') return undefined
  return r as FetchResponse
}

/**
 * The repo gh treats as the cwd's, from `git config --get-regexp '^remote\.'` output: a remote
 * marked `gh-resolved` (by `gh repo set-default`), else `upstream`, `github`, `origin`, as gh does.
 */
export function repoFromRemotes(config: string): string | undefined {
  const urls: Record<string, string> = {}
  let resolved: [string, string] | undefined
  for (const line of config.split('\n')) {
    const m = /^remote\.(.+)\.(url|gh-resolved) (.+)$/.exec(line.trim())
    if (!m) continue
    if (m[2] === 'url') urls[m[1]!] = m[3]!
    else resolved = [m[1]!, m[3]!]
  }
  const repo = (url?: string) => (url ? /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1] : undefined)
  if (resolved) return resolved[1].includes('/') ? resolved[1] : repo(urls[resolved[0]])
  for (const name of ['upstream', 'github', 'origin']) if (repo(urls[name])) return repo(urls[name])
  return undefined
}
