/** Exhaustive `switch` tail: turns a missed union case into a type error. */
export function assertNever(value: never): never {
  throw new Error(`unexpected case: ${JSON.stringify(value)}`)
}
