import assert from 'node:assert/strict';
import test from 'node:test';

import { insertBuzz, insertGame, insertPlayer, loadSessions, openDb, purgeOldGames } from '../db.mjs';
import { creerSalon } from '../game.mjs';
import { creerBanc, horloge, seeded } from './helpers.mjs';

// SQLite n'est pas la vérité chaude, c'est le filet. Ce qu'on vérifie ici :
// une soirée en cours survit à un `docker restart`, et rien ne traîne au-delà
// de 24 h.

test('la clé primaire composite interdit deux buzz du même joueur dans la même manche', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO games (code, host_token) VALUES (?, ?)').run('ACDE', 'jeton');
  insertBuzz(db, { code: 'ACDE', roundId: 1, playerId: 'p1', atMs: 100, rank: 1 });

  assert.throws(
    () => insertBuzz(db, { code: 'ACDE', roundId: 1, playerId: 'p1', atMs: 50, rank: 1 }),
    /UNIQUE|constraint/i,
    'la règle « un buzz par joueur par manche » est portée par le schéma lui-même',
  );
  // La même manche pour un autre joueur, ou la manche suivante, passent.
  insertBuzz(db, { code: 'ACDE', roundId: 1, playerId: 'p2', atMs: 120, rank: 2 });
  insertBuzz(db, { code: 'ACDE', roundId: 2, playerId: 'p1', atMs: 90, rank: 1 });
});

test('redémarrage : la session, ses joueurs et les buzz de la manche en cours sont rechargés', () => {
  const db = openDb(':memory:');
  const h = horloge();
  const banc = creerBanc({ db, h });
  const { code, hostToken } = banc.registre.creerPartie();
  const marie = banc.registre.rejoindre(code, 'Marie');
  const paul = banc.registre.rejoindre(code, 'Paul');
  banc.registre.marquerConnecte(code, marie.playerId, true);
  const { openAt } = banc.registre.mancheSuivante(code, hostToken);
  banc.registre.buzz(code, paul.playerId, openAt + 900, openAt + 950);
  banc.registre.buzz(code, marie.playerId, openAt + 120, openAt + 1400); // arrive en retard
  banc.registre.verrou(code, hostToken, true);

  // --- le process meurt, un autre repart sur la même base -----------------
  const apres = creerSalon({ db, now: h.now, rng: seeded(99), log: () => {} });
  assert.equal(apres.chargerDepuisDb(), 1, 'une session rechargée');

  const inst = apres.instantane(code);
  assert.equal(inst.locked, true, 'le verrou survit');
  assert.equal(inst.openAt, openAt, "l'ouverture de la manche survit : les temps restent comparables");
  assert.deepEqual(
    inst.buzzes.map((b) => [b.name, b.rank, b.ms]),
    [
      ['Marie', 1, 120],
      ['Paul', 2, 900],
    ],
    'la liste ordonnée est restituée telle quelle, temps de réaction compris',
  );
  assert.equal(
    inst.players.every((p) => p.connected === false),
    true,
    'personne n’est connecté au redémarrage : les sockets sont mortes avec le process',
  );
  assert.equal(apres.authentifier(code, 'host', hostToken).role, 'host', 'le token hôte reste valable');
  assert.equal(apres.authentifier(code, 'player', marie.token).role, 'player', 'le joueur retrouve sa place');
});

test('après rechargement, la manche suivante repart au bon numéro et la liste est vide', () => {
  const db = openDb(':memory:');
  const h = horloge();
  const banc = creerBanc({ db, h });
  const { code, hostToken } = banc.registre.creerPartie();
  const j = banc.registre.rejoindre(code, 'Marie');
  const m1 = banc.registre.mancheSuivante(code, hostToken);
  banc.registre.buzz(code, j.playerId, m1.openAt + 100, m1.openAt + 110);

  const apres = creerSalon({ db, now: h.now, rng: seeded(3), log: () => {} });
  apres.chargerDepuisDb();
  h.avancer(2000);
  const m2 = apres.mancheSuivante(code, hostToken);
  assert.equal(m2.roundId, 2, 'le numéro de manche continue, il ne repart pas à 1');
  assert.deepEqual(apres.instantane(code).buzzes, []);

  // Le buzz de la manche 1 est toujours en base mais n'est plus jamais affiché.
  const restants = db.prepare('SELECT round_id FROM buzzes WHERE game_code = ?').all(code).map((r) => r.round_id);
  assert.deepEqual(restants, [1]);
});

test('purge à 24 h : une session de la veille disparaît, celle d’il y a une heure reste', () => {
  const db = openDb(':memory:');
  const banc = creerBanc({ db });
  const recente = banc.registre.creerPartie();
  const vieille = banc.registre.creerPartie();
  banc.registre.rejoindre(vieille.code, 'Marie');

  // On vieillit artificiellement la seconde de 25 h.
  db.prepare("UPDATE games SET created_at = datetime('now', '-25 hours') WHERE code = ?").run(vieille.code);

  assert.deepEqual(purgeOldGames(db, 24), [vieille.code]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM players WHERE game_code = ?').get(vieille.code).n,
    0,
    'les joueurs partent avec la session',
  );

  // Et le rechargement au boot ignore ce qui a plus de 24 h.
  const frais = creerSalon({ db, log: () => {} });
  frais.chargerDepuisDb();
  assert.equal(frais.obtenir(recente.code) !== null, true);
  assert.equal(frais.obtenir(vieille.code), null);
});

test('la purge vide aussi la mémoire et ferme les sockets de la session périmée', () => {
  const db = openDb(':memory:');
  const h = horloge();
  const banc = creerBanc({ db, h });
  const { code } = banc.registre.creerPartie();
  const session = banc.registre.obtenir(code);
  let fermee = false;
  session.conns.add({ isOpen: true, close: () => (fermee = true) });

  db.prepare("UPDATE games SET created_at = datetime('now', '-25 hours') WHERE code = ?").run(code);
  h.avancer(25 * 3600_000);
  banc.registre.purger(24);

  assert.equal(banc.registre.obtenir(code), null, 'la Map en mémoire est nettoyée elle aussi');
  assert.equal(fermee, true, 'les sockets encore ouvertes sur une session périmée sont fermées');
});

test('l’ordre des joueurs survit à un redémarrage, même arrivés dans la même seconde', () => {
  // `joined_at` vaut `datetime('now')` : une seconde de résolution. Quinze
  // personnes qui scannent le QR ensemble partagent donc la même valeur, et un
  // tri sur (joined_at, id) retombait sur l'id aléatoire — la liste du maître
  // ressortait mélangée après un `docker restart` en pleine soirée.
  const db = openDb(':memory:');
  insertGame(db, { code: 'ZK4P', hostToken: 'h', locked: false, openAt: null, roundId: 0 });

  const noms = ['Marie', 'Paul', 'Jean-Christophe', 'Zoé', 'Ana'];
  // Des id volontairement anti-triés, comme le serait un tirage aléatoire.
  const ids = ['zzz9', 'mmm7', 'aaa1', 'ppp5', 'bbb3'];
  noms.forEach((name, i) => insertPlayer(db, { id: ids[i], gameCode: 'ZK4P', name, token: `t${i}`, connected: false }));

  const [session] = loadSessions(db, 24);
  assert.deepEqual(
    session.players.map((p) => p.name),
    noms,
    'les pastilles reviennent dans l’ordre d’arrivée, pas dans l’ordre des id',
  );
});
