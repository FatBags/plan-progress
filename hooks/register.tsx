// plan-progress: live plan bars above the prompt.
//
// Written from scratch. It uses only $.state, $.store, $.ui, $.audio (its own
// sound files), $.clock, $.session.id, $.tool.register and
// $.command.register and $.ui.open (its own pane). No network, no processes, no file access.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ResolveInput } from 'claude-code'

import type { AgentRow, Bar, BarState, Stage, Step } from '../types'

const TOOL_NAME = 'plan_progress'
const PANE = 'plan-progress'
const TOOL_PATTERN = /^mcp__plan-progress__plan_progress$/
const MAX_BARS = 6
const MAX_AGENTS_SHOWN = 3
const KEPT_SESSIONS = 30

const bars = atom({ plugin: 'plan-progress', key: 'bars' } as const, [], {
  shape: 'bars-1',
})
const isHidden = atom({ plugin: 'plan-progress', key: 'isHidden' } as const, false)
const isAgentsFolded = atom(
  { plugin: 'plan-progress', key: 'isAgentsFolded' } as const,
  false,
)
const tick = atom({ plugin: 'plan-progress', key: 'tick' } as const, 0)

type Options = { doneBarSeconds?: number; twinkle?: boolean; sounds?: boolean }

// ---------------------------------------------------------------------------
// Plan model: pure functions over a Bar.

type StepInput = { title?: unknown; status?: unknown }
type StageInput = { name?: unknown; steps?: unknown }
type ToolInput = {
  id?: unknown
  title?: unknown
  kind?: unknown
  stages?: unknown
  steps?: unknown
  next?: unknown
  done?: unknown
  active?: unknown
  failed?: unknown
  state?: unknown
  note?: unknown
}

type Outcome = { bar: Bar; error?: undefined } | { error: string; bar?: undefined }

const STATUSES = ['pending', 'active', 'done', 'failed'] as const
const BAR_STATES = ['running', 'needs_input', 'error', 'done'] as const

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

const allSteps = (bar: Bar): Step[] => bar.stages.flatMap(s => s.steps)

const isOpen = (s: Step) => s.status !== 'done'

function parseStages(input: ToolInput, title: string): Stage[] | string {
  let raw: unknown = input.stages
  if (raw === undefined && Array.isArray(input.steps)) {
    raw = [{ name: title, steps: input.steps }]
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'stages must be a non-empty list of {name, steps:[{title}]}'
  }
  const stages: Stage[] = []
  for (const one of raw as StageInput[]) {
    const name = str(one?.name) || title
    const stepsIn = Array.isArray(one?.steps) ? (one.steps as StepInput[]) : []
    const steps: Step[] = []
    for (const s of stepsIn) {
      const t = typeof s === 'string' ? str(s) : str(s?.title)
      if (!t) continue
      const status = (STATUSES as readonly string[]).includes(str(s?.status))
        ? (str(s?.status) as Step['status'])
        : 'pending'
      steps.push({ title: t.slice(0, 80), status })
    }
    if (steps.length === 0) steps.push({ title: name, status: 'pending' })
    stages.push({ name: name.slice(0, 40), steps })
  }
  return stages.slice(0, 12)
}

// The step a title names: the first open one with that title, else any.
function findStep(bar: Bar, title: string): Step | undefined {
  const t = title.toLowerCase()
  const matches = allSteps(bar).filter(s => s.title.toLowerCase() === t)
  return matches.find(isOpen) ?? matches[0]
}

function stepList(bar: Bar): string {
  return bar.stages
    .map(st => `${st.name}: ${st.steps.map(s => s.title).join(', ')}`)
    .join('; ')
}

function activate(step: Step, now: number) {
  step.status = 'active'
  step.startedAt ??= now
  step.endedAt = undefined
}

function finish(step: Step, now: number) {
  step.status = 'done'
  step.startedAt ??= now
  step.endedAt ??= now
}

// Keep exactly one active step while the bar runs: the first open one.
function settle(bar: Bar, now: number) {
  const steps = allSteps(bar)
  const actives = steps.filter(s => s.status === 'active')
  for (const extra of actives.slice(1)) extra.status = 'pending'
  if (actives.length === 0 && bar.state !== 'error') {
    const first = steps.find(s => s.status === 'pending')
    if (first) activate(first, now)
  }
  if (steps.every(s => s.status === 'done') && bar.state !== 'done') {
    bar.state = 'done'
    bar.finishedAt = now
    bar.note = undefined
  }
}

