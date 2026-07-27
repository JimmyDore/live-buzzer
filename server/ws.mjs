import { createHash } from 'node:crypto';

/* ---------------------------------------------------------------------------
   Transport WebSocket écrit à la main (RFC 6455), zéro dépendance npm.

   Ce fichier ne connaît RIEN du jeu : ni parties, ni joueurs, ni buzz. Il ne
   fait que du transport — poignée de main, trames, ping/pong, backpressure,
   liveness — et remet au métier un objet `Conn` minimal (`send`, `close`,
   `on`, `data`).

   Deux partis pris assumés :
   - aucune extension n'est négociée (jamais d'en-tête `Sec-WebSocket-Extensions`,
     donc jamais de `permessage-deflate`) : compresser des messages de 60 octets
     doublerait la surface de bug pour rien ;
   - `setNoDelay(true)` dès la poignée de main : l'algorithme de Nagle retient
     une petite trame jusqu'à 40 ms, soit la moitié du budget de latence d'un
     buzzer. Non négociable.
--------------------------------------------------------------------------- */

/* ⚠️ GUID magique de la RFC 6455 §1.3. Il se termine par `B11`, pas `B39` :
   le brief (§4.1) contient une coquille sur ce point, et c'est la seule erreur
   du projet qu'aucun navigateur ne pardonne — la poignée de main échoue à tous
   les coups, sans message utile. Le vecteur canonique de la RFC (premier test
   de la suite) est ce qui la débusque : ne jamais toucher à cette constante
   sans le relancer. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE_CONTINUATION = 0x0;
export const OPCODE_TEXTE = 0x1;
export const OPCODE_BINAIRE = 0x2;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

/** ~1 Mo : très au-dessus de l'instantané d'état à 40 joueurs, très en dessous
 *  de ce qui ferait mal au serveur si un client envoyait n'importe quoi. */
const MAX_MESSAGE_DEFAUT = 1_048_576;

/** Une clé `Sec-WebSocket-Key` est un tirage de 16 octets en base64. */
const CLE_VALIDE = /^[A-Za-z0-9+/]{22}==$/;

// ---------------------------------------------------------------- fonctions pures

/**
 * Clé `Sec-WebSocket-Accept` (RFC 6455 §4.2.2) : SHA-1 de la clé du client
 * concaténée au GUID magique, en base64.
 */
export function computeAccept(secWebSocketKey) {
  return createHash('sha1')
    .update(String(secWebSocketKey) + GUID)
    .digest('base64');
}

/**
 * Encode une trame SERVEUR. Les trames serveur ne sont **jamais** masquées
 * (RFC 6455 §5.1) : le bit MASK reste à 0 et il n'y a pas de clé de masquage.
 * Longueur encodée sur 7, 7+16 ou 7+64 bits selon la taille.
 *
 * @param {string|Buffer} payload
 * @param {number} [opcode] 0x1 (texte) par défaut
 * @returns {Buffer}
 */
export function encodeFrame(payload, opcode = OPCODE_TEXTE) {
  const corps = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = corps.length;

  let entete;
  if (len <= 125) {
    entete = Buffer.allocUnsafe(2);
    entete[1] = len;
  } else if (len <= 0xffff) {
    entete = Buffer.allocUnsafe(4);
    entete[1] = 126;
    entete.writeUInt16BE(len, 2);
  } else {
    entete = Buffer.allocUnsafe(10);
    entete[1] = 127;
    // 64 bits big-endian. Node ne dépassera jamais 2^32 octets ici, mais les
    // quatre octets de poids fort doivent quand même être écrits à zéro.
    entete.writeUInt32BE(0, 2);
    entete.writeUInt32BE(len, 6);
  }
  entete[0] = 0x80 | (opcode & 0x0f); // FIN = 1, pas de bit RSV

  return Buffer.concat([entete, corps], entete.length + len);
}

/** Erreur de protocole : porte le code de fermeture WebSocket à renvoyer. */
function erreurProtocole(message, wsCode) {
  const err = new Error(message);
  err.wsCode = wsCode;
  return err;
}

