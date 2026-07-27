import assert from 'node:assert/strict';
import test from 'node:test';

import { creerBanc, fauxConn } from './helpers.mjs';

// Protocole applicatif, testé avec de faux `conn` : aucune socket, aucun port,
// aucune attente. Ce qu'on vérifie, c'est le contrat du §4.2 au mot près, et
// surtout la frontière de sécurité du §4.5.

/** Une partie, un hôte connecté, N joueurs connectés. */
function banc(noms = ['Marie', 'Paul']) {
  const b = creerBanc();
  const { code, hostToken } = b.registre.creerPartie();

  const hote = fauxConn('hôte');
  b.protocole.onConnection(hote, {});
  hote.recevoir({ t: 'hello', role: 'host', code, token: hostToken });

  const joueurs = noms.map((nom) => {
    const j = b.registre.rejoindre(code, nom);
    const conn = fauxConn(nom);
    b.protocole.onConnection(conn, {});
    conn.recevoir({ t: 'hello', role: 'player', code, token: j.token });
    return { ...j, nom, conn };
  });
  return { ...b, code, hostToken, hote, joueurs };
}

// ------------------------------------------------------------------ hello

test('à chaque hello, le serveur renvoie un instantané COMPLET, jamais un incrément', () => {
  const b = banc(['Marie']);
  const { code, openAt } = b.registre.mancheSuivante(b.code, b.hostToken) && {
    code: b.code,
    openAt: b.registre.instantane(b.code).openAt,
  };
  b.registre.buzz(code, b.joueurs[0].playerId, openAt + 100, openAt + 110);

  // Mode avion puis retour : nouvelle socket, nouveau hello.
  const retour = fauxConn('hôte-2');
  b.protocole.onConnection(retour, {});
  retour.recevoir({ t: 'hello', role: 'host', code, token: b.hostToken });

  const etat = retour.dernier('state');
  assert.ok(etat, 'un `state` arrive sans qu’on ait rien demandé d’autre');
  assert.deepEqual(Object.keys(etat).sort(), ['buzzes', 'locked', 'openAt', 'players', 't']);
  assert.equal(etat.openAt, openAt);
  assert.equal(etat.buzzes.length, 1, 'la liste en cours est dans l’instantané');
  assert.equal(etat.players.length, 1);
  assert.equal(b.hote.isOpen, false, 'la socket zombie de l’hôte est fermée, elle ne reçoit plus rien');
});

test('un hello avec un mauvais token ou un code inconnu rend une erreur explicite', () => {
  const b = banc([]);
  const c = fauxConn();
  b.protocole.onConnection(c, {});

  c.recevoir({ t: 'hello', role: 'host', code: 'AAAA', token: b.hostToken });
  assert.deepEqual(c.dernier('error'), { t: 'error', code: 'GAME_NOT_FOUND' });

  c.recevoir({ t: 'hello', role: 'host', code: b.code, token: 'nawak' });
  assert.deepEqual(c.dernier('error'), { t: 'error', code: 'BAD_TOKEN' });

  c.recevoir({ t: 'hello', role: 'player', code: b.code, token: undefined });
  assert.deepEqual(c.dernier('error'), { t: 'error', code: 'BAD_TOKEN' });
  assert.equal(c.dernier('state'), null, 'aucun état ne fuit vers un inconnu');
});

test('le hello accepte un code en minuscules (le lien du QR peut être recopié à la main)', () => {
  const b = banc([]);
  const c = fauxConn();
  b.protocole.onConnection(c, {});
  c.recevoir({ t: 'hello', role: 'host', code: b.code.toLowerCase(), token: b.hostToken });
  assert.ok(c.dernier('state'));
});

// ------------------------------------------------------------------- sync

test('sync : `c` est réémis INTACT, avec l’heure serveur — et sans authentification', () => {
  const b = creerBanc();
  const c = fauxConn();
  b.protocole.onConnection(c, {});

  for (const echantillon of [0, 123456.7, -5, 1e12]) {
    c.recevoir({ t: 'sync', c: echantillon });
    const r = c.dernier('sync');
    assert.equal(r.c, echantillon, 'le client calcule son RTT avec CE nombre : le toucher fausse tout');
    assert.equal(r.s, b.h.now());
  }
});

// ------------------------------------------------------------------- buzz

