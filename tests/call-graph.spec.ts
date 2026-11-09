import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { callGraph, type CallEdge, type CallGraphNode } from '../src/app/views/call-graph.ts'
import { snapshot, type Snapshot } from '../src/app/views/records.ts'
import { ticketDetail } from '../src/app/views/tickets.ts'
import { threadDetail } from '../src/app/views/threads.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import type { ChannelRef, Ticket, TicketInput, Trigger } from '../src/core/index.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-graph-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const links = (_channel: ChannelRef) => ({ url: 'https://example.test', label: { zh: 'x', en: 'x' } })
function host() {
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(feishuKind); sources.register(githubKind)
  return { store, sources, links }
}
const view = (): Snapshot => snapshot(host())
const mandate = { strength: 'explicit' as const, policyVersion: 'v', basis: { via: 'listed' as const },
  actor: { source: 'feishu', id: 'ou_alice' }, scope: '' }
function ticket(id: string, title: string, decisionId: string, origin: string, at: string, inputs: TicketInput[] = [],
  extra: { scope?: string; assignment?: string; access?: 'read-only' | 'write' } = {}) {
  const saved: Ticket = { id, title, decisionId, channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { ...mandate, scope: extra.scope ?? '' },
    ...extra.assignment || extra.access ? { execution: { name: id, directory: '/w', assignment: extra.assignment ?? '', ...extra.access ? { access: extra.access } : {} } } : {},
    origin: { triggerId: origin, triggerIds: [origin] }, assignments: [{ id: `a-${id}`, state: 'running', createdAt: at, startedAt: at }],
    inputs }
  store.tickets.save(saved)
}
function message(id: string, text: string, at: string, thread: { source: string; id: string } = { source: 'feishu', id: 'topic' }, human = true): Trigger {
  const trigger: Trigger = { id, source: thread.source, threads: [thread], actor: { source: 'feishu', id: 'ou_alice' },
    human, at, text, meta: {} }
  store.triggers.save(trigger)
  return trigger
}
function thread(key: string, id: string, subscriptions: string[], extra: { context?: string[]; pending?: string[]; label?: string } = {}) {
  const source = key.split(':')[0]!
  store.threads.save({ key, ref: { source, id }, createdAt: '2026-11-06T13:00:00.000Z', subscriptions, correlated: [], pending: extra.pending ?? [],
    ...extra.context ? { context: extra.context } : {}, meta: extra.label ? { label: extra.label } : {} })
}
const edge = (graph: { edges: CallEdge[] }, kind: CallEdge['kind'], fields: Record<string, unknown>) =>
  graph.edges.find(item => item.kind === kind && Object.entries(fields).every(([name, value]) => item[name as keyof CallEdge] === value))
const triggerNode = (nodes: CallGraphNode[], id: string) => nodes.find(node => node.kind === 'trigger' && node.triggerId === id)

const topic = 'feishu:topic'
const tReport = '2026-11-06T13:19:00.000Z'
const tAcceptA = '2026-11-06T13:20:00.000Z'
const tWhy = '2026-11-06T14:00:00.000Z'
const tBranch = '2026-11-06T15:00:00.000Z'
const tHandback = '2026-11-06T15:05:00.000Z'
const tAcceptB = '2026-11-06T15:10:00.000Z'
const tPush = '2026-11-06T16:00:00.000Z'
const tJira = '2026-11-09T14:57:00.000Z'

