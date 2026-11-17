'use strict'
// MineBuddy — l'appli de bureau qui règle et lance le bot.
// Elle garde les réglages dans le dossier de l'utilisateur (%APPDATA%\MineBuddy), lance le bot
// en arrière-plan, et affiche ce qu'il fait en direct.

const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { fork } = require('child_process')

const RACINE = path.join(__dirname, '..') // dossier du bot (index.js, actions.js...)
const DATA = () => app.getPath('userData')
const FICHIER_CONFIG = () => path.join(DATA(), 'config.json')
const MAX_LOGS = 500

let fenetre = null
let botProc = null
let arretVoulu = false
let relanceTimer = null
let crashs = [] // heures des derniers plantages, pour ne pas relancer en boucle
let dernierEtat = null
const logs = []
const enAttente = new Map() // réponses du bot aux modifications de mémoire
let prochainId = 1

// ---------- réglages ----------
const DEFAUT = {
  nomBot: 'Claude',
  pseudo: '',
  hote: 'localhost',
  port: 25565,
  version: '',
  compte: 'offline',
  modele: 'claude-sonnet-5-5',
  effort: 'medium',
  budget: 3,
  repondreATous: false,
  caractere: '',
  style: '',
  regles: 'Ne casse jamais mes constructions et n\'attaque jamais de joueur.'
}

function lireConfig () {
  try { return { ...DEFAUT, ...JSON.parse(fs.readFileSync(FICHIER_CONFIG(), 'utf8')) } } catch (_) { return { ...DEFAUT } }
}
function ecrireConfig (c) {
  fs.mkdirSync(DATA(), { recursive: true })
  fs.writeFileSync(FICHIER_CONFIG(), JSON.stringify(c, null, 2))
}

// La clé API est chiffrée par Windows (safeStorage) : elle n'est jamais écrite en clair
function lireCle () {
  const c = lireConfig()
  try {
    if (c.cleChiffree && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(c.cleChiffree, 'base64'))
  } catch (_) {}
  return c.cleClaire || ''
}
function ecrireCle (cle) {
  const c = lireConfig()
  delete c.cleChiffree
  delete c.cleClaire
  if (cle) {
    if (safeStorage.isEncryptionAvailable()) c.cleChiffree = safeStorage.encryptString(cle).toString('base64')
    else c.cleClaire = cle
  }
  ecrireConfig(c)
}

// Premier lancement depuis le dossier du projet : on reprend le .env et la mémoire existants
function importerAncienBot () {
  if (fs.existsSync(FICHIER_CONFIG())) return
  const envFile = path.join(RACINE, '.env')
  if (fs.existsSync(envFile)) {
    try {
      const e = require('dotenv').parse(fs.readFileSync(envFile))
      const c = {
        ...DEFAUT,
        nomBot: e.MC_USERNAME || DEFAUT.nomBot,
        pseudo: e.OWNER && e.OWNER !== 'TonPseudo' ? e.OWNER : '',
        hote: e.MC_HOST || DEFAUT.hote,
        port: Number(e.MC_PORT) || DEFAUT.port,
        version: e.MC_VERSION || '',
        compte: e.MC_AUTH || 'offline',
        modele: e.MODEL || DEFAUT.modele,
        effort: e.EFFORT || DEFAUT.effort,
        budget: Number(e.BUDGET_USD) || DEFAUT.budget,
        repondreATous: e.RESPOND_ALL === 'true'
      }
      ecrireConfig(c)
      if (e.ANTHROPIC_API_KEY && !e.ANTHROPIC_API_KEY.startsWith('sk-ant-...')) ecrireCle(e.ANTHROPIC_API_KEY)
    } catch (_) {}
  }
  const ancienne = path.join(RACINE, 'memoire.json')
  const nouvelle = path.join(DATA(), 'memoire.json')
  if (fs.existsSync(ancienne) && !fs.existsSync(nouvelle)) {
    try { fs.mkdirSync(DATA(), { recursive: true }); fs.copyFileSync(ancienne, nouvelle) } catch (_) {}
  }
}

// ---------- journal ----------
function ajouterLog (ligne) {
  const l = String(ligne).replace(/\s+$/, '')
  if (!l) return
  const entree = { t: new Date().toLocaleTimeString('fr-FR'), texte: l }
  logs.push(entree)
  if (logs.length > MAX_LOGS) logs.shift()
  fenetre?.webContents.send('bot:log', entree)
}

function envoyerEtat () {
  const etat = {
    lance: !!botProc,
    ...(dernierEtat || {}),
    connecte: !!botProc && !!dernierEtat?.connecte
  }
  fenetre?.webContents.send('bot:etat', etat)
}

