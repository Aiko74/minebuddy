'use strict'
// Pont sécurisé entre l'interface et l'appli : l'interface n'a accès qu'à ces fonctions-là
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mb', {
  lireConfig: () => ipcRenderer.invoke('config:lire'),
  ecrireConfig: (c) => ipcRenderer.invoke('config:ecrire', c),
  ecrireCle: (cle) => ipcRenderer.invoke('cle:ecrire', cle),
  testerCle: (cle) => ipcRenderer.invoke('cle:tester', cle),
  demarrer: () => ipcRenderer.invoke('bot:demarrer'),
  arreter: () => ipcRenderer.invoke('bot:arreter'),
  redemarrer: () => ipcRenderer.invoke('bot:redemarrer'),
  dire: (texte) => ipcRenderer.invoke('bot:dire', texte),
  etat: () => ipcRenderer.invoke('bot:etat'),
  logs: () => ipcRenderer.invoke('logs:lire'),
  lireMemoire: () => ipcRenderer.invoke('memoire:lire'),
  memoire: (op, args) => ipcRenderer.invoke('memoire:op', op, args),
  ouvrirLien: (url) => ipcRenderer.invoke('lien:ouvrir', url),
  ouvrirDossier: () => ipcRenderer.invoke('dossier:ouvrir'),
  infos: () => ipcRenderer.invoke('appli:infos'),
  installerMaj: () => ipcRenderer.invoke('maj:installer'),
  carteVisible: (v) => ipcRenderer.invoke('carte:visible', v),
  surCarte: (cb) => ipcRenderer.on('bot:carte', (e, c) => cb(c)),
  surMaj: (cb) => ipcRenderer.on('maj:etat', (e, m) => cb(m)),
  lanMondes: () => ipcRenderer.invoke('lan:mondes'),
  utiliserMonde: (m) => ipcRenderer.invoke('lan:utiliser', m),
  surLog: (cb) => ipcRenderer.on('bot:log', (e, l) => cb(l)),
  surEtat: (cb) => ipcRenderer.on('bot:etat', (e, s) => cb(s)),
  surMondes: (cb) => ipcRenderer.on('lan:mondes', (e, m) => cb(m)),
  surConfig: (cb) => ipcRenderer.on('config:change', () => cb())
})