/** The sample: a report opens A, a later message is handed back and opens B, and the thread fans out to both. */
function sample() {
  message('R1', '排查这个生产问题', tReport)
  message('F1', '为什么是114219', tWhy)
  message('F2', '从 master 拉分支一起改', tBranch)
  message('F3', 'push吧', tPush)
  message('F4', 'def 816 建 Jira 工单', tJira)
  store.triggers.saveDisposition('R1', { fanout: [], decisionId: 'dA', at: tReport })
  store.triggers.saveDisposition('F1', { fanout: ['A'], at: tWhy })
  store.triggers.saveDisposition('F2', { fanout: ['A'], decisionId: 'dB', handbacks: [{ ticketId: 'A', reason: '超出只读', at: tHandback }], at: tBranch })
  store.triggers.saveDisposition('F3', { fanout: ['A', 'B'], at: tPush })
  store.triggers.saveDisposition('F4', { fanout: ['A', 'B'], at: tJira })
  store.decisions.save({ id: 'dA', evalId: 'eA', threadKey: topic, triggerIds: ['R1'], policyVersion: 'v', at: tAcceptA, kind: 'accept',
    reason: [{ code: 'explicitRouted' }], strength: 'explicit', ticketId: 'A' })
  store.decisions.save({ id: 'dB', evalId: 'eB', threadKey: topic, triggerIds: ['F2'], policyVersion: 'v', at: tAcceptB, kind: 'accept',
    reason: [{ code: 'explicitRouted' }], strength: 'explicit', ticketId: 'B' })
  // An ignore on the same thread is not a route.
  store.decisions.save({ id: 'dIgnore', evalId: 'eI', threadKey: topic, triggerIds: ['F1'], policyVersion: 'v', at: tWhy, kind: 'ignore',
    reason: [{ code: 'explicitRouted' }], strength: 'explicit' })
  const input = (id: string, triggerId: string, at: string, context = false): TicketInput =>
    ({ id, kind: 'trigger', triggerId, at, human: true, ...context ? { context: true as const } : {} })
  ticket('A', '排查工单', 'dA', 'R1', tAcceptA, [input('i1', 'F1', tWhy), input('i2', 'F2', tBranch), input('i3', 'F3', tPush), input('i4', 'F4', tJira)],
    { scope: '排查生产问题', access: 'read-only' })
  ticket('B', '写工单', 'dB', 'F2', tAcceptB, [input('j3', 'F3', tPush), input('j4', 'F4', tJira)],
    { scope: '写代码改仓库', access: 'write' })
  thread(topic, 'topic', ['A', 'B'], { label: '生产问题' })
  message('noise', 'filtered', tReport)
  store.triggers.saveDisposition('noise', { filtered: { code: 'not_a_member' }, fanout: [], at: tReport })
}

it('draws the initial report, passthrough, hand-back and the second ticket on that thread', () => {
  sample()
  const graph = callGraph(view(), { ticketId: 'A' })
  expect(graph.multiTicket).toBe(true)
  expect(graph.threads.map(item => item.title)).toEqual(['生产问题'])
  expect(triggerNode(graph.nodes, 'R1')).toMatchObject({ role: 'origin' })
  // F2 opened B only after A handed it back, so it stays a later input.
  expect(triggerNode(graph.nodes, 'F2')).toMatchObject({ role: 'feedback' })
  expect(triggerNode(graph.nodes, 'noise')).toBeUndefined()
  expect(graph.nodes.filter(node => node.kind === 'router').map(node => node.decisionId).sort()).toEqual(['dA', 'dB'])
  expect(graph.nodes.filter(node => node.kind === 'worker').map(node => [node.ticketId, node.focus, node.work, node.workFrom, node.access,
    node.detail?.text])).toEqual([['A', true, '排查生产问题', 'scope', 'read-only', '超出只读'], ['B', false, '写代码改仓库', 'scope', 'write', undefined]])
  expect(edge(graph, 'evaluate', { triggerId: 'R1', to: 'router:dA' })).toBeTruthy()
  expect(edge(graph, 'accept', { decisionId: 'dA', ticketId: 'A' })).toBeTruthy()
  expect(edge(graph, 'fanout', { triggerId: 'R1' })).toBeUndefined()
  expect(edge(graph, 'fanout', { triggerId: 'F1', ticketId: 'A' })).toBeTruthy()
  expect(edge(graph, 'evaluate', { triggerId: 'F1' })).toBeUndefined()
  expect(edge(graph, 'fanout', { triggerId: 'F2', ticketId: 'A' })).toBeTruthy()
  expect(edge(graph, 'fanout', { triggerId: 'F2', ticketId: 'B' })).toBeUndefined()
  expect(edge(graph, 'handback', { triggerId: 'F2', ticketId: 'A', to: 'router:dB', reason: '超出只读' })).toMatchObject({ at: tHandback })
  expect(edge(graph, 'evaluate', { triggerId: 'F2', to: 'router:dB' })).toBeTruthy()
  expect(edge(graph, 'accept', { decisionId: 'dB', ticketId: 'B' })).toBeTruthy()
  for (const id of ['F3', 'F4']) {
    expect(edge(graph, 'fanout', { triggerId: id, ticketId: 'A' })).toBeTruthy()
    expect(edge(graph, 'fanout', { triggerId: id, ticketId: 'B' })).toBeTruthy()
  }
  // The same drawing is on the thread, and on B, which shares it.
  const onThread = callGraph(view(), { threadKey: topic })
  expect(onThread.edges.map(item => item.id).sort()).toEqual(graph.edges.map(item => item.id).sort())
  expect(onThread.nodes.filter(node => node.kind === 'worker').every(node => !node.focus)).toBe(true)
  expect(callGraph(view(), { ticketId: 'B' }).edges.map(item => item.id).sort()).toEqual(graph.edges.map(item => item.id).sort())
  expect(ticketDetail(host(), 'A')!.routing.edges.map(item => item.id)).toEqual(graph.edges.map(item => item.id))
  // A message that arrives while the page is polled joins the passthrough to both workers.
  message('F5', '合并到dev', '2026-11-09T15:00:00.000Z')
  store.triggers.saveDisposition('F5', { fanout: ['A', 'B'], at: '2026-11-09T15:00:00.000Z' })
  const ticketA = store.tickets.get('A')!
  store.tickets.save({ ...ticketA, inputs: [...ticketA.inputs, { id: 'i5', kind: 'trigger', triggerId: 'F5', at: '2026-11-09T15:00:00.000Z', human: true }] })
  const polled = ticketDetail(host(), 'A')!.routing
  expect(edge(polled, 'fanout', { triggerId: 'F5', ticketId: 'A' })).toBeTruthy()
  expect(edge(polled, 'fanout', { triggerId: 'F5', ticketId: 'B' })).toBeTruthy()
  expect(threadDetail(host(), topic, undefined, 50)!.routing.edges.some(item => item.kind === 'fanout' && item.triggerId === 'F5')).toBe(true)
})