/**
 * Décodeur incrémental. On lui pousse des morceaux de TCP, il rend les trames
 * applicatives complètes. Il gère : une trame coupée sur plusieurs paquets,
 * plusieurs trames dans un paquet, la continuation (`FIN=0` puis opcode `0x0`),
 * et les longueurs sur 7 / 16 / 64 bits.
 */
export class FrameDecoder {
  #tampon = Buffer.alloc(0);
  #morceaux = [];
  #tailleMorceaux = 0;
  #fragmente = false;

  constructor({ maxMessageSize = MAX_MESSAGE_DEFAUT } = {}) {
    this.maxMessageSize = maxMessageSize;
  }

  /** Octets en attente d'une trame complète (utile aux tests et au diagnostic). */
  get enAttente() {
    return this.#tampon.length;
  }

  /**
   * @param {Buffer} chunk
   * @returns {Array<{type:'text'|'ping'|'pong'|'close', payload:Buffer, code?:number}>}
   *   Pour un `close`, `payload` est la raison (sans les deux octets de code) et
   *   `code` le code de fermeture s'il était présent.
   * @throws {Error & {wsCode:number}} trame binaire (1003), trame non masquée,
   *   opcode inconnu, continuation incohérente, trame de contrôle fragmentée
   *   (1002), message trop volumineux (1009).
   */
  push(chunk) {
    if (chunk && chunk.length > 0) {
      this.#tampon =
        this.#tampon.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#tampon, chunk]);
    }

    const buf = this.#tampon;
    const messages = [];
    let o = 0;

    try {
      for (;;) {
        // --- en-tête minimal ---
        if (buf.length - o < 2) break;

        const b0 = buf[o];
        const b1 = buf[o + 1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masque = (b1 & 0x80) !== 0;
        const controle = (opcode & 0x08) !== 0;
        let len = b1 & 0x7f;
        let taille = 2;

        // Aucune extension n'a été négociée : un bit RSV positionné est une
        // erreur de protocole, pas quelque chose qu'on ignore poliment.
        if ((b0 & 0x70) !== 0) {
          throw erreurProtocole('bits RSV positionnés alors qu\'aucune extension n\'est négociée', 1002);
        }
        // Un navigateur masque TOUJOURS ses trames (RFC 6455 §5.1).
        if (!masque) throw erreurProtocole('trame client non masquée', 1002);
        // Les trames de contrôle ne sont jamais fragmentées et tiennent en
        // 125 octets : on le vérifie sur le champ brut, avant toute extension.
        if (controle && !fin) throw erreurProtocole('trame de contrôle fragmentée', 1002);
        if (controle && len > 125) throw erreurProtocole('trame de contrôle de plus de 125 octets', 1002);

        // --- longueur étendue ---
        if (len === 126) {
          if (buf.length - o < 4) break;
          len = buf.readUInt16BE(o + 2);
          taille = 4;
        } else if (len === 127) {
          if (buf.length - o < 10) break;
          const haut = buf.readUInt32BE(o + 2);
          const bas = buf.readUInt32BE(o + 6);
          // Refus AVANT toute allocation : une longueur absurde ne doit jamais
          // réserver de mémoire, sinon un octet malveillant fait tomber le
          // serveur au milieu de la soirée.
          if (haut !== 0 || bas > this.maxMessageSize) {
            throw erreurProtocole(`message de ${haut * 2 ** 32 + bas} octets refusé`, 1009);
          }
          len = bas;
          taille = 10;
        }

        if (len > this.maxMessageSize) {
          throw erreurProtocole(`message de ${len} octets refusé`, 1009);
        }
        if (!controle && this.#fragmente && this.#tailleMorceaux + len > this.maxMessageSize) {
          throw erreurProtocole('message fragmenté trop volumineux', 1009);
        }

        // --- corps complet ? ---
        const total = taille + 4 + len; // + les 4 octets de masque
        if (buf.length - o < total) break; // trame coupée : on attend la suite

        const cle = buf.subarray(o + taille, o + taille + 4);
        const brut = buf.subarray(o + taille + 4, o + total);
        const charge = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) charge[i] = brut[i] ^ cle[i & 3];
        o += total;

        // --- trames de contrôle ---
        if (controle) {
          if (opcode === OPCODE_CLOSE) {
            const code = len >= 2 ? charge.readUInt16BE(0) : undefined;
            messages.push({ type: 'close', payload: charge.subarray(len >= 2 ? 2 : 0), code });
          } else if (opcode === OPCODE_PING) {
            messages.push({ type: 'ping', payload: charge });
          } else if (opcode === OPCODE_PONG) {
            messages.push({ type: 'pong', payload: charge });
          } else {
            throw erreurProtocole(`opcode de contrôle inconnu 0x${opcode.toString(16)}`, 1002);
          }
          continue;
        }

        // --- trames de données ---
        if (opcode === OPCODE_BINAIRE) {
          throw erreurProtocole('trame binaire refusée', 1003);
        }
        if (opcode === OPCODE_TEXTE) {
          if (this.#fragmente) {
            throw erreurProtocole('trame texte reçue pendant un message fragmenté', 1002);
          }
          if (fin) {
            messages.push({ type: 'text', payload: charge });
            continue;
          }
          this.#fragmente = true;
          this.#morceaux = [charge];
          this.#tailleMorceaux = len;
          continue;
        }
        if (opcode === OPCODE_CONTINUATION) {
          if (!this.#fragmente) {
            throw erreurProtocole('continuation sans trame initiale', 1002);
          }
          this.#morceaux.push(charge);
          this.#tailleMorceaux += len;
          if (fin) {
            const complet = Buffer.concat(this.#morceaux, this.#tailleMorceaux);
            this.#morceaux = [];
            this.#tailleMorceaux = 0;
            this.#fragmente = false;
            messages.push({ type: 'text', payload: complet });
          }
          continue;
        }

        throw erreurProtocole(`opcode inconnu 0x${opcode.toString(16)}`, 1002);
      }
    } finally {
      // On ne garde que ce qui n'a pas été consommé. La copie libère l'ancien
      // bloc : sans elle, une trame de 1 Mo resterait référencée par le reliquat.
      if (o >= buf.length) this.#tampon = Buffer.alloc(0);
      else if (o > 0) this.#tampon = Buffer.from(buf.subarray(o));
    }

    return messages;
  }
}

// ---------------------------------------------------------------- connexion

/** Codes interdits sur le fil (RFC 6455 §7.4.1) : on les remplace par 1000. */
function codeSortie(code) {
  const n = Number(code);
  if (!Number.isInteger(n) || n < 1000 || n > 4999) return 1000;
  if (n === 1004 || n === 1005 || n === 1006) return 1000;
  return n;
}

/**
 * Conn — l'objet remis au métier. Volontairement minuscule : `send`, `close`,
 * `on('message'|'close')`, `data` (bac à sable) et `isOpen`.
 */
class Conn {
  #socket;
  #decodeur;
  #ecouteurs = new Map();
  #livenessMs;
  #maxBufferedBytes;
  #log;
  #conns;
  #chronoLiveness = null;
  #chronoCoupure = null;
  #termine = false;

