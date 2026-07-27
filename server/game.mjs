import { genererCode } from './codes.mjs';
import {
  deletePlayer,
  gameCodeExists,
  insertBuzz,
  insertGame,
  insertPlayer,
  loadSessions,
  newId,
  newToken,
  purgeOldGames,
  setPlayerConnected,
  updateBuzzRank,
  updateGame,
} from './db.mjs';

// Cœur métier : sessions, joueurs, manches, bornage du buzz, autorisation.
// Aucune I/O réseau ici — pas un `conn`, pas un `res`. C'est ce qui rend le
// bornage de latence (§3 du brief) testable au millimètre, sans socket.
//
// La vérité chaude est cette Map en mémoire. SQLite (db.mjs) n'est qu'un
// journal d'écriture pour survivre à un redémarrage.

/** Limite produit. Le serveur en tiendrait 100 ; le brief en veut 40. */
export const MAX_JOUEURS = 40;

/** L'ouverture est datée dans le futur (§3.2) : 300 ms d'avance de diffusion. */
export const AVANCE_OUVERTURE_MS = 300;

/** Un prénom, pas une biographie. */
export const MAX_LONGUEUR_NOM = 24;

/**
 * Fabrique le registre de sessions.
 *
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync|null} deps.db  filet de sauvegarde
 * @param {() => number} deps.now      horloge injectable (tests déterministes)
 * @param {() => number} deps.rng      aléa injectable
 * @param {(...a:any[]) => void} deps.log
 */
