import '../src/env.js'
import { BAND_AGENT_NAMES, bandCredentials, requireEnv } from '../src/env.js'
import { BandAgentClient } from '../src/band.js'
import { zc, defaultModel } from '../src/zoowork.js'

async function main() {
  console.log('== ZooWork ==')
  const models = await zc.listModels()
  console.log(`models: ${models.length}; default: ${await defaultModel()}`)

  console.log('\n== Band ==')
  const roomTitle = requireEnv('BAND_ROOM')
  for (const name of BAND_AGENT_NAMES) {
    const { apiKey } = bandCredentials(name)
    const client = new BandAgentClient(name, apiKey)
    const me = await client.me()
    const room = await client.findRoomByTitle(roomTitle)
    console.log(`${name.padEnd(10)} -> @${me.handle} (${me.id})  room: ${room ? room.id : 'NOT A PARTICIPANT of "' + roomTitle + '"'}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
