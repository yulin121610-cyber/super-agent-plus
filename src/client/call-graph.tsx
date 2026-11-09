/** Live routing graph: initial report through Eval, subscription passthrough, and hand-back. */
import type { ReactNode } from 'react'
import type { TicketPageView } from './api.ts'
import { Tag } from './controls.tsx'
import { decisionMark, ticketMark } from './marks.ts'
import { usePanel } from './provider.tsx'
import { actorName, readableMarkers, reasonLabel } from './text.ts'
import { Hint, Section, When } from './widgets.tsx'

type Graph = TicketPageView['routing']
type Node = Graph['nodes'][number]
type Edge = Graph['edges'][number]
type TriggerNode = Extract<Node, { kind: 'trigger' }>
type RouterNode = Extract<Node, { kind: 'router' }>
type WorkerNode = Extract<Node, { kind: 'worker' }>
type DecideEdge = Extract<Edge, { kind: 'accept' | 'reopen' | 'stop' }>
interface Flow {
  id: string
  group: 'origin' | 'handback' | 'feedback'
  at: string
  steps: ({ kind: 'node'; id: string } | { kind: 'edge'; id: string })[]
  captionId?: string
  also?: number
}
const byAt = (a: Flow, b: Flow) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)
/** Paths the drawing reads left to right. A hand-back that opened another Ticket replaces that accept's own row. */
function flowsOf(graph: Graph): Flow[] {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const known = (id: string) => nodes.has(id)
  const decide = graph.edges.filter((edge): edge is DecideEdge => edge.kind === 'accept' || edge.kind === 'reopen' || edge.kind === 'stop')
  const evaluate = graph.edges.filter((edge): edge is Extract<Edge, { kind: 'evaluate' }> => edge.kind === 'evaluate')
  const handbacks = graph.edges.filter((edge): edge is Extract<Edge, { kind: 'handback' }> => edge.kind === 'handback')
  const passed = graph.edges.filter((edge): edge is Extract<Edge, { kind: 'fanout' | 'context' }> => edge.kind === 'fanout' || edge.kind === 'context')
  const handed = new Set(handbacks.map(edge => edge.to))
  const flows: Flow[] = []
  for (const edge of decide) {
    if (handed.has(edge.from) || !known(edge.from) || !known(edge.to)) continue
    const incoming = evaluate.filter(item => item.to === edge.from && known(item.from))
      .sort((a, b) => (nodes.get(a.from) as TriggerNode).at.localeCompare((nodes.get(b.from) as TriggerNode).at))
    const chosen = incoming.find(item => (nodes.get(item.from) as TriggerNode).role === 'origin') ?? incoming[0]
    const router = nodes.get(edge.from) as RouterNode
    flows.push({ id: edge.id, group: 'origin', at: chosen ? (nodes.get(chosen.from) as TriggerNode).at : router.at ?? '',
      also: Math.max(0, incoming.length - 1),
      steps: [...chosen ? [{ kind: 'node' as const, id: chosen.from }, { kind: 'edge' as const, id: chosen.id }] : [],
        { kind: 'node', id: edge.from }, { kind: 'edge', id: edge.id }, { kind: 'node', id: edge.to }] })
  }
  for (const edge of handbacks) {
    if (!known(edge.from) || !known(edge.to)) continue
    const onward = decide.filter(item => item.from === edge.to && known(item.to)
      && (nodes.get(edge.to) as RouterNode).triggerIds.includes(edge.triggerId))
    const next = onward.find(item => item.ticketId !== edge.ticketId) ?? onward[0]
    flows.push({ id: edge.id, group: 'handback', at: edge.at, captionId: `trigger:${edge.triggerId}`,
      steps: [{ kind: 'node', id: edge.from }, { kind: 'edge', id: edge.id }, { kind: 'node', id: edge.to },
        ...next ? [{ kind: 'edge' as const, id: next.id }, { kind: 'node' as const, id: next.to }] : []] })
  }
  const drawn = new Set(flows.flatMap(flow => flow.steps.flatMap(step => step.kind === 'edge' ? [step.id] : [])))
  for (const edge of evaluate) {
    if (drawn.has(edge.id) || !known(edge.from) || !known(edge.to)) continue
    const trigger = nodes.get(edge.from) as TriggerNode
    const decided = decide.some(item => item.from === edge.to)
    const returned = handbacks.some(item => item.triggerId === edge.triggerId)
    const fanned = passed.some(item => item.triggerId === edge.triggerId)
    if (decided || returned || fanned) continue
    flows.push({ id: edge.id, group: trigger.role === 'origin' ? 'origin' : 'feedback', at: trigger.at,
      steps: [{ kind: 'node', id: edge.from }, { kind: 'edge', id: edge.id }, { kind: 'node', id: edge.to }] })
  }
  const seen = new Set<string>()
  for (const edge of passed) {
    if (seen.has(edge.from) || !known(edge.from)) continue
    seen.add(edge.from)
    const group = passed.filter(item => item.from === edge.from && known(item.to))
    if (!group.length) continue
    const trigger = nodes.get(edge.from) as TriggerNode
    const mixed = group.some(item => item.kind !== group[0]!.kind)
    const steps: Flow['steps'] = [{ kind: 'node', id: edge.from }]
    if (!mixed) steps.push({ kind: 'edge', id: group[0]!.id }, ...group.map(item => ({ kind: 'node' as const, id: item.to })))
    else for (const item of group) steps.push({ kind: 'edge', id: item.id }, { kind: 'node', id: item.to })
    flows.push({ id: `pass:${edge.triggerId}`, group: 'feedback', at: trigger.at, steps })
  }
  return flows.sort(byAt)
}

