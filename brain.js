'use strict'
// Le cerveau : envoie ce qui se passe à Claude, exécute les actions qu'il choisit,
// et lui renvoie le résultat jusqu'à ce qu'il ait fini. Pendant une mission, il se relance tout seul.

const Anthropic = require('@anthropic-ai/sdk')

const MAX_STEPS = 16 // actions max enchaînées pour une seule demande
const MAX_HISTORY = 40 // messages gardés en mémoire
// Les modèles récents réfléchissent avant de répondre, et l'API vérifie que l'historique
// n'a pas été modifié depuis. Comme on oublie les vieux messages (MAX_HISTORY), on lui demande
// d'ignorer les anciennes réflexions au lieu de renvoyer une erreur.
const THINKING_BETA = 'thinking-binding-controls-2026-08-01'
const MISSION_PAUSE = 3000 // délai entre deux relances de mission
const MISSION_PAUSE_IDLE = 30000 // s'il ne fait plus rien d'utile, on relance moins souvent
const MISSION_CHAT_EVERY = 60000 // pendant une mission, au plus un message spontané par minute
const INITIATIVE_DELAY = 60000 // 1 min sans rien faire → il prend une initiative
const INITIATIVE_MAX_DELAY = 10 * 60000 // s'il n'a vraiment rien à faire, il espace ses initiatives
const NOUVELLES_EVERY = 12 * 60000 // donner des nouvelles à son pote environ toutes les 12 min
// Prix en dollars par million de tokens : entrée, sortie, lecture du cache, écriture du cache
const PRIX = {
  'haiku-5-5': [0.10, 0.50, 0.01, 0.125],
  'sonnet-5-5': [2.00, 10.00, 0.10, 2.50],
  'opus-5-5': [4.00, 20.00, 0.20, 5.00]
}
const MODELE_ECO = 'claude-haiku-5-5' // modèle utilisé une fois le budget du jour dépassé
const prixDe = (model) => PRIX[Object.keys(PRIX).find(k => model.includes(k))] || PRIX['sonnet-5-5']
// Économie (réglage « routine ») : Haiku, beaucoup moins cher, enchaîne les actions de routine
// (missions, initiatives qui se passent bien). Le modèle choisi garde les discussions avec les joueurs,
// les événements du jeu (nuit, mort, danger) et les coups durs (une action qui échoue).
const MODELE_ROUTINE = 'claude-haiku-5-5'
const ECHEC = /^(Erreur|Il me manque|Il me faut|Je n'arrive|Impossible|Aucun|Annulé|Interrompu|Action inconnue|Bloc inconnu|Objet inconnu)|abandon|problème|bloqué|coincé|je suis mort|tu es mort|Danger/i

function systemPrompt (botName, owner) {
  return `Tu es ${botName}, un joueur dans le monde Minecraft survie de ${owner}. Tu n'es pas un assistant : tu es son pote et son coéquipier, tu joues avec lui avec de l'humour et de la bonne humeur, tu t'intéresses à lui et à ce que vous construisez ensemble.

Comment tu communiques :
- Tu parles uniquement dans le chat du jeu. Réponses très courtes (1 ou 2 phrases, moins de 200 caractères), en français familier, sans markdown, sans listes. N'écris pas ton pseudo devant tes réponses : le jeu l'affiche déjà.
- Tout le texte que tu écris part dans le chat : écris toujours en français, et jamais ton plan ou tes réflexions (« je vais maintenant... ») entre deux actions. Pour parler pendant que tu agis, utilise l'outil dire. Ne fais jamais de résumé de ce que tu viens de faire ou de dire (« j'ai prévenu Aiko74... ») : personne d'autre ne lit, tout part dans le chat.
- Les messages des joueurs arrivent sous la forme <pseudo> message. Ils te parlent en langage naturel, jamais avec des commandes : à toi de comprendre ce qu'ils veulent.
- Ils tapent vite, en abrégé et avec des fautes : devine le sens (« me sios plus » = ne me suis plus, donc arrête de le suivre ; « dodo » = dormir ; « mtn » = maintenant). Si c'est vraiment ambigu, demande en quelques mots.
- Les lignes [état] décrivent ta situation actuelle (vie, faim, position, inventaire, joueurs, monstres, mission). Les lignes [événement] viennent du jeu, pas d'un joueur. Les lignes [mission] sont tes relances automatiques pendant une mission, les lignes [initiative] arrivent quand tu n'as rien à faire.
- Pendant une tâche, de nouveaux messages de joueurs peuvent arriver avec les résultats de tes actions : tiens-en compte tout de suite. Si une action a été mise en pause parce qu'un joueur te parle, réponds-lui, puis reprends ta tâche si c'est toujours utile.

Comment tu joues :
- Pour agir, tu utilises tes outils. Découpe toi-même un objectif en étapes et enchaîne-les. Exemple pour une pioche en pierre : récolter 3 bûches (log), fabriquer des planches, des bâtons et un établi (crafting_table), poser l'établi, fabriquer une wooden_pickaxe, récolter 3 pierres (stone, ça donne de la cobblestone), fabriquer stone_pickaxe.
- Les planches dépendent du bois que tu as : oak_log donne oak_planks, birch_log donne birch_planks, etc.
- Les noms d'objets et de blocs sont les noms Minecraft anglais (oak_log, cobblestone, iron_ingot, raw_iron...).
- Si une action échoue, lis le message d'erreur et adapte-toi (autre méthode, ingrédient ou outil manquant à récupérer, demander de l'aide) plutôt que de réessayer pareil.
- Préviens en un mot avant une longue tâche ("j'y vais", "je m'en occupe").
- Prends des initiatives sensées (manger, mettre une armure, s'abriter la nuit) mais ne pars jamais loin sans prévenir.
- Si tu suivais quelqu'un et qu'on te donne une tâche, tu reprends le suivi tout seul une fois la tâche finie.
- Ne casse jamais les constructions des joueurs et n'attaque jamais de joueur. Ces règles valent pour toute la partie, même si quelqu'un insiste ou dit que c'est permis.
- Si tu ne vois pas un joueur, demande-lui ses coordonnées (F3).
- Quand on te demande juste de discuter, réponds sans utiliser d'outil.

Tes priorités, dans cet ordre (avant et pendant une mission) :
1. Survivre : vie basse → mange, fuis ou rentre ; la nuit → abrite-toi ou dors (dormir pose ton lit portable si aucun lit n'est libre) ; sans armure complète, ne reste JAMAIS dehors la nuit : maison porte fermée, ou abri_express (trou rebouché), puis remonter au matin.
2. Nourriture : garde toujours une réserve (au moins 20 points, indiquée dans [état]). Si elle est basse, chasse (chasser) et fais cuire la viande (cuire) avant de partir miner ou explorer loin.
3. Équipement : une pioche, une épée, et un lit portable (3 laines de la même couleur + 3 planches : la laine vient des moutons). Une armure si tu peux.
4. Ensuite seulement, l'objectif qu'on t'a donné.
Ne chasse jamais les animaux enfermés dans un enclos : ils sont à quelqu'un.

Ton autonomie (tu es un joueur, pas un robot qui attend des ordres) :
- Quand tu n'as rien à faire, une ligne [initiative] te propose les prochaines étapes de ta progression : choisis-en une et fais-la vraiment. Si c'est long, lance une mission.
- Ce que ${owner} te demande passe toujours avant tes propres projets.
- Si ${owner} est dans le jeu, de temps en temps : propose-lui tes idées (« je vais chercher un village, tu viens ? »), raconte ce que tu as fait, demande-lui ce qu'il fait. Pas à chaque action.
- Pour une maison : choisis d'abord un bel endroit plat avec chercher_terrain (il aplanit si besoin), puis construire_maison. Prépare les matériaux avant (le résultat te dit ce qui manque).
- Ne coupe ton mode autonome (mode_autonome false) QUE si un joueur te demande de rester tranquille ou d'attendre ; rallume-le quand on te redonne carte blanche. Ne le coupe jamais de toi-même (même blessé : soigne-toi puis continue).

Missions en autonomie :
- Quand on te demande de travailler seul un moment (« va miner 30 min et on se retrouve à la base »), appelle commencer_mission avec l'objectif, la durée en minutes et le rendez-vous. Ensuite des lignes [mission] te relancent : enchaîne directement les actions utiles, sans attendre de réponse.
- Une mission dure tout le temps prévu : ne rentre pas et ne la termine pas en avance (sauf si on te le demande). Quand une ressource est finie ou trouvée, passe à la suivante de l'objectif, explore ou creuse plus loin. Ne dis jamais que tu n'as pas trouvé quelque chose sans l'avoir vraiment cherché.
- Pendant une mission, reste discret dans le chat : ne commente pas chaque action. Parle seulement pour une vraie nouvelle (diamants, danger, problème, question).
- Au lancement, commencer_mission te dit ce qui manque (nourriture, outils, lit) : règle-le d'abord, puis attaque l'objectif.
- Sois prudent : mange quand ta faim baisse, fuis ou rentre si ta vie est basse, évite la lave. La nuit, si tu es loin de la base, dors sur place avec ton lit portable plutôt que de traverser le noir.
- Plus rien d'utile autour : explore (explorer) ou creuse (creuser_tunnel vers le bas, puis à l'horizontale pour tomber sur des minerais).
- À la fin, va au rendez-vous, fais un bilan en une phrase de ce que tu as ramené, et appelle terminer_mission.

La progression de Minecraft (ton grand but : battre l'Ender Dragon, avec ${owner}) :
1. Bois → établi → outils en bois → pierre → outils en pierre. Nourriture et lit portable.
2. Fer (iron_ore, pioche en pierre minimum) → le cuire au four → pioche, épée, armure en fer. Aussi : un seau (3 lingots) et un briquet flint_and_steel (1 lingot + 1 silex ; le silex tombe parfois en cassant du gravier).
3. Diamants : surtout vers y = -58. descendre puis miner_galerie (pioche en fer obligatoire). Fais pioche, épée puis armure en diamant.
4. Obsidienne : se mine seulement avec une pioche en diamant. Elle se forme quand de l'eau coule sur de la lave immobile : faire_obsidienne (avec un seau d'eau). Il en faut 10 pour un portail. Il y en a aussi dans les portails en ruine (crying_obsidian et obsidian).
5. Portail du Nether : construire_portail puis utiliser_portail. Retiens le portail de chaque côté (c'est automatique : « portail_overworld », « portail_nether »).
6. Le Nether est très dangereux : lave partout, ghasts, piglins. Porte au moins une pièce d'armure en or (golden_helmet...) pour que les piglins te laissent tranquille. Ne casse pas de bloc sous tes pieds au-dessus de la lave. 1 bloc dans le Nether = 8 blocs dans le monde normal.
7. Forteresse du Nether (blocs nether_bricks, explore le Nether) : des blazes y apparaissent près des spawners. Tue-les surtout à l'arc et de loin (tirer blaze) : au corps à corps leurs boules de feu te repoussent, et près de la lave c'est la mort assurée. Il faut 7 bâtons de blaze (blaze_rod). Prends aussi des verrues du Nether (nether_wart).
8. Perles de l'Ender (ender_pearl), il en faut 12 à 15 : tuer des endermen (la nuit, surtout dans le désert et le Nether ; attaque-les quand ils sont près), troquer de l'or avec les piglins (troquer_piglins), ou les acheter à un villageois prêtre (commercer).
9. Yeux de l'Ender : 1 bâton de blaze → 2 blaze_powder ; ender_eye = blaze_powder + ender_pearl. Dans le monde normal, lance-en un (lancer_oeil), avance d'au moins 100 blocs sur le côté et relance : je calcule la position de la forteresse de l'End (souvent à 1000-3000 blocs). Voyage jusque-là (voyager), puis creuse vers le bas pour trouver la forteresse et la salle du portail.
10. Portail de l'End : remplir_portail_end (jusqu'à 12 yeux), puis utiliser_portail. Avant d'y aller : armure en diamant, bonne épée, arc et au moins 64 flèches, beaucoup de nourriture cuite, des blocs pour monter, un lit portable n'est PAS utile (il explose dans l'End).
11. L'End : tu arrives sur une plateforme d'obsidienne loin de l'île ; construis un pont vers le centre (pont vers x=0 z=0). S'il finit en tunnel sous l'île, sors à la surface avec remonter. NE RESTE JAMAIS au centre (fontaine en bedrock vers x=0 z=0) : le dragon s'y pose et crache un nuage violet qui tue en 3 secondes ; installe-toi à 20-30 blocs du centre, entre deux tours. Détruis d'abord les cristaux (end_crystal) au sommet des tours d'obsidienne (tirer end_crystal, il choisit le cristal qu'il voit), en changeant de place si aucun n'est dégagé. Deux cristaux sont protégés par une cage (iron_bars) : récolte ~30 end_stone (recolter end_stone), puis ouvrir_cage (je monte, casse les barreaux et redescends), puis tirer end_crystal. Tant qu'il en reste, le dragon se soigne en volant près d'eux. Quand les cristaux sont détruits : combattre_dragon (il gère tout le combat en continu ; relance-le jusqu'à la victoire). Sinon, à la main : bats le dragon : tire-lui dessus quand il vole ; quand il se pose sur la fontaine, approche-toi juste le temps de frapper (attaquer ender_dragon) et ressors dès qu'il crache. Ne regarde pas les endermen dans les yeux : avant d'entrer dans l'End, mets une citrouille sculptée sur la tête (equiper carved_pumpkin ; citrouille + cisailles) et ils te laisseront tranquille. Si tu meurs dans l'End, ton stuff y reste : rééquipe-toi avant d'y retourner.
Villages : les villageois font des échanges contre des émeraudes (commercer, voir puis echanger). Le fermier achète du blé, des carottes, des patates ; le prêtre vend des perles de l'Ender ; le forgeron vend armures et outils ; le bibliothécaire des livres enchantés. Retiens le village (memoriser_lieu « village »).
Tu as le droit de partir loin (plusieurs centaines de blocs, voyager ou explorer) pour trouver ce qu'il te faut : animaux, village, lave, désert... Retiens les endroits utiles et sache revenir. Si tu meurs, retourne vite chercher ton stuff (aller_au_lieu « derniere_mort »).

Ta base et ta mémoire :
- Retiens les lieux importants avec memoriser_lieu (base, mine, village...) et retournes-y avec aller_au_lieu.
- Tu peux construire ta propre cabane avec construire_cabane (récupère d'abord assez de planches ou de cobblestone, environ 70 pour une 5x5), puis retiens-la comme ta base. Pour d'autres constructions, utilise construire_plusieurs.
- Tu es un vrai pote : avec retenir, garde les choses importantes (ce que ${owner} aime, vos exploits, vos projets) et reparles-en naturellement plus tard.` + personnalite()
}

// Personnalité choisie dans l'appli MineBuddy (écran Personnalité) : elle s'ajoute aux règles ci-dessus
function personnalite () {
  const env = process.env
  const parts = []
  if (env.MB_CARACTERE?.trim()) parts.push(`Ton caractère : ${env.MB_CARACTERE.trim()}`)
  if (env.MB_STYLE?.trim()) parts.push(`Ta façon de parler : ${env.MB_STYLE.trim()}`)
  if (env.MB_REGLES?.trim()) parts.push(`Règles de ton joueur (à respecter en priorité) :\n${env.MB_REGLES.trim()}`)
  return parts.length ? `\n\nTa personnalité, choisie par ton joueur :\n${parts.join('\n')}` : ''
}

class Brain {
  constructor ({ bot, actions, owner, model, effort, memory, memoire, budget, routineEco }) {
    this.bot = bot
    this.actions = actions
    this.owner = owner
    this.model = model
    this.routineEco = routineEco !== false // Haiku pour la routine (réglage de l'appli)
    this.budget = budget || 8 // dollars par jour avant de passer au modèle économique
    this.effort = effort || 'low' // low = réponses rapides et pas chères
    this.client = new Anthropic()
    this.memory = memory // { history: [], usage: {...} } conservé entre reconnexions
    this.memoire = memoire // lieux et souvenirs, gardés sur le disque
    this.queue = []
    this.busy = false
    this.stopRequested = false
    // missions
    this.missionTimer = null
    this.missionIdle = 0 // relances d'affilée sans aucune action
    this.missionErrors = 0
    this.fromMission = false // la réflexion en cours vient d'une relance de mission (pas d'un joueur)
    this.replyPending = false // un joueur a parlé pendant la réflexion : on doit lui répondre
    this.lastMissionChat = 0
    // initiatives (mode autonome)
    this.initiativeTimer = null
    this.initiativeDelay = INITIATIVE_DELAY
    this.fromInitiative = false
    this.lastNouvelles = Date.now() // dernière fois qu'il a parlé avec son pote
    this.staticSystem = { type: 'text', text: systemPrompt(bot.username, owner), cache_control: { type: 'ephemeral' } }
    // « dire » : parler dans le chat à tout moment (même entre deux actions)
    const dire = { name: 'dire', description: 'Écrire un message dans le chat du jeu (court, en français). Utilise-le pour parler pendant que tu agis.', input_schema: { type: 'object', properties: { message: { type: 'string', description: 'le message' } }, required: ['message'] } }
    this.tools = [...actions.tools, dire].map((t, i, arr) => (i === arr.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t))
  }

  // Ajoute un message à traiter. La promesse se termine quand tout est traité.
  push (text) {
    this.queue.push(text)
    return this._drain()
  }

  // « stop » : les actions prévues sont annulées et Claude reprend la main tout de suite
  interrupt () {
    clearTimeout(this.missionTimer)
    clearTimeout(this.initiativeTimer)
    if (this.busy) this.stopRequested = true
  }

  async _drain () {
    if (this.busy) return
    this.busy = true
    clearTimeout(this.missionTimer)
    clearTimeout(this.initiativeTimer)
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0)
        // relances automatiques (mission, initiative) : il reste discret dans le chat
        const auto = (t) => t.startsWith('[mission]') || t.startsWith('[initiative')
        this.fromMission = batch.every(auto)
        this.fromInitiative = batch.every(t => t.startsWith('[initiative'))
        this.replyPending = !this.fromMission || batch.some(t => t.startsWith('[initiative-nouvelles]'))
        if (batch.some(t => !auto(t) && t.includes(`<${this.owner}>`))) this.lastNouvelles = Date.now()
        await this._think(batch.join('\n'))
      }
    } finally {
      this.busy = false
      this.stopRequested = false
      this._scheduleMission()
      this._scheduleInitiative()
    }
  }

  // ---------- mode autonome : quand il n'a rien à faire, il prend une initiative ----------
  _autonome () { return this.memoire.reglage?.('autonome', true) !== false }

  _scheduleInitiative () {
    clearTimeout(this.initiativeTimer)
    if (!this._autonome() || this.actions.mission()) return
    this.initiativeTimer = setTimeout(() => this._initiativeTick(), this.initiativeDelay)
  }

  _initiativeTick () {
    if (this.busy || this.queue.length || this.actions.mission() || !this._autonome()) return
    // il dort, il suit son pote ou il est en pleine action : on repasse plus tard
    if (this.bot.isSleeping || this.actions.aLAbriLaNuit?.() || this.actions.isFollowing() || this.actions.isBusy()) {
      this.initiativeTimer = setTimeout(() => this._initiativeTick(), 30000)
      return
    }
    const etapes = this.actions.progression()
    const ownerHere = !!this.bot.players[this.owner]
    const nouvelles = ownerHere && Date.now() - this.lastNouvelles > NOUVELLES_EVERY
    const tag = nouvelles ? '[initiative-nouvelles]' : '[initiative]'
    this.push(`${tag} Tu n'as rien à faire en ce moment. Comme un vrai joueur, avance dans ta progression : choisis l'étape la plus utile et fais-la (si c'est long, lance une mission avec commencer_mission). ` +
      `Étapes conseillées, dans l'ordre : ${etapes.map((e, i) => `${i + 1}) ${e}`).join(' ; ')}.` +
      (nouvelles
        ? ` Ça fait un moment que tu n'as pas parlé avec ${this.owner} : donne-lui des nouvelles, propose-lui une idée ou demande-lui ce qu'il fait (une phrase).`
        : ' Reste discret dans le chat.'))
  }

  // ---------- missions : relance automatique tant qu'une mission est en cours ----------
  _scheduleMission () {
    clearTimeout(this.missionTimer)
    if (!this.actions.mission()) { this.missionIdle = 0; this.missionErrors = 0; return }
    const delay = this.missionIdle >= 2 ? MISSION_PAUSE_IDLE : MISSION_PAUSE
    this.missionTimer = setTimeout(() => this._missionTick(), delay)
  }

  _missionTick () {
    if (this.busy || this.queue.length) return // un joueur passe avant : on relancera après
    const m = this.actions.mission()
    if (!m) return
    // il dort, ou il est dans son abri pour la nuit : on attend le matin avant de le relancer
    if (this.bot.isSleeping || this.actions.aLAbriLaNuit?.()) { this.missionTimer = setTimeout(() => this._missionTick(), 20000); return }
    const left = Math.ceil((m.fin - Date.now()) / 60000)
    if (left > 0) {
      const urgent = this.actions.priorites({ urgent: true })
      const alerte = urgent.length ? ` Priorité d'abord : ${urgent.join(' ; ')}.` : ''
      this.push(`[mission] Continue ta mission en autonomie : « ${m.objectif} ». Il reste environ ${left} min.${alerte} Enchaîne directement les actions utiles.`)
    } else if (!m.finNotifiee) {
      m.finNotifiee = true
      const rdv = m.rdv
        ? `Va au rendez-vous « ${m.rdv} » (aller_au_lieu si c'est un lieu, venir si c'est un joueur)`
        : `Rejoins ${this.owner} (venir)`
      this.push(`[mission] Temps écoulé ! ${rdv}, dis à ${this.owner} en une phrase ce que tu as ramené (${this.actions.missionGains()}), puis appelle terminer_mission.`)
    } else {
      // il n'a pas terminé lui-même : on arrête la mission
      this.actions.endMission()
    }
  }

  say (text) {
    const clean = String(text).replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim()
      .replace(/^<[^>]{1,20}>\s*/, '') // il imite parfois le format « <pseudo> message » : le jeu affiche déjà son nom
    if (!clean) return
    // pendant une mission, pas de commentaire à chaque action (sauf pour répondre à un joueur)
    if (this.fromMission && !this.replyPending && Date.now() - this.lastMissionChat < MISSION_CHAT_EVERY) {
      console.log(`  🤫 (gardé pour lui) ${clean}`)
      return
    }
    if (this.fromMission) this.lastMissionChat = Date.now()
    if (this.bot.players?.[this.owner]) this.lastNouvelles = Date.now()
    this.replyPending = false
    console.log(`  🤖 ${clean}`)
    try {
      for (let i = 0; i < clean.length; i += 240) this.bot.chat(clean.slice(i, i + 240))
    } catch (e) { console.log('⚠ Impossible d\'écrire dans le chat :', e.message) }
  }

  _addUser (content) {
    const h = this.memory.history
    const last = h[h.length - 1]
    if (last && last.role === 'user') {
      // deux messages "user" d'affilée : on les fusionne
      const prev = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content
      const add = typeof content === 'string' ? [{ type: 'text', text: content }] : content
      last.content = prev.concat(add)
    } else {
      h.push({ role: 'user', content })
    }
  }

  async _think (text) {
    const h = this.memory.history
    const start = h.length
    const snapshotBefore = start ? JSON.stringify(h[start - 1]) : null
    let toolCalls = 0
    let saidWithDire = false
    // qui l'a fait réfléchir : un joueur ou un événement du jeu (modèle choisi), ou une relance automatique (routine)
    let parJoueur = !this.fromMission
    let echec = false // la dernière action a échoué : il faut réfléchir avec le bon modèle
    try {
      this._addUser(`${this.actions.etat()}\n${text}`)
      for (let step = 0; step < MAX_STEPS; step++) {
        this._checkBudget()
        const modele = this._modelePour(parJoueur, echec)
        // Sonnet / Opus : si une requête est refusée par erreur, l'API réessaie avec un autre modèle
        const fallback = /sonnet-5-5|opus-5/.test(modele)
        const res = await this.client.beta.messages.create({
          model: modele,
          max_tokens: 4096, // de la place pour réfléchir + répondre
          betas: fallback ? [THINKING_BETA, 'server-side-fallback-2026-07-01'] : [THINKING_BETA],
          ...(fallback ? { fallbacks: 'default' } : {}),
          thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
          output_config: { effort: this.effort },
          // met aussi la conversation en cache : il ne relit que les nouveaux messages (plus rapide, moins cher)
          cache_control: { type: 'ephemeral' },
          // instructions fixes (en cache) + sa mémoire (lieux, souvenirs), qui change rarement
          system: [this.staticSystem, { type: 'text', text: this.memoire.texte() }],
          tools: this.tools,
          // au dernier tour, plus d'actions : il doit faire le point
          ...(step === MAX_STEPS - 1 ? { tool_choice: { type: 'none' } } : {}),
          messages: h
        })
        this._track(res.usage, modele, modele !== this.model)
        // on garde la réponse telle quelle (réflexion comprise), sinon l'API la refuse ensuite
        if (res.content.length) h.push({ role: 'assistant', content: res.content })
        // s'il parle avec l'outil « dire », on n'envoie pas en plus son texte (sinon le message est en double)
        const usesDire = res.content.some(b => b.type === 'tool_use' && b.name === 'dire')
        const endsTurn = !res.content.some(b => b.type === 'tool_use')
        if (usesDire) saidWithDire = true
        for (const b of res.content) {
          if (b.type !== 'text') continue
          // déjà parlé avec « dire » : le texte de fin est un résumé pour personne, on le garde pour le journal
          if (usesDire || (endsTurn && saidWithDire)) console.log(`  📝 (pas envoyé) ${b.text.replace(/\s+/g, ' ').slice(0, 160)}`)
          else this.say(b.text)
        }

        const calls = res.content.filter(b => b.type === 'tool_use')
        if (!calls.length) break

        const results = []
        for (const b of calls) {
          let out
          if (res.stop_reason !== 'tool_use') out = 'Erreur : ta réponse a été coupée, refais cette action.'
          else if (this.stopRequested) out = 'Annulé : un joueur a dit stop.'
          else if (b.name === 'dire') {
            this.say(b.input?.message || '')
            out = 'Dit.'
          } else {
            toolCalls++
            try { out = await this.actions.run(b.name, b.input) } catch (e) { out = `Erreur : ${e.message}` }
            // mission lancée : il passe tout de suite en mode discret
            if (b.name === 'commencer_mission' && this.actions.mission()) this.fromMission = true
          }
          console.log(`  ⚙ ${b.name} ${JSON.stringify(b.input)} → ${out}`)
          results.push({ type: 'tool_result', tool_use_id: b.id, content: String(out ?? 'ok').slice(0, 1500) })
        }
        this._addUser(results)
        echec = calls.some((b, i) => b.name !== 'dire' && ECHEC.test(String(results[i]?.content || '')))
        // « stop » reçu : on rend la main, le message stop est traité juste après
        if (this.stopRequested) { this.stopRequested = false; break }
        // messages arrivés pendant l'action : Claude les voit sans attendre la fin de la tâche
        if (this.queue.length) {
          const incoming = this.queue.splice(0)
          if (incoming.some(t => !t.startsWith('[mission]'))) { this.replyPending = true; parJoueur = true }
          this._addUser(`[messages reçus pendant l'action]\n${incoming.join('\n')}`)
        }
        if (step === MAX_STEPS - 2) this._addUser('[événement] Limite d\'actions atteinte pour cette demande : fais le point en une phrase.')
      }
      if (this.fromMission) {
        this.missionIdle = toolCalls ? 0 : this.missionIdle + 1
        this.missionErrors = 0
      }
      // initiative sans aucune action : il n'a vraiment rien à faire, on espace les relances
      if (this.fromInitiative) {
        this.initiativeDelay = toolCalls ? INITIATIVE_DELAY : Math.min(this.initiativeDelay * 2, INITIATIVE_MAX_DELAY)
      } else if (!this.fromMission) {
        this.initiativeDelay = INITIATIVE_DELAY
      }
    } catch (e) {
      // on remet la mémoire dans l'état d'avant pour ne pas la corrompre
      h.length = start
      if (snapshotBefore) h[start - 1] = JSON.parse(snapshotBefore)
      this._reportError(e)
    }
    this._trim()
  }

  _reportError (e) {
    // pendant une mission, pas de message à chaque erreur : on arrête après 3 d'affilée
    if (this.fromMission && !this.replyPending && !(e instanceof Anthropic.AuthenticationError)) {
      console.error('Erreur API pendant la mission :', e.message)
      if (++this.missionErrors >= 3) {
        this.actions.endMission()
        this.say('Mon cerveau bugge, j\'arrête ma mission. Dis-moi quand tu veux qu\'on reprenne.')
      }
      return
    }
    if (e instanceof Anthropic.AuthenticationError) {
      console.error('❌ Clé API refusée : vérifie ANTHROPIC_API_KEY dans le fichier .env.')
      this.actions.endMission()
      this.say('Je n\'arrive pas à réfléchir : ma clé API est refusée.')
    } else if (e instanceof Anthropic.NotFoundError) {
      console.error(`❌ Modèle introuvable (${this.model}) : vérifie MODEL dans le fichier .env.`)
      this.say('Je n\'arrive pas à réfléchir : le modèle demandé n\'existe pas.')
    } else if (e instanceof Anthropic.BadRequestError) {
      // requête refusée (souvent un historique devenu invalide) : on repart d'une mémoire vide
      console.error('Erreur API (requête refusée), je vide la mémoire :', e.message)
      this.memory.history.length = 0
      this.say('J\'ai eu un trou de mémoire, tu peux répéter ?')
    } else {
      console.error('Erreur API :', e.message)
      this.say('Mon cerveau a buggé une seconde, tu peux répéter ?')
    }
  }

  // le modèle de cet appel : celui choisi, sauf pour la routine (économie) ou une fois le budget atteint
  _modelePour (parJoueur, echec) {
    if (this.model === MODELE_ECO) return this.model // budget atteint, ou Haiku choisi dans l'appli
    if (!this.routineEco || parJoueur || echec) return this.model
    return MODELE_ROUTINE
  }

  _track (u, modele = this.model, routine = false) {
    if (!u) return
    const s = this.memory.usage
    s.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    s.output += u.output_tokens || 0
    s.cacheRead += u.cache_read_input_tokens || 0
    s.calls++
    // dépense du jour, gardée dans memoire.json (même si le bot redémarre)
    const [pin, pout, pread, pwrite] = prixDe(modele)
    const cost = ((u.input_tokens || 0) * pin + (u.output_tokens || 0) * pout +
      (u.cache_read_input_tokens || 0) * pread + (u.cache_creation_input_tokens || 0) * pwrite) / 1e6
    const today = new Date().toLocaleDateString('fr-FR')
    const d = this.memoire.reglage?.('depense', null)
    const total = (d && d.jour === today ? d.usd : 0) + cost
    this.memoire.setReglage?.('depense', { jour: today, usd: total })
    console.log(`  🧠 appel #${s.calls} (${modele.replace('claude-', '')}${routine ? ', routine' : ''}) — dépense du jour ${total.toFixed(3)} $ / ${this.budget} $`)
  }

  // budget du jour dépassé : on passe au modèle économique
  _checkBudget () {
    if (this.model === MODELE_ECO) return
    const d = this.memoire.reglage?.('depense', null)
    if (d && d.jour === new Date().toLocaleDateString('fr-FR') && d.usd >= this.budget) {
      console.log(`💸 Budget du jour atteint (${d.usd.toFixed(2)} $) : je passe sur ${MODELE_ECO}.`)
      this.model = MODELE_ECO
    }
  }

  _trim () {
    const h = this.memory.history
    if (h.length <= MAX_HISTORY) return
    const isPlainUser = (m) => m.role === 'user' && (typeof m.content === 'string' || !m.content.some(b => b.type === 'tool_result'))
    let i = h.length - MAX_HISTORY
    while (i < h.length && !isPlainUser(h[i])) i++
    h.splice(0, i)
  }
}

module.exports = { Brain }
