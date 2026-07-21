import type {
  PortfolioGenerationInvalidationBroadcastChannelFactory,
  PortfolioGenerationInvalidationBroadcastChannelLike,
} from '../portfolioGenerationInvalidationTransport'

export type FakeBroadcastChannelEventType =
  | 'constructed'
  | 'constructor_failed'
  | 'posted'
  | 'post_failed'
  | 'delivered'
  | 'closed'

export interface FakeBroadcastChannelEvent {
  readonly type: FakeBroadcastChannelEventType
  readonly channelName: string
  readonly participantId: number
}

export interface FakeBroadcastChannelParticipantHandle
  extends PortfolioGenerationInvalidationBroadcastChannelLike {
  readonly participantId: number
}

interface ParticipantState {
  readonly id: number
  readonly channelName: string
  closed: boolean
  listener: ((event: { data: unknown }) => void) | null
  postMessageShouldThrow: boolean
}

export class FakeBroadcastChannelHub {
  private nextParticipantId = 1
  private readonly participants = new Map<number, ParticipantState>()
  private readonly eventLog: FakeBroadcastChannelEvent[] = []
  private readonly constructorFailureQueue: string[] = []
  private pendingDeliveries: Array<() => void> = []
  private synchronousDelivery = true

  createFactory(): PortfolioGenerationInvalidationBroadcastChannelFactory {
    return (channelName: string) => this.createParticipant(channelName)
  }

  failNextConstruction(channelName: string): void {
    this.constructorFailureQueue.push(channelName)
  }

  setPostMessageShouldThrow(participantId: number, shouldThrow: boolean): void {
    const state = this.participants.get(participantId)
    if (state) state.postMessageShouldThrow = shouldThrow
  }

  flush(order: 'fifo' | 'reverse' = 'fifo'): void {
    const pending = this.pendingDeliveries
    this.pendingDeliveries = []
    const ordered = order === 'fifo' ? pending : pending.slice().reverse()
    for (const run of ordered) run()
  }

  get events(): readonly FakeBroadcastChannelEvent[] {
    return this.eventLog.slice()
  }

  get participantCount(): number {
    let count = 0
    for (const state of this.participants.values()) {
      if (!state.closed) count += 1
    }
    return count
  }

  get pendingDeliveryCount(): number {
    return this.pendingDeliveries.length
  }

  private createParticipant(channelName: string): FakeBroadcastChannelParticipantHandle {
    const failIndex = this.constructorFailureQueue.indexOf(channelName)
    if (failIndex >= 0) {
      this.constructorFailureQueue.splice(failIndex, 1)
      this.record('constructor_failed', channelName, -1)
      throw new Error('fake BroadcastChannel constructor failure')
    }

    const id = this.nextParticipantId
    this.nextParticipantId += 1
    const state: ParticipantState = {
      id,
      channelName,
      closed: false,
      listener: null,
      postMessageShouldThrow: false,
    }
    this.participants.set(id, state)
    this.record('constructed', channelName, id)

    const hub = this

    return {
      participantId: id,
      postMessage(message: unknown): void {
        if (state.closed) return
        if (state.postMessageShouldThrow) {
          hub.record('post_failed', channelName, id)
          throw new Error('fake BroadcastChannel postMessage failure')
        }
        hub.record('posted', channelName, id)
        hub.deliver(channelName, id, message)
      },
      close(): void {
        if (state.closed) return
        state.closed = true
        hub.record('closed', channelName, id)
      },
      addEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
        state.listener = listener
      },
      removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
        if (state.listener === listener) state.listener = null
      },
    }
  }

  private deliver(channelName: string, senderId: number, data: unknown): void {
    const run = () => {
      for (const [id, state] of this.participants) {
        if (id === senderId) continue
        if (state.channelName !== channelName) continue
        if (state.closed || !state.listener) continue
        this.record('delivered', channelName, id)
        state.listener({ data })
      }
    }
    this.pendingDeliveries.push(run)
    this.flushImmediatelyIfNeeded()
  }

  setSynchronousDelivery(synchronous: boolean): void {
    this.synchronousDelivery = synchronous
  }

  private flushImmediatelyIfNeeded(): void {
    if (!this.synchronousDelivery) return
    this.flush()
  }

  private record(
    type: FakeBroadcastChannelEventType,
    channelName: string,
    participantId: number,
  ): void {
    this.eventLog.push({ type, channelName, participantId })
  }
}
