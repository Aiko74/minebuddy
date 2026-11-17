'use strict'
/* global mb */
// Interface de MineBuddy : navigation, pilotage du bot, réglages, mémoire, personnalité et guide des premiers pas.

// ---------- petites icônes (traits simples, couleur du texte) ----------
const ICONES = {
  robot: '<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 4v4M9 13h.01M15 13h.01M9 16.5h6"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  plug: '<path d="M7 12l5 5M17 7l-5 5M9 3v4M15 17v4M3 9h4M17 15h4M6.5 17.5l-2 2M19.5 4.5l-2 2"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8.5 14.5a4.5 4.5 0 0 0 7 0"/>',
  send: '<path d="M4 12L20 4l-6 16-3-7z"/><path d="M11 13l9-9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  trash: '<path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  coeur: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>'
}
const svg = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONES[n] || ''}</svg>`
const posIcones = (racine = document) => racine.querySelectorAll('[data-ic]').forEach(el => { el.innerHTML = svg(el.dataset.ic) })
posIcones()

const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const NOMS_MODELES = { 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-opus-5-5': 'Opus 5.5' }
const dollars = (n) => (Number(n) || 0).toFixed(2).replace('.', ',') + ' $'
const NOM_VALIDE = /^[A-Za-z0-9_]{3,16}$/ // règle de Minecraft pour les pseudos

// ---------- noms des objets en français ----------
const OBJETS = {
  oak_log: 'Bûche de chêne', spruce_log: 'Bûche de sapin', birch_log: 'Bûche de bouleau', jungle_log: 'Bûche d\'acajou', acacia_log: 'Bûche d\'acacia', dark_oak_log: 'Bûche de chêne noir', cherry_log: 'Bûche de cerisier', mangrove_log: 'Bûche de palétuvier',
  oak_planks: 'Planches de chêne', spruce_planks: 'Planches de sapin', birch_planks: 'Planches de bouleau', stick: 'Bâton',
  cobblestone: 'Pierre taillée', stone: 'Roche', cobbled_deepslate: 'Ardoise des abîmes taillée', deepslate: 'Ardoise des abîmes', dirt: 'Terre', grass_block: 'Bloc d\'herbe', sand: 'Sable', gravel: 'Gravier',
  andesite: 'Andésite', diorite: 'Diorite', granite: 'Granite', tuff: 'Tuf', netherrack: 'Netherrack', obsidian: 'Obsidienne', glass: 'Verre', crying_obsidian: 'Obsidienne pleureuse',
  coal: 'Charbon', charcoal: 'Charbon de bois', iron_ingot: 'Lingot de fer', raw_iron: 'Fer brut', gold_ingot: 'Lingot d\'or', raw_gold: 'Or brut', copper_ingot: 'Lingot de cuivre', raw_copper: 'Cuivre brut',
  diamond: 'Diamant', emerald: 'Émeraude', redstone: 'Poudre de redstone', lapis_lazuli: 'Lapis-lazuli', quartz: 'Quartz du Nether', netherite_ingot: 'Lingot de netherite', gold_nugget: 'Pépite d\'or', iron_nugget: 'Pépite de fer',
  torch: 'Torche', crafting_table: 'Établi', furnace: 'Fourneau', chest: 'Coffre', ladder: 'Échelle', enchanting_table: 'Table d\'enchantement', anvil: 'Enclume',
  wooden_pickaxe: 'Pioche en bois', stone_pickaxe: 'Pioche en pierre', iron_pickaxe: 'Pioche en fer', golden_pickaxe: 'Pioche en or', diamond_pickaxe: 'Pioche en diamant', netherite_pickaxe: 'Pioche en netherite',
  wooden_axe: 'Hache en bois', stone_axe: 'Hache en pierre', iron_axe: 'Hache en fer', diamond_axe: 'Hache en diamant',
  wooden_sword: 'Épée en bois', stone_sword: 'Épée en pierre', iron_sword: 'Épée en fer', golden_sword: 'Épée en or', diamond_sword: 'Épée en diamant', netherite_sword: 'Épée en netherite',
  wooden_shovel: 'Pelle en bois', stone_shovel: 'Pelle en pierre', iron_shovel: 'Pelle en fer', diamond_shovel: 'Pelle en diamant', wooden_hoe: 'Houe en bois', stone_hoe: 'Houe en pierre', iron_hoe: 'Houe en fer',
  leather_helmet: 'Chapeau en cuir', leather_chestplate: 'Tunique en cuir', leather_leggings: 'Pantalon en cuir', leather_boots: 'Bottes en cuir',
  iron_helmet: 'Casque en fer', iron_chestplate: 'Plastron en fer', iron_leggings: 'Jambières en fer', iron_boots: 'Bottes en fer',
  golden_helmet: 'Casque en or', golden_chestplate: 'Plastron en or', golden_leggings: 'Jambières en or', golden_boots: 'Bottes en or',
  chainmail_helmet: 'Casque en mailles', chainmail_chestplate: 'Cotte de mailles', chainmail_leggings: 'Jambières en mailles', chainmail_boots: 'Bottes en mailles',
  diamond_helmet: 'Casque en diamant', diamond_chestplate: 'Plastron en diamant', diamond_leggings: 'Jambières en diamant', diamond_boots: 'Bottes en diamant',
  netherite_helmet: 'Casque en netherite', netherite_chestplate: 'Plastron en netherite', netherite_leggings: 'Jambières en netherite', netherite_boots: 'Bottes en netherite',
  shield: 'Bouclier', bow: 'Arc', arrow: 'Flèche', crossbow: 'Arbalète', totem_of_undying: 'Totem d\'immortalité',
  bucket: 'Seau', water_bucket: 'Seau d\'eau', lava_bucket: 'Seau de lave', milk_bucket: 'Seau de lait', flint_and_steel: 'Briquet', flint: 'Silex',
  fishing_rod: 'Canne à pêche', shears: 'Cisailles', compass: 'Boussole', clock: 'Montre', map: 'Carte vierge', filled_map: 'Carte',
  cooked_beef: 'Steak', beef: 'Bœuf cru', cooked_porkchop: 'Côtelette de porc cuite', porkchop: 'Côtelette de porc crue', cooked_chicken: 'Poulet cuit', chicken: 'Poulet cru',
  cooked_mutton: 'Mouton cuit', mutton: 'Mouton cru', cooked_cod: 'Morue cuite', cod: 'Morue crue', cooked_salmon: 'Saumon cuit', salmon: 'Saumon cru',
  bread: 'Pain', apple: 'Pomme', golden_apple: 'Pomme dorée', carrot: 'Carotte', potato: 'Pomme de terre', baked_potato: 'Pomme de terre cuite', wheat: 'Blé', wheat_seeds: 'Graines de blé', rotten_flesh: 'Chair putréfiée',
  bone: 'Os', string: 'Ficelle', gunpowder: 'Poudre à canon', spider_eye: 'Œil d\'araignée', ender_pearl: 'Perle de l\'Ender', ender_eye: 'Œil de l\'Ender', blaze_rod: 'Bâton de blaze', blaze_powder: 'Poudre de blaze',
  leather: 'Cuir', feather: 'Plume', paper: 'Papier', book: 'Livre', sugar_cane: 'Canne à sucre', oak_sapling: 'Pousse de chêne', oak_door: 'Porte en chêne', oak_fence: 'Barrière en chêne', oak_fence_gate: 'Portillon en chêne'
}
function nomObjet (id) {
  const n = String(id || '').replace(/^minecraft:/, '')
  if (OBJETS[n]) return OBJETS[n]
  if (/_bed$/.test(n)) return 'Lit'
  if (/_wool$/.test(n)) return 'Laine'
  if (/_log$/.test(n)) return 'Bûche'
  if (/_planks$/.test(n)) return 'Planches'
  const t = n.replace(/_/g, ' ')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

// ---------- ce que fait le bot, en français ----------
const PHRASES = {
  suivre: 'Suit', venir: 'Vient te rejoindre', aller_a: 'Marche vers un endroit', arreter: 'S\'arrête', regarder_autour: 'Regarde autour de lui',
  recolter: 'Récolte', creuser: 'Creuse', creuser_tunnel: 'Creuse un tunnel', fabriquer: 'Fabrique', cuire: 'Fait cuire', poser: 'Pose un bloc',
  construire: 'Construit', utiliser_bloc: 'Utilise un bloc', donner: 'Donne un objet', ramasser: 'Ramasse des objets', attaquer: 'Se bat contre', chasser: 'Chasse',
  manger: 'Mange', equiper: 'S\'équipe', dormir: 'Dort', se_reveiller: 'Se réveille', coffre_contenu: 'Regarde dans un coffre', coffre_deposer: 'Range dans un coffre',
  coffre_prendre: 'Prend dans un coffre', planter: 'Plante', moissonner: 'Moissonne', pecher: 'Pêche', defense: 'Se défend', sauter: 'Saute', regarder_joueur: 'Te regarde',
  memoriser_lieu: 'Retient un lieu', aller_au_lieu: 'Va au lieu', oublier_lieu: 'Oublie un lieu', retenir: 'Retient quelque chose', mode_autonome: 'Change de mode',
  commencer_mission: 'Commence une mission', terminer_mission: 'Termine sa mission', explorer: 'Explore', construire_plusieurs: 'Construit', construire_cabane: 'Construit une cabane',
  chercher_terrain: 'Cherche un terrain', aplanir: 'Aplanit le terrain', construire_maison: 'Construit une maison', construire_enclos: 'Construit un enclos',
  attirer_animaux: 'Attire des animaux', reproduire: 'Fait se reproduire les animaux', descendre: 'Descend à la mine', miner_galerie: 'Mine une galerie', enchanter: 'Enchante',
  voyager: 'Voyage', remplir_seau: 'Remplit un seau', faire_obsidienne: 'Fait de l\'obsidienne', construire_portail: 'Construit un portail', utiliser_portail: 'Passe le portail',
  commercer: 'Commerce avec un villageois', troquer_piglins: 'Troque avec les piglins', lancer_oeil: 'Lance un œil de l\'Ender', remplir_portail_end: 'Remplit le portail de l\'End',
  pont: 'Construit un pont', abri_express: 'Se fait un abri', remonter: 'Remonte à la surface', tirer: 'Tire à l\'arc', combattre_dragon: 'Combat le dragon !', ouvrir_cage: 'Ouvre une cage'
}
function texteActivite (e) {
  if (e.action?.nom) {
    const base = PHRASES[e.action.nom] || e.action.nom.replace(/_/g, ' ')
    const i = e.action.input || {}
    const quoi = i.bloc || i.objet || i.cible || i.joueur || i.nom
    if (typeof quoi !== 'string' || !quoi) return base
    if (i.joueur || i.nom) return `${base} « ${quoi} »`
    return `${base} : ${nomObjet(quoi).toLowerCase()}`
  }
  if (e.reflechit) return 'Réfléchit…'
  if (e.suit) return e.suit === config?.pseudo ? 'Te suit' : `Suit ${e.suit}`
  return 'Attend, prêt à jouer'
}

// ---------- navigation ----------
let pageActuelle = 'pilotage'
function allerA (page) {
  document.querySelectorAll('.nv').forEach(b => b.classList.toggle('on', b.dataset.page === page))
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === `page-${page}`))
  if (page === 'memoire' || page === 'carte') chargerMemoire()
  // le bot ne calcule la carte que si on la regarde
  if ((page === 'carte') !== (pageActuelle === 'carte')) mb.carteVisible(page === 'carte')
  pageActuelle = page
  if (page === 'carte') dessinerCarte()
}
document.querySelectorAll('.nv').forEach(b => b.addEventListener('click', () => allerA(b.dataset.page)))
document.querySelectorAll('[data-aller]').forEach(b => b.addEventListener('click', () => allerA(b.dataset.aller)))

// ---------- pilotage : état ----------
let etatBot = { lance: false, connecte: false }
function afficherEtat (s) {
  etatBot = s || etatBot
  const e = etatBot
  const nom = e.nom || config?.nomBot || 'Claude'
  $('#etat-nom').textContent = nom
  $('#avatar').textContent = nom.slice(0, 1).toUpperCase()
  const badge = $('#etat-badge')
  badge.className = 'badge' + (e.connecte ? ' ok' : e.lance ? ' attente' : '')
  badge.textContent = e.connecte ? 'Connecté' : e.lance ? 'Connexion…' : 'Arrêté'
  const ou = []
  if (e.adresse) ou.push(e.adresse)
  if (e.connecte && e.position) ou.push(`${e.position.x} ${e.position.y} ${e.position.z}`)
  if (e.connecte && e.dimension) ou.push(/nether/.test(e.dimension) ? 'Nether' : /end/.test(e.dimension) ? 'End' : 'Monde normal')
  if (e.connecte && e.jour != null) ou.push(e.jour ? 'Jour' : 'Nuit')
  $('#etat-ou').textContent = ou.join(' · ') || (config ? `${config.hote}:${config.port}` : '—')
  // en ce moment
  const act = $('#activite')
  act.hidden = !e.connecte
  if (e.connecte) {
    act.innerHTML = `<span>En ce moment : <span class="act">${esc(texteActivite(e))}</span></span>` +
      (e.mission ? `<span class="mis">Mission : ${esc(e.mission)}</span>` : '')
  }
  const vie = e.connecte ? e.vie : null
  const faim = e.connecte ? e.faim : null
  $('#bar-vie').style.width = vie == null ? '0' : `${Math.max(0, Math.min(20, vie)) * 5}%`
  $('#bar-faim').style.width = faim == null ? '0' : `${Math.max(0, Math.min(20, faim)) * 5}%`
  $('#txt-vie').textContent = vie == null ? '—' : `${vie}/20`
  $('#txt-faim').textContent = faim == null ? '—' : `${faim}/20`
  $('#btn-demarrer').disabled = !!e.lance
  $('#btn-arreter').disabled = !e.lance
  $('#btn-redemarrer').hidden = !e.lance
  const modele = e.modele || config?.modele
  $('#pied-modele').textContent = `Cerveau : ${NOMS_MODELES[modele] || modele || '—'}`
  // bot arrêté : la dépense du jour vient de sa mémoire (elle y est gardée)
  const d = memoire?.reglages?.depense
  const depense = e.depense ?? (d && d.jour === new Date().toLocaleDateString('fr-FR') ? d.usd : 0)
  $('#pied-depense').textContent = `Aujourd'hui : ${dollars(depense)} / ${dollars(e.lance ? (e.budget ?? config?.budget) : config?.budget)}`
  afficherPoches(e)
  afficherMondePilotage()
  if (pageActuelle === 'carte') dessinerCarte()
}
mb.surEtat(afficherEtat)