// ---------- le bot ----------
function demarrer () {
  if (botProc) return { ok: true }
  const c = lireConfig()
  const cle = lireCle()
  if (!cle) {
    ajouterLog('❌ Il manque la clé API : mets-la dans l\'onglet Connexion.')
    return { ok: false, erreur: 'cle' }
  }
  if (!c.pseudo) ajouterLog('⚠ Ton pseudo Minecraft n\'est pas rempli (onglet Connexion) : le bot ne répondra que si on dit son nom.')
  clearTimeout(relanceTimer)
  arretVoulu = false
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    MB_DATA_DIR: DATA(),
    ANTHROPIC_API_KEY: cle,
    MC_HOST: c.hote,
    MC_PORT: String(c.port),
    MC_USERNAME: c.nomBot,
    MC_AUTH: c.compte,
    MC_VERSION: c.version || '',
    OWNER: c.pseudo,
    MODEL: c.modele,
    EFFORT: c.effort,
    BUDGET_USD: String(c.budget),
    RESPOND_ALL: c.repondreATous ? 'true' : 'false',
    MB_CARACTERE: c.caractere || '',
    MB_STYLE: c.style || '',
    MB_REGLES: c.regles || ''
  }
  fs.mkdirSync(DATA(), { recursive: true })
  botProc = fork(path.join(RACINE, 'index.js'), [], { cwd: DATA(), env, silent: true })
  const lignes = (flux) => {
    let reste = ''
    flux.setEncoding('utf8')
    flux.on('data', (d) => {
      const parts = (reste + d).split(/\r?\n/)
      reste = parts.pop()
      for (const p of parts) ajouterLog(p)
    })
  }
  lignes(botProc.stdout)
  lignes(botProc.stderr)
  botProc.on('message', (m) => {
    if (m?.type === 'status') { dernierEtat = m.data; envoyerEtat() }
    if (m?.type === 'memoire' && enAttente.has(m.id)) { enAttente.get(m.id)(m); enAttente.delete(m.id) }
  })
  botProc.on('exit', (code) => {
    botProc = null
    dernierEtat = { ...(dernierEtat || {}), connecte: false }
    envoyerEtat()
    if (arretVoulu || code === 0) { ajouterLog('⏹ Bot arrêté.'); return }
    if (code === 2) return // clé API manquante : inutile de relancer
    crashs = crashs.filter(t => Date.now() - t < 5 * 60000)
    crashs.push(Date.now())
    const delai = crashs.length > 3 ? 60000 : 5000
    ajouterLog(`💥 Le bot s'est arrêté (code ${code}). Relance dans ${delai / 1000} s...`)
    relanceTimer = setTimeout(demarrer, delai)
  })
  ajouterLog('▶ Démarrage du bot...')
  envoyerEtat()
  return { ok: true }
}

function arreter () {
  clearTimeout(relanceTimer)
  arretVoulu = true
  if (!botProc) { envoyerEtat(); return { ok: true } }
  const p = botProc
  try { p.send({ type: 'stop' }) } catch (_) {}
  setTimeout(() => { try { p.kill() } catch (_) {} }, 2000)
  return { ok: true }
}

// ---------- mémoire ----------
function memoireDirecte () {
  process.env.MB_DATA_DIR = DATA()
  return require(path.join(RACINE, 'memoire.js')).createMemoire()
}

async function operationMemoire (op, args) {
  // bot lancé : c'est lui qui modifie sa mémoire (sinon il écraserait nos changements)
  if (botProc?.connected) {
    const id = prochainId++
    const rep = await new Promise((resolve) => {
      enAttente.set(id, resolve)
      botProc.send({ type: 'memoire', op, args, id })
      setTimeout(() => { if (enAttente.has(id)) { enAttente.delete(id); resolve({ ok: false, error: 'Le bot ne répond pas' }) } }, 4000)
    })
    if (rep.ok) return { ok: true, data: rep.data }
    return { ok: false, erreur: rep.error }
  }
  const m = memoireDirecte()
  if (op === 'setLieu') m.setLieu(args.nom, { x: Number(args.x), y: Number(args.y), z: Number(args.z) }, args.dimension || 'overworld')
  else if (op === 'removeLieu') m.removeLieu(args.nom)
  else if (op === 'addSouvenir') m.addSouvenir(args.texte)
  else if (op === 'editSouvenir') m.editSouvenir(args.index, args.texte)
  else if (op === 'removeSouvenir') m.removeSouvenir(args.index)
  else if (op === 'toutEffacer') m.toutEffacer()
  else if (op === 'setReglage') m.setReglage(args.nom, args.valeur)
  return { ok: true, data: m.export() }
}

