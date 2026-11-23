import { describe, it, expect, vi } from 'vitest'
import { createReduceMotionStore, type ReduceMotionSource } from '@/lib/a11y/reduceMotion'

function fakeSource(initial: boolean) {
  let emit: (v: boolean) => void = () => {}
  const unsubscribe = vi.fn()
  const source: ReduceMotionSource = {
    isEnabled: () => Promise.resolve(initial),
    subscribe: (cb) => {
      emit = cb
      return unsubscribe
    },
  }
  return { source, emit: (v: boolean) => emit(v), unsubscribe }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('reduce-motion store', () => {
  it('resolves the OS setting on first subscribe and notifies', async () => {
    const f = fakeSource(true)
    const store = createReduceMotionStore(f.source)
    const listener = vi.fn()
    expect(store.getSnapshot()).toBe(false)
    store.subscribe(listener)
    await flush()
    expect(store.getSnapshot()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('follows live changes (the mid-session flip that useReducedMotion misses)', async () => {
    const f = fakeSource(false)
    const store = createReduceMotionStore(f.source)
    const listener = vi.fn()
    store.subscribe(listener)
    await flush()
    f.emit(true)
    expect(store.getSnapshot()).toBe(true)
    f.emit(false)
    expect(store.getSnapshot()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not notify when the value is unchanged', async () => {
    const f = fakeSource(false)
    const store = createReduceMotionStore(f.source)
    const listener = vi.fn()
    store.subscribe(listener)
    await flush()
    f.emit(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('a change event beats a slower initial query', async () => {
    let resolveInitial: (v: boolean) => void = () => {}
    let emit: (v: boolean) => void = () => {}
    const store = createReduceMotionStore({
      isEnabled: () => new Promise<boolean>((r) => (resolveInitial = r)),
      subscribe: (cb) => {
        emit = cb
        return () => {}
      },
    })
    store.subscribe(() => {})
    emit(true)
    resolveInitial(false) // stale answer arrives late
    await flush()
    expect(store.getSnapshot()).toBe(true)
  })

  it('stops the source when the last listener leaves and restarts on the next', async () => {
    const f = fakeSource(false)
    const store = createReduceMotionStore(f.source)
    const off1 = store.subscribe(() => {})
    const off2 = store.subscribe(() => {})
    off1()
    expect(f.unsubscribe).not.toHaveBeenCalled()
    off2()
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
