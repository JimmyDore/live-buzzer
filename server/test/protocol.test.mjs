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
  // On NE ferme PAS l'ancienne socket de l'hôte : voir le P0 documenté dans
  // `bonjour`. Une console encore vivante ne doit jamais être coupée par
  // l'arrivée d'une autre.
  assert.equal(b.hote.isOpen, true, 'l’ancienne console reste utilisable');
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

test('un joueur ne reçoit JAMAIS `hasBuzzed` dans son `state` — l’hôte, si', () => {
  // §2 : « Le joueur ne voit jamais la liste des autres. Seulement sa
  // position. » `hasBuzzed` par joueur, c'est cette liste dans un autre ordre :
  // un onglet réseau ouvert suffisait à lire qui avait déjà buzzé.
  const b = banc(['Marie', 'Paul']);
  const openAt = b.registre.mancheSuivante(b.code, b.hostToken).openAt;
  b.h.poser(openAt + 200);
  b.joueurs[0].conn.recevoir({ t: 'buzz', at: openAt + 150 });

  // Reconnexion de Paul : à chaque hello, un `state` COMPLET (règle d'or §4.2).
  const paul = fauxConn('paul-2');
  b.protocole.onConnection(paul, {});
  paul.recevoir({ t: 'hello', role: 'player', code: b.code, token: b.joueurs[1].token });

  const chezPaul = paul.dernier('state');
  assert.equal(chezPaul.players.length, 2, 'il voit bien la salle, juste pas ce qu’elle fait');
  for (const p of chezPaul.players) {
    assert.deepEqual(Object.keys(p).sort(), ['connected', 'id', 'name'], `champ de trop sur ${p.name}`);
    assert.equal('hasBuzzed' in p, false);
  }
  assert.deepEqual(chezPaul.buzzes, [], 'ni la liste des buzz, ni un buzz qui n’est pas le sien');

  // L'hôte, lui, en a besoin : sa console grise les pastilles de ceux qui ont
  // déjà buzzé. Ce filtrage ne doit surtout pas le lui retirer.
  const hote2 = fauxConn('hôte-2');
  b.protocole.onConnection(hote2, {});
  hote2.recevoir({ t: 'hello', role: 'host', code: b.code, token: b.hostToken });
  assert.deepEqual(
    hote2.dernier('state').players.map((p) => [p.name, p.hasBuzzed]),
    [
      ['Marie', true],
      ['Paul', false],
    ],
  );
});

