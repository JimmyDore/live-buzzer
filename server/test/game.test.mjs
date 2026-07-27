import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_JOUEURS } from '../game.mjs';
import { creerBanc } from './helpers.mjs';

// Le cœur du produit. Chaque test ici correspond à une ligne du §3 du brief
// (correction de latence) ou du §1 (règles produit fermes).

/** Crée une partie, y met des joueurs, ouvre une manche. */
function partiePrete(banc, noms = ['Marie', 'Paul']) {
  const { code, hostToken } = banc.registre.creerPartie();
  const joueurs = noms.map((n) => ({ nom: n, ...banc.registre.rejoindre(code, n) }));
  const manche = banc.registre.mancheSuivante(code, hostToken);
  return { code, hostToken, joueurs, openAt: manche.openAt };
}

// --------------------------------------------------------- bornage du buzz

test("un `at` antérieur à l'ouverture est ramené à openAt : personne ne buzze avant le départ", () => {
  const banc = creerBanc();
  const { code, joueurs, openAt } = partiePrete(banc);
  banc.h.avancer(800); // on est 500 ms après l'ouverture

  const r = banc.registre.buzz(code, joueurs[0].playerId, openAt - 5000, banc.h.now());
  assert.equal(r.ms, 0, 'un buzz « avant le départ » vaut exactement 0 ms, jamais un négatif');
  assert.equal(r.rank, 1);
});

test('un `at` postérieur à la réception est ramené à la réception', () => {
  const banc = creerBanc();
  const { code, joueurs, openAt } = partiePrete(banc);
  const recuA = banc.h.avancer(800);

  const r = banc.registre.buzz(code, joueurs[0].playerId, recuA + 60_000, recuA);
  assert.equal(r.ms, recuA - openAt, 'borné à recuA : on ne buzze pas après que le paquet soit arrivé');
});

test('un `at` absurde (0, négatif, 1e18, NaN, chaîne, absent) ne plante jamais et reste borné', () => {
  const banc = creerBanc();
  const noms = ['A', 'B', 'C', 'D', 'E', 'F'];
  const { code, joueurs, openAt } = partiePrete(banc, noms);
  const recuA = banc.h.avancer(1000);

  const cas = [
    [0, 0],
    [-1, 0],
    [-1e18, 0],
    [1e18, recuA - openAt],
    [NaN, recuA - openAt],
    ['coucou', recuA - openAt],
  ];
  cas.forEach(([at, msAttendu], i) => {
    const r = banc.registre.buzz(code, joueurs[i].playerId, at, recuA);
    assert.equal(r.error, undefined, `at=${String(at)} ne doit pas produire d'erreur`);
    assert.equal(r.ms, msAttendu, `at=${String(at)} → ms attendu ${msAttendu}`);
    assert.ok(r.ms >= 0, 'un temps de réaction négatif est impossible par construction');
  });

  // `at` totalement absent : même traitement que NaN, on retombe sur l'horloge serveur.
  const bancB = creerBanc();
  const p = partiePrete(bancB, ['Solo']);
  const recuB = bancB.h.avancer(1000);
  const r = bancB.registre.buzz(p.code, p.joueurs[0].playerId, undefined, recuB);
  assert.equal(r.ms, recuB - p.openAt);
});

test('tout buzz borné est journalisé côté serveur (§3.3 : diagnostiquer une dérive d’horloge)', () => {
  const lignes = [];
  const banc = creerBanc({ log: (l) => lignes.push(String(l)) });
  const { code, joueurs, openAt } = partiePrete(banc, ['Marie', 'Paul']);
  const recuA = banc.h.avancer(900);

  banc.registre.buzz(code, joueurs[0].playerId, openAt - 3000, recuA); // borné bas
  banc.registre.buzz(code, joueurs[1].playerId, recuA + 3000, recuA); // borné haut
  assert.equal(lignes.length, 2, 'les deux buzz bornés sont journalisés');
  assert.match(lignes[0], /buzz borné/);
  assert.match(lignes[0], new RegExp(`openAt=${openAt}`));

  // Un buzz honnête ne pollue pas le journal.
  const bancB = creerBanc({ log: () => assert.fail('un buzz non borné ne doit rien journaliser') });
  const p = partiePrete(bancB, ['Solo']);
  const recuB = bancB.h.avancer(900);
  bancB.registre.buzz(p.code, p.joueurs[0].playerId, recuB - 40, recuB);
});

