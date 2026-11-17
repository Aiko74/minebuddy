'use strict'
// Dessine l'icône de MineBuddy (build/icon.png, 512x512) sans aucune bibliothèque :
// un carré arrondi vert-bleu avec une tête de robot blanche.
// Lance : node scripts/icone.js

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const N = 512
const px = Buffer.alloc(N * N * 4) // RGBA, transparent

function set (x, y, [r, g, b, a = 255]) {
  if (x < 0 || y < 0 || x >= N || y >= N) return
  const i = (y * N + x) * 4
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a
}
// rectangle aux coins arrondis, avec un léger anticrénelage sur les bords
function rectArrondi (x0, y0, w, h, r, couleur) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const cx = Math.max(x0 + r, Math.min(x + 0.5, x0 + w - r))
      const cy = Math.max(y0 + r, Math.min(y + 0.5, y0 + h - r))
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      const a = Math.max(0, Math.min(1, r - d + 0.5))
      if (a > 0) set(x, y, [...couleur.slice(0, 3), Math.round(255 * a)])
    }
  }
}
function disque (cx, cy, r, couleur) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5))
      if (a > 0) set(x, y, [...couleur.slice(0, 3), Math.round(255 * a)])
    }
  }
}

const VERT = [29, 158, 117]
const FONCE = [15, 58, 46]
const BLANC = [255, 255, 255]
rectArrondi(16, 16, 480, 480, 110, VERT) // fond
rectArrondi(243, 92, 26, 70, 13, BLANC) // antenne
disque(256, 92, 26, BLANC)
rectArrondi(116, 150, 280, 250, 60, BLANC) // tête
disque(196, 260, 32, FONCE) // yeux
disque(316, 260, 32, FONCE)
rectArrondi(186, 332, 140, 26, 13, FONCE) // sourire

// encodage PNG minimal
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const bloc = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4)
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const lignes = Buffer.alloc(N * (N * 4 + 1))
for (let y = 0; y < N; y++) { lignes[y * (N * 4 + 1)] = 0; px.copy(lignes, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4) }
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloc('IHDR', ihdr), bloc('IDAT', zlib.deflateSync(lignes, { level: 9 })), bloc('IEND', Buffer.alloc(0))])
const sortie = path.join(__dirname, '..', 'build', 'icon.png')
fs.writeFileSync(sortie, png)
console.log('Icône écrite :', sortie, png.length, 'octets')
