'use strict'
// Mémoire à long terme du bot : les lieux qu'il connaît (base, mine...) et ses souvenirs avec toi.
// Tout est gardé dans memoire.json, donc il s'en souvient même après un redémarrage.

const fs = require('fs')
const path = require('path')

// Dossier des données : celui de l'appli MineBuddy (MB_DATA_DIR) ou, en ligne de commande, le dossier du projet
const dossier = () => process.env.MB_DATA_DIR || __dirname
const MAX_SOUVENIRS = 40

function createMemoire () {
  const FILE = path.join(dossier(), 'memoire.json')
  let data = { lieux: {}, souvenirs: [], reglages: {} }
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    data = { lieux: saved.lieux || {}, souvenirs: saved.souvenirs || [], reglages: saved.reglages || {} }
  } catch (_) { /* pas encore de mémoire : on part de zéro */ }

  const save = () => {
    try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)) } catch (e) { console.log('⚠ Mémoire non sauvegardée :', e.message) }
  }
  const cle = (nom) => String(nom || '').toLowerCase().trim()

  return {
    estVide: () => !Object.keys(data.lieux).length && !data.souvenirs.length,
    // réglages gardés d'une partie à l'autre (ex. mode autonome)
    reglage: (nom, defaut) => (nom in data.reglages ? data.reglages[nom] : defaut),
    setReglage (nom, valeur) { data.reglages[nom] = valeur; save() },
    lieu: (nom) => data.lieux[cle(nom)] || null,
    lieux: () => data.lieux,
    setLieu (nom, pos, dimension) {
      data.lieux[cle(nom)] = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dimension }
      save()
    },
    removeLieu (nom) {
      if (!data.lieux[cle(nom)]) return false
      delete data.lieux[cle(nom)]
      save()
      return true
    },
    addSouvenir (texte) {
      data.souvenirs.push({ date: new Date().toLocaleDateString('fr-FR'), texte: String(texte).slice(0, 300) })
      while (data.souvenirs.length > MAX_SOUVENIRS) data.souvenirs.shift()
      save()
    },
    // --- pour l'appli MineBuddy (écran Mémoire) ---
    souvenirs: () => data.souvenirs,
    editSouvenir (index, texte) {
      if (!data.souvenirs[index]) return false
      data.souvenirs[index].texte = String(texte).slice(0, 300)
      save()
      return true
    },
    removeSouvenir (index) {
      if (!data.souvenirs[index]) return false
      data.souvenirs.splice(index, 1)
      save()
      return true
    },
    toutEffacer () {
      data.lieux = {}
      data.souvenirs = []
      save()
    },
    // copie lisible de toute la mémoire (lieux, souvenirs, dépense du jour)
    export: () => JSON.parse(JSON.stringify(data)),
    // Texte donné à Claude avec ses instructions
    texte () {
      const lieux = Object.entries(data.lieux).map(([k, v]) => `${k} (${v.x} ${v.y} ${v.z}${v.dimension ? ', ' + v.dimension : ''})`).join(' ; ') || 'aucun pour l\'instant'
      const souv = data.souvenirs.map(s => `- [${s.date}] ${s.texte}`).join('\n') || '- aucun pour l\'instant'
      return `Ta mémoire (tu la gardes même quand tu te reconnectes) :\nLieux connus : ${lieux}\nSouvenirs :\n${souv}`
    }
  }
}

module.exports = { createMemoire }
