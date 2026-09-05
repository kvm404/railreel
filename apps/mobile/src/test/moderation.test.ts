import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  encodeMsg,
  parseClientMsg,
  parseServerMsg,
  isPlaybackRequest,
  isPlaybackRequestDecision,
  type ClientMsg,
  type ServerMsg,
  type PlaybackRequestMsg,
  type PlaybackRequestDecisionMsg,
} from '@/lib/protocol'

/**
 * Moderation session controller test harness simulating the SessionProvider host/follower state machine.
 */
class ModerationTestHarness {
  // Host state
  hostPlayer = {
    currentTime: 100,
    isPlaying: true,
    pause() {
      this.isPlaying = false
    },
    seekTo(posSec: number) {
      this.currentTime = posSec
    },
  }

  pendingRequests: Array<{
    requestId: string
    requesterId: string
    requesterName: string
    action: 'pause' | 'rewind'
    seconds?: number
    receivedAt: number
  }> = []

  broadcastedDecisions: PlaybackRequestDecisionMsg[] = []
  publishedHostPlaybacks: Array<{ positionSec: number; isPlaying: boolean }> = []
  autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // Follower state
  followerState = {
    id: 'follower_1',
    grant: 'grant_secret_1',
    status: 'idle' as 'idle' | 'pending' | 'approved' | 'dismissed',
    activeRequestId: null as string | null,
    toastDismissTimer: null as ReturnType<typeof setTimeout> | null,
  }

  // Follower sends a playback request
  sendPlaybackRequest(action: 'pause' | 'rewind', seconds?: number): PlaybackRequestMsg {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.followerState.activeRequestId = requestId
    this.followerState.status = 'pending'

    const msg: PlaybackRequestMsg = {
      t: 'playbackRequest',
      id: this.followerState.id,
      grant: this.followerState.grant,
      requestId,
      action,
      seconds: typeof seconds === 'number' && seconds > 0 ? seconds : (action === 'rewind' ? 15 : undefined),
    }

    // Deliver to host
    this.hostReceivePlaybackRequest(msg, 'Riya')
    return msg
  }

  // Host receives a playback request
  hostReceivePlaybackRequest(msg: PlaybackRequestMsg, requesterName = 'Guest') {
    // Prevent duplicate request ID
    if (this.pendingRequests.some((r) => r.requestId === msg.requestId)) return

    const req = {
      requestId: msg.requestId,
      requesterId: msg.id,
      requesterName,
      action: msg.action,
      seconds: msg.seconds,
      receivedAt: Date.now(),
    }

    this.pendingRequests.push(req)

    // 10s auto-dismiss timer
    const timer = setTimeout(() => {
      this.handlePlaybackRequest(req.requestId, false)
    }, 10_000)
    this.autoDismissTimers.set(req.requestId, timer)
  }

  // Host resolves a request
  handlePlaybackRequest(requestId: string, approved: boolean) {
    const timer = this.autoDismissTimers.get(requestId)
    if (timer) {
      clearTimeout(timer)
      this.autoDismissTimers.delete(requestId)
    }

    const index = this.pendingRequests.findIndex((r) => r.requestId === requestId)
    if (index === -1) return
    const [req] = this.pendingRequests.splice(index, 1)
    if (!req) return

    if (approved) {
      if (req.action === 'pause') {
        this.hostPlayer.pause()
        this.publishedHostPlaybacks.push({
          positionSec: this.hostPlayer.currentTime,
          isPlaying: false,
        })
      } else if (req.action === 'rewind') {
        const delta = typeof req.seconds === 'number' && req.seconds > 0 ? req.seconds : 15
        const target = Math.max(0, this.hostPlayer.currentTime - delta)
        this.hostPlayer.seekTo(target)
        this.publishedHostPlaybacks.push({
          positionSec: target,
          isPlaying: this.hostPlayer.isPlaying,
        })
      }

      const decision: PlaybackRequestDecisionMsg = {
        t: 'playbackRequestDecision',
        requestId: req.requestId,
        requesterId: req.requesterId,
        approved: true,
        action: req.action,
        seconds: req.seconds,
      }
      this.broadcastedDecisions.push(decision)
      this.followerReceiveDecision(decision)
    } else {
      const decision: PlaybackRequestDecisionMsg = {
        t: 'playbackRequestDecision',
        requestId: req.requestId,
        requesterId: req.requesterId,
        approved: false,
        action: req.action,
        seconds: req.seconds,
      }
      this.broadcastedDecisions.push(decision)
      this.followerReceiveDecision(decision)
    }
  }