function newBar(id: string, title: string, stages: Stage[], now: number): Bar {
  const bar: Bar = {
    id,
    title,
    stages,
    state: 'running',
    startedAt: now,
    touchedAt: now,
    agents: [],
  }
  for (const s of allSteps(bar)) {
    if (s.status === 'done') finish(s, now)
    if (s.status === 'active') activate(s, now)
  }
  settle(bar, now)
  return bar
}

function replan(old: Bar, title: string, stages: Stage[], now: number): Bar {
  const sent = stages.flatMap(s => s.steps)
  const hasStatuses = sent.some(s => s.status !== 'pending')
  const onlyFirstActive =
    sent.every((s, i) => s.status === (i === 0 ? 'active' : 'pending')) ||
    !hasStatuses
  const keepsTitle = title === old.title
  const keepsFinished = allSteps(old)
    .filter(s => s.status === 'done')
    .every(s => sent.some(n => n.title.toLowerCase() === s.title.toLowerCase()))

  // A finished bar sent the same plan again starts a new run; another plan
  // under it is the next task and starts from zero.
  if (old.state === 'done' && (onlyFirstActive || !keepsTitle || !keepsFinished)) {
    const fresh = newBar(old.id, title, stages, now)
    return fresh
  }

  const before = new Map<string, Step>()
  for (const s of allSteps(old)) {
    const key = s.title.toLowerCase()
    if (!before.has(key) || s.status === 'done') before.set(key, s)
  }
  for (const s of sent) {
    const prior = before.get(s.title.toLowerCase())
    if (s.status === 'pending' && prior?.status === 'done') {
      s.status = 'done'
      s.startedAt = prior.startedAt
      s.endedAt = prior.endedAt
    } else if (s.status === 'done') {
      s.startedAt = prior?.startedAt ?? now
      s.endedAt = prior?.endedAt ?? now
    } else if (prior?.startedAt && s.status !== 'pending') {
      s.startedAt = prior.startedAt
    }
    if (s.status === 'active') s.startedAt ??= now
  }
  const bar: Bar = { ...old, title, stages, touchedAt: now }
  if (bar.state === 'done' || bar.state === 'error') {
    bar.state = 'running'
    bar.finishedAt = undefined
    bar.note = undefined
  }
  settle(bar, now)
  return bar
}

// Applies one tool call to the bar list; answers the new bar or a refusal.
function apply(list: readonly Bar[], input: ToolInput, now: number): Outcome {
  const id = str(input.id)
  if (!id) return { error: 'id is required (one id per task, e.g. "auth")' }
  const prev = list.find(b => b.id === id)
  const title = str(input.title).slice(0, 40) || prev?.title || id

  let bar: Bar
  if (input.stages !== undefined || input.steps !== undefined) {
    const stages = parseStages(input, title)
    if (typeof stages === 'string') return { error: stages }
    bar = prev ? replan(prev, title, stages, now) : newBar(id, title, stages, now)
  } else if (prev) {
    bar = JSON.parse(JSON.stringify(prev)) as Bar
    bar.touchedAt = now
  } else {
    return {
      error: `No bar "${id}". Create it first with {id, title, stages:[{name, steps:[{title}]}]}.`,
    }
  }

  const unknown: string[] = []
  const lookup = (t: string) => {
    const s = findStep(bar, t)
    if (!s) unknown.push(t)
    return s
  }

  const done = Array.isArray(input.done) ? input.done.map(str).filter(Boolean) : []
  const doneSteps = done.map(lookup)
  const activeTitle = str(input.active)
  const activeStep = activeTitle ? lookup(activeTitle) : undefined
  const failedTitle = str(input.failed)
  const failedStep = failedTitle ? lookup(failedTitle) : undefined
  if (unknown.length > 0) {
    return {
      error: `Unknown step${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. The bar's steps are: ${stepList(bar)}`,
    }
  }

  const steps = allSteps(bar)

  if (input.next === true) {
    const at = steps.findIndex(s => s.status === 'active')
    if (at >= 0) finish(steps[at]!, now)
    const after = steps.slice(at + 1).find(s => s.status === 'pending')
    const anyOpen = steps.find(s => s.status === 'pending' || s.status === 'failed')
    const nextStep = after ?? anyOpen
    if (nextStep) activate(nextStep, now)
    if (bar.state === 'error' || bar.state === 'needs_input') {
      bar.state = 'running'
      bar.note = undefined
    }
  }

  for (const s of doneSteps) if (s) finish(s, now)

  if (activeStep) {
    // Every step before the new active one that was active counts as done.
    const at = steps.indexOf(activeStep)
    for (const s of steps.slice(0, at)) if (s.status === 'active') finish(s, now)
    for (const s of steps) if (s !== activeStep && s.status === 'active') s.status = 'pending'
    activate(activeStep, now)
    if (bar.state !== 'running') {
      bar.state = 'running'
      bar.finishedAt = undefined
      bar.note = undefined
    }
  }

  if (failedStep) {
    for (const s of steps) if (s !== failedStep && s.status === 'active') s.status = 'pending'
    failedStep.status = 'failed'
    failedStep.startedAt ??= now
    failedStep.endedAt = now
    bar.state = 'error'
    bar.note = str(input.note).slice(0, 120) || undefined
  }

  const wanted = str(input.state)
  if (wanted) {
    if (!(BAR_STATES as readonly string[]).includes(wanted)) {
      return { error: `state must be one of ${BAR_STATES.join(', ')}` }
    }
    const state = wanted as BarState
    if (state === 'done') {
      for (const s of steps) finish(s, now)
    } else {
      bar.finishedAt = undefined
    }
    bar.state = state
    bar.note = state === 'needs_input' || state === 'error'
      ? str(input.note).slice(0, 120) || undefined
      : undefined
    if (state === 'done') bar.finishedAt = now
  }

  settle(bar, now)
  return { bar }
}