test('la diffusion `players` est filtrée elle aussi : le joueur n’y lit pas qui a buzzé', () => {
  // Même fuite par une autre porte : `players` part vers TOUT LE MONDE à
  // chaque arrivée ou départ, pas seulement vers l'hôte.
  const b = banc(['Marie', 'Paul']);
  const openAt = b.registre.mancheSuivante(b.code, b.hostToken).openAt;
  b.h.poser(openAt + 200);
  b.joueurs[0].conn.recevoir({ t: 'buzz', at: openAt + 150 });
  b.hote.vider();
  b.joueurs[1].conn.vider();

  // Un retardataire rejoint : tout le monde reçoit un `players`.
  const tard = b.registre.rejoindre(b.code, 'Zoé');
  const conn = fauxConn('Zoé');
  b.protocole.onConnection(conn, {});
  conn.recevoir({ t: 'hello', role: 'player', code: b.code, token: tard.token });

  const chezPaul = b.joueurs[1].conn.dernier('players');
  assert.ok(chezPaul, 'Paul apprend bien qu’il y a du monde en plus');
  assert.equal(
    chezPaul.players.some((p) => 'hasBuzzed' in p),
    false,
  );
  assert.deepEqual(
    b.hote.dernier('players').players.map((p) => [p.name, p.hasBuzzed]),
    [
      ['Marie', true],
      ['Paul', false],
      ['Zoé', false],
    ],
  );
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
  // Les deux joueurs rendent leur socket : le téléphone partagé ci-dessous sera
  // la SEULE à les porter, donc la seule à pouvoir les laisser fantômes.
  b.joueurs.forEach((j) => j.conn.close());

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

// ------------------------------------- P0 : la console du maître ne doit
// ------------------------------------- JAMAIS être coupée en silence

test('P0 : un second hello hôte ne ferme pas la console déjà connectée', () => {
  // Reproduction du P0 de production (session DRMH) : le serveur fermait la
  // socket du maître avec le code 1000 juste après lui avoir envoyé `state`.
  // L'UI affichait encore « CONNECTÉ » — elle avait reçu l'instantané — mais
  // verrou et MANCHE SUIVANTE partaient dans une socket morte, sans erreur.
  const b = banc(['Marie']);
  const telephone = b.hote;
  assert.equal(telephone.isOpen, true);

  // Second onglet / tablette / outil de test : une autre socket dit hello.
  const tablette = fauxConn('tablette');
  b.protocole.onConnection(tablette, {});
  tablette.recevoir({ t: 'hello', role: 'host', code: b.code, token: b.hostToken });

  assert.equal(telephone.isOpen, true, 'la console du maître survit à l’arrivée d’une seconde');
  assert.ok(tablette.dernier('state'), 'et la seconde reçoit bien son instantané');

  // Les DEUX consoles commandent, et les commandes prennent effet.
  telephone.recevoir({ t: 'lock', locked: true });
  assert.equal(b.registre.instantane(b.code).locked, true, 'le verrou du téléphone a pris effet');

  telephone.recevoir({ t: 'next' });
  const apres = b.registre.instantane(b.code);
  assert.equal(apres.locked, false, 'MANCHE SUIVANTE a déverrouillé');
  assert.equal(typeof apres.openAt, 'number', 'MANCHE SUIVANTE a rouvert les buzzers');

  // Et les deux reçoivent les diffusions.
  assert.ok(tablette.dernier('open'), 'la tablette voit l’ouverture');
  assert.ok(telephone.dernier('open'), 'le téléphone aussi');
});

test('P0 : après plusieurs cycles de reconnexion, l’hôte commande toujours pour de vrai', () => {
  // On ne se contente pas de « aucune erreur n'est revenue » : on relit l'état
  // pour vérifier que la commande a bel et bien mordu.
  const b = banc(['Marie', 'Paul']);
  let console_ = b.hote;

  for (let cycle = 0; cycle < 5; cycle++) {
    // Coupure brutale (mode avion) puis reconnexion avec le même jeton.
    console_.close();
    const neuve = fauxConn(`console-${cycle}`);
    b.protocole.onConnection(neuve, {});
    neuve.recevoir({ t: 'hello', role: 'host', code: b.code, token: b.hostToken });
    assert.ok(neuve.dernier('state'), `cycle ${cycle} : instantané complet reçu`);
    assert.equal(neuve.isOpen, true, `cycle ${cycle} : la socket n’est pas refermée derrière nous`);
    console_ = neuve;

    // verrou → l'état doit VRAIMENT changer
    console_.recevoir({ t: 'lock', locked: true });
    assert.equal(b.registre.instantane(b.code).locked, true, `cycle ${cycle} : lock effectif`);

    // manche suivante → déverrouille et rouvre pour de bon
    console_.recevoir({ t: 'next' });
    const etat = b.registre.instantane(b.code);
    assert.equal(etat.locked, false, `cycle ${cycle} : next a déverrouillé`);
    assert.equal(typeof etat.openAt, 'number', `cycle ${cycle} : next a rouvert`);
    assert.equal(etat.buzzes.length, 0, `cycle ${cycle} : next a vidé la liste`);
  }

  // kick, après tous ces cycles, doit lui aussi mordre.
  const cible = b.joueurs[1];
  console_.recevoir({ t: 'kick', playerId: cible.playerId });
  const restants = b.registre.instantane(b.code).players.map((p) => p.name);
  assert.deepEqual(restants, ['Marie'], 'kick effectif après reconnexions');
});

test('P0 : deux consoles hôte simultanées ne se coupent pas mutuellement', () => {
  const b = banc(['Marie']);
  const a = b.hote;
  const c = fauxConn('console-B');
  b.protocole.onConnection(c, {});

  // Dix allers-retours de hello : aucune des deux ne doit tomber.
  for (let i = 0; i < 10; i++) {
    c.recevoir({ t: 'hello', role: 'host', code: b.code, token: b.hostToken });
    a.recevoir({ t: 'hello', role: 'host', code: b.code, token: b.hostToken });
    assert.equal(a.isOpen, true, `tour ${i} : console A vivante`);
    assert.equal(c.isOpen, true, `tour ${i} : console B vivante`);
  }
  a.recevoir({ t: 'next' });
  assert.equal(typeof b.registre.instantane(b.code).openAt, 'number', 'A commande encore');
  c.recevoir({ t: 'lock', locked: true });
  assert.equal(b.registre.instantane(b.code).locked, true, 'B commande aussi');
});

test('P0 : un joueur avec deux sockets (onglet resté ouvert) garde les deux vivantes', () => {
  const b = banc(['Marie']);
  const premiere = b.joueurs[0].conn;
  const seconde = fauxConn('Marie-onglet-2');
  b.protocole.onConnection(seconde, {});
  seconde.recevoir({ t: 'hello', role: 'player', code: b.code, token: b.joueurs[0].token });

  assert.equal(premiere.isOpen, true, 'le premier onglet n’est pas coupé');
  assert.equal(seconde.isOpen, true);
  assert.equal(b.registre.instantane(b.code).players[0].connected, true);

  // Une seule socket qui meurt ne doit pas éteindre la pastille.
  premiere.close();
  assert.equal(b.registre.instantane(b.code).players[0].connected, true, 'il reste une socket');
  seconde.close();
  assert.equal(b.registre.instantane(b.code).players[0].connected, false, 'plus aucune : éteinte');
});