// équipement et inventaire (seulement quand il est en jeu)
const EQUIP = [['tete', 'Casque'], ['torse', 'Plastron'], ['jambes', 'Jambières'], ['pieds', 'Bottes'], ['main', 'En main']]
let derniersPoches = ''
function afficherPoches (e) {
  const cle = JSON.stringify([e.connecte, e.equipement, e.inventaire])
  if (cle === derniersPoches) return // rien n'a changé : on ne redessine pas
  derniersPoches = cle
  if (!e.connecte || !e.inventaire) {
    $('#equip').innerHTML = '<div class="vide">Visible quand il est en jeu.</div>'
    $('#inv').innerHTML = ''
    $('#inv-total').textContent = ''
    return
  }
  const eq = e.equipement || {}
  $('#equip').innerHTML = EQUIP.map(([k, lab]) => `<div><span class="lab">${lab}</span>${eq[k]
    ? `<span class="obj" title="${esc(nomObjet(eq[k]))}">${esc(nomObjet(eq[k]))}</span>`
    : '<span class="obj rien">rien</span>'}</div>`).join('')
  const inv = e.inventaire
  $('#inv-total').textContent = inv.length ? `${inv.length} sortes` : ''
  $('#inv').innerHTML = inv.length
    ? inv.map(o => `<div><span class="obj" title="${esc(nomObjet(o.nom))}">${esc(nomObjet(o.nom))}</span><span class="nb">×${o.nombre}</span></div>`).join('')
    : '<div class="vide">Ses poches sont vides.</div>'
}