it('marks a context-only fan-out, and a ticket that is only followed for context', () => {
  sample()
  message('C', 'CI failed', '2026-11-07T00:00:00.000Z', { source: 'github', id: '7' })
  store.triggers.saveDisposition('C', { fanout: ['A'], context: ['A'], at: '2026-11-07T00:00:00.000Z' })
  const ticketA = store.tickets.get('A')!
  store.tickets.save({ ...ticketA, inputs: [...ticketA.inputs, { id: 'ic', kind: 'trigger', triggerId: 'C', at: '2026-11-07T00:00:00.000Z', context: true }] })
  thread('github:7', '7', ['A'], { context: ['A'] })
  const onTicket = callGraph(view(), { ticketId: 'A' })
  expect(edge(onTicket, 'context', { triggerId: 'C', ticketId: 'A' })).toBeTruthy()
  expect(edge(onTicket, 'fanout', { triggerId: 'C' })).toBeUndefined()
  expect(onTicket.nodes.find(node => node.kind === 'worker' && node.ticketId === 'A')).toMatchObject({ context: false })
  const onIssue = callGraph(view(), { threadKey: 'github:7' })
  expect(onIssue.edges.map(item => item.kind)).toEqual(['context'])
  expect(onIssue.nodes.find(node => node.kind === 'worker')).toMatchObject({ ticketId: 'A', context: true })
  expect(onIssue.nodes.some(node => node.kind === 'trigger' && node.triggerId === 'R1')).toBe(false)
})

it('sends a hand-back to the pending router until a later decision takes it', () => {
  message('H', '请改一下', '2026-11-08T00:00:00.000Z')
  store.triggers.saveDisposition('H', { fanout: ['A'], handbacks: [{ ticketId: 'A', reason: '超出只读', at: '2026-11-08T00:01:00.000Z' }], at: '2026-11-08T00:00:00.000Z' })
  ticket('A', '排查工单', 'dA', 'R1', tAcceptA, [{ id: 'ih', kind: 'trigger', triggerId: 'H', at: '2026-11-08T00:00:00.000Z', human: true }])
  message('R1', '排查这个生产问题', tReport)
  store.triggers.saveDisposition('R1', { fanout: [], decisionId: 'dA', at: tReport })
  store.decisions.save({ id: 'dA', evalId: 'eA', threadKey: topic, triggerIds: ['R1'], policyVersion: 'v', at: tAcceptA, kind: 'accept',
    reason: [{ code: 'explicitRouted' }], strength: 'explicit', ticketId: 'A' })
  thread(topic, 'topic', ['A'], { pending: ['H'] })
  const queued = callGraph(view(), { ticketId: 'A' })
  expect(edge(queued, 'handback', { triggerId: 'H', to: `router:pending:${topic}` })).toBeTruthy()
  expect(queued.nodes.find(node => node.kind === 'router' && node.id === `router:pending:${topic}`)).toMatchObject({ pending: 'queued' })
  expect(queued.nodes.find(node => node.kind === 'router' && node.id === `router:pending:${topic}`)).not.toHaveProperty('returned')
  store.threads.save({ ...store.threads.get(topic)!, pending: [] })
  const returned = callGraph(view(), { ticketId: 'A' })
  expect(returned.nodes.find(node => node.kind === 'router' && node.id === `router:pending:${topic}`)).toMatchObject({ returned: true })
  expect(returned.nodes.find(node => node.kind === 'router' && node.id === `router:pending:${topic}`)).not.toHaveProperty('pending')
})

