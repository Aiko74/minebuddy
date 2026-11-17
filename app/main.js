'use strict'
// MineBuddy — l'appli de bureau qui règle et lance le bot.
// Elle garde les réglages dans le dossier de l'utilisateur (%APPDATA%\MineBuddy), lance le bot
// en arrière-plan, et affiche ce qu'il fait en direct.

const { app, BrowserWindow, ipcMain, safeStorage, shell, Tray, Menu, nativeImage, Notification } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const dgram = require('dgram')
const { fork } = require('child_process')

// Pour les tests : MB_USERDATA=dossier utilise des réglages à part (ne touche pas aux vrais)
if (process.env.MB_USERDATA) app.setPath('userData', process.env.MB_USERDATA)
// photos d'écran de test : sans la carte graphique, les captures sont plus fiables
if (process.env.MB_CAPTURE) app.disableHardwareAcceleration()

const RACINE = path.join(__dirname, '..') // dossier du bot (index.js, actions.js...)
const ICONE = path.join(__dirname, '..', 'build', 'icon.png')
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
  regles: 'Ne casse jamais mes constructions et n\'attaque jamais de joueur.',
  arrierePlan: true, // fermer la fenêtre laisse le bot jouer (icône près de l'horloge)
  guideVu: false // le guide des premiers pas a été fait ou passé
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
  majTray()
}

// ---------- mondes LAN ----------
// Quand on ouvre un monde en LAN, Minecraft l'annonce sur le réseau toutes les 1,5 s
// (message « [MOTD]nom du monde[/MOTD][AD]port[/AD] » vers 224.0.2.60:4445).
// On écoute ces annonces : plus besoin de recopier le port à la main.
const mondesLan = new Map() // "hote:port" -> { motd, hote, port, vu }
let lanSocket = null

function adressesLocales () {
  const s = new Set(['127.0.0.1', '::1'])
  for (const liste of Object.values(os.networkInterfaces())) for (const a of liste || []) s.add(a.address)
  return s
}
const listeMondes = () => [...mondesLan.values()].map(({ motd, hote, port }) => ({ motd, hote, port }))
function envoyerMondes () { fenetre?.webContents.send('lan:mondes', listeMondes()) }

function ecouterLan () {
  try {
    lanSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    lanSocket.on('error', () => { try { lanSocket.close() } catch (_) {} lanSocket = null })
    lanSocket.on('message', (msg, rinfo) => {
      const t = msg.toString('utf8')
      const port = Number(/\[AD\](\d+)\[\/AD\]/.exec(t)?.[1])
      if (!port || port > 65535) return
      const motd = (/\[MOTD\]([\s\S]*?)\[\/MOTD\]/.exec(t)?.[1] || 'Monde LAN').replace(/§./g, '').trim().slice(0, 80)
      const hote = adressesLocales().has(rinfo.address) ? 'localhost' : rinfo.address
      const cle = `${hote}:${port}`
      const nouveau = !mondesLan.has(cle)
      mondesLan.set(cle, { motd, hote, port, vu: Date.now() })
      if (nouveau) { envoyerMondes(); adopterMonde() }
    })
    lanSocket.bind(4445, () => {
      // on écoute sur chaque carte réseau (Minecraft annonce sur celle par défaut)
      try { lanSocket.addMembership('224.0.2.60') } catch (_) {}
      for (const liste of Object.values(os.networkInterfaces())) {
        for (const a of liste || []) {
          if (a.family === 'IPv4' || a.family === 4) { try { lanSocket.addMembership('224.0.2.60', a.address) } catch (_) {} }
        }
      }
    })
  } catch (_) { lanSocket = null }
  // un monde qui ne s'annonce plus depuis 6 s est fermé
  setInterval(() => {
    let change = false
    for (const [k, m] of mondesLan) if (Date.now() - m.vu > 6000) { mondesLan.delete(k); change = true }
    if (change) envoyerMondes()
  }, 2000)
}

// adresse « à la maison » (pas un serveur sur Internet) : on peut la remplacer par le monde trouvé
const adresseLocale = (h) => !h || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)

// Un seul monde ouvert en LAN : on l'utilise tout seul (et on relance le bot s'il cherchait ailleurs)
function adopterMonde (force) {
  const liste = [...mondesLan.values()]
  const m = force || (liste.length === 1 ? liste[0] : null)
  if (!m) return { ok: false }
  const c = lireConfig()
  if (!force && !adresseLocale(c.hote)) return { ok: false } // il joue sur un serveur : on ne touche à rien
  if (c.hote === m.hote && Number(c.port) === m.port) return { ok: true }
  if (!force && botProc && dernierEtat?.connecte) return { ok: false } // déjà en jeu : on ne le coupe pas
  c.hote = m.hote
  c.port = m.port
  ecrireConfig(c)
  ajouterLog(`📡 Monde LAN trouvé : « ${m.motd} » (port ${m.port}). Je l'utilise.`)
  fenetre?.webContents.send('config:change')
  if (botProc) { arreter(); setTimeout(demarrer, 2500) }
  return { ok: true }
}

// ---------- icône près de l'horloge ----------
let tray = null
let quitter = false
let dejaPrevenu = false
let cleTray = ''