function Arrow({ edge }: { edge: Edge }) {
  const { t } = usePanel()
  const label = edge.kind === 'evaluate' ? t('routingEvaluate')
    : edge.kind === 'accept' ? t('routingAccept')
    : edge.kind === 'fanout' ? t('routingPassthrough')
    : edge.kind === 'context' ? t('contextOnly')
    : edge.kind === 'handback' ? t('routingHandbackReason', { reason: edge.reason })
    : edge.kind === 'reopen' ? t('decision.reopen') : t('decision.stop')
  const dashed = edge.kind === 'handback' || edge.kind === 'context'
  return <span className="dt-route-arrow" data-kind={edge.kind} {...dashed ? { 'data-dashed': 'true' } : {}}><i />{label}</span>
}
function GraphNode({ node }: { node: Node }) {
  const { t, navigate } = usePanel()
  const title = node.kind === 'trigger' ? readableMarkers(t, node.preview) || t('empty')
    : node.kind === 'worker' ? node.workFrom === 'handback' ? t('routingHandbackReason', { reason: node.work }) : node.work
    : node.outcome ? decisionMark(t, node.outcome).label
    : node.returned ? t('routingReturned')
    : node.pending === 'evaluating' ? t('dispositionEvaluating') : t('dispositionQueued')
  const go = () => {
    if (node.kind === 'trigger') navigate({ page: 'trigger', id: node.thread, query: { trigger: node.triggerId } })
    else if (node.kind === 'worker') { if (!node.focus) navigate({ page: 'execution', id: node.ticketId }) }
    else navigate({ page: 'trigger', id: node.thread })
  }
  const reason = node.kind === 'router' && node.reason?.length ? reasonLabel(t, node.reason) : ''
  const mark = node.kind === 'worker' ? ticketMark(t, node) : undefined
  const tip = node.kind === 'worker' ? `${title}\n${node.title}\n${node.ticketId}` : title
  return <div className="dt-route-node" data-kind={node.kind} {...node.kind === 'worker' && node.focus ? { 'data-current': 'true' } : {}}>
    <button type="button" className="dt-route-node-title" title={tip} onClick={go}>{title}</button>
    {node.kind === 'worker' && node.title !== node.work && <span className="dt-route-node-sub">{node.title}</span>}
    <div className="dt-row-meta">
      {node.kind === 'trigger' && <span>{actorName(t, node.actor)}</span>}
      {node.kind === 'trigger' && <When at={node.at} />}
      {node.kind === 'trigger' && node.pending === 'queued' && <Tag tone="info">{t('dispositionQueued')}</Tag>}
      {node.kind === 'trigger' && node.pending === 'evaluating' && <Tag tone="info">{t('dispositionEvaluating')}</Tag>}
      {node.kind === 'router' && node.at && <When at={node.at} />}
      {mark && <Tag tone={mark.tone}>{mark.label}</Tag>}
      {node.kind === 'worker' && node.access && <Tag tone={node.access === 'read-only' ? 'quiet' : 'success'}>{t(node.access === 'read-only'
        ? 'routingReadOnly' : 'routingWrite')}</Tag>}
      {node.kind === 'worker' && node.focus && <Tag tone="info">{t('routingCurrent')}</Tag>}
      {node.kind === 'worker' && node.context && <Tag tone="quiet" title={t('contextOnlyHint')}>{t('contextOnly')}</Tag>}
    </div>
    {node.kind === 'worker' && node.detail?.kind === 'handback' && <Hint>{t('routingHandbackReason', { reason: node.detail.text })}</Hint>}
    {reason && <Hint>{reason}</Hint>}
  </div>
}
const GROUPS = ['origin', 'handback', 'feedback'] as const
/**
 * Draws `graph` from the payload the page already polls. Nothing is drawn when the store has no route yet.
 */