$('#btn-demarrer').addEventListener('click', async () => {
  const r = await mb.demarrer()
  if (!r.ok && r.erreur === 'cle') allerA('connexion')
})
$('#btn-arreter').addEventListener('click', () => mb.arreter())

// ---------- pilotage : journal ----------
const CACHES = /^(🧠|📝|🤫|🛠|🧱|🧭|🔧|🎒|🏹|📦|🔎)|deprecated event|^\s*at |^\s*[{}[\]]/
function classer (texte) {
  const t = texte.trim()
  if (/^🤖/.test(t)) return 'parle'
  if (/^⚙/.test(t)) return 'action'
  if (/^(💀|❌|💥)/.test(t)) return 'mort'
  if (/^(⚠)/.test(t)) return 'err'
  if (/^(❤|🫧|🕳|🏃)/.test(t)) return 'vie'
  if (/^(✅|🔄|🔑|🔌|▶|⏹|💸|💬|📡|⬆)/.test(t)) return 'info'
  return 'detail'
}
function ligneJournal (l) {
  const t = l.texte.trim()
  const div = document.createElement('div')
  const cls = classer(t)
  div.className = `lg ${cls}`
  if (CACHES.test(t) || cls === 'detail') div.dataset.detail = '1'
  if (div.dataset.detail && !$('#chk-details').checked) div.hidden = true
  const court = t.length > 260 ? t.slice(0, 260) + '…' : t
  div.innerHTML = `<span class="lg-t">${esc(l.t.slice(0, 5))}</span><span class="lg-x">${esc(court)}</span>`
  return div
}
function ajouterJournal (l) {
  const j = $('#journal')
  const enBas = j.scrollTop + j.clientHeight >= j.scrollHeight - 30
  j.appendChild(ligneJournal(l))
  while (j.children.length > 500) j.firstChild.remove()
  if (enBas) j.scrollTop = j.scrollHeight
}
mb.surLog(ajouterJournal)
$('#chk-details').addEventListener('change', (e) => {
  document.querySelectorAll('#journal [data-detail]').forEach(d => { d.hidden = !e.target.checked })
})