test("le temps de réaction est relatif à openAt, jamais à l'arrivée du message", () => {
  const banc = creerBanc();
  const { code, joueurs, openAt } = partiePrete(banc);
  // Doigt rapide, connexion pourrie : il buzze 120 ms après l'ouverture, le
  // paquet met 900 ms à arriver.
  const r = banc.registre.buzz(code, joueurs[0].playerId, openAt + 120, openAt + 1020);
  assert.equal(r.ms, 120, "900 ms de réseau n'ont aucun effet sur le temps affiché");
});

// ------------------------------------------------------------ ordre & rangs

test("l'ordre est celui des vrais temps de réaction, pas celui des arrivées", () => {
  const banc = creerBanc();
  const { code, joueurs, openAt } = partiePrete(banc, ['Wifi', 'Quatre G']);

  // Wifi buzze à +100 et arrive vite ; 4G buzze à +50 mais arrive 250 ms après.
  const wifi = banc.registre.buzz(code, joueurs[0].playerId, openAt + 100, openAt + 150);
  assert.equal(wifi.rank, 1, "au moment où il arrive, il est effectivement seul");

  const quatreG = banc.registre.buzz(code, joueurs[1].playerId, openAt + 50, openAt + 400);
  assert.equal(quatreG.rank, 1, "le doigt le plus rapide gagne, pas la meilleure connexion");
  assert.deepEqual(quatreG.reclasses, [joueurs[0].playerId], 'le wifi est reclassé, il faut le rediffuser');

  const liste = banc.registre.instantane(code).buzzes;
  assert.deepEqual(
    liste.map((b) => [b.name, b.rank, b.ms]),
    [
      ['Quatre G', 1, 50],
      ['Wifi', 2, 100],
    ],
  );
});

test('égalité stricte : départage déterministe par ordre d’arrivée serveur', () => {
  const banc = creerBanc();
  const { code, joueurs, openAt } = partiePrete(banc, ['Un', 'Deux', 'Trois']);
  const at = openAt + 200;

  // Trois buzz au MÊME instant effectif, reçus dans l'ordre Deux, Trois, Un.
  banc.registre.buzz(code, joueurs[1].playerId, at, openAt + 205);
  banc.registre.buzz(code, joueurs[2].playerId, at, openAt + 206);
  banc.registre.buzz(code, joueurs[0].playerId, at, openAt + 207);

  const liste = banc.registre.instantane(code).buzzes;
  assert.deepEqual(
    liste.map((b) => b.name),
    ['Deux', 'Trois', 'Un'],
    'à effectif égal, le paquet arrivé le premier prend le rang le plus petit',
  );
  assert.deepEqual(
    liste.map((b) => b.ms),
    [200, 200, 200],
  );
});

test('12 joueurs buzzent dans la même seconde : 12 rangs distincts et stables', () => {
  const banc = creerBanc();
  const noms = Array.from({ length: 12 }, (_, i) => `J${i}`);
  const { code, joueurs, openAt } = partiePrete(banc, noms);

  // Réceptions dans le désordre, temps de réaction croissants avec l'indice.
  const ordreArrivee = [7, 3, 11, 0, 5, 9, 1, 8, 4, 10, 2, 6];
  ordreArrivee.forEach((i, n) => {
    banc.registre.buzz(code, joueurs[i].playerId, openAt + 100 + i * 13, openAt + 300 + n * 7);
  });

  const liste = banc.registre.instantane(code).buzzes;
  assert.equal(liste.length, 12);
  assert.deepEqual(
    liste.map((b) => b.rank),
    Array.from({ length: 12 }, (_, i) => i + 1),
    'les rangs sont 1..12, sans trou ni doublon',
  );
  assert.deepEqual(
    liste.map((b) => b.name),
    noms,
    "l'ordre restitué est celui des temps de réaction",
  );
  assert.equal(new Set(liste.map((b) => b.playerId)).size, 12, 'aucun joueur en double');
});

