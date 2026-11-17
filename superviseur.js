'use strict'
// Lance le bot et le relance tout seul s'il plante (pratique quand personne ne surveille).
// npm start lance ce fichier ; Ctrl+C arrête tout.

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const logFile = path.join(__dirname, 'bot.log')
const log = (msg) => {
  console.log(msg)
  try { fs.appendFileSync(logFile, `${new Date().toLocaleTimeString('fr-FR')} ${msg}\n`) } catch (_) {}
}

let child = null
let stopping = false
let crashes = []

function launch () {
  child = spawn(process.execPath, [path.join(__dirname, 'index.js')], { stdio: ['inherit', 'inherit', 'pipe'] })
  // les erreurs graves vont aussi dans bot.log
  child.stderr.on('data', (d) => {
    process.stderr.write(d)
    try { fs.appendFileSync(logFile, `${new Date().toLocaleTimeString('fr-FR')} [stderr] ${d}`) } catch (_) {}
  })
  child.on('exit', (code) => {
    if (stopping || code === 0) process.exit(0)
    // trop de plantages d'affilée : on attend plus longtemps
    const now = Date.now()
    crashes = crashes.filter(t => now - t < 5 * 60000).concat(now)
    const delay = crashes.length > 3 ? 60000 : 5000
    log(`💥 Le bot s'est arrêté (code ${code}). Relance dans ${delay / 1000} s...`)
    setTimeout(launch, delay)
  })
}

process.on('SIGINT', () => {
  stopping = true
  if (!child) process.exit(0)
  // le bot affiche sa consommation puis s'arrête ; au cas où il traîne :
  setTimeout(() => process.exit(0), 3000)
})

launch()