$('#form-dire').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const champ = $('#txt-dire')
  const texte = champ.value.trim()
  $('#err-dire').textContent = ''
  if (!texte) { $('#err-dire').textContent = 'Écris un message d\'abord.'; return }
  const r = await mb.dire(texte)
  if (!r.ok) { $('#err-dire').textContent = r.erreur || 'Message non envoyé.'; return }
  champ.value = ''
})
$('#txt-dire').addEventListener('input', () => { $('#err-dire').textContent = '' })

// ---------- mondes LAN trouvés tout seuls ----------
let mondes = []
let lanEcoute = false
const adresseLocale = (h) => !h || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)
const estUtilise = (m) => config && config.hote === m.hote && Number(config.port) === m.port
function afficherMondes () {
  $('#lan-liste').innerHTML = mondes.length
    ? mondes.map((m, i) => `<div class="monde"><span class="pulse"></span><span class="m-nom" title="${esc(m.motd)}">${esc(m.motd)}</span><span class="coords">${esc(m.hote)}:${m.port}</span>${estUtilise(m)
      ? '<span class="badge ok">utilisé</span>'
      : `<button type="button" class="bt" data-monde="${i}">Utiliser</button>`}</div>`).join('')
    : `<div class="vide">${lanEcoute ? 'Aucun pour l\'instant. Ouvre ton monde en LAN : il apparaîtra ici et le port sera rempli tout seul.' : 'La recherche automatique ne marche pas sur ce PC : entre le port à la main.'}</div>`
  afficherMondePilotage()
  afficherMondeGuide()
}
function afficherMondePilotage () {
  const el = $('#etat-monde')
  if (!el) return
  if (etatBot.connecte || !lanEcoute || !config || !adresseLocale(config.hote)) { el.hidden = true; return }
  el.hidden = false
  const utilise = mondes.find(estUtilise)
  if (utilise) el.innerHTML = `<span class="pulse"></span><span>Monde trouvé : « ${esc(utilise.motd)} »</span>`
  else if (mondes.length > 1) el.innerHTML = '<span class="pulse"></span><span>Plusieurs mondes ouverts : choisis le tien dans Connexion.</span>'
  else el.innerHTML = '<span class="pulse eteint"></span><span>Aucun monde ouvert en LAN. Dans Minecraft : Échap, puis Ouvrir au réseau local.</span>'
}
$('#lan-liste').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-monde]')
  if (!b) return
  await mb.utiliserMonde(mondes[Number(b.dataset.monde)])
  await chargerConfig()
})
mb.surMondes((m) => { mondes = m || []; afficherMondes() })
// le port a été rempli tout seul : on met à jour l'écran sans toucher au reste du formulaire
mb.surConfig(async () => {
  config = await mb.lireConfig()
  const f = $('#form-connexion')
  f.elements.hote.value = config.hote
  f.elements.port.value = config.port
  afficherMondes()
  afficherEtat()
})

// ---------- connexion ----------
let config = null
async function chargerConfig () {
  config = await mb.lireConfig()
  const f = $('#form-connexion')
  for (const [k, v] of Object.entries(config)) {
    const el = f.elements[k]
    if (!el) continue
    if (el.type === 'checkbox') el.checked = !!v
    else el.value = v ?? ''
  }
  $('#cle-etat').textContent = config.aUneCle ? 'Une clé est enregistrée. Laisse vide pour la garder.' : 'Aucune clé enregistrée.'
  $('#bandeau-cle').hidden = !!config.aUneCle
  const p = $('#form-perso')
  p.elements.caractere.value = config.caractere || ''
  p.elements.style.value = config.style || ''
  p.elements.regles.value = config.regles || ''
  afficherEtat()
  afficherMondes()
}