test('un buzz est annoncé à l’hôte et au joueur concerné, jamais aux autres joueurs', () => {
  const b = banc(['Marie', 'Paul']);
  const openAt = b.registre.mancheSuivante(b.code, b.hostToken).openAt;
  b.hote.vider();
  b.joueurs.forEach((j) => j.conn.vider());
  b.h.poser(openAt + 400);

  b.joueurs[0].conn.recevoir({ t: 'buzz', at: openAt + 350 });

  const chezHote = b.hote.dernier('buzz');
  assert.deepEqual(chezHote, {
    t: 'buzz',
    playerId: b.joueurs[0].playerId,
    name: 'Marie',
    rank: 1,
    ms: 350,
  });
  assert.deepEqual(b.joueurs[0].conn.dernier('buzz'), chezHote, 'Marie voit sa propre position');
  assert.equal(b.joueurs[1].conn.dernier('buzz'), null, 'Paul ne voit jamais la liste des autres');
});

test('un buzz reclassant (arrivé tard, horodaté tôt) rediffuse un instantané complet', () => {
  const b = banc(['Wifi', 'Quatre G']);
  const openAt = b.registre.mancheSuivante(b.code, b.hostToken).openAt;
  b.hote.vider();

  b.h.poser(openAt + 150);
  b.joueurs[0].conn.recevoir({ t: 'buzz', at: openAt + 100 });
  b.hote.vider();
  b.joueurs[0].conn.vider();

  b.h.poser(openAt + 400);
  b.joueurs[1].conn.recevoir({ t: 'buzz', at: openAt + 50 });

  const etat = b.hote.dernier('state');
  assert.ok(etat, 'le reclassement force un instantané, pas un patch');
  assert.deepEqual(
    etat.buzzes.map((x) => [x.name, x.rank]),
    [
      ['Quatre G', 1],
      ['Wifi', 2],
    ],
  );
  // Le joueur déclassé apprend son nouveau rang, sans voir les autres.
  const chezWifi = b.joueurs[0].conn.dernier('state');
  assert.equal(chezWifi.buzzes.length, 1);
  assert.equal(chezWifi.buzzes[0].rank, 2);
  assert.equal(chezWifi.buzzes[0].playerId, b.joueurs[0].playerId);
});

test('un buzz alors que les buzzers sont fermés : pas de ligne, et l’UI du joueur est resynchronisée', () => {
  const b = banc(['Marie']);
  const openAt = b.registre.mancheSuivante(b.code, b.hostToken).openAt;
  b.registre.verrou(b.code, b.hostToken, true);
  b.h.poser(openAt + 500);
  b.joueurs[0].conn.vider();

  b.joueurs[0].conn.recevoir({ t: 'buzz', at: openAt + 400 });
  assert.deepEqual(b.joueurs[0].conn.dernier('lock'), { t: 'lock', locked: true });
  assert.equal(b.joueurs[0].conn.dernier('buzz'), null);
  assert.equal(b.registre.instantane(b.code).buzzes.length, 0);
});

test('un buzz avant tout hello est refusé', () => {
  const b = banc([]);
  const c = fauxConn();
  b.protocole.onConnection(c, {});
  c.recevoir({ t: 'buzz', at: 1 });
  assert.deepEqual(c.dernier('error'), { t: 'error', code: 'BAD_TOKEN' });
});

// ---------------------------------------------------- frontière de sécurité

test('SÉCURITÉ : un joueur qui envoie next / lock / kick est refusé, et rien ne bouge', () => {
  const b = banc(['Marie', 'Paul']);
  const openAt = b.registre.mancheSuivante(b.code, b.hostToken).openAt;
  b.h.poser(openAt + 200);
  b.joueurs[0].conn.recevoir({ t: 'buzz', at: openAt + 150 });
  b.registre.verrou(b.code, b.hostToken, true);

  const avant = JSON.stringify(b.registre.instantane(b.code));
  const pirate = b.joueurs[1].conn;
  pirate.vider();

  // Il essaie tout : déverrouiller, effacer la liste, virer le premier.
  pirate.recevoir({ t: 'lock', locked: false });
  pirate.recevoir({ t: 'next' });
  pirate.recevoir({ t: 'kick', playerId: b.joueurs[0].playerId });
  // Et même en se faisant passer pour l'hôte dans le message.
  pirate.recevoir({ t: 'next', token: b.hostToken, role: 'host' });

  assert.deepEqual(
    pirate.tous('error'),
    Array(4).fill({ t: 'error', code: 'BAD_TOKEN' }),
    'chaque tentative reçoit BAD_TOKEN',
  );
  assert.equal(JSON.stringify(b.registre.instantane(b.code)), avant, 'aucun état n’a bougé');
  assert.equal(b.registre.instantane(b.code).locked, true, 'les buzzers sont restés fermés');
  assert.equal(b.registre.instantane(b.code).buzzes.length, 1, 'la liste est intacte');
});

