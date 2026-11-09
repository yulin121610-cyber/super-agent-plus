/** Routing graph for a Ticket or a Thread, read again on every panel poll. */
import { liveTicket, threadKey, ticketStage, type Decision, type DecisionKind, type Thread, type Ticket, type Trigger,
  type TriggerDisposition } from '../../core/index.ts'
import type { Reason } from '../../core/reasons.ts'
import { decisionView, threadTitle, type ActorView, type DecisionOutcome, type Snapshot } from './records.ts'
import { preview } from './text.ts'

/** Later inputs are capped; origins, hand-backs and Triggers waiting for Eval are kept, and human inputs outrank bots. */
const FEEDBACK_LIMIT = 24
const ROUTED: readonly DecisionKind[] = ['accept', 'reopen', 'stop', 'unavailable']

export interface CallGraphThread { key: string; source: string; title: string; subscriptions: number }
export interface CallGraphTrigger {
  id: string
  kind: 'trigger'
  /** `origin` opened a Ticket through Eval; `feedback` reached a Ticket by Subscription, including one later handed back. */
  role: 'origin' | 'feedback'
  triggerId: string
  at: string
  preview: string
  actor: ActorView
  human: boolean
  thread: string
  pending?: 'queued' | 'evaluating'
}
export interface CallGraphRouter {
  id: string
  kind: 'router'
  decisionId?: string
  outcome?: DecisionOutcome
  reason?: Reason[]
  at?: string
  thread: string
  pending?: 'queued' | 'evaluating'
  /** Handed back, and not yet queued or decided again. */
  returned?: true
  triggerIds: string[]
}
export type CallGraphWorker = {
  id: string
  kind: 'worker'
  ticketId: string
  title: string
  focus: boolean
  /** Every Thread in scope that subscribes this Ticket does so for context only. */
  context: boolean
  createdAt: string
  state: 'open' | 'ended'
  ended: Ticket['ended']
} & TicketStageOf
type TicketStageOf = ReturnType<typeof ticketStage>
export type CallGraphNode = CallGraphTrigger | CallGraphRouter | CallGraphWorker
export type CallEdge =
  | { id: string; kind: 'evaluate'; from: string; to: string; triggerId: string }
  | { id: string; kind: 'accept' | 'reopen' | 'stop'; from: string; to: string; decisionId: string; ticketId: string }
  | { id: string; kind: 'fanout' | 'context'; from: string; to: string; triggerId: string; ticketId: string }
  | { id: string; kind: 'handback'; from: string; to: string; triggerId: string; ticketId: string; reason: string; at: string }
export interface CallGraph {
  threads: CallGraphThread[]
  /** Some Thread in scope subscribes more than one Ticket. */
  multiTicket: boolean
  /** Later inputs left out of the drawing, oldest first, after the ones it kept. */
  omitted: number
  nodes: CallGraphNode[]
  edges: CallEdge[]
}
const empty = (): CallGraph => ({ threads: [], multiTicket: false, omitted: 0, nodes: [], edges: [] })

/**
 * How work moved for one Ticket, or along one Thread.
 * The initial report goes through Eval and may open a Ticket. A later message on a subscribed Thread fans out to those
 * Tickets and skips Eval, unless a Worker hands it back: it then returns to Eval, which may open another Ticket.
 * A Ticket page includes the Threads it subscribes to and the Thread its origin belongs to, and every Ticket those
 * Threads subscribe or that an accept, reopen or stop on them names. A Thread page stays on that Thread.
 */
