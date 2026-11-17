'use strict'
require('dotenv').config()

const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const pvp = require('mineflayer-pvp').plugin
const collectBlock = require('mineflayer-collectblock').plugin
const { createActions } = require('./actions')
const { Brain } = require('./brain')
const { createMemoire } = require('./memoire')

// Tout ce qui s'affiche dans le terminal est aussi écrit dans bot.log (pratique pour déboguer)
const fs = require('fs')
const path = require('path')
// Dossier des données : celui de l'appli MineBuddy (MB_DATA_DIR) ou, en ligne de commande, le dossier du projet
const DATA = process.env.MB_DATA_DIR || __dirname
const DANS_APPLI = !!process.send // lancé par l'appli MineBuddy (elle reçoit le journal et l'état)
const logFile = path.join(DATA, 'bot.log')
for (const level of ['log', 'error']) {
  const orig = console[level].bind(console)
  console[level] = (...args) => {
    orig(...args)
    const line = args.map(a => (typeof a === 'string' ? a : (a?.message || JSON.stringify(a)))).join(' ')
    try { fs.appendFileSync(logFile, `${new Date().toLocaleTimeString('fr-FR')} ${line}\n`) } catch (_) {}
  }
}

const env = process.env
if (!env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY.startsWith('sk-ant-...')) {
  console.error(DANS_APPLI ? '❌ Il manque la clé API : mets-la dans l\'onglet Connexion.' : '❌ Mets ta clé API dans le fichier .env (ANTHROPIC_API_KEY=...)')
  process.exit(2)
}

const OWNER = env.OWNER || ''
if (!OWNER || OWNER === 'TonPseudo') console.log('⚠ OWNER n\'est pas rempli dans .env : le bot ne répondra que si on dit son nom.')
const RESPOND_ALL = env.RESPOND_ALL === 'true'
const STOP_WORDS = /^(stop|arr[eê]te|arr[eê]te[- ]toi|stoppe|bouge plus|freeze)\b/i
const HOST = env.MC_HOST || 'localhost'
const PORT = Number(env.MC_PORT || 25565)

// Conversation conservée même si le bot se reconnecte
const memory = { history: [], usage: { input: 0, output: 0, cacheRead: 0, calls: 0 } }
// Lieux et souvenirs, gardés sur le disque (memoire.json) même quand on relance le bot
const memoire = createMemoire()

// Une erreur imprévue dans un plugin ne doit pas faire planter tout le bot
process.on('unhandledRejection', (e) => console.log('⚠ Erreur ignorée :', e?.message || e))
process.on('uncaughtException', (e) => console.error('💥 Erreur imprévue (le bot continue) :', e?.stack || e))