function summary(bar: Bar): string {
  const steps = allSteps(bar)
  const done = steps.filter(s => s.status === 'done').length
  const active = steps.find(s => s.status === 'active')
  return `${bar.id}: ${done}/${steps.length}, ${bar.state}${active ? `, active: ${active.title}` : ''}`
}

// A plan approved in plan mode: `##` headings are stages, list items steps.
function stagesFromMarkdown(md: string): Stage[] {
  const stages: Stage[] = []
  let current: Stage | undefined
  for (const line of md.split('\n')) {
    const heading = /^#{2,3}\s+(.+?)\s*#*$/.exec(line)
    if (heading) {
      current = { name: heading[1]!.replace(/[*_`]/g, '').slice(0, 40), steps: [] }
      stages.push(current)
      continue
    }
    const item = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line)
    if (item && current) {
      const text = item[1]!.replace(/[*_`[\]]/g, '').replace(/\s+/g, ' ').trim()
      if (text) current.steps.push({ title: text.slice(0, 60), status: 'pending' })
    }
  }
  const used = stages.filter(s => s.steps.length > 0)
  for (const s of used) s.steps = s.steps.slice(0, 10)
  return used.slice(0, 7)
}

// ---------------------------------------------------------------------------
// Drawing helpers.

const COLORS: Record<BarState, { fill: string; pill: string; row: string }> = {
  running: { fill: '#8f78ee', pill: '#7c5cf0', row: '#2d2546' },
  needs_input: { fill: '#d0913e', pill: '#d1862a', row: '#3a2c1c' },
  error: { fill: '#cc5a5a', pill: '#d04848', row: '#3a2222' },
  done: { fill: '#46a564', pill: '#2f9e55', row: '#1f3326' },
}
const AGENT_COLORS = {
  running: { dot: '#8f78ee', row: '#2a2342' },
  done: { dot: '#46a564', row: '#1d3024' },
  error: { dot: '#d04848', row: '#382020' },
} as const
const ICONS: Record<BarState, string> = {
  running: '•',
  needs_input: '?',
  error: '!',
  done: '✓',
}

// A small deterministic hash in [0, 1).
function noise(a: number, b: number, c = 0): number {
  let x = (a * 374761393 + b * 668265263 + c * 2147483647) | 0
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

function seconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}

function runningClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${String(s).padStart(2, '0')}s`
  return seconds(ms)
}

function modelLabel(model: string): string {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(model)
  if (m) return `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  return model
}

function percent(bar: Bar): number {
  const steps = allSteps(bar)
  if (bar.state === 'done') return 100
  const done = steps.filter(s => s.status === 'done').length
  return steps.length === 0 ? 0 : Math.round((done / steps.length) * 100)
}

function pillLabel(bar: Bar, now: number): string {
  const active =
    bar.stages.find(st => st.steps.some(s => s.status === 'active' || s.status === 'failed')) ??
    bar.stages.find(st => st.steps.some(isOpen))
  const name = active?.name ?? bar.title
  switch (bar.state) {
    case 'done':
      return `✓ ${seconds((bar.finishedAt ?? now) - bar.startedAt)}`
    case 'needs_input':
      return `? ${name}`
    case 'error':
      return `✕ ${name}`
    default:
      return name
  }
}

