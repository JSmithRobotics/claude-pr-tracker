/**
 * Which PRs a shell command acts on. A small shell lexer splits the command into simple commands,
 * drops quotes, heredoc bodies, comments and redirections, and only `gh pr <verb> <target>` names a
 * PR. A link in a body, a title, a heredoc or any other program's arguments names nothing.
 */

/**
 * A PR a command names. `repo` comes from the target URL, `-R`/`--repo` or `GH_REPO`; else `dir`
 * is the folder a `cd` earlier in the command moved to; with neither, the PR is in the cwd's repo.
 */
export type Ref = { repo?: string; dir?: string; number: number }

const VERBS = new Set(['view', 'checks', 'merge', 'ready', 'edit', 'comment', 'diff', 'review', 'reopen', 'close'])
/** Long flags of those verbs that take a value, so the value is never taken for the target. */
const LONG_VALUE = new Set([
  'repo', 'body', 'body-file', 'title', 'json', 'jq', 'template', 'base', 'head', 'milestone', 'subject',
  'add-assignee', 'remove-assignee', 'add-label', 'remove-label', 'add-reviewer', 'remove-reviewer',
  'add-project', 'remove-project', 'match-head-commit', 'author-email', 'interval', 'color',
])
const SHORT_VALUE = new Set(['R', 'b', 'F', 't', 'B', 'q', 'A', 'i'])
/** Words that may lead a simple command without being the program. */
const LEADERS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'env', 'command', 'exec'])

const PR_URL_ONLY = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/
const PR_NUMBER = /^#?(\d+)$/
const ASSIGNMENT = /^([A-Za-z_]\w*)=(.*)$/s

/**
 * The simple commands in `command`, each as its words with quoting removed. Splits on newlines,
 * `;`, `&`, `&&`, `|`, `||`, parentheses and command substitution; skips comments, redirection
 * targets and heredoc bodies. Quoted text stays inside its word, so it never starts a command.
 */
export function simpleCommands(command: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  /** What the next finished word is: a redirection target to drop, or a heredoc delimiter. */
  let pending: 'target' | 'heredoc' | undefined
  const heredocs: string[] = []
  const endWord = () => {
    if (!inWord) return
    if (pending === 'heredoc') heredocs.push(word)
    else if (pending !== 'target') words.push(word)
    pending = undefined
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) out.push(words)
    words = []
  }
  const n = command.length
  let i = 0
  while (i < n) {
    const c = command[i]!
    const next = command[i + 1]
    if (c === '\\') {
      if (next === '\n') i += 2
      else {
        word += next ?? ''
        inWord = true
        i += 2
      }
      continue
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      word += command.slice(i + 1, end < 0 ? n : end)
      inWord = true
      i = end < 0 ? n : end + 1
      continue
    }
    if (c === '"') {
      i += 1
      while (i < n && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < n && '"\\$`\n'.includes(command[i + 1]!)) i += 1
        word += command[i]
        i += 1
      }
      inWord = true
      i += 1
      continue
    }
    if (c === '#' && !inWord) {
      while (i < n && command[i] !== '\n') i += 1
      continue
    }
    if (c === '\n') {
      endCommand()
      i += 1
      // Heredoc bodies start on the line after their operator and end at a line holding the delimiter.
      for (const delim of heredocs.splice(0)) {
        while (i < n) {
          const eol = command.indexOf('\n', i)
          const line = command.slice(i, eol < 0 ? n : eol)
          i = eol < 0 ? n : eol + 1
          if (line.trim() === delim) break
        }
      }
      continue
    }
    if (c === ' ' || c === '\t') {
      endWord()
      i += 1
      continue
    }
    if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      // A word of digits right before is the descriptor being redirected, not an argument.
      if (inWord && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      }
      endWord()
      if (c === '<' && next === '<' && command[i + 2] === '<') {
        i += 3
        pending = 'target'
      } else if (c === '<' && next === '<') {
        i += command[i + 2] === '-' ? 3 : 2
        pending = 'heredoc'
      } else {
        i += 1
        while (i < n && (command[i] === '>' || command[i] === '&' || command[i] === '|')) i += 1
        pending = 'target'
      }
      continue
    }
    if (c === '$' && next === '(') {
      endCommand()
      i += 2
      continue
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '`') {
      endCommand()
      i += 1
      continue
    }
    word += c
    inWord = true
    i += 1
  }
  endCommand()
  return out
}

