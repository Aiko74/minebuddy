'use strict'
/* global mb */
// Interface de MineBuddy : navigation, pilotage du bot, réglages, mémoire et personnalité.

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
  x: '<path d="M6 6l12 12M18 6L6 18"/>'
}
const svg = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONES[n] || ''}</svg>`
const posIcones = (racine = document) => racine.querySelectorAll('[data-ic]').forEach(el => { el.innerHTML = svg(el.dataset.ic) })
posIcones()

const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const NOMS_MODELES = { 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-opus-5-5': 'Opus 5.5' }
const dollars = (n) => (Number(n) || 0).toFixed(2).replace('.', ',') + ' $'

// ---------- navigation ----------
function allerA (page) {
  document.querySelectorAll('.nv').forEach(b => b.classList.toggle('on', b.dataset.page === page))
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === `page-${page}`))
  if (page === 'memoire') chargerMemoire()
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
  if (e.connecte && e.dimension && !/overworld/.test(e.dimension)) ou.push(/nether/.test(e.dimension) ? 'Nether' : 'End')
  $('#etat-ou').textContent = ou.join(' · ') || (config ? `${config.hote}:${config.port}` : '—')
  const vie = e.connecte ? e.vie : null
  const faim = e.connecte ? e.faim : null
  $('#bar-vie').style.width = vie == null ? '0' : `${Math.max(0, Math.min(20, vie)) * 5}%`
  $('#bar-faim').style.width = faim == null ? '0' : `${Math.max(0, Math.min(20, faim)) * 5}%`
  $('#txt-vie').textContent = vie == null ? '—' : `${vie}/20`
  $('#txt-faim').textContent = faim == null ? '—' : `${faim}/20`
  $('#mission').textContent = e.connecte && e.mission ? `Mission : ${e.mission}` : ''
  $('#btn-demarrer').disabled = !!e.lance
  $('#btn-arreter').disabled = !e.lance
  $('#btn-redemarrer').hidden = !e.lance
  const modele = e.modele || config?.modele
  $('#pied-modele').textContent = `Cerveau : ${NOMS_MODELES[modele] || modele || '—'}`
  // bot arrêté : la dépense du jour vient de sa mémoire (elle y est gardée)
  const d = memoire?.reglages?.depense
  const depense = e.depense ?? (d && d.jour === new Date().toLocaleDateString('fr-FR') ? d.usd : 0)
  $('#pied-depense').textContent = `Aujourd'hui : ${dollars(depense)} / ${dollars(e.lance ? (e.budget ?? config?.budget) : config?.budget)}`
}
mb.surEtat(afficherEtat)

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
  if (/^(✅|🔄|🔑|🔌|▶|⏹|💸|💬)/.test(t)) return 'info'
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
}

$('#btn-enregistrer').addEventListener('click', async () => {
  const f = $('#form-connexion')
  const c = {}
  for (const el of f.elements) {
    if (!el.name) continue
    c[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim()
  }
  if (!c.nomBot || !/^[A-Za-z0-9_]{3,16}$/.test(c.nomBot)) {
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

// ---------- au démarrage ----------
;(async () => {
  await chargerConfig()
  afficherEtat(await mb.etat())
  for (const l of await mb.logs()) ajouterJournal(l)
  chargerMemoire()
})()