test('un second appui ne change rien : même rang, même temps, aucune ligne ajoutée', () => {
  const banc = creerBanc();
  const { code, joueurs, openAt } = partiePrete(banc);
  const premier = banc.registre.buzz(code, joueurs[0].playerId, openAt + 300, openAt + 320);
  banc.registre.buzz(code, joueurs[1].playerId, openAt + 400, openAt + 420);

  const second = banc.registre.buzz(code, joueurs[0].playerId, openAt + 10, openAt + 500);
  assert.equal(second.deja, true);
  assert.equal(second.rank, premier.rank);
  assert.equal(second.ms, premier.ms, 'même un `at` plus ancien ne fait pas remonter un joueur');
  assert.equal(banc.registre.instantane(code).buzzes.length, 2, 'toujours deux lignes');
});

test('le premier buzz ne verrouille personne : la liste continue de se remplir', () => {
  const banc = creerBanc();
  const { code, joueurs, openAt } = partiePrete(banc, ['A', 'B', 'C']);
  banc.registre.buzz(code, joueurs[0].playerId, openAt + 100, openAt + 110);
  const b = banc.registre.buzz(code, joueurs[1].playerId, openAt + 200, openAt + 210);
  const c = banc.registre.buzz(code, joueurs[2].playerId, openAt + 300, openAt + 310);
  assert.equal(b.rank, 2);
  assert.equal(c.rank, 3);
  assert.equal(banc.registre.instantane(code).locked, false, 'les buzzers restent ouverts');
});

// ------------------------------------------------------------- manche & verrou

test('MANCHE SUIVANTE efface la liste, rouvre les buzzers et date l’ouverture 300 ms dans le futur', () => {
  const banc = creerBanc();
  const { code, hostToken, joueurs, openAt } = partiePrete(banc);
  banc.registre.buzz(code, joueurs[0].playerId, openAt + 100, openAt + 110);
  banc.registre.verrou(code, hostToken, true);

  const t = banc.h.avancer(5000);
  const manche = banc.registre.mancheSuivante(code, hostToken);
  assert.equal(manche.openAt, t + 300, "l'ouverture est programmée, pas immédiate");
  assert.equal(manche.roundId, 2);
  const inst = banc.registre.instantane(code);
  assert.deepEqual(inst.buzzes, [], 'la liste est vide');
  assert.equal(inst.locked, false, 'MANCHE SUIVANTE déverrouille toujours');
  assert.equal(inst.players.every((p) => p.hasBuzzed === false), true);
});

test("cinq MANCHE SUIVANTE en deux secondes : aucun buzz n'atterrit dans la mauvaise manche", () => {
  const banc = creerBanc();
  const { code, hostToken, joueurs } = partiePrete(banc);
  let dernier = null;
  for (let i = 0; i < 5; i++) {
    banc.h.avancer(400);
    dernier = banc.registre.mancheSuivante(code, hostToken);
  }
  assert.equal(dernier.roundId, 6);

  // Un buzz en vol de la manche précédente arrive avant l'ouverture programmée.
  const enVol = banc.registre.buzz(code, joueurs[0].playerId, dernier.openAt - 200, dernier.openAt - 100);
  assert.equal(enVol.error, 'LOCKED', 'les buzzers ne sont pas encore armés');
  assert.equal(banc.registre.instantane(code).buzzes.length, 0);
});

test('le verrou ferme les buzzers sans effacer la liste', () => {
  const banc = creerBanc();
  const { code, hostToken, joueurs, openAt } = partiePrete(banc);
  banc.registre.buzz(code, joueurs[0].playerId, openAt + 100, openAt + 110);

  banc.registre.verrou(code, hostToken, true);
  const bloque = banc.registre.buzz(code, joueurs[1].playerId, openAt + 200, openAt + 210);
  assert.equal(bloque.error, 'LOCKED');
  const inst = banc.registre.instantane(code);
  assert.equal(inst.locked, true);
  assert.equal(inst.buzzes.length, 1, 'la liste survit au verrou');

  banc.registre.verrou(code, hostToken, false);
  const passe = banc.registre.buzz(code, joueurs[1].playerId, openAt + 200, openAt + 900);
  assert.equal(passe.rank, 2, 'après déverrouillage, la liste reprend où elle en était');
});

