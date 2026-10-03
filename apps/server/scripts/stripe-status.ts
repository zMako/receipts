import '../src/env.js'
const id = process.argv[2]
const res = await fetch(`https://api.stripe.com/v1/disputes/${id}`, { headers: { Authorization: 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64') } })
const d = (await res.json()) as { id: string; status: string; evidence_details?: { submission_count?: number } }
console.log(d.id, 'status:', d.status, 'submissions:', d.evidence_details?.submission_count)
