export type StepStatus = 'pending' | 'active' | 'done' | 'failed'

export type Step = {
  title: string
  status: StepStatus
  startedAt?: number
  endedAt?: number
}

export type Stage = { name: string; steps: Step[] }

export type BarState = 'running' | 'needs_input' | 'error' | 'done'

export type AgentState = 'running' | 'done' | 'error'

export type AgentRow = {
  id: string
  index: number
  description: string
  model: string
  effort?: string
  tool?: string
  state: AgentState
  startedAt: number
  endedAt?: number
}

export type Bar = {
  id: string
  title: string
  stages: Stage[]
  state: BarState
  note?: string
  startedAt: number
  finishedAt?: number
  touchedAt: number
  agents: AgentRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'plan-progress': {
      bars: Shaped<Bar[]>
      isHidden: boolean
      isAgentsFolded: boolean
      tick: number
    }
  }
}