test('aucune manche ouverte : un buzz est refusé (les buzzers ne s’arment pas tout seuls)', () => {
  const banc = creerBanc();
  const { code, hostToken } = banc.registre.creerPartie();
  const j = banc.registre.rejoindre(code, 'Marie');
  assert.equal(banc.registre.instantane(code).openAt, null);
  assert.equal(banc.registre.buzz(code, j.playerId, banc.h.now(), banc.h.now()).error, 'LOCKED');
  assert.equal(typeof hostToken, 'string');
});

// ------------------------------------------------------------ autorisation

test('un token joueur sur next / lock / kick est refusé, et ne change AUCUN état', () => {
  const banc = creerBanc();
  const { code, hostToken, joueurs, openAt } = partiePrete(banc, ['Marie', 'Paul']);
  banc.registre.buzz(code, joueurs[0].playerId, openAt + 100, openAt + 110);
  const avant = JSON.stringify(banc.registre.instantane(code));
  const jeton = joueurs[1].token;

  assert.deepEqual(banc.registre.mancheSuivante(code, jeton), { error: 'BAD_TOKEN' });
  assert.deepEqual(banc.registre.verrou(code, jeton, true), { error: 'BAD_TOKEN' });
  assert.deepEqual(banc.registre.verrou(code, jeton, false), { error: 'BAD_TOKEN' });
  assert.deepEqual(banc.registre.exclure(code, jeton, joueurs[0].playerId), { error: 'BAD_TOKEN' });
  // Un token vide, nul ou absent ne passe pas non plus.
  assert.deepEqual(banc.registre.mancheSuivante(code, ''), { error: 'BAD_TOKEN' });
  assert.deepEqual(banc.registre.mancheSuivante(code, undefined), { error: 'BAD_TOKEN' });
  assert.deepEqual(banc.registre.mancheSuivante(code, null), { error: 'BAD_TOKEN' });

  assert.equal(JSON.stringify(banc.registre.instantane(code)), avant, "l'état est intact au bit près");
  // Et le vrai hôte, lui, passe.
  assert.equal(banc.registre.verrou(code, hostToken, true).locked, true);
});

test('un `hello` avec un mauvais token est refusé pour les deux rôles', () => {
  const banc = creerBanc();
  const { code, hostToken } = banc.registre.creerPartie();
  const j = banc.registre.rejoindre(code, 'Marie');

  assert.deepEqual(banc.registre.authentifier(code, 'host', 'nawak'), { error: 'BAD_TOKEN' });
  assert.deepEqual(banc.registre.authentifier(code, 'player', 'nawak'), { error: 'BAD_TOKEN' });
  assert.deepEqual(banc.registre.authentifier(code, 'player', hostToken), { error: 'BAD_TOKEN' });
  assert.deepEqual(banc.registre.authentifier('AAAA', 'host', hostToken), { error: 'GAME_NOT_FOUND' });
  assert.equal(banc.registre.authentifier(code, 'host', hostToken).role, 'host');
  assert.equal(banc.registre.authentifier(code, 'player', j.token).role, 'player');
});

// ------------------------------------------------------------- joueurs

test(`le ${MAX_JOUEURS + 1}ᵉ joueur reçoit GAME_FULL, jamais un plantage`, () => {
  const banc = creerBanc();
  const { code } = banc.registre.creerPartie();
  for (let i = 0; i < MAX_JOUEURS; i++) {
    const r = banc.registre.rejoindre(code, `Joueur ${i}`);
    assert.equal(r.error, undefined, `le joueur ${i} doit entrer`);
  }
  assert.deepEqual(banc.registre.rejoindre(code, 'Le retardataire'), { error: 'GAME_FULL' });
  assert.equal(banc.registre.resume(code).playerCount, MAX_JOUEURS);
});

test('les prénoms en double sont acceptés et désambiguïsés « Marie (2) »', () => {
  const banc = creerBanc();
  const { code } = banc.registre.creerPartie();
  const noms = ['Marie', 'Marie', 'marie ', ' Marie', 'Paul'].map((n) => banc.registre.rejoindre(code, n).name);
  assert.deepEqual(noms, ['Marie', 'Marie (2)', 'marie', 'Marie (3)', 'Paul']);
});