  constructor(socket, { livenessMs, maxBufferedBytes, maxMessageSize, log, conns }) {
    this.#socket = socket;
    this.#livenessMs = livenessMs;
    this.#maxBufferedBytes = maxBufferedBytes;
    this.#log = log;
    this.#conns = conns;
    this.#decodeur = new FrameDecoder({ maxMessageSize });

    /** Bac à sable libre pour le métier (playerId, code, role…). */
    this.data = {};
    this.isOpen = true;
    /** Octets remis à la socket et pas encore acquittés. */
    this.enTampon = 0;

    socket.on('data', (chunk) => this.recevoir(chunk));
    socket.on('error', (err) => {
      this.#log(`ws: erreur de socket (${err.message})`);
      this.#terminer();
    });
    socket.on('close', () => this.#terminer());
    /* ⚠️ `node:http` crée ses sockets avec `allowHalfOpen: true`. Quand le
       téléphone ferme son onglet, il envoie un FIN : la socket émet `end` et
       s'en tient là — `close` n'arrive JAMAIS tant que le serveur ne raccroche
       pas de son côté. Sans cette ligne, le joueur reste affiché « connecté »
       sur la console du maître pendant les 20 s du délai de liveness, et son
       descripteur de fichier reste ouvert pour rien. On raccroche donc nous. */
    socket.on('end', () => {
      this.#terminer();
      try {
        socket.destroy();
      } catch {
        /* déjà détruite */
      }
    });

    this.#armerLiveness();
  }

  /** Encode puis écrit un message texte. `false` si la connexion est fermée. */
  send(data) {
    if (!this.isOpen) return false;
    return this.#ecrire(encodeFrame(data, OPCODE_TEXTE));
  }

  /** Fermeture propre : trame `close`, puis FIN TCP, puis coupure de sécurité. */
  close(code = 1000, reason = '') {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.#annulerLiveness();

    try {
      // La raison tient dans 123 octets : 125 moins les 2 octets de code.
      const raison = Buffer.from(String(reason), 'utf8').subarray(0, 123);
      const charge = Buffer.allocUnsafe(2 + raison.length);
      charge.writeUInt16BE(codeSortie(code), 0);
      raison.copy(charge, 2);
      this.#socket.write(encodeFrame(charge, OPCODE_CLOSE));
      this.#socket.end();
    } catch {
      // Socket déjà morte : il n'y a plus rien à annoncer.
    }

    // Filet : si le pair ne renvoie jamais son close, on ne garde pas la socket
    // ouverte pour autant.
    this.#chronoCoupure = setTimeout(() => {
      try {
        this.#socket.destroy();
      } catch {
        /* déjà détruite */
      }
    }, 500);
    this.#chronoCoupure.unref?.();

