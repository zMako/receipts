import type { Merchant, Product } from './types.js'

export const MERCHANT: Merchant = {
  name: 'Harbor & Pine Outfitters',
  domain: 'harborandpine.com',
  platform: 'Shopify (Stripe payments)',
  return_policy: {
    version: '2026-08-01',
    window_days: 30,
    url: 'https://harborandpine.com/policies/returns',
    text: 'Unworn items with tags may be returned within 30 days of delivery for a full refund. Final-sale items excluded. Refunds are issued after inspection unless noted otherwise.',
  },
  stripe_account: 'acct_test_harborpine',
  vamp: { window: '2026-09', tc05: 4120, tc40: 31, tc15: 24, threshold: 0.015 },
}

export const PRODUCTS: Product[] = [
  { sku: 'HP-JKT-RIDGE', name: 'Ridgeline Shell Jacket', category: 'outerwear', price: 189, weight_g: 620, sizes: ['XS', 'S', 'M', 'L', 'XL'], colors: ['Navy', 'Midnight', 'Olive'], ambiguity: 'Navy vs Midnight are near-identical in product photos; agents frequently pick the wrong one.' },
  { sku: 'HP-PRK-SUMMIT', name: 'Summit Down Parka', category: 'outerwear', price: 289, weight_g: 980, sizes: ['S', 'M', 'L', 'XL'], colors: ['Black', 'Spruce'] },
  { sku: 'HP-BOOT-TRAIL', name: 'Trailhead Hiking Boots', category: 'footwear', price: 169, weight_g: 1450, sizes: ['7', '8', '9', '10', '11', '12', '13'], ambiguity: 'US sizing only; EU sizes listed in the description text, not as a variant.' },
  { sku: 'HP-PACK-CAIRN', name: 'Cairn Daypack 22L', category: 'packs', price: 98, weight_g: 760, colors: ['Slate', 'Rust'] },
  { sku: 'HP-BASE-MERINO', name: 'Merino Base Layer', category: 'layers', price: 69, weight_g: 210, sizes: ['S', 'M', 'L', 'XL'] },
  { sku: 'HP-PANT-TIDE', name: 'Tidewater Rain Pants', category: 'outerwear', price: 119, weight_g: 410, sizes: ['S', 'M', 'L', 'XL'] },
  { sku: 'HP-FLC-BASE', name: 'Basecamp Fleece', category: 'layers', price: 89, weight_g: 480, sizes: ['S', 'M', 'L', 'XL'], colors: ['Charcoal', 'Moss'] },
  { sku: 'HP-SHOE-CREST', name: 'Crest Trail Runner', category: 'footwear', price: 139, weight_g: 640, sizes: ['7', '8', '9', '10', '11', '12'] },
  { sku: 'HP-VEST-EMBER', name: 'Ember Insulated Vest', category: 'layers', price: 129, weight_g: 390, sizes: ['S', 'M', 'L', 'XL'] },
  { sku: 'HP-HAT-LOOK', name: 'Lookout Sun Hat', category: 'accessories', price: 39, weight_g: 90 },
  { sku: 'HP-BELT-GRAN', name: 'Granite Belt', category: 'accessories', price: 29, weight_g: 120 },
  { sku: 'HP-SOCK-SWB', name: 'Switchback Socks 3-pack', category: 'accessories', price: 24, weight_g: 150 },
]

