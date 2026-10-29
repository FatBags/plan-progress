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

  const made = await $.tool.call(PLAN)
  expect(made.text ?? String(made.result)).toContain('0/4, running, active: Routes')

  const moved = await $.tool.call({ tool: TOOL, id: 'checkout', next: true })
  expect(String(moved.result)).toContain('1/4, running, active: Cart')

  const jumped = await $.tool.call({ tool: TOOL, id: 'checkout', done: ['Cart'], active: 'Review' })
  expect(String(jumped.result)).toContain('2/4, running, active: Review')

  const refused = await $.tool.call({ tool: TOOL, id: 'checkout', done: ['Nope'] })
  expect(refused.deny ?? refused.text).toContain('Unknown step: Nope')
  expect(refused.deny ?? refused.text).toContain('Build: Routes, Cart')

  const asking = await $.tool.call({ tool: TOOL, id: 'checkout', state: 'needs_input', note: 'Which tax?' })
  expect(String(asking.result)).toContain('needs_input')
  expect(played).toContain('sounds/decision.wav')

  const failed = await $.tool.call({ tool: TOOL, id: 'checkout', failed: 'Review', note: 'boom' })
  expect(String(failed.result)).toContain('error')
  expect(played).toContain('sounds/error.wav')

  const finished = await $.tool.call({ tool: TOOL, id: 'checkout', state: 'done' })
  expect(String(finished.result)).toContain('4/4, done')
  expect(played).toContain('sounds/done.wav')
})

test('a replan keeps finished steps by title', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(PLAN)
  await $.tool.call({ tool: TOOL, id: 'checkout', next: true })

  const replanned = await $.tool.call({
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
  await $.tool.call(PLAN)
  await $.tool.call({ tool: TOOL, id: 'checkout', next: true })
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