$('#btn-enregistrer').addEventListener('click', async () => {
  const f = $('#form-connexion')
  const c = {}
  for (const el of f.elements) {
    if (!el.name) continue
    c[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim()
  }
  if (!NOM_VALIDE.test(c.nomBot)) {
    $('#msg-connexion').textContent = 'Le nom du bot : 3 à 16 lettres, chiffres ou _ (règle de Minecraft).'
    return
  }
  await mb.ecrireConfig(c)
  const cle = $('#cle').value.trim()
  if (cle) { await mb.ecrireCle(cle); $('#cle').value = '' }
  await chargerConfig()
  $('#msg-connexion').textContent = etatBot.lance ? 'Enregistré. Redémarre le bot pour appliquer.' : 'Enregistré.'
})
$('#btn-redemarrer').addEventListener('click', async () => {
  $('#msg-connexion').textContent = 'Redémarrage…'
  await mb.redemarrer()
  $('#msg-connexion').textContent = 'Bot redémarré avec les nouveaux réglages.'
})
$('#btn-tester').addEventListener('click', async () => {
  $('#cle-test').textContent = 'Test en cours…'
  const r = await mb.testerCle($('#cle').value.trim())
  $('#cle-test').textContent = r.ok ? 'La clé marche.' : r.erreur
})
$('#btn-console').addEventListener('click', () => mb.ouvrirLien('https://console.anthropic.com/settings/keys'))

// ---------- mémoire ----------
let memoire = { lieux: {}, souvenirs: [], reglages: {} }
const DIMS = { overworld: 'Monde', the_nether: 'Nether', the_end: 'End' }
async function chargerMemoire () {
  const r = await mb.lireMemoire()
  if (r.ok) { memoire = r.data; afficherMemoire(); afficherEtat() }
}
function afficherMemoire () {
  const lieux = Object.entries(memoire.lieux || {})
  $('#lieux').innerHTML = lieux.length
    ? lieux.map(([nom, l]) => `<div class="ligne-l">
        <span class="nom-l">${esc(nom)}</span>
        <span class="coords">${l.x} ${l.y} ${l.z}</span>
        <span class="dim">${esc(DIMS[String(l.dimension || 'overworld').replace('minecraft:', '')] || l.dimension || '')}</span>
        <button class="ic-bt" data-modif-lieu="${esc(nom)}" aria-label="Modifier ${esc(nom)}">${svg('edit')}</button>
        <button class="ic-bt" data-suppr-lieu="${esc(nom)}" aria-label="Supprimer ${esc(nom)}">${svg('trash')}</button>
      </div>`).join('')
    : '<div class="vide">Aucun lieu. Le bot en retient tout seul (base, mine…), ou ajoute-les ici.</div>'
  const s = memoire.souvenirs || []
  $('#souvenirs').innerHTML = s.length
    ? s.map((x, i) => `<div class="ligne-l" data-souv="${i}">
        <span class="txt">${esc(x.texte)}</span><span class="date">${esc(x.date || '')}</span>
        <button class="ic-bt" data-modif-souv="${i}" aria-label="Modifier ce souvenir">${svg('edit')}</button>
        <button class="ic-bt" data-suppr-souv="${i}" aria-label="Supprimer ce souvenir">${svg('trash')}</button>
      </div>`).join('')
    : '<div class="vide">Aucun souvenir pour l\'instant.</div>'
  $('#chk-autonome').checked = memoire.reglages?.autonome !== false
}
async function opMemoire (op, args) {
  const r = await mb.memoire(op, args)
  if (r.ok) { memoire = r.data; afficherMemoire() }
  return r
}
$('#lieux').addEventListener('click', async (ev) => {
  const modif = ev.target.closest('[data-modif-lieu]')
  const suppr = ev.target.closest('[data-suppr-lieu]')
  if (modif) {
    const nom = modif.dataset.modifLieu
    const l = memoire.lieux[nom]
    const f = $('#form-lieu')
    f.elements.nom.value = nom
    f.elements.x.value = l.x
    f.elements.y.value = l.y
    f.elements.z.value = l.z
    f.elements.dimension.value = String(l.dimension || 'overworld').replace('minecraft:', '')
    f.elements.nom.focus()
  }
  if (suppr && confirm(`Oublier le lieu « ${suppr.dataset.supprLieu} » ?`)) await opMemoire('removeLieu', { nom: suppr.dataset.supprLieu })
})
$('#form-lieu').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const f = ev.target
  const nom = f.elements.nom.value.trim()
  const [x, y, z] = ['x', 'y', 'z'].map(k => f.elements[k].value.trim())
  $('#err-lieu').textContent = ''
  if (!nom || x === '' || y === '' || z === '') { $('#err-lieu').textContent = 'Il faut un nom et les trois coordonnées.'; return }
  const r = await opMemoire('setLieu', { nom, x: Number(x), y: Number(y), z: Number(z), dimension: f.elements.dimension.value })
  if (!r.ok) { $('#err-lieu').textContent = r.erreur || 'Lieu non enregistré.'; return }
  f.reset()
})
$('#souvenirs').addEventListener('click', async (ev) => {
  const modif = ev.target.closest('[data-modif-souv]')
  const suppr = ev.target.closest('[data-suppr-souv]')
  if (suppr && confirm('Supprimer ce souvenir ?')) await opMemoire('removeSouvenir', { index: Number(suppr.dataset.supprSouv) })
  if (modif) {
    const i = Number(modif.dataset.modifSouv)
    const ligne = document.querySelector(`[data-souv="${i}"]`)
    ligne.innerHTML = `<input class="txt" value="${esc(memoire.souvenirs[i].texte)}" maxlength="300">
      <button class="ic-bt" data-ok aria-label="Valider">${svg('check')}</button>
      <button class="ic-bt" data-annuler aria-label="Annuler">${svg('x')}</button>`
    const champ = ligne.querySelector('input')
    champ.focus()
    const valider = async () => { const t = champ.value.trim(); if (t) await opMemoire('editSouvenir', { index: i, texte: t }); else afficherMemoire() }
    ligne.querySelector('[data-ok]').addEventListener('click', valider)
    ligne.querySelector('[data-annuler]').addEventListener('click', afficherMemoire)
    champ.addEventListener('keydown', (k) => { if (k.key === 'Enter') valider(); if (k.key === 'Escape') afficherMemoire() })
  }
})
$('#form-souvenir').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const t = ev.target.elements.texte.value.trim()
  if (!t) return
  await opMemoire('addSouvenir', { texte: t })
  ev.target.reset()
})
$('#btn-effacer').addEventListener('click', async () => {
  if (confirm('Effacer tous les lieux et tous les souvenirs du bot ? Ce n\'est pas réversible.')) await opMemoire('toutEffacer', {})
})
$('#btn-dossier').addEventListener('click', () => mb.ouvrirDossier())

