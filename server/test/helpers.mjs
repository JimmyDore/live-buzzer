import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';

import { openDb } from '../db.mjs';
import { creerSalon } from '../game.mjs';
import { creerProtocole } from '../protocol.mjs';

// Outillage de test. Deux principes :
//  1. la logique de jeu se teste SANS socket (faux `conn` ci-dessous) ;
//  2. l'horloge et l'aléa sont injectés, donc tous les tests de latence sont
//     déterministes à la milliseconde près.

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
export function seeded(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Horloge pilotée à la main : `h.now()` pour lire, `h.avancer(ms)` pour bouger. */
export function horloge(depart = 1_700_000_000_000) {
  let t = depart;
  return {
    now: () => t,
    avancer(ms) {
      t += ms;
      return t;
    },
    poser(ms) {
      t = ms;
      return t;
    },
  };
}

/**
 * Faux `conn` conforme au contrat d'agent A (§3 de CONTRACT.md).
 * Il enregistre ce que le serveur envoie et permet d'injecter des messages
 * client — aucune WebSocket, aucun port, aucune attente.
 */
export function fauxConn(nom = 'conn') {
  const handlers = { message: [], close: [] };
  const conn = {
    nom,
    data: {},
    isOpen: true,
    envoyes: [],
    send(texte) {
      if (!conn.isOpen) return false;
      conn.envoyes.push(JSON.parse(texte));
      return true;
    },
    close() {
      if (!conn.isOpen) return;
      conn.isOpen = false;
      for (const h of handlers.close) h();
    },
    on(evenement, fn) {
      handlers[evenement]?.push(fn);
    },
    /** Simule une trame texte reçue du client. */
    recevoir(message) {
      const texte = typeof message === 'string' ? message : JSON.stringify(message);
      for (const h of handlers.message) h(texte);
    },
    dernier(t) {
      for (let i = conn.envoyes.length - 1; i >= 0; i--) if (conn.envoyes[i].t === t) return conn.envoyes[i];
      return null;
    },
    tous(t) {
      return conn.envoyes.filter((m) => m.t === t);
    },
    vider() {
      conn.envoyes.length = 0;
    },
  };
  return conn;
}

/** Registre + protocole prêts à l'emploi, sur une base en mémoire. */
export function creerBanc({ db = openDb(':memory:'), h = horloge(), rng = seeded(7), maxJoueurs, log = () => {} } = {}) {
  const registre = creerSalon({ db, now: h.now, rng, log, maxJoueurs });
  const protocole = creerProtocole(registre, { log, now: h.now });
  return { db, h, registre, protocole };
}

/** Démarre l'API réelle sur un port libre et rend un petit client HTTP. */
export async function startApp({ h = horloge(), rng = seeded(7), maxJoueurs, log = () => {} } = {}) {
  // Import dynamique : `index.mjs` importe `ws.mjs` (agent A). Les tests de
  // logique pure ne doivent pas en dépendre.
  const { creerApp } = await import('../index.mjs');
  const { db, registre, protocole } = creerBanc({ h, rng, maxJoueurs, log });
  const server = creerApp(registre, { protocole, now: h.now, log });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const call = async (methode, chemin, { body, token } = {}) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + chemin, {
      method: methode,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const texte = await res.text();
    return { status: res.status, body: texte ? JSON.parse(texte) : null };
  };

  return {
    db,
    base,
    port,
    call,
    registre,
    protocole,
    h,
    ws: (options) => connecterWs(`ws://127.0.0.1:${port}/ws`, options),
    close: () =>
      new Promise((r) => {
        server.wsServer?.close();
        server.close(r);
      }),
  };
}

// ------------------------------------------------------------------------
// Client WebSocket brut (zéro dépendance) — sert aux tests de bout en bout.
// Une version autonome et TLS vit dans tools/smoke.mjs ; celle-ci reste
// volontairement minimale (pas de wss://, pas de fragmentation en émission).
// ------------------------------------------------------------------------

/* GUID magique de la RFC 6455 §1.3 — il se termine par `B11`, pas `B39` :
   le §4.1 du brief contient une coquille sur ce point. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function connecterWs(url, { timeoutMs = 5000 } = {}) {
  const u = new URL(url);
  const port = Number(u.port || 80);
  return new Promise((resolve, reject) => {
    const cle = randomBytes(16).toString('base64');
    const socket = connect(port, u.hostname, () => {
      socket.write(
        `GET ${u.pathname} HTTP/1.1\r\n` +
          `Host: ${u.hostname}:${port}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${cle}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.setNoDelay(true);
    const minuteur = setTimeout(() => {
      socket.destroy();
      reject(new Error(`poignée de main WebSocket : délai dépassé sur ${url}`));
    }, timeoutMs);

    let tampon = Buffer.alloc(0);
    let etabli = false;
    const messages = [];
    const attentes = [];
    const client = {
      socket,
      messages,
      envoyer(obj) {
        socket.write(trameClient(JSON.stringify(obj)));
      },
      /** Attend le prochain message de type `t` (ou n'importe lequel). */
      attendre(t, delai = 3000) {
        const deja = messages.find((m) => !m.__lu && (!t || m.t === t));
        if (deja) {
          deja.__lu = true;
          return Promise.resolve(deja);
        }
        return new Promise((res, rej) => {
          const minute = setTimeout(() => {
            const i = attentes.indexOf(entree);
            if (i >= 0) attentes.splice(i, 1);
            rej(new Error(`aucun message « ${t ?? '*'} » en ${delai} ms`));
          }, delai);
          const entree = { t, res, minute };
          attentes.push(entree);
        });
      },
      fermer() {
        socket.destroy();
      },
    };

    socket.on('data', (chunk) => {
      tampon = Buffer.concat([tampon, chunk]);
      if (!etabli) {
        const fin = tampon.indexOf('\r\n\r\n');
        if (fin < 0) return;
        const entete = tampon.subarray(0, fin).toString('latin1');
        tampon = tampon.subarray(fin + 4);
        const attendu = createHash('sha1').update(cle + GUID).digest('base64');
        if (!/^HTTP\/1\.1 101/.test(entete) || !entete.includes(attendu)) {
          clearTimeout(minuteur);
          socket.destroy();
          return reject(new Error(`poignée de main refusée : ${entete.split('\r\n')[0]}`));
        }
        etabli = true;
        clearTimeout(minuteur);
        resolve(client);
      }
      for (;;) {
        const trame = lireTrameServeur(tampon);
        if (!trame) break;
        tampon = tampon.subarray(trame.consomme);
        if (trame.opcode === 0x9) {
          socket.write(trameClient(trame.payload, 0xa));
          continue;
        }
        if (trame.opcode !== 0x1) continue;
        let msg;
        try {
          msg = JSON.parse(trame.payload.toString('utf8'));
        } catch {
          continue;
        }
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
    });
    socket.on('error', (err) => {
      clearTimeout(minuteur);
      reject(err);
    });
  });
}

/** Trame CLIENT : toujours masquée (RFC 6455 §5.3). */
export function trameClient(donnees, opcode = 0x1) {
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

/** Trame SERVEUR : jamais masquée. Rend `null` si la trame est incomplète. */
export function lireTrameServeur(tampon) {
  if (tampon.length < 2) return null;
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
  const payload = tampon.subarray(decalage, decalage + taille);
  return { opcode, payload, consomme: decalage + taille };
}
