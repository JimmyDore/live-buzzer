import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_JOUEURS } from '../game.mjs';
import { fauxConn, startApp } from './helpers.mjs';

// L'API HTTP est le strict minimum du §4.3 : créer, rejoindre, secourir.
// Aucun fichier statique — nginx en prod, Vite en dev.

test('GET /api/health répond 200 { ok: true }', async (t) => {
  const app = await startApp();
  t.after(app.close);
  assert.deepEqual(await app.call('GET', '/api/health'), { status: 200, body: { ok: true } });
});

test('créer une session prend un seul appel, sans aucune option', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const res = await app.call('POST', '/api/games');
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body).sort(), ['code', 'hostToken']);
  assert.match(res.body.code, /^[ACDEFGHJKMNPQRTUVWXY346789]{4}$/);
  assert.equal(res.body.hostToken.length, 32);

  const etat = await app.call('GET', `/api/games/${res.body.code}`);
  assert.deepEqual(etat.body, { exists: true, locked: false, playerCount: 0 });
});

test('un code inconnu ou mal formé rend { exists: false }, jamais une erreur technique', async (t) => {
  const app = await startApp();
  t.after(app.close);
  for (const code of ['AAAA', 'ZZZZ', 'xx', '%%%%']) {
    const res = await app.call('GET', `/api/games/${encodeURIComponent(code)}`);
    assert.equal(res.status, 200, `${code} → 200`);
    assert.deepEqual(res.body, { exists: false, locked: false, playerCount: 0 });
  }
});

test('rejoindre : un prénom suffit, les doublons sont désambiguïsés', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const { code } = (await app.call('POST', '/api/games')).body;

  const noms = [];
  for (const nom of ['Marie', 'Marie', 'Paul']) {
    const res = await app.call('POST', `/api/games/${code}/players`, { body: { name: nom } });
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body).sort(), ['name', 'playerId', 'token']);
    noms.push(res.body.name);
  }
  assert.deepEqual(noms, ['Marie', 'Marie (2)', 'Paul']);
  assert.equal((await app.call('GET', `/api/games/${code}`)).body.playerCount, 3);
});

test(`le ${MAX_JOUEURS + 1}ᵉ joueur reçoit un 409 lisible en français`, async (t) => {
  const app = await startApp();
  t.after(app.close);
  const { code } = (await app.call('POST', '/api/games')).body;
  for (let i = 0; i < MAX_JOUEURS; i++) {
    await app.call('POST', `/api/games/${code}/players`, { body: { name: `J${i}` } });
  }
  const res = await app.call('POST', `/api/games/${code}/players`, { body: { name: 'Le 41e' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'session complète (40 joueurs maximum)');
});

test('rejoindre une session inconnue rend 404, un prénom vide rend 400', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const { code } = (await app.call('POST', '/api/games')).body;
  assert.equal((await app.call('POST', '/api/games/AAAA/players', { body: { name: 'Marie' } })).status, 404);
  assert.equal((await app.call('POST', `/api/games/${code}/players`, { body: { name: '  ' } })).status, 400);
  assert.equal((await app.call('POST', `/api/games/${code}/players`, { body: {} })).status, 400);
});

// ------------------------------------------------- le repli du §3.4

test('le buzz de secours HTTP rend EXACTEMENT le même rang et le même temps que la WebSocket', async (t) => {
  // Deux sessions strictement identiques : dans l'une le buzz passe par la
  // WebSocket, dans l'autre par le repli HTTP. Les deux réponses doivent être
  // indiscernables — sinon on aurait deux vérités selon l'état du réseau.
  const app = await startApp();
  t.after(app.close);

  async function jouer(voieHttp) {
    const { code, hostToken } = (await app.call('POST', '/api/games')).body;
    const marie = (await app.call('POST', `/api/games/${code}/players`, { body: { name: 'Marie' } })).body;
    const paul = (await app.call('POST', `/api/games/${code}/players`, { body: { name: 'Paul' } })).body;
    const { openAt } = app.registre.mancheSuivante(code, hostToken);

    app.h.poser(openAt + 420);
    app.protocole.appliquerBuzz(code, paul.playerId, openAt + 400, app.h.now());

    app.h.poser(openAt + 610);
    if (voieHttp) {
      const res = await app.call('POST', `/api/games/${code}/buzz`, {
        body: { at: openAt + 137 },
        token: marie.token,
      });
      assert.equal(res.status, 200);
      return res.body;
    }
    const conn = fauxConn();
    app.protocole.onConnection(conn, {});
    conn.recevoir({ t: 'hello', role: 'player', code, token: marie.token });
    conn.recevoir({ t: 'buzz', at: openAt + 137 });
    const { rank, ms } = conn.dernier('buzz');
    return { rank, ms };
  }

  const parWs = await jouer(false);
  const parHttp = await jouer(true);
  assert.deepEqual(parHttp, parWs);
  assert.deepEqual(parHttp, { rank: 1, ms: 137 }, 'même bornage, même départage, même temps de réaction');
});

test('le buzz de secours est borné comme le buzz WebSocket et reste idempotent', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const { code, hostToken } = (await app.call('POST', '/api/games')).body;
  const marie = (await app.call('POST', `/api/games/${code}/players`, { body: { name: 'Marie' } })).body;
  const { openAt } = app.registre.mancheSuivante(code, hostToken);
  app.h.poser(openAt + 900);

  const triche = await app.call('POST', `/api/games/${code}/buzz`, { body: { at: 0 }, token: marie.token });
  assert.deepEqual(triche.body, { rank: 1, ms: 0 }, 'at=0 est borné à openAt : premier, mais pas négatif');

  // La WebSocket s'est rétablie et renvoie le même buzz : aucune ligne en plus.
  const rejeu = await app.call('POST', `/api/games/${code}/buzz`, { body: { at: openAt + 50 }, token: marie.token });
  assert.deepEqual(rejeu.body, { rank: 1, ms: 0 }, 'le second envoi ne change rien');
  assert.equal(app.registre.instantane(code).buzzes.length, 1);
});