// ---------- personnalité ----------
const PRESETS = {
  pote: { caractere: 'Blagueur, enthousiaste, toujours partant pour une aventure. Il chambre gentiment son pote.', style: 'Phrases courtes, tutoie, parle comme un pote, une petite blague de temps en temps.' },
  pro: { caractere: 'Calme, organisé et efficace. Il pense à la sécurité et prépare tout à l\'avance.', style: 'Messages courts et clairs, va droit au but, tutoie.' },
  explo: { caractere: 'Curieux de tout, adore explorer, trouver des grottes, des villages et des biomes rares.', style: 'S\'émerveille facilement, raconte ce qu\'il découvre en une phrase.' },
  pirate: { caractere: 'Un vieux pirate qui cherche des trésors (diamants !) et aime la mer.', style: 'Parle comme un pirate : « moussaillon », « mille sabords », phrases courtes.' }
}
$('#presets').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-preset]')
  if (!b) return
  const p = PRESETS[b.dataset.preset]
  const f = $('#form-perso')
  f.elements.caractere.value = p.caractere
  f.elements.style.value = p.style
  $('#msg-perso').textContent = 'Modèle appliqué : n\'oublie pas d\'enregistrer.'
})
$('#btn-perso').addEventListener('click', async () => {
  const f = $('#form-perso')
  await mb.ecrireConfig({ caractere: f.elements.caractere.value.trim(), style: f.elements.style.value.trim(), regles: f.elements.regles.value.trim() })
  await opMemoire('setReglage', { nom: 'autonome', valeur: $('#chk-autonome').checked })
  await chargerConfig()
  $('#msg-perso').textContent = etatBot.lance ? 'Enregistré. Redémarre le bot (onglet Connexion) pour appliquer.' : 'Enregistré.'
})

// ---------- carte en direct ----------
// couleurs des familles de blocs envoyées par le bot (voir carte.js) : 0 = pas chargé
const COULEURS = ['#15161a', '#5f9c48', '#3e7533', '#7b5b37', '#3a6cc0', '#d9cb8e', '#8c8f94', '#86603f', '#e8edf1',
  '#e8752a', '#8e3a3a', '#d8d4a0', '#c58a4c', '#8c8f94', '#a9b84b', '#4b4d53', '#a5664a']
const RVB = COULEURS.map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)))
const ECHELLE = 8 // pixels par bloc sur le dessin
const NOMS_DIMS = { overworld: 'Monde normal', the_nether: 'Nether', the_end: 'End' }
const dimCourte = (d) => String(d || 'overworld').replace('minecraft:', '')
const POINTS = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest']
const direction = (dx, dz) => POINTS[(Math.round(Math.atan2(dx, -dz) / (Math.PI / 4)) + 8) % 8] // 0 = nord
let carteData = null
mb.surCarte((c) => { carteData = c; if (pageActuelle === 'carte') dessinerCarte() })

