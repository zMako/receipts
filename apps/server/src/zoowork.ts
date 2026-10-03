import {
  assistantText,
  createZooworkClient,
  isRunFinished,
  runOutcome,
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

export async function defaultModel(): Promise<string> {
  const models = await zc.listModels()
  const row = models.find((m) => m.selectable !== false && m.default_for?.includes('model'))
  if (!row) throw new Error('No selectable default ZooWork model')
  return row.model
}

/**
 * Create-once helper. Agents own a persistent sandbox, so we persist the agent_id
 * per logical name under .state/ and reuse it across restarts.
 */
export async function ensureAgent(
  name: string,
  build: (model: string) => Record<string, unknown>,
): Promise<string> {
  const state = await readState()
  if (state[name]) {
    try {
      const rec = await zc.getAgent(state[name])
      if (rec.status?.desired_state !== 'running') {
        await zc.startAgent(state[name])
        await zc.waitUntilRunning(state[name])
      }
      return state[name]
    } catch (err) {
      console.warn(`[zoowork] stored agent ${name} unusable, recreating:`, (err as Error).message)
    }
  }
  const model = await defaultModel()
  const created = await zc.createAgent({ resource: { name, model: { primary: model }, ...build(model) } }, `receipts-${name}-v1`)
  state[name] = created.agent_id
  await writeState(state)
  await zc.startAgent(created.agent_id)
  await zc.waitUntilRunning(created.agent_id)
  return created.agent_id
}

/** One-shot turn: new session, one user message, return the assistant text. */
export async function ask(agentId: string, content: string, onEvent?: (e: unknown) => void): Promise<string> {
  const session = await zc.createSession(agentId, { initial_events: [{ type: 'user.message', content }] })
  let text = ''
  for await (const event of zc.streamEvents(agentId, session.session_id)) {
    onEvent?.(event)
    text += assistantText(event)
    if (isRunFinished(event)) {
      const outcome = runOutcome(event)
      if (outcome !== 'succeeded') throw new Error(`ZooWork run ${outcome}`)
      break
    }
  }
  return text
}