export const FIRST_NAMES = ['Ava', 'Liam', 'Noah', 'Mia', 'Ethan', 'Zoe', 'Lucas', 'Isla', 'Mason', 'Chloe', 'Elijah', 'Nora', 'Owen', 'Ruby', 'Caleb', 'Hazel', 'Jonah', 'Ivy', 'Miles', 'Leah', 'Theo', 'Elena', 'Felix', 'Maya', 'Silas', 'Priya', 'Rowan', 'Amara', 'Jude', 'Kai']
export const LAST_NAMES = ['Carter', 'Nguyen', 'Patel', 'Brooks', 'Kim', 'Alvarez', 'Hughes', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Reyes', 'Walsh', 'Bauer', 'Costa', 'Ferreira', 'Haddad', 'Novak', 'Sato', 'Dubois']
export const CITIES: { city: string; state: string; zip: string }[] = [
  { city: 'Portland', state: 'OR', zip: '97209' },
  { city: 'Seattle', state: 'WA', zip: '98103' },
  { city: 'Denver', state: 'CO', zip: '80205' },
  { city: 'Austin', state: 'TX', zip: '78704' },
  { city: 'Chicago', state: 'IL', zip: '60614' },
  { city: 'Boston', state: 'MA', zip: '02139' },
  { city: 'Oakland', state: 'CA', zip: '94610' },
  { city: 'Minneapolis', state: 'MN', zip: '55408' },
  { city: 'Asheville', state: 'NC', zip: '28801' },
  { city: 'Burlington', state: 'VT', zip: '05401' },
  { city: 'Salt Lake City', state: 'UT', zip: '84103' },
  { city: 'Boise', state: 'ID', zip: '83702' },
]
export const STREETS = ['Alder St', 'Juniper Ave', 'Cedar Ln', 'Harbor Dr', 'Pine Ct', 'Ridge Rd', 'Maple Way', 'Summit Blvd', 'Lakeview Ter', 'Birch Pl']

export const HUMAN_DEVICES = [
  { platform: 'macOS 15', browser: 'Safari 19', hardware: 'Apple M3, 2560x1664, Metal' },
  { platform: 'Windows 11', browser: 'Chrome 131', hardware: 'Intel UHD, 1920x1080, ANGLE D3D11' },
  { platform: 'iOS 19', browser: 'Mobile Safari', hardware: 'iPhone 16, 1179x2556' },
  { platform: 'Android 16', browser: 'Chrome 131', hardware: 'Pixel 9, 1080x2424, Adreno' },
  { platform: 'Windows 11', browser: 'Edge 131', hardware: 'NVIDIA RTX, 2560x1440, ANGLE D3D11' },
  { platform: 'macOS 15', browser: 'Chrome 131', hardware: 'Apple M2, 1728x1117, Metal' },
]

/** Every Muse session looks the same: one sandbox image, SwiftShader rendering, 2 vCPU, 7.7 GiB. */
export const MUSE_DEVICE = { platform: 'Linux x86_64 (Ubuntu 24.04)', browser: 'Chrome 131 (headful, virtualized)', hardware: '2 vCPU, 7.7 GiB, SwiftShader, 1280x720' }
/** Dots runs each agent on its own OpenAI-hosted cloud computer; the browser image is likewise uniform. */
export const DOTS_DEVICE = { platform: 'Linux x86_64 (cloud computer)', browser: 'Chrome 131 (headful, virtualized)', hardware: '4 vCPU, 16 GiB, SwiftShader, 1440x900' }
export const AGENT_RUNTIME_DEVICE = { platform: 'Agent runtime', browser: 'HTTP client (signed)', hardware: 'n/a' }

export const RESIDENTIAL_ASNS = [
  { asn: 7922, org: 'Comcast Cable', prefix: '73.' },
  { asn: 701, org: 'Verizon', prefix: '71.' },
  { asn: 7018, org: 'AT&T', prefix: '99.' },
  { asn: 20115, org: 'Charter Spectrum', prefix: '47.' },
  { asn: 22773, org: 'Cox Communications', prefix: '68.' },
  { asn: 21928, org: 'T-Mobile USA', prefix: '172.58.' },
]
export const CLOUD_EGRESS_ASNS = [
  { asn: 13335, org: 'Cloudflare', prefix: '104.16.' },
  { asn: 54113, org: 'Fastly', prefix: '151.101.' },
]
export const SIGNED_AGENTS = [
  { origin: 'https://agent.cartwright.ai', ua: 'Cartwright-Agent/2.1 (+https://agent.cartwright.ai/bot)' },
  { origin: 'https://shopper.lumen.app', ua: 'LumenShopper/1.0 (+https://shopper.lumen.app/agent)' },
]
export const MUSE_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