const tampon = document.createElement('canvas')
function dessinerCarte () {
  const cv = $('#carte')
  const ctx = cv.getContext('2d')
  const e = etatBot
  afficherLieuxCarte()
  const ok = e.connecte && carteData
  $('#carte-vide').hidden = !!ok
  $('#carte-vide').textContent = e.connecte ? 'Chargement de la carte…' : 'La carte s\'affiche quand le bot est en jeu.'
  if (!ok) { ctx.clearRect(0, 0, cv.width, cv.height); $('#carte-info').textContent = ''; return }
  const { rayon: R, familles, hauteurs, cx, cz } = carteData
  const cote = R * 2 + 1
  if (cv.width !== cote * ECHELLE) { cv.width = cote * ECHELLE; cv.height = cote * ECHELLE }

  // le terrain : une case par bloc ; relief comme sur les cartes du jeu (plus clair si ça monte vers le sud)
  tampon.width = cote
  tampon.height = cote
  const tctx = tampon.getContext('2d')
  const img = tctx.createImageData(cote, cote)
  for (let i = 0; i < cote * cote; i++) {
    const h = hauteurs[i]
    let [r, g, b] = RVB[familles[i]] || RVB[6]
    if (h == null) [r, g, b] = RVB[0]
    else {
      const hn = i >= cote ? hauteurs[i - cote] : null
      let f = 1 + Math.max(-0.25, Math.min(0.25, h * 0.012))
      if (hn != null) f *= h > hn ? 1.14 : h < hn ? 0.84 : 1
      r = Math.min(255, r * f); g = Math.min(255, g * f); b = Math.min(255, b * f)
    }
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255
  }
  tctx.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(tampon, 0, 0, cv.width, cv.height)

  // repères : position à l'écran d'un point du monde (nord en haut)
  const ecran = (x, z) => [(Math.floor(x) - cx + R + 0.5) * ECHELLE, (Math.floor(z) - cz + R + 0.5) * ECHELLE]
  const dedans = ([sx, sy]) => sx >= 0 && sy >= 0 && sx <= cv.width && sy <= cv.height
  ctx.font = '600 22px "Segoe UI", sans-serif'
  const prises = [] // étiquettes déjà posées : une étiquette qui en chevaucherait une autre n'est pas affichée
  const etiquette = (txt, sx, sy, dy = -46) => {
    const w = ctx.measureText(txt).width + 16
    const x = Math.max(4, Math.min(cv.width - w - 4, sx - w / 2))
    const y = Math.max(4, Math.min(cv.height - 34, sy + dy))
    if (prises.some(p => x < p.x + p.w + 4 && p.x < x + w + 4 && y < p.y + 34 && p.y < y + 34)) return
    prises.push({ x, y, w })
    ctx.fillStyle = 'rgba(15, 16, 19, .82)'
    ctx.beginPath(); ctx.roundRect(x, y, w, 30, 8); ctx.fill()
    ctx.fillStyle = '#e8eaed'
    ctx.fillText(txt, x + 8, y + 22)
  }
  const point = (sx, sy, couleur) => {
    ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI * 2)
    ctx.fillStyle = couleur; ctx.fill()
    ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke()
  }
  const fleche = (sx, sy, ang, couleur, taille = 1) => {
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(ang); ctx.scale(taille, taille)
    ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-10, -11); ctx.lineTo(-5, 0); ctx.lineTo(-10, 11); ctx.closePath()
    ctx.fillStyle = couleur; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.restore()
  }
  // les joueurs que le bot voit (leurs noms passent en premier)
  for (const j of e.joueurs || []) {
    const s = ecran(j.x, j.z)
    if (dedans(s)) { point(s[0], s[1], '#5b9cf0'); etiquette(j.nom, s[0], s[1]) }
  }
  // les lieux retenus de cette dimension ; ceux qui sont loin : une flèche au bord, dans leur direction
  const dim = dimCourte(e.dimension)
  const loin = []
  for (const [nom, l] of Object.entries(memoire.lieux || {})) {
    if (dimCourte(l.dimension) !== dim) continue
    const s = ecran(l.x, l.z)
    if (dedans(s)) { point(s[0], s[1], '#f0b443'); etiquette(nom, s[0], s[1]) } else loin.push([nom, s])
  }
  for (const [nom, s] of loin) {
    const ang = Math.atan2(s[1] - cv.height / 2, s[0] - cv.width / 2)
    const k = (cv.width / 2 - 20) / Math.max(Math.abs(Math.cos(ang)), Math.abs(Math.sin(ang)))
    const bx = cv.width / 2 + Math.cos(ang) * k
    const by = cv.height / 2 + Math.sin(ang) * k
    fleche(bx, by, ang, '#f0b443', 0.8)
    etiquette(nom, bx - Math.cos(ang) * 46, by - Math.sin(ang) * 30, -15)
  }
  // le bot, tourné dans la direction où il regarde
  if (e.position) {
    const [sx, sy] = ecran(e.position.x, e.position.z)
    const yaw = e.yaw ?? 0
    fleche(sx, sy, Math.atan2(-Math.cos(yaw), -Math.sin(yaw)), '#1d9e75')
  }
  const p = e.position
  $('#carte-info').textContent = p
    ? `${NOMS_DIMS[dim] || dim} · bot en ${p.x} ${p.y} ${p.z}${carteData.sousTerre ? ' · vue sous terre' : ''} · nord en haut`
    : ''
}
// survol : les coordonnées de la case sous la souris
$('#carte').addEventListener('mousemove', (ev) => {
  if (!carteData || !etatBot.connecte) return
  const { rayon: R, cx, cz, y, hauteurs } = carteData
  const cote = R * 2 + 1
  const r = ev.currentTarget.getBoundingClientRect()
  const col = Math.min(cote - 1, Math.max(0, Math.floor((ev.clientX - r.left) / r.width * cote)))
  const lig = Math.min(cote - 1, Math.max(0, Math.floor((ev.clientY - r.top) / r.height * cote)))
  const h = hauteurs[lig * cote + col]
  $('#carte-survol').textContent = `x ${cx - R + col} · z ${cz - R + lig}${h != null ? ` · y ${y + h}` : ''}`
})
$('#carte').addEventListener('mouseleave', () => { $('#carte-survol').textContent = '' })

// la liste des lieux, avec la distance et la direction depuis le bot
let derniersLieux = ''
function afficherLieuxCarte () {
  const e = etatBot
  const dim = dimCourte(e.dimension)
  const lieux = Object.entries(memoire.lieux || {})
  const html = lieux.length
    ? lieux.map(([nom, l]) => {
      const proche = e.connecte && e.position && dimCourte(l.dimension) === dim
      const dx = l.x - (e.position?.x ?? 0)
      const dz = l.z - (e.position?.z ?? 0)
      const d = Math.round(Math.hypot(dx, dz))
      const loin = proche ? (d < 3 ? 'il y est' : `${d} blocs · ${direction(dx, dz)}`) : `${l.x} ${l.y} ${l.z} · ${NOMS_DIMS[dimCourte(l.dimension)] || ''}`
      return `<div class="ligne-l"><span class="nom-l">${esc(nom)}</span>${e.connecte
        ? `<button class="bt" data-y-aller="${esc(nom)}">Y aller</button>` : ''}<span class="loin">${esc(loin)}</span></div>`
    }).join('')
    : '<div class="vide">Aucun lieu retenu. Dis-lui « retiens cet endroit comme la base », ou ajoute-les dans Mémoire.</div>'
  if (html === derniersLieux) return
  derniersLieux = html
  $('#carte-lieux').innerHTML = html
}
// « Y aller » : on lui demande en langage naturel, comme dans le chat
$('#carte-lieux').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-y-aller]')
  if (!b) return
  const r = await mb.dire(`Va au lieu « ${b.dataset.yAller} »`)
  b.textContent = r.ok ? 'Demandé' : 'Pas lancé'
  setTimeout(() => { b.textContent = 'Y aller' }, 2500)
})

// ---------- mises à jour, version, soutien ----------
function afficherMaj (m) {
  const el = $('#maj')
  el.hidden = !m
  if (!m) return
  el.innerHTML = m.etat === 'prete'
    ? `<span>Nouvelle version ${esc(m.version)} prête.</span><button class="bt prim" id="btn-maj">Redémarrer pour l'installer</button>`
    : `<span>Téléchargement de la version ${esc(m.version)}… ${m.pourcent || 0} %</span>`
  $('#btn-maj')?.addEventListener('click', () => mb.installerMaj())
}
mb.surMaj(afficherMaj)
let lienSoutien = ''
$('#btn-soutien').addEventListener('click', () => { if (lienSoutien) mb.ouvrirLien(lienSoutien) })