    this.#terminer();
  }

  on(evenement, fn) {
    const liste = this.#ecouteurs.get(evenement);
    if (liste) liste.push(fn);
    else this.#ecouteurs.set(evenement, [fn]);
    return this;
  }

  /** Entrée du décodeur. Publique parce que la poignée de main doit y pousser
   *  le `head` déjà lu par node:http avant de rendre la main. */
  recevoir(chunk) {
    if (!this.isOpen) return;

    let trames;
    try {
      trames = this.#decodeur.push(chunk);
    } catch (err) {
      this.#log(`ws: trame invalide (${err.message})`);
      this.close(err.wsCode ?? 1002, err.message);
      return;
    }

    for (const trame of trames) {
      if (!this.isOpen) return;
      switch (trame.type) {
        case 'text':
          // Seul un message APPLICATIF rafraîchit la liveness : le ping/pong de
          // contrôle n'est pas exposé par le navigateur, il ne prouve rien sur
          // la santé de l'onglet.
          this.#armerLiveness();
          this.#emettre('message', trame.payload.toString('utf8'));
          break;
        case 'ping':
          this.#ecrire(encodeFrame(trame.payload, OPCODE_PONG));
          break;
        case 'pong':
          break;
        case 'close':
          this.close(trame.code ?? 1000, '');
          return;
      }
    }
  }

  #ecrire(trame) {
    if (!this.isOpen) return false;

