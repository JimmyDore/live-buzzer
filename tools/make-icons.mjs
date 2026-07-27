#!/usr/bin/env node
// Génère les icônes PNG de `public/` (iOS refuse le SVG pour « Ajouter à
// l'écran d'accueil » : sans PNG, il fabrique une capture blanche — un carré
// blanc parmi les icônes, le soir où on veut que ça ait l'air d'un vrai jeu).
//
// Encodeur PNG maison, zéro dépendance npm : c'est la contrainte du projet,
// et elle vaut aussi pour l'outillage.
//
//   node tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

// `maskable` : Android rogne l'icône dans une forme variable (cercle, goutte…).
// Les icônes prévues pour ça gardent une marge de sécurité de 20 % au bord.
const SORTIES = [
  { fichier: 'apple-touch-icon.png', taille: 180, marge: 0.1 },
  { fichier: 'icon-192.png', taille: 192, marge: 0.1 },
  { fichier: 'icon-512.png', taille: 512, marge: 0.1 },
  { fichier: 'icon-512-maskable.png', taille: 512, marge: 0.2 },
];

// Jetons figés (CONTRACT.md §9).
const FOND = [0x07, 0x07, 0x0c];
const CYAN = [0x22, 0xe6, 0xff];
const MAGENTA = [0xff, 0x2f, 0xb9];

const melange = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * Math.max(0, Math.min(1, t))));

/**
 * Le buzzer vu de face : un disque cyan cerclé de halos concentriques, la
 * grammaire visuelle de toute l'app. Reconnaissable à 32 px comme à 512.
 */
function dessiner(taille, marge) {
  const pixels = Buffer.alloc(taille * taille * 3);
  const centre = taille / 2;
  // Rayon utile après la marge de sécurité maskable.
  const utile = centre - taille * marge;

  // Anneaux, du plus large au plus serré. `alpha` est la force du trait.
  const ANNEAUX = [
    { r: utile * 0.98, epaisseur: taille * 0.024, couleur: MAGENTA, alpha: 0.92 },
    { r: utile * 0.8, epaisseur: taille * 0.026, couleur: CYAN, alpha: 0.6 },
    { r: utile * 0.64, epaisseur: taille * 0.034, couleur: CYAN, alpha: 0.95 },
  ];
  const rDisque = utile * 0.47;

  for (let y = 0; y < taille; y++) {
    for (let x = 0; x < taille; x++) {
      const d = Math.hypot(x + 0.5 - centre, y + 0.5 - centre);

      // Fond : nuit de studio, réchauffée d'un souffle cyan au centre.
      let couleur = melange(FOND, CYAN, Math.max(0, 1 - d / (utile * 1.5)) * 0.14);

      for (const anneau of ANNEAUX) {
        // Couverture antialiasée : 1 au cœur du trait, 0 au-delà d'un pixel.
        const dist = Math.abs(d - anneau.r) - anneau.epaisseur / 2;
        const couverture = Math.max(0, Math.min(1, 1 - dist));
        if (couverture > 0) couleur = melange(couleur, anneau.couleur, couverture * anneau.alpha);
      }

      // Le disque : cyan plein, dégradé vers un cyan profond en bas à droite
      // pour lui donner du volume — un aplat parfait ressemble à un bouton
      // désactivé.
      const dedans = Math.max(0, Math.min(1, rDisque - d + 0.5));
      if (dedans > 0) {
        const profondeur = Math.max(0, Math.min(1, (x - centre + (y - centre)) / (rDisque * 2.6) + 0.35));
        const chair = melange(CYAN, [0x06, 0x5c, 0x74], profondeur * 0.75);
        couleur = melange(couleur, chair, dedans);
      }

      const i = (y * taille + x) * 3;
      pixels[i] = couleur[0];
      pixels[i + 1] = couleur[1];
      pixels[i + 2] = couleur[2];
    }
  }
  return pixels;
}

// --- encodage PNG ---------------------------------------------------------

const TABLE_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const octet of buf) c = TABLE_CRC[(c ^ octet) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const longueur = Buffer.alloc(4);
  longueur.writeUInt32BE(data.length);
  const corps = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corps));
  return Buffer.concat([longueur, corps, crc]);
}

function encoderPng(pixels, taille) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(taille, 0);
  ihdr.writeUInt32BE(taille, 4);
  ihdr[8] = 8; // 8 bits par canal
  ihdr[9] = 2; // couleur vraie (RGB)

  // Chaque ligne est préfixée de son octet de filtre (0 = aucun).
  const largeurLigne = taille * 3 + 1;
  const brut = Buffer.alloc(taille * largeurLigne);
  for (let y = 0; y < taille; y++) {
    brut[y * largeurLigne] = 0;
    pixels.copy(brut, y * largeurLigne + 1, y * taille * 3, (y + 1) * taille * 3);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(brut, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const { fichier, taille, marge } of SORTIES) {
  const png = encoderPng(dessiner(taille, marge), taille);
  writeFileSync(`public/${fichier}`, png);
  console.log(`public/${fichier} — ${taille}×${taille}, ${png.length} octets`);
}