export function callGraph(view: Snapshot, focus: { ticketId?: string; threadKey?: string }): CallGraph {
  const { store } = view
  const focusTicket = focus.ticketId ? store.tickets.get(focus.ticketId) : undefined
  if (focus.ticketId && !focusTicket) return empty()
  const focusThread = focus.threadKey ? store.threads.get(focus.threadKey) : undefined
  if (focus.threadKey && !focusThread) return empty()

  const threadKeys = new Set<string>()
  if (focusThread) threadKeys.add(focusThread.key)
  if (focusTicket) {
    for (const thread of view.threadsOf(focusTicket.id)) threadKeys.add(thread.key)
    for (const id of new Set([focusTicket.origin.triggerId, ...focusTicket.origin.triggerIds])) {
      for (const ref of store.triggers.get(id)?.threads ?? []) threadKeys.add(threadKey(ref))
    }
  }
  const threadOf = (key: string) => store.threads.get(key)
  const onScope = (trigger: Trigger) => trigger.threads.some(ref => threadKeys.has(threadKey(ref)))
  const decisions: Decision[] = []
  const seenDecisions = new Set<string>()
  const addDecision = (decision: Decision | undefined) => {
    if (!decision || seenDecisions.has(decision.id) || !ROUTED.includes(decision.kind)) return
    seenDecisions.add(decision.id)
    decisions.push(decision)
  }
  for (const key of threadKeys) for (const decision of threadOf(key) ? store.decisions.byThread(key) : []) addDecision(decision)
  if (focusTicket) addDecision(store.decisions.get(focusTicket.decisionId))

  const ticketIds = new Set<string>(focusTicket ? [focusTicket.id] : [])
  for (const key of threadKeys) for (const id of threadOf(key)?.subscriptions ?? []) ticketIds.add(id)
  for (const decision of decisions) if (decision.ticketId) ticketIds.add(decision.ticketId)

  const triggerIds = new Set<string>()
  const consider = (id: string | undefined) => {
    const trigger = id ? store.triggers.get(id) : undefined
    if (trigger && onScope(trigger)) triggerIds.add(trigger.id)
  }
  for (const id of ticketIds) {
    const ticket = store.tickets.get(id)
    if (!ticket) continue
    consider(ticket.origin.triggerId)
    for (const originId of ticket.origin.triggerIds) consider(originId)
    for (const input of ticket.inputs) if (input.kind === 'trigger' || input.kind === 'resumed') consider(input.triggerId)
  }
  for (const decision of decisions) for (const id of decision.triggerIds) consider(id)
  for (const key of threadKeys) {
    const thread = threadOf(key)
    if (!thread) continue
    for (const id of thread.evaluating?.triggerIds ?? []) consider(id)
    for (const id of thread.pending) if (store.triggers.get(id)?.human) consider(id)
  }
  for (const id of [...triggerIds]) {
    const disposition = store.triggers.disposition(id)
    for (const ticketId of disposition?.fanout ?? []) ticketIds.add(ticketId)
    for (const handback of disposition?.handbacks ?? []) ticketIds.add(handback.ticketId)
  }
  for (const id of [...ticketIds]) {
    const ticket = store.tickets.get(id)
    if (!ticket) continue
    consider(ticket.origin.triggerId)
    for (const originId of ticket.origin.triggerIds) consider(originId)
  }

  const waiting = new Map<string, 'queued' | 'evaluating'>()
  for (const key of threadKeys) {
    const thread = threadOf(key)
    if (!thread) continue
    for (const id of thread.pending) if (triggerIds.has(id)) waiting.set(id, waiting.get(id) ?? 'queued')
    for (const id of thread.evaluating?.triggerIds ?? []) if (triggerIds.has(id)) waiting.set(id, 'evaluating')
  }
  const originated = (id: string) => {
    if (store.triggers.disposition(id)?.handbacks?.length) return false
    for (const ticketId of ticketIds) if (store.tickets.get(ticketId)?.origin.triggerId === id) return true
    return false
  }
  const touches = (id: string, disposition: TriggerDisposition | undefined) => {
    if (!disposition) return false
    if (disposition.handbacks?.some(item => ticketIds.has(item.ticketId))) return true
    if (disposition.fanout.some(ticketId => ticketIds.has(ticketId) && store.tickets.get(ticketId))) return true
    return decisions.some(decision => decision.id === disposition.decisionId || decision.triggerIds.includes(id))
  }
  const ranked = [...triggerIds].flatMap(id => {
    const trigger = store.triggers.get(id)
    if (!trigger) return []
    const disposition = store.triggers.disposition(id)
    const role = originated(id) ? 'origin' as const : 'feedback' as const
    if (role !== 'origin' && !waiting.has(id) && !touches(id, disposition)) return []
    return [{ id, trigger, role }]
  })
  const pinned = (item: (typeof ranked)[number]) => item.role === 'origin' || waiting.has(item.id)
    || !!store.triggers.disposition(item.id)?.handbacks?.length
  const recent = (a: (typeof ranked)[number], b: (typeof ranked)[number]) => b.trigger.at.localeCompare(a.trigger.at) || b.id.localeCompare(a.id)
  const optional = ranked.filter(item => !pinned(item)).sort(recent)
  // Humans first, then bots, newest of each first, so a busy Thread's CI does not crowd out the messages people sent.
  const keptOptional = [...optional.filter(item => item.trigger.human), ...optional.filter(item => !item.trigger.human)].slice(0, FEEDBACK_LIMIT)
  const kept = new Set([...ranked.filter(pinned), ...keptOptional].map(item => item.id))
  const omitted = optional.length - keptOptional.length

  const triggers = new Map<string, CallGraphTrigger>()
  for (const item of ranked) if (kept.has(item.id)) {
    const pending = waiting.get(item.id)
    triggers.set(triggerNode(item.id), { id: triggerNode(item.id), kind: 'trigger', role: item.role, triggerId: item.id, at: item.trigger.at,
      preview: preview(item.trigger.text, 80), actor: view.actor(item.trigger.actor, item.trigger.human), human: item.trigger.human,
      thread: homeOf(item.trigger, threadKeys), ...pending ? { pending } : {} })
  }
  const workers = new Map<string, CallGraphWorker>()
  const workerId = (ticketId: string): string | undefined => {
    const ticket = store.tickets.get(ticketId)
    if (!ticket) return undefined
    const id = `worker:${ticketId}`
    if (!workers.has(id)) workers.set(id, { id, kind: 'worker', ticketId, title: ticket.title, focus: ticketId === focus.ticketId,
      context: contextOnly(ticketId, threadKeys, threadOf), createdAt: ticket.createdAt, state: liveTicket(ticket) ? 'open' : 'ended',
      ended: ticket.ended, ...ticketStage(ticket) })
    return id
  }
  if (focus.ticketId) workerId(focus.ticketId)
  for (const key of threadKeys) for (const id of threadOf(key)?.subscriptions ?? []) workerId(id)

  const routers = new Map<string, CallGraphRouter>()
  for (const decision of decisions) {
    if (!decision.triggerIds.some(id => kept.has(id)) && decision.id !== focusTicket?.decisionId) continue
    const shown = decisionView(view, decision)
    routers.set(`router:${decision.id}`, { id: `router:${decision.id}`, kind: 'router', decisionId: decision.id, outcome: shown.outcome,
      reason: decision.reason, at: decision.at, thread: decision.threadKey, triggerIds: decision.triggerIds })
  }
  const pendingRouter = (thread: string, triggerId: string, mode: 'queued' | 'evaluating' | 'returned'): string => {
    const id = `router:pending:${thread}`
    const current = routers.get(id) ?? { id, kind: 'router' as const, thread, triggerIds: [] as string[] }
    if (!current.decisionId) {
      if (mode === 'evaluating') { current.pending = 'evaluating'; delete current.returned }
      else if (mode === 'queued') { if (current.pending !== 'evaluating') current.pending = 'queued'; delete current.returned }
      else if (!current.pending) current.returned = true
    }
    if (!current.triggerIds.includes(triggerId)) current.triggerIds.push(triggerId)
    routers.set(id, current)
    return id
  }
  const edges = new Map<string, CallEdge>()
  const add = (edge: CallEdge) => { edges.set(edge.id, edge) }
  for (const decision of decisions) {
    const router = `router:${decision.id}`
    if (!routers.has(router)) continue
    for (const triggerId of decision.triggerIds) if (kept.has(triggerId)) add({ id: `evaluate:${triggerId}:${router}`, kind: 'evaluate',
      from: triggerNode(triggerId), to: router, triggerId })
    if ((decision.kind === 'accept' || decision.kind === 'reopen' || decision.kind === 'stop') && decision.ticketId
      && workerId(decision.ticketId)) add({ id: `${decision.kind}:${decision.id}:${decision.ticketId}`, kind: decision.kind, from: router,
      to: `worker:${decision.ticketId}`, decisionId: decision.id, ticketId: decision.ticketId })
  }
  for (const id of kept) {
    const trigger = store.triggers.get(id)!
    const disposition = store.triggers.disposition(id)
    const node = triggerNode(id)
    const opened = (ticketId: string) => {
      const ticket = store.tickets.get(ticketId)
      const origin = ticket?.origin.triggerId === id || !!ticket?.origin.triggerIds.includes(id)
      return origin && decisions.some(decision => decision.ticketId === ticketId && decision.triggerIds.includes(id)
        && (decision.kind === 'accept' || decision.kind === 'reopen'))
    }
    for (const ticketId of disposition?.fanout ?? []) {
      if (!workerId(ticketId) || opened(ticketId)) continue
      const ticket = store.tickets.get(ticketId)!
      const context = !!disposition?.context?.includes(ticketId) || ticket.inputs.some(input => input.kind === 'trigger'
        && input.triggerId === id && input.context)
      const kind = context ? 'context' as const : 'fanout' as const
      add({ id: `${kind}:${id}:${ticketId}`, kind, from: node, to: `worker:${ticketId}`, triggerId: id, ticketId })
    }
    const home = homeOf(trigger, threadKeys)
    const state = waiting.get(id)
    if (state) add({ id: `evaluate:${id}:router:pending:${home}`, kind: 'evaluate', from: node, to: pendingRouter(home, id, state), triggerId: id })
    for (const handback of disposition?.handbacks ?? []) {
      if (!workerId(handback.ticketId)) continue
      // The Decision that opened the handing-back Ticket is the path in, not the re-eval the hand-back asked for.
      const created = store.tickets.get(handback.ticketId)?.decisionId
      const later = decisions.filter(decision => decision.triggerIds.includes(id) && decision.at >= handback.at && decision.id !== created)
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))[0]
      const decided = later && routers.has(`router:${later.id}`) ? `router:${later.id}` : undefined
      const target = decided ?? pendingRouter(home, id, state ?? 'returned')
      add({ id: `handback:${handback.ticketId}:${id}`, kind: 'handback', from: `worker:${handback.ticketId}`, to: target, triggerId: id,
        ticketId: handback.ticketId, reason: handback.reason, at: handback.at })
    }
  }
  const first = focus.threadKey ?? originThread(focusTicket, store)
  const orderedThreads = [...threadKeys].map(key => threadCard(store, key, threadOf(key)))
    .sort((a, b) => (a.key === first ? 0 : 1) - (b.key === first ? 0 : 1) || a.key.localeCompare(b.key))
  const byAt = (a: { at?: string; id: string }, b: { at?: string; id: string }) => (a.at ?? '').localeCompare(b.at ?? '') || a.id.localeCompare(b.id)
  const kindOrder = (edge: CallEdge) => ['evaluate', 'accept', 'reopen', 'stop', 'fanout', 'context', 'handback'].indexOf(edge.kind)
  return { threads: orderedThreads, multiTicket: [...threadKeys].some(key => (threadOf(key)?.subscriptions.length ?? 0) > 1), omitted,
    nodes: [...[...triggers.values()].sort(byAt), ...[...routers.values()].sort(byAt), ...[...workers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))],
    edges: [...edges.values()].sort((a, b) => kindOrder(a) - kindOrder(b) || a.id.localeCompare(b.id)) }
}

const triggerNode = (id: string) => `trigger:${id}`
function homeOf(trigger: Trigger, threadKeys: Set<string>): string {
  const keys = trigger.threads.map(threadKey)
  return keys.find(key => threadKeys.has(key)) ?? keys[0] ?? ''
}
function contextOnly(ticketId: string, threadKeys: Set<string>, threadOf: (key: string) => Thread | undefined): boolean {
  const homes = [...threadKeys].filter(key => threadOf(key)?.subscriptions.includes(ticketId))
  return homes.length > 0 && homes.every(key => !!threadOf(key)?.context?.includes(ticketId))
}
function originThread(ticket: Ticket | undefined, store: Snapshot['store']): string | undefined {
  const trigger = ticket && store.triggers.get(ticket.origin.triggerId)
  return trigger?.threads[0] ? threadKey(trigger.threads[0]) : undefined
}
function threadCard(store: Snapshot['store'], key: string, thread: Thread | undefined): CallGraphThread {
  return { key, source: thread?.ref.source ?? key.split(':')[0] ?? key, title: thread ? threadTitle(store, thread) : key,
    subscriptions: thread?.subscriptions.length ?? 0 }
}