it('names each worker by its own goal, then by what that ticket did, when the titles match', () => {
  message('R', '请看一下', tReport)
  message('M', '把按钮改成蓝色', tWhy)
  store.triggers.saveDisposition('R', { fanout: [], decisionId: 'd', at: tReport })
  store.triggers.saveDisposition('M', { fanout: ['I', 'H'], handbacks: [{ ticketId: 'H', reason: '超出只读', at: tHandback }], at: tWhy })
  store.decisions.save({ id: 'd', evalId: 'e', threadKey: topic, triggerIds: ['R'], policyVersion: 'v', at: tAcceptA, kind: 'accept',
    reason: [{ code: 'explicitRouted' }], strength: 'explicit', ticketId: 'S' })
  const heard = (id: string): TicketInput => ({ id: `i-${id}`, kind: 'trigger', triggerId: 'M', at: tWhy, human: true })
  ticket('S', '工单', 'd', 'R', tAcceptA, [], { scope: '排查生产问题', assignment: '不要用这段派工' })
  ticket('G', '工单', 'd', 'R', tAcceptA, [heard('G')], { assignment: '写代码改仓库' })
  ticket('I', '工单', 'd', 'R', tAcceptA, [heard('I')])
  ticket('H', '工单', 'd', 'R', tAcceptA, [heard('H')])
  thread(topic, 'topic', ['S', 'G', 'I', 'H'])
  const work = (id: string) => callGraph(view(), { threadKey: topic }).nodes.find(node => node.kind === 'worker' && node.ticketId === id)
  expect(work('S')).toMatchObject({ work: '排查生产问题', workFrom: 'scope', title: '工单' })
  expect(work('S')).not.toHaveProperty('detail')
  expect(work('G')).toMatchObject({ work: '写代码改仓库', workFrom: 'assignment' })
  expect(work('I')).toMatchObject({ work: '把按钮改成蓝色', workFrom: 'input' })
  expect(work('H')).toMatchObject({ work: '超出只读', workFrom: 'handback' })
})

it('keeps human later inputs ahead of newer bot traffic', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 8, 0, minute)).toISOString()
  message('human', '请看一下', at(0))
  store.triggers.saveDisposition('human', { fanout: ['A'], at: at(0) })
  ticket('A', '排查工单', 'dA', 'R1', tAcceptA, [{ id: 'ih', kind: 'trigger', triggerId: 'human', at: at(0), human: true }])
  message('R1', '排查这个生产问题', tReport)
  store.triggers.saveDisposition('R1', { fanout: [], decisionId: 'dA', at: tReport })
  store.decisions.save({ id: 'dA', evalId: 'eA', threadKey: topic, triggerIds: ['R1'], policyVersion: 'v', at: tAcceptA, kind: 'accept',
    reason: [{ code: 'explicitRouted' }], strength: 'explicit', ticketId: 'A' })
  const inputs = [...store.tickets.get('A')!.inputs]
  for (let index = 0; index < 30; index += 1) {
    const id = `bot${index}`
    message(id, `ci ${index}`, at(index + 1), { source: 'feishu', id: 'topic' }, false)
    store.triggers.saveDisposition(id, { fanout: ['A'], at: at(index + 1) })
    inputs.push({ id: `i-${id}`, kind: 'trigger', triggerId: id, at: at(index + 1) })
  }
  store.tickets.save({ ...store.tickets.get('A')!, inputs })
  thread(topic, 'topic', ['A'])
  const graph = callGraph(view(), { ticketId: 'A' })
  expect(graph.omitted).toBe(7)
  expect(triggerNode(graph.nodes, 'human')).toBeTruthy()
  expect(triggerNode(graph.nodes, 'R1')).toMatchObject({ role: 'origin' })
  expect(triggerNode(graph.nodes, 'bot0')).toBeUndefined()
  expect(triggerNode(graph.nodes, 'bot29')).toBeTruthy()
})
