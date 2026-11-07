import { Show, createSignal, onSettled } from 'solid-js'
import type { JSX } from '@solidjs/web'

/**
 * Renders nothing until `ms` has passed.
 *
 * Use it inside a `<Loading fallback>`: reads here finish in single-digit
 * milliseconds, and a spinner that appears and vanishes in that window reads as
 * a glitch rather than feedback. The timer starts when the fallback mounts and
 * is cleared if the data lands first.
 */
export const Delayed = (props: { ms?: number; children: JSX.Element }) => {
  const [show, setShow] = createSignal(false)

  onSettled(() => {
    const timer = setTimeout(() => setShow(true), props.ms ?? 100)
    return () => clearTimeout(timer)
  })

  return <Show when={show()}>{props.children}</Show>
}

export default Delayed
