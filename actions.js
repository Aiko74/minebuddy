'use strict'
// Tout ce que le bot sait faire dans le monde. Claude choisit lui-même
// quelles actions enchaîner à partir de ce que tu lui dis en langage naturel.

const { goals, Movements } = require('mineflayer-pathfinder')
const { GoalNear, GoalFollow, GoalBlock } = goals
const { Vec3 } = require('vec3')

// Monstres que le bot attaque tout seul s'ils s'approchent
const AUTO_DEFENSE = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider',
  'witch', 'slime', 'magma_cube', 'pillager', 'vindicator', 'phantom', 'silverfish',
  'endermite', 'zombie_villager', 'blaze', 'hoglin', 'zoglin', 'wither_skeleton', 'vex'
])
const HOSTILES = new Set([...AUTO_DEFENSE, 'creeper', 'enderman', 'warden', 'ghast', 'evoker', 'ravager', 'breeze', 'guardian', 'piglin_brute'])

// Blocs de construction : il refuse de les « récolter » et ne creuse jamais à travers en se déplaçant
const PROTECTED = new RegExp([
  '_planks$', 'glass', 'bricks$', '_wool$', 'chest', 'barrel', 'shulker_box', '_bed$', 'door', 'table$', 'furnace', 'smoker',
  'torch$', 'lantern', '_stairs$', '_slab$', 'fence', '_wall$', 'carpet', 'concrete', 'terracotta', 'sign', 'banner', 'ladder',
  'scaffolding', 'bookshelf', 'hay_block', '^cobblestone$', '^mossy_cobblestone$', '^polished_', '^smooth_', '^cut_', '^chiseled_',
  '^stripped_', '_wood$', '_hyphae$', 'anvil', 'stand$', 'lectern', 'loom', 'composter', 'campfire', 'bell$', 'jukebox', 'note_block',
  'dispenser', 'dropper', 'hopper', 'piston', 'observer', 'lever', 'button', 'pressure_plate', 'rail$', 'repeater', 'comparator',
  'redstone_(wire|torch|lamp|block)', 'iron_bars', 'flower_pot', 'beacon', 'farmland',
  '^(iron|gold|diamond|emerald|lapis|coal|copper|netherite|raw_iron|raw_gold|raw_copper|slime|honey)_block$'
].join('|'))

const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew'])
const FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'])
const MIN_FOOD = 20 // points de nourriture à avoir en réserve avant de partir en mission
const WEAPONS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe']
const ARMOR_TIER = { leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6, turtle: 3 }
const ARMOR_SLOT = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }
const MATURE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, nether_wart: 3 }
const SEED_FOR = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds' }

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const norm = (s) => String(s || '').toLowerCase().trim().replace(/^minecraft:/, '').replace(/\s+/g, '_')
const isAir = (b) => b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air')
const fmt = (v) => `${Math.floor(v.x)} ${Math.floor(v.y)} ${Math.floor(v.z)}`

function withTimeout (promise, ms, onTimeout) {
  let t
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => { onTimeout?.(); reject(new Error('trop long, abandon')) }, ms) })
  ])
}

// Correctif des données Minecraft 26.1 : des blocs (minerais, obsidienne, cuivre...) ont perdu
// l'information « se mine à la pioche ». Sans ça, le bot croit miner à la main : jusqu'à 8 fois trop lent
// (75 s par obsidienne au lieu de 9 s, 4,5 s par minerai de fer au lieu d'1 s).
function fixMiningData (reg) {
  let n = 0
  for (const b of reg.blocksArray) {
    if (!/^incorrect_for_\w+_tool$/.test(String(b.material)) || !b.harvestTools) continue
    if (Object.keys(b.harvestTools).some(id => /_pickaxe$/.test(reg.items[id]?.name || ''))) { b.material = 'mineable/pickaxe'; n++ }
  }
  return n
}

