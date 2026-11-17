'use strict'
// Carte en direct pour l'appli MineBuddy : vue de dessus autour du bot.
// Pour chaque colonne, on prend le bloc le plus haut (ou, sous terre, le sol de la grotte),
// sa « famille » (herbe, eau, pierre...) et sa hauteur. Calculée par petits morceaux pour ne pas faire ramer le bot.
const { Vec3 } = require('vec3')

const RAYON = 40 // 81 x 81 blocs autour du bot

// familles de blocs → numéro de couleur (les couleurs sont dans l'appli). Le premier qui correspond gagne.
const FAMILLES = [
  [/water|bubble_column|kelp|seagrass|sea_pickle/, 4],
  [/lava|magma/, 9],
  [/leaves|vine|azalea|mangrove_roots/, 2],
  [/_log$|_wood$|_stem$|hyphae|bamboo|mushroom_block/, 3],
  [/wheat|carrots|potatoes|beetroots|farmland|melon|pumpkin|sugar_cane|hay_block/, 14],
  [/planks|brick|glass|wool|concrete|door|fence|slab|stairs|torch|_bed$|chest|crafting|furnace|carpet|lantern|_wall$|ladder|cobblestone$|smooth|polished|chiseled|^cut_|bookshelf|barrel/, 12],
  [/terracotta/, 16],
  [/grass|fern|flower|tulip|poppy|dandelion|orchid|allium|bluet|daisy|cornflower|lily|moss|bush|sapling|dripleaf|petals|cactus/, 1],
  [/snow|ice/, 8],
  [/sand/, 5],
  [/dirt|gravel|mud|clay|podzol|mycelium|path/, 7],
  [/netherrack|nether|crimson|warped|soul|basalt|blackstone|glowstone|quartz|wart|shroomlight/, 10],
  [/end_stone|purpur|chorus/, 11],
  [/deepslate|tuff|bedrock|obsidian/, 15]
]
const VIDE = /^(air|cave_air|void_air|light|structure_void)$/
const PAS_UN_PLAFOND = /leaves|_log$|_wood$|vine|glass/

function creerCarte (bot) {
  const familles = new Map() // type de bloc → famille (mise en cache)
  const famille = (b) => {
    let f = familles.get(b.type)
    if (f === undefined) {
      f = 6 // pierre par défaut
      for (const [re, n] of FAMILLES) if (re.test(b.name)) { f = n; break }
      familles.set(b.type, f)
    }
    return f
  }

  // sous terre (mine, grotte, Nether) : on dessine le sol autour de lui, pas le dessus de la montagne
  function sousTerre (p) {
    if (/nether/.test(bot.game?.dimension || '')) return true
    for (let dy = 2; dy <= 14; dy++) {
      const b = bot.blockAt(p.offset(0, dy, 0))
      if (b && !VIDE.test(b.name) && b.boundingBox === 'block' && !PAS_UN_PLAFOND.test(b.name)) return true
    }
    return false
  }

  // renvoie { cx, cz, y, rayon, familles, hauteurs } ; hauteur relative au bot, null = zone pas chargée ou vide
  async function calculer () {
    const pos = bot.entity?.position
    if (!pos) return null
    const p = pos.floored()
    const dessous = sousTerre(p)
    const haut = dessous ? p.y + 1 : p.y + 16
    const bas = Math.max(bot.game?.minY ?? -64, haut - 56)
    const cote = RAYON * 2 + 1
    const fam = new Array(cote * cote).fill(0)
    const hau = new Array(cote * cote).fill(null)
    const v = new Vec3(0, 0, 0)
    for (let dz = -RAYON; dz <= RAYON; dz++) {
      for (let dx = -RAYON; dx <= RAYON; dx++) {
        const i = (dz + RAYON) * cote + (dx + RAYON)
        v.x = p.x + dx
        v.z = p.z + dz
        for (let y = haut; y >= bas; y--) {
          v.y = y
          const b = bot.blockAt(v, false)
          if (!b) break // pas chargé
          if (VIDE.test(b.name)) continue
          fam[i] = famille(b)
          hau[i] = y - p.y
          break
        }
      }
      // une pause toutes les 3 lignes : le bot continue de jouer (et de bouger) pendant le calcul
      if ((dz + RAYON) % 3 === 2) await new Promise(r => setImmediate(r))
    }
    return { cx: p.x, cz: p.z, y: p.y, rayon: RAYON, sousTerre: dessous, familles: fam, hauteurs: hau }
  }

  return { calculer }
}

module.exports = { creerCarte }
