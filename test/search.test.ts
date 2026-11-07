import { expect, test } from 'bun:test'

import { translateSearch } from '../src/server/query/search'

test('bare terms AND together; each term is quoted so no FTS5 syntax leaks', () => {
  expect(translateSearch('alpha beta')).toEqual({ kind: 'terms', match: '"alpha" AND "beta"' })
  expect(translateSearch('foo:bar OR (baz')).toEqual({
    kind: 'terms',
    match: '"foobar" AND "OR" AND "baz"',
  })
})

test('quoted phrases survive as phrases', () => {
  expect(translateSearch('alpha "big phrase"')).toEqual({
    kind: 'terms',
    match: '"alpha" AND "big phrase"',
  })
})

test('user -term exclusion becomes FTS5 binary NOT', () => {
  expect(translateSearch('alpha -beta')).toEqual({ kind: 'terms', match: '"alpha" NOT "beta"' })
  expect(translateSearch('a b -c -d')).toEqual({
    kind: 'terms',
    match: '"a" AND "b" NOT "c" NOT "d"',
  })
})

test('exclusion-only input becomes data (answered via NOT EXISTS MATCH)', () => {
  expect(translateSearch('-beta')).toEqual({ kind: 'exclusions', match: '"beta"' })
  expect(translateSearch('-a -b')).toEqual({ kind: 'exclusions', match: '"a" OR "b"' })
})

test('type-ahead appends * to the last positive term', () => {
  expect(translateSearch('alp', { typeAhead: true })).toEqual({ kind: 'terms', match: '"alp"*' })
  expect(translateSearch('alpha "big phrase"', { typeAhead: true })).toEqual({
    kind: 'terms',
    match: '"alpha" AND "big phrase"*',
  })
  expect(translateSearch('alpha -beta', { typeAhead: true })).toEqual({
    kind: 'terms',
    match: '"alpha"* NOT "beta"',
  })
})

test('empty input is empty', () => {
  expect(translateSearch('')).toEqual({ kind: 'empty' })
  expect(translateSearch('   ')).toEqual({ kind: 'empty' })
  expect(translateSearch('-')).toEqual({ kind: 'empty' })
})
