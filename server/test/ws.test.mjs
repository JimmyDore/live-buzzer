import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';

import {
  attachWebSocketServer,
  computeAccept,
  encodeFrame,
  FrameDecoder,
  OPCODE_BINAIRE,
  OPCODE_CLOSE,
  OPCODE_CONTINUATION,
  OPCODE_PING,
  OPCODE_PONG,
  OPCODE_TEXTE,
} from '../ws.mjs';

/* ---------------------------------------------------------------------------
   Suite de la couche transport. C'est la plus fournie du projet : une trame
   mal décodée un soir de soirée, ce n'est pas un bug, c'est la soirée qui
   s'arrête. Tout ce qui est affirmé ici est vérifié sur les octets du fil,
   jamais sur une intention.
--------------------------------------------------------------------------- */

// ---------------------------------------------------------------- outillage

const CLE_TEST = randomBytes(16).toString('base64');
const MASQUE = Buffer.from([0x12, 0x34, 0x56, 0x78]);

/** Construit une trame CLIENT (masquée par défaut, comme un navigateur). */
function trameClient(charge, { opcode = OPCODE_TEXTE, fin = true, cle = MASQUE, masque = true } = {}) {
  const corps = Buffer.isBuffer(charge) ? Buffer.from(charge) : Buffer.from(String(charge), 'utf8');
  const len = corps.length;

  let entete;
  if (len <= 125) {
    entete = Buffer.alloc(2);
    entete[1] = len;
  } else if (len <= 0xffff) {
    entete = Buffer.alloc(4);
    entete[1] = 126;
    entete.writeUInt16BE(len, 2);
  } else {
    entete = Buffer.alloc(10);
    entete[1] = 127;
    entete.writeUInt32BE(0, 2);
    entete.writeUInt32BE(len, 6);
  }
  entete[0] = (fin ? 0x80 : 0) | opcode;

  if (!masque) return Buffer.concat([entete, corps]);

  entete[1] |= 0x80;
  const masquee = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masquee[i] = corps[i] ^ cle[i % 4];
  return Buffer.concat([entete, cle, masquee]);
}

/**
 * Retourne une trame SERVEUR en trame CLIENT en réutilisant son encodage de
 * longueur : c'est ce qui fait de l'aller-retour un vrai aller-retour, et pas
 * deux implémentations qui se congratulent.
 */
function versClient(trame, cle = Buffer.from([0xa1, 0xb2, 0xc3, 0xd4])) {
  const len7 = trame[1] & 0x7f;
  const taille = len7 <= 125 ? 2 : len7 === 126 ? 4 : 10;
  const tete = Buffer.from(trame.subarray(0, taille));
  tete[1] |= 0x80;
  const corps = trame.subarray(taille);
  const masquee = Buffer.allocUnsafe(corps.length);
  for (let i = 0; i < corps.length; i++) masquee[i] = corps[i] ^ cle[i % 4];
  return Buffer.concat([tete, cle, masquee]);
}

/** Décodeur des trames SERVEUR (non masquées) — écrit à la main côté client. */
class LecteurServeur {
  constructor() {
    this.tampon = Buffer.alloc(0);
    this.trames = [];
    this.attentes = [];
  }

  pousser(chunk) {
    this.tampon = Buffer.concat([this.tampon, chunk]);
    for (;;) {
      const buf = this.tampon;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masque = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let taille = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        taille = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        taille = 10;
      }
      const debut = taille + (masque ? 4 : 0);
      if (buf.length < debut + len) return;
      const charge = Buffer.from(buf.subarray(debut, debut + len));
      this.tampon = Buffer.from(buf.subarray(debut + len));
      this.#livrer({ fin, opcode, masque, charge });
    }
  }

  #livrer(trame) {
    const attente = this.attentes.shift();
    if (attente) attente(trame);
    else this.trames.push(trame);
  }

  prochaine() {
    if (this.trames.length > 0) return Promise.resolve(this.trames.shift());
    return new Promise((resolve) => this.attentes.push(resolve));
  }
}

/** Socket bouchonnée : permet de piloter écritures, saturation et minuteries. */
class SocketFactice extends EventEmitter {
  constructor({ ecoule = true } = {}) {
    super();
    this.ecrit = [];
    this.rappels = [];
    this.detruite = false;
    this.finie = false;
    this.noDelay = null;
    this.ecoule = ecoule;
  }

  setNoDelay(valeur) {
    this.noDelay = valeur;
  }

  setTimeout() {}

  write(data, rappel) {
    this.ecrit.push(Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data), 'utf8'));
    // Le rappel n'est jamais déclenché quand `ecoule` est faux : c'est
    // exactement une socket qui ne se vide pas.
    if (rappel && this.ecoule) this.rappels.push(rappel);
    return this.ecoule;
  }

  end() {
    this.finie = true;
  }

  destroy() {
    if (this.detruite) return;
    this.detruite = true;
    this.emit('close');
  }

  /** L'en-tête HTTP de la poignée de main (première écriture). */
  get handshake() {
    return this.ecrit[0].toString('latin1');
  }

  /** Les trames WebSocket écrites après la poignée de main. */
  tramesEcrites() {
    const lecteur = new LecteurServeur();
    for (const bloc of this.ecrit.slice(1)) lecteur.pousser(bloc);
    return lecteur.trames;
  }
}

function requeteFactice({ url = '/ws', cle = CLE_TEST, version = '13' } = {}) {
  return { url, headers: { upgrade: 'websocket', 'sec-websocket-key': cle, 'sec-websocket-version': version } };
}

