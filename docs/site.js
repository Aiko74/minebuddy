'use strict'
// Confort et petites animations du site MineBuddy (le même fichier pour la page française et la page anglaise).
// Tout est discret, et tout se coupe si le visiteur a demandé moins d'animations à son système.
;(() => {
  // ---------- liens à remplir quand ils existent (bouton caché tant que c'est vide) ----------
  const LIENS = {
    youtube: '', // ex. https://www.youtube.com/@tachaine
    dons: '' // ex. https://ko-fi.com/tonpseudo
  }

  const en = document.documentElement.lang === 'en'
  const T = en
    ? { copie: 'Copied! In Minecraft: press T, then Ctrl+V.', copieRatee: 'Could not copy: select the text instead.', copierTitre: 'Click to copy', haut: 'Back to top', visionneuse: 'Screenshot, full size', fermer: 'Close', prec: 'Previous image', suiv: 'Next image', etoiles: (n) => `${n} star${n > 1 ? 's' : ''} on GitHub`, dl: (n) => `${n} downloads` }
    : { copie: 'Copié ! Dans Minecraft : appuie sur T, puis Ctrl+V.', copieRatee: 'Copie impossible : sélectionne le texte à la main.', copierTitre: 'Clique pour copier', haut: 'Revenir en haut', visionneuse: 'Capture en grand', fermer: 'Fermer', prec: 'Image précédente', suiv: 'Image suivante', etoiles: (n) => `${n} étoile${n > 1 ? 's' : ''} sur GitHub`, dl: (n) => `${n} téléchargements` }
  const calme = matchMedia('(prefers-reduced-motion: reduce)').matches
  const $ = (s, r = document) => r.querySelector(s)
  const $$ = (s, r = document) => [...r.querySelectorAll(s)]
  const attendre = (ms) => new Promise(r => setTimeout(r, ms))
  const ICONE = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`

  $$('[data-lien]').forEach((a) => {
    const url = LIENS[a.dataset.lien]
    if (url) a.href = url
    else a.hidden = true
  })

  // ---------- petit message en bas de l'écran ----------
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.setAttribute('role', 'status')
  toast.setAttribute('aria-live', 'polite')
  document.body.append(toast)
  let toastTimer = 0
  function message (texte) {
    toast.textContent = texte
    toast.classList.add('visible')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600)
  }

  // ---------- 1) les blocs apparaissent en douceur quand on arrive dessus ----------
  if (!calme && 'IntersectionObserver' in window) {
    const SEL = '.bloc h2, .bloc .intro, .carte, .phrase, .galerie figure, .etapes li, .pastilles li, .promesse, .guide-img, #faq details, .soutenir .actions'
    const cibles = $$(SEL)
    document.documentElement.classList.add('anim')
    cibles.forEach((el) => {
      const freres = [...el.parentElement.children].filter(c => c.matches(SEL))
      el.style.setProperty('--d', `${Math.min(freres.indexOf(el), 7) * 70}ms`)
      el.classList.add('revele')
    })
    const io = new IntersectionObserver((entrees) => {
      for (const e of entrees) if (e.isIntersecting) { e.target.classList.add('vu'); io.unobserve(e.target) }
    }, { rootMargin: '0px 0px -8% 0px' })
    cibles.forEach(el => io.observe(el))
  }

  // ---------- 2) le chat de l'accueil : plusieurs discussions qui s'enchaînent ----------
  const CONVS = [
    ['tu peux aller chercher des diamants ? on se retrouve à la base dans 30 min', 'Ok ! Je prends des torches et je descends. À tout à l\'heure à la base !'],
    ['me sios plus jvais construire', 'Ça marche, je te laisse construire. Je coupe du bois en attendant !'],
    ['il fait nuit viens on rentre', 'J\'arrive ! Je reste collé à toi, gaffe aux creepers.'],
    ['t\'as trouvé quoi aujourd\'hui ?', '3 diamants et un village au nord ! Je l\'ai retenu, on y va demain ?']
  ]
  const chat = $('[data-chat]')
  if (chat && !calme) {
    const [toi, bot] = $$('.bulle', chat)
    const nomBot = $('b', bot).textContent
    let visible = true
    new IntersectionObserver(([e]) => { visible = e.isIntersecting }).observe(chat)
    const ecrire = (bulle, nom, html) => { bulle.innerHTML = `<b>${nom}</b>${html}`; bulle.classList.remove('entre'); void bulle.offsetWidth; bulle.classList.add('entre') }
    const echappe = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    ;(async () => {
      let i = 0
      await attendre(4500) // on laisse lire la première discussion
      for (;;) {
        if (!visible || document.hidden) { await attendre(1000); continue }
        i = (i + 1) % CONVS.length
        const [question, reponse] = CONVS[i]
        chat.classList.add('sort')
        await attendre(300)
        chat.classList.remove('sort')
        bot.hidden = true
        ecrire(toi, $('b', toi).textContent, echappe(question))
        await attendre(900)
        bot.hidden = false
        ecrire(bot, nomBot, '<span class="points" aria-label="…"><i></i><i></i><i></i></span>')
        await attendre(1300)
        bot.innerHTML = `<b>${nomBot}</b>${echappe(reponse)}`
        await attendre(4800)
      }
    })()
  }

  // ---------- 3) la capture de l'accueil s'incline doucement vers la souris ----------
  const vis = $('.hero-visuel')
  const fen = vis && $('.fenetre', vis)
  if (fen && !calme && matchMedia('(pointer: fine)').matches) {
    let raf = 0
    vis.addEventListener('mousemove', (e) => {
      const r = vis.getBoundingClientRect()
      const x = (e.clientX - r.left) / r.width - 0.5
      const y = (e.clientY - r.top) / r.height - 0.5
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => { fen.style.transform = `perspective(1400px) rotateY(${x * 7}deg) rotateX(${-y * 5}deg)` })
    })
    vis.addEventListener('mouseleave', () => { cancelAnimationFrame(raf); fen.style.transform = '' })
  }

  // ---------- 4) l'en-tête : une ombre en défilant, et le menu montre où l'on est ----------
  const entete = $('.entete')
  const boutonHaut = document.createElement('button')
  boutonHaut.className = 'haut'
  boutonHaut.type = 'button'
  boutonHaut.setAttribute('aria-label', T.haut)
  boutonHaut.innerHTML = ICONE('M12 19V5M5 12l7-7 7 7')
  boutonHaut.addEventListener('click', () => window.scrollTo({ top: 0, behavior: calme ? 'auto' : 'smooth' }))
  document.body.append(boutonHaut)
  const surDefilement = () => {
    entete.classList.toggle('ombre', window.scrollY > 8)
    boutonHaut.classList.toggle('visible', window.scrollY > 900)
  }
  window.addEventListener('scroll', surDefilement, { passive: true })
  surDefilement()
  const liensMenu = $$('.menu a')
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entrees) => {
      for (const e of entrees) {
        if (e.isIntersecting) liensMenu.forEach(a => a.classList.toggle('actif', a.getAttribute('href') === `#${e.target.id}`))
      }
    }, { rootMargin: '-45% 0px -50% 0px' })
    liensMenu.map(a => document.getElementById(a.getAttribute('href').slice(1))).filter(Boolean).forEach(s => io.observe(s))
  }

  // ---------- 5) les captures s'ouvrent en grand, sans quitter la page ----------
  const liensImg = $$('.galerie a')
  if (liensImg.length) {
    const v = document.createElement('div')
    v.className = 'visionneuse'
    v.hidden = true
    v.setAttribute('role', 'dialog')
    v.setAttribute('aria-modal', 'true')
    v.setAttribute('aria-label', T.visionneuse)
    v.innerHTML = `<button type="button" class="v-btn v-fermer" aria-label="${T.fermer}">${ICONE('M6 6l12 12M18 6L6 18')}</button>
      <button type="button" class="v-btn v-prec" aria-label="${T.prec}">${ICONE('M15 5l-7 7 7 7')}</button>
      <figure><img alt=""><figcaption></figcaption></figure>
      <button type="button" class="v-btn v-suiv" aria-label="${T.suiv}">${ICONE('M9 5l7 7-7 7')}</button>`
    document.body.append(v)
    const img = $('img', v)
    let n = 0
    let retour = null
    const montrer = (k) => {
      n = (k + liensImg.length) % liensImg.length
      const a = liensImg[n]
      img.src = a.getAttribute('href')
      img.alt = $('img', a).alt
      $('figcaption', v).innerHTML = $('figcaption', a.closest('figure')).innerHTML
    }
    const ouvrir = (k) => {
      retour = document.activeElement
      montrer(k)
      v.hidden = false
      requestAnimationFrame(() => v.classList.add('ouverte'))
      document.body.style.overflow = 'hidden'
      $('.v-fermer', v).focus()
    }
    const fermer = () => {
      v.classList.remove('ouverte')
      setTimeout(() => { v.hidden = true }, calme ? 0 : 200)
      document.body.style.overflow = ''
      retour?.focus()
    }
    liensImg.forEach((a, k) => a.addEventListener('click', (e) => { e.preventDefault(); ouvrir(k) }))
    v.addEventListener('click', (e) => { if (e.target === v || e.target.tagName === 'FIGURE') fermer() })
    $('.v-fermer', v).addEventListener('click', fermer)
    $('.v-prec', v).addEventListener('click', () => montrer(n - 1))
    $('.v-suiv', v).addEventListener('click', () => montrer(n + 1))
    document.addEventListener('keydown', (e) => {
      if (v.hidden) return
      if (e.key === 'Escape') fermer()
      else if (e.key === 'ArrowLeft') montrer(n - 1)
      else if (e.key === 'ArrowRight') montrer(n + 1)
      else if (e.key === 'Tab') { // le clavier reste dans la visionneuse
        const btns = $$('button', v)
        const i = btns.indexOf(document.activeElement)
        e.preventDefault()
        btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus()
      }
    })
  }

  // ---------- 6) un clic sur une phrase d'exemple la copie, prête à coller dans le jeu ----------
  $$('.phrase blockquote').forEach((q) => {
    q.tabIndex = 0
    q.setAttribute('role', 'button')
    q.title = T.copierTitre
    const copier = async () => {
      try {
        await navigator.clipboard.writeText(q.textContent.trim())
        message(T.copie)
        q.classList.add('copiee')
        setTimeout(() => q.classList.remove('copiee'), 900)
      } catch (_) { message(T.copieRatee) }
    }
    q.addEventListener('click', copier)
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copier() } })
  })

  // ---------- 7) compteurs GitHub : ils n'apparaissent que quand il y a de quoi être fier ----------
  ;(async () => {
    let s = null
    try { s = JSON.parse(sessionStorage.getItem('mb-stats') || 'null') } catch (_) {}
    if (!s) {
      const [depot, versions] = await Promise.all([
        fetch('https://api.github.com/repos/Aiko74/minebuddy').then(r => r.json()),
        fetch('https://api.github.com/repos/Aiko74/minebuddy/releases?per_page=30').then(r => r.json())
      ])
      const dl = (Array.isArray(versions) ? versions : []).flatMap(x => x.assets || []).filter(a => /\.exe$/i.test(a.name)).reduce((t, a) => t + (a.download_count || 0), 0)
      s = { etoiles: depot.stargazers_count || 0, dl }
      try { sessionStorage.setItem('mb-stats', JSON.stringify(s)) } catch (_) {}
    }
    const morceaux = []
    if (s.dl >= 25) morceaux.push(['dl', s.dl])
    if (s.etoiles >= 5) morceaux.push(['etoiles', s.etoiles])
    if (!morceaux.length) return
    const p = document.createElement('p')
    p.className = 'compteurs'
    p.innerHTML = morceaux.map(([k]) => `<span data-k="${k}"></span>`).join('<span aria-hidden="true">·</span>')
    $('.hero .note').after(p)
    for (const [k, total] of morceaux) {
      const el = $(`[data-k="${k}"]`, p)
      if (calme) { el.textContent = T[k](total); continue }
      const t0 = performance.now()
      const tour = (t) => {
        const f = Math.min(1, (t - t0) / 1200)
        el.textContent = T[k](Math.round(total * (1 - Math.pow(1 - f, 3))))
        if (f < 1) requestAnimationFrame(tour)
      }
      requestAnimationFrame(tour)
    }
  })().catch(() => {})
})()