function pillHover(bar: Bar, now: number): string {
  const active = allSteps(bar).find(s => s.status === 'active' || s.status === 'failed')
  const stage = bar.stages.find(st => active && st.steps.includes(active))
  const parts = [stage?.name, active?.title].filter(Boolean).join(' › ')
  const spent = seconds((bar.finishedAt ?? now) - bar.startedAt)
  const note = bar.note ? ` — ${bar.note}` : ''
  return `${parts || bar.title} · ${spent} so far${note}`
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

type Marker = { at: number; kind: 'stage' | 'step'; hover: string }

function markers(bar: Bar, now: number): Marker[] {
  const steps = allSteps(bar)
  const n = steps.length
  const out: Marker[] = []
  let i = 0
  for (const stage of bar.stages) {
    stage.steps.forEach((step, j) => {
      const at = i / n
      if (i > 0) {
        const took = step.endedAt && step.startedAt ? ` · took ${seconds(step.endedAt - step.startedAt)}` : ''
        const hover =
          step.status === 'done'
            ? `${j === 0 ? `${stage.name}: ` : ''}${step.title}${took}`
            : step.status === 'pending'
              ? `Next: ${j === 0 ? `${stage.name} › ` : ''}${step.title}`
              : `${step.title} · ${seconds(now - (step.startedAt ?? now))} so far`
        out.push({ at, kind: j === 0 ? 'stage' : 'step', hover })
      }
      i++
    })
  }
  return out
}

function barSvg(bar: Bar, width: number, height: number, now: number, twinkle: boolean): string {
  const c = COLORS[bar.state]
  const pct = percent(bar) / 100
  const label = pillLabel(bar, now)
  const fontSize = Math.round(height * 0.5)
  const pillW = Math.min(width * 0.45, Math.round(label.length * fontSize * 0.62 + fontSize * 2))
  const pillH = height - 4
  const fillW = Math.max(pillW * 0.6, pct * width)
  const pillX = Math.max(2, Math.min(width - pillW - 2, fillW - pillW * 0.35))
  const cell = 4
  const cols = Math.floor(fillW / cell)
  const rows = Math.floor((height - 4) / cell)
  const doTwinkle = twinkle && (bar.state === 'running' || bar.state === 'needs_input')
  const seed = bar.id.split('').reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) | 0

  const dots: string[] = []
  for (let x = 0; x < cols; x++) {
    const along = (x + 1) / Math.max(1, cols)
    const density = 0.3 + 0.65 * along ** 1.3
    for (let y = 0; y < rows; y++) {
      const r = noise(seed, x, y)
      if (r > density) continue
      const op = (0.25 + 0.75 * along * noise(seed + 1, x, y) + 0.15 * along).toFixed(2)
      const px = x * cell + 1
      const py = y * cell + 3
      if (doTwinkle && noise(seed + 2, x, y) < 0.09) {
        const dur = (1.1 + noise(seed + 3, x, y) * 1.6).toFixed(2)
        const begin = (noise(seed + 4, x, y) * 2).toFixed(2)
        dots.push(
          `<rect x="${px}" y="${py}" width="3" height="3" fill="${c.fill}" opacity="${op}"><animate attributeName="opacity" values="${op};0.08;${op}" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/></rect>`,
        )
      } else {
        dots.push(`<rect x="${px}" y="${py}" width="3" height="3" fill="${c.fill}" opacity="${op}"/>`)
      }
    }
  }

  const marks = markers(bar, now).map(m => {
    const x = Math.round(m.at * width)
    if (x > pillX - 4 && x < pillX + pillW + 4) return ''
    const passed = x < fillW
    return m.kind === 'stage'
      ? `<g><title>${xml(m.hover)}</title><rect x="${x - 6}" y="0" width="12" height="${height}" fill="transparent"/><rect x="${x - 1.5}" y="${height * 0.28}" width="3" height="${height * 0.44}" rx="1.5" fill="#fff" opacity="${passed ? 0.75 : 0.45}"/></g>`
      : `<g><title>${xml(m.hover)}</title><circle cx="${x}" cy="${height / 2}" r="7" fill="transparent"/><circle cx="${x}" cy="${height / 2}" r="2" fill="#fff" opacity="${passed ? 0.7 : 0.35}"/></g>`
  })

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><clipPath id="r"><rect width="${width}" height="${height}" rx="${height / 2}"/></clipPath></defs>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${width}" height="${height}" fill="#2b2b30"/>`,
    dots.join(''),
    `</g>`,
    marks.join(''),
    `<g><title>${xml(pillHover(bar, now))}</title>`,
    `<rect x="${pillX}" y="2" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="${c.pill}"/>`,
    `<text x="${pillX + pillW / 2}" y="${height / 2}" dy="0.35em" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="${fontSize}" font-weight="600" fill="#fff">${xml(label)}</text>`,
    `</g></svg>`,
  ].join('')
}

// The terminal's bar: a row of cells, each a character and its colors.
type Cell = { ch: string; fg?: string; bg: string; bold?: boolean }