export function RoutingGraph({ graph }: { graph: Graph }) {
  const { t, navigate } = usePanel()
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const edges = new Map(graph.edges.map(edge => [edge.id, edge]))
  const flows = flowsOf(graph)
  if (!flows.length) return null
  const linked = new Set(flows.flatMap(flow => flow.steps.flatMap(step => step.kind === 'node' ? [step.id] : [])))
  const unlinked = graph.multiTicket ? graph.nodes.filter((node): node is WorkerNode => node.kind === 'worker' && !linked.has(node.id)) : []
  const step = (flow: Flow, index: number, item: Flow['steps'][number]): ReactNode => {
    if (item.kind === 'edge') {
      const edge = edges.get(item.id)
      return edge ? <Arrow key={`${flow.id}:${item.id}`} edge={edge} /> : null
    }
    const current = nodes.get(item.id)
    return current ? <GraphNode key={`${flow.id}:${item.id}:${index}`} node={current} /> : null
  }
  const caption = (id: string | undefined) => {
    const trigger = id ? nodes.get(id) : undefined
    return trigger?.kind === 'trigger' ? readableMarkers(t, trigger.preview) : ''
  }
  return <Section title={t('routing')} icon="decision" hint={t('routingHint')} count={graph.nodes.filter(node => node.kind === 'worker').length || undefined}>
    {graph.threads.length > 1 && <div className="dt-row-meta">{graph.threads.map(thread => <button key={thread.key} type="button" className="dt-textlink"
      onClick={() => navigate({ page: 'trigger', id: thread.key })}>{readableMarkers(t, thread.title)}</button>)}</div>}
    <div className="dt-route">
      {GROUPS.flatMap(group => {
        const rows = flows.filter(flow => flow.group === group)
        if (!rows.length) return []
        return [<div key={group} className="dt-route-group">
          <div className="dt-route-label">{t(group === 'origin' ? 'routingInitial' : group === 'handback' ? 'routingHandbackGroup' : 'routingFeedback')}</div>
          {rows.map(flow => <div key={flow.id}>
            <div className="dt-route-row">{flow.steps.map((item, index) => step(flow, index, item))}</div>
            {!!flow.also && <Hint>{t('routingBatch', { count: flow.also })}</Hint>}
            {caption(flow.captionId) && <Hint>{caption(flow.captionId)}</Hint>}
          </div>)}
        </div>]
      })}
      {unlinked.length > 0 && <div className="dt-route-group">
        <div className="dt-route-label">{t('routingAlso')}</div>
        <div className="dt-route-row">{unlinked.map(worker => <GraphNode key={worker.id} node={worker} />)}</div>
      </div>}
      {graph.omitted > 0 && <Hint>{t('routingOmitted', { count: graph.omitted })}</Hint>}
      {graph.multiTicket && <Hint>{t('routingMulti')}</Hint>}
    </div>
  </Section>
}