    this.enTampon += trame.length;
    let ecoule;
    try {
      ecoule = this.#socket.write(trame, () => {
        this.enTampon -= trame.length;
      });
    } catch (err) {
      this.#log(`ws: écriture impossible (${err.message})`);
      this.#terminer();
      return false;
    }

    // Un client mort ne doit pas faire gonfler la mémoire du serveur : passé le
    // seuil, on coupe net plutôt que d'empiler.
    if (!ecoule && this.enTampon > this.#maxBufferedBytes) {
      this.#log(`ws: tampon saturé (${this.enTampon} octets), connexion coupée`);
      this.isOpen = false;
      this.#annulerLiveness();
      try {
        this.#socket.destroy();
      } catch {
        /* déjà détruite */
      }
      this.#terminer();
      return false;
    }
    return true;
  }

  #armerLiveness() {
    this.#annulerLiveness();
    if (!(this.#livenessMs > 0)) return;
    this.#chronoLiveness = setTimeout(() => {
      this.#log('ws: silence applicatif, connexion considérée morte');
      this.close(1001, 'silence');
    }, this.#livenessMs);
    this.#chronoLiveness.unref?.();
  }

  #annulerLiveness() {
    if (this.#chronoLiveness) clearTimeout(this.#chronoLiveness);
    this.#chronoLiveness = null;
  }

  #terminer() {
    if (this.#termine) return;
    this.#termine = true;
    this.isOpen = false;
    this.#annulerLiveness();
    this.#conns.delete(this);
    this.#emettre('close');
  }

  #emettre(evenement, ...args) {
    for (const fn of this.#ecouteurs.get(evenement) ?? []) {
      try {
        fn(...args);
      } catch (err) {
        // Un bug du métier ne doit pas emporter le transport avec lui.
        this.#log(`ws: écouteur ${evenement} en erreur (${err.stack ?? err.message})`);
      }
    }
  }
}

// ---------------------------------------------------------------- serveur

function refuser(socket, motif, log) {
  log(`ws: upgrade refusé (${motif})`);
  try {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  } catch {
    /* socket déjà morte */
  }
}

/**
 * Branche le serveur WebSocket sur l'événement `upgrade` d'un serveur node:http.
 * Ne gère AUCUN métier : uniquement le transport.
 *
 * @returns {{ conns: Set<Conn>, close(): void }}
 */
export function attachWebSocketServer(httpServer, options = {}) {
  const {
    path = '/ws',
    livenessMs = 20_000,
    maxBufferedBytes = 1_000_000,
    maxMessageSize = MAX_MESSAGE_DEFAUT,
    onConnection,
    log = console.log,
  } = options;

  const conns = new Set();

  function surUpgrade(req, socket, head) {
    const chemin = String(req.url ?? '/').split('?')[0];
    if (chemin !== path) return refuser(socket, `chemin ${chemin}`, log);

    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      return refuser(socket, 'en-tête Upgrade absent ou inattendu', log);
    }

    const cle = req.headers['sec-websocket-key'];
    if (typeof cle !== 'string' || !CLE_VALIDE.test(cle)) {
      return refuser(socket, 'Sec-WebSocket-Key absente ou invalide', log);
    }

    const version = String(req.headers['sec-websocket-version'] ?? '');
    if (version !== '13') return refuser(socket, `version ${version || 'absente'}`, log);

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${computeAccept(cle)}\r\n\r\n`,
    );
    // Nagle peut retenir une petite trame jusqu'à 40 ms. Sur un buzzer, c'est
    // la différence entre gagner et perdre. Non négociable.
    socket.setNoDelay(true);
    // La socket vit des heures sans forcément parler : aucun délai d'inactivité
    // hérité du serveur HTTP ne doit la couper.
    socket.setTimeout?.(0);

    const conn = new Conn(socket, { livenessMs, maxBufferedBytes, maxMessageSize, log, conns });
    conns.add(conn);

    // Le métier s'abonne AVANT qu'on lui pousse quoi que ce soit.
    try {
      onConnection?.(conn, req);
    } catch (err) {
      log(`ws: onConnection en erreur (${err.stack ?? err.message})`);
      conn.close(1011, 'erreur interne');
      return;
    }

    // node:http a pu lire les premiers octets applicatifs avec l'en-tête.
    if (head && head.length > 0) conn.recevoir(head);
  }

  httpServer.on('upgrade', surUpgrade);

  return {
    conns,
    close() {
      httpServer.removeListener('upgrade', surUpgrade);
      for (const conn of [...conns]) conn.close(1001, 'serveur arrêté');
    },
  };
}