function createActions (bot, memoire) {
  const reg = bot.registry
  const fixed = fixMiningData(reg)
  if (fixed) console.log(`  🔧 ${fixed} blocs corrigés (vitesse de minage)`)
  // busy : nombre d'actions en cours ; defending : combat lancé par la défense auto
  // yieldReq : un joueur parle, les longues tâches s'interrompent pour lui répondre
  // mission : tâche autonome en cours ; onEvent : prévenir le cerveau d'un événement du jeu
  const ctx = { abort: false, defense: true, eating: false, followName: null, busy: 0, defending: false, yieldReq: false, mission: null, onEvent: null, deaths: 0 }
  const interrupted = () => ctx.abort || ctx.yieldReq || ctx.deaths !== ctx.runDeaths

  // ---------- déplacements : il peut creuser pour passer, mais jamais dans tes constructions ----------
  const moves = new Movements(bot)
  moves.canDig = true
  moves.allowSprinting = true
  for (const b of reg.blocksArray) if (PROTECTED.test(b.name)) moves.blocksCantBreak.add(b.id)
  // blocs qu'il peut poser sous ses pieds pour grimper ou faire un pont : par défaut seulement
  // terre et cobblestone, et il restait coincé au pied d'une falaise de sable quand il n'en avait plus
  moves.scafoldingBlocks = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff',
    'stone', 'end_stone', 'blackstone', 'coarse_dirt', 'rooted_dirt', 'sandstone', 'red_sandstone']
    .map(n => reg.itemsByName[n]?.id).filter(id => id !== undefined)
  bot.pathfinder.thinkTimeout = 10000 // terrain difficile (jungle, falaises) : on lui laisse plus de temps pour trouver un chemin
  // l'eau coûte plus cher : il nage mal (trajets « trop long ») et s'y fait tuer (noyés à trident, squelettes) :
  // il préfère donc les chemins sur la terre ferme quand il y en a un
  moves.liquidCost = 4
  // pas de saut dans le vide : par défaut le pathfinder saute par-dessus les trous (parkour, souvent raté
  // en montagne) et se jette de n'importe quelle hauteur s'il voit de l'eau en bas. On interdit les deux.
  // (il garde les descentes de 3 blocs max, qui ne font pas mal : réglage maxDropDown par défaut)
  moves.allowParkour = false
  moves.infiniteLiquidDropdownDistance = false
  bot.pathfinder.setMovements(moves)
  // le combat et la récolte utilisent les mêmes règles (sinon ils remettent les leurs)
  bot.pvp.movements = moves
  bot.collectBlock.movements = null

  // ---------- utilitaires ----------
  const dist = (pos) => Math.round(pos.distanceTo(bot.entity.position))
  const playerEntity = (name) => {
    const n = norm(name)
    const p = Object.values(bot.players).find(pl => pl.username.toLowerCase() === n)
    return p?.entity || null
  }
  const items = () => bot.inventory.items()
  const countOf = (name) => items().filter(i => i.name === name).reduce((a, i) => a + i.count, 0)
  const findItem = (name) => items().find(i => i.name === norm(name))

  function blockIds (name) {
    const n = norm(name)
    if (reg.blocksByName[n]) return [reg.blocksByName[n].id]
    return reg.blocksArray.filter(b => b.name.includes(n)).map(b => b.id)
  }

  const fighting = () => !!bot.pvp.target || ctx.defending
  async function waitFightEnd (ms = 30000) {
    const t0 = Date.now()
    while (fighting() && Date.now() - t0 < ms) await sleep(300)
  }

  // Coincé : sur 26.1 il peut rester collé pile contre deux murs (dans un coin), et la physique de
  // mineflayer le croit alors "en l'air" : il ne peut plus sauter et appuie sur avancer dans le vide.
  // On le recentre dans son bloc (petit déplacement), on saute, et on repart.
  async function decoincer () {
    console.log('  🔧 coincé sur place, je me recentre dans mon bloc et je repars')
    bot.clearControlStates()
    const p = bot.entity.position
    const c = p.floored()
    const centre = bot.blockAt(c)
    if (!centre || isAir(centre) || centre.boundingBox === 'empty') bot.entity.position.set(c.x + 0.5, p.y, c.z + 0.5)
    await sleep(300)
    bot.setControlState('jump', true)
    await sleep(300)
    bot.setControlState('jump', false)
    await sleep(500)
  }

  async function goto (goal, ms = 60000) {
    let decoinces = 0
    for (let attempt = 0; ; attempt++) {
      // surveillance : s'il ne bouge plus du tout pendant 6 s alors qu'il suit un chemin (sans creuser ni poser), il est coincé
      let coince = false
      let last = bot.entity.position.clone()
      let lastMove = Date.now()
      const garde = setInterval(() => {
        const p = bot.entity.position
        if (p.distanceTo(last) > 0.15) { last = p.clone(); lastMove = Date.now(); return }
        if (!bot.pathfinder.isMoving() || bot.pathfinder.isMining() || bot.pathfinder.isBuilding() || ctx.fleeing) { lastMove = Date.now(); return }
        if (Date.now() - lastMove > 6000) { coince = true; bot.pathfinder.setGoal(null) }
      }, 500)
      try {
        return await withTimeout(bot.pathfinder.goto(goal), ms, () => bot.pathfinder.setGoal(null))
      } catch (e) {
        if (coince && !ctx.abort && decoinces < 3) { decoinces++; attempt--; await decoincer(); continue }
        if (ctx.abort || attempt >= 2) throw e
        // trajet coupé par la défense auto : on finit le combat puis on repart
        if (fighting()) { await waitFightEnd(); continue }
        // trajet coupé par une esquive (creeper, souffle ou boule de feu du dragon) : on attend la fin puis on repart
        if (ctx.fleeing || /goal was changed/i.test(e.message)) {
          const t0 = Date.now()
          while (ctx.fleeing && Date.now() - t0 < 6000) await sleep(200)
          if (ctx.deaths === ctx.runDeaths) continue
        }
        // trajet annulé par un reste de l'action précédente (récolte abandonnée...) : on réessaie une fois
        if (/stopped/i.test(e.message) && attempt === 0) { await sleep(300); continue }
        throw e
      } finally {
        clearInterval(garde)
      }
    }
  }
  const gotoPos = (p, range = 2, ms) => goto(new GoalNear(p.x, p.y, p.z, range), ms)

  // Long voyage : par étapes d'environ 40 blocs (le pathfinder s'en sort mieux), avec détection du blocage
  async function travelTo (x, z, y, { range = 2, maxMs = 20 * 60000 } = {}) {
    const t0 = Date.now()
    let stuck = 0
    let best = Infinity
    while (Date.now() - t0 < maxMs) {
      if (ctx.abort) throw new Error('interrompu')
      const here = bot.entity.position
      const d = Math.hypot(x - here.x, z - here.z)
      if (d <= 48) {
        // dernière étape : si le pathfinder rame (jungle, falaises), on retente au lieu d'abandonner
        // (le compteur de blocage plus bas arrête si on n'avance vraiment plus)
        try {
          await goto(y !== undefined ? new GoalNear(x, y, z, range) : new goals.GoalNearXZ(x, z, range), 90000)
          return
        } catch (e) {
          if (ctx.abort) throw e
        }
      } else {
        const k = 40 / d
        try {
          await goto(new goals.GoalNearXZ(Math.floor(here.x + (x - here.x) * k), Math.floor(here.z + (z - here.z) * k), 6), 90000)
        } catch (e) {
          if (ctx.abort) throw e
        }
      }
      const nd = Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z)
      if (nd <= range + 2) return // assez près
      if (nd > best - 5) {
        if (++stuck >= 3) throw new Error(`bloqué en chemin à ${Math.round(nd)} blocs du but (falaise, sable ou eau ? Prends de la terre ou de la pierre pour pouvoir grimper, ou contourne par un autre côté)`)
      } else {
        stuck = 0
        best = nd
      }
    }
    throw new Error('trop long, abandon')
  }

  async function equipBestWeapon () {
    for (const w of WEAPONS) {
      const it = findItem(w)
      if (it) { await bot.equip(it, 'hand'); return it.name }
    }
    return null
  }

  async function equipToolFor (block) {
    try { if (bot.tool) await bot.tool.equipForBlock(block, {}) } catch (_) {}
  }

  // vie du dragon en % (barre de boss), ou null si on ne la voit pas
  function vieDragon () {
    const bars = bot.bossBars || []
    const b = bars.find(x => /dragon/i.test(JSON.stringify(x.title || ''))) || (bars.length === 1 ? bars[0] : null)
    return b ? Math.round(b.health * 100) : null
  }

  // Le dragon posé sur la fontaine : on frappe sa TÊTE (seule partie qui prend tous les dégâts).
  // La tête est une "partie" du dragon avec son propre numéro (numéro du dragon + 1).
  async function frapperDragon (dragon) {
    const deaths0 = ctx.deaths
    const vie0 = vieDragon()
    const txtVie = () => { const v = vieDragon(); return v === null ? '' : ` (vie du dragon : ${vie0 !== null && vie0 !== v ? `${vie0}% → ` : ''}${v}%)` }
    const p0 = dragon.position.clone()
    await sleep(700)
    const d0 = bot.entities[dragon.id]
    if (!d0) return 'Le dragon a disparu de ma vue.'
    const pose = d0.position.distanceTo(p0) < 1 && Math.hypot(d0.position.x, d0.position.z) < 12
    if (!pose) return `Le dragon vole${txtVie()} : tire-lui dessus à l'arc (tirer ender_dragon) et attends qu'il se pose sur la fontaine au centre pour le frapper.`
    await equipBestWeapon()
    ctx.followName = null
    const head = { id: dragon.id + 1 }
    // la tête est à ~6 blocs du corps, d'un côté ou de l'autre selon son orientation : on essaie les deux
    const yaw = d0.yaw || 0
    const cotes = [1, -1].map(s => d0.position.offset(-Math.sin(yaw) * 6 * s, 0, -Math.cos(yaw) * 6 * s))
    let cote = 0
    let coups = 0
    let sansEffet = 0
    let derniere = vieDragon()
    const t0 = Date.now()
    try {
      while (!interrupted() && Date.now() - t0 < 20000) {
        const d = bot.entities[dragon.id]
        if (!d || d.position.distanceTo(p0) > 3) break // il s'envole
        if (bot.health <= 8) return `Je me retire, ma vie est basse (${Math.round(bot.health)}/20)${txtVie()}. Mange et éloigne-toi du centre.`
        if (ctx.fleeing) { await sleep(300); continue } // le souffle : la routine m'éloigne du nuage
        const cible = cotes[cote]
        if (bot.entity.position.distanceTo(cible) > 2.5) {
          bot.pathfinder.setGoal(new GoalNear(cible.x, cible.y, cible.z, 1))
          await sleep(300)
          if (Date.now() - t0 > 6000 && coups === 0) cote = 1 - cote
          continue
        }
        bot.pathfinder.setGoal(null)
        await bot.lookAt(cible.offset(0, 1, 0), true)
        bot.attack(head)
        coups++
        await sleep(650) // recharge de l'épée
        const v = vieDragon()
        if (v !== null && derniere !== null && v < derniere) sansEffet = 0
        else if (++sansEffet >= 3) { cote = 1 - cote; sansEffet = 0; bot.attack(d) } // pas la tête ici : l'autre côté (et un coup au corps)
        derniere = v
      }
    } finally {
      bot.pathfinder.setGoal(null)
    }
    if (ctx.deaths !== deaths0) return `Je suis mort en frappant le dragon${txtVie()}.`
    if (!bot.entities[dragon.id]) return `Le dragon est mort !${txtVie()}`
    return `${coups} coup(s) d'épée sur le dragon${txtVie()}. Il s'est envolé ou le temps est écoulé : reprends l'arc, éloigne-toi du centre et attends qu'il se repose.`
  }

  function resumeFollow () {
    if (!ctx.followName) return
    const ent = playerEntity(ctx.followName)
    if (ent) bot.pathfinder.setGoal(new GoalFollow(ent, 2), true)
  }

  function stopAll () {
    ctx.abort = true
    ctx.followName = null
    ctx.mission = null
    ctx.defending = false
    try { bot.pathfinder.setGoal(null) } catch (_) {}
    bot.pvp.stop().catch(() => {})
    bot.collectBlock.cancelTask().catch(() => {})
    try { bot.stopDigging() } catch (_) {}
    bot.clearControlStates()
  }

  async function eat () {
    if (ctx.eating) return 'Je mange déjà.'
    if (bot.food >= 20) return "Je n'ai pas faim."
    const foods = items().filter(i => reg.foodsByName?.[i.name] && !BAD_FOOD.has(i.name))
    if (!foods.length) return "Je n'ai rien de mangeable."
    foods.sort((a, b) => (reg.foodsByName[b.name].foodPoints || 0) - (reg.foodsByName[a.name].foodPoints || 0))
    ctx.eating = true
    try {
      await bot.equip(foods[0], 'hand')
      await bot.consume()
      return `J'ai mangé : ${foods[0].name}.`
    } catch (e) {
      return `Impossible de manger : ${e.message}`
    } finally { ctx.eating = false }
  }

  async function pickUpItems (radius = 12) {
    await faireDeLaPlace()
    // ne pas ramasser les déchets qu'on vient de jeter (sinon il jette / ramasse / jette… en boucle)
    const dechet = (e) => {
      const nom = e.getDroppedItem?.()?.name
      if (!nom) return false
      if (Date.now() - (ctx.jetesRecents?.[nom] || 0) < 5 * 60000) return true // outil dépassé jeté exprès
      const d = DECHETS.find(([n]) => n === nom)
      if (!d) return false
      return items().filter(i => i.name === nom).reduce((s, i) => s + i.count, 0) >= d[1]
    }
    const drops = Object.values(bot.entities).filter(e => e.name === 'item' && dist(e.position) <= radius && !dechet(e))
    let n = 0
    for (const d of drops) {
      if (ctx.abort) break
      try { await goto(new GoalBlock(Math.floor(d.position.x), Math.floor(d.position.y), Math.floor(d.position.z)), 10000); n++ } catch (_) {}
    }
    return n
  }

  const isLog = (b) => /_log$|_stem$/.test(b.name)

  // Une bûche fait partie d'un arbre si on trouve des feuilles en haut de son tronc.
  // Une bûche de ta maison, elle, n'a pas de feuilles autour : il n'y touche pas.
  function isTreeLog (block) {
    let top = block.position
    for (let i = 0; i < 40; i++) {
      const up = bot.blockAt(top.offset(0, 1, 0))
      if (!up || !isLog(up)) break
      top = top.offset(0, 1, 0)
    }
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -1; dy <= 2; dy++) {
        for (let dz = -2; dz <= 2; dz++) {
          const b = bot.blockAt(top.offset(dx, dy, dz))
          if (b && /_leaves$|_wart_block$/.test(b.name)) return true
        }
      }
    }
    return false
  }

  // Pierre, minerais... : sans le bon outil, le bloc ne donne rien. On le dit au lieu d'essayer.
  function missingTool (block) {
    if (!block.harvestTools) return null
    if (items().some(i => block.harvestTools[i.type])) return null
    const names = Object.keys(block.harvestTools).map(id => reg.items[id]?.name).filter(Boolean)
    return `Il me faut un de ces outils pour miner ${block.name} : ${names.join(', ')}. Fabrique-le d'abord.`
  }

  // Cherche un bloc solide à côté d'une position pour poser contre lui
  function referenceFor (pos) {
    const faces = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)]
    for (const f of faces) {
      const ref = bot.blockAt(pos.plus(f))
      if (ref && ref.boundingBox === 'block') return { ref, face: f.scaled(-1) }
    }
    return null
  }

  const nuitDehors = () => { const t = bot.time.timeOfDay; return t >= 12500 && t < 23000 }
  // ---------- abri d'urgence : un trou de 2 blocs rebouché au-dessus de la tête ----------
  async function abriExpress () {
    if (ctx.enAbri) return 'Je suis déjà dans mon abri.'
    if (ctx.abriEnCours) return 'Je suis en train de creuser mon abri.'
    ctx.abriEnCours = true
    try {
      return await abriExpressFaire()
    } finally {
      ctx.abriEnCours = false
    }
  }
  async function abriExpressFaire () {
    bot.pathfinder.setGoal(null)
    await bot.pvp.stop().catch(() => {})
    bot.clearControlStates()
    const p = bot.entity.position.floored()
    // pas au-dessus d'une grotte, de l'eau ou de la lave
    for (let dy = -1; dy >= -3; dy--) {
      const b = bot.blockAt(p.offset(0, dy, 0))
      if (!b || /lava|water/.test(b.name)) return 'Impossible de creuser ici (eau ou lave dessous) : bouge un peu et réessaie.'
      if (dy === -3 && (isAir(b) || b.boundingBox !== 'block')) return 'Impossible : il y a un vide sous moi. Bouge un peu et réessaie.'
      if (dy > -3 && b.name === 'bedrock') return 'Impossible : bedrock.'
      // jamais dans une construction (sol de maison, de cabane...) : règle d'Aiko74, on ne casse pas ses constructions
      if (dy > -3 && PROTECTED.test(b.name)) return `Pas d'abri ici : je suis sur une construction (${b.name}), je ne la casse pas. Mets-toi sur de la terre naturelle à quelques blocs, ou reste à l'intérieur porte fermée.`
      // de l'eau ou de la lave à côté du trou : elle le remplirait (il s'est noyé comme ça)
      if (dy > -3 && liquidNear(p.offset(0, dy, 0))) return 'Impossible de creuser ici : il y a de l\'eau ou de la lave juste à côté, le trou se remplirait. Éloigne-toi de quelques blocs et réessaie.'
    }
    const ordre = ['dirt', 'coarse_dirt', 'rooted_dirt', 'netherrack', 'end_stone', 'andesite', 'diorite', 'granite', 'tuff', 'cobbled_deepslate', 'stone', 'sandstone', 'cobblestone']
    const bloc = () => ordre.map(n => findItem(n)).find(Boolean)
    // sans bloc à poser, il faut que ce qu'on creuse en donne : de la pierre sans pioche ne donne rien
    if (!bloc()) {
      const sol = [-1, -2].map(dy => bot.blockAt(p.offset(0, dy, 0))).filter(b => b && !isAir(b))
      if (sol.length && sol.every(b => missingTool(b))) {
        return 'Pas d\'abri possible ici : le sol est en pierre, je n\'ai pas de pioche et pas de bloc pour refermer. Va plutôt dans ta maison (porte fermée) ou sur un sol de terre.'
      }
    }
    for (const dy of [-1, -2]) {
      const b = bot.blockAt(p.offset(0, dy, 0))
      if (b && !isAir(b)) { await equipToolFor(b); await creuserBloc(b, true) }
    }
    const t0 = Date.now()
    while (Date.now() - t0 < 2000 && bot.entity.position.y > p.y - 1.9) await sleep(50)
    // reboucher les trous autour du corps, puis au-dessus de la tête (de préférence avec de la terre : je pourrai la recasser)
    // les blocs qu'on vient de creuser tombent en objets : attendre de les avoir ramassés avant de refermer
    // (sinon « pas de bloc à poser » alors qu'on vient de creuser de la terre)
    const t1 = Date.now()
    while (!bloc() && Date.now() - t1 < 2500) await sleep(100)
    const pieds = bot.entity.position.floored()
    const trous = []
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, 1]) {
        const c = pieds.offset(dx, dy, dz)
        const b = bot.blockAt(c)
        if (b && (isAir(b) || b.boundingBox !== 'block')) trous.push(c)
      }
    }
    const toitPos = pieds.offset(0, 2, 0)
    let poses = 0
    const poser = async (c) => {
      const it = bloc()
      if (!it) return false
      const r = referenceFor(c)
      if (!r) return false
      await bot.equip(it, 'hand')
      try { await bot.placeBlock(r.ref, r.face); poses++; return true } catch (_) { return false }
    }
    for (const c of trous) { if (!bloc()) break; await poser(c) }
    // le toit : s'il n'a aucun appui (trou creusé sur une bosse), poser d'abord un bloc à côté, au même niveau
    if (!referenceFor(toitPos)) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cote = toitPos.offset(dx, 0, dz)
        const b = bot.blockAt(cote)
        if (b && isAir(b) && referenceFor(cote) && await poser(cote)) break
      }
    }
    await poser(toitPos)
    const toit = bot.blockAt(pieds.offset(0, 2, 0))
    const ferme = toit && !isAir(toit) && toit.boundingBox === 'block'
    if (ferme) ctx.enAbri = pieds.offset(0, 2, 0)
    await equipBestWeapon().catch(() => {})
    return ferme
      ? `Je suis à l'abri dans un trou rebouché (${poses} bloc(s) posé(s)), en ${fmt(pieds)}. Mange, attends le jour (ou que ta vie remonte), puis « remonter » pour sortir.`
      : `J'ai creusé un trou en ${fmt(pieds)} mais je n'ai pas pu le refermer (pas de bloc à poser : terre, pierre...). Les monstres peuvent encore venir.`
  }

  // ---------- priorités : nourriture, équipement, lit ----------
  // Points de nourriture qu'il a en réserve (viande, pain, pommes...)
  function foodReserve () {
    return items().filter(i => reg.foodsByName?.[i.name] && !BAD_FOOD.has(i.name))
      .reduce((a, i) => a + (reg.foodsByName[i.name].foodPoints || 0) * i.count, 0)
  }
  const bedItem = () => items().find(i => /_bed$/.test(i.name))
  const hasPickaxe = () => items().some(i => /_pickaxe$/.test(i.name))
  // Sac plein : on jette les cailloux en trop (on en garde un peu pour construire / grimper).
  // Sinon la récolte s'arrête avec « There are no defined chest locations » (elle cherche un coffre où vider le sac).
  const DECHETS = [['rotten_flesh', 0], ['poisonous_potato', 0], ['gravel', 0], ['tuff', 0], ['calcite', 0], ['andesite', 0], ['diorite', 0], ['granite', 0],
    ['cobbled_deepslate', 64], ['netherrack', 32], ['dirt', 32], ['cobblestone', 64], ['deepslate', 0], ['sand', 16], ['stick', 16]]
  // derriere = direction {x, z} où lancer les déchets (derrière moi, là d'où je viens) : jetés à mes pieds,
  // le jeu me les fait ramasser 2 s plus tard et ça tourne en boucle
  async function faireDeLaPlace (libres = 3, derriere = null) {
    if (bot.inventory.emptySlotCount() >= libres) return 0
    // lancer un peu vers le haut pour que ça retombe à 2 blocs (hors de portée de ramassage automatique)
    if (derriere && (derriere.x || derriere.z)) await bot.look(Math.atan2(-derriere.x, -derriere.z), 0.35, true).catch(() => {})
    else await bot.look(bot.entity.yaw, 0.35, true).catch(() => {})
    let jetes = 0
    for (const [nom, garder] of DECHETS) {
      const id = reg.itemsByName[nom]?.id
      if (id === undefined) continue
      let total = items().filter(i => i.type === id).reduce((s, i) => s + i.count, 0)
      while (total > garder && bot.inventory.emptySlotCount() < libres) {
        const tas = items().filter(i => i.type === id).sort((a, b) => a.count - b.count)[0]
        if (!tas) break
        const n = Math.min(tas.count, total - garder)
        try { await bot.toss(id, null, n) } catch (_) { break }
        total -= n
        jetes += n
        await sleep(150)
      }
      if (bot.inventory.emptySlotCount() >= libres) break
    }
    // 2e niveau : les outils et armures dépassés (une pioche en pierre quand on en a une en diamant...)
    if (bot.inventory.emptySlotCount() < libres) {
      const RANG = { wooden: 1, leather: 1, stone: 2, golden: 2, chainmail: 2.5, iron: 3, diamond: 4, netherite: 5 }
      const porte = armorNames()
      for (const cat of ['sword', 'axe', 'shovel', 'hoe', 'helmet', 'chestplate', 'leggings', 'boots', 'pickaxe']) {
        const re = new RegExp(`^(\\w+?)_${cat}$`)
        const tous = [...items().map(i => i.name), ...porte].filter(n => re.test(n))
        const rangs = tous.map(n => RANG[n.match(re)[1]] || 0).sort((a, b) => b - a)
        // pioche : on garde la meilleure ET une de rechange
        const seuil = cat === 'pickaxe' ? (rangs[1] ?? rangs[0]) : rangs[0]
        for (const it of items().filter(i => re.test(i.name))) {
          if ((RANG[it.name.match(re)[1]] || 0) >= seuil) continue
          try { await bot.toss(it.type, null, it.count); jetes += it.count; (ctx.jetesRecents ||= {})[it.name] = Date.now() } catch (_) {}
          if (bot.inventory.emptySlotCount() >= libres) break
        }
        if (bot.inventory.emptySlotCount() >= libres) break
      }
    }
    // 3e niveau (dernier recours) : moins de blocs de réserve
    if (bot.inventory.emptySlotCount() < libres) {
      for (const nom of ['cobbled_deepslate', 'cobblestone', 'dirt', 'netherrack', 'sand']) {
        const id = reg.itemsByName[nom]?.id
        if (id === undefined) continue
        const total = items().filter(i => i.type === id).reduce((s, i) => s + i.count, 0)
        if (total > 16) { try { await bot.toss(id, null, total - 16); jetes += total - 16 } catch (_) {} }
        if (bot.inventory.emptySlotCount() >= libres) break
      }
    }
    if (jetes) console.log(`  🎒 sac plein : j'ai jeté ${jetes} objets inutiles`)
    return jetes
  }
  // usure des pioches : coups restants au total (le deepslate les use vite : ~3 blocs par marche d'escalier)
  const pochesUsure = () => {
    const p = items().filter(i => /_pickaxe$/.test(i.name))
    const reste = p.reduce((s, i) => s + Math.max(0, (i.maxDurability || 0) - (i.durabilityUsed || 0)), 0)
    return { n: p.length, reste }
  }
  const alertePioche = (besoin) => {
    const { n, reste } = pochesUsure()
    return reste < besoin ? ` ⚠ Mes pioches sont presque usées (${n} pioche(s), ~${reste} coups restants) : fabrique une pioche de rechange (fer, ou pierre avec du cobbled_deepslate) avant d'aller plus loin.` : ''
  }
  const hasWeapon = () => items().some(i => /_sword$|_axe$/.test(i.name))

  // Ce qu'il doit régler avant (ou pendant) une mission, du plus important au moins important.
  // urgent = seulement ce qui ne peut pas attendre
  function priorites ({ urgent = false } = {}) {
    const p = []
    const food = foodReserve()
    if (food < (urgent ? 10 : MIN_FOOD)) p.push(`nourriture : seulement ${food} points en réserve (vise au moins ${MIN_FOOD}) → chasse (chasser), fais cuire la viande (cuire), ou récolte des cultures`)
    if (urgent) return p
    if (!hasPickaxe()) p.push('pas de pioche → fabrique-en une')
    if (!hasWeapon()) p.push('pas d\'arme → fabrique une épée')
    if (!bedItem()) p.push('pas de lit portable → 3 laines de la même couleur (moutons) + 3 planches, puis fabrique le lit (ex. white_bed)')
    return p
  }

  // Un animal près d'une clôture est sûrement dans l'enclos de quelqu'un : on n'y touche pas
  function isPenned (ent) {
    const p = ent.position.floored()
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          const b = bot.blockAt(p.offset(dx, dy, dz))
          if (b && /fence|_wall$/.test(b.name)) return true
        }
      }
    }
    return false
  }

  // Lit portable : il le pose sur 2 blocs plats libres à côté de lui
  async function placePortableBed (item) {
    const p = bot.entity.position.floored()
    await goto(new GoalBlock(p.x, p.y, p.z), 5000).catch(() => {}) // bien au centre du bloc
    const free = (q) => { const b = bot.blockAt(q); return b && (isAir(b) || /grass$|fern|snow$|flower|poppy|dandelion/.test(b.name)) }
    const solid = (q) => bot.blockAt(q.offset(0, -1, 0))?.boundingBox === 'block'
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const foot = p.offset(dx, 0, dz)
      const head = p.offset(2 * dx, 0, 2 * dz) // le lit s'allonge dans la direction où il regarde
      if (!(free(foot) && free(head) && solid(foot) && solid(head))) continue
      await bot.equip(item, 'hand')
      await bot.lookAt(head.offset(0.5, 0, 0.5), true)
      try { await bot.placeBlock(bot.blockAt(foot.offset(0, -1, 0)), new Vec3(0, 1, 0)) } catch (_) {}
      const b = bot.blockAt(foot)
      if (b && /_bed$/.test(b.name)) return b
    }
    return null
  }

  async function pickUpBed (pos) {
    const b = bot.blockAt(pos)
    if (!b || !/_bed$/.test(b.name)) return
    try { await creuserBloc(b) } catch (_) {}
    await sleep(400)
    await pickUpItems(5)
  }

  // ---------- état envoyé à Claude avant chaque message ----------
  function etat () {
    const p = bot.entity.position
    const t = bot.time.timeOfDay
    const moment = t < 12000 ? 'jour' : t < 13800 ? 'coucher du soleil' : t < 22500 ? 'nuit' : 'lever du soleil'
    const inv = {}
    for (const i of items()) inv[i.name] = (inv[i.name] || 0) + i.count
    const invTxt = Object.entries(inv).map(([k, v]) => `${k} x${v}`).join(', ') || 'vide'
    const joueurs = Object.values(bot.players)
      .filter(pl => pl.username !== bot.username)
      .map(pl => pl.entity ? `${pl.username} à ${dist(pl.entity.position)} blocs (${fmt(pl.entity.position)})` : `${pl.username} (hors de vue)`)
      .join(', ') || 'aucun'
    const monstres = Object.values(bot.entities)
      .filter(e => HOSTILES.has(e.name) && dist(e.position) < 20)
      .map(e => `${e.name} à ${dist(e.position)}`)
      .join(', ') || 'aucun'
    const m = ctx.mission
    const missionTxt = m
      ? ` Mission en cours : « ${m.objectif} » (${Math.max(0, Math.ceil((m.fin - Date.now()) / 60000))} min restantes${m.rdv ? `, rendez-vous : ${m.rdv}` : ''}).`
      : ''
    return `[état] vie ${Math.round(bot.health)}/20, faim ${bot.food}/20, position ${fmt(p)} (${bot.game.dimension}), ${moment}, ` +
      `en main : ${bot.heldItem?.name || 'rien'}, inventaire : ${invTxt}. Réserve de nourriture : ${foodReserve()} points. ` +
      `Lit portable : ${bedItem() ? 'oui' : 'non'}. Armure portée : ${armorNames().join(', ') || 'aucune'}. Joueurs : ${joueurs}. Monstres proches : ${monstres}.` +
      (ctx.followName ? ` Tu suis ${ctx.followName}.` : '') + missionTxt
  }

  // Comptage de l'inventaire (pour le bilan d'une mission)
  function invCounts () {
    const inv = {}
    for (const i of items()) inv[i.name] = (inv[i.name] || 0) + i.count
    return inv
  }
  function missionGains () {
    if (!ctx.mission) return ''
    const now = invCounts()
    const gains = Object.entries(now).map(([k, v]) => [k, v - (ctx.mission.depart[k] || 0)]).filter(([, d]) => d > 0)
    return gains.map(([k, d]) => `${d} ${k}`).join(', ') || 'rien de nouveau'
  }

  // ---------- progression : ce qu'un joueur ferait ensuite ----------
  const armorNames = () => [5, 6, 7, 8].map(s => bot.inventory.slots[s]?.name).filter(Boolean)
  function progression () {
    const all = items().map(i => i.name).concat(armorNames())
    const has = (re) => all.some(n => re.test(n))
    const lieux = memoire.lieux()
    const steps = []
    if (!has(/_pickaxe$/) || !has(/_sword$|_axe$/)) steps.push('outils de base : bois → planches → établi → pioche et épée (en pierre au minimum)')
    if (foodReserve() < MIN_FOOD) steps.push('nourriture : chasser (chasser) puis faire cuire la viande (cuire)')
    if (!has(/_bed$/)) steps.push('lit portable : la laine de 3 moutons de la même couleur + 3 planches')
    if (!lieux.maison) steps.push('ta maison : trouver un bel endroit (chercher_terrain) puis construire une vraie maison stylée (construire_maison)')
    if (!lieux.coffre) steps.push('un coffre à la maison pour ranger tes ressources (fabriquer chest, poser, memoriser_lieu « coffre »)')
    if (!has(/^(iron|diamond|netherite)_pickaxe$/)) steps.push('pioche en fer : miner du fer (iron_ore), le cuire, fabriquer iron_pickaxe')
    const manque = ['helmet', 'chestplate', 'leggings', 'boots'].filter(p => !has(new RegExp(`^(iron|diamond|netherite)_${p}$`)))
    if (manque.length) steps.push(`armure en fer complète (il manque : ${manque.join(', ')})`)
    if (!lieux.enclos) steps.push('une ferme : construire un enclos (construire_enclos), y attirer 2 vaches et 2 moutons avec du blé (attirer_animaux), les faire se reproduire (reproduire)')
    if (!lieux.champ) steps.push('un champ de blé près de la maison (graines en cassant de l\'herbe short_grass, houe, planter, memoriser_lieu « champ »)')
    if (!has(/^diamond/)) steps.push('trouver des diamants : descendre vers y = -58 (descendre) puis creuser des galeries (miner_galerie)')
    const manqueDiam = ['helmet', 'chestplate', 'leggings', 'boots', 'pickaxe', 'sword'].filter(p => !has(new RegExp(`^(diamond|netherite)_${p}$`)))
    if (has(/^diamond$/) && manqueDiam.length) steps.push(`équipement en diamant (il manque : ${manqueDiam.join(', ')})`)
    if (!lieux.village) steps.push('explorer les environs pour trouver un village (explorer ; villageois, cloche)')
    if (!has(/^enchanting_table$/) && !lieux.enchantement) steps.push('une table d\'enchantement (4 obsidienne, 2 diamants, 1 livre) puis enchanter ton équipement (enchanter, avec du lapis)')
    steps.push('améliorer ta base : décorer, agrandir la ferme, faire des réserves, aider ton pote')
    return steps.slice(0, 4)
  }

  // Ce qu'il voit autour de lui : blocs intéressants et créatures
  function scan (rayon = 24) {
    const re = /_ore$|_log$|^chest$|^barrel$|crafting_table|furnace|smoker|_bed$|^bell$|^lava$|^nether_bricks$|^spawner$|^obsidian$|^crying_obsidian$|^end_portal_frame$|^nether_portal$|^ancient_debris$|^nether_wart$|^wheat$|^carrots$|^potatoes$|^farmland$|^sugar_cane$|^pumpkin$|^melon$/
    const positions = bot.findBlocks({ matching: (b) => re.test(b.name), maxDistance: rayon, count: 400 })
    const blocs = {}
    for (const pos of positions) {
      const b = bot.blockAt(pos); if (!b) continue
      const d = dist(pos)
      if (!blocs[b.name]) blocs[b.name] = { n: 0, d, pos }
      blocs[b.name].n++
      if (d < blocs[b.name].d) Object.assign(blocs[b.name], { d, pos })
    }
    const btxt = Object.entries(blocs).map(([k, v]) => `${k} x${v.n} (le plus proche à ${v.d} blocs, ${fmt(v.pos)})`).join('; ') || 'rien de notable'
    const ents = {}
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !e.name || e.name === 'item' || dist(e.position) > rayon) continue
      const k = e.type === 'player' ? `joueur ${e.username}` : e.name
      if (!ents[k] || dist(e.position) < ents[k].d) ents[k] = { d: dist(e.position), n: (ents[k]?.n || 0) + 1 }
      else ents[k].n++
    }
    const etxt = Object.entries(ents).map(([k, v]) => `${k} x${v.n} (${v.d} blocs)`).join('; ') || 'personne'
    return `Blocs : ${btxt}. Créatures : ${etxt}.`
  }

  // Pose un bloc de l'inventaire à une position précise. Renvoie 'ok', 'occupé', 'sans appui', 'plus de matériau' ou 'échec'.
  async function placeAt (itemName, pos) {
    // sable, gravier, poudre de béton : ils tombent s'il y a du vide dessous. Jamais au-dessus de moi (étouffement)
    if (/sand$|gravel$|concrete_powder$|anvil$/.test(itemName) && !/sandstone/.test(itemName)) {
      const me = bot.entity.position.floored()
      const dessous = bot.blockAt(pos.offset(0, -1, 0))
      if (pos.x === me.x && pos.z === me.z && pos.y > me.y && dessous && (isAir(dessous) || dessous.boundingBox === 'empty')) return 'tomberait'
    }
    const cur = bot.blockAt(pos)
    if (cur && !isAir(cur) && !/water|grass$|fern|snow$|dead_bush|vine/.test(cur.name)) return 'occupé'
    const r = referenceFor(pos)
    if (!r) return 'sans appui'
    if (!findItem(itemName)) return 'plus de matériau'
    await gotoPos(pos, 3, 20000).catch(() => {})
    // ne pas se poser le bloc sur la tête
    const me = bot.entity.position.floored()
    if (me.equals(pos) || me.offset(0, 1, 0).equals(pos)) await goto(new GoalNear(pos.x + 2, pos.y, pos.z + 2, 1), 8000).catch(() => {})
    const item = findItem(itemName)
    if (!item) return 'plus de matériau'
    await bot.equip(item, 'hand')
    try { await bot.placeBlock(r.ref, r.face) } catch (_) {}
    const now = bot.blockAt(pos)
    return now && !isAir(now) && now.type !== cur?.type ? 'ok' : 'échec'
  }

  // Pose une liste de blocs, du bas vers le haut. Renvoie un petit bilan.
  async function placeMany (itemName, positions) {
    const res = { ok: 0, 'occupé': 0, 'sans appui': 0, 'échec': 0 }
    for (const p of positions) {
      if (interrupted()) return { ...res, stop: 'interrompu' }
      const r = await placeAt(itemName, p)
      if (r === 'plus de matériau') return { ...res, stop: `plus de ${itemName}` }
      res[r]++
    }
    return res
  }
  const bilan = (r) => `${r.ok} posés` + (r['occupé'] ? `, ${r['occupé']} déjà remplis` : '') +
    (r['sans appui'] ? `, ${r['sans appui']} sans appui (terrain pas plat ?)` : '') + (r['échec'] ? `, ${r['échec']} ratés` : '') +
    (r.stop ? ` (arrêt : ${r.stop})` : '')

  // ---------- les actions (outils donnés à Claude) ----------
  const defs = []
  const impl = {}
  const requiredOf = {}
  const tool = (name, description, properties, required, fn) => {
    defs.push({ name, description, input_schema: { type: 'object', properties, required } })
    impl[name] = fn
    requiredOf[name] = required
  }
  const S = (description) => ({ type: 'string', description })
  const N = (description) => ({ type: 'integer', description })
  const XYZ = { x: N('x'), y: N('y'), z: N('z') }

  tool('suivre', 'Suivre un joueur en continu (jusqu\'à arreter ou une autre action de déplacement).',
    { joueur: S('pseudo du joueur') }, ['joueur'], async ({ joueur }) => {
      const ent = playerEntity(joueur)
      if (!ent) return `Je ne vois pas ${joueur} (trop loin). Demande-lui ses coordonnées.`
      ctx.followName = ent.username
      bot.pathfinder.setGoal(new GoalFollow(ent, 2), true)
      return `Je suis ${ent.username}.`
    })

  tool('venir', 'Aller rejoindre un joueur une fois.', { joueur: S('pseudo') }, ['joueur'], async ({ joueur }) => {
    const ent = playerEntity(joueur)
    if (!ent) return `Je ne vois pas ${joueur}. Demande-lui ses coordonnées.`
    ctx.followName = null
    await gotoPos(ent.position, 2, 90000)
    return `Arrivé près de ${joueur}.`
  })

  tool('aller_a', 'Marcher jusqu\'à des coordonnées.', XYZ, ['x', 'y', 'z'], async ({ x, y, z }) => {
    ctx.followName = null
    ctx.abort = false
    await gotoPos(new Vec3(x, y, z), 1, 180000)
    return `Arrivé en ${x} ${y} ${z}.`
  })

  tool('arreter', 'Tout arrêter : déplacement, combat, minage.', {}, [], async () => { stopAll(); return 'Arrêté.' })

  tool('regarder_autour', 'Voir les blocs intéressants (minerais, arbres, coffres, établis, fours, lits...) et les créatures dans un rayon de 24 blocs.',
    {}, [], async () => scan(24))

  tool('recolter', 'Casser et ramasser des blocs naturels : bois (ex. "log" pour n\'importe quel tronc, "oak_log"), pierre ("stone" donne de la cobblestone), minerais ("iron_ore", "coal_ore", "diamond_ore"), terre, sable, etc. Choisit tout seul le bon outil.',
    { bloc: S('nom Minecraft du bloc, en anglais'), quantite: N('nombre de blocs (max 64)') }, ['bloc'],
    async ({ bloc, quantite = 1 }) => {
      const n = norm(bloc)
      if (n === 'cobblestone') return 'La cobblestone s\'obtient en minant de la pierre : récolte "stone" (il faut une pioche).'
      if (PROTECTED.test(n)) return `Je ne casse pas de ${bloc} : ça pourrait être une construction. Si c'est voulu, utilise creuser avec des coordonnées précises.`
      let ids = blockIds(n)
      // un minerai peut aussi être dans la deepslate (deepslate_iron_ore...)
      if (n.endsWith('_ore') && !n.startsWith('deepslate_')) ids = ids.concat(blockIds('deepslate_' + n))
      // « log » ne doit pas viser les bûches écorcées ni les blocs de construction
      ids = ids.filter(id => !PROTECTED.test(reg.blocks[id].name))
      if (!ids.length) return `Bloc inconnu : ${bloc}.`
      const target = Math.min(Math.max(1, quantite | 0), 64)
      const skip = new Set() // blocs inaccessibles, on n'y revient pas
      let done = 0
      let fails = 0
      while (done < target) {
        if (ctx.abort) return `Interrompu après ${done}/${target}.`
        if (ctx.deaths !== ctx.runDeaths) return `Récolté ${done}/${target}, puis je suis mort.`
        if (ctx.yieldReq) return `Récolté ${done}/${target}, mis en pause : un joueur te parle (reprends ensuite si c'est toujours utile).`
        await waitFightEnd()
        // le plus proche qui soit naturel : une bûche doit faire partie d'un arbre, pas d'une maison
        const block = bot.findBlocks({ matching: ids, maxDistance: 64, count: 300 })
          .map(p => bot.blockAt(p))
          .find(b => b && !skip.has(b.position.toString()) && (!isLog(b) || isTreeLog(b)))
        if (!block) return done ? `Récolté ${done}/${target}, il n'y en a plus autour.` : `Aucun ${bloc} naturel à moins de 64 blocs. Il faudrait explorer.`
        const need = missingTool(block)
        if (need) return (done ? `Récolté ${done}/${target}. ` : '') + need
        await faireDeLaPlace(3, { x: bot.entity.position.x - block.position.x, z: bot.entity.position.z - block.position.z })
        try {
          await withTimeout(bot.collectBlock.collect(block), 40000, () => bot.collectBlock.cancelTask().catch(() => {}))
        } catch (e) {
          if (/chest locations/i.test(e.message)) {
            if (await faireDeLaPlace(4)) continue
            return `Récolté ${done}/${target} : mon sac est plein et je n'ai rien d'inutile à jeter. Range des objets dans un coffre ou jette-en (donner / coffres).`
          }
          skip.add(block.position.toString())
          if (++fails >= 3) return `Récolté ${done}/${target}, puis problème : ${e.message}`
          continue
        }
        // on vérifie que le bloc a vraiment été cassé (un combat peut interrompre la récolte)
        const now = bot.blockAt(block.position)
        if (now && now.type !== block.type) { done++; fails = 0 } else if (!fighting()) {
          skip.add(block.position.toString())
          if (++fails >= 3) return `Récolté ${done}/${target}, je n'arrive pas à casser les suivants.`
        }
      }
      return `Récolté ${done} × ${bloc}.`
    })

  tool('creuser', 'Casser un bloc précis à des coordonnées (pour creuser un passage, un tunnel, enlever un bloc).', XYZ, ['x', 'y', 'z'],
    async ({ x, y, z }) => {
      const block = bot.blockAt(new Vec3(x, y, z))
      if (!block || isAir(block)) return 'Il n\'y a rien à casser ici.'
      if (block.name === 'bedrock') return 'C\'est de la bedrock, incassable.'
      await gotoPos(block.position, 3, 60000)
      await equipToolFor(block)
      await creuserBloc(block)
      await pickUpItems(4)
      return `Cassé : ${block.name}.`
    })

  tool('creuser_tunnel', 'Creuser un tunnel droit de 1x2 dans une direction (pour miner, descendre ou traverser une colline).',
    { direction: { type: 'string', enum: ['nord', 'sud', 'est', 'ouest', 'bas'] }, longueur: N('nombre de blocs (max 32)') }, ['direction', 'longueur'],
    async ({ direction, longueur }) => {
      const dirs = { nord: [0, 0, -1], sud: [0, 0, 1], est: [1, 0, 0], ouest: [-1, 0, 0], bas: [0, -1, 0] }
      const [dx, dy, dz] = dirs[direction]
      const n = Math.min(Math.max(1, longueur | 0), 32)
      ctx.abort = false
      ctx.followName = null
      bot.pathfinder.setGoal(null)
      let dug = 0
      for (let i = 0; i < n; i++) {
        if (interrupted()) break
        const base = bot.entity.position.floored()
        if (dy === -1) {
          // escalier descendant pour pouvoir remonter
          const step = base.offset(1, -1, 0)
          for (const p of [base.offset(1, 0, 0), base.offset(1, 1, 0), step]) {
            const b = bot.blockAt(p)
            if (b && !isAir(b) && b.diggable) {
              if (/lava|water/.test(b.name)) return `Danger : ${b.name} devant, j'arrête.`
              if (PROTECTED.test(b.name)) return `Il y a une construction (${b.name}) devant, j'arrête.`
              await equipToolFor(b); await creuserBloc(b)
            }
          }
          await goto(new GoalBlock(step.x, step.y, step.z), 10000).catch(() => {})
        } else {
          for (const p of [base.offset(dx, 0, dz), base.offset(dx, 1, dz)]) {
            const b = bot.blockAt(p)
            if (b && !isAir(b) && b.diggable) {
              if (/lava|water/.test(b.name)) return `Danger : ${b.name} devant, j'arrête après ${dug} blocs.`
              if (PROTECTED.test(b.name)) return `Il y a une construction (${b.name}) devant, j'arrête après ${dug} blocs.`
              await equipToolFor(b); await creuserBloc(b)
            }
          }
          const next = base.offset(dx, 0, dz)
          // le tunnel débouche sur un vide (grotte, ravin) : on ne saute pas dedans
          if (chuteSous(next) >= 3) return `Vide devant (grotte ou ravin de plus de 3 blocs) : j'arrête après ${dug} blocs pour ne pas tomber. Je suis en ${fmt(bot.entity.position)}.`
          await goto(new GoalBlock(next.x, next.y, next.z), 10000).catch(() => {})
        }
        dug++
      }
      await pickUpItems(6)
      return `Tunnel creusé sur ${dug} blocs vers ${direction}. Position : ${fmt(bot.entity.position)}.` +
        (ctx.yieldReq ? ' Mis en pause : un joueur te parle.' : '')
    })

  tool('fabriquer', 'Fabriquer un objet (planches, bâtons, outils, armes, armures, établi, four, torches, lit...). Utilise un établi proche si besoin.',
    { objet: S('nom Minecraft anglais, ex. stone_pickaxe, oak_planks, stick, torch'), quantite: N('nombre voulu') }, ['objet'],
    async ({ objet, quantite = 1 }) => {
      const item = reg.itemsByName[norm(objet)]
      if (!item) return `Objet inconnu : ${objet}.`
      // il faut une place libre dans le sac pour l'objet fabriqué (sinon il « disparaît »)
      await faireDeLaPlace(2)
      if (bot.inventory.emptySlotCount() < 1) return 'Mon sac est plein et je n\'ai rien d\'inutile à jeter : range des objets dans un coffre avant de fabriquer.'
      let table = null
      let recipe = bot.recipesFor(item.id, null, 1, null)[0]
      if (!recipe) {
        table = bot.findBlock({ matching: reg.blocksByName.crafting_table.id, maxDistance: 32 })
        if (table) {
          try {
            await gotoPos(table.position, 2, 90000)
          } catch (e) {
            return `Je n'arrive pas à rejoindre l'établi en ${fmt(table.position)} (${e.message}). Fabrique un nouvel établi (4 planches) et pose-le ici, puis réessaie.`
          }
          recipe = bot.recipesFor(item.id, null, 1, table)[0]
        }
        if (!recipe) {
          const all = bot.recipesAll(item.id, null, true)
          if (!all.length) return `${objet} ne se fabrique pas.`
          // Une recette peut avoir plusieurs variantes (cobblestone ou deepslate...) :
          // on prend celle à laquelle il manque le moins de choses et on dit exactement quoi.
          const have = (id) => items().filter(i => i.type === id).reduce((a, i) => a + i.count, 0)
          // planches qu'il peut découper dans ses bûches (ex. acacia_log → acacia_planks) : variante à préférer
          const aLesBuches = (nom) => /_planks$/.test(nom) &&
            ['_log', '_stem'].some(s => have(reg.itemsByName[nom.replace(/_planks$/, s)]?.id) > 0)
          let best = null
          for (const r of all) {
            const need = r.delta.filter(d => d.count < 0)
            const missing = need.map(d => ({ name: reg.items[d.id]?.name, n: -d.count - have(d.id) })).filter(m => m.n > 0)
            const score = missing.reduce((a, m) => a + m.n - (aLesBuches(m.name) ? 0.5 : 0), 0)
            if (!best || score < best.score) best = { r, need, missing, score }
          }
          const recette = best.need.map(d => `${-d.count} ${reg.items[d.id]?.name}`).join(', ')
          const noTable = best.r.requiresTable && !table
          if (!best.missing.length) {
            return noTable
              ? `J'ai les ingrédients (${recette}) mais il faut un établi posé à moins de 32 blocs : fabrique-en un et pose-le.`
              : `Je n'arrive pas à fabriquer ${objet} (recette : ${recette}).`
          }
          const manque = best.missing.map(m => `${m.n} ${m.name}`).join(', ')
          const decoupe = best.missing.filter(m => aLesBuches(m.name)).map(m => m.name)
          return `Il me manque : ${manque} (recette : ${recette}).${noTable ? ' Il faut aussi un établi posé à proximité.' : ''}` +
            (decoupe.length ? ` Tu as les bûches : fabrique d'abord ${decoupe.join(', ')}.` : '')
        }
      }
      const perCraft = recipe.result?.count || 1
      const times = Math.max(1, Math.ceil(quantite / perCraft))
      let made = 0
      const compte = () => items().filter(i => i.type === item.id).reduce((a, i) => a + i.count, 0)
      const avant = compte()
      // Sur 26.1, une fabrication rate parfois sans prévenir (« updateSlot did not fire ») et l'inventaire
      // que voit le bot ne correspond plus à celui du serveur (vu : 24 bûches côté serveur, 0 côté bot).
      // Seule une reconnexion remet tout d'aplomb : le superviseur relance le bot en quelques secondes.
      const resynchroniser = (pourquoi) => {
        console.log(`  🔄 inventaire désynchronisé (${pourquoi}) : je me reconnecte pour le remettre à jour`)
        setTimeout(() => process.exit(3), 1500)
        return `La fabrication n'a pas marché : mon inventaire n'est plus à jour (${pourquoi}). Je me reconnecte quelques secondes pour le resynchroniser, puis réessaie.`
      }
      for (let i = 0; i < times; i++) {
        const r = bot.recipesFor(item.id, null, 1, table)[0]
        if (!r) break
        // laisser le serveur confirmer la fabrication précédente (sur 26.1, deux fabrications collées désynchronisent l'inventaire)
        const depuis = Date.now() - (ctx.derniereFabrication || 0)
        if (depuis < 800) await sleep(800 - depuis)
        try {
          await bot.craft(r, 1, table)
          ctx.derniereFabrication = Date.now()
        } catch (e) {
          if (/updateSlot|did not fire/i.test(e.message)) return resynchroniser('le jeu n\'a pas confirmé')
          throw e
        }
        made += perCraft
        // attendre que l'inventaire affiche bien l'objet : sinon la fabrication suivante
        // (ex. une pioche juste après les bâtons) croit qu'il manque encore des ingrédients
        const t0 = Date.now()
        while (compte() < avant + made && Date.now() - t0 < 1500) await sleep(50)
      }
      if (made && compte() <= avant) return resynchroniser(`${item.name} fabriqué mais absent de mon sac`)
      return made ? `Fabriqué ${made} × ${item.name}.` : 'Pas assez d\'ingrédients.'
    })

  tool('cuire', 'Faire cuire ou fondre dans un four proche : minerai de fer (raw_iron), viande crue, sable (verre)... Met le combustible tout seul.',
    { objet: S('objet à cuire, ex. raw_iron, beef'), quantite: N('nombre') }, ['objet'],
    async ({ objet, quantite = 1 }) => {
      const name = norm(objet)
      const input = findItem(name)
      if (!input) return `Je n'ai pas de ${objet}.`
      const n = Math.min(quantite, countOf(name), 64)
      const ids = ['furnace', 'smoker', 'blast_furnace'].map(b => reg.blocksByName[b]?.id).filter(Boolean)
      const fb = bot.findBlock({ matching: ids, maxDistance: 32 })
      if (!fb) return 'Je ne vois pas de four. Il faut en fabriquer un (8 cobblestone) et le poser.'
      await gotoPos(fb.position, 2, 90000)
      const furnace = await bot.openFurnace(fb)
      ctx.abort = false
      try {
        if (!furnace.fuelItem()) {
          const fuels = [['coal', 8], ['charcoal', 8]].map(([f, per]) => ({ it: findItem(f), per }))
            .concat(items().filter(i => /_planks$|_log$/.test(i.name)).map(it => ({ it, per: 1.5 })))
            .filter(f => f.it)
          if (!fuels.length) return 'Je n\'ai pas de combustible (charbon, bois ou planches).'
          const f = fuels[0]
          await furnace.putFuel(f.it.type, null, Math.min(Math.ceil(n / f.per), countOf(f.it.name)))
        }
        await furnace.putInput(input.type, null, n)
        let got = 0
        const deadline = Date.now() + n * 11000 + 10000
        while (got < n && Date.now() < deadline && !ctx.abort) {
          await sleep(2000)
          if (furnace.outputItem()) {
            const taken = await furnace.takeOutput()
            got += taken?.count || 0
          }
        }
        return `Cuit ${got}/${n}.`
      } finally { furnace.close() }
    })

  tool('poser', 'Poser un bloc juste à côté de moi (établi, four, coffre, torche, lit...).', { objet: S('nom du bloc') }, ['objet'],
    async ({ objet }) => {
      const item = findItem(objet)
      if (!item) return `Je n'ai pas de ${objet}.`
      await bot.equip(item, 'hand')
      const p = bot.entity.position.floored()
      const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]]
      for (const [dx, dz] of offsets) {
        const ref = bot.blockAt(p.offset(dx, -1, dz))
        const spot = bot.blockAt(p.offset(dx, 0, dz))
        const above = bot.blockAt(p.offset(dx, 1, dz))
        if (ref?.boundingBox === 'block' && isAir(spot) && isAir(above)) {
          try { await bot.placeBlock(ref, new Vec3(0, 1, 0)) } catch (_) {}
          const now = bot.blockAt(spot.position)
          if (now && !isAir(now)) return `Posé ${item.name} en ${fmt(spot.position)}.`
        }
      }
      return 'Pas de place pour le poser ici.'
    })

  tool('construire', 'Poser un bloc à des coordonnées précises (pour construire : murs, ponts, abris...). Pour une construction, appelle-le plusieurs fois.',
    { objet: S('bloc à poser'), ...XYZ }, ['objet', 'x', 'y', 'z'],
    async ({ objet, x, y, z }) => {
      const item = findItem(objet)
      if (!item) return `Je n'ai pas de ${objet}.`
      const r = await placeAt(item.name, new Vec3(x, y, z))
      if (r === 'ok') return `Posé ${item.name} en ${x} ${y} ${z}.`
      if (r === 'occupé') return `Il y a déjà ${bot.blockAt(new Vec3(x, y, z))?.name} en ${x} ${y} ${z}.`
      if (r === 'sans appui') return 'Aucun bloc d\'appui à côté de cette position (il faut construire à partir du sol ou d\'un autre bloc).'
      if (r === 'tomberait') return `Non : ${item.name} tombe s'il y a du vide dessous, il me tomberait sur la tête (étouffement). Utilise de la terre ou de la pierre pour un toit.`
      return `Échec de la pose en ${x} ${y} ${z}.`
    })

  tool('utiliser_bloc', 'Interagir avec un bloc : ouvrir/fermer une porte ou trappe, appuyer sur un bouton, un levier...', XYZ, ['x', 'y', 'z'],
    async ({ x, y, z }) => {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b || isAir(b)) return 'Rien ici.'
      await gotoPos(b.position, 3, 30000)
      await bot.activateBlock(b)
      return `Utilisé : ${b.name}.`
    })

  tool('donner', 'Donner (lancer) des objets à un joueur.', { joueur: S('pseudo'), objet: S('nom de l\'objet'), quantite: N('nombre') }, ['joueur', 'objet'],
    async ({ joueur, objet, quantite = 1 }) => {
      const ent = playerEntity(joueur)
      if (!ent) return `Je ne vois pas ${joueur}.`
      const item = findItem(objet)
      if (!item) return `Je n'ai pas de ${objet}.`
      await gotoPos(ent.position, 2, 60000)
      const n = Math.min(quantite, countOf(item.name))
      await bot.lookAt(ent.position.offset(0, 1.6, 0))
      await bot.toss(item.type, null, n)
      return `Donné ${n} × ${item.name} à ${joueur}.`
    })

  tool('ramasser', 'Ramasser les objets qui traînent par terre autour.', {}, [], async () => {
    ctx.abort = false
    const n = await pickUpItems(16)
    return n ? `Ramassé ${n} tas d'objets.` : 'Rien à ramasser.'
  })

  tool('attaquer', 'Attaquer la créature la plus proche d\'un type donné (monstre ou animal pour la nourriture, ex. zombie, cow, pig, sheep, chicken). Jamais de joueurs.',
    { cible: S('type de créature en anglais') }, ['cible'], async ({ cible }) => {
      const name = norm(cible)
      if (name === 'player') return 'Je n\'attaque pas les joueurs.'
      if (name === 'end_crystal') return 'Non ! Un cristal frappé à l\'épée explose et me tue. Je m\'éloigne à plus de 10 blocs et je le casse à l\'arc (tirer end_crystal).'
      if (name === 'ender_dragon') {
        const dragon = bot.nearestEntity(e => e.name === 'ender_dragon' && dist(e.position) < 120)
        if (!dragon) return 'Je ne vois pas le dragon.'
        return frapperDragon(dragon)
      }
      const ent = bot.nearestEntity(e => e.name === name && dist(e.position) < 32)
      if (!ent) return `Aucun ${cible} à moins de 32 blocs.`
      const deaths0 = ctx.deaths
      await equipBestWeapon()
      bot.pvp.attack(ent).catch(() => {})
      const t0 = Date.now()
      let retraite = false
      while (bot.entities[ent.id] && Date.now() - t0 < 30000 && !ctx.abort) {
        // vie trop basse : on arrête le combat avant de mourir
        if (bot.health > 0 && bot.health <= 6) { retraite = true; break }
        await sleep(400)
      }
      await bot.pvp.stop().catch(() => {})
      if (ctx.deaths !== deaths0) return `Je suis mort pendant le combat contre ${cible}.`
      if (retraite) {
        // s'éloigner un peu du monstre puis manger
        const m = bot.entities[ent.id]
        if (m) await goto(new goals.GoalInvert(new GoalFollow(m, 14)), 6000).catch(() => {})
        await eat().catch(() => {})
        return `Je me retire : ma vie est tombée à ${Math.round(bot.health)}/20. Mets ton armure si ce n'est pas fait, mange, et abrite-toi (maison, ou trou refermé) avant de repartir au combat.`
      }
      const killed = !bot.entities[ent.id]
      if (killed) { await sleep(500); await pickUpItems(6) }
      return killed ? `${cible} tué, butin ramassé.` : 'Combat interrompu.'
    })

  tool('chasser', 'Chasser plusieurs animaux pour la nourriture (vaches, cochons, moutons, poulets, lapins) et ramasser la viande. Ne touche jamais aux animaux enfermés dans l\'enclos de quelqu\'un d\'autre. Dans TON enclos (le lieu « enclos »), je peux en prendre en gardant toujours 2 bêtes pour la reproduction.',
    { quantite: N('nombre d\'animaux, 1 à 10 (défaut 4)'), animal: S('type précis (optionnel) : cow, pig, sheep, chicken, rabbit') }, [],
    async ({ quantite = 4, animal }) => {
      const n = Math.min(Math.max(1, quantite | 0), 10)
      const types = animal ? new Set([norm(animal)]) : FOOD_ANIMALS
      const skip = new Set() // animaux en enclos ou qu'on n'arrive pas à atteindre
      let killed = 0
      let penned = 0
      ctx.followName = null
      const deaths0 = ctx.deaths
      await equipBestWeapon()
      while (killed < n && !interrupted()) {
        if (ctx.deaths !== deaths0) return `Je suis mort pendant la chasse (${killed} animaux tués avant). Mets-toi à l'abri, mange, et récupère ton stuff.`
        const ent = bot.nearestEntity(e => types.has(e.name) && !skip.has(e.id) && dist(e.position) < 48)
        if (!ent) break
        if (isPenned(ent)) {
          // SON propre enclos (le lieu « enclos » qu'il a construit) : il peut en prendre, en gardant 2 bêtes pour la reproduction.
          // Les autres enclos sont à quelqu'un : on n'y touche jamais.
          const enclos = memoire.lieu('enclos')
          const dansLeMien = enclos && ent.position.distanceTo(new Vec3(enclos.x, enclos.y, enclos.z)) < 8
          const restants = dansLeMien ? Object.values(bot.entities).filter(e => e.name === ent.name && isPenned(e) && e.position.distanceTo(new Vec3(enclos.x, enclos.y, enclos.z)) < 8).length : 0
          if (!(dansLeMien && restants > 2)) { skip.add(ent.id); penned++; continue }
          // entrer par le portillon (et le refermer derrière moi), frapper, ressortir en refermant
          await enterPen().catch(() => {})
          bot.pvp.attack(ent).catch(() => {})
          const t1 = Date.now()
          while (bot.entities[ent.id] && Date.now() - t1 < 20000 && !ctx.abort) await sleep(300)
          await bot.pvp.stop().catch(() => {})
          await pickUpItems(5)
          await exitPen().catch(() => {})
          if (bot.entities[ent.id]) { skip.add(ent.id); continue }
          killed++
          continue
        }
        bot.pvp.attack(ent).catch(() => {})
        const t0 = Date.now()
        while (bot.entities[ent.id] && Date.now() - t0 < 25000 && !ctx.abort) await sleep(300)
        await bot.pvp.stop().catch(() => {})
        if (ctx.deaths !== deaths0) continue
        if (bot.entities[ent.id]) { skip.add(ent.id); continue }
        killed++
        await sleep(500)
        await pickUpItems(6)
      }
      const enclos = penned ? ` (${penned} animaux laissés tranquilles : ils sont dans un enclos)` : ''
      if (!killed) return `Aucun animal libre à moins de 48 blocs${enclos}. Explore pour en trouver.`
      return `Chassé ${killed} animaux, viande ramassée${enclos}. Réserve de nourriture : ${foodReserve()} points. Fais cuire la viande crue (cuire) pour qu'elle nourrisse plus.`
    })

  tool('manger', 'Manger le meilleur aliment de l\'inventaire.', {}, [], eat)

  tool('equiper', 'Équiper un objet en main, ou "armure" pour mettre automatiquement la meilleure armure.', { objet: S('nom de l\'objet ou "armure"') }, ['objet'],
    async ({ objet }) => {
      if (norm(objet) === 'armure') {
        const best = {}
        for (const it of items()) {
          const m = it.name.match(/^(\w+?)_(helmet|chestplate|leggings|boots)$/)
          if (!m) continue
          const tier = ARMOR_TIER[m[1]] || 0
          if (!best[m[2]] || tier > best[m[2]].tier) best[m[2]] = { it, tier }
        }
        const done = []
        for (const [piece, { it }] of Object.entries(best)) { await bot.equip(it, ARMOR_SLOT[piece]); done.push(it.name) }
        if (done.length) return `Armure équipée : ${done.join(', ')}.`
        return armorNames().length ? `Je porte déjà mon armure : ${armorNames().join(', ')}.` : 'Je n\'ai pas d\'armure.'
      }
      const it = findItem(objet)
      if (!it) return `Je n'ai pas de ${objet}.`
      const piece = it.name.match(/_(helmet|chestplate|leggings|boots)$/)
      if (piece) { await bot.equip(it, ARMOR_SLOT[piece[1]]); return `${it.name} enfilé.` }
      if (it.name === 'carved_pumpkin') { await bot.equip(it, 'head'); return 'Citrouille sur la tête : les endermen ne s\'énervent plus quand je les regarde.' }
      await bot.equip(it, it.name === 'shield' ? 'off-hand' : 'hand')
      return `${it.name} équipé.`
    })

  tool('dormir', 'Dormir la nuit : dans un lit libre proche, sinon je pose mon lit portable (si j\'en ai un) et je le reprends au réveil.', {}, [], async () => {
    const t = bot.time.timeOfDay
    if (!(t >= 12542 && t <= 23459) && !bot.thunderState) return 'Ce n\'est pas encore la nuit : on ne peut pas dormir.'
    // 1) un lit libre pas loin (on évite ceux où quelqu'un dort déjà)
    const beds = bot.findBlocks({ matching: (b) => bot.isABed(b), maxDistance: 24, count: 20 }).map(p => bot.blockAt(p)).filter(Boolean)
    const free = beds.filter(b => !b.getProperties?.().occupied)
    let lastErr = null
    for (const bed of free.slice(0, 4)) {
      try {
        await gotoPos(bed.position, 2, 60000)
        await bot.sleep(bed)
        return 'Je dors. Zzz.'
      } catch (e) {
        lastErr = e
        if (!/occupied|too far|path|stopped/i.test(e.message)) return `Impossible de dormir : ${e.message}` // jour, monstres... : inutile d'insister
      }
    }
    // 2) sinon, le lit portable
    const item = bedItem()
    if (!item) {
      return (beds.length ? 'Pas de lit libre ici' : 'Aucun lit à proximité') +
        ' et pas de lit portable. Il en faut un : 3 laines de la même couleur (moutons) + 3 planches.'
    }
    const bed = await placePortableBed(item)
    if (!bed) return 'Pas de place pour poser mon lit portable ici (il faut 2 blocs plats et libres à côté de moi).'
    try {
      await bot.sleep(bed)
      ctx.portableBed = bed.position
      return 'Lit portable posé, je dors. Zzz. Je le reprendrai à mon réveil.'
    } catch (e) {
      await pickUpBed(bed.position)
      return `Impossible de dormir : ${e.message}. J'ai repris mon lit portable.`
    }
  })

  tool('se_reveiller', 'Sortir du lit.', {}, [], async () => { try { await bot.wake() } catch (_) {} return 'Réveillé.' })

  tool('coffre_contenu', 'Voir le contenu du coffre (ou tonneau) le plus proche.', {}, [], async () => {
    const c = await openNearestChest(); if (typeof c === 'string') return c
    try {
      const inv = {}
      for (const i of c.containerItems()) inv[i.name] = (inv[i.name] || 0) + i.count
      return 'Coffre : ' + (Object.entries(inv).map(([k, v]) => `${k} x${v}`).join(', ') || 'vide')
    } finally { c.close() }
  })

  tool('coffre_deposer', 'Ranger des objets dans le coffre le plus proche. Sans objet précisé : range tout sauf outils, armes, armure et nourriture.',
    { objet: S('objet à ranger (optionnel)'), quantite: N('nombre (optionnel)') }, [],
    async ({ objet, quantite }) => {
      const c = await openNearestChest(); if (typeof c === 'string') return c
      try {
        const keep = (i) => /_sword$|_pickaxe$|_axe$|_shovel$|_hoe$|_helmet$|_chestplate$|_leggings$|_boots$|shield|fishing_rod|bow$/.test(i.name) || reg.foodsByName?.[i.name]
        const todo = {}
        for (const i of items()) {
          if (objet ? i.name !== norm(objet) : keep(i)) continue
          todo[i.type] = { name: i.name, n: (todo[i.type]?.n || 0) + i.count }
        }
        const done = []
        for (const [type, { name, n }] of Object.entries(todo)) {
          const k = quantite ? Math.min(quantite, n) : n
          try { await c.deposit(Number(type), null, k); done.push(`${k} ${name}`) } catch (e) { done.push(`(${name} : ${e.message})`) }
        }
        return done.length ? `Rangé : ${done.join(', ')}.` : 'Rien à ranger.'
      } finally { c.close() }
    })

  tool('coffre_prendre', 'Prendre des objets dans le coffre le plus proche.', { objet: S('objet'), quantite: N('nombre') }, ['objet'],
    async ({ objet, quantite = 1 }) => {
      const c = await openNearestChest(); if (typeof c === 'string') return c
      try {
        const it = c.containerItems().find(i => i.name === norm(objet))
        if (!it) return `Pas de ${objet} dans le coffre.`
        const total = c.containerItems().filter(i => i.name === it.name).reduce((a, i) => a + i.count, 0)
        const n = Math.min(quantite, total)
        await c.withdraw(it.type, null, n)
        return `Pris ${n} × ${it.name}.`
      } finally { c.close() }
    })

  async function openNearestChest () {
    const ids = ['chest', 'trapped_chest', 'barrel'].map(n => reg.blocksByName[n]?.id).filter(Boolean)
    const chest = bot.findBlock({ matching: ids, maxDistance: 32 })
    if (!chest) return 'Aucun coffre à proximité.'
    await gotoPos(chest.position, 2, 90000)
    return bot.openContainer(chest)
  }

  tool('planter', 'Planter des graines/légumes sur la terre labourée (farmland) libre autour. Laboure aussi la terre si j\'ai une houe.',
    { graine: S('wheat_seeds, carrot, potato ou beetroot_seeds'), quantite: N('nombre') }, ['graine'],
    async ({ graine, quantite = 16 }) => {
      const seed = findItem(graine)
      if (!seed) return `Je n'ai pas de ${graine}.`
      ctx.abort = false
      let planted = 0
      const farmId = reg.blocksByName.farmland.id
      while (planted < quantite && !ctx.abort && countOf(seed.name) > 0) {
        let soil = bot.findBlock({ matching: farmId, maxDistance: 32, useExtraInfo: (b) => isAir(bot.blockAt(b.position.offset(0, 1, 0))) })
        if (!soil) {
          const hoe = items().find(i => i.name.endsWith('_hoe'))
          if (!hoe) break
          const dirt = bot.findBlock({ matching: ['dirt', 'grass_block'].map(n => reg.blocksByName[n].id), maxDistance: 16, useExtraInfo: (b) => isAir(bot.blockAt(b.position.offset(0, 1, 0))) })
          if (!dirt) break
          await gotoPos(dirt.position, 3, 20000)
          await bot.equip(hoe, 'hand')
          await bot.activateBlock(dirt)
          await sleep(300)
          soil = bot.blockAt(dirt.position)
          if (soil?.name !== 'farmland') break
        }
        await gotoPos(soil.position, 3, 20000)
        await bot.equip(findItem(seed.name), 'hand')
        try { await bot.placeBlock(soil, new Vec3(0, 1, 0)) } catch (_) {}
        planted++
      }
      return planted ? `Planté ${planted} × ${seed.name}.` : 'Pas de terre labourée libre (ni de houe pour en faire).'
    })

  tool('moissonner', 'Récolter les cultures mûres autour (blé, carottes, patates, betteraves) et replanter.',
    { quantite: N('nombre max de plants') }, [], async ({ quantite = 32 }) => {
      ctx.abort = false
      let n = 0
      const ids = Object.keys(MATURE).map(k => reg.blocksByName[k]?.id).filter(Boolean)
      while (n < quantite && !ctx.abort) {
        const crop = bot.findBlock({
          matching: ids, maxDistance: 32,
          useExtraInfo: (b) => (b.getProperties?.().age ?? b.metadata) >= MATURE[b.name]
        })
        if (!crop) break
        await gotoPos(crop.position, 3, 20000)
        await creuserBloc(crop)
        n++
        await goto(new GoalBlock(crop.position.x, crop.position.y, crop.position.z), 5000).catch(() => {})
        const seed = SEED_FOR[crop.name] && findItem(SEED_FOR[crop.name])
        const soil = bot.blockAt(crop.position.offset(0, -1, 0))
        if (seed && soil?.name === 'farmland') { await bot.equip(seed, 'hand'); try { await bot.placeBlock(soil, new Vec3(0, 1, 0)) } catch (_) {} }
      }
      await pickUpItems(8)
      return n ? `Moissonné ${n} plants et replanté.` : 'Aucune culture mûre autour.'
    })

  tool('pecher', 'Pêcher avec une canne à pêche pendant un moment (près de l\'eau).', { secondes: N('durée, max 300') }, [],
    async ({ secondes = 60 }) => {
      const rod = findItem('fishing_rod')
      if (!rod) return 'Je n\'ai pas de canne à pêche (3 bâtons + 2 ficelles).'
      const water = bot.findBlock({ matching: reg.blocksByName.water.id, maxDistance: 24 })
      if (!water) return 'Pas d\'eau à proximité.'
      await gotoPos(water.position, 3, 30000)
      await bot.lookAt(water.position.offset(0.5, 0.5, 0.5))
      await bot.equip(rod, 'hand')
      ctx.abort = false
      const end = Date.now() + Math.min(secondes, 300) * 1000
      let caught = 0
      while (Date.now() < end && !ctx.abort) {
        try { await withTimeout(bot.fish(), 45000, () => bot.activateItem()); caught++ } catch (_) { break }
      }
      return `J'ai pêché ${caught} fois.`
    })

  tool('defense', 'Activer ou couper la défense automatique contre les monstres.', { active: { type: 'boolean' } }, ['active'],
    async ({ active }) => { ctx.defense = !!active; return `Défense auto ${active ? 'activée' : 'coupée'}.` })

  tool('sauter', 'Faire un petit saut (pour saluer ou débloquer).', {}, [], async () => {
    bot.setControlState('jump', true); await sleep(400); bot.setControlState('jump', false); return 'Sauté.'
  })

  tool('regarder_joueur', 'Se tourner vers un joueur.', { joueur: S('pseudo') }, ['joueur'], async ({ joueur }) => {
    const ent = playerEntity(joueur); if (!ent) return `Je ne vois pas ${joueur}.`
    await bot.lookAt(ent.position.offset(0, 1.6, 0)); return 'Ok.'
  })

  // ---------- mémoire : lieux et souvenirs ----------
  tool('memoriser_lieu', 'Retenir un lieu important sous un nom (base, mine, village...). Sans coordonnées : l\'endroit où je suis.',
    { nom: S('nom du lieu, ex. base'), x: N('x (optionnel)'), y: N('y (optionnel)'), z: N('z (optionnel)') }, ['nom'],
    async ({ nom, x, y, z }) => {
      const pos = (x !== undefined && y !== undefined && z !== undefined) ? new Vec3(x, y, z) : bot.entity.position
      memoire.setLieu(nom, pos, bot.game.dimension)
      return `Lieu « ${nom} » retenu en ${fmt(pos)}.`
    })

  tool('aller_au_lieu', 'Aller à un lieu retenu (ex. base).', { nom: S('nom du lieu') }, ['nom'], async ({ nom }) => {
    const l = memoire.lieu(nom)
    if (!l) return `Je ne connais pas de lieu « ${nom} ». Lieux connus : ${Object.keys(memoire.lieux()).join(', ') || 'aucun'}.`
    if (l.dimension && l.dimension !== bot.game.dimension) return `« ${nom} » est dans une autre dimension (${l.dimension}).`
    ctx.followName = null
    await travelTo(l.x, l.z, l.y)
    return `Arrivé à « ${nom} » (${l.x} ${l.y} ${l.z}).`
  })

  tool('oublier_lieu', 'Oublier un lieu retenu.', { nom: S('nom du lieu') }, ['nom'], async ({ nom }) =>
    memoire.removeLieu(nom) ? `Lieu « ${nom} » oublié.` : `Je ne connaissais pas « ${nom} ».`)

  tool('retenir', 'Garder un souvenir pour toujours : quelque chose d\'important sur un joueur (ce qu\'il aime, son surnom), un exploit fait ensemble, un projet. Une phrase courte.',
    { souvenir: S('le souvenir, en une phrase') }, ['souvenir'], async ({ souvenir }) => { memoire.addSouvenir(souvenir); return 'Souvenir gardé.' })

  tool('mode_autonome', 'Allumer ou couper ton mode autonome (quand tu n\'as rien à faire, tu prends des initiatives tout seul). Coupe-le si on te demande de rester tranquille ou d\'attendre ; rallume-le quand on te redonne carte blanche.',
    { actif: { type: 'boolean' } }, ['actif'], async ({ actif }) => {
      memoire.setReglage('autonome', !!actif)
      return actif ? 'Mode autonome allumé : je prendrai des initiatives quand je n\'ai rien à faire.' : 'Mode autonome coupé : j\'attends qu\'on me dise quoi faire.'
    })

  // ---------- missions autonomes ----------
  tool('commencer_mission', 'Lancer une mission en autonomie : tu travailles seul pendant une durée (miner, récolter, explorer, construire...), puis tu vas au rendez-vous et tu fais un bilan. Des lignes [mission] te relancent régulièrement.',
    {
      objectif: S('ce qu\'il faut faire, ex. « miner du fer et du charbon, couper du bois »'),
      minutes: N('durée en minutes (1 à 120)'),
      rendez_vous: S('où revenir à la fin : un lieu retenu (ex. base) ou le pseudo d\'un joueur (optionnel)')
    }, ['objectif', 'minutes'],
    async ({ objectif, minutes, rendez_vous }) => {
      const min = Math.min(Math.max(1, minutes | 0), 120)
      ctx.followName = null
      ctx.mission = { objectif, fin: Date.now() + min * 60000, rdv: rendez_vous || null, depart: invCounts(), finNotifiee: false }
      let rdvTxt = ''
      if (rendez_vous && !memoire.lieu(rendez_vous) && !playerEntity(rendez_vous) && !bot.players[rendez_vous]) {
        rdvTxt = ` Attention : je ne connais pas de lieu « ${rendez_vous} ». Retiens-le d'abord avec memoriser_lieu si c'est ici.`
      }
      const prio = priorites()
      const prioTxt = prio.length
        ? ` AVANT l'objectif, règle ces priorités dans l'ordre : ${prio.map((x, i) => `${i + 1}) ${x}`).join(' ; ')}.`
        : ' Tu es bien équipé : fonce sur l\'objectif.'
      return `Mission lancée pour ${min} min : ${objectif}.${rdvTxt}${prioTxt}`
    })

  tool('terminer_mission', 'Terminer la mission en cours : seulement quand le temps est écoulé, ou quand un joueur te demande d\'arrêter. Renvoie ce que tu as récupéré pendant la mission.',
    { raison: { type: 'string', enum: ['temps_ecoule', 'joueur_demande'], description: 'pourquoi tu termines' } }, ['raison'],
    async ({ raison }) => {
      if (!ctx.mission) return 'Pas de mission en cours.'
      const left = Math.ceil((ctx.mission.fin - Date.now()) / 60000)
      if (left > 0 && raison !== 'joueur_demande') {
        return `Pas encore : il reste ${left} min de mission. Continue (autre ressource de l'objectif, explorer, creuser plus loin...). Tu ne termines en avance que si un joueur te le demande.`
      }
      const g = missionGains()
      ctx.mission = null
      return `Mission terminée. Récupéré pendant la mission : ${g}.`
    })

  tool('explorer', 'Partir explorer dans une direction pour trouver des ressources (arbres, minerais, animaux, village...) quand il n\'y en a plus autour. Dit ce qu\'il voit à l\'arrivée.',
    { direction: { type: 'string', enum: ['nord', 'sud', 'est', 'ouest'] }, distance: N('nombre de blocs, 16 à 150 (défaut 48)') }, ['direction'],
    async ({ direction, distance = 48 }) => {
      const d = Math.min(Math.max(16, distance | 0), 150)
      const [dx, dz] = { nord: [0, -1], sud: [0, 1], est: [1, 0], ouest: [-1, 0] }[direction]
      ctx.followName = null
      const p = bot.entity.position
      try {
        await goto(new goals.GoalXZ(Math.floor(p.x + dx * d), Math.floor(p.z + dz * d)), d * 1500 + 15000)
      } catch (e) {
        return `Exploration arrêtée (${e.message}) en ${fmt(bot.entity.position)}. ${scan(32)}`
      }
      return `Arrivé en ${fmt(bot.entity.position)} après ${d} blocs vers ${direction}. ${scan(32)}`
    })

  // ---------- construction ----------
  const MATERIAUX = /_planks$|^cobblestone$|^cobbled_deepslate$|^stone$|^stone_bricks$|^bricks$|^sandstone$|^dirt$/
  function bestMaterial () {
    const inv = invCounts()
    const best = Object.entries(inv).filter(([k]) => MATERIAUX.test(k) && k !== 'dirt').sort((a, b) => b[1] - a[1])[0]
    return best ? best[0] : (inv.dirt ? 'dirt' : null)
  }
  const replaceable = (p) => { const b = bot.blockAt(p); return !b || isAir(b) || /water|grass$|fern|snow$|dead_bush|vine/.test(b.name) }

  tool('construire_plusieurs', 'Poser plusieurs blocs d\'un coup (mur, sol, pont, tour...) : donne la liste des positions. Je les pose du bas vers le haut.',
    {
      objet: S('bloc à poser'),
      blocs: { type: 'array', description: 'positions [x, y, z] (128 max)', items: { type: 'array', items: { type: 'integer' } } }
    }, ['objet', 'blocs'],
    async ({ objet, blocs }) => {
      const item = findItem(objet)
      if (!item) return `Je n'ai pas de ${objet}.`
      const list = (Array.isArray(blocs) ? blocs : []).filter(b => Array.isArray(b) && b.length === 3).slice(0, 128).map(([x, y, z]) => new Vec3(x, y, z))
      if (!list.length) return 'Liste de positions vide ou invalide (format : [[x, y, z], ...]).'
      const need = list.filter(replaceable).length
      if (countOf(item.name) < need) return `Il me faut ${need} ${item.name}, j'en ai ${countOf(item.name)}.`
      ctx.followName = null
      list.sort((a, b) => a.y - b.y || dist(a) - dist(b))
      return `Construction : ${bilan(await placeMany(item.name, list))}.`
    })

  tool('construire_cabane', 'Construire tout seul une cabane : 4 murs avec une ouverture pour la porte (côté sud) et un toit plat, plus porte et torche si j\'en ai. Mets-toi sur un terrain plutôt plat. Sans coordonnées, je la construis juste à côté de moi. Il faut assez de blocs (cabane 5x5x3 ≈ 70 blocs).',
    {
      x: N('coin nord-ouest, x (optionnel)'),
      y: N('niveau où commencent les murs = hauteur de tes pieds sur le sol (optionnel)'),
      z: N('coin nord-ouest, z (optionnel)'),
      largeur: N('est-ouest, 4 à 9 (défaut 5)'),
      longueur: N('nord-sud, 4 à 9 (défaut 5)'),
      hauteur: N('hauteur des murs, 3 ou 4 (défaut 3)'),
      materiau: S('bloc des murs (défaut : ce que j\'ai le plus : planches, cobblestone...)'),
      toit: S('bloc du toit (défaut : le même)')
    }, [],
    async ({ x, y, z, largeur = 5, longueur = 5, hauteur = 3, materiau, toit }) => {
      const W = Math.min(Math.max(4, largeur | 0), 9)
      const L = Math.min(Math.max(4, longueur | 0), 9)
      const H = Math.min(Math.max(3, hauteur | 0), 4)
      const me = bot.entity.position.floored()
      const ox = x ?? me.x + 2
      const oy = y ?? me.y
      const oz = z ?? me.z - Math.floor(L / 2)
      const mur = materiau ? norm(materiau) : bestMaterial()
      const roof = toit ? norm(toit) : mur
      if (!mur) return 'Je n\'ai pas de blocs pour construire (planches, cobblestone...). Il faut en récolter ou en fabriquer d\'abord.'
      const doorX = ox + Math.floor(W / 2)
      const walls = []
      for (let dy = 0; dy < H; dy++) {
        for (let dx = 0; dx < W; dx++) {
          for (let dz = 0; dz < L; dz++) {
            if (!(dx === 0 || dx === W - 1 || dz === 0 || dz === L - 1)) continue
            if (dz === L - 1 && ox + dx === doorX && dy < 2) continue // ouverture de la porte
            walls.push(new Vec3(ox + dx, oy + dy, oz + dz))
          }
        }
      }
      // le toit se pose du bord vers le centre, pour que chaque bloc ait un appui
      const top = []
      for (let dx = 0; dx < W; dx++) {
        for (let dz = 0; dz < L; dz++) top.push({ p: new Vec3(ox + dx, oy + H, oz + dz), ring: Math.min(dx, W - 1 - dx, dz, L - 1 - dz) })
      }
      top.sort((a, b) => a.ring - b.ring)
      const needs = {}
      needs[mur] = (needs[mur] || 0) + walls.filter(replaceable).length
      needs[roof] = (needs[roof] || 0) + top.filter(t => replaceable(t.p)).length
      const manque = Object.entries(needs).filter(([k, n]) => countOf(k) < n).map(([k, n]) => `${n - countOf(k)} ${k} (j'en ai ${countOf(k)}, il en faut ${n})`)
      if (manque.length) return `Pas assez de blocs pour une cabane ${W}x${L}x${H} : il manque ${manque.join(', ')}. Récupère-les d'abord, ou fais-la plus petite.`
      ctx.followName = null
      const r1 = await placeMany(mur, walls)
      if (r1.stop) return `Murs : ${bilan(r1)}. Cabane pas finie.`
      const r2 = await placeMany(roof, top.map(t => t.p))
      let extras = ''
      const door = items().find(i => /_door$/.test(i.name))
      if (door && !r2.stop && (await placeAt(door.name, new Vec3(doorX, oy, oz + L - 1))) === 'ok') extras += ' Porte posée.'
      if (findItem('torch') && !r2.stop && (await placeAt('torch', new Vec3(ox + 1, oy, oz + 1))) === 'ok') extras += ' Torche posée dedans.'
      return `Cabane ${W}x${L} construite (coin ${ox} ${oy} ${oz}, entrée côté sud en ${doorX} ${oy} ${oz + L - 1}). Murs : ${bilan(r1)}. Toit : ${bilan(r2)}.${extras} Pense à la retenir avec memoriser_lieu.`
    })

  // =====================================================================
  // ---------- terrain : chercher un bel endroit, aplanir ----------
  // =====================================================================
  const clamp = (v, a, b) => Math.min(Math.max(a, v | 0), b)
  const dim = () => bot.game.dimension
  // l'objet de ce type que j'ai le plus (ex. les planches les plus nombreuses)
  const most = (re, excl) => Object.entries(invCounts()).filter(([k]) => re.test(k) && !(excl && excl.test(k))).sort((a, b) => b[1] - a[1])[0]?.[0]
  const TREE = /_leaves$|_log$|_stem$|vine|bamboo|mushroom_block|_wart_block$/

  // hauteur du sol d'une colonne (le dernier bloc solide sous les arbres et les herbes)
  function surface (x, z, refY) {
    let tree = false
    for (let y = refY + 16; y >= refY - 24; y--) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) return null // pas chargé
      if (/water|lava/.test(b.name)) return { y, liquid: true, tree }
      if (isAir(b) || b.boundingBox === 'empty') continue
      if (TREE.test(b.name)) { tree = true; continue }
      return { y, liquid: false, tree }
    }
    return null
  }

  tool('chercher_terrain', 'Chercher autour de toi (40 blocs) le meilleur endroit plat et dégagé pour construire (maison, enclos, champ), loin des constructions des joueurs. Donne les coordonnées à utiliser ensuite.',
    { largeur: N('taille est-ouest voulue (défaut 9)'), longueur: N('taille nord-sud voulue (défaut 9)') }, [],
    async ({ largeur = 9, longueur = 9 }) => {
      const W = clamp(largeur, 4, 15)
      const L = clamp(longueur, 4, 15)
      const me = bot.entity.position.floored()
      const R = 40
      const H = new Map()
      for (let x = me.x - R; x <= me.x + R; x++) {
        for (let z = me.z - R; z <= me.z + R; z++) {
          const s = surface(x, z, me.y)
          if (s) H.set(x + ',' + z, s)
        }
      }
      // on évite les constructions des joueurs (8 blocs de marge)
      const builds = bot.findBlocks({ matching: (b) => PROTECTED.test(b.name), maxDistance: R + 10, count: 3000 })
      let best = null
      for (let x0 = me.x - R; x0 <= me.x + R - W; x0 += 2) {
        for (let z0 = me.z - R; z0 <= me.z + R - L; z0 += 2) {
          const hs = []
          let bad = false
          let trees = 0
          for (let dx = -1; dx <= W && !bad; dx++) {
            for (let dz = -1; dz <= L; dz++) {
              const s = H.get((x0 + dx) + ',' + (z0 + dz))
              if (!s || s.liquid) { bad = true; break }
              hs.push(s.y)
              if (s.tree) trees++
            }
          }
          if (bad) continue
          if (builds.some(p => p.x >= x0 - 8 && p.x <= x0 + W + 8 && p.z >= z0 - 8 && p.z <= z0 + L + 8)) continue
          hs.sort((a, b) => a - b)
          const med = hs[Math.floor(hs.length / 2)]
          const work = hs.reduce((a, h) => a + Math.abs(h - med), 0) + trees * 3
          const score = work + Math.hypot(x0 + W / 2 - me.x, z0 + L / 2 - me.z) / 8
          if (!best || score < best.score) best = { x0, z0, y: med + 1, work, trees, score }
        }
      }
      if (!best) return 'Pas de terrain correct dans les 40 blocs (eau, pentes ou constructions partout). Explore plus loin (explorer).'
      const plat = best.work <= 4 ? 'Presque plat, tu peux construire directement' : `Il faudra aplanir d'abord (environ ${best.work} blocs à déplacer${best.trees ? ', avec des arbres' : ''})`
      return `Meilleur endroit : coin nord-ouest x=${best.x0}, z=${best.z0}, niveau du sol y=${best.y} (zone ${W}x${L}). ${plat}. Utilise ces x, y, z pour aplanir puis construire_maison.`
    })

  tool('aplanir', 'Aplanir un terrain avant de construire : enlève ce qui dépasse (terre, pierre, arbres) et bouche les trous (avec de la terre ou de la cobblestone). Refuse s\'il y a une construction dans la zone.',
    {
      x: N('coin nord-ouest x'),
      y: N('niveau du sol voulu (hauteur des pieds)'),
      z: N('coin nord-ouest z'),
      largeur: N('est-ouest (défaut 9)'),
      longueur: N('nord-sud (défaut 9)'),
      hauteur: N('hauteur à dégager au-dessus du sol (défaut 8)')
    }, ['x', 'y', 'z'],
    async ({ x, y, z, largeur = 9, longueur = 9, hauteur = 8 }) => {
      const W = clamp(largeur, 3, 15)
      const L = clamp(longueur, 3, 15)
      const Hc = clamp(hauteur, 3, 12)
      const toDig = []
      const toFill = []
      for (let dx = -1; dx <= W; dx++) {
        for (let dz = -1; dz <= L; dz++) {
          for (let dy = Hc; dy >= 0; dy--) {
            const p = new Vec3(x + dx, y + dy, z + dz)
            const b = bot.blockAt(p)
            if (!b) return 'Cette zone n\'est pas chargée : rapproche-toi d\'abord.'
            if (isAir(b)) continue
            if (PROTECTED.test(b.name)) return `Il y a une construction (${b.name}) en ${fmt(p)} : je n'aplanis pas ici.`
            if (b.name === 'bedrock' || !b.diggable || /water|lava/.test(b.name)) continue
            toDig.push(p)
          }
          for (let dy = -1; dy >= -3; dy--) {
            const q = new Vec3(x + dx, y + dy, z + dz)
            const b = bot.blockAt(q)
            if (b && (isAir(b) || b.boundingBox === 'empty')) toFill.push(q)
            else break
          }
        }
      }
      if (toDig.length > 400) return `Trop de travail (${toDig.length} blocs à casser) : choisis un endroit plus plat (chercher_terrain).`
      ctx.followName = null
      let dug = 0
      for (const p of toDig) {
        if (interrupted()) break
        const b = bot.blockAt(p)
        if (!b || isAir(b)) continue
        await gotoPos(p, 4, 15000).catch(() => {})
        if (bot.entity.position.offset(0, 1.6, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 5.5) continue
        await equipToolFor(b)
        try { await creuserBloc(b); dug++ } catch (_) {}
        if (dug % 25 === 0) await pickUpItems(10)
      }
      await pickUpItems(12)
      toFill.sort((a, b) => a.y - b.y)
      let filled = 0
      for (const p of toFill) {
        if (interrupted()) break
        const m = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone'].find(n => countOf(n) > 0)
        if (!m) break
        if ((await placeAt(m, p)) === 'ok') filled++
      }
      const reste = toFill.length - filled
      return `Terrain aplani : ${dug} blocs enlevés, ${filled} trous bouchés${reste ? ` (${reste} trous restent : il manque de la terre ou de la cobblestone)` : ''}.`
    })

  // Pose une liste de blocs de matériaux différents ; continue si un matériau manque
  async function placeAll (list) {
    const res = { ok: 0, 'occupé': 0, 'sans appui': 0, 'échec': 0, manque: {} }
    for (const { p, mat } of list) {
      if (interrupted()) { res.stop = 'interrompu'; break }
      const r = await placeAt(mat, p)
      if (r === 'plus de matériau') { res.manque[mat] = (res.manque[mat] || 0) + 1; continue }
      res[r]++
    }
    return res
  }
  const bilan2 = (r) => bilan(r) + (Object.keys(r.manque).length ? `, il a manqué : ${Object.entries(r.manque).map(([k, n]) => `${n} ${k}`).join(', ')}` : '')
  // compte ce qu'il faut et ce qui manque pour une liste de blocs
  function besoins (list) {
    const need = {}
    for (const { p, mat } of list) if (replaceable(p)) need[mat] = (need[mat] || 0) + 1
    const manque = Object.entries(need).filter(([k, n]) => countOf(k) < n).map(([k, n]) => `${n - countOf(k)} ${k} (il en faut ${n}, j'en ai ${countOf(k)})`)
    return { need, manque }
  }

  // =====================================================================
  // ---------- maison style chalet ----------
  // =====================================================================
  tool('construire_maison', 'Construire une vraie maison style chalet : soubassement en cobblestone, piliers en bûches aux coins, murs en planches, fenêtres (si tu as du verre), porte, toit à deux pentes qui dépasse, torches dedans. Le terrain doit être plat (chercher_terrain puis aplanir). Si des matériaux manquent, le résultat dit lesquels.',
    {
      x: N('coin nord-ouest x'),
      y: N('niveau du sol (hauteur des pieds)'),
      z: N('coin nord-ouest z'),
      largeur: N('est-ouest, 5 à 11 (défaut 7)'),
      longueur: N('nord-sud, 5 à 13 (défaut 7)'),
      hauteur: N('hauteur des murs, 3 à 5 (défaut 4)'),
      murs: S('bloc des murs (défaut : les planches que j\'ai le plus)'),
      toit: S('bloc du toit (défaut : cobblestone, sinon d\'autres planches)'),
      piliers: S('bûches des coins (défaut : celles que j\'ai)')
    }, ['x', 'y', 'z'],
    async ({ x, y, z, largeur = 7, longueur = 7, hauteur = 4, murs, toit, piliers }) => {
      const W = clamp(largeur, 5, 11)
      const L = clamp(longueur, 5, 13)
      const H = clamp(hauteur, 3, 5)
      const x0 = x
      const x1 = x + W - 1
      const z0 = z
      const z1 = z + L - 1
      const doorX = x0 + Math.floor(W / 2)
      const wallMat = murs ? norm(murs) : (most(/_planks$/) || most(/^cobblestone$|^stone_bricks$/))
      if (!wallMat) return 'Il me faut des planches (ou de la cobblestone) pour les murs. Coupe du bois d\'abord : 1 bûche = 4 planches.'
      const logMat = piliers ? norm(piliers) : (most(/_log$/, /^stripped_/) || wallMat)
      const baseMat = countOf('cobblestone') ? 'cobblestone' : wallMat
      const roofMat = toit ? norm(toit) : (countOf('cobblestone') >= 60 ? 'cobblestone' : (most(/_planks$/, new RegExp('^' + wallMat + '$')) || wallMat))
      const glass = most(/^glass_pane$|^glass$/)
      let glassLeft = glass ? countOf(glass) : 0 // pas assez de verre : les fenêtres en trop deviennent des murs
      const plan = []
      // fenêtres : au milieu des murs est/ouest/nord, et de chaque côté de la porte si la maison est large
      const midZ = z0 + Math.floor(L / 2)
      const isWindow = (px, pz, dy) => {
        if (dy < 1 || dy > 2) return false
        if ((px === x0 || px === x1) && (pz === midZ || (L >= 9 && (pz === z0 + 2 || pz === z1 - 2)))) return true
        if (pz === z0 && px === doorX) return true
        if (pz === z1 && W >= 7 && (px === doorX - 2 || px === doorX + 2)) return true
        return false
      }
      for (let dy = 0; dy < H; dy++) {
        for (let px = x0; px <= x1; px++) {
          for (let pz = z0; pz <= z1; pz++) {
            if (!(px === x0 || px === x1 || pz === z0 || pz === z1)) continue
            if (pz === z1 && px === doorX && dy < 2) continue // porte
            const corner = (px === x0 || px === x1) && (pz === z0 || pz === z1)
            let mat = wallMat
            if (corner) mat = logMat
            else if (dy === 0) mat = baseMat
            else if (glassLeft > 0 && isWindow(px, pz, dy)) { mat = glass; glassLeft-- }
            plan.push({ p: new Vec3(px, y + dy, pz), mat })
          }
        }
      }
      // pignons (triangles au nord et au sud sous le toit) + toit à deux pentes qui dépasse d'un bloc sur les côtés
      const roofY = y + H
      for (let k = 0; x0 + k <= x1 - k; k++) {
        const ly = roofY + k
        for (const pz of [z0, z1]) {
          for (let px = x0 + k + 1; px <= x1 - k - 1; px++) plan.push({ p: new Vec3(px, ly, pz), mat: wallMat })
        }
        // ordre : d'abord le bloc qui a un appui dessous, puis celui à côté
        const left = k === 0 ? [x0, x0 - 1] : [x0 - 1 + k, x0 + k]
        const right = k === 0 ? [x1, x1 + 1] : [x1 + 1 - k, x1 - k]
        const cols = [...new Set([...left, ...right])]
        for (let pz = z0; pz <= z1; pz++) for (const px of cols) plan.push({ p: new Vec3(px, ly, pz), mat: roofMat })
      }
      const { manque } = besoins(plan)
      if (manque.length) {
        return `Pour une maison ${W}x${L} il manque : ${manque.join(' ; ')}. Récupère-les (1 bûche = 4 planches ; la cobblestone vient de la pierre), ou choisis d'autres matériaux (murs, toit, piliers) ou une maison plus petite.`
      }
      ctx.followName = null
      const r = await placeAll(plan)
      let extras = ''
      const door = items().find(i => /_door$/.test(i.name))
      if (door && !r.stop && (await placeAt(door.name, new Vec3(doorX, y, z1))) === 'ok') extras += ' Porte posée.'
      for (const [tx, tz] of [[x0 + 1, z0 + 1], [x1 - 1, z0 + 1]]) {
        if (findItem('torch') && !r.stop && (await placeAt('torch', new Vec3(tx, y, tz))) === 'ok') extras += ' Torche posée.'
      }
      const centre = new Vec3(x0 + Math.floor(W / 2), y, z0 + Math.floor(L / 2))
      memoire.setLieu('maison', centre, dim())
      if (!memoire.lieu('base')) memoire.setLieu('base', centre, dim())
      return `Maison ${W}x${L} construite : ${bilan2(r)}.${extras} Entrée côté sud en ${doorX} ${y} ${z1}. Retenue comme « maison ». ${door ? '' : 'Fabrique une porte (6 planches) et pose-la à l\'entrée. '}Tu peux l'aménager : lit, coffre, établi, four (poser).`
    })

  // =====================================================================
  // ---------- ferme : enclos, attirer, reproduire ----------
  // =====================================================================
  const BAIT = { cow: /^wheat$/, sheep: /^wheat$/, mooshroom: /^wheat$/, goat: /^wheat$/, pig: /^(carrot|potato|beetroot)$/, chicken: /_seeds$/, rabbit: /^(carrot|dandelion)$/ }
  const BAIT_TXT = { cow: 'du blé', sheep: 'du blé', mooshroom: 'du blé', goat: 'du blé', pig: 'des carottes ou des patates', chicken: 'des graines', rabbit: 'des carottes' }
  const inPen = (pos) => {
    const c = memoire.lieu('enclos')
    if (!c) return false
    const half = Math.floor(memoire.reglage('enclos_taille', 7) / 2) - 0.5
    return Math.abs(pos.x - (c.x + 0.5)) < half && Math.abs(pos.z - (c.z + 0.5)) < half
  }
  async function setGate (open) {
    const g = memoire.lieu('enclos_portillon')
    if (!g) return false
    const b = bot.blockAt(new Vec3(g.x, g.y, g.z))
    if (!b || !/fence_gate/.test(b.name)) return false
    if (!!b.getProperties().open === open) return true
    await gotoPos(b.position, 3, 20000).catch(() => {})
    try { await bot.activateBlock(b) } catch (_) {}
    await sleep(300)
    return true
  }
  // Autour de l'enclos, il ne pose ni ne casse aucun bloc en marchant :
  // un bloc de terre laissé contre la clôture sert de marchepied aux animaux pour s'échapper.
  async function noBuild (fn) {
    const saved = { dig: moves.canDig, towers: moves.allow1by1towers, scaf: moves.scafoldingBlocks }
    moves.canDig = false
    moves.allow1by1towers = false
    moves.scafoldingBlocks = []
    try { return await fn() } finally {
      moves.canDig = saved.dig
      moves.allow1by1towers = saved.towers
      moves.scafoldingBlocks = saved.scaf
    }
  }
  async function enterPen () {
    const c = memoire.lieu('enclos')
    await noBuild(async () => {
      await setGate(true)
      await goto(new goals.GoalNearXZ(c.x, c.z, 1), 20000).catch(() => {})
      await setGate(false)
    })
  }
  async function exitPen () {
    const g = memoire.lieu('enclos_portillon')
    await noBuild(async () => {
      await setGate(true)
      await goto(new goals.GoalNearXZ(g.x, g.z + 2, 1), 20000).catch(() => {})
      await setGate(false)
    })
  }
  // Enlève tout bloc parasite à l'intérieur de l'enclos (au niveau du sol et juste au-dessus)
  async function cleanPen () {
    const c = memoire.lieu('enclos')
    if (!c) return 0
    const half = Math.floor(memoire.reglage('enclos_taille', 7) / 2) - 1
    let removed = 0
    for (let dx = -half; dx <= half; dx++) {
      for (let dz = -half; dz <= half; dz++) {
        for (const dy of [0, 1]) {
          const p = new Vec3(c.x + dx, c.y + dy, c.z + dz)
          const b = bot.blockAt(p)
          if (!b || isAir(b) || b.boundingBox === 'empty' || /fence|_gate/.test(b.name)) continue
          await gotoPos(p, 4, 10000).catch(() => {})
          await equipToolFor(b)
          try { await creuserBloc(b); removed++ } catch (_) {}
        }
      }
    }
    if (removed) console.log(`  🧹 ${removed} bloc(s) parasite(s) enlevé(s) dans l'enclos`)
    return removed
  }

  tool('construire_enclos', 'Construire un enclos pour les animaux : clôture tout autour et un portillon côté sud. Il faut des clôtures (oak_fence : 4 planches + 2 bâtons → 3) et un portillon (oak_fence_gate : 4 bâtons + 2 planches). Sans coordonnées : à côté de moi.',
    { x: N('coin nord-ouest x (optionnel)'), y: N('niveau du sol (optionnel)'), z: N('coin nord-ouest z (optionnel)'), taille: N('côté de l\'enclos, 5 à 11 (défaut 7)') }, [],
    async ({ x, y, z, taille = 7 }) => {
      const T = clamp(taille, 5, 11)
      const me = bot.entity.position.floored()
      const x0 = x ?? me.x + 2
      const z0 = z ?? me.z - Math.floor(T / 2)
      const y0 = y ?? me.y
      const fence = most(/_fence$/)
      const gate = most(/_fence_gate$/)
      const gx = x0 + Math.floor(T / 2)
      const gz = z0 + T - 1
      const posts = []
      for (let dx = 0; dx < T; dx++) {
        for (let dz = 0; dz < T; dz++) {
          if (!(dx === 0 || dx === T - 1 || dz === 0 || dz === T - 1)) continue
          const s = surface(x0 + dx, z0 + dz, y0)
          if (!s || s.liquid) return `Il y a de l'eau ou un trou en ${x0 + dx} ${z0 + dz} : choisis un autre endroit (chercher_terrain).`
          posts.push({ p: new Vec3(x0 + dx, s.y + 1, z0 + dz), gate: x0 + dx === gx && z0 + dz === gz })
        }
      }
      const need = posts.filter(q => !q.gate).length
      if (!fence || countOf(fence) < need || !gate) {
        return `Il me faut ${need} clôtures (j'en ai ${fence ? countOf(fence) : 0}) et 1 portillon (${gate ? 'ok' : 'manquant'}). Fabrique oak_fence (4 planches + 2 bâtons → 3 clôtures) et oak_fence_gate (4 bâtons + 2 planches).`
      }
      ctx.followName = null
      const r = await placeAll(posts.map(q => ({ p: q.p, mat: q.gate ? gate : fence })))
      const g = posts.find(q => q.gate)
      memoire.setLieu('enclos', new Vec3(x0 + Math.floor(T / 2), y0, z0 + Math.floor(T / 2)), dim())
      memoire.setLieu('enclos_portillon', g.p, dim())
      memoire.setReglage('enclos_taille', T)
      await noBuild(() => cleanPen())
      return `Enclos ${T}x${T} construit (${bilan2(r)}), portillon en ${fmt(g.p)}. Retenu comme « enclos ». Ensuite : attirer_animaux avec ${BAIT_TXT.cow} pour les vaches et moutons.`
    })

  tool('attirer_animaux', 'Attirer des animaux dans ton enclos en tenant leur nourriture (vache, mouton : blé ; cochon : carotte ; poulet : graines). Il faut un enclos (construire_enclos). J\'ouvre et je referme le portillon.',
    { animal: S('cow, sheep, pig, chicken...'), nombre: N('combien, 1 à 4 (défaut 2)') }, ['animal'],
    async ({ animal, nombre = 2 }) => {
      const type = norm(animal)
      const bait = BAIT[type]
      if (!bait) return `Je ne sais pas attirer ${animal}.`
      if (!items().some(i => bait.test(i.name))) return `Il me faut ${BAIT_TXT[type]} pour attirer des ${type}.`
      const pen = memoire.lieu('enclos')
      const gp = memoire.lieu('enclos_portillon')
      if (!pen || !gp) return 'Je n\'ai pas d\'enclos : construis-en un d\'abord (construire_enclos).'
      const n = clamp(nombre, 1, 4)
      const outside = new Vec3(gp.x, gp.y, gp.z + 2)
      // le fond de l'enclos (côté opposé au portillon) : l'animal doit passer entièrement le portillon
      const half = Math.floor(memoire.reglage('enclos_taille', 7) / 2)
      const back = new Vec3(pen.x, pen.y, pen.z - (half - 1))
      const holdBait = async () => {
        if (bait.test(bot.heldItem?.name || '')) return
        const b = items().find(i => bait.test(i.name))
        if (b) await bot.equip(b, 'hand').catch(() => {})
      }
      // tenir un objet qui n'attire pas les animaux (épée, outil, bloc)
      const holdNoBait = async () => {
        const other = items().find(i => /_sword$|_axe$|_pickaxe$/.test(i.name)) || items().find(i => !bait.test(i.name) && !reg.foodsByName?.[i.name])
        if (other) await bot.equip(other, 'hand').catch(() => {})
        else await bot.unequip('hand').catch(() => {})
      }
      ctx.followName = null
      // pendant qu'il attire : il marche lentement, ne pose ni ne casse aucun bloc (sinon il lâche le blé)
      const saved = { sprint: moves.allowSprinting, dig: moves.canDig, towers: moves.allow1by1towers, scaf: moves.scafoldingBlocks }
      moves.allowSprinting = false
      moves.canDig = false
      moves.allow1by1towers = false
      moves.scafoldingBlocks = []
      let brought = 0
      const tried = new Set()
      try {
        while (brought < n && !interrupted()) {
          const ent = bot.nearestEntity(e => e.name === type && !tried.has(e.id) && !inPen(e.position) && !isPenned(e) && dist(e.position) < 64)
          if (!ent) break
          tried.add(ent.id)
          if (!items().some(i => bait.test(i.name))) break
          await gotoPos(ent.position, 3, 60000).catch(() => {})
          await holdBait()
          console.log(`  🐄 près de la vache ${ent.id} : distance ${ent.position.distanceTo(bot.entity.position).toFixed(1)}, en main ${bot.heldItem?.name}`)
          await sleep(1500)
          // on marche vers l'enclos par petites étapes, en attendant que l'animal suive
          let lost = false
          for (let i = 0; i < 80 && !interrupted(); i++) {
            const e = bot.entities[ent.id]
            if (!e) { lost = true; break }
            const here = bot.entity.position
            if (here.distanceTo(outside) < 2.5) break
            await holdBait()
            const d = e.position.distanceTo(here)
            if (i % 5 === 0) console.log(`  🐄 étape ${i} : vache à ${d.toFixed(1)} blocs, moi à ${here.distanceTo(outside).toFixed(1)} de l'enclos, en main ${bot.heldItem?.name}`)
            if (d > 10) { lost = true; console.log(`  🐄 vache perdue (${d.toFixed(1)} blocs)`); break }
            if (d > 4) { await sleep(800); continue }
            const dir = outside.minus(here)
            const target = here.plus(dir.scaled(Math.min(4, dir.norm()) / dir.norm()))
            await goto(new goals.GoalNearXZ(Math.floor(target.x), Math.floor(target.z), 1), 10000).catch(() => {})
          }
          if (lost) continue
          // ouvrir, entrer jusqu'au fond avec l'animal qui suit, attendre qu'il soit bien dedans
          await setGate(true)
          await holdBait()
          await goto(new goals.GoalNearXZ(back.x, back.z, 0), 15000).catch(() => {})
          await holdBait()
          const t0 = Date.now()
          while (bot.entities[ent.id] && !inPen(bot.entities[ent.id].position) && Date.now() - t0 < 20000) await sleep(500)
          await sleep(1000)
          const inside = !!bot.entities[ent.id] && inPen(bot.entities[ent.id].position)
          console.log(`  🐄 dans l'enclos ? ${inside} (vache en ${bot.entities[ent.id] ? fmt(bot.entities[ent.id].position) : 'disparue'})`)
          // elle est dedans : on referme tout de suite derrière elle (depuis l'intérieur)
          if (inside) await setGate(false)
          await cleanPen() // pas de marchepied pour s'échapper
          // prendre autre chose en main (sinon elle nous suit), puis ressortir vite : ouvrir, passer, refermer
          await holdNoBait()
          console.log(`  🐄 en main pour sortir : ${bot.heldItem?.name || 'rien'}`)
          await sleep(2000)
          await exitPen()
          const still = !!bot.entities[ent.id] && inPen(bot.entities[ent.id].position)
          console.log(`  🐄 après ma sortie, toujours dedans ? ${still}`)
          if (still) brought++
        }
      } finally {
        moves.allowSprinting = saved.sprint
        moves.canDig = saved.dig
        moves.allow1by1towers = saved.towers
        moves.scafoldingBlocks = saved.scaf
      }
      const total = Object.values(bot.entities).filter(e => e.name === type && inPen(e.position)).length
      return brought
        ? `${brought} ${type} amené(s) dans l'enclos (${total} au total), portillon refermé.`
        : `Je n'ai amené aucun ${type} : pas d'animal libre trouvé, ou il ne m'a pas suivi. Rapproche-toi d'un troupeau et réessaie.`
    })

  tool('reproduire', 'Faire se reproduire les animaux de ton enclos en leur donnant leur nourriture : 2 adultes du même type et 2 portions (vache, mouton : blé ; cochon : carotte ; poulet : graines). Recommençable toutes les 5 minutes.',
    { animal: S('cow, sheep, pig, chicken') }, ['animal'],
    async ({ animal }) => {
      const type = norm(animal)
      const bait = BAIT[type]
      if (!bait) return `Je ne sais pas faire se reproduire ${animal}.`
      const portions = items().filter(i => bait.test(i.name)).reduce((a, i) => a + i.count, 0)
      if (portions < 2) return `Il me faut au moins 2 portions de ${BAIT_TXT[type]}.`
      const pen = memoire.lieu('enclos')
      const candidates = Object.values(bot.entities).filter(e => e.name === type && (pen ? inPen(e.position) : dist(e.position) < 16))
      if (candidates.length < 2) return `Il faut au moins 2 ${type} ${pen ? 'dans l\'enclos' : 'à côté de moi'} (j'en vois ${candidates.length}).`
      ctx.followName = null
      if (pen && !inPen(bot.entity.position)) await enterPen()
      let fed = 0
      for (const e of candidates.slice(0, Math.min(4, portions))) {
        if (interrupted()) break
        const food = items().find(i => bait.test(i.name))
        if (!food || !bot.entities[e.id]) continue
        await bot.equip(food, 'hand')
        await gotoPos(e.position, 2, 10000).catch(() => {})
        try {
          await bot.lookAt(e.position.offset(0, (e.height || 1) * 0.6, 0))
          await bot.activateEntity(e)
          fed++
        } catch (_) {}
        await sleep(400)
      }
      if (pen) await noBuild(() => cleanPen())
      // tenir autre chose que leur nourriture, sinon elles nous suivent dehors
      const other = items().find(i => /_sword$|_axe$|_pickaxe$/.test(i.name)) || items().find(i => !bait.test(i.name) && !reg.foodsByName?.[i.name])
      if (other) await bot.equip(other, 'hand').catch(() => {})
      else await bot.unequip('hand').catch(() => {})
      await sleep(1500)
      if (pen) await exitPen()
      return fed >= 2 ? `J'ai nourri ${fed} ${type} : des bébés vont arriver ! (on peut recommencer dans 5 min)` : `Je n'ai nourri que ${fed} ${type}, il en faut 2 (peut-être des bébés ou trop loin).`
    })

  // =====================================================================
  // ---------- mine profonde : descendre, galeries ----------
  // =====================================================================
  const ORE_IDS = reg.blocksArray.filter(b => /_ore$|^ancient_debris$/.test(b.name)).map(b => b.id)
  const DIR4 = { nord: [0, -1], sud: [0, 1], est: [1, 0], ouest: [-1, 0] }
  // hauteur de vide sous une case (0 = sol plein juste dessous) ; l'eau compte comme un sol (on y tombe sans se blesser)
  function chuteSous (p) {
    let n = 0
    for (let k = 1; k <= 4; k++) {
      const b = bot.blockAt(p.offset(0, -k, 0))
      if (b && (isAir(b) || b.boundingBox === 'empty') && !/water/.test(b.name)) n++
      else break
    }
    return n
  }

  function liquidNear (p) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const b = bot.blockAt(p.offset(dx, dy, dz))
          if (b && /lava|water/.test(b.name)) return b.name
        }
      }
    }
    return null
  }
  // casse un bloc jusqu'à ce que la case soit vide (le gravier et le sable retombent)
  // casser un bloc avec une limite de temps : sinon, si le serveur ne confirme jamais, il attend pour toujours
  // (vu en vrai : 53 minutes figé au fond de la mine)
  async function creuserBloc (b, forceLook) {
    await equipToolFor(b)
    const ms = Math.min(20000, (bot.digTime?.(b) || 2000) + 4000)
    await withTimeout(bot.dig(b, forceLook), ms, () => { try { bot.stopDigging() } catch (_) {} })
  }
  async function clearCell (p) {
    for (let t = 0; t < 6; t++) {
      const b = bot.blockAt(p)
      if (!b || isAir(b) || b.boundingBox === 'empty') return true
      if (PROTECTED.test(b.name) || b.name === 'bedrock' || !b.diggable) return false
      try { await creuserBloc(b) } catch (_) { return false }
      await sleep(250)
    }
    return true
  }
  async function mineVisibleOres (found) {
    for (const p of bot.findBlocks({ matching: ORE_IDS, maxDistance: 3, count: 12 })) {
      if (interrupted()) return
      const b = bot.blockAt(p)
      if (!b || liquidNear(p) || missingTool(b)) continue
      // hors de portée de bras (4,5 blocs depuis les yeux) : on laisse
      if (bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.5) continue
      try { await creuserBloc(b); found[b.name] = (found[b.name] || 0) + 1 } catch (_) {}
    }
  }
  const oresTxt = (found) => Object.entries(found).map(([k, n]) => `${n} ${k}`).join(', ') || 'aucun'

  tool('descendre', 'Descendre sous terre en creusant un escalier, pour aller chercher des minerais rares (les diamants sont surtout vers y = -58). Je mine les minerais que je croise et je m\'arrête avant la lave ou l\'eau. Il faut une pioche.',
    { y: N('profondeur visée (ex. -58)'), direction: { type: 'string', enum: ['nord', 'sud', 'est', 'ouest'], description: 'sens de l\'escalier (défaut est)' } }, ['y'],
    async ({ y, direction = 'est' }) => {
      if (!hasPickaxe()) return 'Il me faut une pioche pour descendre.'
      const target = Math.max(-59, y | 0)
      const [dx, dz] = DIR4[direction] || DIR4.est
      ctx.followName = null
      bot.pathfinder.setGoal(null)
      if (!memoire.lieu('mine')) memoire.setLieu('mine', bot.entity.position, dim())
      const found = {}
      let steps = 0
      let stop = ''
      while (Math.floor(bot.entity.position.y) > target && steps < 150) {
        if (interrupted()) { stop = 'interrompu'; break }
        if (!hasPickaxe()) { stop = 'ma pioche s\'est cassée'; break }
        await faireDeLaPlace(3, { x: -dx, z: -dz })
        const base = bot.entity.position.floored()
        const step = base.offset(dx, -1, dz)
        const cells = [base.offset(dx, 1, dz), base.offset(dx, 0, dz), step]
        const danger = cells.map(liquidNear).find(Boolean)
        if (danger) { stop = `${danger} juste devant`; break }
        let ok = true
        for (const c of cells) if (!(await clearCell(c))) { ok = false; break }
        if (!ok) { stop = 'bloc impossible à casser devant'; break }
        // il faut un sol sous la marche
        const floor = step.offset(0, -1, 0)
        if (isAir(bot.blockAt(floor))) {
          const m = ['cobblestone', 'cobbled_deepslate', 'dirt'].find(n => countOf(n) > 0)
          if (!m || (await placeAt(m, floor)) !== 'ok') { stop = 'un trou sous la marche'; break }
        }
        await goto(new GoalBlock(step.x, step.y, step.z), 8000).catch(() => {})
        if (!bot.entity.position.floored().equals(step)) { stop = 'je n\'arrive pas à avancer'; break }
        steps++
        await mineVisibleOres(found)
      }
      await pickUpItems(6)
      const yy = Math.floor(bot.entity.position.y)
      return `Descendu de ${steps} marches, je suis à y = ${yy}${stop ? ` (arrêt : ${stop})` : ''}. Minerais pris en route : ${oresTxt(found)}. L'entrée est retenue (« mine »). Ensuite : miner_galerie pour chercher des diamants.${alertePioche(150)}`
    })

  tool('miner_galerie', 'Creuser une longue galerie droite sous terre pour trouver des minerais (diamants vers y = -58) : je mine tous les minerais que je vois en chemin et je m\'arrête avant la lave.',
    { direction: { type: 'string', enum: ['nord', 'sud', 'est', 'ouest'] }, longueur: N('nombre de blocs, 8 à 64 (défaut 32)') }, ['direction'],
    async ({ direction, longueur = 32 }) => {
      if (!hasPickaxe()) return 'Il me faut une pioche.'
      const [dx, dz] = DIR4[direction]
      const n = clamp(longueur, 8, 64)
      ctx.followName = null
      bot.pathfinder.setGoal(null)
      const found = {}
      let dug = 0
      let stop = ''
      for (let i = 0; i < n; i++) {
        if (interrupted()) { stop = 'interrompu'; break }
        if (!hasPickaxe()) { stop = 'ma pioche s\'est cassée'; break }
        await faireDeLaPlace(3, { x: -dx, z: -dz })
        const base = bot.entity.position.floored()
        const next = base.offset(dx, 0, dz)
        const cells = [next, next.offset(0, 1, 0)]
        const danger = cells.map(liquidNear).find(Boolean)
        if (danger) { stop = `${danger} devant`; break }
        let ok = true
        for (const c of cells) if (!(await clearCell(c))) { ok = false; break }
        if (!ok) { stop = 'bloc impossible à casser'; break }
        if (isAir(bot.blockAt(next.offset(0, -1, 0)))) {
          const m = ['cobblestone', 'cobbled_deepslate', 'dirt'].find(k => countOf(k) > 0)
          if (m) await placeAt(m, next.offset(0, -1, 0))
        }
        // toujours du vide sous la case suivante (pas de bloc pour faire un pont) : on ne saute pas dedans
        if (chuteSous(next) >= 3) { stop = 'vide devant (grotte ou ravin)'; break }
        await goto(new GoalBlock(next.x, next.y, next.z), 8000).catch(() => {})
        if (!bot.entity.position.floored().equals(next)) { stop = 'je n\'arrive pas à avancer'; break }
        dug++
        await mineVisibleOres(found)
        if (i % 10 === 9) await pickUpItems(5)
      }
      await pickUpItems(6)
      return `Galerie de ${dug} blocs vers ${direction} (y = ${Math.floor(bot.entity.position.y)})${stop ? `, arrêt : ${stop}` : ''}. Minerais : ${oresTxt(found)}.${alertePioche(100)}`
    })

  // =====================================================================
  // ---------- enchantement ----------
  // =====================================================================
  tool('enchanter', 'Enchanter un objet (épée, pioche, armure...) sur une table d\'enchantement proche. Il faut du lapis-lazuli et des niveaux d\'expérience. Je prends le meilleur enchantement possible avec mes niveaux.',
    { objet: S('objet à enchanter, ex. diamond_sword') }, ['objet'],
    async ({ objet }) => {
      const item = findItem(objet)
      if (!item) return `Je n'ai pas de ${objet}.`
      const lapis = findItem('lapis_lazuli')
      if (!lapis) return 'Il me faut du lapis-lazuli (minerai lapis_ore).'
      const tb = bot.findBlock({ matching: reg.blocksByName.enchanting_table.id, maxDistance: 24 })
      if (!tb) return 'Pas de table d\'enchantement à côté. Elle se fabrique avec 4 obsidiennes, 2 diamants et 1 livre.'
      if (bot.experience.level < 1) return 'Je n\'ai aucun niveau d\'expérience : il faut tuer des monstres ou miner du charbon et d\'autres minerais.'
      await gotoPos(tb.position, 2, 90000)
      const table = await bot.openEnchantmentTable(tb)
      try {
        await table.putTargetItem(item)
        await table.putLapis(lapis)
        await withTimeout(new Promise(r => table.once('ready', r)), 5000).catch(() => {})
        const lvl = bot.experience.level
        let choice = -1
        table.enchantments.forEach((e, i) => { if (e.level > 0 && e.level <= lvl) choice = i })
        if (choice < 0) {
          await table.takeTargetItem().catch(() => {})
          return `Pas assez de niveaux (j'en ai ${lvl}). Gagne de l'expérience puis reviens.`
        }
        await withTimeout(table.enchant(choice), 8000)
        await table.takeTargetItem().catch(() => {})
        return `${item.name} enchanté (choix ${choice + 1}, ${table.enchantments[choice].level} niveaux) !`
      } finally {
        table.close()
      }
    })

  // =====================================================================
  // ---------- voyages lointains ----------
  // =====================================================================
  const dimShort = () => String(dim()).replace('minecraft:', '').replace('the_', '')

  tool('voyager', 'Partir loin vers des coordonnées précises (village repéré, forteresse, position calculée avec les yeux de l\'Ender...). Peut prendre plusieurs minutes. Astuce : 1 bloc dans le Nether = 8 blocs dans le monde normal.',
    { x: N('x'), z: N('z'), y: N('y (optionnel)') }, ['x', 'z'],
    async ({ x, z, y }) => {
      ctx.followName = null
      const d = Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z)
      const ms = Math.min(20 * 60000, d * 1500 + 30000)
      try {
        await travelTo(x, z, y, { maxMs: ms })
      } catch (e) {
        const reste = Math.round(Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z))
        return `Voyage interrompu (${e.message}) en ${fmt(bot.entity.position)}, encore ${reste} blocs. Relance voyager pour continuer. ${scan(32)}`
      }
      return `Arrivé en ${fmt(bot.entity.position)}. ${scan(32)}`
    })

  // =====================================================================
  // ---------- seau d'eau, obsidienne ----------
  // =====================================================================
  const isSource = (b) => !!b && (b.getProperties?.().level === 0 || b.getProperties?.().level === '0')
  async function useItemAt (pos) { // regarder un point et utiliser l'objet en main (seau...)
    await bot.lookAt(pos, true)
    bot.activateItem()
    await sleep(400)
    bot.deactivateItem()
    await sleep(300)
  }
  async function fillWaterBucket () {
    if (findItem('water_bucket')) return true
    if (!findItem('bucket')) return false
    const water = bot.findBlocks({ matching: reg.blocksByName.water.id, maxDistance: 32, count: 60 })
      .map(p => bot.blockAt(p)).find(b => isSource(b) && isAir(bot.blockAt(b.position.offset(0, 1, 0))))
    if (!water) return false
    await gotoPos(water.position, 3, 30000).catch(() => {})
    await bot.equip(findItem('bucket'), 'hand')
    await useItemAt(water.position.offset(0.5, 0.9, 0.5))
    return !!findItem('water_bucket')
  }

  tool('remplir_seau', 'Remplir un seau vide avec de l\'eau proche (pour faire de l\'obsidienne, éteindre du feu, descendre une falaise...).', {}, [],
    async () => (await fillWaterBucket()) ? 'Seau d\'eau prêt.' : 'Impossible : il me faut un seau vide (3 lingots de fer) et de l\'eau immobile à moins de 32 blocs.')

  tool('faire_obsidienne', 'Fabriquer de l\'obsidienne : je verse un seau d\'eau sur une mare de lave immobile, la lave devient de l\'obsidienne, je reprends l\'eau puis je mine l\'obsidienne. Il faut une pioche en diamant et un seau d\'eau.',
    { quantite: N('nombre d\'obsidiennes voulues (défaut 10)') }, [],
    async ({ quantite = 10 }) => {
      if (!items().some(i => /^(diamond|netherite)_pickaxe$/.test(i.name))) return 'Il me faut une pioche en diamant : l\'obsidienne ne se mine qu\'avec ça.'
      if (!findItem('water_bucket') && !(await fillWaterBucket())) return 'Il me faut un seau d\'eau : un seau (3 lingots de fer) et de l\'eau pas loin.'
      const target = clamp(quantite, 1, 20)
      const start = countOf('obsidian')
      ctx.followName = null
      for (let tries = 0; tries < 8 && countOf('obsidian') - start < target && !interrupted(); tries++) {
        // une lave immobile avec un bord solide à côté (et de l'air au-dessus du bord)
        let spot = null
        const lavas = bot.findBlocks({ matching: reg.blocksByName.lava.id, maxDistance: 48, count: 300 }).map(p => bot.blockAt(p)).filter(isSource)
        for (const l of lavas) {
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const rim = bot.blockAt(l.position.offset(dx, 0, dz))
            const above = bot.blockAt(l.position.offset(dx, 1, dz))
            if (rim && rim.boundingBox === 'block' && !/lava|water/.test(rim.name) && isAir(above)) { spot = { rim, above }; break }
          }
          if (spot) break
        }
        if (!spot) {
          if (countOf('obsidian') === start) return 'Pas de lave immobile accessible à moins de 48 blocs. Cherche une mare de lave (en surface, ou sous terre vers y = -55), ou un portail en ruine.'
          break
        }
        await gotoPos(spot.above.position, 3, 30000).catch(() => {})
        if (!findItem('water_bucket') && !(await fillWaterBucket())) break
        await bot.equip(findItem('water_bucket'), 'hand')
        await useItemAt(spot.rim.position.offset(0.5, 1, 0.5)) // l'eau coule du bord sur la lave
        await sleep(2500)
        // reprendre l'eau
        const w = bot.blockAt(spot.above.position)
        if (w && /water/.test(w.name) && findItem('bucket')) {
          await bot.equip(findItem('bucket'), 'hand')
          await useItemAt(spot.above.position.offset(0.5, 0.5, 0.5))
        }
        // miner l'obsidienne formée (pas celle qui est au-dessus de la lave ou du vide : elle tomberait)
        const obs = bot.findBlocks({ matching: reg.blocksByName.obsidian.id, maxDistance: 7, count: 30 }).map(p => bot.blockAt(p))
        for (const o of obs) {
          if (countOf('obsidian') - start >= target || interrupted()) break
          const below = bot.blockAt(o.position.offset(0, -1, 0))
          if (!below || below.boundingBox !== 'block') continue
          await gotoPos(o.position, 3, 20000).catch(() => {})
          await equipToolFor(o)
          try { await creuserBloc(o) } catch (_) {}
          await sleep(300)
          await pickUpItems(4)
        }
      }
      const got = countOf('obsidian') - start
      return got
        ? `+${got} obsidienne(s), j'en ai ${countOf('obsidian')} en tout.${findItem('water_bucket') || findItem('bucket') ? '' : ' (j\'ai perdu le seau)'}`
        : 'Je n\'ai pas réussi à obtenir d\'obsidienne (l\'eau n\'a pas atteint la lave, ou c\'était trop risqué à miner).'
    })

  // =====================================================================
  // ---------- portails (Nether, End) ----------
  // =====================================================================
  tool('construire_portail', 'Construire un portail du Nether devant moi : cadre de 10 obsidiennes (4 blocs quelconques aux coins), puis je l\'allume avec un briquet (flint_and_steel : 1 lingot de fer + 1 silex, le silex vient du gravier).',
    { x: N('coin bas-gauche x (optionnel)'), y: N('niveau du sol (optionnel)'), z: N('z (optionnel)') }, [],
    async ({ x, y, z }) => {
      if (countOf('obsidian') < 10) return `Il me faut 10 obsidiennes (j'en ai ${countOf('obsidian')}). Fais-en avec faire_obsidienne (pioche en diamant + seau d'eau).`
      if (!findItem('flint_and_steel')) return 'Il me faut un briquet (flint_and_steel : 1 lingot de fer + 1 silex ; le silex tombe parfois en cassant du gravier).'
      const filler = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone'].find(n => countOf(n) >= 4) || (countOf('obsidian') >= 14 ? 'obsidian' : null)
      if (!filler) return 'Il me faut 4 blocs (cobblestone, terre...) pour les coins du cadre.'
      const me = bot.entity.position.floored()
      const x0 = x ?? me.x + 2
      const z0 = z ?? me.z
      // hauteur : sur le vrai sol à cet endroit (pas la hauteur du bot, qui peut être dans un trou)
      const sol = surface(x0 + 1, z0, me.y)
      const y0 = y ?? (sol && !sol.liquid ? sol.y + 1 : me.y)
      const frame = []
      const inner = []
      for (let dx = 0; dx < 4; dx++) {
        for (let dy = 0; dy < 5; dy++) {
          const p = new Vec3(x0 + dx, y0 + dy, z0)
          const ex = dx === 0 || dx === 3
          const ey = dy === 0 || dy === 4
          if (ex && ey) frame.push({ p, mat: filler })
          else if (ex || ey) frame.push({ p, mat: 'obsidian' })
          else inner.push(p)
        }
      }
      ctx.followName = null
      // dégager la place (jamais une construction)
      for (const p of [...inner, ...frame.map(f => f.p)]) {
        const b = bot.blockAt(p)
        if (!b || isAir(b) || b.name === 'obsidian') continue
        if (PROTECTED.test(b.name)) return `Il y a une construction (${b.name}) en ${fmt(p)} : choisis un autre endroit.`
        await gotoPos(p, 4, 15000).catch(() => {})
        await clearCell(p)
      }
      frame.sort((a, b) => a.p.y - b.p.y)
      // pendant la pose, le pathfinder ne doit poser aucun bloc (il en mettait dans l'intérieur du cadre)
      const r = await noBuild(() => placeAll(frame))
      const manquants = frame.filter(f => f.mat === 'obsidian' && bot.blockAt(f.p)?.name !== 'obsidian')
      if (manquants.length) return `Cadre incomplet : ${manquants.length} obsidiennes pas posées (${bilan2(r)}).`
      // l'intérieur doit être complètement vide pour que le portail s'allume
      for (const p of inner) {
        const b = bot.blockAt(p)
        if (b && !isAir(b)) { await gotoPos(p, 4, 15000).catch(() => {}); await clearCell(p) }
      }
      // allumer : briquet sur le dessus d'une obsidienne du bas (on essaie les deux)
      let lit = null
      for (const bx of [x0 + 1, x0 + 2]) {
        const bottom = bot.blockAt(new Vec3(bx, y0, z0))
        await noBuild(() => gotoPos(bottom.position, 3, 15000).catch(() => {}))
        await bot.equip(findItem('flint_and_steel'), 'hand')
        await bot.lookAt(bottom.position.offset(0.5, 1, 0.5), true)
        try { await bot.activateBlock(bottom, new Vec3(0, 1, 0)) } catch (_) {}
        await sleep(1000)
        lit = bot.blockAt(new Vec3(x0 + 1, y0 + 1, z0))
        if (lit && lit.name === 'nether_portal') break
      }
      if (!lit || lit.name !== 'nether_portal') {
        const dedans = inner.map(p => bot.blockAt(p)?.name).filter(n => n && n !== 'air').join(', ')
        return `Cadre construit en ${x0} ${y0} ${z0}, mais il ne s'est pas allumé${dedans ? ` (il reste dedans : ${dedans})` : ''}. Réessaie avec utiliser_bloc sur ${x0 + 1} ${y0} ${z0} en tenant le briquet.`
      }
      memoire.setLieu(`portail_${dimShort()}`, new Vec3(x0 + 1, y0 + 1, z0), dim())
      return `Portail du Nether allumé en ${x0 + 1} ${y0 + 1} ${z0} ! Retenu comme « portail_${dimShort()} ». Passe dedans avec utiliser_portail.`
    })

  tool('utiliser_portail', 'Passer dans le portail allumé le plus proche (Nether ou End) pour changer de dimension. Je retiens l\'endroit d\'arrivée pour pouvoir revenir.', {}, [],
    async () => {
      const ids = ['nether_portal', 'end_portal'].map(n => reg.blocksByName[n]?.id).filter(Boolean)
      const portal = bot.findBlock({ matching: ids, maxDistance: 48 })
      if (!portal) return 'Aucun portail allumé à moins de 48 blocs.'
      const before = dim()
      ctx.followName = null
      // si on vient d'arriver par ce portail, il faut d'abord en sortir pour pouvoir repartir
      if (bot.entity.position.distanceTo(portal.position.offset(0.5, 0, 0.5)) < 2.5) {
        await goto(new goals.GoalInvert(new GoalNear(portal.position.x, portal.position.y, portal.position.z, 3)), 8000).catch(() => {})
        await sleep(1500)
      }
      await goto(new GoalBlock(portal.position.x, portal.position.y, portal.position.z), 60000).catch(() => {})
      bot.clearControlStates()
      // plan B (portail de l'End surtout) : le pathfinder n'ose pas "marcher dans" le portail.
      // je m'approche du bord puis j'avance tout droit dedans
      await sleep(2500)
      if (dim() === before) {
        await goto(new GoalNear(portal.position.x, portal.position.y + 1, portal.position.z, 2), 30000).catch(() => {})
        const centre = portal.position.offset(0.5, 0.5, 0.5)
        await bot.lookAt(centre, true)
        bot.setControlState('forward', true)
        bot.setControlState('jump', true)
        const t1 = Date.now()
        while (dim() === before && Date.now() - t1 < 3000) { await bot.lookAt(centre, true); await sleep(100) }
        bot.clearControlStates()
      }
      const t0 = Date.now()
      while (dim() === before && Date.now() - t0 < 25000) await sleep(500)
      if (dim() === before) return 'Je suis au portail mais rien ne se passe : il faut rester dedans quelques secondes, ou il n\'est pas complet.'
      await sleep(3000) // le temps que le monde se charge
      memoire.setLieu(`portail_${dimShort()}`, bot.entity.position, dim())
      return `Me voilà dans ${dim()} ! Arrivée en ${fmt(bot.entity.position)}, retenue comme « portail_${dimShort()} ». ${scan(24)}`
    })

  // =====================================================================
  // ---------- échanges : villageois, piglins ----------
  // =====================================================================
  // un objet d'échange en texte (« 26 potato ») ; tolérant aux formats de 26.1
  const itemTxt = (it, count) => {
    if (!it) return null
    const name = it.name || reg.items[it.type]?.name || reg.items[it.itemId]?.name
    const c = count ?? it.count ?? it.itemCount
    return name && c ? `${c} ${name}` : null
  }

  tool('commercer', 'Échanger avec le villageois le plus proche. action « voir » : liste ses offres (émeraudes contre objets, objets contre émeraudes) ; action « echanger » : fait l\'offre numéro N (autant de fois que demandé).',
    { action: { type: 'string', enum: ['voir', 'echanger'] }, numero: N('numéro de l\'offre (pour echanger)'), fois: N('combien de fois (défaut 1)') }, ['action'],
    async ({ action, numero, fois = 1 }) => {
      // les villageois sans métier (ou qui bougent) n'ouvrent pas leur fenêtre : on essaie les plus proches un par un
      const candidats = Object.values(bot.entities).filter(e => e.name === 'villager' && dist(e.position) < 32)
        .sort((a, b) => dist(a.position) - dist(b.position)).slice(0, 5)
      if (!candidats.length) return 'Aucun villageois à moins de 32 blocs.'
      ctx.followName = null
      let vil = null
      for (const c of candidats) {
        const v = bot.entities[c.id]
        if (!v) continue
        await gotoPos(v.position, 2, 20000).catch(() => {})
        try { vil = await withTimeout(bot.openVillager(bot.entities[v.id] || v), 6000) } catch (_) { vil = null }
        if (vil) break
      }
      if (!vil) return 'Aucun villageois ne veut commercer ici (il leur faut un métier : un bloc de travail comme un composteur, un lutrin, un haut fourneau...).'
      try {
        const trades = vil.trades || []
        if (trades[0]) console.log('  🧾 offre brute :', JSON.stringify(trades[0], (k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 600))
        if (!trades.length) return 'Ce villageois n\'a rien à échanger (il n\'a pas de métier : il lui faut un bloc de travail).'
        const list = trades.map((t, i) => {
          const prix = [itemTxt(t.inputItem1, t.realPrice ?? t.inputItem1?.count), t.hasItem2 ? itemTxt(t.inputItem2) : null].filter(Boolean).join(' + ')
          const epuise = t.tradeDisabled || t.nbTradeUses >= t.maximumNbTradeUses ? ' (épuisé)' : ''
          return `${i + 1}) ${prix} → ${itemTxt(t.outputItem)}${epuise}`
        }).join(' ; ')
        if (action === 'voir') return `Offres de ce villageois : ${list}`
        const idx = (numero | 0) - 1
        const t = trades[idx]
        if (!t) return `Pas d'offre n°${numero}. Offres : ${list}`
        const reste = t.maximumNbTradeUses - t.nbTradeUses
        if (t.tradeDisabled || reste <= 0) return 'Cette offre est épuisée pour l\'instant (elle revient plus tard).'
        const n = Math.max(1, Math.min(fois | 0, reste))
        const prix1 = t.realPrice ?? t.inputItem1.count
        if (countOf(t.inputItem1.name) < prix1 * n) return `Il me faut ${prix1 * n} ${t.inputItem1.name} (j'en ai ${countOf(t.inputItem1.name)}).`
        if (t.hasItem2 && countOf(t.inputItem2.name) < t.inputItem2.count * n) return `Il me faut aussi ${t.inputItem2.count * n} ${t.inputItem2.name}.`
        await withTimeout(bot.trade(vil, idx, n), 15000)
        return `Échange fait ${n} fois : reçu ${itemTxt(t.outputItem)} à chaque fois.`
      } finally {
        vil.close()
      }
    })

  tool('troquer_piglins', 'Dans le Nether : jeter des lingots d\'or à un piglin pour qu\'il donne un objet en échange (perles de l\'Ender, silex, cuir, obsidienne...). Porte une pièce d\'armure en or, sinon ils t\'attaquent.',
    { lingots: N('nombre de lingots d\'or à donner (défaut 4)') }, [],
    async ({ lingots = 4 }) => {
      if (!countOf('gold_ingot')) return 'Il me faut des lingots d\'or (minerai d\'or ou nether_gold_ore, à cuire).'
      const first = bot.nearestEntity(e => e.name === 'piglin' && dist(e.position) < 32)
      if (!first) return 'Aucun piglin à moins de 32 blocs.'
      // enfiler une pièce d'armure en or si j'en ai une (sinon les piglins attaquent)
      if (!armorNames().some(n => n.startsWith('golden_'))) {
        const g = items().find(i => /^golden_(helmet|chestplate|leggings|boots)$/.test(i.name))
        if (g) await bot.equip(g, ARMOR_SLOT[g.name.split('_')[1]]).catch(() => {})
      }
      const armure = armorNames().some(n => n.startsWith('golden_'))
      const n = Math.min(clamp(lingots, 1, 16), countOf('gold_ingot'))
      const before = invCounts()
      ctx.followName = null
      for (let i = 0; i < n && !interrupted(); i++) {
        const pig = bot.entities[first.id] || bot.nearestEntity(e => e.name === 'piglin' && dist(e.position) < 32)
        if (!pig) break
        await gotoPos(pig.position, 2, 15000).catch(() => {})
        await bot.lookAt(pig.position.offset(0, 1, 0), true)
        await bot.toss(reg.itemsByName.gold_ingot.id, null, 1)
        await sleep(7000) // il examine l'or environ 6 secondes
        await pickUpItems(8)
      }
      const after = invCounts()
      const gains = Object.entries(after).map(([k, v]) => [k, v - (before[k] || 0)]).filter(([k, d]) => d > 0 && k !== 'gold_ingot').map(([k, d]) => `${d} ${k}`).join(', ')
      return `${n} lingot(s) d'or donné(s). Reçu : ${gains || 'rien de ramassé (regarde autour)'}.${armure ? '' : ' Attention : sans armure en or, les piglins deviennent agressifs.'}`
    })

  // =====================================================================
  // ---------- yeux de l'Ender, portail de l'End ----------
  // =====================================================================
  const eyeThrows = []
  tool('lancer_oeil', 'Lancer un œil de l\'Ender pour voir dans quelle direction est la forteresse de l\'End. Après 2 lancers faits à au moins 100 blocs l\'un de l\'autre (sur le côté), je calcule sa position.', {}, [],
    async () => {
      if (!findItem('ender_eye')) return 'Il me faut des yeux de l\'Ender (fabriquer ender_eye : 1 poudre de blaze + 1 perle de l\'Ender).'
      if (!/overworld/.test(dim())) return 'Les yeux de l\'Ender ne fonctionnent que dans le monde normal.'
      await bot.equip(findItem('ender_eye'), 'hand')
      const from = bot.entity.position.clone()
      await bot.look(bot.entity.yaw, 0.3, true)
      const known = new Set(Object.keys(bot.entities))
      bot.activateItem()
      let ent = null
      const t0 = Date.now()
      while (!ent && Date.now() - t0 < 3000) {
        await sleep(100)
        ent = Object.values(bot.entities).find(e => !known.has(String(e.id)) && /eye_of_ender/.test(e.name || ''))
      }
      if (!ent) return 'Je n\'ai pas vu l\'œil partir : lance-le à ciel ouvert.'
      const p1 = ent.position.clone()
      await sleep(1500)
      const p2 = (bot.entities[ent.id] || ent).position.clone()
      const dx = p2.x - p1.x
      const dz = p2.z - p1.z
      const len = Math.hypot(dx, dz) || 1
      const ux = dx / len
      const uz = dz / len
      eyeThrows.push({ x: from.x, z: from.z, ux, uz })
      const card = Math.abs(ux) > Math.abs(uz) ? (ux > 0 ? 'l\'est' : 'l\'ouest') : (uz > 0 ? 'le sud' : 'le nord')
      let pos = ''
      if (eyeThrows.length >= 2) {
        const a = eyeThrows[eyeThrows.length - 2]
        const b = eyeThrows[eyeThrows.length - 1]
        const cross = a.ux * b.uz - a.uz * b.ux
        if (Math.abs(cross) > 0.05) {
          const t = ((b.x - a.x) * b.uz - (b.z - a.z) * b.ux) / cross
          const X = Math.round(a.x + t * a.ux)
          const Z = Math.round(a.z + t * a.uz)
          pos = ` Avec le lancer d'avant, la forteresse est vers x ≈ ${X}, z ≈ ${Z} (à ${Math.round(Math.hypot(X - from.x, Z - from.z))} blocs) : voyager là-bas, puis descendre pour la trouver.`
          memoire.setLieu('forteresse_estimee', new Vec3(X, 30, Z), dim())
        } else {
          pos = ' Les deux lancers sont presque dans la même direction : déplace-toi plus sur le côté avant de relancer.'
        }
      }
      await sleep(2500)
      await pickUpItems(16) // l'œil retombe parfois
      return `L'œil part vers ${card} (direction x ${ux.toFixed(2)}, z ${uz.toFixed(2)}) depuis ${fmt(from)}.${pos || ' Avance d\'au moins 100 blocs sur le côté puis relance pour calculer sa position.'}`
    })

  tool('remplir_portail_end', 'Dans la forteresse de l\'End : poser des yeux de l\'Ender dans les cadres du portail (end_portal_frame) pour l\'ouvrir (12 cadres au total, certains ont déjà un œil).', {}, [],
    async () => {
      const frames = bot.findBlocks({ matching: reg.blocksByName.end_portal_frame.id, maxDistance: 24, count: 12 }).map(p => bot.blockAt(p))
      if (!frames.length) return 'Pas de cadre de portail de l\'End ici : il est dans une salle de la forteresse (cherche des end_portal_frame).'
      const hasEye = (f) => { const e = f.getProperties().eye; return e === true || e === 'true' }
      const empty = frames.filter(f => !hasEye(f))
      if (!empty.length) return 'Tous les cadres ont déjà un œil : le portail devrait être ouvert.'
      if (empty.length > countOf('ender_eye')) return `Il manque ${empty.length - countOf('ender_eye')} yeux (cadres vides : ${empty.length}, yeux : ${countOf('ender_eye')}).`
      ctx.followName = null
      let filled = 0
      for (const f of empty) {
        if (interrupted()) break
        await gotoPos(f.position, 3, 20000).catch(() => {})
        await bot.equip(findItem('ender_eye'), 'hand')
        try { await bot.activateBlock(f, new Vec3(0, 1, 0)); filled++ } catch (_) {}
        await sleep(400)
      }
      await sleep(1000)
      const open = bot.findBlock({ matching: reg.blocksByName.end_portal.id, maxDistance: 24 })
      return open
        ? `Portail de l'End ouvert (${filled} yeux posés) ! Prépare-toi (armure, épée, arc et beaucoup de flèches, nourriture, blocs), puis utiliser_portail.`
        : `${filled} yeux posés, mais le portail n'est pas encore ouvert.`
    })

  // =====================================================================
  // ---------- pont (au-dessus du vide ou de l'eau) ----------
  // =====================================================================
  const PONT_BLOCS = /^(cobblestone|cobbled_deepslate|dirt|netherrack|end_stone|stone|deepslate|.*_planks)$/
  tool('pont', 'Construire un pont droit au-dessus du vide ou de l\'eau jusqu\'à des coordonnées (ex. dans l\'End, de la plateforme d\'obsidienne jusqu\'à l\'île). Je marche accroupi pour ne pas tomber et je pose des blocs (cobblestone, terre, netherrack, end_stone, planches...). Si un bloc me barre la route, je le casse.',
    { x: N('x visé'), z: N('z visé'), longueur: N('nombre de blocs max (défaut 64)') }, ['x', 'z'],
    async ({ x, z, longueur = 64 }) => {
      const n = clamp(longueur, 4, 128)
      ctx.followName = null
      bot.pathfinder.setGoal(null)
      let placed = 0
      let walked = 0
      bot.setControlState('sneak', true)
      try {
        for (let i = 0; i < n && !interrupted(); i++) {
          const here = bot.entity.position
          const dx = x - here.x
          const dz = z - here.z
          if (Math.hypot(dx, dz) < 1.5) break
          // un pas dans la direction principale
          const step = Math.abs(dx) > Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
          const feet = here.floored()
          const next = feet.plus(step)
          const under = next.offset(0, -1, 0)
          // un bloc devant (pieds ou tête) : on le casse
          for (const c of [next, next.offset(0, 1, 0)]) {
            const b = bot.blockAt(c)
            if (b && !isAir(b) && b.boundingBox === 'block') {
              if (PROTECTED.test(b.name)) return `Il y a une construction (${b.name}) sur le chemin, j'arrête (pont de ${placed} blocs).`
              await clearCell(c)
            }
          }
          // pas de sol devant : on pose un bloc contre celui sous nos pieds
          const ub = bot.blockAt(under)
          if (!ub || ub.boundingBox !== 'block') {
            const mat = items().find(it => PONT_BLOCS.test(it.name))
            if (!mat) return `Plus de blocs pour le pont : ${placed} blocs posés, je suis en ${fmt(bot.entity.position)}.`
            const ref = bot.blockAt(feet.offset(0, -1, 0))
            if (!ref || ref.boundingBox !== 'block') return `Je ne suis pas sur un bloc solide, impossible de continuer le pont (${placed} blocs).`
            await bot.equip(mat, 'hand')
            await bot.lookAt(under.offset(0.5, 0.5, 0.5), true)
            try { await bot.placeBlock(ref, step) } catch (_) {}
            if (bot.blockAt(under)?.boundingBox !== 'block') return `Je n'arrive pas à poser le bloc suivant (pont de ${placed} blocs, je suis en ${fmt(bot.entity.position)}).`
            placed++
          }
          // avancer d'un bloc, accroupi
          await bot.lookAt(next.offset(0.5, 1.6, 0.5), true)
          bot.setControlState('forward', true)
          const t0 = Date.now()
          while (Date.now() - t0 < 2500 && !bot.entity.position.floored().equals(next)) await sleep(50)
          bot.setControlState('forward', false)
          if (!bot.entity.position.floored().equals(next)) return `Je n'avance plus (pont de ${placed} blocs), je suis en ${fmt(bot.entity.position)}.`
          walked++
        }
      } finally {
        bot.clearControlStates()
      }
      return `Pont terminé : ${placed} blocs posés sur ${walked} pas. Je suis en ${fmt(bot.entity.position)}.`
    })

  tool('abri_express', 'Abri d\'urgence quand la nuit tombe sans armure, ou quand des monstres te harcèlent et que ta maison est loin : je creuse 2 blocs sous moi et je rebouche au-dessus de ma tête. Pour ressortir : « remonter ».', {}, [],
    async () => { ctx.followName = null; return abriExpress() })

  tool('remonter', 'Remonter à la surface quand tu es sous terre (tunnel, grotte, sous l\'île de l\'End, abri d\'urgence) : je creuse un escalier vers le haut jusqu\'à l\'air libre.',
    { forcer: { type: 'boolean', description: 'sortir de l\'abri même la nuit (seulement si un joueur te le demande)' } }, [],
    async ({ forcer = false } = {}) => {
      if (ctx.enAbri && !forcer && nuitDehors() && armorNames().length < 4) {
        return 'Il fait encore nuit et ton armure n\'est pas complète : reste dans ton abri jusqu\'au matin (tu seras prévenu au lever du jour). Mange si besoin.'
      }
      // sortir de l'abri d'urgence : casser le toit moi-même (s'il est en cobblestone, le pathfinder n'y touche pas)
      if (ctx.enAbri) {
        const toit = bot.blockAt(ctx.enAbri)
        if (toit && !isAir(toit)) { await equipToolFor(toit); await creuserBloc(toit).catch(() => {}) }
        ctx.enAbri = null
      }
      const p = bot.entity.position.floored()
      // hauteur où l'on se tient à la surface d'une colonne : au-dessus de la roche, le premier
      // endroit avec 4 blocs d'air d'affilée (pas le sommet d'un pilier ou d'un arbre).
      // null = colonne impossible (bedrock, obsidienne : incassable ou trop long à creuser)
      const surfaceAt = (x, z) => {
        let top = null
        let air = 0
        for (let y = p.y + 2; y < p.y + 40; y++) {
          const b = bot.blockAt(new Vec3(x, y, z))
          if (!b) return null
          if (!isAir(b)) {
            if (/bedrock|obsidian|barrier|lava|water/.test(b.name)) return null
            top = y
            air = 0
          } else if (top !== null && ++air >= 4) return top + 1
        }
        return top === null ? 'libre' : null
      }
      if (surfaceAt(p.x, p.z) === 'libre') return `Je suis déjà à l'air libre (en ${fmt(bot.entity.position)}).`
      // la colonne la plus facile autour de moi (peu de hauteur à creuser, pas trop loin)
      let best = null
      for (let dx = -8; dx <= 8; dx++) {
        for (let dz = -8; dz <= 8; dz++) {
          const s = surfaceAt(p.x + dx, p.z + dz)
          if (typeof s !== 'number') continue
          const cost = (s - p.y) + Math.hypot(dx, dz)
          if (!best || cost < best.cost) best = { x: p.x + dx, y: s, z: p.z + dz, cost }
        }
      }
      if (!best) return `Je ne trouve pas de passage vers la surface ici (bedrock ou obsidienne au-dessus). Avance de quelques blocs et réessaie. Je suis en ${fmt(bot.entity.position)}.`
      ctx.followName = null
      try {
        await goto(new goals.GoalNear(best.x, best.y, best.z, 1), 120000)
      } catch (e) {
        return `Je n'arrive pas à remonter (${e.message}), je suis en ${fmt(bot.entity.position)}.`
      }
      return `Remonté à la surface en ${fmt(bot.entity.position)}. ${scan(24)}`
    })

  // =====================================================================
  // ---------- arc ----------
  // =====================================================================
  // calcule l'angle de tir (la flèche ralentit et retombe). haut = tir en cloche au lieu du tir tendu
  function aimPitch (horiz, dy, haut = false) {
    let best = null
    for (let i = 0; i <= 660; i++) {
      const deg = haut ? 85 - i * 0.25 : -80 + i * 0.25
      const a = deg * Math.PI / 180
      let vh = 3 * Math.cos(a)
      let vy = 3 * Math.sin(a)
      let px = 0
      let py = 0
      for (let t = 0; t < 200; t++) {
        px += vh
        py += vy
        vh *= 0.99
        vy = vy * 0.99 - 0.05
        if (px >= horiz) {
          const err = Math.abs(py - dy)
          if (!best || err < best.err) best = { a, err, t }
          break
        }
        if (py < dy - 40) break
      }
      if (best && best.err < 0.3) break // le premier tir qui touche (le plus tendu, ou le plus en cloche)
    }
    return best && best.err < 2 ? best : null
  }

  // La flèche suit une courbe : on vérifie chaque bout de sa trajectoire, pas une ligne droite.
  // Barreaux, vitres, clôtures comptent comme des murs pleins (sur 26.1 mineflayer voit mal leur forme).
  function trajetBloque (eye, ent, target, a) {
    const hx = target.x - eye.x
    const hz = target.z - eye.z
    const H = Math.hypot(hx, hz) || 0.001
    const ux = hx / H
    const uz = hz / H
    const half = (ent.width || 1) / 2 + 0.2
    const h = ent.height || 1
    const dansCible = (p) => Math.abs(p.x - ent.position.x) < half && Math.abs(p.z - ent.position.z) < half &&
      p.y > ent.position.y - 0.2 && p.y < ent.position.y + h + 0.2
    let vh = 3 * Math.cos(a)
    let vy = 3 * Math.sin(a)
    let px = 0
    let py = 0
    for (let t = 0; t < 200; t++) {
      for (let s = 1; s <= 8; s++) {
        const qx = px + vh * s / 8
        const p = new Vec3(eye.x + ux * qx, eye.y + py + vy * s / 8, eye.z + uz * qx)
        if (dansCible(p) || qx > H + half) return null
        const b = bot.blockAt(p)
        if (b && !isAir(b) && (b.boundingBox === 'block' || /iron_bars|glass_pane|fence|chain|_wall$/.test(b.name))) return b
      }
      px += vh
      py += vy
      vh *= 0.99
      vy = vy * 0.99 - 0.05
    }
    return null
  }

  // depuis l'œil "eye", peut-on toucher "ent" ? essaie le tir tendu puis le tir en cloche
  function planTir (eye, ent) {
    const target = ent.position.offset(0, (ent.height || 1) * 0.5, 0)
    const H = Math.hypot(target.x - eye.x, target.z - eye.z)
    let mur = null
    for (const haut of [false, true]) {
      const sol = aimPitch(H, target.y - eye.y, haut)
      if (!sol) continue
      const b = trajetBloque(eye, ent, target, sol.a)
      if (!b) return { sol, target }
      mur = mur || b
    }
    return mur ? { mur } : { loin: true }
  }

  tool('tirer', 'Tirer à l\'arc sur une cible à distance (end_crystal, ender_dragon, blaze, ghast, skeleton...). Il faut un arc et des flèches. Pour les cristaux de l\'End, je me place tout seul là d\'où on les voit.',
    { cible: S('type de cible, ex. end_crystal'), fois: N('nombre de flèches max (défaut 5)') }, ['cible'],
    async ({ cible, fois = 5 }) => {
      if (!findItem('bow')) return 'Il me faut un arc (3 bâtons + 3 ficelles).'
      if (!items().some(i => /arrow$/.test(i.name))) return 'Il me faut des flèches (silex + bâton + plume).'
      const name = norm(cible)
      const n = clamp(fois, 1, 20)
      ctx.followName = null
      const rates = ctx.tirsRates || (ctx.tirsRates = {}) // flèches tirées sans effet sur chaque cible immobile
      const oeil = () => bot.entity.position.offset(0, 1.62, 0)
      // parmi toutes les cibles de ce type, la plus proche qu'on peut vraiment toucher
      const choisir = () => {
        const all = Object.values(bot.entities).filter(e => e.name === name && dist(e.position) < 90 && (rates[e.id] || 0) < 3).sort((a, b) => dist(a.position) - dist(b.position))
        // un cristal explose : jamais à moins de 10 blocs (on ira se placer plus loin)
        for (const e of all) if (!(e.name === 'end_crystal' && dist(e.position) < 10) && planTir(oeil(), e).sol) return { ent: e, all }
        return { ent: null, all }
      }
      // cristaux cachés (en haut de leur pilier) : chercher au sol un endroit d'où la flèche passe
      const auSol = (x, z, y0) => {
        for (let y = y0 + 15; y > y0 - 15; y--) {
          const b = bot.blockAt(new Vec3(x, y, z))
          if (!b) return null
          if (isAir(b)) continue
          if (b.boundingBox !== 'block' || /obsidian|bedrock|iron_bars|fire/.test(b.name)) return null
          const a1 = bot.blockAt(new Vec3(x, y + 1, z))
          const a2 = bot.blockAt(new Vec3(x, y + 2, z))
          return a1 && a2 && isAir(a1) && isAir(a2) ? y + 1 : null
        }
        return null
      }
      const posteDeTir = (cibles) => {
        const me = bot.entity.position
        const dansEnd = /end/.test(bot.game.dimension || '')
        let best = null
        for (const c of cibles.slice(0, 10)) {
          for (let r = 16; r <= 72; r += 4) {
            for (let deg = 0; deg < 360; deg += 20) {
              const x = Math.floor(c.position.x + Math.cos(deg * Math.PI / 180) * r)
              const z = Math.floor(c.position.z + Math.sin(deg * Math.PI / 180) * r)
              if (dansEnd && Math.hypot(x, z) < 12) continue // la fontaine : le dragon s'y pose et crache
              const cost = Math.hypot(x - me.x, z - me.z)
              if (best && cost >= best.cost) continue
              const y = auSol(x, z, Math.floor(me.y))
              if (y === null) continue
              if (planTir(new Vec3(x + 0.5, y + 1.62, z + 0.5), c).sol) best = { x, y, z, cost }
            }
          }
        }
        return best
      }
      let shots = 0
      let touches = 0
      let deplacements = 0
      for (; shots < n && !interrupted(); shots++) {
        if (!items().some(i => /arrow$/.test(i.name))) break
        const { ent, all } = choisir()
        if (!ent) {
          if (!all.length) break
          const fixes = all.filter(e => e.name === 'end_crystal')
          if (fixes.length && deplacements < 4) {
            const p = posteDeTir(fixes)
            if (p) {
              deplacements++
              console.log(`  🏹 je me place en ${p.x} ${p.y} ${p.z} pour toucher un ${cible}`)
              try { await goto(new GoalNear(p.x, p.y, p.z, 0), 60000) } catch (e) {}
              shots--
              continue
            }
          }
          if (shots > 0) break
          const why = planTir(oeil(), all[0])
          const autres = all.length > 1 ? ` (${all.length} en vue, aucun touchable d'ici)` : ''
          if (why.loin) return `${cible} est hors de portée de l'arc${autres} : rapproche-toi.`
          return `Pas de ligne de tir : il y a ${why.mur.name} sur le trajet de la flèche vers ${cible} (en ${fmt(why.mur.position)})${autres}. Change de place.`
        }
        await bot.equip(findItem('bow'), 'hand')
        const avant = ent.position.clone()
        bot.activateItem() // bander l'arc
        await sleep(1100)
        const e2 = bot.entities[ent.id] || ent
        const fixe = e2.position.distanceTo(avant) < 0.3
        if (fixe && name === 'ender_dragon' && Math.hypot(e2.position.x, e2.position.z) < 12) {
          bot.deactivateItem()
          return `Le dragon est posé sur la fontaine : les flèches rebondissent sur lui quand il est posé. Va le frapper à l'épée tout de suite (attaquer ender_dragon), puis éloigne-toi quand il crache.${shots ? ` (${shots} flèche(s) tirée(s) avant.)` : ''}`
        }
        const eye = oeil()
        let plan = planTir(eye, e2)
        // viser là où il sera (seulement si la vitesse lue est plausible : sur 26.1 elle est parfois fausse)
        const v = e2.velocity
        if (plan.sol && !fixe && v && Math.hypot(v.x, v.y, v.z) < 1.5) {
          const lead = plan.target.plus(v.scaled(plan.sol.t))
          const s2 = aimPitch(Math.hypot(lead.x - eye.x, lead.z - eye.z), lead.y - eye.y)
          if (s2) plan = { sol: s2, target: lead }
        }
        if (!plan.sol) {
          bot.deactivateItem()
          if (shots > 0) break
          return plan.loin ? `${cible} est hors de portée de l'arc : rapproche-toi.` : `Pas de ligne de tir : il y a ${plan.mur.name} sur le trajet (en ${fmt(plan.mur.position)}). Change de place.`
        }
        const { sol, target } = plan
        await bot.look(Math.atan2(-(target.x - eye.x), -(target.z - eye.z)), sol.a, true)
        await sleep(150) // laisser le temps au serveur de recevoir la nouvelle direction avant de tirer
        const known = new Set(Object.keys(bot.entities))
        bot.deactivateItem() // tirer
        await sleep(250)
        // diagnostic : où part la flèche ?
        const arrow = Object.values(bot.entities).find(e => !known.has(String(e.id)) && /arrow/.test(e.name || ''))
        console.log(`  🏹 visée ${(sol.a * 180 / Math.PI).toFixed(1)}° vers ${fmt(target)} (dist ${Math.hypot(target.x - eye.x, target.z - eye.z).toFixed(1)}) ; flèche : ${arrow ? `${fmt(arrow.position)} vitesse ${arrow.velocity.x.toFixed(2)} ${arrow.velocity.y.toFixed(2)} ${arrow.velocity.z.toFixed(2)}` : 'pas vue'}`)
        // une cible immobile (cristal) : attendre que la flèche arrive avant de retirer, pour ne pas gaspiller
        if (fixe && name === 'end_crystal') {
          const t0 = Date.now()
          while (Date.now() - t0 < Math.min(9000, sol.t * 50 + 500) && bot.entities[ent.id]) await sleep(100)
          if (!bot.entities[ent.id]) { touches++; console.log(`  🎯 ${cible} touché`) } else {
            rates[ent.id] = (rates[ent.id] || 0) + 1 // 3 ratés : il y a sûrement un obstacle invisible pour moi (cage...), je passe à un autre
            if (rates[ent.id] >= 3) console.log(`  🏹 ${cible} en ${fmt(ent.position)} : 3 flèches sans effet, je l'abandonne (cage ?)`)
          }
        } else await sleep(450)
      }
      await sleep(1000) // laisser la dernière flèche arriver
      const restants = Object.values(bot.entities).filter(e => e.name === name && dist(e.position) < 90)
      const intouchables = restants.filter(e => (rates[e.id] || 0) >= 3)
      const bilan = touches ? ` ${touches} détruit(s).` : ''
      const cage = intouchables.length ? ` ${intouchables.length} semble(nt) intouchable(s) à l'arc (sûrement dans une cage en barreaux de fer) : ${intouchables.map(e => fmt(e.position)).join(' ; ')}.` : ''
      const autres = restants.length - intouchables.length
      if (name === 'ender_dragon') {
        const v = vieDragon()
        return `${shots} flèche(s) tirée(s) sur le dragon${v !== null ? ` (sa vie : ${v}%)` : ''}.${restants.length ? '' : ' Il est parti ou mort !'}`
      }
      return `${shots} flèche(s) tirée(s) sur ${cible}.${bilan}${cage} ${autres ? `Il en reste ${autres} autre(s) en vue : continue.` : restants.length ? '' : 'Plus aucun en vue !'}`
    })

  // Combat contre le dragon en boucle, sans attendre le cerveau entre deux gestes (un boss demande des réflexes)
  tool('combattre_dragon', 'End : combat complet contre le dragon pendant quelques minutes, tout seul : arc quand il vole (j\'anticipe sa trajectoire), je recule quand il se pose sur la fontaine (les flèches rebondissent sur lui), esquives et repas automatiques, jamais au centre sinon. À lancer quand les cristaux sont détruits ; relance-le tant que le dragon vit.',
    { minutes: N('durée max en minutes (défaut 4)'), epee: { type: 'boolean', description: 'aussi l\'attaquer à l\'épée quand il se pose (risqué, défaut non : arc seulement)' } }, [],
    async ({ minutes = 4, epee = false }) => {
      if (!findItem('bow')) return 'Il me faut un arc.'
      const deaths0 = ctx.deaths
      const vie0 = vieDragon()
      const fin = Date.now() + clamp(minutes, 1, 8) * 60000
      ctx.followName = null
      let fleches = 0
      let poses = 0
      const fleche = () => items().some(i => /arrow$/.test(i.name))
      while (Date.now() < fin && !interrupted()) {
        if (ctx.deaths !== deaths0) break
        const dragon = bot.nearestEntity(e => e.name === 'ender_dragon')
        if (!dragon) {
          await sleep(1500)
          if (!bot.nearestEntity(e => e.name === 'ender_dragon') && vieDragon() === null) return `Le dragon est mort ! (${fleches} flèches, le dragon s'est posé ${poses} fois)`
          continue
        }
        if (ctx.fleeing || bot.pvp.target) { await sleep(300); continue } // esquive ou riposte en cours
        if (bot.health < 15 && bot.food < 20 && !ctx.eating) { await eat().catch(() => {}); continue }
        // posé sur la fontaine ? -> épée sur la tête
        const p0 = dragon.position.clone()
        await sleep(350)
        const d = bot.entities[dragon.id]
        if (!d) continue
        if (d.position.distanceTo(p0) < 0.4 && Math.hypot(d.position.x, d.position.z) < 12) {
          poses++
          if (epee) {
            const r = await frapperDragon(d)
            console.log(`  ⚔ ${r}`)
            if (/mort/.test(r)) return `${r} (${fleches} flèches tirées avant)`
            continue
          }
          // posé : les flèches rebondissent et s'approcher est très dangereux (souffle, coups d'ailes qui projettent en l'air).
          // je recule à ~24 blocs et j'attends qu'il redécolle.
          const me = bot.entity.position
          if (Math.hypot(me.x, me.z) < 20) {
            const ang = Math.atan2(me.z, me.x)
            try { await goto(new goals.GoalNearXZ(Math.round(Math.cos(ang) * 24), Math.round(Math.sin(ang) * 24), 3), 10000) } catch (e) {}
          } else await sleep(500)
          continue
        }
        // en vol : une flèche s'il est à portée et que la trajectoire est libre
        if (!fleche()) return `Plus de flèches (${fleches} tirées). Vie du dragon : ${vieDragon() ?? '?'}%.`
        const eye0 = bot.entity.position.offset(0, 1.62, 0)
        if (dist(d.position) < 80 && planTir(eye0, d).sol) {
          await bot.equip(findItem('bow'), 'hand')
          const a = d.position.clone()
          bot.activateItem()
          await sleep(1100)
          const e2 = bot.entities[d.id]
          if (!e2) { bot.deactivateItem(); continue }
          // vitesse mesurée sur la charge de l'arc (blocs par tick) : sur 26.1 celle des paquets est peu fiable
          const v = e2.position.minus(a).scaled(1 / 22)
          const eye = bot.entity.position.offset(0, 1.62, 0)
          let plan = planTir(eye, e2)
          if (plan.sol && v.norm() < 2) {
            const lead = plan.target.plus(v.scaled(plan.sol.t))
            const s2 = aimPitch(Math.hypot(lead.x - eye.x, lead.z - eye.z), lead.y - eye.y)
            if (s2) plan = { sol: s2, target: lead }
          }
          if (!plan.sol) { bot.deactivateItem(); continue }
          await bot.look(Math.atan2(-(plan.target.x - eye.x), -(plan.target.z - eye.z)), plan.sol.a, true)
          await sleep(120)
          bot.deactivateItem()
          fleches++
          await sleep(250)
          continue
        }
        // pas de tir possible : se placer sur l'anneau à ~25 blocs du centre (loin de la fontaine et des tours), du côté du dragon
        const me = bot.entity.position
        const rMoi = Math.hypot(me.x, me.z)
        if (rMoi < 16 || rMoi > 34) {
          const ang = Math.atan2(d.position.z, d.position.x)
          try { await goto(new goals.GoalNearXZ(Math.round(Math.cos(ang) * 25), Math.round(Math.sin(ang) * 25), 3), 15000) } catch (e) {}
        } else await sleep(400)
      }
      const v = vieDragon()
      if (ctx.deaths !== deaths0) return `Je suis mort pendant le combat (${fleches} flèches, le dragon s'est posé ${poses} fois). Vie du dragon : ${vie0 ?? '?'}% → ${v ?? '?'}%.`
      return `Fin de la manche : ${fleches} flèches, le dragon s'est posé ${poses} fois. Vie du dragon : ${vie0 ?? '?'}% → ${v ?? '?'}%. Relance combattre_dragon s'il vit encore (mange avant si besoin).`
    })

  tool('ouvrir_cage','End : ouvrir la cage en barreaux de fer autour d\'un cristal. Je monte contre la tour en posant de la pierre de l\'End sous moi, je casse les barreaux du côté du centre de l\'île, puis je redescends en recassant ma tour et je m\'éloigne. Ensuite « tirer end_crystal » peut le toucher. Il me faut une pioche et ~30 end_stone (recolter end_stone).', {}, [],
    async () => {
      const barsId = reg.blocksByName.iron_bars?.id
      const cages = Object.values(bot.entities)
        .filter(e => e.name === 'end_crystal' && dist(e.position) < 120)
        .map(c => ({ c, bars: bot.findBlocks({ point: c.position, matching: barsId, maxDistance: 4, count: 200 }) }))
        .filter(x => x.bars.length)
        .sort((a, b) => dist(a.c.position) - dist(b.c.position))
      if (!cages.length) return 'Je ne vois aucun cristal en cage autour de moi.'
      const { c, bars } = cages[0]
      const cy = Math.floor(c.position.y)
      // de quel côté : vers le centre de l'île (le sol est de ce côté)
      let ux = -c.position.x
      let uz = -c.position.z
      const L = Math.hypot(ux, uz) || 1
      ux /= L
      uz /= L
      // rayon du pilier (obsidienne mesurée juste sous le sommet)
      let r = 1
      while (r < 8) {
        const b = bot.blockAt(new Vec3(Math.floor(c.position.x + ux * (r + 1)), cy - 2, Math.floor(c.position.z + uz * (r + 1))))
        if (!b || b.name !== 'obsidian') break
        r++
      }
      const tx = Math.floor(c.position.x + ux * (r + 1.5))
      const tz = Math.floor(c.position.z + uz * (r + 1.5))
      const pierre = items().filter(i => i.name === 'end_stone').reduce((s, i) => s + i.count, 0)
      const besoin = cy - Math.floor(bot.entity.position.y) + 4
      if (pierre < besoin) return `Il me faut au moins ${besoin} end_stone pour monter jusqu'à la cage en ${fmt(c.position)} (j'en ai ${pierre}) : recolter end_stone d'abord.`
      // hauteur du sol au pied de la tour (pour savoir jusqu'où redescendre)
      let sol0 = null
      for (let y = cy - 3; y > cy - 60; y--) {
        const b = bot.blockAt(new Vec3(tx, y, tz))
        if (b && !isAir(b) && b.boundingBox === 'block') { sol0 = y + 1; break }
      }
      // monter UNIQUEMENT avec de la pierre de l'End : je pourrai la recasser pour redescendre
      const saved = moves.scafoldingBlocks
      moves.scafoldingBlocks = [reg.itemsByName.end_stone.id]
      ctx.followName = null
      try {
        try { await goto(new GoalBlock(tx, cy, tz), 150000) } catch (e) { return `Je n'arrive pas à monter contre la tour (${e.message}). Je suis en ${fmt(bot.entity.position)}.` }
        // casser les barreaux de la face tournée vers moi
        const dot = p => (p.x + 0.5 - c.position.x) * ux + (p.z + 0.5 - c.position.z) * uz
        const maxDot = Math.max(...bars.map(dot))
        const face = bars.filter(p => dot(p) > maxDot - 1).sort((a, b) => a.y - b.y)
        let n = 0
        for (const p of face) {
          if (interrupted()) break
          const b = bot.blockAt(p)
          if (!b || b.name !== 'iron_bars') continue
          if (bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.5) continue
          await equipToolFor(b)
          await creuserBloc(b)
          n++
        }
        if (!n) return `Je n'atteins pas les barreaux depuis ici (${fmt(bot.entity.position)}).`
        // redescendre AU SOL : je recasse ma tour de pierre de l'End sous mes pieds, bloc par bloc
        bot.pathfinder.setGoal(null)
        for (let i = 0; i < 60 && !interrupted(); i++) {
          const pied = bot.entity.position.floored()
          if (sol0 !== null && pied.y <= sol0) break
          const dessous = bot.blockAt(pied.offset(0, -1, 0))
          if (!dessous || dessous.name !== 'end_stone') break
          await equipToolFor(dessous)
          try { await creuserBloc(dessous, true) } catch (e) { break }
          const t1 = Date.now()
          while (Date.now() - t1 < 1500 && bot.entity.position.y > pied.y - 0.9) await sleep(50)
        }
        // puis s'éloigner : un cristal qui explose tue à moins de 8 blocs,
        // et rester perché en hauteur, c'est se faire éjecter par le dragon
        const gx = Math.floor(c.position.x + ux * 24)
        const gz = Math.floor(c.position.z + uz * 24)
        let gy = null
        for (let y = cy - 5; y > cy - 50; y--) {
          const b = bot.blockAt(new Vec3(gx, y, gz))
          if (b && !isAir(b) && b.boundingBox === 'block') { gy = y + 1; break }
        }
        try { await goto(gy !== null ? new GoalNear(gx, gy, gz, 2) : new goals.GoalNearXZ(gx, gz, 2), 150000) } catch (e) {}
        return `Cage ouverte : ${n} barreaux cassés côté centre de l'île. Je suis en ${fmt(bot.entity.position)}. Maintenant : tirer end_crystal.`
      } finally {
        moves.scafoldingBlocks = saved
      }
    })

  // ---------- routines automatiques (sans appel à l'IA) ----------
  // Renvoie une fonction qui arrête les routines (utile quand le bot se reconnecte)
  function startRoutines () {
    // Défense automatique
    const timer = setInterval(() => {
      if (!bot.entity) return
      // souffle du dragon (nuage violet au sol) : il tue en 3 secondes, on sort tout de suite (même si la défense est coupée)
      const nuage = bot.nearestEntity(e => e.name === 'area_effect_cloud' && Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z) < 9 && Math.abs(e.position.y - bot.entity.position.y) < 4)
      // (prioritaire : même pendant une autre esquive, celle d'une boule de feu par exemple)
      if (nuage && !ctx.fuiteNuage && !bot.isSleeping) {
        ctx.fleeing = true
        ctx.fuiteNuage = true
        bot.pvp.stop().catch(() => {})
        const goal = new goals.GoalInvert(new GoalFollow(nuage, 14))
        bot.pathfinder.setGoal(goal, true)
        console.log('  🏃 souffle du dragon, je sors du nuage')
        setTimeout(() => {
          ctx.fleeing = false
          ctx.fuiteNuage = false
          if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null)
        }, 3500)
        return
      }
      if (!ctx.defense) return
      // un monstre collé à moi (zombie...) : je le frappe d'abord, même s'il y a un creeper un peu plus loin
      // (sinon je fuis le creeper sans arrêt et le zombie me tape dans le dos)
      const colle = bot.nearestEntity(e => AUTO_DEFENSE.has(e.name) && e.position.distanceTo(bot.entity.position) < 2.5)
      if (colle && !ctx.enAbri && !bot.isSleeping && bot.pvp.target?.id !== colle.id && !ctx.fuiteNuage) {
        ctx.fleeing = false
        ctx.defending = true
        equipBestWeapon().catch(() => {})
        bot.pvp.attack(colle).catch(() => {})
        return
      }
      // un creeper trop près : on ne le tape pas (il explose), on s'éloigne quelques secondes
      const creeper = bot.nearestEntity(e => e.name === 'creeper' && dist(e.position) < 5)
      // (pas depuis l'abri : la fuite le ferait creuser pour sortir, droit dans les zombies)
      if (creeper && !ctx.fleeing && !bot.isSleeping && !colle && !ctx.enAbri) {
        ctx.fleeing = true
        ctx.defending = true
        bot.pvp.stop().catch(() => {})
        bot.pathfinder.setGoal(new goals.GoalInvert(new GoalFollow(creeper, 10)), true)
        console.log('  🏃 creeper trop près, je m\'éloigne')
        setTimeout(() => {
          ctx.fleeing = false
          ctx.defending = false
          if (bot.pathfinder.goal instanceof goals.GoalInvert) bot.pathfinder.setGoal(null)
        }, 4000)
        return
      }
      if (ctx.fleeing || bot.pvp.target) return
      if (ctx.enAbri || ctx.abriEnCours) return // dans l'abri, on ne sort pas se battre
      const mob = bot.nearestEntity(e => AUTO_DEFENSE.has(e.name) && dist(e.position) < 6)
      if (!mob) return
      ctx.defending = true
      equipBestWeapon().catch(() => {})
      bot.pvp.attack(mob).catch(() => {})
    }, 500)
    // Après un combat : reprendre le suivi (sauf si une action est en cours, elle reprendra seule)
    const onStopped = () => {
      ctx.defending = false
      setTimeout(() => { if (!ctx.busy && !bot.pathfinder.goal) resumeFollow() }, 300)
    }
    // Manger tout seul (pas en plein travail, sauf s'il a vraiment faim)
    let lastLowAlert = 0
    const onHealth = () => {
      if (bot.health > 0 && bot.health <= 8 && Date.now() - lastLowAlert > 60000) {
        lastLowAlert = Date.now()
        // réflexe : des monstres tout près et la vie basse -> je m'enterre tout de suite (abri d'urgence)
        const menace = bot.nearestEntity(e => HOSTILES.has(e.name) && dist(e.position) < 10)
        // pas d'abri si un monstre est déjà collé à moi : creuser prend du temps, il me taperait pendant ce temps
        const auContact = bot.nearestEntity(e => HOSTILES.has(e.name) && e.position.distanceTo(bot.entity.position) < 3)
        if (menace && !auContact && !ctx.enAbri && !bot.isSleeping && /overworld/.test(bot.game.dimension || '')) {
          console.log('  🕳 vie basse et monstres autour : abri d\'urgence')
          ctx.abort = true
          setTimeout(() => {
            ctx.abort = false
            abriExpress().then(r => ctx.onEvent?.(`[événement] Ta vie était basse (${Math.round(bot.health)}/20) avec des monstres autour : ${r}`)).catch(() => {})
          }, 300)
        } else {
          ctx.onEvent?.(`[événement] Attention, ta vie est basse (${Math.round(bot.health)}/20) ! Éloigne-toi des monstres, mange, et mets-toi à l'abri (ta maison, ou abri_express).`)
        }
      }
      // blessé : il faut au moins 18 de faim pour que la vie remonte, donc on mange plus tôt
      const seuil = bot.health < 20 ? 18 : 15
      if (bot.food < seuil && !ctx.eating && !bot.pvp.target && (!ctx.busy || bot.food < 8 || bot.health < 12)) eat().catch(() => {})
    }
    // La nuit tombe : on prévient le cerveau (rentrer, s'abriter, dormir...)
    const isNight = () => { const t = bot.time.timeOfDay; return t >= 12500 && t < 23000 }
    let wasNight = isNight()
    const onTime = () => {
      const night = isNight()
      if (night && !wasNight) {
        const pieces = armorNames().length
        ctx.onEvent?.(pieces >= 4
          ? '[événement] La nuit tombe : les monstres vont sortir.'
          : `[événement] La nuit tombe et tu n'as que ${pieces} pièce(s) d'armure : arrête ce que tu fais et mets-toi à l'abri MAINTENANT (dans ta maison/cabane porte fermée, ou abri_express sur place) jusqu'au matin. Dors si tu as un lit.`)
      }
      if (!night && wasNight && ctx.enAbri) ctx.onEvent?.('[événement] Le jour se lève : tu peux sortir de ton abri (remonter) et reprendre tes activités.')
      wasNight = night
    }
    // Au réveil : il reprend son lit portable
    const onWake = () => {
      if (!ctx.portableBed) return
      const pos = ctx.portableBed
      ctx.portableBed = null
      setTimeout(() => pickUpBed(pos).catch(() => {}), 1000)
    }
    // Boules de feu du dragon : leur nuage fait des dégâts magiques (l'armure ne protège pas).
    // Si une boule arrive sur moi, je fais un pas de côté.
    const vuFb = {}
    const esquive = setInterval(() => {
      if (!bot.entity || bot.isSleeping) return
      for (const fb of Object.values(bot.entities)) {
        if (fb.name !== 'dragon_fireball' || dist(fb.position) > 40) continue
        const prev = vuFb[fb.id]
        vuFb[fb.id] = fb.position.clone()
        const dir = prev ? fb.position.minus(prev) : fb.velocity
        if (!dir || dir.norm() < 0.05 || ctx.fleeing) continue
        const dn = dir.unit()
        const rel = bot.entity.position.offset(0, 1, 0).minus(fb.position)
        const along = rel.dot(dn)
        if (along <= 0) continue // elle s'éloigne
        if (rel.minus(dn.scaled(along)).norm() > 6) continue // elle va me rater
        // pas de côté, perpendiculaire à sa trajectoire, du côté où je suis déjà
        let px = -dn.z
        let pz = dn.x
        const n = Math.hypot(px, pz) || 1
        px /= n
        pz /= n
        const side = (rel.x * px + rel.z * pz) >= 0 ? 1 : -1
        const p = bot.entity.position
        const goal = new GoalNear(p.x + px * side * 9, p.y, p.z + pz * side * 9, 1)
        ctx.fleeing = true
        bot.pvp.stop().catch(() => {})
        bot.pathfinder.setGoal(goal, true)
        console.log('  🏃 boule de feu du dragon, j\'esquive')
        setTimeout(() => {
          ctx.fleeing = false
          if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null)
        }, 2500)
        return
      }
      for (const id of Object.keys(vuFb)) if (!bot.entities[id]) delete vuFb[id]
    }, 200)
    // Noyade : la tête sous l'eau, je nage vers le haut pour respirer.
    // Si l'air baisse vraiment, j'abandonne le trajet en cours (le pathfinder se perd dans les mines inondées).
    // Sous un plafond (poche d'eau souterraine), je cherche le chemin d'eau le plus court vers de l'air et je le suis à la nage.
    let nage = false
    let alerteAir = 0
    let enNage = false
    let yAvant = null
    let bloqueDepuis = 0
    const passable = (b) => b && (isAir(b) || /^(water|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant)$/.test(b.name))
    const respirable = (b) => b && isAir(b)
    function cheminVersAir () {
      const depart = bot.entity.position.offset(0, 1.62, 0).floored()
      const cle = (p) => `${p.x},${p.y},${p.z}`
      const vu = new Map([[cle(depart), null]])
      const file = [depart]
      const dirs = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]
      while (file.length && vu.size < 3000) {
        const p = file.shift()
        // une case d'air avec de l'air (ou de l'eau) au-dessous : la tête peut y respirer
        if (respirable(bot.blockAt(p)) && !p.equals(depart)) {
          const chemin = []
          for (let q = p; q; q = vu.get(cle(q))) chemin.unshift(q)
          return chemin
        }
        for (const [dx, dy, dz] of dirs) {
          const n = p.offset(dx, dy, dz)
          if (vu.has(cle(n)) || n.distanceTo(depart) > 16) continue
          if (!passable(bot.blockAt(n))) continue
          // le corps fait 2 blocs de haut : la case sous la tête doit aussi être libre (sauf en montant tout droit)
          if (dy !== 1 && !passable(bot.blockAt(n.offset(0, -1, 0)))) continue
          vu.set(cle(n), p)
          file.push(n)
        }
      }
      return null
    }
    async function nagerVersAir () {
      if (enNage) return
      enNage = true
      try {
        const chemin = cheminVersAir()
        if (!chemin) { console.log('  🫧 pas de poche d\'air atteignable à la nage'); return }
        console.log(`  🫧 coincé sous l'eau : je nage vers l'air en ${fmt(chemin[chemin.length - 1])} (${chemin.length} cases)`)
        bot.pathfinder.setGoal(null)
        for (const wp of chemin.slice(1)) {
          // wp = case où doit passer la TÊTE ; les pieds sont 1 bloc plus bas
          const cible = wp.offset(0.5, -1.1, 0.5)
          const t0 = Date.now()
          while (Date.now() - t0 < 2500 && bot.entity) {
            const tete = bot.blockAt(bot.entity.position.offset(0, 1.62, 0))
            if (tete && isAir(tete)) return // la tête est sortie : je respire
            const p = bot.entity.position
            if (Math.hypot(p.x - cible.x, p.z - cible.z) < 0.4 && Math.abs(p.y - cible.y) < 0.6) break
            await bot.lookAt(cible.offset(0, 1.6, 0), true)
            bot.setControlState('forward', Math.hypot(p.x - cible.x, p.z - cible.z) > 0.3)
            bot.setControlState('jump', cible.y > p.y - 0.2)
            bot.setControlState('sneak', cible.y < p.y - 0.6)
            await sleep(50)
          }
        }
      } finally {
        bot.setControlState('forward', false)
        bot.setControlState('sneak', false)
        enNage = false
      }
    }
    let sousLeauDepuis = 0
    const anti_noyade = setInterval(() => {
      if (!bot.entity || bot.isSleeping) return
      const tete = bot.blockAt(bot.entity.position.offset(0, 1.62, 0))
      // sous l'eau, la tête peut aussi être dans des algues, des herbes marines, une colonne de bulles
      // ou un bloc « gorgé d'eau » (waterlogged) : ils ne s'appellent pas « water » (deux noyades sans réflexe à cause de ça)
      const sousLeau = !!tete && (/^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(tete.name) ||
        tete.getProperties?.()?.waterlogged === true || (bot.entity.isInWater && (bot.oxygenLevel ?? 20) < 19))
      // l'air lu par mineflayer n'est pas toujours mis à jour (26.1) : on compte aussi le temps passé la tête sous l'eau
      if (sousLeau) { if (!sousLeauDepuis) sousLeauDepuis = Date.now() } else sousLeauDepuis = 0
      const estime = sousLeauDepuis ? Math.max(0, 20 - Math.floor((Date.now() - sousLeauDepuis) / 750)) : 20
      // la jauge d'air du jeu est fiable (testée) : l'estimation au temps ne sert que si elle est absente.
      // (à la surface de la mer, les yeux sont parfois « dans l'eau » alors qu'il respire : l'estimation le bloquait en mer)
      const air = bot.oxygenLevel ?? estime
      // je n'arrive plus à monter (plafond) : nage vers la poche d'air la plus proche
      if (sousLeau) {
        const y = bot.entity.position.y
        if (yAvant !== null && Math.abs(y - yAvant) < 0.05) { if (!bloqueDepuis) bloqueDepuis = Date.now() } else bloqueDepuis = 0
        yAvant = y
        if (!enNage && bloqueDepuis && Date.now() - bloqueDepuis > 1000 && air < 18) {
          ctx.abort = true
          setTimeout(() => { ctx.abort = false }, 1500)
          nagerVersAir().catch(() => {})
        }
      } else { yAvant = null; bloqueDepuis = 0 }
      if (enNage) return
      if (sousLeau && (air < 16 || !bot.pathfinder.isMoving())) {
        if (air < 10 && bot.pathfinder.goal) { bot.pathfinder.setGoal(null); ctx.abort = true; setTimeout(() => { ctx.abort = false }, 1500) }
        if (!nage) {
          nage = true
          if (air < 16) console.log(`  🫧 tête sous l'eau (air ${air}/20), je remonte respirer`)
        }
        bot.setControlState('jump', true)
        if (air < 8 && Date.now() - alerteAir > 30000) {
          alerteAir = Date.now()
          ctx.onEvent?.(`[événement] Tu te noies (air ${air}/20) ! Remonte respirer, ne creuse pas plus bas, sors de l'eau. Si tu es coincé sous un plafond, casse le bloc au-dessus de ta tête.`)
        }
      } else if (nage && !sousLeau) {
        nage = false
        bot.setControlState('jump', false)
      }
    }, 250)
    // Un enderman (neutre d'habitude) qui me frappe : je riposte
    const onHurt = (e) => {
      if (e !== bot.entity || !ctx.defense || ctx.fleeing || bot.pvp.target) return
      const ender = bot.nearestEntity(m => m.name === 'enderman' && dist(m.position) < 5)
      if (!ender) return
      ctx.defending = true
      equipBestWeapon().catch(() => {})
      bot.pvp.attack(ender).catch(() => {})
    }
    bot.on('stoppedAttacking', onStopped)
    bot.on('health', onHealth)
    bot.on('time', onTime)
    bot.on('wake', onWake)
    // Réapparition la nuit sans armure : la base est souvent envahie (boucle de morts vue plusieurs fois).
    // Réflexe : s'enterrer tout de suite, sauf si un monstre est déjà collé à moi.
    const onSpawn = () => {
      setTimeout(() => {
        if (!bot.entity || !nuitDehors() || armorNames().length >= 2 || !/overworld/.test(bot.game.dimension || '')) return
        const auContact = bot.nearestEntity(e => HOSTILES.has(e.name) && e.position.distanceTo(bot.entity.position) < 3)
        if (auContact) return
        console.log('  🕳 réapparu la nuit sans armure : abri d\'urgence tout de suite')
        ctx.enAbri = null
        abriExpress().then(r => ctx.onEvent?.(`[événement] Tu viens de réapparaître la nuit sans armure : ${r}`)).catch(() => {})
      }, 1500)
    }
    bot.on('spawn', onSpawn)
    bot.on('entityHurt', onHurt)
    return () => {
      clearInterval(timer)
      clearInterval(esquive)
      clearInterval(anti_noyade)
      bot.removeListener('spawn', onSpawn)
      bot.removeListener('entityHurt', onHurt)
      bot.removeListener('stoppedAttacking', onStopped)
      bot.removeListener('health', onHealth)
      bot.removeListener('time', onTime)
      bot.removeListener('wake', onWake)
    }
  }

  async function run (name, input) {
    const fn = impl[name]
    if (!fn) return `Action inconnue : ${name}`
    const missing = requiredOf[name].filter(k => input?.[k] === undefined || input[k] === '')
    if (missing.length) return `Il manque : ${missing.join(', ')}. Rappelle l'action avec ces informations.`
    ctx.abort = false
    ctx.yieldReq = false
    ctx.runDeaths = ctx.deaths
    ctx.busy++
    ctx.actionEnCours = { nom: name, input: input || {} } // affiché en direct dans l'appli
    try {
      // filet de sécurité : aucune action ne doit durer plus de 15 minutes (sinon le cerveau reste bloqué à l'attendre)
      let delai = false
      const out = await withTimeout(fn(input || {}), 15 * 60000, () => {
        delai = true
        ctx.abort = true
        bot.pathfinder.setGoal(null)
        try { bot.stopDigging() } catch (_) {}
        bot.clearControlStates()
        setTimeout(() => { ctx.abort = false }, 3000)
      }).catch(e => { if (delai) return `Action « ${name} » arrêtée : elle durait depuis plus de 15 minutes (bloquée ?). Je suis en ${fmt(bot.entity.position)}.`; throw e })
      // il est mort pendant l'action : on le lui dit clairement
      return ctx.deaths !== ctx.runDeaths ? `${out} (ATTENTION : tu es mort pendant cette action, ton stuff est resté à l'endroit de ta mort.)` : out
    } finally {
      ctx.busy--
      if (!ctx.busy) ctx.actionEnCours = null
      // il suivait quelqu'un avant cette tâche : il s'y remet
      if (!ctx.busy && ctx.followName && !bot.pathfinder.goal) resumeFollow()
    }
  }

  return {
    tools: defs,
    run,
    etat,
    stopAll,
    startRoutines,
    mission: () => ctx.mission,
    missionGains,
    priorites,
    progression,
    isFollowing: () => !!ctx.followName,
    suitQui: () => ctx.followName || null,
    isBusy: () => ctx.busy > 0,
    actionEnCours: () => (ctx.busy ? ctx.actionEnCours : null),
    aLAbriLaNuit: () => !!ctx.enAbri && nuitDehors(),
    endMission: () => { ctx.mission = null },
    // un joueur parle pendant une tâche : les longues actions s'arrêtent pour lui répondre
    yieldToPlayer: () => { if (ctx.busy) ctx.yieldReq = true },
    // il vient de mourir : on retient l'endroit pour aller récupérer son stuff
    onDeath: () => { ctx.deaths++; ctx.enAbri = null; const p = bot.entity.position; memoire.setLieu('derniere_mort', p, dim()); return fmt(p) },
    onEvent: (fn) => { ctx.onEvent = fn }
  }
}

module.exports = { createActions }
