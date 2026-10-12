/** What GitHub says about one PR: the fetcher's payload, a daemon's included. */
export type PrData = {
  title: string
  url: string
  /** OPEN, CLOSED or MERGED; `UNKNOWN` until the first fetch answers. */
  state: string
  isDraft: boolean
  /** MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: string
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or empty when no review is required. */
  review: string
  pass: number
  fail: number
  pending: number
  skipped: number
  failing: string[]
  running: string[]
}

/** One PR's latest fetch: its data, or why it has none. */
export type FetchedPr = {
  /** Epoch ms the fetch answered. */
  fetchedAt: number
  data?: PrData
  error?: string
}

/** Asks for each PR no older than `maxAgeMs`: what a fetcher, built in or a daemon's `fetch`, reads. */
export type FetchRequest = {
  version: 1
  /** The budget shared by every session; a daemon enforces it across them. */
  requestsPerHour: number
  prs: { key: string; maxAgeMs: number }[]
}

/**
 * What a fetcher answers: every requested PR it has a result for, fresh or cached. A key left out has
 * no result yet (held back, or never fetched); one GitHub could not answer carries an `error`.
 */
export type FetchResponse = {
  prs: Record<string, FetchedPr>
  /** Epoch ms until which the budget or GitHub holds fetches back; absent when nothing was held. */
  limitedUntil?: number
  reason?: string
}

export type TrackedPr = PrData & {
  /** `owner/name#number`, the identity a PR is tracked by. */
  key: string
  repo: string
  number: number
  /** Epoch ms of the last answered fetch; 0 before one. */
  checkedAt: number
  /** The last fetch's error, cleared by the next one that answers. */
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'pr-tracker': {
      prs: TrackedPr[]
      /** Index of the first PR chip shown in the one-row inline view. */
      chipOffset: number
    }
  }
}
