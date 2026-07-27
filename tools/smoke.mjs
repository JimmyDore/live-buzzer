#!/usr/bin/env node
// Joue une vraie soirée contre une instance réelle, en HTTP et en WebSocket, et
// vérifie chaque étape. Sert à prouver qu'un déploiement est vivant — pas
// seulement que le port répond.
//
//   node tools/smoke.mjs                             # local (http://localhost:8787)
//   node tools/smoke.mjs https://buzz.jimmydore.fr   # production (wss:// à travers Caddy + nginx)
//
// Zéro dépendance : le client WebSocket (poignée de main RFC 6455, trames
// masquées, TLS) est écrit à la main plus bas.

import { createHash, randomBytes } from 'node:crypto';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';

const BASE = (process.argv[2] ?? 'http://localhost:8787').replace(/\/+$/, '');
const URL_WS = BASE.replace(/^http/, 'ws') + '/ws';

let echecs = 0;
let etapes = 0;
const sockets = [];

function verifier(condition, libelle, detail = '') {
  etapes++;
  if (condition) {
    console.log(`  ✓ ${libelle}`);
  } else {
    echecs++;
    console.log(`  ✗ ${libelle}${detail ? ` — ${detail}` : ''}`);
  }
}

async function appel(methode, chemin, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + chemin, {
    method: methode,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const texte = await res.text();
  let payload = null;
  try {
    payload = texte ? JSON.parse(texte) : null;
  } catch {
    payload = { brut: texte.slice(0, 200) };
  }
  return { status: res.status, body: payload };
}

const dormir = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function terminer(codeSortie) {
  for (const s of sockets) s.destroy();
  process.exit(codeSortie);
}

/**
 * Un serveur injoignable, un TLS qui échoue, un message jamais reçu : tout ça
 * doit sortir en français avec un code de retour non nul, jamais en pile
 * d'appels. Ce script sert de sonde de déploiement — il est lu par quelqu'un
 * qui veut savoir si la soirée peut commencer.
 */
function fatal(err) {
  console.log(`\n  ✗ ÉCHEC : ${err?.message ?? err}`);
  console.log(`\n--------------------------------------------------`);
  console.log(`${etapes - echecs}/${etapes} vérifications passées avant l'arrêt sur ${BASE}\n`);
  terminer(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

// ===========================================================================
// Client WebSocket brut — RFC 6455, avec TLS. Aucune dépendance npm.
// ===========================================================================

/* GUID magique de la RFC 6455 §1.3. Il se termine par `B11`, pas `B39` :
   le §4.1 du brief contient une coquille sur ce point, et c'est l'erreur
   qu'aucun navigateur ne pardonne. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Trame CLIENT : toujours masquée (RFC 6455 §5.3). */
function trameClient(donnees, opcode = 0x1) {
  const charge = Buffer.isBuffer(donnees) ? donnees : Buffer.from(String(donnees), 'utf8');
  const masque = randomBytes(4);
  let entete;
  if (charge.length < 126) {
    entete = Buffer.from([0x80 | opcode, 0x80 | charge.length]);
  } else if (charge.length < 65536) {
    entete = Buffer.alloc(4);
    entete[0] = 0x80 | opcode;
    entete[1] = 0x80 | 126;
    entete.writeUInt16BE(charge.length, 2);
  } else {
    entete = Buffer.alloc(10);
    entete[0] = 0x80 | opcode;
    entete[1] = 0x80 | 127;
    entete.writeBigUInt64BE(BigInt(charge.length), 2);
  }
  const masquee = Buffer.allocUnsafe(charge.length);
  for (let i = 0; i < charge.length; i++) masquee[i] = charge[i] ^ masque[i % 4];
  return Buffer.concat([entete, masque, masquee]);
}

/** Trame SERVEUR : jamais masquée. Rend `null` si elle n'est pas complète. */
function lireTrame(tampon) {
  if (tampon.length < 2) return null;
  const fin = (tampon[0] & 0x80) === 0x80;
  const opcode = tampon[0] & 0x0f;
  const masquee = (tampon[1] & 0x80) === 0x80;
  let taille = tampon[1] & 0x7f;
  let decalage = 2;
  if (taille === 126) {
    if (tampon.length < 4) return null;
    taille = tampon.readUInt16BE(2);
    decalage = 4;
  } else if (taille === 127) {
    if (tampon.length < 10) return null;
    taille = Number(tampon.readBigUInt64BE(2));
    decalage = 10;
  }
  if (masquee) decalage += 4;
  if (tampon.length < decalage + taille) return null;
  return { fin, opcode, payload: tampon.subarray(decalage, decalage + taille), consomme: decalage + taille };
}

/**
 * Ouvre une WebSocket. Gère `ws://` et `wss://` (indispensable : la
 * Definition of Done exige de tourner contre https://buzz.jimmydore.fr, donc à
 * travers Caddy puis nginx).
 */
function ouvrirWs(url, { timeoutMs = 15_000 } = {}) {
  const u = new URL(url);
  const tls = u.protocol === 'wss:';
  const port = Number(u.port || (tls ? 443 : 80));

  return new Promise((resolve, reject) => {
    const cle = randomBytes(16).toString('base64');
    const options = { host: u.hostname, port, servername: u.hostname };
    const socket = tls ? connectTls(options, poignee) : connectTcp(port, u.hostname, poignee);
    sockets.push(socket);

    function poignee() {
      socket.setNoDelay(true);
      socket.write(
        `GET ${u.pathname} HTTP/1.1\r\n` +
          `Host: ${u.hostname}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${cle}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    }

    const minuteur = setTimeout(() => {
      socket.destroy();
      reject(new Error(`délai dépassé sur ${url}`));
    }, timeoutMs);

    let tampon = Buffer.alloc(0);
    let etabli = false;
    let assemblage = Buffer.alloc(0);
    const messages = [];
    const attentes = [];

    const client = {
      url,
      messages,
      envoyer(objet) {
        socket.write(trameClient(JSON.stringify(objet)));
      },
      /** Attend le prochain message non lu de type `t`. */
      attendre(t, delai = 8000) {
        const deja = messages.find((m) => !m.__lu && (!t || m.t === t));
        if (deja) {
          deja.__lu = true;
          return Promise.resolve(deja);
        }
        return new Promise((res, rej) => {
          const entree = {
            t,
            res,
            minute: setTimeout(() => {
              const i = attentes.indexOf(entree);
              if (i >= 0) attentes.splice(i, 1);
              rej(new Error(`aucun message « ${t ?? '*'} » reçu en ${delai} ms`));
            }, delai),
          };
          attentes.push(entree);
        });
      },
      recus(t) {
        return messages.filter((m) => m.t === t);
      },
      /** Marque tout le courrier en attente comme lu : les `attendre` qui
       *  suivent porteront sur des messages FRAIS, pas sur un reliquat. */
      vider() {
        for (const m of messages) m.__lu = true;
      },
      fermer() {
        socket.destroy();
      },
    };

    function livrer(msg) {
      const i = attentes.findIndex((a) => !a.t || a.t === msg.t);
      if (i >= 0) {
        const [a] = attentes.splice(i, 1);
        clearTimeout(a.minute);
        msg.__lu = true;
        messages.push(msg);
        a.res(msg);
      } else {
        messages.push(msg);
      }
    }

    socket.on('data', (chunk) => {
      tampon = Buffer.concat([tampon, chunk]);
      if (!etabli) {
        const fin = tampon.indexOf('\r\n\r\n');
        if (fin < 0) return;
        const entete = tampon.subarray(0, fin).toString('latin1');
        tampon = tampon.subarray(fin + 4);
        const attendu = createHash('sha1').update(cle + GUID).digest('base64');
        clearTimeout(minuteur);
        if (!/^HTTP\/1\.1 101/.test(entete)) {
          socket.destroy();
          return reject(new Error(`poignée de main refusée : ${entete.split('\r\n')[0]}`));
        }
        if (!entete.includes(attendu)) {
          socket.destroy();
          return reject(new Error('Sec-WebSocket-Accept incorrect'));
        }
        if (/sec-websocket-extensions/i.test(entete)) {
          socket.destroy();
          return reject(new Error('le serveur a négocié une extension : non prévu'));
        }
        etabli = true;
        resolve(client);
      }
      for (;;) {
        const trame = lireTrame(tampon);
        if (!trame) break;
        tampon = tampon.subarray(trame.consomme);
        if (trame.opcode === 0x9) {
          socket.write(trameClient(trame.payload, 0xa));
          continue;
        }
        if (trame.opcode === 0x8) {
          socket.destroy();
          break;
        }
        if (trame.opcode === 0x1 || trame.opcode === 0x0) {
          assemblage = Buffer.concat([assemblage, trame.payload]);
          if (!trame.fin) continue;
          const texte = assemblage.toString('utf8');
          assemblage = Buffer.alloc(0);
          try {
            livrer(JSON.parse(texte));
          } catch {
            /* trame non JSON : ignorée */
          }
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(minuteur);
      reject(err);
    });
  });
}

/** Synchronisation d'horloge façon NTP (§3.1) : 5 échantillons, meilleur RTT. */
async function synchroniser(client, echantillons = 5) {
  const mesures = [];
  for (let i = 0; i < echantillons; i++) {
    const t0 = performance.now();
    client.envoyer({ t: 'sync', c: t0 });
    const rep = await client.attendre('sync');
    const t1 = performance.now();
    const rtt = t1 - t0;
    if (rep.c !== t0) throw new Error('le serveur n’a pas réémis « c » intact');
    if (rtt <= 1500) mesures.push({ rtt, offset: rep.s + rtt / 2 - t1 });
    await dormir(100);
  }
  if (mesures.length === 0) return { offset: 0, rtt: NaN, mesures: 0 };
  const meilleur = mesures.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  return { ...meilleur, mesures: mesures.length };
}

// ===========================================================================
// La soirée
// ===========================================================================

console.log(`\nSoirée de bout en bout sur ${BASE}`);
console.log(`WebSocket : ${URL_WS}\n`);

// --- 1. le service répond ---------------------------------------------------
console.log('1. Service');
const sante = await appel('GET', '/api/health');
verifier(sante.status === 200 && sante.body?.ok === true, `GET /api/health → ${sante.status}`, JSON.stringify(sante.body));
if (sante.status !== 200) terminer(1);

// --- 2. création ------------------------------------------------------------
console.log('\n2. Création de la session');
const creation = await appel('POST', '/api/games');
verifier(creation.status === 201, `POST /api/games → ${creation.status}`, JSON.stringify(creation.body));
if (creation.status !== 201) terminer(1);
const { code, hostToken } = creation.body;
console.log(`     code de session : ${code}`);
verifier(/^[ACDEFGHJKMNPQRTUVWXY346789]{4}$/.test(code), 'le code est dans l’alphabet sans confusables');

const resume = await appel('GET', `/api/games/${code}`);
verifier(resume.body?.exists === true && resume.body.playerCount === 0, 'la session existe et est vide');
const inconnue = await appel('GET', '/api/games/AAAA');
verifier(inconnue.status === 200 && inconnue.body?.exists === false, 'un code inconnu rend { exists: false }, pas une erreur');

// --- 3. la console du maître se connecte ------------------------------------
console.log('\n3. WebSocket');
let hote;
try {
  hote = await ouvrirWs(URL_WS);
  verifier(true, `poignée de main WebSocket établie (${URL_WS.startsWith('wss') ? 'TLS' : 'clair'})`);
} catch (err) {
  verifier(false, 'poignée de main WebSocket', err.message);
  terminer(1);
}
hote.envoyer({ t: 'hello', role: 'host', code, token: hostToken });
const etat0 = await hote.attendre('state');
verifier(etat0.players.length === 0 && etat0.buzzes.length === 0, 'le hello rend un instantané complet et vide');
verifier(etat0.openAt === null && etat0.locked === false, 'aucune manche ouverte au départ');

/**
 * Redemande l'instantané complet sur la MÊME socket. Un second `hello` est la
 * façon normale de resynchroniser (règle d'or : chaque `hello` rend un `state`
 * complet) — ouvrir une deuxième socket hôte ferait fermer la première, ce qui
 * est le comportement voulu côté serveur.
 */
async function etatHote() {
  hote.vider();
  hote.envoyer({ t: 'hello', role: 'host', code, token: hostToken });
  return hote.attendre('state');
}

const horloge = await synchroniser(hote);
verifier(horloge.mesures >= 3, `${horloge.mesures} échantillons de synchro retenus`);
verifier(
  Number.isFinite(horloge.rtt) && horloge.rtt < 1500,
  `meilleur RTT ${horloge.rtt.toFixed(0)} ms (offset performance.now → horloge serveur : ${horloge.offset.toFixed(0)} ms)`,
);
const maintenant = () => performance.now() + horloge.offset;

// --- 4. quatre joueurs rejoignent -------------------------------------------
console.log('\n4. Quatre joueurs rejoignent');
const joueurs = [];
for (const nom of ['Marie', 'Paul', 'Marie', 'Jean-Christophe']) {
  const res = await appel('POST', `/api/games/${code}/players`, { body: { name: nom } });
  if (res.status !== 201) {
    verifier(false, `${nom} rejoint`, `${res.status} ${JSON.stringify(res.body)}`);
    terminer(1);
  }
  const conn = await ouvrirWs(URL_WS);
  conn.envoyer({ t: 'hello', role: 'player', code, token: res.body.token });
  await conn.attendre('state');
  joueurs.push({ ...res.body, conn });
}
verifier(joueurs.length === 4, '4 joueurs inscrits et connectés');
verifier(
  joueurs.map((j) => j.name).join(', ') === 'Marie, Paul, Marie (2), Jean-Christophe',
  `les homonymes sont désambiguïsées : ${joueurs.map((j) => j.name).join(', ')}`,
);
verifier(new Set(joueurs.map((j) => j.playerId)).size === 4, 'aucun identifiant en double');
verifier((await appel('GET', `/api/games/${code}`)).body.playerCount === 4, 'la session compte 4 joueurs');

// --- 5. MANCHE SUIVANTE -----------------------------------------------------
console.log('\n5. MANCHE SUIVANTE');
hote.envoyer({ t: 'next' });
const ouverture = await hote.attendre('open');
const openAt = ouverture.at;
verifier(openAt - maintenant() > 0, `l'ouverture est datée dans le futur (+${Math.round(openAt - maintenant())} ms)`);
let memeDate = true;
for (const j of joueurs) memeDate = memeDate && (await j.conn.attendre('open')).at === openAt;
verifier(memeDate, 'les 4 joueurs reçoivent exactement la même date d’ouverture');

// --- 6. les buzz, dans un ordre connu ---------------------------------------
console.log('\n6. Les buzz');
// Temps de réaction imposés. On les envoie dans l'ordre INVERSE : si le serveur
// classait par arrivée de paquet, la liste sortirait à l'envers.
const scenario = [
  { j: joueurs[2], nom: 'Marie (2)', reaction: 60 },
  { j: joueurs[0], nom: 'Marie', reaction: 140 },
  { j: joueurs[3], nom: 'Jean-Christophe', reaction: 230 },
  { j: joueurs[1], nom: 'Paul', reaction: 380 },
];
await dormir(openAt + 380 - maintenant() + 120);
for (const e of [...scenario].reverse()) e.j.conn.envoyer({ t: 'buzz', at: openAt + e.reaction });

const annonces = [];
for (let i = 0; i < scenario.length; i++) annonces.push(await hote.attendre('buzz'));
verifier(annonces.length === 4, 'les 4 buzz sont annoncés à la console');

// L'instantané complet fait foi : c'est ce que le maître a sous les yeux.
const etatFinal = await etatHote();
const obtenu = etatFinal.buzzes.map((b) => `${b.rank}. ${b.name} ${b.ms}ms`).join(' | ');
const attendu = scenario.map((e, i) => `${i + 1}. ${e.nom} ${e.reaction}ms`).join(' | ');
verifier(obtenu === attendu, 'la liste ordonnée est exactement celle des temps de réaction', `obtenu : ${obtenu}`);
console.log(`     ${obtenu}`);

// Un joueur ne voit jamais la liste des autres.
const fuite = joueurs[1].conn.recus('buzz').filter((b) => b.playerId !== joueurs[1].playerId);
verifier(fuite.length === 0, 'aucun joueur ne reçoit le buzz d’un autre');

// Second appui : rien ne change.
joueurs[0].conn.envoyer({ t: 'buzz', at: openAt + 1 });
await dormir(300);
const apresRejeu = await appel('GET', `/api/games/${code}`);
verifier(apresRejeu.body.playerCount === 4, 'un second appui ne casse rien');
const etatRejeu = await etatHote();
verifier(etatRejeu.buzzes.length === 4, 'un second appui n’ajoute aucune ligne');
verifier(
  etatRejeu.buzzes.find((b) => b.playerId === joueurs[0].playerId)?.rank === 2,
  'un second appui ne change pas la position',
);

// --- 7. sécurité : un joueur n'est pas le maître du jeu ---------------------
console.log('\n7. Sécurité');
const pirate = joueurs[1].conn;
pirate.envoyer({ t: 'next' });
verifier((await pirate.attendre('error')).code === 'BAD_TOKEN', 'un joueur qui envoie `next` est refusé');
pirate.envoyer({ t: 'lock', locked: false });
verifier((await pirate.attendre('error')).code === 'BAD_TOKEN', 'un joueur qui envoie `lock` est refusé');
pirate.envoyer({ t: 'kick', playerId: joueurs[0].playerId });
verifier((await pirate.attendre('error')).code === 'BAD_TOKEN', 'un joueur qui envoie `kick` est refusé');

const apresPirate = await etatHote();
verifier(apresPirate.buzzes.length === 4 && apresPirate.openAt === openAt, 'aucun état n’a bougé après les tentatives');

const volHttp = await appel('POST', `/api/games/${code}/buzz`, { body: { at: 0 }, token: 'jeton-bidon' });
verifier(volHttp.status === 403, `un jeton bidon sur le buzz HTTP → ${volHttp.status}`);

// --- 8. verrou --------------------------------------------------------------
console.log('\n8. Verrou');
hote.envoyer({ t: 'lock', locked: true });
verifier((await joueurs[0].conn.attendre('lock')).locked === true, 'le verrou est diffusé jusqu’aux joueurs');
const bloque = await appel('POST', `/api/games/${code}/buzz`, {
  body: { at: maintenant() },
  token: joueurs[3].token,
});
verifier(bloque.status === 409, `buzzers fermés : le repli HTTP répond ${bloque.status}`);
hote.envoyer({ t: 'lock', locked: false });
verifier((await joueurs[0].conn.attendre('lock')).locked === false, 'le déverrouillage est diffusé aussi');

// --- 9. manche suivante + repli HTTP ---------------------------------------
console.log('\n9. Manche suivante et repli HTTP (WebSocket fermée)');
hote.envoyer({ t: 'next' });
const ouverture2 = await hote.attendre('open');
const etat2 = await hote.attendre('state');
verifier(etat2.buzzes.length === 0, 'la liste est effacée');
verifier(etat2.locked === false, 'les buzzers sont rouverts');

// Le téléphone de Jean-Christophe perd sa socket : il doit quand même buzzer.
joueurs[3].conn.fermer();
await dormir(Math.max(0, ouverture2.at - maintenant()) + 200);
const secours = await appel('POST', `/api/games/${code}/buzz`, {
  body: { at: ouverture2.at + 90 },
  token: joueurs[3].token,
});
verifier(secours.status === 200, `POST /buzz de secours → ${secours.status}`, JSON.stringify(secours.body));
verifier(secours.body?.rank === 1 && secours.body?.ms === 90, `rang ${secours.body?.rank}, ${secours.body?.ms} ms`);
const vuHote = await hote.attendre('buzz');
verifier(vuHote.playerId === joueurs[3].playerId, 'le buzz de secours apparaît sur la console du maître');

// Le tricheur : il ouvre la console de son téléphone et envoie `at: 0`.
// Le bornage le ramène mécaniquement à openAt — donc premier, mais à 0 ms, et
// surtout sans rien casser. C'est la seule triche possible, et on l'accepte.
joueurs[1].conn.vider();
joueurs[1].conn.envoyer({ t: 'buzz', at: 0 });
const triche = await joueurs[1].conn.attendre('buzz');
verifier(triche.ms === 0 && triche.rank === 1, `at:0 est borné à openAt → rang ${triche.rank}, ${triche.ms} ms`);
const apresTriche = await etatHote();
verifier(
  apresTriche.buzzes.length === 2 && apresTriche.buzzes[1].playerId === joueurs[3].playerId,
  'le buzz honnête est simplement reclassé 2ᵉ, la liste reste cohérente',
);

// --- 10. exclusion et session pleine ---------------------------------------
console.log('\n10. Gestion');
joueurs[0].conn.vider();
hote.envoyer({ t: 'kick', playerId: joueurs[0].playerId });
verifier((await joueurs[0].conn.attendre('error')).code === 'BAD_TOKEN', 'le joueur exclu est prévenu');
const apresKick = await etatHote();
verifier(apresKick.players.length === 3, `${apresKick.players.length} joueurs après exclusion`);

const plein = await appel('POST', '/api/games');
const codePlein = plein.body.code;
let dernierStatut = 0;
for (let i = 0; i < 41; i++) {
  dernierStatut = (await appel('POST', `/api/games/${codePlein}/players`, { body: { name: `J${i}` } })).status;
}
verifier(dernierStatut === 409, `le 41ᵉ joueur reçoit ${dernierStatut}, un refus lisible et pas un plantage`);

// --- verdict ----------------------------------------------------------------
console.log('\n--------------------------------------------------');
console.log(`${etapes - echecs}/${etapes} vérifications passées sur ${BASE}`);
if (echecs > 0) {
  console.log(`${echecs} ÉCHEC(S)\n`);
  terminer(1);
}
console.log(`Session ${code} jouée de bout en bout, WebSocket comprise. Tout est vert.\n`);
terminer(0);
