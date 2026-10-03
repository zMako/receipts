import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Dataset } from './types.js'

export * from './types.js'
export * from './vault.js'
export { MERCHANT, PRODUCTS } from './catalog.js'

export function loadDataset(): Dataset {
  const here = dirname(fileURLToPath(import.meta.url))
  return JSON.parse(readFileSync(resolve(here, '../data/dataset.json'), 'utf8')) as Dataset
}
export * from './events.js'
export * from './replay.js'
