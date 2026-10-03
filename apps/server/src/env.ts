import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '../../.env') })
config()

export function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var ${name}`)
  return v
}

export const BAND_AGENT_NAMES = ['history', 'logistics', 'identity', 'forensics', 'critic'] as const
export type BandAgentName = (typeof BAND_AGENT_NAMES)[number]

export function bandCredentials(name: BandAgentName): { agentId: string; apiKey: string } {
  const key = name.toUpperCase()
  return {
    agentId: requireEnv(`BAND_${key}_AGENT_ID`),
    apiKey: requireEnv(`BAND_${key}_API_KEY`),
  }
}
