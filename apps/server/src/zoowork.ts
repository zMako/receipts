import {
  assistantText,
  createZooworkClient,
  customToolUse,
  isRunFinished,
  runOutcome,
  toolCall,
  type CustomToolDeclaration,
  type CustomToolResultContent,
  type SessionEvent,
  type ZooworkClient,
} from '@zoowork-ai/sdk'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

export const zc: ZooworkClient = createZooworkClient()

const STATE_DIR = resolve(process.cwd(), '.state')
const STATE_FILE = resolve(STATE_DIR, 'zoowork-agents.json')

async function readState(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

async function writeState(state: Record<string, string>): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
}

let modelCache: string | undefined
export async function defaultModel(): Promise<string> {
  if (modelCache) return modelCache
  const models = await zc.listModels()
  const row = models.find((m) => m.selectable !== false && m.default_for?.includes('model'))
  if (!row) throw new Error('No selectable default ZooWork model')
  modelCache = row.model
  return modelCache
}

export interface AgentSpec {
  persona: { docs: { name: string; content: string }[] }
  custom_tools: CustomToolDeclaration[]
}

/**
 * Create-once helper. Agents own a persistent sandbox, so we persist the agent_id per logical
 * name under .state/ and reuse it across restarts. The declared persona and tools are re-synced
 * on every boot so edits to the spec take effect without recreating the agent.
 */
export async function ensureAgent(name: string, spec: AgentSpec): Promise<string> {
  const state = await readState()
  const model = await defaultModel()
  if (state[name]) {
    try {
      const rec = await zc.getAgent(state[name])
      await zc.updateAgent(state[name], { persona: spec.persona, custom_tools: spec.custom_tools, include_global_skills: false })
      if (rec.status?.desired_state !== 'running') {
        await zc.startAgent(state[name])
        await zc.waitUntilRunning(state[name])
      }
      return state[name]
    } catch (err) {
      console.warn(`[zoowork] stored agent ${name} unusable, recreating:`, (err as Error).message)
    }
  }
  const created = await zc.createAgent(
    { resource: { name, model: { primary: model }, persona: spec.persona, custom_tools: spec.custom_tools, include_global_skills: false, skills: [] } },
    `receipts-${name}-v1`,
  )
  state[name] = created.agent_id
  await writeState(state)
  await zc.startAgent(created.agent_id)
  await zc.waitUntilRunning(created.agent_id)
  return created.agent_id
}

export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<unknown>

export interface RunOptions {
  timeoutMs?: number
  onTool?: (name: string, input: Record<string, unknown>) => void
  onBuiltinTool?: (name: string) => void
  onText?: (text: string) => void
}

/**
 * One turn in a fresh session. Application-executed custom tools are resolved through `exec`.
 * Returns the assistant text, or throws on failure/timeout.
 */
export async function runTurn(agentId: string, content: string, exec: ToolExecutor, opts: RunOptions = {}): Promise<string> {
  const session = await zc.createSession(agentId, { initial_events: [{ type: 'user.message', content }] })
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000)
  let text = ''
  let cursor: string | undefined
  const handled = new Set<string>()

  const handleEvent = async (ev: SessionEvent): Promise<boolean> => {
    cursor = ev.cursor ?? cursor
    const t = assistantText(ev)
    if (t) {
      text += t
      opts.onText?.(t)
    }
    const tc = toolCall(ev)
    if (tc?.phase === 'start') opts.onBuiltinTool?.(tc.toolName)
    const ct = customToolUse(ev)
    if (ct?.phase === 'requested' && ct.name && !handled.has(ct.callId)) {
      handled.add(ct.callId)
      const input = ct.input ?? {}
      opts.onTool?.(ct.name, input)
      let content: CustomToolResultContent[]
      let isError = false
      try {
        const value = await exec(ct.name, input)
        content = [{ type: 'json', value: value ?? { ok: true } }]
      } catch (err) {
        isError = true
        content = [{ type: 'text', text: `Tool failed: ${(err as Error).message}` }]
      }
      await zc.resolveCustomToolCall(agentId, ct.callId, { content, isError })
    }
    if (isRunFinished(ev)) {
      const outcome = runOutcome(ev)
      if (outcome !== 'succeeded') throw new Error(`ZooWork run ${outcome}`)
      return true
    }
    return false
  }

  // The stream can close on idle; resume from the last cursor until the run finishes or we time out.
  while (Date.now() < deadline) {
    const signal = AbortSignal.timeout(Math.max(1_000, deadline - Date.now()))
    let finished = false
    for await (const ev of zc.streamEvents(agentId, session.session_id, { cursor, signal })) {
      if (await handleEvent(ev)) {
        finished = true
        break
      }
    }
    if (finished) return text
    if (signal.aborted) break
  }
  try {
    await zc.postEvents(agentId, session.session_id, [{ type: 'user.interrupt' }])
  } catch {
    /* best effort */
  }
  throw new Error('ZooWork turn timed out')
}
