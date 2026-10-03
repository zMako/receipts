/**
 * Ed25519 key store for locally registered test agents. Keys live in apps/server/.state/agent-keys.json
 * and are generated on first use. Both the server (to serve the JWKS directory) and the test clients
 * (to sign) read this file.
 */
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifierFromJWK } from 'web-bot-auth/crypto'
import type { JSONWebKeySet } from 'web-bot-auth'
import type { Jwk } from './types.js'

export interface StoredAgentKey {
  name: string
  /** RFC 7638 JWK thumbprint, base64url SHA-256; this is the `keyid` in Signature-Input. */
  kid: string
  alg: 'EdDSA'
  public_jwk: Jwk
  private_jwk: Jwk
  created_at: string
}

export const KEY_STORE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../.state/agent-keys.json')

export function loadKeyStore(): Record<string, StoredAgentKey> {
  if (!existsSync(KEY_STORE_PATH)) return {}
  try {
    return JSON.parse(readFileSync(KEY_STORE_PATH, 'utf8')) as Record<string, StoredAgentKey>
  } catch {
    return {}
  }
}

function saveKeyStore(store: Record<string, StoredAgentKey>): void {
  mkdirSync(dirname(KEY_STORE_PATH), { recursive: true })
  writeFileSync(KEY_STORE_PATH, JSON.stringify(store, null, 2) + '\n')
}

export function getAgentKey(name: string): StoredAgentKey | undefined {
  return loadKeyStore()[name]
}

/** Load the agent's key, generating and persisting a fresh Ed25519 pair on first use. */
export async function ensureAgentKey(name: string): Promise<StoredAgentKey> {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new Error(`invalid agent name ${name}`)
  const store = loadKeyStore()
  const hit = store[name]
  if (hit) return hit
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'jwk' }) as JsonWebKey
  const priv = privateKey.export({ format: 'jwk' }) as JsonWebKey
  const kid = (await verifierFromJWK(pub)).keyid
  const public_jwk: Jwk = { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', kid, x: pub.x }
  const private_jwk: Jwk = { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', kid, x: priv.x, d: priv.d }
  const rec: StoredAgentKey = { name, kid, alg: 'EdDSA', public_jwk, private_jwk, created_at: new Date().toISOString() }
  store[name] = rec
  saveKeyStore(store)
  return rec
}

/** JWKS document for `/.well-known/http-message-signatures-directory` (public keys only). */
export function jwksFor(name: string): JSONWebKeySet | undefined {
  const k = getAgentKey(name)
  if (!k) return undefined
  return { keys: [k.public_jwk] }
}

export function listLocalAgents(): string[] {
  return Object.keys(loadKeyStore())
}
