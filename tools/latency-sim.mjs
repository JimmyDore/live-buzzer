#!/usr/bin/env node
// Preuve chiffrée de la correction de latence (§3 du brief).
//
// On simule quatre téléphones : RTT de 0, 150 et 400 ms, horloges décalées de
// −3 s à +3 s, qui buzzent à des instants réels CONNUS. Les messages traversent
// le VRAI code serveur (game.mjs + protocol.mjs), avec une horloge virtuelle
// pour que le résultat soit reproductible à la milliseconde.
//
// Ce qu'il faut prouver, et que ce script mesure :
//   1. l'ordre restitué est celui des vrais temps de réaction, PAS celui des
//      arrivées de paquets ;
//   2. le temps de réaction calculé par le serveur est juste à ± 20 ms, malgré
//      400 ms de RTT et 3 secondes de décalage d'horloge.
//
//   node tools/latency-sim.mjs

import { creerSalon } from '../server/game.mjs';
import { creerProtocole } from '../server/protocol.mjs';

const TOLERANCE_MS = 20;
const T_DEPART = 1_700_000_000_000;

// Générateur déterministe (mulberry32) : deux exécutions donnent les mêmes
// chiffres, sinon « la preuve » dépendrait de la chance.
function seeded(seed = 2026) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = seeded();

/** Gigue réseau : ± 8 % sur chaque demi-trajet, indépendamment. */
function demiTrajet(rtt) {
  return (rtt / 2) * (1 + 0.08 * (rng() * 2 - 1));
}

// --------------------------------------------------------- horloge virtuelle

let horloge = T_DEPART;
const now = () => horloge;

// ------------------------------------------------------------- faux socket

function fauxConn() {
  const handlers = { message: [], close: [] };
  const conn = {
    data: {},
    isOpen: true,
    envoyes: [],
    send(texte) {
      conn.envoyes.push(JSON.parse(texte));
      return true;
    },
    close() {
      conn.isOpen = false;
    },
    on(ev, fn) {
      handlers[ev]?.push(fn);
    },
    recevoir(obj) {
      for (const h of handlers.message) h(JSON.stringify(obj));
    },
    dernier(t) {
      for (let i = conn.envoyes.length - 1; i >= 0; i--) if (conn.envoyes[i].t === t) return conn.envoyes[i];
      return null;
    },
  };
  return conn;
}

// -------------------------------------------------------- client simulé

class Client {
  /**
   * @param {string} nom
   * @param {number} rtt      aller-retour réseau en ms
   * @param {number} decalage décalage de l'horloge locale (performance.now) en ms
   * @param {number} reaction VRAI temps de réaction du doigt, en ms
   */
  constructor(nom, rtt, decalage, reaction) {
    Object.assign(this, { nom, rtt, decalage, reaction });
    this.echantillons = [];
    this.offset = 0;
    this.conn = fauxConn();
  }

  /** L'horloge locale du client — décalée, comme un vrai performance.now(). */
  perfNow(tServeur) {
    return tServeur + this.decalage;
  }

  /**
   * Un échantillon de synchro, sur le canal applicatif (§3.1) :
   * client → {"t":"sync","c":t0} · serveur → {"t":"sync","c":t0,"s":serverNow}
   */
  synchroniser(tEnvoi) {
    const aller = demiTrajet(this.rtt);
    const retour = demiTrajet(this.rtt);
    const t0 = this.perfNow(tEnvoi);

    horloge = tEnvoi + aller; // le serveur reçoit
    this.conn.recevoir({ t: 'sync', c: t0 });
    const reponse = this.conn.dernier('sync');
    if (reponse.c !== t0) throw new Error(`${this.nom} : le serveur n'a pas réémis « c » intact`);

    const t1 = this.perfNow(tEnvoi + aller + retour);
    const rtt = t1 - t0;
    if (rtt > 1500) return; // échantillon rejeté (§3.1)
    this.echantillons.push({ rtt, offset: reponse.s + rtt / 2 - t1 });
    // On retient le MEILLEUR RTT des 8 derniers, pas la moyenne : un RTT bas
    // est un RTT peu bruité, une moyenne intègre le bruit.
    const derniers = this.echantillons.slice(-8);
    this.offset = derniers.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
  }

  /** L'estimation d'horloge serveur du client, en ms. */
  maintenant(tServeur) {
    return this.perfNow(tServeur) + this.offset;
  }
}

// ------------------------------------------------------------------ scénario

const registre = creerSalon({ now, rng: seeded(1), log: () => {} });
const protocole = creerProtocole(registre, { now, log: () => {} });

const { code, hostToken } = registre.creerPartie();
const hote = fauxConn();
protocole.onConnection(hote, {});
hote.recevoir({ t: 'hello', role: 'host', code, token: hostToken });

const clients = [
  //          nom                RTT   décalage horloge   vrai temps de réaction
  new Client('Wifi salon', 0, 0, 320),
  new Client('Wifi cuisine', 150, +3000, 285),
  new Client('4G couloir', 400, -3000, 240),
  new Client('4G jardin', 400, +1234, 610),
];

for (const c of clients) {
  const j = registre.rejoindre(code, c.nom);
  c.playerId = j.playerId;
  protocole.onConnection(c.conn, {});
  horloge = T_DEPART;
  c.conn.recevoir({ t: 'hello', role: 'player', code, token: j.token });
}

// --- 1. synchronisation : 5 échantillons rapides puis 3 périodiques ---------
let t = T_DEPART;
for (let i = 0; i < 5; i++, t += 100) for (const c of clients) c.synchroniser(t);
for (let i = 0; i < 3; i++, t += 5000) for (const c of clients) c.synchroniser(t);