/**
 * Harnais « socket bouchonnée » : un vrai serveur HTTP à l'écoute (pour ne pas
 * dépendre d'un process sans handle), mais une socket sous contrôle total.
 */
async function harnais(options = {}, socketOptions = {}) {
  const httpServer = createServer();
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

  const messages = [];
  let conn = null;
  let fermetures = 0;
  const ws = attachWebSocketServer(httpServer, {
    log: () => {},
    onConnection: (c) => {
      conn = c;
      c.on('message', (m) => messages.push(m));
      c.on('close', () => {
        fermetures += 1;
      });
    },
    ...options,
  });

  const socket = new SocketFactice(socketOptions);
  httpServer.emit('upgrade', requeteFactice(), socket, Buffer.alloc(0));

  return {
    socket,
    messages,
    ws,
    get conn() {
      return conn;
    },
    get fermetures() {
      return fermetures;
    },
    /** Attend l'événement `close` du Conn. */
    attendreFermeture() {
      return new Promise((resolve) => conn.on('close', resolve));
    },
    fermer() {
      ws.close();
      return new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- client TCP brut

/** Client WebSocket écrit à la main, avec node:net et node:crypto. */
class ClientBrut {
  constructor(socket, reste) {
    this.socket = socket;
    this.lecteur = new LecteurServeur();
    this.ferme = once(socket, 'close');
    socket.on('data', (chunk) => this.lecteur.pousser(chunk));
    socket.on('error', () => {});
    if (reste && reste.length > 0) this.lecteur.pousser(reste);
  }

  envoyer(charge, options) {
    this.socket.write(trameClient(charge, options));
  }

  prochaine() {
    return this.lecteur.prochaine();
  }

  detruire() {
    this.socket.destroy();
  }
}

/** Ouvre une socket TCP et joue la poignée de main HTTP à la main. */
async function poigneeDeMain(port, { chemin = '/ws', cle = CLE_TEST, version = '13', avecCle = true } = {}) {
  const socket = connect({ port, host: '127.0.0.1' });
  await once(socket, 'connect');

  let requete = `GET ${chemin} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`;
  if (avecCle) requete += `Sec-WebSocket-Key: ${cle}\r\n`;
  if (version) requete += `Sec-WebSocket-Version: ${version}\r\n`;
  socket.write(`${requete}\r\n`);

  const { entete, reste } = await lireEntete(socket);
  const lignes = entete.split('\r\n');
  const enTetes = new Map();
  for (const ligne of lignes.slice(1)) {
    const i = ligne.indexOf(':');
    if (i > 0) enTetes.set(ligne.slice(0, i).trim().toLowerCase(), ligne.slice(i + 1).trim());
  }
  return { socket, statut: lignes[0], enTetes, reste };
}

function lireEntete(socket) {
  return new Promise((resolve, reject) => {
    let tampon = Buffer.alloc(0);
    const nettoyer = () => {
      socket.off('data', surData);
      socket.off('error', surErreur);
      socket.off('close', surFermeture);
    };
    const surData = (chunk) => {
      tampon = Buffer.concat([tampon, chunk]);
      const i = tampon.indexOf('\r\n\r\n');
      if (i === -1) return;
      nettoyer();
      resolve({ entete: tampon.subarray(0, i + 2).toString('latin1'), reste: tampon.subarray(i + 4) });
    };
    const surErreur = (err) => {
      nettoyer();
      reject(err);
    };
    const surFermeture = () => {
      nettoyer();
      reject(new Error(`socket fermée avant la fin des en-têtes (${tampon.length} octets)`));
    };
    socket.on('data', surData);
    socket.on('error', surErreur);
    socket.on('close', surFermeture);
  });
}

/** Démarre un vrai serveur HTTP + WebSocket qui renvoie l'écho des messages. */
async function demarrerServeur(options = {}) {
  const httpServer = createServer((req, res) => res.writeHead(404).end());
  const recus = [];
  const ws = attachWebSocketServer(httpServer, {
    log: () => {},
    onConnection: (conn) => {
      conn.on('message', (texte) => {
        recus.push(texte);
        conn.send(`echo:${texte}`);
      });
    },
    ...options,
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return {
    port: httpServer.address().port,
    recus,
    ws,
    fermer() {
      ws.close();
      return new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

// ---------------------------------------------------------- 1. Sec-WebSocket-Accept

test('computeAccept rend la valeur du vecteur canonique de la RFC 6455', () => {
  assert.equal(computeAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('computeAccept rend 28 caractères de base64 pour une clé quelconque', () => {
  const accept = computeAccept(randomBytes(16).toString('base64'));
  assert.equal(accept.length, 28);
  assert.match(accept, /^[A-Za-z0-9+/]{27}=$/);
});

// ------------------------------------------- 2. frontières 125 / 126 / 65535 / 65536

test('encodeFrame choisit le bon encodage de longueur à 125 octets (7 bits)', () => {
  const trame = encodeFrame('x'.repeat(125));
  assert.equal(trame[0], 0x81, 'FIN=1, opcode texte, aucun bit RSV');
  assert.equal(trame[1] & 0x80, 0, 'une trame serveur n\'est jamais masquée');
  assert.equal(trame[1] & 0x7f, 125, 'longueur écrite en clair sur 7 bits');
  assert.equal(trame.length, 2 + 125);
});

test('encodeFrame bascule sur 16 bits à 126 octets', () => {
  const trame = encodeFrame('x'.repeat(126));
  assert.equal(trame[1] & 0x7f, 126, 'le champ vaut 126, la longueur suit sur 2 octets');
  assert.equal(trame.readUInt16BE(2), 126);
  assert.equal(trame.length, 4 + 126);
});

test('encodeFrame reste sur 16 bits à 65 535 octets', () => {
  const trame = encodeFrame('x'.repeat(65535));
  assert.equal(trame[1] & 0x7f, 126);
  assert.equal(trame.readUInt16BE(2), 65535);
  assert.equal(trame.length, 4 + 65535);
});

test('encodeFrame bascule sur 64 bits à 65 536 octets', () => {
  const trame = encodeFrame('x'.repeat(65536));
  assert.equal(trame[1] & 0x7f, 127, 'le champ vaut 127, la longueur suit sur 8 octets');
  assert.equal(trame.readUInt32BE(2), 0, 'les 4 octets de poids fort sont à zéro');
  assert.equal(trame.readUInt32BE(6), 65536);
  assert.equal(trame.length, 10 + 65536);
});

test('un aller-retour encode/décode conserve le payload aux quatre frontières', () => {
  for (const taille of [0, 1, 125, 126, 127, 65535, 65536]) {
    const texte = 'é'.repeat(0) + 'x'.repeat(taille); // ASCII : 1 octet = 1 caractère
    const decodeur = new FrameDecoder();
    const trames = decodeur.push(versClient(encodeFrame(texte)));
    assert.equal(trames.length, 1, `une seule trame à ${taille} octets`);
    assert.equal(trames[0].type, 'text');
    assert.equal(trames[0].payload.length, taille, `payload de ${taille} octets`);
    assert.equal(trames[0].payload.toString('utf8'), texte);
    assert.equal(decodeur.enAttente, 0, 'rien ne doit rester en attente');
  }
});

// ------------------------------------------------- 3. trame coupée sur plusieurs paquets

test('une trame coupée en plein en-tête ne rend un message qu\'une fois complète', () => {
  const trame = trameClient('x'.repeat(300)); // en-tête de 4 octets (len == 126)
  const decodeur = new FrameDecoder();
  assert.deepEqual(decodeur.push(trame.subarray(0, 3)), [], 'en-tête tronqué : rien à livrer');
  const trames = decodeur.push(trame.subarray(3));
  assert.equal(trames.length, 1);
  assert.equal(trames[0].payload.toString('utf8'), 'x'.repeat(300));
});

test('une trame coupée en plein payload ne rend un message qu\'une fois complète', () => {
  const trame = trameClient('{"t":"buzz","at":1753630000123}');
  const coupe = trame.length - 7;
  const decodeur = new FrameDecoder();
  assert.deepEqual(decodeur.push(trame.subarray(0, coupe)), [], 'payload incomplet : rien à livrer');
  const trames = decodeur.push(trame.subarray(coupe));
  assert.equal(trames.length, 1);
  assert.equal(trames[0].payload.toString('utf8'), '{"t":"buzz","at":1753630000123}');
});

test('une trame de 70 000 octets poussée octet par octet rend un seul message intact', () => {
  const texte = 'a'.repeat(70_000);
  const trame = trameClient(texte);
  const decodeur = new FrameDecoder();
  let rendus = [];
  for (const octet of trame) rendus = rendus.concat(decodeur.push(Buffer.from([octet])));
  assert.equal(rendus.length, 1, 'un seul message, quelle que soit la découpe TCP');
  assert.equal(rendus[0].payload.toString('utf8'), texte);
});

// --------------------------------------------------- 4. plusieurs trames dans un paquet

test('deux trames complètes dans un seul paquet rendent deux messages, dans l\'ordre', () => {
  const paquet = Buffer.concat([trameClient('{"t":"sync","c":1}'), trameClient('{"t":"buzz","at":2}')]);
  const trames = new FrameDecoder().push(paquet);
  assert.equal(trames.length, 2);
  assert.equal(trames[0].payload.toString('utf8'), '{"t":"sync","c":1}');
  assert.equal(trames[1].payload.toString('utf8'), '{"t":"buzz","at":2}');
});

test('trois trames et demie dans un paquet : les complètes sortent, le reliquat attend', () => {
  const entiere = trameClient('un');
  const partielle = trameClient('quatre').subarray(0, 4);
  const decodeur = new FrameDecoder();
  const trames = decodeur.push(Buffer.concat([entiere, trameClient('deux'), trameClient('trois'), partielle]));
  assert.deepEqual(
    trames.map((t) => t.payload.toString('utf8')),
    ['un', 'deux', 'trois'],
  );
  assert.equal(decodeur.enAttente, partielle.length, 'seul le reliquat reste en tampon');
  assert.equal(decodeur.push(trameClient('quatre').subarray(4))[0].payload.toString('utf8'), 'quatre');
});

// ------------------------------------------------------------------ 5. continuation

test('une trame FIN=0 suivie d\'une continuation FIN=1 donne un seul message', () => {
  const paquet = Buffer.concat([
    trameClient('Marie ', { fin: false }),
    trameClient('a buzzé', { opcode: OPCODE_CONTINUATION, fin: true }),
  ]);
  const trames = new FrameDecoder().push(paquet);
  assert.equal(trames.length, 1, 'un message applicatif, pas deux');
  assert.equal(trames[0].type, 'text');
  assert.equal(trames[0].payload.toString('utf8'), 'Marie a buzzé');
});

test('un message fragmenté en trois morceaux est réassemblé dans l\'ordre', () => {
  const decodeur = new FrameDecoder();
  assert.deepEqual(decodeur.push(trameClient('{"t":', { fin: false })), []);
  assert.deepEqual(decodeur.push(trameClient('"next"', { opcode: OPCODE_CONTINUATION, fin: false })), []);
  const trames = decodeur.push(trameClient('}', { opcode: OPCODE_CONTINUATION, fin: true }));
  assert.equal(trames.length, 1);
  assert.equal(trames[0].payload.toString('utf8'), '{"t":"next"}');
});

test('un ping glissé au milieu d\'un message fragmenté ne casse pas le réassemblage', () => {
  const paquet = Buffer.concat([
    trameClient('début ', { fin: false }),
    trameClient('vivant', { opcode: OPCODE_PING }),
    trameClient('et fin', { opcode: OPCODE_CONTINUATION, fin: true }),
  ]);
  const trames = new FrameDecoder().push(paquet);
  assert.deepEqual(
    trames.map((t) => t.type),
    ['ping', 'text'],
  );
  assert.equal(trames[1].payload.toString('utf8'), 'début et fin');
});

test('une continuation sans trame initiale est une erreur de protocole (1002)', () => {
  assert.throws(() => new FrameDecoder().push(trameClient('orphelin', { opcode: OPCODE_CONTINUATION })), {
    wsCode: 1002,
  });
});

test('une trame texte reçue pendant un message fragmenté est refusée (1002)', () => {
  const decodeur = new FrameDecoder();
  decodeur.push(trameClient('début', { fin: false }));
  assert.throws(() => decodeur.push(trameClient('intrus')), { wsCode: 1002 });
});

// ------------------------------------------------------------------ 6. ping / pong

test('un ping est rendu tel quel par le décodeur, avec son payload', () => {
  const trames = new FrameDecoder().push(trameClient('ping-42', { opcode: OPCODE_PING }));
  assert.equal(trames[0].type, 'ping');
  assert.equal(trames[0].payload.toString('utf8'), 'ping-42');
});

test('le serveur répond au ping par un pong au payload identique', async (t) => {
  const h = await harnais();
  t.after(() => h.fermer());

  h.socket.emit('data', trameClient('charge-de-ping', { opcode: OPCODE_PING }));

  const trames = h.socket.tramesEcrites();
  assert.equal(trames.length, 1, 'exactement une trame en réponse');
  assert.equal(trames[0].opcode, OPCODE_PONG, 'opcode 0xA');
  assert.equal(trames[0].masque, false, 'une trame serveur n\'est jamais masquée');
  assert.equal(trames[0].charge.toString('utf8'), 'charge-de-ping');
});

test('un pong entrant ne produit ni réponse ni message applicatif', async (t) => {
  const h = await harnais();
  t.after(() => h.fermer());

  h.socket.emit('data', trameClient('peu importe', { opcode: OPCODE_PONG }));

  assert.deepEqual(h.socket.tramesEcrites(), []);
  assert.deepEqual(h.messages, []);
  assert.equal(h.conn.isOpen, true);
});

// ---------------------------------------------------------------------- 7. close

test('un close entrant est rendu avec son code et sa raison', () => {
  const charge = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from('au revoir', 'utf8')]);
  const trames = new FrameDecoder().push(trameClient(charge, { opcode: OPCODE_CLOSE }));
  assert.equal(trames[0].type, 'close');
  assert.equal(trames[0].code, 1000);
  assert.equal(trames[0].payload.toString('utf8'), 'au revoir');
});

test('un close entrant fait répondre un close et ferme la connexion', async (t) => {
  const h = await harnais();
  t.after(() => h.fermer());

  const charge = Buffer.alloc(2);
  charge.writeUInt16BE(1000, 0);
  h.socket.emit('data', trameClient(charge, { opcode: OPCODE_CLOSE }));

  const trames = h.socket.tramesEcrites();
  assert.equal(trames[0].opcode, OPCODE_CLOSE, 'le close est renvoyé en écho');
  assert.equal(trames[0].charge.readUInt16BE(0), 1000);
  assert.equal(h.conn.isOpen, false);
  assert.equal(h.socket.finie, true, 'la socket est terminée côté serveur');
  assert.equal(h.fermetures, 1, 'l\'écouteur close du métier a été prévenu une seule fois');
});

test('un code de fermeture interdit sur le fil (1005) est remplacé par 1000', async (t) => {
  const h = await harnais();
  t.after(() => h.fermer());

  h.conn.close(1005, 'pas sur le fil');

  assert.equal(h.socket.tramesEcrites()[0].charge.readUInt16BE(0), 1000);
});

test('close() deux fois de suite n\'écrit qu\'une trame et n\'émet qu\'un événement', async (t) => {
  const h = await harnais();
  t.after(() => h.fermer());

  h.conn.close(1001, 'une fois');
  h.conn.close(1001, 'deux fois');

  assert.equal(h.socket.tramesEcrites().length, 1);
  assert.equal(h.fermetures, 1);
  assert.equal(h.conn.send('trop tard'), false, 'send sur une connexion fermée rend false');
});

// ----------------------------------------------------------- 8. trame binaire refusée

test('une trame binaire est refusée par le décodeur avec le code 1003', () => {
  assert.throws(() => new FrameDecoder().push(trameClient(Buffer.from([1, 2, 3]), { opcode: OPCODE_BINAIRE })), {
    wsCode: 1003,
  });
});

test('une trame binaire ferme la connexion avec un close 1003', async (t) => {
  const h = await harnais();
  t.after(() => h.fermer());

  h.socket.emit('data', trameClient(Buffer.from([0xde, 0xad, 0xbe, 0xef]), { opcode: OPCODE_BINAIRE }));

  const trames = h.socket.tramesEcrites();
  assert.equal(trames[0].opcode, OPCODE_CLOSE);
  assert.equal(trames[0].charge.readUInt16BE(0), 1003, 'code 1003 : type de donnée non acceptable');
  assert.equal(h.conn.isOpen, false);
  assert.equal(h.fermetures, 1);
});

// -------------------------------------------------------- 9. trame non masquée refusée

test('une trame client non masquée est refusée par le décodeur avec le code 1002', () => {
  assert.throws(() => new FrameDecoder().push(trameClient('sans masque', { masque: false })), { wsCode: 1002 });
});

test('une trame client non masquée ferme la connexion avec un close 1002', async (t) => {
  const h = await harnais();
  t.after(() => h.fermer());

  h.socket.emit('data', trameClient('sans masque', { masque: false }));

  const trames = h.socket.tramesEcrites();
  assert.equal(trames[0].opcode, OPCODE_CLOSE);
  assert.equal(trames[0].charge.readUInt16BE(0), 1002, 'code 1002 : erreur de protocole');
  assert.equal(h.conn.isOpen, false);
});

test('un bit RSV positionné est refusé : aucune extension n\'a été négociée', () => {
  const trame = trameClient('compressé ?');
  trame[0] |= 0x40; // RSV1, celui de permessage-deflate
  assert.throws(() => new FrameDecoder().push(trame), { wsCode: 1002 });
});

test('une trame de contrôle fragmentée ou trop longue est refusée (1002)', () => {
  assert.throws(() => new FrameDecoder().push(trameClient('a', { opcode: OPCODE_PING, fin: false })), {
    wsCode: 1002,
  });
  assert.throws(() => new FrameDecoder().push(trameClient('x'.repeat(126), { opcode: OPCODE_PING })), {
    wsCode: 1002,
  });
});

test('un opcode inconnu est refusé (1002)', () => {
  assert.throws(() => new FrameDecoder().push(trameClient('inconnu', { opcode: 0x3 })), { wsCode: 1002 });
  assert.throws(() => new FrameDecoder().push(trameClient('inconnu', { opcode: 0xb })), { wsCode: 1002 });
});

// ----------------------------------------------------------------- 10. UTF-8 multioctet

test('un payload UTF-8 accentué et émoji survit à l\'aller-retour au caractère près', () => {
  const texte = '{"t":"buzz","name":"Jean-Christophe élève 😀","ms":842}';
  const trames = new FrameDecoder().push(versClient(encodeFrame(texte)));
  assert.equal(trames[0].payload.toString('utf8'), texte);
  assert.equal(trames[0].payload.length, Buffer.byteLength(texte, 'utf8'), 'la longueur est en OCTETS, pas en caractères');
});

test('un caractère multioctet coupé entre deux fragments est recollé correctement', () => {
  const texte = 'Jean-Christophe élève 😀';
  const octets = Buffer.from(texte, 'utf8');
  const coupe = octets.length - 2; // au beau milieu des 4 octets de l'émoji
  const decodeur = new FrameDecoder();
  decodeur.push(trameClient(octets.subarray(0, coupe), { fin: false }));
  const trames = decodeur.push(trameClient(octets.subarray(coupe), { opcode: OPCODE_CONTINUATION, fin: true }));
  assert.equal(trames[0].payload.toString('utf8'), texte, 'l\'émoji n\'est pas remplacé par des losanges');
});

// --------------------------------------------------------- 11. message trop volumineux

test('un message annoncé au-dessus de maxMessageSize est refusé sur son seul en-tête (1009)', () => {
  const decodeur = new FrameDecoder({ maxMessageSize: 1024 });
  // 4 octets d'en-tête annonçant 2000 octets : le refus tombe AVANT que le
  // moindre octet de payload n'ait été poussé, donc sans rien allouer.
  const entete = Buffer.from([0x81, 0xfe, 0x07, 0xd0]);
  assert.throws(() => decodeur.push(entete), { wsCode: 1009 });
});

test('une longueur absurde sur 64 bits est refusée sans allouer (1009)', () => {
  const decodeur = new FrameDecoder({ maxMessageSize: 1024 });
  // 0x0000_00FF_0000_0000 octets, soit 1 To : personne n'alloue ça.
  const entete = Buffer.from([0x81, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00]);
  assert.throws(() => decodeur.push(entete), { wsCode: 1009 });
});

test('un message sous la limite passe, un message juste au-dessus est refusé', () => {
  const limite = 512;
  assert.equal(new FrameDecoder({ maxMessageSize: limite }).push(trameClient('x'.repeat(limite))).length, 1);
  assert.throws(() => new FrameDecoder({ maxMessageSize: limite }).push(trameClient('x'.repeat(limite + 1))), {
    wsCode: 1009,
  });
});

test('un message fragmenté qui dépasse la limite par accumulation est refusé (1009)', () => {
  const decodeur = new FrameDecoder({ maxMessageSize: 300 });
  decodeur.push(trameClient('x'.repeat(200), { fin: false }));
  assert.throws(() => decodeur.push(trameClient('x'.repeat(200), { opcode: OPCODE_CONTINUATION, fin: true })), {
    wsCode: 1009,
  });
});

test('un message trop volumineux ferme la connexion avec un close 1009', async (t) => {
  const h = await harnais({ maxMessageSize: 256 });
  t.after(() => h.fermer());

  h.socket.emit('data', trameClient('x'.repeat(1000)));

  const trames = h.socket.tramesEcrites();
  assert.equal(trames[0].opcode, OPCODE_CLOSE);
  assert.equal(trames[0].charge.readUInt16BE(0), 1009);
  assert.equal(h.conn.isOpen, false);
});

// ------------------------------------------------------------- 12. bout en bout réel

test('bout en bout : poignée de main, écho, ping/pong et fermeture propre sur une vraie socket TCP', async (t) => {
  const serveur = await demarrerServeur();
  t.after(() => serveur.fermer());

  const cle = randomBytes(16).toString('base64');
  const { socket, statut, enTetes, reste } = await poigneeDeMain(serveur.port, { cle });
  const client = new ClientBrut(socket, reste);
  t.after(() => client.detruire());

  // --- poignée de main ---
  assert.equal(statut, 'HTTP/1.1 101 Switching Protocols');
  assert.equal(enTetes.get('upgrade')?.toLowerCase(), 'websocket');
  assert.equal(enTetes.get('connection')?.toLowerCase(), 'upgrade');
  assert.equal(enTetes.get('sec-websocket-accept'), computeAccept(cle));
  assert.equal(
    enTetes.has('sec-websocket-extensions'),
    false,
    'aucune extension ne doit être négociée : pas de permessage-deflate',
  );

  // --- écho d'un message applicatif accentué ---
  const message = '{"t":"hello","name":"Jean-Christophe élève 😀"}';
  client.envoyer(message);
  const echo = await client.prochaine();
  assert.equal(echo.opcode, OPCODE_TEXTE);
  assert.equal(echo.fin, true);
  assert.equal(echo.masque, false, 'le serveur ne masque jamais ses trames');
  assert.equal(echo.charge.toString('utf8'), `echo:${message}`);

  // --- gros message : encodage 64 bits ET fragmentation TCP réelle ---
  const gros = 'z'.repeat(70_000);
  client.envoyer(gros);
  const grosEcho = await client.prochaine();
  assert.equal(grosEcho.charge.length, 70_005);
  assert.equal(grosEcho.charge.toString('utf8'), `echo:${gros}`);

  // --- ping / pong ---
  client.envoyer('sonde-liveness', { opcode: OPCODE_PING });
  const pong = await client.prochaine();
  assert.equal(pong.opcode, OPCODE_PONG);
  assert.equal(pong.charge.toString('utf8'), 'sonde-liveness');

  // --- fermeture ---
  const adieu = Buffer.alloc(2);
  adieu.writeUInt16BE(1000, 0);
  client.envoyer(adieu, { opcode: OPCODE_CLOSE });
  const closeRecu = await client.prochaine();
  assert.equal(closeRecu.opcode, OPCODE_CLOSE);
  assert.equal(closeRecu.charge.readUInt16BE(0), 1000);
  await client.ferme;

  assert.deepEqual(serveur.recus, [message, gros]);
  assert.equal(serveur.ws.conns.size, 0, 'la connexion est retirée du registre');
});

test('bout en bout : deux messages écrits dans le même paquet TCP sortent dans l\'ordre', async (t) => {
  const serveur = await demarrerServeur();
  t.after(() => serveur.fermer());

  const { socket, reste } = await poigneeDeMain(serveur.port);
  const client = new ClientBrut(socket, reste);
  t.after(() => client.detruire());

  socket.write(Buffer.concat([trameClient('{"t":"sync"}'), trameClient('{"t":"buzz"}')]));
  const a = await client.prochaine();
  const b = await client.prochaine();
  assert.equal(a.charge.toString('utf8'), 'echo:{"t":"sync"}');
  assert.equal(b.charge.toString('utf8'), 'echo:{"t":"buzz"}');
});

test('bout en bout : un message fragmenté en continuation est réassemblé côté serveur', async (t) => {
  const serveur = await demarrerServeur();
  t.after(() => serveur.fermer());

  const { socket, reste } = await poigneeDeMain(serveur.port);
  const client = new ClientBrut(socket, reste);
  t.after(() => client.detruire());

  client.envoyer('{"t":', { fin: false });
  client.envoyer('"next"}', { opcode: OPCODE_CONTINUATION, fin: true });
  const echo = await client.prochaine();
  assert.equal(echo.charge.toString('utf8'), 'echo:{"t":"next"}');
});

test('bout en bout : une trame binaire fait fermer la connexion avec 1003', async (t) => {
  const serveur = await demarrerServeur();
  t.after(() => serveur.fermer());

  const { socket, reste } = await poigneeDeMain(serveur.port);
  const client = new ClientBrut(socket, reste);
  t.after(() => client.detruire());

  client.envoyer(Buffer.from([0x00, 0x01, 0x02]), { opcode: OPCODE_BINAIRE });
  const trame = await client.prochaine();
  assert.equal(trame.opcode, OPCODE_CLOSE);
  assert.equal(trame.charge.readUInt16BE(0), 1003);
  await client.ferme;
});

test('bout en bout : un upgrade sur un mauvais chemin est refusé par un 400', async (t) => {
  const serveur = await demarrerServeur();
  t.after(() => serveur.fermer());

  const { socket, statut } = await poigneeDeMain(serveur.port, { chemin: '/mauvais' });
  socket.destroy();
  assert.match(statut, /^HTTP\/1\.1 400 /);
});

test('bout en bout : un upgrade sans Sec-WebSocket-Key est refusé par un 400', async (t) => {
  const serveur = await demarrerServeur();
  t.after(() => serveur.fermer());

  const { socket, statut } = await poigneeDeMain(serveur.port, { avecCle: false });
  socket.destroy();
  assert.match(statut, /^HTTP\/1\.1 400 /);
});

test('bout en bout : une Sec-WebSocket-Key malformée est refusée par un 400', async (t) => {
  const serveur = await demarrerServeur();
  t.after(() => serveur.fermer());

  const { socket, statut } = await poigneeDeMain(serveur.port, { cle: 'pas-du-base64-de-16-octets' });
  socket.destroy();
  assert.match(statut, /^HTTP\/1\.1 400 /);
});

test('bout en bout : une version WebSocket autre que 13 est refusée par un 400', async (t) => {
  const serveur = await demarrerServeur();
  t.after(() => serveur.fermer());

  const { socket, statut } = await poigneeDeMain(serveur.port, { version: '8' });
  socket.destroy();
  assert.match(statut, /^HTTP\/1\.1 400 /);
});

test('bout en bout : le chemin est comparé sans la chaîne de requête', async (t) => {
  const serveur = await demarrerServeur();
  t.after(() => serveur.fermer());

  const { socket, statut, reste } = await poigneeDeMain(serveur.port, { chemin: '/ws?code=ZK4P' });
  const client = new ClientBrut(socket, reste);
  t.after(() => client.detruire());

  assert.equal(statut, 'HTTP/1.1 101 Switching Protocols');
  client.envoyer('bonjour');
  assert.equal((await client.prochaine()).charge.toString('utf8'), 'echo:bonjour');
});

test('bout en bout : ws.close() ferme toutes les connexions ouvertes', async (t) => {
  const serveur = await demarrerServeur();
  t.after(() => serveur.fermer());

  const { socket, reste } = await poigneeDeMain(serveur.port);
  const client = new ClientBrut(socket, reste);
  t.after(() => client.detruire());

  assert.equal(serveur.ws.conns.size, 1);
  serveur.ws.close();
  const trame = await client.prochaine();
  assert.equal(trame.opcode, OPCODE_CLOSE);
  assert.equal(trame.charge.readUInt16BE(0), 1001, 'code 1001 : le serveur s\'en va');
  assert.equal(serveur.ws.conns.size, 0);
});

// ------------------------------------------------------------------ 13. backpressure

test('la poignée de main pose setNoDelay(true) et n\'annonce aucune extension', async (t) => {
  const h = await harnais();
  t.after(() => h.fermer());

  assert.equal(h.socket.noDelay, true, 'Nagle retiendrait la trame jusqu\'à 40 ms');
  assert.match(h.socket.handshake, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(h.socket.handshake, new RegExp(`Sec-WebSocket-Accept: ${computeAccept(CLE_TEST).replace(/\+/g, '\\+')}`));
  assert.equal(/sec-websocket-extensions/i.test(h.socket.handshake), false);
});

test('une socket qui ne se vide jamais est coupée dès le seuil de tampon dépassé', async (t) => {
  const h = await harnais({ maxBufferedBytes: 200 }, { ecoule: false });
  t.after(() => h.fermer());

  const message = 'x'.repeat(90); // 92 octets sur le fil (en-tête de 2 octets)
  assert.equal(h.conn.send(message), true, '92 octets en tampon : sous le seuil');
  assert.equal(h.conn.isOpen, true);
  assert.equal(h.conn.send(message), true, '184 octets en tampon : toujours sous le seuil');
  assert.equal(h.conn.isOpen, true);

  assert.equal(h.conn.send(message), false, '276 octets : au-dessus du seuil, on coupe');
  assert.equal(h.conn.isOpen, false, 'la connexion est fermée');
  assert.equal(h.socket.detruite, true, 'la socket est détruite, pas juste terminée');
  assert.equal(h.fermetures, 1, 'le métier est prévenu de la fermeture');
  assert.equal(h.conn.send('encore ?'), false, 'plus rien ne part sur une connexion morte');
});

test('une socket qui se vide normalement ne déclenche jamais la coupure de tampon', async (t) => {
  const h = await harnais({ maxBufferedBytes: 200 });
  t.after(() => h.fermer());

  for (let i = 0; i < 50; i++) assert.equal(h.conn.send('x'.repeat(90)), true);
  assert.equal(h.conn.isOpen, true, 'un client qui lit ne doit jamais être coupé');
});

// ---------------------------------------------------------------- 14. liveness

test('sans message applicatif pendant livenessMs, la connexion est déclarée morte', async (t) => {
  const h = await harnais({ livenessMs: 40 });
  t.after(() => h.fermer());

  await h.attendreFermeture();

  assert.equal(h.conn.isOpen, false);
  assert.equal(h.fermetures, 1, 'le métier est prévenu exactement une fois');
  const trames = h.socket.tramesEcrites();
  assert.equal(trames[0].opcode, OPCODE_CLOSE);
  assert.equal(trames[0].charge.readUInt16BE(0), 1001, 'code 1001 : le pair s\'en va');
});

test('chaque message texte réarme le compteur de liveness', async (t) => {
  // Délais choisis pour que l'assertion soit à SENS UNIQUE : sur une machine
  // chargée le silence mesuré ne peut que s'allonger, jamais raccourcir.
  //   sans réarmement -> fermeture à 400 ms, soit 200 ms de silence ;
  //   avec réarmement -> fermeture à ~600 ms, soit ~400 ms de silence.
  // Le seuil à 320 ms tranche entre les deux avec 80 ms de marge de chaque côté.
  const livenessMs = 400;
  const h = await harnais({ livenessMs });
  t.after(() => h.fermer());

  const ferme = h.attendreFermeture();
  await pause(200);
  assert.equal(h.conn.isOpen, true, 'la connexion vit encore : le délai n\'est pas écoulé');

  // Horodatage AVANT l'émission : la minuterie de liveness est armée sur
  // l'horloge de boucle de libuv, déjà figée au début de l'itération courante.
  // Mesurer après l'armement rendrait le silence artificiellement court.
  const dernierMessage = Date.now();
  h.socket.emit('data', trameClient('{"t":"sync","c":1}'));

  await ferme;
  const silence = Date.now() - dernierMessage;
  assert.ok(silence >= 320, `silence de ${silence} ms après le dernier message, attendu >= 320 ms`);
  assert.deepEqual(h.messages, ['{"t":"sync","c":1}']);
});

test('un flot ininterrompu de pings ne maintient pas la connexion en vie', { timeout: 5000 }, async (t) => {
  // Si le ping réarmait la liveness, la connexion ne mourrait JAMAIS et ce test
  // finirait en délai dépassé. Assertion à sens unique, là encore.
  const h = await harnais({ livenessMs: 80 });
  const sonde = setInterval(() => h.socket.emit('data', trameClient('sonde', { opcode: OPCODE_PING })), 15);
  t.after(() => {
    clearInterval(sonde);
    return h.fermer();
  });

  await h.attendreFermeture();

  assert.equal(h.conn.isOpen, false, 'un ping de contrôle ne prouve pas que l\'onglet est vivant');
  assert.deepEqual(h.messages, [], 'un ping n\'est pas un message applicatif');
});

// ------------------------------------------------------- divers : contrat et robustesse

test('conn.data est un bac à sable libre, propre à chaque connexion', async (t) => {
  const h = await harnais();
  t.after(() => h.fermer());

  assert.deepEqual(h.conn.data, {});
  h.conn.data.playerId = 'abc';
  assert.equal(h.conn.data.playerId, 'abc');
});

test('une exception d\'un écouteur du métier n\'emporte pas le transport', async (t) => {
  const h = await harnais({
    onConnection: (conn) => {
      conn.on('message', () => {
        throw new Error('bug du métier');
      });
    },
  });
  t.after(() => h.fermer());

  h.socket.emit('data', trameClient('boum'));
  assert.equal(h.ws.conns.size, 1, 'la connexion reste ouverte malgré le bug applicatif');
});

test('le `head` déjà lu par node:http est décodé et non perdu', async (t) => {
  const httpServer = createServer();
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => httpServer.close(resolve)));

  const messages = [];
  attachWebSocketServer(httpServer, {
    log: () => {},
    onConnection: (conn) => conn.on('message', (m) => messages.push(m)),
  });

  const socket = new SocketFactice();
  httpServer.emit('upgrade', requeteFactice(), socket, trameClient('{"t":"hello"}'));

  assert.deepEqual(messages, ['{"t":"hello"}'], 'le premier message ne doit jamais être perdu');
});

test('l\'ordre des messages applicatifs est conservé de bout en bout du décodeur', async (t) => {
  const h = await harnais();
  t.after(() => h.fermer());

  const attendus = Array.from({ length: 20 }, (_, i) => `{"t":"buzz","n":${i}}`);
  h.socket.emit('data', Buffer.concat(attendus.map((m) => trameClient(m))));
  assert.deepEqual(h.messages, attendus);
});

// ------------------------------- 18. FIN du client sur une socket half-open

test('bout en bout : un client qui ferme sa socket (FIN) est détecté immédiatement', async (t) => {
  // `node:http` crée ses sockets avec `allowHalfOpen: true` : sur un FIN du
  // client, la socket émet `end` et JAMAIS `close`. Sans traitement explicite,
  // le joueur qui ferme son onglet resterait « connecté » jusqu'au timeout de
  // liveness — 20 s de pastille verte mensongère sur la console du maître.
  const fermetures = [];
  const serveur = await demarrerServeur({
    livenessMs: 60_000, // très long : seul le FIN peut conclure ce test
    onConnection: (conn) => conn.on('close', () => fermetures.push(Date.now())),
  });
  t.after(() => serveur.fermer());

  const { socket } = await poigneeDeMain(serveur.port);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fermetures.length, 0, 'rien ne se ferme tant que le client est là');

  socket.end(); // FIN, sans trame close WebSocket : l'onglet a disparu
  const t0 = Date.now();
  while (fermetures.length === 0 && Date.now() - t0 < 2000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(fermetures.length, 1, 'le métier est prévenu du départ du joueur');
  assert.ok(Date.now() - t0 < 1000, `détecté en ${Date.now() - t0} ms, sans attendre la liveness`);
  assert.equal(serveur.ws.conns.size, 0, 'la connexion ne traîne pas dans le registre du transport');
});

test('bout en bout : après un FIN client, la socket serveur est bien libérée', async (t) => {
  const serveur = await demarrerServeur({ livenessMs: 60_000 });
  t.after(() => serveur.fermer());

  const sockets = [];
  for (let i = 0; i < 5; i++) sockets.push((await poigneeDeMain(serveur.port)).socket);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(serveur.ws.conns.size, 5);

  for (const s of sockets) s.end();
  const t0 = Date.now();
  while (serveur.ws.conns.size > 0 && Date.now() - t0 < 2000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(serveur.ws.conns.size, 0, 'les 5 connexions sont libérées sans attendre 20 s');
});