// ---------- boîte aux lettres : chaque ligne ajoutée à console.txt est un message de OWNER ----------
// (pour lui parler depuis l'ordinateur quand on n'est pas devant le jeu)
const INBOX = path.join(DATA, 'console.txt')
let inboxHandler = null
try { if (!fs.existsSync(INBOX)) fs.writeFileSync(INBOX, '') } catch (_) {}
let inboxSize = fs.existsSync(INBOX) ? fs.statSync(INBOX).size : 0
fs.watchFile(INBOX, { interval: 1000 }, (cur) => {
  if (cur.size < inboxSize) inboxSize = 0 // fichier vidé
  if (cur.size === inboxSize) return
  try {
    const fd = fs.openSync(INBOX, 'r')
    const buf = Buffer.alloc(cur.size - inboxSize)
    fs.readSync(fd, buf, 0, buf.length, inboxSize)
    fs.closeSync(fd)
    inboxSize = cur.size
    for (const line of buf.toString('utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean)) inboxHandler?.(line)
  } catch (e) { console.log('⚠ Boîte aux lettres illisible :', e.message) }
})

// ---------- lien avec l'appli MineBuddy (quand c'est elle qui lance le bot) ----------
// État actuel, partagé avec l'appli : bot, cerveau et actions de la connexion en cours
const etat = { bot: null, brain: null, actions: null, connecte: false }
if (DANS_APPLI) {
  process.on('message', (m) => {
    if (!m || typeof m !== 'object') return
    // un message tapé dans l'appli : comme s'il venait de console.txt
    if (m.type === 'say' && typeof m.text === 'string') return inboxHandler?.(m.text.trim())
    // modification de la mémoire depuis l'écran Mémoire
    if (m.type === 'memoire') {
      try {
        const a = m.args || {}
        if (m.op === 'setLieu') memoire.setLieu(a.nom, { x: Number(a.x), y: Number(a.y), z: Number(a.z) }, a.dimension || 'overworld')
        else if (m.op === 'removeLieu') memoire.removeLieu(a.nom)
        else if (m.op === 'addSouvenir') memoire.addSouvenir(a.texte)
        else if (m.op === 'editSouvenir') memoire.editSouvenir(a.index, a.texte)
        else if (m.op === 'removeSouvenir') memoire.removeSouvenir(a.index)
        else if (m.op === 'toutEffacer') memoire.toutEffacer()
        else if (m.op === 'setReglage') memoire.setReglage(a.nom, a.valeur)
        process.send({ type: 'memoire', id: m.id, ok: true, data: memoire.export() })
      } catch (e) {
        process.send({ type: 'memoire', id: m.id, ok: false, error: e.message })
      }
      return
    }
    // bouton « Arrêter » : il se déconnecte proprement
    if (m.type === 'stop') {
      try { etat.bot?.quit('Arrêté depuis MineBuddy') } catch (_) {}
      setTimeout(() => process.exit(0), 800)
    }
  })
  // toutes les 2 s : l'état du bot pour l'écran Pilotage
  setInterval(() => {
    const b = etat.bot
    const p = b?.entity?.position
    const d = memoire.reglage('depense', null)
    const aujourdhui = new Date().toLocaleDateString('fr-FR')
    try {
      process.send({
        type: 'status',
        data: {
          connecte: etat.connecte,
          nom: b?.username || env.MC_USERNAME || 'Claude',
          adresse: `${HOST}:${PORT}`,
          position: p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null,
          dimension: b?.game?.dimension || null,
          vie: etat.connecte ? Math.round(b.health ?? 0) : null,
          faim: etat.connecte ? Math.round(b.food ?? 0) : null,
          modele: etat.brain?.model || env.MODEL || 'claude-haiku-5-5',
          depense: d && d.jour === aujourdhui ? d.usd : 0,
          budget: Number(env.BUDGET_USD || 8),
          mission: etat.actions?.mission?.()?.objectif || null
        }
      })
    } catch (_) { /* l'appli est fermée */ }
  }, 2000)
}

function start () {
  console.log(`🔄 Connexion à ${HOST}:${PORT}...`)
  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: env.MC_USERNAME || 'Claude',
    auth: env.MC_AUTH || 'offline',
    version: env.MC_VERSION || false
  })
  // les récoltes / coups de pioche coupés par nos limites de temps laissent des écouteurs en attente :
  // sans gravité, mais Node affiche un avertissement au-delà de 10
  bot.setMaxListeners(100)
  etat.bot = bot
  etat.connecte = false

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(pvp)
  bot.loadPlugin(collectBlock)

  let actions = null
  let brain = null
  let stopRoutines = null
  let debugUntil = 0

  bot.once('spawn', () => {
    actions = createActions(bot, memoire)
    brain = new Brain({ bot, actions, owner: OWNER, model: env.MODEL || 'claude-haiku-5-5', effort: env.EFFORT || 'low', memory, memoire, budget: Number(env.BUDGET_USD || 8) })
    actions.onEvent((text) => brain.push(text))
    stopRoutines = actions.startRoutines()
    etat.actions = actions
    etat.brain = brain
    etat.connecte = true

    console.log(`✅ ${bot.username} est connecté (Minecraft ${bot.version}). Parle-lui dans le chat !`)
    brain.push(memory.history.length
      ? '[événement] Tu viens de te reconnecter au monde.'
      : memoire.estVide()
        ? `[événement] Tu viens d'arriver dans le monde de ${OWNER}. Dis-lui salut.`
        : `[événement] Tu reviens dans le monde de ${OWNER} après une coupure : tu as oublié la conversation récente, mais tu as ta mémoire (lieux, souvenirs). Dis-lui que tu es de retour, en une phrase.`)
  })

  function onMessage (username, message, whisper = false) {
    if (!brain || username === bot.username) return
    // retours de commandes (« [Aiko74: Set own game mode...] ») : ce n'est pas quelqu'un qui lui parle
    const count = (c) => message.split(c).length - 1
    if (/[^:;=]\]$/.test(message) && count(']') > count('[')) return
    const isOwner = OWNER && username.toLowerCase() === OWNER.toLowerCase()
    const mentioned = message.toLowerCase().includes(bot.username.toLowerCase())
    if (!(isOwner || whisper || mentioned || RESPOND_ALL)) return

    console.log(`💬 <${username}> ${message}`)
    // « stop » agit tout de suite, sans attendre l'IA
    if (STOP_WORDS.test(message.trim())) {
      actions.stopAll()
      brain.interrupt()
    } else {
      // une longue tâche en cours se met en pause pour qu'il te réponde vite
      actions.yieldToPlayer()
    }
    brain.push(`${whisper ? '(en privé) ' : ''}<${username}> ${message}`)
  }

  bot.on('chat', (u, m) => onMessage(u, m))
  bot.on('whisper', (u, m) => onMessage(u, m, true))

  // message de la boîte aux lettres : c'est OWNER qui écrit depuis l'ordinateur
  inboxHandler = (line) => {
    if (!brain) return
    // « ?paquets » : diagnostic, enregistre 12 s de paquets bruts sur les entités qui ne sont pas des créatures
    if (line.startsWith('?paquets')) {
      const names = ['spawn_entity', 'entity_velocity', 'rel_entity_move', 'entity_move_look', 'entity_teleport', 'sync_entity_position', 'entity_position_sync']
      const watched = new Set()
      const handlers = names.map(n => {
        const h = (p) => {
          if (n === 'spawn_entity') { const t = bot.registry.entities[p.type]?.name; if (!/eye|arrow/.test(t || '')) return; watched.add(p.entityId) } else if (!watched.has(p.entityId)) return
          console.log(`📦 ${n} ${JSON.stringify(p, (k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 300)}`)
        }
        bot._client.on(n, h)
        return [n, h]
      })
      setTimeout(() => handlers.forEach(([n, h]) => bot._client.removeListener(n, h)), 12000)
      console.log('📦 enregistrement des paquets pendant 12 s')
      return
    }
    // « ?blocs » : diagnostic, les blocs autour du bot (couche par couche, de y-1 à y+2)
    if (line.startsWith('?blocs')) {
      const p = bot.entity.position.floored()
      const court = (n) => n === 'air' || n === 'cave_air' ? '.' : n.replace(/^(jungle|oak|spruce|birch|dark_oak|acacia|mangrove|cherry)_/, '').slice(0, 6)
      console.log(`🧱 moi en ${bot.entity.position.x.toFixed(2)} ${bot.entity.position.y.toFixed(2)} ${bot.entity.position.z.toFixed(2)}, au sol: ${bot.entity.onGround}, dans l'eau: ${bot.entity.isInWater}`)
      const sous = bot.blockAt(bot.entity.position.offset(0, -0.5, 0))
      console.log(`🧱 sous mes pieds : ${sous?.name} (état ${sous?.stateId}) bbox=${sous?.boundingBox} formes=${JSON.stringify(sous?.shapes)} ; pieds: ${JSON.stringify(bot.blockAt(bot.entity.position)?.shapes)} ; tête: ${bot.blockAt(bot.entity.position.offset(0, 1, 0))?.name} ${JSON.stringify(bot.blockAt(bot.entity.position.offset(0, 1, 0))?.shapes)}`)
      // la physique tourne-t-elle ? (ticks par seconde, état du client, objectif du pathfinder, touches appuyées)
      let ticks = 0
      const onTick = () => { ticks++ }
      bot.on('physicsTick', onTick)
      setTimeout(() => {
        bot.removeListener('physicsTick', onTick)
        const touches = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].filter(k => bot.getControlState(k))
        console.log(`🧱 physique : ${ticks} ticks/s, client: ${bot._client.state}, bloc à ma position: ${bot.blockAt(bot.entity.position)?.name ?? 'AUCUN (chunk?)'}, physicsEnabled: ${bot.physicsEnabled}, objectif pathfinder: ${bot.pathfinder.goal ? bot.pathfinder.goal.constructor.name : 'aucun'}, en mouvement: ${bot.pathfinder.isMoving()}, creuse: ${bot.pathfinder.isMining()}, pose: ${bot.pathfinder.isBuilding()}, touches: ${touches.join(',') || 'aucune'}, vitesse: ${bot.entity.velocity.toString()}`)
      }, 1000)
      for (let dy = -1; dy <= 2; dy++) {
        const rows = []
        for (let dz = -2; dz <= 2; dz++) {
          const row = []
          for (let dx = -2; dx <= 2; dx++) row.push(court(bot.blockAt(p.offset(dx, dy, dz))?.name || '?').padEnd(6))
          rows.push(row.join(' '))
        }
        console.log(`🧱 y${dy >= 0 ? '+' : ''}${dy} (nord en haut, est à droite) :\n    ${rows.join('\n    ')}`)
      }
      return
    }
    // « ?chemin x y z » : diagnostic, ce que le pathfinder calcule pour aller là
    if (line.startsWith('?chemin')) {
      const [x, y, z] = line.split(/\s+/).slice(1).map(Number)
      const { goals } = require('mineflayer-pathfinder')
      const t0 = Date.now()
      try {
        const r = bot.pathfinder.getPathTo(bot.pathfinder.movements, new goals.GoalNear(x, y, z, 2), 10000)
        const etapes = (r.path || []).slice(0, 8).map(m => `${m.x},${m.y},${m.z}${m.toBreak?.length ? ' casse:' + m.toBreak.map(b => bot.blockAt(b)?.name || '?').join('+') : ''}${m.toPlace?.length ? ' pose' : ''}`)
        console.log(`🧭 chemin vers ${x} ${y} ${z} : ${r.status}, ${r.path?.length ?? 0} étapes, coût ${Math.round(r.cost || 0)}, ${r.visitedNodes} nœuds en ${Date.now() - t0} ms. Début : ${etapes.join(' | ') || 'aucun'}`)
      } catch (e) {
        console.log(`🧭 chemin : erreur ${e.message}`)
      }
      return
    }
    // « ?vue » : diagnostic, où le bot croit que sont les créatures proches
    if (line.startsWith('?vue')) {
      const type = line.split(' ')[1] || 'cow'
      const me = bot.entity.position
      const vus = Object.values(bot.entities).filter(e => e.name === type).sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me)).slice(0, 5)
      console.log(`🔎 moi en ${me.x.toFixed(1)} ${me.y.toFixed(1)} ${me.z.toFixed(1)} ; ${type} vus : ${vus.map(e => `${e.position.x.toFixed(1)} ${e.position.y.toFixed(1)} ${e.position.z.toFixed(1)}`).join(' | ') || 'aucun'}`)
      return
    }
    // ligne qui commence par « / » : commande de test envoyée telle quelle (monde de test uniquement)
    if (line.startsWith('/')) {
      console.log(`🛠 commande de test : ${line}`)
      debugUntil = Date.now() + 4000
      try { bot.chat(line) } catch (e) { console.log('🛠 échec :', e.message) }
      return
    }
    console.log(`💬 <${OWNER} via console> ${line}`)
    if (STOP_WORDS.test(line)) {
      actions.stopAll()
      brain.interrupt()
    } else {
      actions.yieldToPlayer()
    }
    brain.push(`<${OWNER}> (il t'écrit depuis l'ordinateur, il n'est pas devant le jeu) ${line}`)
  }

  let derniereCause = { texte: '', t: 0 }
  // Messages de mort du jeu (« Aiko74 was slain by Zombie ») : il réagit quand son pote meurt
  bot.on('message', (msg) => {
    if (Date.now() < debugUntil) console.log(`🛠 réponse du jeu : ${msg.toString()}`)
    if (!brain || !OWNER) return
    const key = String(msg.translate || msg.json?.translate || '')
    const text = msg.toString()
    // la cause de SA mort (« Claude was slain by Skeleton », « Claude fell from a high place »...)
    if (key.startsWith('death.') && text.includes(bot.username)) {
      console.log(`💀 cause : ${text}`)
      derniereCause = { texte: text, t: Date.now() }
    }
    if (key.startsWith('death.') && text.includes(OWNER)) brain.push(`[événement] ${OWNER} vient de mourir : « ${text} ». Son stuff est resté là où il est mort.`)
  })

  bot.on('death', () => {
    if (!brain) return
    const ou = actions.onDeath()
    console.log(`💀 Mort en ${ou}`)
    // le message du jeu (« Claude was impaled by Drowned ») arrive juste après : on l'attend pour donner la cause au cerveau
    setTimeout(() => {
      const cause = Date.now() - derniereCause.t < 3000 ? derniereCause.texte : ''
      const t = bot.time?.timeOfDay ?? 0
      const nuit = t >= 12500 && t < 23000
      const monstre = /slain|shot|impaled|blown|fireball|killed/i.test(cause)
      const danger = (monstre && nuit) || /drown|impaled|lava|fell/i.test(cause)
      brain.push(`[événement] Tu es mort en ${ou}${cause ? ` (« ${cause} »)` : ''} et tu viens de réapparaître. Ton stuff est resté là-bas et disparaît au bout de 5 minutes. ` +
        (danger
          ? 'ATTENTION : l\'endroit est dangereux (monstres la nuit, eau, lave ou vide). N\'y retourne PAS maintenant : abrite-toi ou rééquipe-toi, tant pis pour le stuff.'
          : 'Si c\'est sans danger, va le récupérer tout de suite (aller_au_lieu « derniere_mort », puis ramasser).'))
    }, 800)
  })
  bot.on('playerJoined', (p) => { if (brain && p.username !== bot.username) brain.push(`[événement] ${p.username} vient de se connecter.`) })

  // diagnostic : quand il perd beaucoup de vie d'un coup, on note ce qu'il y a autour
  let lastHealth = 20
  bot.on('health', () => {
    if (bot.health < lastHealth - 2 && bot.entity) {
      const me = bot.entity.position
      const near = Object.values(bot.entities).filter(e => e !== bot.entity && e.position.distanceTo(me) < 16 && e.name !== 'item')
        .map(e => `${e.name || e.username}@${e.position.distanceTo(me).toFixed(0)}`).slice(0, 6).join(' ')
      const feet = bot.blockAt(me)?.name
      const head = bot.blockAt(me.offset(0, 1, 0))?.name
      console.log(`❤ vie ${lastHealth.toFixed(0)} → ${bot.health.toFixed(0)} (faim ${bot.food}) pieds:${feet} tête:${head} autour: ${near || 'rien'}`)
    }
    lastHealth = bot.health
  })

  bot.on('login', () => console.log('🔑 Connecté au serveur, chargement du monde...'))

  // Correctif Minecraft 26.1 : les vitesses des entités arrivent déjà en blocs/tick (format « lpVec3 »),
  // mais mineflayer les divise encore par 8000 → toutes les vitesses valaient ~0 (flèches, yeux de l'Ender, monstres).
  bot.once('login', () => {
    let lp = false
    try { lp = JSON.stringify(require('minecraft-data')(bot.version).protocol.play.toClient.types.packet_entity_velocity).includes('lpVec3') } catch (_) {}
    if (!lp) return
    const fixVel = (packet) => {
      const e = bot.entities[packet.entityId]
      if (e && packet.velocity) e.velocity.set(packet.velocity.x, packet.velocity.y, packet.velocity.z)
    }
    bot._client.on('entity_velocity', fixVel)
    bot._client.on('spawn_entity', fixVel)
    console.log('  🔧 vitesses des entités corrigées (format 26.1)')
  })
  bot.on('kicked', (r) => console.log('⚠ Expulsé :', typeof r === 'string' ? r : JSON.stringify(r)))
  bot.on('error', (e) => {
    if (e.code === 'ECONNREFUSED') console.log(`⚠ Personne n'écoute sur ${HOST}:${PORT}. Le monde est bien ouvert (LAN ou serveur lancé) et le port est le bon ?`)
    else console.log('⚠ Erreur :', e.message)
  })
  bot.on('end', (reason) => {
    stopRoutines?.()
    etat.connecte = false
    console.log(`🔌 Déconnecté (${reason}). Reconnexion dans 10 s...`)
    setTimeout(start, 10000)
  })
}

// Ctrl+C : afficher la conso avant de quitter
process.on('SIGINT', () => {
  const u = memory.usage
  console.log(`\nSession terminée : ${u.calls} appels, ${u.input} tokens en entrée, ${u.output} en sortie.`)
  process.exit(0)
})

start()
