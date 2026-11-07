/**
 * Search input → FTS5. The raw input never reaches MATCH: this translator
 * parses it into terms and emits the dialect FTS5 actually accepts.
 *
 * User grammar: bare terms (AND'd), `"quoted phrases"`, `-term` exclusion,
 * and a trailing `*` on the last term for type-ahead.
 *
 * FTS5 facts pinned against Bun's SQLite 3.53.2: `-term` is NOT syntax (it
 * parses as a broken column filter), unary `NOT` is invalid — exclusion is
 * the binary form `a NOT b` — and `"phrase"*` is valid prefix syntax.
 * A query of exclusions only has no FTS5 expression ("everything except x"),
 * so it is returned as data and the view answers it with `NOT EXISTS MATCH`.
 */

export type SearchQuery =
  { kind: 'empty' } | { kind: 'terms'; match: string } | { kind: 'exclusions'; match: string }

/** Strip FTS5 syntax characters from a bare term (it becomes a quoted term). */
function sanitizeTerm(raw: string): string {
  return raw.replace(/["*()^:]/g, '').trim()
}

export function translateSearch(input: string, opts: { typeAhead?: boolean } = {}): SearchQuery {
  const positives: string[] = []
  const negatives: string[] = []

  const tokenPattern = /"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(input)) !== null) {
    const [, phrase, bare] = match
    if (phrase !== undefined) {
      const clean = phrase.replace(/"/g, '').trim()
      if (clean !== '') positives.push(`"${clean}"`)
      continue
    }
    if (bare === undefined) continue
    let term = bare
    if (term === '-') continue // a lone dash is not a term
    let excluded = false
    if (term.startsWith('-') && term.length > 1) {
      excluded = true
      term = term.slice(1)
    }
    if (term.startsWith('"') || term.endsWith('"')) {
      // A stray quote glued to a bare word — strip and treat as a term.
      term = term.replace(/"/g, '')
    }
    const clean = sanitizeTerm(term)
    if (clean === '') continue
    const quoted = `"${clean}"`
    if (excluded) negatives.push(quoted)
    else positives.push(quoted)
  }

  if (positives.length === 0 && negatives.length === 0) return { kind: 'empty' }

  if (positives.length === 0) {
    // "Everything except these" has no FTS5 expression (unary NOT is invalid);
    // the view answers it as NOT EXISTS (entries_fts MATCH `match`).
    return { kind: 'exclusions', match: negatives.join(' OR ') }
  }

  let last = positives[positives.length - 1]!
  if (opts.typeAhead && !last.endsWith('*')) last = `${last}*`
  const positivePart = [...positives.slice(0, -1), last].join(' AND ')
  const negativePart = negatives.map((n) => `NOT ${n}`).join(' ')
  return {
    kind: 'terms',
    match: negativePart === '' ? positivePart : `${positivePart} ${negativePart}`,
  }
}