// ---------- fenêtre ----------
function creerFenetre () {
  fenetre = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: '#17181b',
    title: 'MineBuddy',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  fenetre.removeMenu()
  fenetre.loadFile(path.join(__dirname, 'ui', 'index.html'))
  // les liens s'ouvrent dans le navigateur, jamais dans l'appli
  fenetre.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  fenetre.on('closed', () => { fenetre = null })
  // Pour les tests : MB_CAPTURE=dossier photographie chaque écran puis ferme l'appli
  if (process.env.MB_CAPTURE) {
    fenetre.webContents.once('did-finish-load', async () => {
      const dossier = process.env.MB_CAPTURE
      fs.mkdirSync(dossier, { recursive: true })
      const photo = async (nom) => {
        const img = await fenetre.webContents.capturePage()
        fs.writeFileSync(path.join(dossier, `${nom}.png`), img.toPNG())
      }
      await new Promise(r => setTimeout(r, 1500))
      for (const page of ['pilotage', 'connexion', 'memoire', 'personnalite']) {
        await fenetre.webContents.executeJavaScript(`document.querySelector('[data-page=${page}]').click()`)
        await new Promise(r => setTimeout(r, 900))
        await photo(page)
      }
      // MB_CAPTURE_BOT=1 : démarre aussi le bot et photographie le pilotage 12 s plus tard
      if (process.env.MB_CAPTURE_BOT) {
        await fenetre.webContents.executeJavaScript('document.querySelector(\'[data-page=pilotage]\').click(); document.querySelector(\'#btn-demarrer\').click()')
        await new Promise(r => setTimeout(r, 12000))
        await photo('pilotage-bot')
        arreter()
        await new Promise(r => setTimeout(r, 2500))
      }
      app.quit()
    })
  }
}

ipcMain.handle('config:lire', () => {
  const c = lireConfig()
  delete c.cleChiffree
  delete c.cleClaire
  return { ...c, aUneCle: !!lireCle() }
})
ipcMain.handle('config:ecrire', (e, nouveau) => {
  const c = lireConfig()
  for (const k of Object.keys(DEFAUT)) if (k in nouveau) c[k] = nouveau[k]
  c.port = Number(c.port) || 25565
  c.budget = Math.max(0, Number(c.budget) || 0)
  ecrireConfig(c)
  return { ok: true }
})
ipcMain.handle('cle:ecrire', (e, cle) => { ecrireCle(String(cle || '').trim()); return { ok: true } })
ipcMain.handle('cle:tester', async (e, cle) => {
  const k = String(cle || '').trim() || lireCle()
  if (!k) return { ok: false, erreur: 'Aucune clé à tester.' }
  try {
    const Anthropic = require('@anthropic-ai/sdk')
    const client = new (Anthropic.default || Anthropic)({ apiKey: k })
    await client.models.list({ limit: 1 })
    return { ok: true }
  } catch (err) {
    const s = err?.status
    return { ok: false, erreur: s === 401 ? 'Clé refusée : vérifie qu\'elle est complète.' : `Test impossible (${err?.message || err}).` }
  }
})
ipcMain.handle('bot:demarrer', () => demarrer())
ipcMain.handle('bot:arreter', () => arreter())
ipcMain.handle('bot:redemarrer', async () => {
  arreter()
  await new Promise(r => setTimeout(r, 2500))
  return demarrer()
})
ipcMain.handle('bot:dire', (e, texte) => {
  const t = String(texte || '').trim()
  if (!t) return { ok: false }
  if (!botProc?.connected) return { ok: false, erreur: 'Le bot n\'est pas lancé.' }
  botProc.send({ type: 'say', text: t })
  return { ok: true }
})
ipcMain.handle('bot:etat', () => ({ lance: !!botProc, ...(dernierEtat || {}), connecte: !!botProc && !!dernierEtat?.connecte }))
ipcMain.handle('logs:lire', () => logs)
ipcMain.handle('memoire:lire', () => {
  try { return { ok: true, data: memoireDirecte().export() } } catch (e) { return { ok: false, erreur: e.message } }
})
ipcMain.handle('memoire:op', (e, op, args) => operationMemoire(op, args || {}))
ipcMain.handle('lien:ouvrir', (e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url) })
ipcMain.handle('dossier:ouvrir', () => shell.openPath(DATA()))

app.setAppUserModelId('com.aiko74.minebuddy')
app.whenReady().then(() => {
  importerAncienBot()
  creerFenetre()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) creerFenetre() })
})
app.on('window-all-closed', () => {
  arreter()
  setTimeout(() => app.quit(), 600)
})