// --- 2. le maître ouvre la manche ------------------------------------------
horloge = t + 1000;
const { openAt } = protocole.appliquerMancheSuivante(code, hostToken);

// --- 3. tout le monde buzze, chacun à son vrai temps de réaction ------------
const envois = clients.map((c) => {
  const tReel = openAt + c.reaction; // instant VRAI du doigt, horloge serveur
  return {
    c,
    tReel,
    at: c.maintenant(tReel), // ce que le client ose affirmer
    arrivee: tReel + demiTrajet(c.rtt), // quand le paquet atteint le serveur
  };
});

// Le serveur les reçoit dans l'ordre des arrivées, pas des doigts.
const parArrivee = [...envois].sort((a, b) => a.arrivee - b.arrivee);
for (const e of parArrivee) {
  horloge = e.arrivee;
  e.c.conn.recevoir({ t: 'buzz', at: e.at });
}

// --- 4. ce que le maître du jeu voit VRAIMENT à l'écran ----------------------
// On rejoue le flux de messages reçu par sa console, exactement comme le ferait
// le client : `state` remplace tout, `buzz` insère ou met à jour une ligne.
// Se contenter de relire l'état du serveur prouverait le tri, pas la diffusion.
const vueHote = new Map();
for (const m of hote.envoyes) {
  if (m.t === 'state') {
    vueHote.clear();
    for (const b of m.buzzes) vueHote.set(b.playerId, b);
  } else if (m.t === 'buzz') {
    vueHote.set(m.playerId, { playerId: m.playerId, name: m.name, rank: m.rank, ms: m.ms });
  }
}
const liste = [...vueHote.values()].sort((a, b) => a.rank - b.rank);
const rangServeur = new Map(liste.map((b) => [b.playerId, b]));

// Filet : l'écran du maître doit correspondre au bit près à l'état du serveur.
const officiel = registre.instantane(code).buzzes;
const ecranFidele = JSON.stringify(liste) === JSON.stringify(officiel);

// ------------------------------------------------------------------ rapport

const vraiOrdre = [...envois].sort((a, b) => a.reaction - b.reaction || 0);
const ordreAttendu = [...clients].sort((a, b) => a.reaction - b.reaction).map((c) => c.nom);
const ordreServeur = liste.map((b) => b.name);
const ordreArrivee = parArrivee.map((e) => e.c.nom);
void vraiOrdre;

console.log('\n  CORRECTION DE LATENCE — preuve chiffrée');
console.log(`  ${clients.length} clients, ouverture programmée à openAt = ${openAt} (Date.now serveur)\n`);

const lignes = [
  ['client', 'RTT', 'horloge', 'réaction', 'serveur', 'écart', 'offset est.', 'rang'],
  ['', '(ms)', '(ms)', 'vraie (ms)', 'mesuré (ms)', '(ms)', '(ms)', ''],
];
let pireEcart = 0;
for (const c of clients) {
  const b = rangServeur.get(c.playerId);
  const ecart = b ? b.ms - c.reaction : NaN;
  pireEcart = Math.max(pireEcart, Math.abs(ecart));
  lignes.push([
    c.nom,
    String(c.rtt),
    (c.decalage > 0 ? '+' : '') + c.decalage,
    String(c.reaction),
    b ? String(b.ms) : 'ABSENT',
    (ecart > 0 ? '+' : '') + ecart.toFixed(0),
    c.offset.toFixed(1),
    b ? `${b.rank}` : '—',
  ]);
}

const largeurs = lignes[0].map((_, i) => Math.max(...lignes.map((l) => String(l[i]).length)));
lignes.forEach((l, i) => {
  const rendu = l.map((v, j) => (j === 0 ? String(v).padEnd(largeurs[j]) : String(v).padStart(largeurs[j]))).join('  ');
  console.log(`  ${rendu}`);
  if (i === 1) console.log(`  ${'-'.repeat(rendu.length)}`);
});

console.log('');
console.log(`  ordre des VRAIS temps de réaction : ${ordreAttendu.join(' > ')}`);
console.log(`  ordre restitué par le serveur     : ${ordreServeur.join(' > ')}`);
console.log(`  ordre des ARRIVÉES de paquets     : ${ordreArrivee.join(' > ')}`);
console.log('');

// ------------------------------------------------------------------ verdict

let echecs = 0;
function verifier(condition, libelle) {
  console.log(`  ${condition ? '✓' : '✗'} ${libelle}`);
  if (!condition) echecs++;
}

verifier(liste.length === clients.length, `les ${clients.length} buzz sont enregistrés`);
verifier(
  JSON.stringify(ordreServeur) === JSON.stringify(ordreAttendu),
  "l'ordre restitué est exactement celui des vrais temps de réaction",
);
verifier(
  JSON.stringify(ordreArrivee) !== JSON.stringify(ordreAttendu),
  "le scénario est probant : l'ordre des arrivées, lui, est FAUX (sans correction, le classement serait celui-là)",
);
verifier(pireEcart <= TOLERANCE_MS, `tous les écarts sont dans ± ${TOLERANCE_MS} ms (pire écart : ${pireEcart} ms)`);
verifier(
  liste.every((b) => b.ms >= 0),
  'aucun temps de réaction négatif',
);
verifier(
  new Set(liste.map((b) => b.rank)).size === liste.length,
  'les rangs sont tous distincts (départage déterministe)',
);
verifier(ecranFidele, "l'écran du maître, reconstruit depuis les seuls messages reçus, égale l'état du serveur");

console.log('');
if (echecs > 0) {
  console.log(`  ÉCHEC : ${echecs} vérification(s) en défaut.\n`);
  process.exit(1);
}
console.log('  PASS — le doigt le plus rapide gagne, pas la meilleure connexion.\n');