test('SÉCURITÉ : un joueur ne peut pas se réauthentifier en hôte avec son propre token', () => {
  const b = banc(['Marie']);
  const c = b.joueurs[0].conn;
  c.vider();
  c.recevoir({ t: 'hello', role: 'host', code: b.code, token: b.joueurs[0].token });
  assert.deepEqual(c.dernier('error'), { t: 'error', code: 'BAD_TOKEN' });
  c.recevoir({ t: 'next' });
  assert.deepEqual(c.dernier('error'), { t: 'error', code: 'BAD_TOKEN' });
});

// ----------------------------------------------------------- hôte : contrôles

test('MANCHE SUIVANTE diffuse `open` daté dans le futur, puis l’instantané vidé', () => {
  const b = banc(['Marie']);
  const openAt0 = b.registre.mancheSuivante(b.code, b.hostToken).openAt;
  b.h.poser(openAt0 + 500);
  b.joueurs[0].conn.recevoir({ t: 'buzz', at: openAt0 + 400 });
  b.hote.vider();
  b.joueurs[0].conn.vider();

  const t = b.h.avancer(1000);
  b.hote.recevoir({ t: 'next' });

  const ouverture = b.joueurs[0].conn.dernier('open');
  assert.deepEqual(ouverture, { t: 'open', at: t + 300 }, "l'ouverture est datée 300 ms dans le futur");
  assert.equal(b.hote.dernier('open').at, t + 300, "l'hôte reçoit la même date que les joueurs");
  assert.deepEqual(b.hote.dernier('state').buzzes, [], 'la liste est effacée');
  assert.equal(b.hote.dernier('state').locked, false);
});

test('le verrou est diffusé aux deux côtés : personne ne tape dans le vide', () => {
  const b = banc(['Marie']);
  b.hote.vider();
  b.joueurs[0].conn.vider();

  b.hote.recevoir({ t: 'lock', locked: true });
  assert.deepEqual(b.joueurs[0].conn.dernier('lock'), { t: 'lock', locked: true });
  assert.deepEqual(b.hote.dernier('lock'), { t: 'lock', locked: true });

  b.hote.recevoir({ t: 'lock', locked: false });
  assert.deepEqual(b.joueurs[0].conn.dernier('lock'), { t: 'lock', locked: false });
});

test('kick : le joueur est prévenu, sa socket est fermée, la console est à jour', () => {
  const b = banc(['Marie', 'Paul']);
  const cible = b.joueurs[0];
  b.hote.vider();
  cible.conn.vider();

  b.hote.recevoir({ t: 'kick', playerId: cible.playerId });

  assert.deepEqual(cible.conn.dernier('error'), { t: 'error', code: 'BAD_TOKEN' });
  assert.equal(cible.conn.isOpen, false, 'la socket du joueur exclu est fermée');
  const etat = b.hote.dernier('state');
  assert.equal(etat.players.length, 1);
  assert.equal(etat.players[0].name, 'Paul');
  assert.deepEqual(b.registre.authentifier(b.code, 'player', cible.token), { error: 'BAD_TOKEN' });
});

// ----------------------------------------------------------- robustesse

test('une trame malformée ou un message inconnu ne tue pas la connexion', () => {
  const b = banc(['Marie']);
  const c = b.joueurs[0].conn;
  c.vider();
  c.recevoir('{ ceci n’est pas du JSON');
  c.recevoir('null');
  c.recevoir('42');
  c.recevoir('[1,2,3]');
  c.recevoir({ sans: 'type' });
  c.recevoir({ t: 'inconnu' });
  assert.equal(c.envoyes.length, 0, 'on ignore, on ne répond pas, on ne ferme pas');
  assert.equal(c.isOpen, true);

  // Et la connexion sert toujours.
  c.recevoir({ t: 'sync', c: 7 });
  assert.equal(c.dernier('sync').c, 7);
});