// ---------- guide des premiers pas ----------
let etapeGuide = 1
const TITRES_GUIDE = ['Bienvenue dans MineBuddy', 'Presque prêt', 'Dernière étape']
function ouvrirGuide () {
  $('#g-pseudo').value = config?.pseudo || ''
  $('#g-nom').value = config?.nomBot || 'Claude'
  $('#g-cle').value = ''
  $('#g-port').value = ''
  $('#g-cle-etat').textContent = config?.aUneCle
    ? 'Une clé est déjà enregistrée : tu peux passer à la suite.'
    : 'Gardée chiffrée sur ce PC seulement. Elle n\'est jamais affichée.'
  $('#guide').hidden = false
  guideAller(1)
}
function guideAller (n) {
  etapeGuide = n
  document.querySelectorAll('.guide-etape').forEach(el => { el.hidden = Number(el.dataset.etape) !== n })
  document.querySelectorAll('.points span').forEach(p => p.classList.toggle('on', Number(p.dataset.pt) <= n))
  $('#g-num').textContent = n
  $('#guide-titre').textContent = TITRES_GUIDE[n - 1]
  $('#g-retour').hidden = n === 1
  $('#g-suivant').textContent = n < 3 ? 'Suivant' : 'Démarrer le bot'
  $('#g-err').textContent = ''
  if (n === 3) afficherMondeGuide()
  const champ = { 1: '#g-cle', 2: '#g-pseudo' }[n]
  if (champ) setTimeout(() => $(champ).focus(), 50)
}
function afficherMondeGuide () {
  const el = $('#g-monde')
  const m = mondes.find(estUtilise) || mondes[0]
  el.classList.toggle('ok', !!m)
  if (m) el.innerHTML = `<span class="pulse"></span><span>Monde trouvé : « ${esc(m.motd)} » (port ${m.port}). Tout est prêt !</span>`
  else if (!lanEcoute) {
    el.innerHTML = '<span class="pulse eteint"></span><span>La recherche automatique ne marche pas sur ce PC : entre le port ci-dessous.</span>'
    $('.manuel').open = true
  } else el.innerHTML = '<span class="pulse"></span><span>En attente de ton monde…</span>'
}
function fermerGuide () {
  $('#guide').hidden = true
  mb.ecrireConfig({ guideVu: true })
}
async function guideSuivant () {
  const err = (t) => { $('#g-err').textContent = t }
  $('#g-err').textContent = ''
  if (etapeGuide === 1) {
    const cle = $('#g-cle').value.trim()
    if (!cle && !config?.aUneCle) return err('Colle ta clé API pour continuer.')
    if (cle) {
      $('#g-suivant').disabled = true
      $('#g-err').textContent = ''
      $('#g-cle-etat').textContent = 'Vérification de la clé…'
      const r = await mb.testerCle(cle)
      $('#g-suivant').disabled = false
      if (!r.ok) { $('#g-cle-etat').textContent = ''; return err(r.erreur) }
      await mb.ecrireCle(cle)
      $('#g-cle').value = ''
      await chargerConfig()
      $('#g-cle-etat').textContent = 'Clé vérifiée et enregistrée.'
    }
    return guideAller(2)
  }
  if (etapeGuide === 2) {
    const pseudo = $('#g-pseudo').value.trim()
    const nom = $('#g-nom').value.trim()
    if (!NOM_VALIDE.test(pseudo)) return err('Ton pseudo Minecraft : 3 à 16 lettres, chiffres ou _.')
    if (!NOM_VALIDE.test(nom)) return err('Le nom du bot : 3 à 16 lettres, chiffres ou _.')
    if (nom.toLowerCase() === pseudo.toLowerCase()) return err('Le bot doit avoir un autre nom que toi.')
    await mb.ecrireConfig({ pseudo, nomBot: nom })
    await chargerConfig()
    return guideAller(3)
  }
  // étape 3 : le monde trouvé est déjà utilisé ; sinon le port tapé à la main
  const port = Number($('#g-port').value)
  if (!mondes.length) {
    if (!port || port > 65535) return err('Ouvre ton monde en LAN (il apparaîtra tout seul), ou entre le port à la main.')
    await mb.ecrireConfig({ hote: 'localhost', port })
  } else if (!mondes.some(estUtilise)) {
    await mb.utiliserMonde(mondes[0])
  }
  await mb.ecrireConfig({ guideVu: true })
  await chargerConfig()
  $('#guide').hidden = true
  allerA('pilotage')
  const r = await mb.demarrer()
  if (!r.ok && r.erreur === 'cle') allerA('connexion')
}
$('#g-suivant').addEventListener('click', guideSuivant)
$('#g-retour').addEventListener('click', () => guideAller(Math.max(1, etapeGuide - 1)))
$('#g-passer').addEventListener('click', fermerGuide)
$('#g-console').addEventListener('click', () => mb.ouvrirLien('https://console.anthropic.com/settings/keys'))
$('#btn-guide').addEventListener('click', ouvrirGuide)
for (const id of ['#g-cle', '#g-pseudo', '#g-nom', '#g-port']) {
  $(id).addEventListener('keydown', (k) => { if (k.key === 'Enter') guideSuivant() })
  $(id).addEventListener('input', () => { $('#g-err').textContent = '' })
}
document.addEventListener('keydown', (k) => { if (k.key === 'Escape' && !$('#guide').hidden) fermerGuide() })

// ---------- au démarrage ----------
;(async () => {
  const infos = await mb.infos()
  $('#version').textContent = `v${infos.version}`
  afficherMaj(infos.maj)
  lienSoutien = infos.soutien || ''
  $('#btn-soutien').hidden = !lienSoutien
  const lan = await mb.lanMondes()
  lanEcoute = !!lan.ecoute
  mondes = lan.mondes || []
  await chargerConfig()
  afficherEtat(await mb.etat())
  for (const l of await mb.logs()) ajouterJournal(l)
  chargerMemoire()
  if (!config.guideVu) ouvrirGuide()
})()
