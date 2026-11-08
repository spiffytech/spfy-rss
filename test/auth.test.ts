import { expect, test } from 'bun:test'

import { verifyLogin } from '../src/server/auth'
import { openDatabase } from '../src/server/db'
import { epochMs, newUserId } from '../src/shared/ids'

const NOW = 1_760_000_000_000

function seed(passwordHash: string) {
  const handle = openDatabase(':memory:')
  handle.sqlite.run(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    [newUserId(epochMs(NOW)), 'spiffy', passwordHash, NOW],
  )
  return handle
}

test('a reserved account with no password cannot log in', () => {
  // `''` is the sentinel the import and the test seeder write. It used to reach
  // verifySync, which throws — a 500 on the login path that confirms the name.
  const handle = seed('')
  expect(verifyLogin(handle, 'spiffy', 'anything')).toBeNull()
  handle.sqlite.close()
})

test('a corrupt hash is a failed login, not an exception', () => {
  const handle = seed('$argon2id$not-a-real-hash')
  expect(() => verifyLogin(handle, 'spiffy', 'anything')).not.toThrow()
  expect(verifyLogin(handle, 'spiffy', 'anything')).toBeNull()
  handle.sqlite.close()
})

test('a real credential verifies in both directions', () => {
  const handle = seed(Bun.password.hashSync('hunter2'))
  expect(verifyLogin(handle, 'spiffy', 'hunter2')?.username).toBe('spiffy')
  expect(verifyLogin(handle, 'spiffy', 'wrong')).toBeNull()
  handle.sqlite.close()
})