test('les pastilles de présence suivent les connexions et les déconnexions', () => {
  const b = banc(['Marie', 'Paul']);
  const vue = () => b.registre.instantane(b.code).players;
  assert.equal(vue().every((p) => p.connected), true);

  b.hote.vider();
  b.joueurs[0].conn.close();
  assert.equal(vue().find((p) => p.name === 'Marie').connected, false);
  assert.deepEqual(
    b.hote.dernier('players').players.map((p) => [p.name, p.connected]),
    [
      ['Marie', false],
      ['Paul', true],
    ],
  );
});

test('15 joueurs rejoignent en rafale : 15 identités distinctes, tous listés', () => {
  const b = banc(Array.from({ length: 15 }, (_, i) => `Joueur ${i}`));
  // L'hôte les voit arriver un par un, sans avoir à recharger quoi que ce soit.
  const derniers = b.hote.dernier('players');
  assert.equal(derniers.players.length, 15);
  assert.equal(new Set(derniers.players.map((p) => p.id)).size, 15, 'aucun id en double');
  assert.equal(new Set(b.joueurs.map((j) => j.token)).size, 15, 'aucun token en double');
});

// --------------------------------------- étanchéité entre sessions (§8)

test('une socket qui bascule sur une autre session ne reçoit plus les diffusions de l’ancienne', () => {
  const b = creerBanc();
  const A = b.registre.creerPartie();
  const B = b.registre.creerPartie();
  const jA = b.registre.rejoindre(A.code, 'Marie');
  const jB = b.registre.rejoindre(B.code, 'Paul');

  const c = fauxConn('téléphone');
  b.protocole.onConnection(c, {});
  c.recevoir({ t: 'hello', role: 'player', code: A.code, token: jA.token });
  assert.equal(c.dernier('state').players.length, 1, 'rattachée à A');

  // Le même téléphone scanne le QR de la session B, sur la même socket.
  c.recevoir({ t: 'hello', role: 'player', code: B.code, token: jB.token });
  c.vider();

  // L'hôte de A ouvre une manche : cette socket ne doit RIEN en voir.
  b.protocole.appliquerMancheSuivante(A.code, A.hostToken);
  assert.deepEqual(c.envoyes, [], 'aucune fuite d’état de A vers une socket passée sur B');

  // …et elle reçoit bien celles de B.
  b.protocole.appliquerMancheSuivante(B.code, B.hostToken);
  assert.ok(c.dernier('open'), 'elle est bien abonnée à B');
  assert.equal(c.dernier('state').players[0].name, 'Paul');

  // L'ancien joueur de A ne reste pas « connecté » à vie.
  assert.equal(b.registre.instantane(A.code).players[0].connected, false);
});

test('une socket qui change de joueur dans la même session ne laisse pas de joueur fantôme', () => {
  const b = banc(['Marie', 'Paul']);
  const c = fauxConn('téléphone partagé');
  b.protocole.onConnection(c, {});
  c.recevoir({ t: 'hello', role: 'player', code: b.code, token: b.joueurs[0].token });
  c.recevoir({ t: 'hello', role: 'player', code: b.code, token: b.joueurs[1].token });

  // Marie n'est plus portée par aucune socket vivante : sa pastille doit s'éteindre.
  const vue = () => b.registre.instantane(b.code).players;
  assert.equal(vue().find((p) => p.name === 'Marie').connected, false);
  assert.equal(vue().find((p) => p.name === 'Paul').connected, true);

  c.close();
  assert.equal(vue().every((p) => !p.connected), true, 'plus personne de connecté');
});

test('la reconnexion à la même place ne fait pas clignoter la pastille', () => {
  const b = banc(['Marie']);
  const c = b.joueurs[0].conn;
  c.vider();
  b.hote.vider();
  c.recevoir({ t: 'hello', role: 'player', code: b.code, token: b.joueurs[0].token });
  assert.equal(b.registre.instantane(b.code).players[0].connected, true);
  assert.deepEqual(b.hote.tous('players'), [], 'aucune diffusion parasite de présence');
  assert.ok(c.dernier('state'), 'et l’instantané complet arrive quand même');
});