function montrerFenetre () {
  if (!fenetre) return creerFenetre()
  if (fenetre.isMinimized()) fenetre.restore()
  fenetre.show()
  fenetre.focus()
}
function toutQuitter () {
  quitter = true
  arreter()
  setTimeout(() => app.quit(), 900)
}
function creerTray () {
  try {
    tray = new Tray(nativeImage.createFromPath(ICONE).resize({ width: 16, height: 16 }))
    tray.on('click', montrerFenetre)
    majTray()
  } catch (_) { tray = null }
}
function majTray () {
  if (!tray) return
  const lance = !!botProc
  const connecte = lance && !!dernierEtat?.connecte
  const cle = `${lance}-${connecte}`
  if (cle === cleTray) return
  cleTray = cle
  tray.setToolTip(`MineBuddy : ${connecte ? 'le bot joue' : lance ? 'connexion au monde…' : 'bot arrêté'}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir MineBuddy', click: montrerFenetre },
    { type: 'separator' },
    lance ? { label: 'Arrêter le bot', click: () => arreter() } : { label: 'Démarrer le bot', click: () => demarrer() },
    { type: 'separator' },
    { label: 'Quitter MineBuddy', click: toutQuitter }
  ]))
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
  if (lanSocket && !mondesLan.size && adresseLocale(c.hote)) ajouterLog('📡 Aucun monde LAN repéré pour l\'instant : ouvre ton monde en LAN (Échap > Ouvrir au réseau local), je trouverai le port tout seul.')
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
  // fermer la fenêtre pendant que le bot joue : il continue en arrière-plan (icône près de l'horloge)
  fenetre.on('close', (ev) => {
    if (quitter || !botProc || !tray || lireConfig().arrierePlan === false) return
    ev.preventDefault()
    fenetre.hide()
    if (!dejaPrevenu && Notification.isSupported()) {
      dejaPrevenu = true
      new Notification({ title: 'MineBuddy continue de jouer', body: 'Le bot reste dans ton monde. Clique sur l\'icône près de l\'horloge pour revenir ou tout arrêter.', icon: ICONE }).show()
    }
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
      const js = (code) => fenetre.webContents.executeJavaScript(code)
      await new Promise(r => setTimeout(r, 1500))
      // le guide des premiers pas, s'il s'affiche
      if (await js('!document.querySelector(\'#guide\').hidden')) {
        for (const n of [1, 2, 3]) {
          await js(`guideAller(${n})`)
          await new Promise(r => setTimeout(r, 2500))
          await photo(`guide-${n}`)
        }
        await js('fermerGuide()')
      }
      // MB_DEMO=1 : état de démonstration (inventaire, action) pour vérifier l'écran Pilotage sans monde ouvert
      if (process.env.MB_DEMO) {
        fenetre.webContents.send('bot:etat', {
          lance: true, connecte: true, nom: 'Claude', adresse: 'localhost:50211', position: { x: -7, y: 76, z: -133 }, dimension: 'minecraft:overworld',
          vie: 18, faim: 15, modele: 'claude-sonnet-5-5', depense: 0.42, budget: 3, jour: true, reflechit: false,
          mission: 'trouver 5 diamants', action: { nom: 'miner_galerie', input: { longueur: 40 } },
          equipement: { tete: 'iron_helmet', torse: 'iron_chestplate', jambes: null, pieds: 'iron_boots', main: 'iron_pickaxe' },
          inventaire: [{ nom: 'cobblestone', nombre: 143 }, { nom: 'oak_log', nombre: 24 }, { nom: 'torch', nombre: 31 }, { nom: 'cooked_beef', nombre: 12 }, { nom: 'iron_ingot', nombre: 9 }, { nom: 'diamond', nombre: 3 }, { nom: 'coal', nombre: 17 }, { nom: 'stone_pickaxe', nombre: 1 }, { nom: 'red_bed', nombre: 1 }, { nom: 'water_bucket', nombre: 1 }, { nom: 'raw_gold', nombre: 4 }, { nom: 'redstone', nombre: 22 }]
        })
        await new Promise(r => setTimeout(r, 800))
        await photo('pilotage-demo')
      }
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
      // MB_TEST_FOND=1 : bot lancé, on ferme la fenêtre → elle doit se cacher et le bot continuer
      if (process.env.MB_TEST_FOND) {
        demarrer()
        await new Promise(r => setTimeout(r, 1500))
        fenetre.close()
        await new Promise(r => setTimeout(r, 1500))
        const res = { fenetreGardee: !!fenetre && !fenetre.isDestroyed(), visible: !!fenetre?.isVisible(), botTourne: !!botProc, icone: !!tray, prevenu: dejaPrevenu }
        montrerFenetre()
        await new Promise(r => setTimeout(r, 500))
        res.revientAuClic = !!fenetre?.isVisible()
        fs.writeFileSync(path.join(dossier, 'test-fond.json'), JSON.stringify(res, null, 2))
        arreter()
        await new Promise(r => setTimeout(r, 2500))
      }
      quitter = true
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
ipcMain.handle('lan:mondes', () => ({ ecoute: !!lanSocket, mondes: listeMondes() }))
ipcMain.handle('lan:utiliser', (e, m) => {
  const port = Number(m?.port)
  if (!port || port > 65535) return { ok: false }
  return adopterMonde({ motd: String(m.motd || 'Monde LAN').slice(0, 80), hote: String(m.hote || 'localhost'), port })
})

// une seule MineBuddy à la fois : la relancer remontre la fenêtre déjà ouverte
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', montrerFenetre)
  app.setAppUserModelId('com.aiko74.minebuddy')
  app.whenReady().then(() => {
    importerAncienBot()
    creerFenetre()
    if (!process.env.MB_CAPTURE || process.env.MB_TEST_FOND) creerTray()
    ecouterLan()
    app.on('activate', montrerFenetre)
  })
}
app.on('before-quit', () => { quitter = true })
app.on('window-all-closed', () => {
  arreter()
  setTimeout(() => app.quit(), 600)
})
