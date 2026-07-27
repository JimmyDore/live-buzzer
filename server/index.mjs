import { createServer } from 'node:http';
import { dirname } from 'node:path';

import { normaliserCode } from './codes.mjs';
import { openDb } from './db.mjs';
import { creerSalon } from './game.mjs';
import { creerProtocole } from './protocol.mjs';
import { attachWebSocketServer } from './ws.mjs';

// API HTTP + WebSocket, sur le même serveur `node:http`.
// La WebSocket porte le jeu ; l'HTTP ne sert qu'à créer, à rejoindre et à
// secourir. Aucun fichier statique n'est servi ici : en prod c'est nginx, en
// dev c'est Vite (§4.3).

const MAX_CORPS = 65_536;
const TROP_GROS = Symbol('corps trop volumineux');
const REPONDU = Symbol('réponse déjà envoyée');

/**
 * Construit l'application. `registre` et `protocole` sont injectables pour que
 * les tests puissent piloter l'horloge et l'aléa.
 */
export function creerApp(registre, deps = {}) {
  const log = deps.log ?? console.log;
  const protocole = deps.protocole ?? creerProtocole(registre, { log, now: deps.now ?? Date.now });
  const now = deps.now ?? Date.now;

  const server = createServer(async (req, res) => {
    // `recuA` capturé à la toute première ligne : c'est la borne haute du
    // bornage pour le buzz de secours. Le mesurer après avoir lu le corps
    // ajouterait la latence de lecture au temps de réaction du joueur.
    const recuA = now();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    try {
      // Base fixe, et surtout PAS l'en-tête `Host` : un `Host` malformé ferait
      // lever `new URL` et, hors de ce try, tuerait le process — donc toutes
      // les soirées en cours d'un coup.
      const seg = new URL(req.url ?? '/', 'http://buzz.local').pathname.split('/').filter(Boolean);
      await router(req, res, seg, { registre, protocole, recuA });
    } catch (err) {
      log(err);
      json(res, 500, { error: 'erreur serveur' });
    }
  });

  // Le transport WebSocket est une brique à part (agent A) : ici on ne fait
  // que lui donner un point d'entrée métier.
  const ws = attachWebSocketServer(server, {
    path: '/ws',
    onConnection: (conn, req) => protocole.onConnection(conn, req),
    log,
  });

  // Exposé pour l'arrêt : `server.close()` attend la fin des sockets ouvertes,
  // et une WebSocket de soirée ne se ferme jamais toute seule. On coupe le
  // transport d'abord, le serveur HTTP ensuite.
  server.wsServer = ws;
  server.on('close', () => ws.close());
  return server;
}

async function router(req, res, seg, ctx) {
  const { registre, protocole, recuA } = ctx;

  // GET /api/health
  if (req.method === 'GET' && seg.length === 2 && seg[0] === 'api' && seg[1] === 'health') {
    return json(res, 200, { ok: true });
  }

  if (seg[0] !== 'api' || seg[1] !== 'games') return json(res, 404, { error: 'route inconnue' });

  // POST /api/games
  if (req.method === 'POST' && seg.length === 2) {
    return json(res, 201, registre.creerPartie());
  }

  const code = normaliserCode(seg[2] ?? '');

  // GET /api/games/:code
  if (req.method === 'GET' && seg.length === 3) {
    // Un code hors alphabet n'est pas une erreur technique : c'est une faute de
    // frappe. Même réponse qu'un code inconnu, l'écran d'accueil sait quoi dire.
    return json(res, 200, code ? registre.resume(code) : { exists: false, locked: false, playerCount: 0 });
  }

  // POST /api/games/:code/players
  if (req.method === 'POST' && seg.length === 4 && seg[3] === 'players') {
    const corps = await corpsJson(req, res);
    if (corps === REPONDU) return;
    if (!code) return json(res, 404, { error: 'session introuvable' });

    const r = registre.rejoindre(code, corps?.name);
    if (r.error === 'GAME_NOT_FOUND') return json(res, 404, { error: 'session introuvable' });
    if (r.error === 'GAME_FULL') {
      return json(res, 409, { error: `session complète (${registre.maxJoueurs} joueurs maximum)` });
    }
    if (r.error === 'NAME_REQUIRED') return json(res, 400, { error: 'prénom requis' });
    if (r.error) return json(res, 400, { error: r.error });
    // La console du maître voit la pastille apparaître tout de suite, sans
    // attendre que le téléphone du joueur ait ouvert sa WebSocket.
    protocole.diffuserJoueurs(registre.obtenir(code));
    return json(res, 201, r);
  }

  // POST /api/games/:code/buzz — repli quand la WebSocket n'est pas OPEN (§3.4).
  if (req.method === 'POST' && seg.length === 4 && seg[3] === 'buzz') {
    const corps = await corpsJson(req, res);
    if (corps === REPONDU) return;
    if (!code) return json(res, 404, { error: 'session introuvable' });

    const auth = registre.authentifier(code, 'player', bearer(req) ?? corps?.token);
    if (auth.error === 'GAME_NOT_FOUND') return json(res, 404, { error: 'session introuvable' });
    if (auth.error) return json(res, 403, { error: 'jeton invalide' });

    const r = protocole.appliquerBuzz(code, auth.player.id, corps?.at, recuA);
    if (r.error === 'LOCKED') return json(res, 409, { error: 'buzzers verrouillés' });
    if (r.error) return json(res, 403, { error: 'jeton invalide' });
    return json(res, 200, { rank: r.rank, ms: r.ms });
  }

  return json(res, 404, { error: 'route inconnue' });
}

// ------------------------------------------------------------------ outils

function bearer(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** Lit le corps JSON et répond lui-même en cas de problème. */
async function corpsJson(req, res) {
  const body = await readJson(req);
  if (body === TROP_GROS) {
    json(res, 413, { error: 'corps trop volumineux' });
    return REPONDU;
  }
  if (body === undefined) {
    json(res, 400, { error: 'JSON invalide' });
    return REPONDU;
  }
  return body;
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    let coupe = false;
    req.on('data', (chunk) => {
      if (coupe) return;
      data += chunk;
      if (data.length > MAX_CORPS) {
        coupe = true;
        resolve(TROP_GROS);
      }
    });
    req.on('end', () => {
      if (coupe) return;
      if (data.length === 0) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(coupe ? TROP_GROS : undefined));
  });
}

// ------------------------------------------------------------- démarrage

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? './data/livebuzzer.db';

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { mkdirSync } = await import('node:fs');
  if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });

  const db = openDb(DB_PATH);
  const registre = creerSalon({ db });

  // Une soirée doit survivre à un `docker restart` : on recharge tout ce qui a
  // moins de 24 h avant même d'écouter.
  const rechargees = registre.chargerDepuisDb();
  registre.purger();
  setInterval(() => registre.purger(), 3600_000).unref();

  creerApp(registre).listen(PORT, () => {
    console.log(`live-buzzer api sur :${PORT} (db: ${DB_PATH}, ${rechargees} session(s) rechargée(s))`);
  });
}
