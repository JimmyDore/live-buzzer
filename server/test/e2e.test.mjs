import assert from 'node:assert/strict';
import test from 'node:test';

import { startApp } from './helpers.mjs';

// Bout en bout, à travers la VRAIE WebSocket d'agent A : poignée de main,
// trames masquées, trames longues. Les tests de logique tournent sans socket ;
// celui-ci existe pour prouver que les deux briques s'emboîtent.

const reel = { now: Date.now, avancer: () => {}, poser: () => {} };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

test('une soirée complète sur une vraie WebSocket : hello, open, buzz, ordre, manche suivante', async (t) => {
  const app = await startApp({ h: reel });
  t.after(app.close);

  const { code, hostToken } = (await app.call('POST', '/api/games')).body;

  const hote = await app.ws();
  t.after(hote.fermer);
  hote.envoyer({ t: 'hello', role: 'host', code, token: hostToken });
  const etat0 = await hote.attendre('state');
  assert.deepEqual(etat0.players, []);
  assert.equal(etat0.openAt, null, 'aucune manche ouverte tant que le maître n’a pas appuyé');

  // --- trois joueurs rejoignent -------------------------------------------
  const joueurs = [];
  for (const nom of ['Marie', 'Paul', 'Marie']) {
    const j = (await app.call('POST', `/api/games/${code}/players`, { body: { name: nom } })).body;
    const conn = await app.ws();
    t.after(conn.fermer);
    conn.envoyer({ t: 'hello', role: 'player', code, token: j.token });
    await conn.attendre('state');
    joueurs.push({ ...j, conn });
  }
  assert.deepEqual(
    joueurs.map((j) => j.name),
    ['Marie', 'Paul', 'Marie (2)'],
    'les homonymes passent, elles sont juste distinguées',
  );

  // --- synchronisation d'horloge ------------------------------------------
  const t0 = 123456.789;
  joueurs[0].conn.envoyer({ t: 'sync', c: t0 });
  const sync = await joueurs[0].conn.attendre('sync');
  assert.equal(sync.c, t0, '`c` est réémis au bit près : le RTT du client en dépend');
  assert.ok(Math.abs(sync.s - Date.now()) < 2000, "`s` est bien l'heure serveur");

  // --- MANCHE SUIVANTE ----------------------------------------------------
  hote.envoyer({ t: 'next' });
  const ouverture = await hote.attendre('open');
  const openAt = ouverture.at;
  assert.ok(openAt > Date.now(), "l'ouverture est datée DANS LE FUTUR, pas à l'instant");
  assert.ok(openAt - Date.now() <= 300);
  for (const j of joueurs) {
    const o = await j.conn.attendre('open');
    assert.equal(o.at, openAt, 'tout le monde reçoit exactement la même date d’ouverture');
  }

  // --- les buzz -----------------------------------------------------------
  // On attend l'ouverture réelle ET le plus lent des temps de réaction annoncés :
  // sinon le bornage haut (`recuA`) écraserait des `at` situés dans le futur.
  const reactions = [
    { j: joueurs[1], ms: 40 }, // Paul, le doigt le plus rapide
    { j: joueurs[2], ms: 95 },
    { j: joueurs[0], ms: 180 },
  ];
  await dormir(Math.max(0, openAt - Date.now()) + 250);
  // Envoi dans l'ordre INVERSE du vrai temps de réaction : si le serveur se
  // fiait aux arrivées, la liste sortirait à l'envers.
  for (const r of [...reactions].reverse()) r.j.conn.envoyer({ t: 'buzz', at: openAt + r.ms });

  const annonces = [];
  for (let i = 0; i < 3; i++) annonces.push(await hote.attendre('buzz'));
  assert.equal(annonces.length, 3);

  // L'instantané final fait foi : c'est ce que le maître voit à l'écran.
  const relecture = await app.ws();
  t.after(relecture.fermer);
  relecture.envoyer({ t: 'hello', role: 'host', code, token: hostToken });
  const etat = await relecture.attendre('state');
  assert.deepEqual(
    etat.buzzes.map((b) => [b.name, b.rank, b.ms]),
    [
      ['Paul', 1, 40],
      ['Marie (2)', 2, 95],
      ['Marie', 3, 180],
    ],
    "l'ordre est celui des doigts, pas celui des paquets",
  );

  // --- un joueur ne voit jamais la liste des autres ------------------------
  const chezPaul = joueurs[1].conn.messages.filter((m) => m.t === 'buzz');
  assert.equal(chezPaul.length, 1);
  assert.equal(chezPaul[0].playerId, joueurs[1].playerId);
  assert.equal(
    joueurs[1].conn.messages.some((m) => m.t === 'state' && m.buzzes.some((b) => b.playerId !== joueurs[1].playerId)),
    false,
    'aucun buzz d’un autre joueur n’a jamais transité vers Paul',
  );
});

test('SÉCURITÉ, sur une vraie socket : un joueur qui envoie `next` est refusé et rien ne bouge', async (t) => {
  const app = await startApp({ h: reel });
  t.after(app.close);
  const { code, hostToken } = (await app.call('POST', '/api/games')).body;
  const j = (await app.call('POST', `/api/games/${code}/players`, { body: { name: 'Pirate' } })).body;

  const hote = await app.ws();
  t.after(hote.fermer);
  hote.envoyer({ t: 'hello', role: 'host', code, token: hostToken });
  await hote.attendre('state');
  hote.envoyer({ t: 'lock', locked: true });
  await hote.attendre('lock');

  const pirate = await app.ws();
  t.after(pirate.fermer);
  pirate.envoyer({ t: 'hello', role: 'player', code, token: j.token });
  await pirate.attendre('state');

  pirate.envoyer({ t: 'next' });
  assert.deepEqual(await pirate.attendre('error'), { t: 'error', code: 'BAD_TOKEN', __lu: true });
  pirate.envoyer({ t: 'lock', locked: false });
  assert.deepEqual(await pirate.attendre('error'), { t: 'error', code: 'BAD_TOKEN', __lu: true });

  assert.equal(app.registre.instantane(code).locked, true, 'les buzzers sont restés fermés');
  assert.equal(app.registre.instantane(code).openAt, null, 'aucune manche n’a été ouverte');
});

test('un instantané à 40 joueurs traverse la socket intact (trame longue, > 125 octets)', async (t) => {
  const app = await startApp({ h: reel });
  t.after(app.close);
  const { code, hostToken } = (await app.call('POST', '/api/games')).body;
  for (let i = 0; i < 40; i++) {
    await app.call('POST', `/api/games/${code}/players`, { body: { name: `Jean-Christophe ${i}` } });
  }

  const hote = await app.ws();
  t.after(hote.fermer);
  hote.envoyer({ t: 'hello', role: 'host', code, token: hostToken });
  const etat = await hote.attendre('state');
  assert.equal(etat.players.length, 40);
  assert.ok(JSON.stringify(etat).length > 2000, `instantané de ${JSON.stringify(etat).length} octets`);
  assert.equal(new Set(etat.players.map((p) => p.id)).size, 40);
  assert.equal(etat.players[39].name, 'Jean-Christophe 39', 'la fin de la trame longue est intacte');
});