const BRAILLE = '⠁⠂⠄⠈⠐⠠⠃⠅⠉⠑⠡⠊⠒⠢⠔⠤⠘⠰⠆⠖⠦⠴⠶⠷⠾⠿⣀⣄⣤⣦⣶⣷⣿'

function barCells(bar: Bar, width: number, now: number, frame: number): Cell[] {
  const c = COLORS[bar.state]
  const BG = '#2b2b30'
  const label = ` ${pillLabel(bar, now)} `
  const pct = percent(bar) / 100
  const fillW = Math.max(Math.min(label.length, width), Math.round(pct * width))
  const pillX = Math.max(0, Math.min(width - label.length, fillW - Math.ceil(label.length * 0.35)))
  const seed = bar.id.length * 97
  const cells: Cell[] = []
  for (let x = 0; x < width; x++) {
    if (x < fillW) {
      const along = (x + 1) / fillW
      const r = noise(seed, x, frame)
      const idx = Math.min(BRAILLE.length - 1, Math.floor((along * 0.7 + r * 0.3) * BRAILLE.length))
      cells.push({ ch: BRAILLE[idx]!, fg: c.fill, bg: BG })
    } else {
      cells.push({ ch: ' ', bg: BG })
    }
  }
  for (const m of markers(bar, now)) {
    const x = Math.min(width - 1, Math.round(m.at * width))
    const cell = cells[x]
    if (!cell || x < fillW) continue
    cell.ch = m.kind === 'stage' ? '┃' : '·'
    cell.fg = '#8a8a90'
  }
  for (let i = 0; i < label.length && pillX + i < width; i++) {
    cells[pillX + i] = { ch: label[i]!, fg: '#ffffff', bg: c.pill, bold: true }
  }
  return cells
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Engine-facing helpers. The module's own settings and the session's keys
// live here; register() fills them in.

type Engine = EngineInterface

const live = {
  sessionKey: undefined as string | undefined,
  ticker: undefined as { cancel: () => void } | undefined,
  doneBarMs: 30_000,
  sounds: true,
  twinkle: true,
  // Set once the band above the prompt has drawn bars on this surface.
  bandSeen: false,
}

// Agent id -> the bar its row lives under; rebuilt from the bars on reload.
const agentBar = new Map<string, string>()

function isLive(list: readonly Bar[]): boolean {
  return list.some(
    b => b.state === 'running' || b.state === 'needs_input' || b.agents.some(a => a.state === 'running'),
  )
}

// Ticks once a second while something on the bars moves, for the clocks.
async function keepTicking($: Engine) {
  const list = await read($, bars)
  if (isLive(list)) {
    live.ticker ??= $.clock.every(1000, () => {
      void tickOnce($)
    })
  } else {
    live.ticker?.cancel()
    live.ticker = undefined
  }
}

async function tickOnce($: Engine) {
  await update($, tick, n => (n + 1) % 1_000_000)
  if (!isLive(await read($, bars))) {
    live.ticker?.cancel()
    live.ticker = undefined
  }
}

async function playFor($: Engine, before: BarState | undefined, after: BarState) {
  if (!live.sounds || before === after) return
  const asset =
    after === 'needs_input'
      ? 'sounds/decision.wav'
      : after === 'error'
        ? 'sounds/error.wav'
        : after === 'done'
          ? 'sounds/done.wav'
          : undefined
  if (asset) await $.audio.play({ asset }).catch(() => undefined)
}

// Writes the bar list, saves it for a resume, and starts or stops the clock.
async function mutate($: Engine, fn: (list: readonly Bar[]) => readonly Bar[]) {
  let next: readonly Bar[] = []
  await update($, bars, list => {
    next = fn(list)
    return [...next]
  })
  if (live.sessionKey) await $.store.set(live.sessionKey, next)
  await keepTicking($)
  return next
}

async function scheduleAutoclose($: Engine, id: string) {
  if ((await $.store.get('autoclose')) !== true) return
  $.clock.after(live.doneBarMs, () => {
    void removeDone($, id)
  })
}

async function removeDone($: Engine, id: string) {
  await mutate($, list => list.filter(b => !(b.id === id && b.state === 'done')))
}

async function removeBar($: Engine, id: string) {
  for (const [agent, bar] of agentBar) if (bar === id) agentBar.delete(agent)
  await mutate($, all => all.filter(b => b.id !== id))
}

async function applyAndReport($: Engine, input: ToolInput): Promise<Outcome> {
  const now = await $.clock.now()
  const before = (await read($, bars)).find(b => b.id === str(input.id))?.state
  let outcome: Outcome = { error: 'not applied' }
  await mutate($, list => {
    outcome = apply(list, input, now)
    if (!outcome.bar) return list
    const bar = outcome.bar
    const at = list.findIndex(b => b.id === bar.id)
    const merged = at >= 0 ? list.map(b => (b.id === bar.id ? bar : b)) : [...list, bar]
    return merged.slice(-MAX_BARS)
  })
  const result = outcome as Outcome
  if (result.bar) {
    if (before === undefined) {
      $.clock.after(1500, () => {
        void openPaneUnlessBand($)
      })
    }
    await playFor($, before, result.bar.state)
    if (result.bar.state === 'done' && before !== 'done') await scheduleAutoclose($, result.bar.id)
  }
  return result
}

// Where no band draws (a cloud session watched from the app), the pane does.
async function openPaneUnlessBand($: Engine) {
  if (live.bandSeen) return
  await $.ui.open({ id: PANE, title: 'Plan progress' })
}

async function setAgent($: Engine, barId: string, agentId: string, patch: Partial<AgentRow>) {
  await mutate($, list =>
    list.map(b =>
      b.id !== barId ? b : { ...b, agents: b.agents.map(a => (a.id === agentId ? { ...a, ...patch } : a)) },
    ),
  )
}

// Draws the bars and their agent rows, for the band and the pane alike.
async function drawBars(
  $: Engine,
  e: ResolveInput,
  list: readonly Bar[],
  bodyColumns: number,
  isWorking: boolean,
) {
  const frame = await read($, tick)
  const folded = await read($, isAgentsFolded)
  const now = await $.clock.now()
  const columns = Math.max(40, bodyColumns)
  const isTerminal = e.surface === 'terminal'
  const ui = $.ui.resolve(e)
  const { Box, Text, Button } = ui
  const Svg = 'Svg' in ui ? ui.Svg : undefined

  const close = (id: string) => () => {
    void removeBar($, id)
  }

  const titleW = Math.min(20, Math.max(10, Math.floor(columns * 0.18)))
  const barCols = Math.max(12, columns - titleW - 12)

  const agentRows = (bar: Bar) => {
    if (folded || bar.agents.length === 0) return []
    const shown = bar.agents.slice(-MAX_AGENTS_SHOWN)
    const hidden = bar.agents.slice(0, -MAX_AGENTS_SHOWN)
    const rows = shown.map(a => {
      const c = AGENT_COLORS[a.state]
      const time =
        a.state === 'running' ? runningClock(now - a.startedAt) : seconds((a.endedAt ?? now) - a.startedAt)
      const meta = `(${a.model}${a.effort ? ` · ${a.effort}` : ''})`
      return (
        <Box key={`agent-${bar.id}-${a.id}`} flexDirection="row" gap={1}>
          <Box width={5}>
            <Text dimColor>🤖 {a.index}</Text>
          </Box>
          <Box flexGrow={1} flexDirection="row" backgroundColor={c.row} paddingX={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                <Text color={c.dot}>● </Text>
                {a.description} <Text dimColor>{meta}</Text>
                {a.tool ? <Text color="#9b87f5">{`   ${a.tool}`}</Text> : null}
              </Text>
            </Box>
            <Text tabular>{time}</Text>
          </Box>
        </Box>
      )
    })
    if (hidden.length > 0) {
      const done = hidden.filter(a => a.state === 'done').length
      rows.push(
        <Box key={`agent-${bar.id}-more`} flexDirection="row" gap={1}>
          <Box width={5}>
            <Text dimColor>🤖 +{hidden.length}</Text>
          </Box>
          <Box flexGrow={1} backgroundColor="#2b2b30" paddingX={1}>
            <Text dimColor>
              {hidden.length} more agent{hidden.length > 1 ? 's' : ''} · {done} done
            </Text>
          </Box>
        </Box>,
      )
    }
    return rows
  }

  const drawBar = (bar: Bar) => {
    if (isTerminal || !Svg) {
      const moving = live.twinkle && isWorking && bar.state === 'running'
      const cells = barCells(bar, barCols, now, moving ? frame : 0)
      // Runs of cells with the same colors become one Text.
      const runs: Cell[] = []
      for (const cell of cells) {
        const last = runs[runs.length - 1]
        if (last && last.fg === cell.fg && last.bg === cell.bg && last.bold === cell.bold) last.ch += cell.ch
        else runs.push({ ...cell })
      }
      return (
        <Text wrap="truncate-end">
          {runs.map(r => (
            <Text color={r.fg} backgroundColor={r.bg} bold={r.bold}>
              {r.ch}
            </Text>
          ))}
        </Text>
      )
    }
    const width = Math.max(160, Math.min(1400, barCols * 8))
    return (
      <Svg
        source={barSvg(bar, width, 26, now, live.twinkle)}
        alt={`${bar.title}: ${percent(bar)}%, ${pillLabel(bar, now)}`}
        width={width}
        height={26}
        isInteractive
      />
    )
  }

  return (
    <Box flexDirection="column">
      {list.map((bar, i) => (
        <Box key={`bar-${bar.id}`} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Box width={titleW} flexDirection="row">
              <Text color={COLORS[bar.state].pill}>{ICONS[bar.state]} </Text>
              <Text weight="semibold" wrap="truncate-end">
                {bar.title}
              </Text>
            </Box>
            <Box flexGrow={1}>{drawBar(bar)}</Box>
            <Box width={5}>
              <Text dimColor tabular>
                {`${percent(bar)}%`.padStart(4)}
              </Text>
            </Box>
            <Button key={`close-${bar.id}`} label="✕" plain dimColor onPress={close(bar.id)} />
          </Box>
          {bar.note && bar.state !== 'running' && bar.state !== 'done' ? (
            <Box paddingLeft={titleW + 1}>
              <Text color={COLORS[bar.state].pill} wrap="truncate-end">
                {bar.note}
              </Text>
            </Box>
          ) : null}
          {agentRows(bar)}
        </Box>
      ))}
    </Box>
  )
}

export const register: Register = (on, options) => {
  const opts = options as unknown as Options
  live.doneBarMs = Math.max(1, Number(opts.doneBarSeconds ?? 30)) * 1000
  live.sounds = opts.sounds !== false
  live.twinkle = opts.twinkle !== false


  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    const sessionKey = `bars:${id}`
    live.sessionKey = sessionKey

    // Keep a short index of sessions so the store does not grow forever.
    const index = ((await $.store.get('sessions')) as string[] | undefined) ?? []
    const kept = [...index.filter(k => k !== sessionKey), sessionKey]
    for (const old of kept.slice(0, Math.max(0, kept.length - KEPT_SESSIONS))) {
      await $.store.delete(old)
    }
    await $.store.set('sessions', kept.slice(-KEPT_SESSIONS))

    // A resumed session gets its bars back.
    const current = await read($, bars)
    if (current.length === 0) {
      const saved = (await $.store.get(sessionKey)) as Bar[] | undefined
      if (Array.isArray(saved) && saved.length > 0) await update($, bars, () => saved)
    }
    for (const b of await read($, bars)) for (const a of b.agents) agentBar.set(a.id, b.id)

    await $.tool.register({
      name: TOOL_NAME,
      isDeferred: false,
      description: [
        'Shows a live progress bar above the user\'s prompt for a multi-step task. Use it for any task with 3 or more steps.',
        'Create once with the whole plan: {id, title, stages:[{name, steps:[{title}]}]} (or {id, title, kind:"todo", steps:[{title}]} for one flat list).',
        '2-7 stages, titles of at most 4 words, in the user\'s language, one id per task. The first open step becomes active.',
        'Then move it with short ops: {id, next:true} finishes the active step and starts the next;',
        '{id, done:["A"], active:"B"} marks steps done and picks the current one; {id, failed:"B", note} marks an error;',
        '{id, state:"needs_input", note} right before asking the user something; {id, state:"done"} when the task is finished.',
        'If the plan changes, resend stages under the same id: finished steps are kept by title.',
        'An unknown step title is refused with the list of the bar\'s steps. The result says done/total, state and the active step.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable id of the task, e.g. "checkout"' },
          title: { type: 'string', description: 'Short task title (at most 4 words)' },
          kind: { type: 'string', enum: ['plan', 'todo'] },
          stages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                steps: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      status: { type: 'string', enum: ['pending', 'active', 'done', 'failed'] },
                    },
                    required: ['title'],
                  },
                },
              },
              required: ['name', 'steps'],
            },
          },
          steps: {
            type: 'array',
            items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
          },
          next: { type: 'boolean' },
          done: { type: 'array', items: { type: 'string' } },
          active: { type: 'string' },
          failed: { type: 'string' },
          state: { type: 'string', enum: ['running', 'needs_input', 'error', 'done'] },
          note: { type: 'string' },
        },
        required: ['id'],
      },
    })

    for (const [name, description] of [
      ['progress', 'Show or hide the plan progress bars'],
      ['progress-clear', 'Remove all plan progress bars'],
      ['progress-agents', 'Fold or show the agent rows under the bars'],
      ['plan-progress-autoclose', 'Turn on or off finished bars leaving on their own'],
      ['progress-pane', 'Show the plan progress bars in a side pane'],
    ] as const) {
      await $.command.register({ name, description })
    }

    await keepTicking($)
    return next(e)
  })

  // The tool only changes the bars in memory, so it never needs a prompt.
  on('tool.check', { tool: TOOL_PATTERN }, () => ({ decision: 'allow' as const }))

  on('tool.call', { tool: TOOL_PATTERN }, async ($, e) => {
    const outcome = await applyAndReport($, e as unknown as ToolInput)
    if (outcome.error !== undefined) return { deny: outcome.error }
    return { result: summary(outcome.bar) }
  })

  // An approved plan from plan mode becomes the bar "plan".
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId || ran.deny !== undefined || ran.isError) return ran
    const plan = (ran.result as { plan?: string | null } | undefined)?.plan
    if (plan) {
      const stages = stagesFromMarkdown(plan)
      const title = (/^#\s+(?:Plan:\s*)?(.+)$/m.exec(plan)?.[1] ?? 'Plan').slice(0, 40)
      if (stages.length > 0) await applyAndReport($, { id: 'plan', title, stages })
    }
    return ran
  }).catch(($, e, next) => next(e))

  // A subagent's row: which tool it is on now.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    const barId = agentId ? agentBar.get(agentId) : undefined
    if (agentId && barId) {
      const tool = String(e.tool).replace(/^mcp__.+?__/, '')
      await setAgent($, barId, agentId, { tool })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A new subagent joins the most recently moved bar that is still open.
  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (!ran.agentId) return ran
    const agentId = ran.agentId
    const now = await $.clock.now()
    const list = await read($, bars)
    const target = [...list]
      .filter(b => b.state !== 'done')
      .sort((a, b) => b.touchedAt - a.touchedAt)[0]
    if (!target) return ran
    agentBar.set(agentId, target.id)
    await mutate($, all =>
      all.map(b => {
        if (b.id !== target.id) return b
        const row: AgentRow = {
          id: agentId,
          index: b.agents.length + 1,
          description: e.description || e.subagentType,
          model: modelLabel(ran.model ?? e.model ?? e.parentModel),
          state: 'running',
          startedAt: now,
        }
        return { ...b, agents: [...b.agents, row].slice(-40) }
      }),
    )
    return ran
  }).catch(($, e, next) => next(e))

  // The effort a subagent runs at, read off its first model request.
  on('turn.step', async function* ($, e, next) {
    const agentId = (e as { agentId?: string }).agentId
    const barId = agentId ? agentBar.get(agentId) : undefined
    if (agentId && barId && typeof e.effort === 'string') {
      const effort = e.effort
      const list = await read($, bars)
      const row = list.find(b => b.id === barId)?.agents.find(a => a.id === agentId)
      if (row && row.effort !== effort) {
        await setAgent($, barId, agentId, { effort })
      }
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    const barId = agentId ? agentBar.get(agentId) : undefined
    if (agentId && barId) {
      const now = await $.clock.now()
      const state = e.isAborted || e.reason === 'error' || e.reason === 'refusal' ? 'error' : 'done'
      await setAgent($, barId, agentId, { state, endedAt: now, tool: undefined })
    }
    return next(e)
  })

  on('command.run', { command: 'progress' }, async $ => {
    let hidden = false
    await update($, isHidden, v => (hidden = !v))
    return { text: hidden ? 'Plan progress bars hidden.' : 'Plan progress bars shown.' }
  })

  on('command.run', { command: 'progress-clear' }, async $ => {
    agentBar.clear()
    await mutate($, () => [])
    return { text: 'Plan progress bars cleared.' }
  })

  on('command.run', { command: 'progress-agents' }, async $ => {
    let folded = false
    await update($, isAgentsFolded, v => (folded = !v))
    return { text: folded ? 'Agent rows folded.' : 'Agent rows shown.' }
  })

  on('command.run', { command: 'plan-progress-autoclose' }, async $ => {
    const isOn = (await $.store.get('autoclose')) !== true
    await $.store.set('autoclose', isOn)
    if (isOn) {
      for (const b of await read($, bars)) if (b.state === 'done') await scheduleAutoclose($, b.id)
    }
    return {
      text: isOn
        ? `Finished bars now leave after ${live.doneBarMs / 1000}s.`
        : 'Finished bars now stay until closed.',
    }
  })

  on('command.run', { command: 'progress-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Plan progress' })
    return { text: 'Plan progress pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const list = await read($, bars)
    if (list.length === 0) return next(e)
    live.bandSeen = true
    return drawBars($, e, list, e.props.bodyColumns, e.props.isWorking)
  })

  // The same bars in a side pane, for surfaces that draw no band (a cloud
  // session watched from the app) or when opened with /progress-pane.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, bars)
    if (list.length === 0) {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>No plans yet.</Text>
    }
    return drawBars($, e, list, e.props.bodyColumns, true)
  })
}
