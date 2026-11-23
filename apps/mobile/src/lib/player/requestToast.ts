/**
 * What a guest's request toast says for each request status. Says who decided, or that nobody
 * did: a host who passed is not the same as a request that simply ran out of time, and neither is
 * the guest's fault. Typed on plain strings so a status this build doesn't know yet renders
 * nothing instead of a wrong claim.
 */
export type RequestToastTone = 'pending' | 'sync' | 'neutral'

export interface RequestToastCopy {
  message: string
  tone: RequestToastTone
  /** Fades on its own (the request is over). */
  terminal: boolean
}

export function requestToastCopy(status: string): RequestToastCopy | null {
  switch (status) {
    case 'pending':
      return { message: 'Asked the host…', tone: 'pending', terminal: false }
    case 'approved':
      return { message: 'Approved — syncing everyone…', tone: 'sync', terminal: true }
    case 'declined':
      return { message: 'The host passed on that one', tone: 'neutral', terminal: true }
    case 'expired':
      return { message: 'No answer yet — you can ask again', tone: 'neutral', terminal: true }
    case 'lost':
      // The connection dropped while waiting: any answer went with it — nobody decided.
      return { message: "Connection dropped — ask again once you're back", tone: 'neutral', terminal: true }
    case 'dismissed':
      // Older status covering both a host dismissal and a timeout — claim neither.
      return { message: 'Request closed — you can ask again', tone: 'neutral', terminal: true }
    default:
      return null // 'idle', or a status newer than this build
  }
}
