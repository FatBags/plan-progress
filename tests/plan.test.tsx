import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__plan-progress__plan_progress' as const

const BAND = {
  plugin: 'plan-progress',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 30,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const PLAN = {
  tool: TOOL,
  id: 'checkout',
  title: 'Checkout flow',
  stages: [
    { name: 'Build', steps: [{ title: 'Routes' }, { title: 'Cart' }] },
    { name: 'Harden', steps: [{ title: 'Tests' }] },
    { name: 'Verify', steps: [{ title: 'Review' }] },
  ],
}

// The plugin's own tool, which the typed tool table may not list yet.
type Caller = { tool: { call: (input: never) => Promise<{ result?: unknown; text?: string; deny?: string }> } }
function callTool($: Caller, input: object) {
  return $.tool.call(input as never)
}

// Stands for the engine beneath the plugin.
function engine(on: On) {
  const played: string[] = []
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 'session-1' }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('audio.play', (_, e) => {
    played.push(String((e.clip as { asset?: string }).asset))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // The engine's own band, drawn when the mod has nothing to show.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return { played, clock }
}

test('a plan moves through its steps', async ($, on) => {
  const { played } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const made = await callTool($, PLAN)
  expect(made.text ?? String(made.result)).toContain('0/4, running, active: Routes')

  const moved = await callTool($, { tool: TOOL, id: 'checkout', next: true })
  expect(String(moved.result)).toContain('1/4, running, active: Cart')

  const jumped = await callTool($, { tool: TOOL, id: 'checkout', done: ['Cart'], active: 'Review' })
  expect(String(jumped.result)).toContain('2/4, running, active: Review')

  const refused = await callTool($, { tool: TOOL, id: 'checkout', done: ['Nope'] })
  expect(refused.deny ?? refused.text).toContain('Unknown step: Nope')
  expect(refused.deny ?? refused.text).toContain('Build: Routes, Cart')

  const asking = await callTool($, { tool: TOOL, id: 'checkout', state: 'needs_input', note: 'Which tax?' })
  expect(String(asking.result)).toContain('needs_input')
  expect(played).toContain('sounds/decision.wav')

  const failed = await callTool($, { tool: TOOL, id: 'checkout', failed: 'Review', note: 'boom' })
  expect(String(failed.result)).toContain('error')
  expect(played).toContain('sounds/error.wav')

  const finished = await callTool($, { tool: TOOL, id: 'checkout', state: 'done' })
  expect(String(finished.result)).toContain('4/4, done')
  expect(played).toContain('sounds/done.wav')
})

test('a replan keeps finished steps by title', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await callTool($, PLAN)
  await callTool($, { tool: TOOL, id: 'checkout', next: true })

  const replanned = await callTool($, {
    tool: TOOL,
    id: 'checkout',
    title: 'Checkout flow',
    stages: [
      { name: 'Build', steps: [{ title: 'Routes' }, { title: 'Webhooks' }] },
      { name: 'Verify', steps: [{ title: 'Review' }] },
    ],
  })
  expect(String(replanned.result)).toContain('1/3, running, active: Webhooks')
})

test('the band draws bars and agent rows on both surfaces', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: '' }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await callTool($, PLAN)
  await callTool($, { tool: TOOL, id: 'checkout', next: true })
  await $.agent.spawn({
    tool_use_id: 't1',
    prompt: 'scan',
    description: 'Scan checkout tests',
    subagentType: 'general-purpose',
    background: false,
  } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Checkout flow/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /25%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Scan checkout tests/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /haiku 4\.5/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({
    answer: 'ok',
    durationMs: 6000,
    isAborted: false,
    turnId: 'x',
    agentId: 'agent-1',
    reason: 'answer',
  } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'close-checkout' })
  expect(await ui.find({ type: 'Text', text: /Checkout flow/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

const PANE = {
  plugin: 'plan-progress',
  component: 'Pane',
  requestId: 'plan-progress',
  props: {
    title: 'Plan progress',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('where no band draws, the bars open in a pane', async ($, on) => {
  const { clock } = engine(on)
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-2' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await callTool($, PLAN)
  await $.agent.spawn({
    tool_use_id: 't2',
    prompt: 'list',
    description: 'List webhooks',
    subagentType: 'general-purpose',
    background: false,
  } as never)
  await clock.advance(2000)
  expect(opened).toEqual(['plan-progress'])

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Checkout flow/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /List webhooks/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /sonnet 5\.5/ })).toBeDefined()
    await ui.unmount()
  }
})

test('where the band draws, no pane opens by itself', async ($, on) => {
  const { clock } = engine(on)
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await callTool($, PLAN)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(2000)
  expect(opened).toEqual([])
  await band.unmount()

  const ran = await $.command.run({ command: 'progress-pane', args: '' } as never)
  expect(ran.text).toBe('Plan progress pane opened.')
  expect(opened).toEqual(['plan-progress'])
})
