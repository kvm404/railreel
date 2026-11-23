import { describe, expect, it, vi } from 'vitest'
import { createBackRegistry, dispatchBack, orderBackEntries, type BackEntry } from '@/lib/nav/backStack'

const entry = (id: number, scope: string, layer: BackEntry['layer'], handled = true): BackEntry => ({
  id,
  scope,
  layer,
  handle: vi.fn(() => handled),
})

describe('orderBackEntries', () => {
  it('only consults the given route', () => {
    const order = orderBackEntries([entry(0, 'Lobby-1', 'screen'), entry(1, 'Player-2', 'screen')], 'Player-2')
    expect(order.map((e) => e.id)).toEqual([1])
  })

  it('puts overlays ahead of the screen, newest first within a layer', () => {
    const order = orderBackEntries(
      [entry(0, 'P', 'screen'), entry(1, 'P', 'overlay'), entry(2, 'P', 'screen'), entry(3, 'P', 'overlay')],
      'P',
    )
    expect(order.map((e) => e.id)).toEqual([3, 1, 2, 0])
  })
})

describe('dispatchBack', () => {
  it('stops at the first handler that consumes the press', () => {
    const chat = entry(1, 'P', 'overlay')
    const screen = entry(0, 'P', 'screen')
    expect(dispatchBack([screen, chat], 'P')).toBe(true)
    expect(chat.handle).toHaveBeenCalledOnce()
    expect(screen.handle).not.toHaveBeenCalled()
  })

  it('falls through handlers that decline', () => {
    const declines = entry(1, 'P', 'overlay', false)
    const screen = entry(0, 'P', 'screen')
    expect(dispatchBack([screen, declines], 'P')).toBe(true)
    expect(declines.handle).toHaveBeenCalledOnce()
    expect(screen.handle).toHaveBeenCalledOnce()
  })

  it('reports unhandled when nothing on the top route consumes it (navigator pops)', () => {
    const other = entry(0, 'Lobby-1', 'screen')
    expect(dispatchBack([other], 'Player-2')).toBe(false)
    expect(other.handle).not.toHaveBeenCalled()
    expect(dispatchBack([], 'Home-0')).toBe(false)
  })
})

describe('createBackRegistry', () => {
  it('routes to the latest registration and forgets unregistered handlers', () => {
    const reg = createBackRegistry()
    const screen = vi.fn(() => true)
    const scanner = vi.fn(() => true)
    reg.register('Join-1', 'screen', screen)
    const closeScanner = reg.register('Join-1', 'overlay', scanner)

    expect(reg.dispatch('Join-1')).toBe(true)
    expect(scanner).toHaveBeenCalledOnce()
    expect(screen).not.toHaveBeenCalled()

    closeScanner()
    expect(reg.dispatch('Join-1')).toBe(true)
    expect(screen).toHaveBeenCalledOnce()
  })

  it('tolerates a handler unregistering itself mid-dispatch', () => {
    const reg = createBackRegistry()
    const screen = vi.fn(() => true)
    reg.register('P', 'screen', screen)
    let off = () => {}
    const selfRemoving = vi.fn(() => {
      off()
      return false
    })
    off = reg.register('P', 'overlay', selfRemoving)

    expect(reg.dispatch('P')).toBe(true)
    expect(selfRemoving).toHaveBeenCalledOnce()
    expect(screen).toHaveBeenCalledOnce()
    expect(reg.dispatch('P')).toBe(true)
    expect(selfRemoving).toHaveBeenCalledOnce()
  })
})
