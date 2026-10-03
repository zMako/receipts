import '../src/env.js'
// Prints only mode and error status. Never prints the key.
const key = process.env.STRIPE_SECRET_KEY
if (!key) throw new Error('STRIPE_SECRET_KEY missing')
const res = await fetch('https://api.stripe.com/v1/balance', {
  headers: { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64') },
})
const body = (await res.json()) as { livemode?: boolean; error?: { message?: string } }
console.log('status', res.status, '| livemode:', body.livemode, '| error:', body.error?.message ?? 'none')
