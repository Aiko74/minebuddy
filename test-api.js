'use strict'
// Test du cerveau SANS Minecraft : vérifie la clé API, le modèle et le format des requêtes.
// Lance : npm run test-api
require('dotenv').config()
const { Brain } = require('./brain')

if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-...')) {
  console.error('❌ Mets ta clé API dans le fichier .env (ANTHROPIC_API_KEY=...)')
  process.exit(1)
}

const owner = process.env.OWNER || 'Testeur'
let jumped = false
const fakeBot = { username: process.env.MC_USERNAME || 'Claude', chat: (m) => console.log(`[chat du jeu] ${m}`) }
const fakeActions = {
  tools: [{ name: 'sauter', description: 'Faire un petit saut (pour saluer).', input_schema: { type: 'object', properties: {}, required: [] } }],
  etat: () => '[état] vie 20/20, faim 20/20, test hors du jeu.',
  run: async (name) => { if (name === 'sauter') jumped = true; return 'Sauté.' },
  mission: () => null,
  missionGains: () => '',
  priorites: () => [],
  endMission: () => {}
}
const fakeMemoire = { texte: () => 'Ta mémoire : (test, vide)' }
const memory = { history: [], usage: { input: 0, output: 0, cacheRead: 0, calls: 0 } }
const brain = new Brain({ bot: fakeBot, actions: fakeActions, owner, model: process.env.MODEL || 'claude-haiku-5-5', effort: process.env.EFFORT || 'low', memory, memoire: fakeMemoire })

;(async () => {
  await brain.push(`<${owner}> salut ! fais un petit saut pour me dire bonjour`)
  // deuxième message : vérifie que la conversation continue sans erreur
  await brain.push(`<${owner}> merci, ça va ?`)
  const ok = memory.usage.calls > 0 && memory.history.length > 0
  console.log(ok
    ? `\n✅ Le cerveau marche (${memory.usage.calls} appels${jumped ? ', il a bien utilisé une action' : ''}).`
    : '\n❌ Le cerveau ne répond pas : regarde l\'erreur au-dessus.')
  process.exit(ok ? 0 : 1)
})()