test('un prénom vide est refusé, un prénom à rallonge est tronqué', () => {
  const banc = creerBanc();
  const { code } = banc.registre.creerPartie();
  assert.deepEqual(banc.registre.rejoindre(code, '   '), { error: 'NAME_REQUIRED' });
  assert.deepEqual(banc.registre.rejoindre(code, null), { error: 'NAME_REQUIRED' });
  const long = banc.registre.rejoindre(code, 'Jean-Christophe de la Tour du Pin');
  assert.equal(long.name.length, 24);
  assert.equal(long.name, 'Jean-Christophe de la To');
});

test('session inconnue : toutes les opérations rendent GAME_NOT_FOUND, rien ne lève', () => {
  const banc = creerBanc();
  assert.deepEqual(banc.registre.rejoindre('AAAA', 'Marie'), { error: 'GAME_NOT_FOUND' });
  assert.deepEqual(banc.registre.buzz('AAAA', 'x', 1, 2), { error: 'GAME_NOT_FOUND' });
  assert.deepEqual(banc.registre.mancheSuivante('AAAA', 'x'), { error: 'GAME_NOT_FOUND' });
  assert.deepEqual(banc.registre.verrou('AAAA', 'x', true), { error: 'GAME_NOT_FOUND' });
  assert.deepEqual(banc.registre.exclure('AAAA', 'x', 'y'), { error: 'GAME_NOT_FOUND' });
  assert.equal(banc.registre.instantane('AAAA'), null);
  assert.deepEqual(banc.registre.resume('AAAA'), { exists: false, locked: false, playerCount: 0 });
});

test('un joueur inconnu qui buzze est rejeté (BAD_TOKEN), sans effet de bord', () => {
  const banc = creerBanc();
  const { code, openAt } = partiePrete(banc);
  assert.deepEqual(banc.registre.buzz(code, 'fantome', openAt + 10, openAt + 20), { error: 'BAD_TOKEN' });
  assert.equal(banc.registre.instantane(code).buzzes.length, 0);
});

test('exclure un joueur le retire de la liste et renumérote les rangs', () => {
  const banc = creerBanc();
  const { code, hostToken, joueurs, openAt } = partiePrete(banc, ['A', 'B', 'C']);
  joueurs.forEach((j, i) => banc.registre.buzz(code, j.playerId, openAt + 100 * (i + 1), openAt + 500));

  const r = banc.registre.exclure(code, hostToken, joueurs[0].playerId);
  assert.equal(r.playerId, joueurs[0].playerId);
  const inst = banc.registre.instantane(code);
  assert.deepEqual(
    inst.buzzes.map((b) => [b.name, b.rank]),
    [
      ['B', 1],
      ['C', 2],
    ],
  );
  assert.equal(inst.players.length, 2);
});

test('deux sessions simultanées ne fuient pas l’une dans l’autre', () => {
  const banc = creerBanc();
  const a = partiePrete(banc, ['Marie']);
  const b = partiePrete(banc, ['Paul', 'Jacques']);
  assert.notEqual(a.code, b.code);

  banc.registre.buzz(a.code, a.joueurs[0].playerId, a.openAt + 100, a.openAt + 110);
  assert.equal(banc.registre.instantane(b.code).buzzes.length, 0);
  // Le token hôte de A ne pilote pas B.
  assert.deepEqual(banc.registre.mancheSuivante(b.code, a.hostToken), { error: 'BAD_TOKEN' });
  assert.equal(banc.registre.instantane(a.code).players.length, 1);
  assert.equal(banc.registre.instantane(b.code).players.length, 2);
});

test('un joueur qui rejoint au milieu d’une manche déjà buzzée voit l’état correct', () => {
  const banc = creerBanc();
  const { code, joueurs, openAt } = partiePrete(banc, ['Marie']);
  banc.registre.buzz(code, joueurs[0].playerId, openAt + 100, openAt + 110);

  const tardif = banc.registre.rejoindre(code, 'Paul');
  const inst = banc.registre.instantane(code);
  assert.equal(inst.locked, false);
  assert.equal(inst.openAt, openAt, "il reçoit l'openAt de la manche en cours");
  assert.equal(inst.players.length, 2);
  const r = banc.registre.buzz(code, tardif.playerId, openAt + 900, openAt + 950);
  assert.equal(r.rank, 2, 'il peut buzzer immédiatement');
});