export function creerSalon({
  db = null,
  now = Date.now,
  rng = Math.random,
  log = console.log,
  maxJoueurs = MAX_JOUEURS,
  avanceMs = AVANCE_OUVERTURE_MS,
} = {}) {
  /** @type {Map<string, object>} */
  const sessions = new Map();

  // ---------------------------------------------------------------------
  // DÉPARTAGE (tie-break) — déterministe et documenté.
  //
  // Les rangs sont ordonnés par `effectif` croissant (l'instant de buzz borné,
  // exprimé dans l'horloge serveur). En cas d'ÉGALITÉ STRICTE sur `effectif`,
  // on départage par ce numéro de séquence, strictement croissant, attribué à
  // la RÉCEPTION du message par le serveur : le paquet arrivé le premier prend
  // le rang le plus petit.
  //
  // Pourquoi celui-là : il est total (jamais deux fois la même valeur), stable
  // (il ne dépend d'aucun tri instable ni de l'ordre d'itération d'une Map),
  // reproductible (rejouer les mêmes réceptions dans le même ordre donne la
  // même liste), et il ne peut pas être influencé par le client. Un tri par
  // playerId ou par ordre d'inscription aurait avantagé toujours les mêmes
  // joueurs toute la soirée.
  // ---------------------------------------------------------------------
  let sequence = 0;

  // ------------------------------------------------------------ helpers

  function ecrireEtat(s) {
    if (db) updateGame(db, s.code, { locked: s.locked, openAt: s.openAt, roundId: s.roundId });
  }

  /** Trie par (effectif, séquence de réception) et renumérote les rangs.
   *  Rend la liste des playerId dont le rang a changé. */
  function renumeroter(s) {
    const avant = new Map(s.buzzes.map((b) => [b.playerId, b.rank]));
    s.buzzes.sort((a, b) => a.effectif - b.effectif || a.seq - b.seq);
    const bouges = [];
    s.buzzes.forEach((b, i) => {
      const rang = i + 1;
      if (b.rank !== rang) {
        b.rank = rang;
        bouges.push(b.playerId);
        if (db) updateBuzzRank(db, { code: s.code, roundId: s.roundId, playerId: b.playerId, rank: rang });
      }
    });
    return bouges;
  }

  function nettoyerNom(brut) {
    if (typeof brut !== 'string') return '';
    return brut.replace(/\s+/g, ' ').trim().slice(0, MAX_LONGUEUR_NOM);
  }

  /** Deux « Marie » sont acceptées : la seconde devient « Marie (2) ».
   *  On ne bloque jamais une soirée sur une homonymie. */
  function nomUnique(s, base) {
    const pris = new Set([...s.players.values()].map((p) => p.name));
    if (!pris.has(base)) return base;
    for (let n = 2; n <= maxJoueurs + 2; n++) {
      const essai = `${base} (${n})`;
      if (!pris.has(essai)) return essai;
    }
    return `${base} (${newId().slice(0, 4)})`;
  }

  function vueJoueurs(s) {
    return [...s.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      hasBuzzed: s.buzzes.some((b) => b.playerId === p.id),
    }));
  }

  function vueBuzzes(s) {
    return s.buzzes.map((b) => ({
      playerId: b.playerId,
      name: s.players.get(b.playerId)?.name ?? '?',
      rank: b.rank,
      // Le temps de réaction est TOUJOURS relatif à `openAt`, jamais à
      // l'arrivée du message. C'est toute la différence entre « le doigt le
      // plus rapide » et « la meilleure connexion ».
      // Arrondi à la milliseconde pour l'affichage : `performance.now()` est
      // fractionnaire côté client. Le classement, lui, utilise `effectif` en
      // pleine précision — deux buzz à 0,3 ms d'écart restent départagés.
      ms: Math.round(b.effectif - s.openAt),
    }));
  }

  // ------------------------------------------------------------- création

  function creerPartie() {
    let code = null;
    for (let essai = 0; essai < 200 && code === null; essai++) {
      const candidat = genererCode(rng);
      if (sessions.has(candidat)) continue;
      if (db && gameCodeExists(db, candidat)) continue;
      code = candidat;
    }
    if (code === null) throw new Error('impossible de tirer un code de session libre');

    const hostToken = newToken();
    const s = {
      code,
      hostToken,
      locked: false,
      // Pas de manche ouverte tant que le maître n'a pas appuyé sur MANCHE
      // SUIVANTE : les buzzers ne s'arment jamais tout seuls.
      openAt: null,
      roundId: 0,
      createdAt: now(),
      players: new Map(),
      buzzes: [],
      /** Sockets rattachées — remplies par protocol.mjs, jamais lues ici. */
      conns: new Set(),
    };
    sessions.set(code, s);
    if (db) insertGame(db, { code, hostToken, locked: false, openAt: null, roundId: 0 });
    return { code, hostToken };
  }

  // ------------------------------------------------------------- joueurs

  function rejoindre(code, nom) {
    const s = sessions.get(code);
    if (!s) return { error: 'GAME_NOT_FOUND' };

    const base = nettoyerNom(nom);
    if (base.length === 0) return { error: 'NAME_REQUIRED' };
    if (s.players.size >= maxJoueurs) return { error: 'GAME_FULL' };

    const player = {
      id: newId(),
      name: nomUnique(s, base),
      token: newToken(),
      connected: false,
      joinedAt: now(),
    };
    s.players.set(player.id, player);
    if (db) insertPlayer(db, { ...player, gameCode: code });
    return { playerId: player.id, token: player.token, name: player.name };
  }

  /** `hello` : rend le rôle si le token correspond, une erreur sinon. */
  function authentifier(code, role, token) {
    const s = sessions.get(code);
    if (!s) return { error: 'GAME_NOT_FOUND' };
    if (role === 'host') {
      return token && token === s.hostToken ? { role: 'host', session: s } : { error: 'BAD_TOKEN' };
    }
    const player = [...s.players.values()].find((p) => token && p.token === token);
    return player ? { role: 'player', session: s, player } : { error: 'BAD_TOKEN' };
  }

  function marquerConnecte(code, playerId, connecte) {
    const s = sessions.get(code);
    const p = s?.players.get(playerId);
    if (!p || p.connected === connecte) return false;
    p.connected = connecte;
    if (db) setPlayerConnected(db, playerId, connecte);
    return true;
  }

  function exclure(code, hostToken, playerId) {
    const s = sessions.get(code);
    if (!s) return { error: 'GAME_NOT_FOUND' };
    if (hostToken !== s.hostToken) return { error: 'BAD_TOKEN' };
    const p = s.players.get(playerId);
    if (!p) return { error: 'GAME_NOT_FOUND' };

    s.players.delete(playerId);
    s.buzzes = s.buzzes.filter((b) => b.playerId !== playerId);
    const reclasses = renumeroter(s);
    if (db) deletePlayer(db, code, playerId);
    return { playerId, reclasses };
  }

  // -------------------------------------------------------------- manches

  function mancheSuivante(code, hostToken) {
    const s = sessions.get(code);
    if (!s) return { error: 'GAME_NOT_FOUND' };
    if (hostToken !== s.hostToken) return { error: 'BAD_TOKEN' };

    s.roundId += 1;
    s.buzzes = [];
    s.locked = false;
    // Ouverture DATÉE DANS LE FUTUR (§3.2) : chaque client arme son buzzer à
    // `at` sur son horloge corrigée. Sans ça, celui qui reçoit la diffusion
    // 120 ms plus tard part avec 120 ms de retard.
    s.openAt = now() + avanceMs;
    ecrireEtat(s);
    return { openAt: s.openAt, roundId: s.roundId };
  }

  function verrou(code, hostToken, locked) {
    const s = sessions.get(code);
    if (!s) return { error: 'GAME_NOT_FOUND' };
    if (hostToken !== s.hostToken) return { error: 'BAD_TOKEN' };
    s.locked = Boolean(locked);
    ecrireEtat(s);
    return { locked: s.locked };
  }

  // ----------------------------------------------------------------- buzz

  /**
   * Enregistre un buzz. `at` est l'horodatage CLIENT (horloge corrigée), `recuA`
   * l'instant serveur de réception. Le serveur ne fait aucune confiance à `at`.
   */
  function buzz(code, playerId, at, recuA = now()) {
    const s = sessions.get(code);
    if (!s) return { error: 'GAME_NOT_FOUND' };
    const p = s.players.get(playerId);
    if (!p) return { error: 'BAD_TOKEN' };
    if (s.locked || s.openAt === null) return { error: 'LOCKED' };
    // Le paquet est arrivé avant même l'ouverture programmée : les buzzers ne
    // sont pas encore armés. Cas réel quand le maître enchaîne cinq MANCHE
    // SUIVANTE en deux secondes — un buzz en vol de la manche précédente ne
    // doit pas atterrir dans la nouvelle.
    if (recuA < s.openAt) return { error: 'LOCKED' };

    // Un joueur ne buzze qu'une fois par manche. Second appui (ou repli HTTP
    // après un envoi WS) : on rend sa position, inchangée, sans nouvelle ligne.
    const deja = s.buzzes.find((b) => b.playerId === playerId);
    if (deja) return { rank: deja.rank, ms: Math.round(deja.effectif - s.openAt), deja: true, reclasses: [] };

    // `at` absurde (NaN, chaîne, absent, Infinity) : on retombe sur l'horloge
    // serveur. Dégradation, pas panne.
    const brut = typeof at === 'number' && Number.isFinite(at) ? at : recuA;

    // --- LE bornage, littéralement celui du §3.3 du brief -----------------
    const effectif = Math.min(Math.max(brut, s.openAt), recuA);
    // ---------------------------------------------------------------------

    if (effectif !== at) {
      // Journalisation obligatoire (§3.3) : c'est le seul moyen de diagnostiquer
      // une dérive d'horloge après coup.
      log(
        `[buzz borné] partie=${s.code} manche=${s.roundId} joueur=${playerId} ` +
          `at=${JSON.stringify(at)} reçu=${recuA} openAt=${s.openAt} → effectif=${effectif} ` +
          `(écart ${typeof at === 'number' && Number.isFinite(at) ? Math.round(at - effectif) : 'n/a'} ms)`,
      );
    }

    const entree = { playerId, effectif, seq: ++sequence, rank: 0 };
    s.buzzes.push(entree);
    if (db) {
      insertBuzz(db, { code, roundId: s.roundId, playerId, atMs: effectif, rank: s.buzzes.length });
    }
    // Un buzz peut arriver EN RETARD avec un `effectif` plus ancien qu'un buzz
    // déjà classé (4G contre wifi). C'est précisément le cas que la correction
    // de latence doit rattraper : on retrie et on renumérote à chaque insertion.
    const reclasses = renumeroter(s).filter((id) => id !== playerId);

    return { rank: entree.rank, ms: Math.round(effectif - s.openAt), deja: false, reclasses };
  }

  // ----------------------------------------------------------- instantané

  /**
   * Instantané COMPLET de la session. Renvoyé à chaque `hello`, donc à chaque
   * reconnexion : le client jette tout et adopte celui-ci. Jamais d'incrémental.
   */
  function instantane(code) {
    const s = sessions.get(code);
    if (!s) return null;
    return {
      locked: s.locked,
      openAt: s.openAt,
      players: vueJoueurs(s),
      buzzes: vueBuzzes(s),
    };
  }

  function resume(code) {
    const s = sessions.get(code);
    if (!s) return { exists: false, locked: false, playerCount: 0 };
    return { exists: true, locked: s.locked, playerCount: s.players.size };
  }

  // ------------------------------------------------- persistance / purge

  /** Recharge les sessions de moins de 24 h. Une soirée survit à un restart. */
  function chargerDepuisDb(hours = 24) {
    if (!db) return 0;
    for (const brut of loadSessions(db, hours)) {
      const s = {
        code: brut.code,
        hostToken: brut.hostToken,
        locked: brut.locked,
        openAt: brut.openAt,
        roundId: brut.roundId,
        // SQLite rend `datetime('now')` en TEXT UTC ; en mémoire on ne manipule
        // que des millisecondes, sinon la purge compare une chaîne à un nombre.
        createdAt: Date.parse(String(brut.createdAt).replace(' ', 'T') + 'Z') || now(),
        players: new Map(brut.players.map((p) => [p.id, p])),
        buzzes: brut.buzzes
          // L'ordre de relecture (at_ms, rank) porte déjà le départage d'origine :
          // on réattribue des numéros de séquence croissants dans cet ordre.
          .map((b) => ({ playerId: b.playerId, effectif: b.atMs, seq: ++sequence, rank: b.rank })),
        conns: new Set(),
      };
      renumeroter(s);
      sessions.set(s.code, s);
    }
    return sessions.size;
  }

  function purger(hours = 24) {
    const perimees = db ? purgeOldGames(db, hours) : [];
    const limite = now() - hours * 3600_000;
    for (const [code, s] of sessions) {
      if (perimees.includes(code) || s.createdAt < limite) {
        for (const conn of s.conns) {
          try {
            conn.close();
          } catch {
            /* socket déjà morte : rien à fermer */
          }
        }
        sessions.delete(code);
      }
    }
    return perimees.length;
  }

  return {
    sessions,
    obtenir: (code) => sessions.get(code) ?? null,
    creerPartie,
    rejoindre,
    authentifier,
    marquerConnecte,
    exclure,
    mancheSuivante,
    verrou,
    buzz,
    instantane,
    resume,
    vueJoueurs,
    vueBuzzes,
    chargerDepuisDb,
    purger,
    maxJoueurs,
  };
}