  // Follower receives decision from host
  followerReceiveDecision(decision: PlaybackRequestDecisionMsg) {
    if (
      decision.requesterId === this.followerState.id ||
      decision.requestId === this.followerState.activeRequestId
    ) {
      this.followerState.status = decision.approved ? 'approved' : 'dismissed'

      if (this.followerState.toastDismissTimer) {
        clearTimeout(this.followerState.toastDismissTimer)
      }
      this.followerState.toastDismissTimer = setTimeout(() => {
        this.followerState.status = 'idle'
        this.followerState.activeRequestId = null
      }, 3000)
    }
  }

  cleanup() {
    this.autoDismissTimers.forEach((t) => clearTimeout(t))
    this.autoDismissTimers.clear()
    if (this.followerState.toastDismissTimer) {
      clearTimeout(this.followerState.toastDismissTimer)
      this.followerState.toastDismissTimer = null
    }
  }
}

describe('Milestone 2: Follower Playback Requests & Host Moderation', () => {
  describe('Protocol Message Serialization & Parsing', () => {
    it('serializes and parses a valid client playbackRequest for pause', () => {
      const msg: ClientMsg = {
        t: 'playbackRequest',
        id: 'client_123',
        grant: 'grant_secret_xyz',
        requestId: 'req_001',
        action: 'pause',
      }

      const raw = encodeMsg(msg)
      const parsed = parseClientMsg(raw)

      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.msg).toEqual(msg)
        expect(isPlaybackRequest(parsed.msg)).toBe(true)
      }
    })

    it('serializes and parses a valid client playbackRequest for rewind with seconds', () => {
      const msg: ClientMsg = {
        t: 'playbackRequest',
        id: 'client_123',
        grant: 'grant_secret_xyz',
        requestId: 'req_002',
        action: 'rewind',
        seconds: 30,
      }

      const raw = encodeMsg(msg)
      const parsed = parseClientMsg(raw)

      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.msg).toEqual(msg)
        expect(isPlaybackRequest(parsed.msg)).toBe(true)
      }
    })

    it('serializes and parses a valid server playbackRequestDecision (approved pause)', () => {
      const msg: ServerMsg = {
        t: 'playbackRequestDecision',
        requestId: 'req_001',
        requesterId: 'client_123',
        approved: true,
        action: 'pause',
      }

      const raw = encodeMsg(msg)
      const parsed = parseServerMsg(raw)

      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.msg).toEqual(msg)
        expect(isPlaybackRequestDecision(parsed.msg)).toBe(true)
      }
    })

    it('serializes and parses a valid server playbackRequestDecision (dismissed rewind)', () => {
      const msg: ServerMsg = {
        t: 'playbackRequestDecision',
        requestId: 'req_002',
        requesterId: 'client_123',
        approved: false,
        action: 'rewind',
        seconds: 15,
      }

      const raw = encodeMsg(msg)
      const parsed = parseServerMsg(raw)

      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.msg).toEqual(msg)
        expect(isPlaybackRequestDecision(parsed.msg)).toBe(true)
      }
    })

    it('does NOT conflate playbackRequestDecision with lobby requestDecision', () => {
      const joinDecisionMsg: ServerMsg = {
        t: 'requestDecision',
        id: 'client_123',
        approved: true,
      }

      const playbackDecisionMsg: ServerMsg = {
        t: 'playbackRequestDecision',
        requestId: 'req_001',
        requesterId: 'client_123',
        approved: true,
        action: 'pause',
      }

      expect(joinDecisionMsg.t).toBe('requestDecision')
      expect(playbackDecisionMsg.t).toBe('playbackRequestDecision')

      // Type guards verify schema non-overlap
      expect(isPlaybackRequestDecision(joinDecisionMsg)).toBe(false)
      expect(isPlaybackRequestDecision(playbackDecisionMsg)).toBe(true)
    })

    it('rejects invalid or malformed playbackRequest messages in isPlaybackRequest', () => {
      expect(isPlaybackRequest(null)).toBe(false)
      expect(isPlaybackRequest({})).toBe(false)
      expect(
        isPlaybackRequest({
          t: 'playbackRequest',
          id: 'c1',
          grant: 'g1',
          requestId: 'r1',
          action: 'invalid_action',
        }),
      ).toBe(false)
      expect(
        isPlaybackRequest({
          t: 'playbackRequest',
          id: 'c1',
          grant: 'g1',
          // missing requestId
          action: 'pause',
        }),
      ).toBe(false)
      expect(
        isPlaybackRequest({
          t: 'playbackRequest',
          id: 'c1',
          grant: 'g1',
          requestId: 'r1',
          action: 'rewind',
          seconds: -5, // negative seconds invalid
        }),
      ).toBe(false)
    })

    it('rejects invalid playbackRequestDecision messages in isPlaybackRequestDecision', () => {
      expect(isPlaybackRequestDecision(null)).toBe(false)
      expect(isPlaybackRequestDecision({})).toBe(false)
      expect(
        isPlaybackRequestDecision({
          t: 'playbackRequestDecision',
          requestId: 'r1',
          requesterId: 'c1',
          // missing approved
          action: 'pause',
        }),
      ).toBe(false)
      expect(
        isPlaybackRequestDecision({
          t: 'playbackRequestDecision',
          requestId: 'r1',
          requesterId: 'c1',
          approved: 'yes', // not a boolean
          action: 'pause',
        }),
      ).toBe(false)
    })
  })

  describe('Request Dispatch & Host Moderation Decisions', () => {
    let harness: ModerationTestHarness

    beforeEach(() => {
      vi.useFakeTimers()
      harness = new ModerationTestHarness()
    })

    afterEach(() => {
      harness.cleanup()
      vi.restoreAllMocks()
    })

    it('transitions follower to pending upon sending playback request', () => {
      expect(harness.followerState.status).toBe('idle')
      const msg = harness.sendPlaybackRequest('pause')

      expect(harness.followerState.status).toBe('pending')
      expect(harness.followerState.activeRequestId).toBe(msg.requestId)
      expect(harness.pendingRequests).toHaveLength(1)
      expect(harness.pendingRequests[0]!.action).toBe('pause')
    })

    it('handles host approval of pause request', () => {
      harness.hostPlayer.currentTime = 120
      harness.hostPlayer.isPlaying = true

      const msg = harness.sendPlaybackRequest('pause')
      expect(harness.pendingRequests).toHaveLength(1)

      harness.handlePlaybackRequest(msg.requestId, true)

      // Host player paused
      expect(harness.hostPlayer.isPlaying).toBe(false)
      expect(harness.hostPlayer.currentTime).toBe(120)

      // Room playback state published
      expect(harness.publishedHostPlaybacks).toHaveLength(1)
      expect(harness.publishedHostPlaybacks[0]).toEqual({
        positionSec: 120,
        isPlaying: false,
      })

      // Decision broadcasted
      expect(harness.broadcastedDecisions).toHaveLength(1)
      expect(harness.broadcastedDecisions[0]).toEqual({
        t: 'playbackRequestDecision',
        requestId: msg.requestId,
        requesterId: harness.followerState.id,
        approved: true,
        action: 'pause',
        seconds: undefined,
      })

      // Request removed from host queue
      expect(harness.pendingRequests).toHaveLength(0)

      // Follower transitions to approved
      expect(harness.followerState.status).toBe('approved')

      // Auto-fades to idle after 3s
      vi.advanceTimersByTime(2999)
      expect(harness.followerState.status).toBe('approved')
      vi.advanceTimersByTime(2)
      expect(harness.followerState.status).toBe('idle')
    })

    it('handles host approval of rewind request with default 15s', () => {
      harness.hostPlayer.currentTime = 80
      harness.hostPlayer.isPlaying = true

      const msg = harness.sendPlaybackRequest('rewind')
      harness.handlePlaybackRequest(msg.requestId, true)

      // Host player sought backward by 15s (80 - 15 = 65)
      expect(harness.hostPlayer.currentTime).toBe(65)
      expect(harness.hostPlayer.isPlaying).toBe(true)

      // Broadcast decision
      expect(harness.broadcastedDecisions[0]).toEqual({
        t: 'playbackRequestDecision',
        requestId: msg.requestId,
        requesterId: harness.followerState.id,
        approved: true,
        action: 'rewind',
        seconds: 15,
      })
    })

    it('handles host approval of rewind request with custom seconds', () => {
      harness.hostPlayer.currentTime = 100
      harness.hostPlayer.isPlaying = true

      const msg = harness.sendPlaybackRequest('rewind', 30)
      harness.handlePlaybackRequest(msg.requestId, true)

      // Host player sought backward by 30s (100 - 30 = 70)
      expect(harness.hostPlayer.currentTime).toBe(70)
      expect(harness.hostPlayer.isPlaying).toBe(true)
      expect(harness.broadcastedDecisions[0]!.seconds).toBe(30)
    })

    it('strictly clamps rewind position at t=0 when rewind exceeds current playhead', () => {
      harness.hostPlayer.currentTime = 8 // At 8 seconds
      harness.hostPlayer.isPlaying = true

      const msg = harness.sendPlaybackRequest('rewind', 15) // Rewind 15s
      harness.handlePlaybackRequest(msg.requestId, true)

      // Clamped to 0 (not -7)
      expect(harness.hostPlayer.currentTime).toBe(0)
      expect(harness.publishedHostPlaybacks[0]!.positionSec).toBe(0)
    })

    it('strictly clamps rewind position at t=0 when rewind is requested from t=0', () => {
      harness.hostPlayer.currentTime = 0
      harness.hostPlayer.isPlaying = false

      const msg = harness.sendPlaybackRequest('rewind', 15)
      harness.handlePlaybackRequest(msg.requestId, true)

      expect(harness.hostPlayer.currentTime).toBe(0)
      expect(harness.publishedHostPlaybacks[0]!.positionSec).toBe(0)
    })

    it('handles host dismissal of request without disturbing playback', () => {
      harness.hostPlayer.currentTime = 150
      harness.hostPlayer.isPlaying = true

      const msg = harness.sendPlaybackRequest('pause')
      harness.handlePlaybackRequest(msg.requestId, false)

      // Host playback undisturbed
      expect(harness.hostPlayer.currentTime).toBe(150)
      expect(harness.hostPlayer.isPlaying).toBe(true)
      expect(harness.publishedHostPlaybacks).toHaveLength(0)

      // Broadcasted with approved: false
      expect(harness.broadcastedDecisions[0]).toEqual({
        t: 'playbackRequestDecision',
        requestId: msg.requestId,
        requesterId: harness.followerState.id,
        approved: false,
        action: 'pause',
        seconds: undefined,
      })

      // Follower status transitions to dismissed
      expect(harness.followerState.status).toBe('dismissed')

      // Auto-fades to idle after 3s
      vi.advanceTimersByTime(3000)
      expect(harness.followerState.status).toBe('idle')
    })
  })

  describe('Auto-Dismiss Timeout Logic', () => {
    let harness: ModerationTestHarness

    beforeEach(() => {
      vi.useFakeTimers()
      harness = new ModerationTestHarness()
    })

    afterEach(() => {
      harness.cleanup()
      vi.restoreAllMocks()
    })

    it('automatically dismisses unhandled playback request after exactly 10 seconds', () => {
      const msg = harness.sendPlaybackRequest('pause')
      expect(harness.pendingRequests).toHaveLength(1)

      // After 5s, still pending
      vi.advanceTimersByTime(5000)
      expect(harness.pendingRequests).toHaveLength(1)
      expect(harness.broadcastedDecisions).toHaveLength(0)
      expect(harness.followerState.status).toBe('pending')

      // Advance remaining 5s (total 10s)
      vi.advanceTimersByTime(5000)

      // Request was auto-dismissed
      expect(harness.pendingRequests).toHaveLength(0)
      expect(harness.broadcastedDecisions).toHaveLength(1)
      expect(harness.broadcastedDecisions[0]).toEqual({
        t: 'playbackRequestDecision',
        requestId: msg.requestId,
        requesterId: harness.followerState.id,
        approved: false,
        action: 'pause',
        seconds: undefined,
      })

      expect(harness.followerState.status).toBe('dismissed')
    })

    it('cancels auto-dismiss timer when host manually approves or dismisses before timeout', () => {
      const msg = harness.sendPlaybackRequest('pause')

      // Host approves after 3 seconds
      vi.advanceTimersByTime(3000)
      harness.handlePlaybackRequest(msg.requestId, true)

      expect(harness.broadcastedDecisions).toHaveLength(1)
      expect(harness.broadcastedDecisions[0]!.approved).toBe(true)

      // Advancing past 10s should NOT trigger auto-dismissal
      vi.advanceTimersByTime(10000)
      expect(harness.broadcastedDecisions).toHaveLength(1) // Still just the 1 manual decision
    })
  })

  describe('Multiple Sequential and Concurrent Requests', () => {
    let harness: ModerationTestHarness

    beforeEach(() => {
      vi.useFakeTimers()
      harness = new ModerationTestHarness()
    })

    afterEach(() => {
      harness.cleanup()
      vi.restoreAllMocks()
    })

    it('handles multiple sequential requests across different participants', () => {
      // 1. First request: Riya requests pause -> Host approves
      const req1: PlaybackRequestMsg = {
        t: 'playbackRequest',
        id: 'client_riya',
        grant: 'g_riya',
        requestId: 'req_seq_1',
        action: 'pause',
      }
      harness.hostReceivePlaybackRequest(req1, 'Riya')
      expect(harness.pendingRequests).toHaveLength(1)
      harness.handlePlaybackRequest(req1.requestId, true)
      expect(harness.hostPlayer.isPlaying).toBe(false)

      // 2. Second request: Alex requests rewind -> Host dismisses
      const req2: PlaybackRequestMsg = {
        t: 'playbackRequest',
        id: 'client_alex',
        grant: 'g_alex',
        requestId: 'req_seq_2',
        action: 'rewind',
        seconds: 15,
      }
      harness.hostReceivePlaybackRequest(req2, 'Alex')
      expect(harness.pendingRequests).toHaveLength(1)
      harness.handlePlaybackRequest(req2.requestId, false)

      expect(harness.broadcastedDecisions).toHaveLength(2)
      expect(harness.broadcastedDecisions[0]!.requestId).toBe('req_seq_1')
      expect(harness.broadcastedDecisions[0]!.approved).toBe(true)
      expect(harness.broadcastedDecisions[1]!.requestId).toBe('req_seq_2')
      expect(harness.broadcastedDecisions[1]!.approved).toBe(false)
      expect(harness.pendingRequests).toHaveLength(0)
    })

    it('maintains FIFO queue for concurrent requests from multiple followers', () => {
      const req1: PlaybackRequestMsg = {
        t: 'playbackRequest',
        id: 'client_riya',
        grant: 'g_riya',
        requestId: 'req_concurrent_1',
        action: 'pause',
      }
      const req2: PlaybackRequestMsg = {
        t: 'playbackRequest',
        id: 'client_alex',
        grant: 'g_alex',
        requestId: 'req_concurrent_2',
        action: 'rewind',
        seconds: 20,
      }

      harness.hostReceivePlaybackRequest(req1, 'Riya')
      harness.hostReceivePlaybackRequest(req2, 'Alex')

      expect(harness.pendingRequests).toHaveLength(2)
      expect(harness.pendingRequests[0]!.requestId).toBe('req_concurrent_1')
      expect(harness.pendingRequests[1]!.requestId).toBe('req_concurrent_2')

      // Host handles first request
      harness.handlePlaybackRequest(req1.requestId, true)
      expect(harness.pendingRequests).toHaveLength(1)
      expect(harness.pendingRequests[0]!.requestId).toBe('req_concurrent_2')

      // Host handles second request
      harness.handlePlaybackRequest(req2.requestId, true)
      expect(harness.pendingRequests).toHaveLength(0)

      expect(harness.broadcastedDecisions).toHaveLength(2)
      expect(harness.broadcastedDecisions[0]!.requestId).toBe('req_concurrent_1')
      expect(harness.broadcastedDecisions[1]!.requestId).toBe('req_concurrent_2')
    })

    it('prevents duplicate request IDs in host queue', () => {
      const req: PlaybackRequestMsg = {
        t: 'playbackRequest',
        id: 'client_riya',
        grant: 'g_riya',
        requestId: 'req_dup_test',
        action: 'pause',
      }

      harness.hostReceivePlaybackRequest(req, 'Riya')
      harness.hostReceivePlaybackRequest(req, 'Riya') // Duplicate delivery

      expect(harness.pendingRequests).toHaveLength(1)
    })

    it('isolates follower resolution to decisions matching the specific client', () => {
      harness.followerState.id = 'client_riya'
      harness.followerState.activeRequestId = 'req_for_riya'
      harness.followerState.status = 'pending'

      // An unrelated decision for Alex arrives
      const decisionForAlex: PlaybackRequestDecisionMsg = {
        t: 'playbackRequestDecision',
        requestId: 'req_for_alex',
        requesterId: 'client_alex',
        approved: true,
        action: 'pause',
      }
      harness.followerReceiveDecision(decisionForAlex)

      // Riya's status remains pending
      expect(harness.followerState.status).toBe('pending')

      // Decision for Riya arrives
      const decisionForRiya: PlaybackRequestDecisionMsg = {
        t: 'playbackRequestDecision',
        requestId: 'req_for_riya',
        requesterId: 'client_riya',
        approved: true,
        action: 'pause',
      }
      harness.followerReceiveDecision(decisionForRiya)

      // Riya's status updates to approved
      expect(harness.followerState.status).toBe('approved')
    })
  })
})