/** `owner/name` from a `-R` value: `owner/name`, `host/owner/name` or a repo URL. */
function repoOf(value: string): string | undefined {
  const parts = value.replace(/^https?:\/\//, '').replace(/\.git$/, '').split('/').filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join('/') : undefined
}

/** The folder `cd <arg>` moves to from `from`; undefined when the shell would have to expand it. */
function cdTo(from: string | undefined, arg: string | undefined): string | undefined {
  if (arg === undefined || arg === '' || arg === '-' || /[$`*?]/.test(arg)) return undefined
  if (arg.startsWith('/') || arg.startsWith('~')) return arg
  return from ? `${from.replace(/\/$/, '')}/${arg}` : arg
}

type Gh = { verb: string; target?: string; repo?: string }

/** The verb, target and repo flag of `gh pr <verb> ...`, or undefined when `words` is not one. */
function ghPr(words: readonly string[]): Gh | undefined {
  const [program, group, verb, ...args] = words
  if (!program || !/(?:^|\/)gh(?:\.exe)?$/.test(program) || group !== 'pr' || !verb) return undefined
  // `close` and `reopen` take `-c/--comment <text>`; elsewhere `-c` is a switch.
  const takesComment = verb === 'close' || verb === 'reopen'
  let repo: string | undefined
  let target: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!
    if (a === '--') {
      target ??= args[i + 1]
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = a.slice(2, eq < 0 ? undefined : eq)
      const takes = LONG_VALUE.has(name) || (takesComment && name === 'comment')
      const value = eq >= 0 ? a.slice(eq + 1) : takes ? args[++i] : undefined
      if (name === 'repo' && value) repo = repoOf(value)
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      const letter = a[1]!
      const takes = SHORT_VALUE.has(letter) || (takesComment && letter === 'c')
      if (!takes) continue
      const value = a.length > 2 ? a.slice(2).replace(/^=/, '') : args[++i]
      if (letter === 'R' && value) repo = repoOf(value)
      continue
    }
    target ??= a
  }
  return { verb, target, repo }
}

/** The script of a `bash|sh|zsh -c <script>` among `words`, wherever the shell sits in them. */
function nestedScript(words: readonly string[]): string | undefined {
  const at = words.findIndex(w => /(?:^|\/)(?:ba|z|da)?sh$/.test(w))
  if (at < 0) return undefined
  for (let i = at + 1; i < words.length - 1; i += 1) {
    const w = words[i]!
    if (!w.startsWith('-')) return undefined
    if (/^-[a-z]*c[a-z]*$/.test(w)) return words[i + 1]
  }
  return undefined
}

function ghPrInvocations(command: string, depth = 0): { gh: Gh; envRepo?: string; dir?: string; cd: boolean }[] {
  const found: { gh: Gh; envRepo?: string; dir?: string; cd: boolean }[] = []
  let exported: string | undefined
  let dir: string | undefined
  let cd = false
  for (const all of simpleCommands(command)) {
    let envRepo = exported
    let k = 0
    for (; k < all.length; k += 1) {
      const w = all[k]!
      const assign = ASSIGNMENT.exec(w)
      if (assign) {
        if (assign[1] === 'GH_REPO') envRepo = repoOf(assign[2] ?? '')
      } else if (!LEADERS.has(w)) break
    }
    const words = all.slice(k)
    if (words.length === 0) continue
    if (words[0] === 'export') {
      for (const w of words.slice(1)) {
        const assign = ASSIGNMENT.exec(w)
        if (assign?.[1] === 'GH_REPO') exported = repoOf(assign[2] ?? '')
      }
      continue
    }
    if (words[0] === 'cd' || words[0] === 'pushd') {
      dir = cdTo(dir, words[1])
      cd = true
      continue
    }
    const gh = ghPr(words)
    if (gh) found.push({ gh, envRepo, dir, cd })
    // A script handed to a shell (`bash -lc '…'`, also through `docker exec` or `ssh`) runs in a
    // folder this command cannot see, so its bare numbers name no repo.
    const script = nestedScript(words)
    if (script !== undefined && depth < 3) {
      for (const inner of ghPrInvocations(script, depth + 1)) {
        found.push({ ...inner, envRepo: inner.envRepo ?? envRepo, dir: undefined, cd: true })
      }
    }
  }
  return found
}

/**
 * The PRs `command` acts on: the target of each `gh pr <verb>` (a number, `#n` or a pull URL).
 * `-R` applies to its own invocation only. A bare number after a `cd` names the PR in that folder's
 * repo, and is left out when the folder is not a plain path.
 */
export function refsInCommand(command: string): Ref[] {
  const refs: Ref[] = []
  for (const { gh, envRepo, dir, cd } of ghPrInvocations(command)) {
    if (!VERBS.has(gh.verb) || !gh.target) continue
    const url = PR_URL_ONLY.exec(gh.target)
    if (url) {
      refs.push({ repo: url[1]!, number: Number(url[2]) })
      continue
    }
    const num = PR_NUMBER.exec(gh.target)
    if (!num) continue
    const number = Number(num[1])
    const repo = gh.repo ?? envRepo
    if (repo) refs.push({ repo, number })
    else if (dir) refs.push({ dir, number })
    else if (!cd) refs.push({ number })
  }
  return refs
}

/** Whether `command` runs `gh pr create`, not merely mentions it. */
export function createsPr(command: string): boolean {
  return ghPrInvocations(command).some(({ gh }) => gh.verb === 'create')
}

/** The PR URLs `gh pr create` printed: each on a line of its own, as gh prints the new PR. */
export function createdPrs(stdout: string): Ref[] {
  return stdout.split('\n').flatMap(line => {
    const m = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(line.trim())
    return m ? [{ repo: m[1]!, number: Number(m[2]) }] : []
  })
}