test('le buzz de secours refuse un jeton invalide, une session inconnue et des buzzers fermés', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const { code, hostToken } = (await app.call('POST', '/api/games')).body;
  const marie = (await app.call('POST', `/api/games/${code}/players`, { body: { name: 'Marie' } })).body;

  assert.equal((await app.call('POST', '/api/games/AAAA/buzz', { body: { at: 1 }, token: marie.token })).status, 404);
  assert.equal((await app.call('POST', `/api/games/${code}/buzz`, { body: { at: 1 }, token: 'nawak' })).status, 403);
  assert.equal((await app.call('POST', `/api/games/${code}/buzz`, { body: { at: 1 } })).status, 403);
  // Le token hôte n'est pas un token joueur : l'hôte ne joue pas.
  assert.equal((await app.call('POST', `/api/games/${code}/buzz`, { body: { at: 1 }, token: hostToken })).status, 403);

  const { openAt } = app.registre.mancheSuivante(code, hostToken);
  app.registre.verrou(code, hostToken, true);
  app.h.poser(openAt + 500);
  const ferme = await app.call('POST', `/api/games/${code}/buzz`, { body: { at: openAt + 400 }, token: marie.token });
  assert.equal(ferme.status, 409);
  assert.equal(ferme.body.error, 'buzzers verrouillés');
});

// ------------------------------------------------------------- robustesse

test('un corps JSON invalide rend 400, un corps énorme rend 413, une route inconnue rend 404', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const { code } = (await app.call('POST', '/api/games')).body;

  const mauvais = await fetch(`${app.base}/api/games/${code}/players`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ pas du json',
  });
  assert.equal(mauvais.status, 400);

  const enorme = await fetch(`${app.base}/api/games/${code}/players`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(200_000) }),
  });
  assert.equal(enorme.status, 413, 'un 413 explicite, pas une socket coupée qui deviendrait un 502');

  assert.equal((await app.call('GET', '/api/nawak')).status, 404);
  assert.equal((await app.call('GET', '/')).status, 404, "le serveur ne sert aucun statique : c'est nginx qui le fait");
});

test('un en-tête Host malformé ne tue pas le serveur (sinon toutes les soirées tombent)', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/health`, { headers: { Host: 'ho st:/\\bad' } });
  assert.ok(res.status === 200 || res.status === 400, `statut ${res.status}, mais le process est vivant`);
  assert.deepEqual((await app.call('GET', '/api/health')).body, { ok: true });
});
