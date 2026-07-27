import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

// SQLite n'est PAS la vérité chaude — celle-ci vit dans une Map en mémoire
// (cf. game.mjs). C'est le filet : une soirée doit survivre à un
// `docker restart` ou à un redéploiement en plein quiz. On écrit à chaque
// mutation, on relit au démarrage, et on purge à 24 h.

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      code       TEXT PRIMARY KEY,
      host_token TEXT NOT NULL,
      locked     INTEGER NOT NULL DEFAULT 0,
      open_at    INTEGER,
      round_id   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS players (
      id        TEXT PRIMARY KEY,
      game_code TEXT NOT NULL,
      name      TEXT NOT NULL,
      token     TEXT NOT NULL,
      connected INTEGER NOT NULL DEFAULT 0,
      joined_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- La clé primaire composite EST la règle « un buzz par joueur par manche ».
    -- Un second appui provoque une contrainte UNIQUE, et c'est très bien.
    CREATE TABLE IF NOT EXISTS buzzes (
      game_code TEXT NOT NULL,
      round_id  INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      at_ms     INTEGER NOT NULL,
      rank      INTEGER NOT NULL,
      PRIMARY KEY (game_code, round_id, player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_players_game ON players(game_code);
    CREATE INDEX IF NOT EXISTS idx_buzzes_manche ON buzzes(game_code, round_id);
    CREATE INDEX IF NOT EXISTS idx_games_created ON games(created_at);
  `);
  return db;
}

export function newToken() {
  return randomBytes(16).toString('hex');
}

export function newId() {
  return randomBytes(9).toString('hex');
}

// ------------------------------------------------------------------ parties

export function insertGame(db, game) {
  db.prepare(
    `INSERT INTO games (code, host_token, locked, open_at, round_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(game.code, game.hostToken, game.locked ? 1 : 0, game.openAt ?? null, game.roundId ?? 0);
}

export function gameCodeExists(db, code) {
  return db.prepare('SELECT 1 FROM games WHERE code = ?').get(code) !== undefined;
}

/** Écrit l'état de manche (verrou, ouverture, numéro de manche). */
export function updateGame(db, code, { locked, openAt, roundId }) {
  db.prepare('UPDATE games SET locked = ?, open_at = ?, round_id = ? WHERE code = ?').run(
    locked ? 1 : 0,
    openAt ?? null,
    roundId,
    code,
  );
}

export function deleteGame(db, code) {
  db.prepare('DELETE FROM buzzes WHERE game_code = ?').run(code);
  db.prepare('DELETE FROM players WHERE game_code = ?').run(code);
  db.prepare('DELETE FROM games WHERE code = ?').run(code);
}

// ------------------------------------------------------------------ joueurs

export function insertPlayer(db, player) {
  db.prepare(
    `INSERT INTO players (id, game_code, name, token, connected)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(player.id, player.gameCode, player.name, player.token, player.connected ? 1 : 0);
}

export function setPlayerConnected(db, id, connected) {
  db.prepare('UPDATE players SET connected = ? WHERE id = ?').run(connected ? 1 : 0, id);
}

export function deletePlayer(db, code, id) {
  db.prepare('DELETE FROM buzzes WHERE game_code = ? AND player_id = ?').run(code, id);
  db.prepare('DELETE FROM players WHERE id = ?').run(id);
}

// -------------------------------------------------------------------- buzz

export function insertBuzz(db, { code, roundId, playerId, atMs, rank }) {
  db.prepare(
    `INSERT INTO buzzes (game_code, round_id, player_id, at_ms, rank)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(code, roundId, playerId, atMs, rank);
}

/** Les rangs se recalculent quand un buzz plus ancien arrive en retard (§3). */
export function updateBuzzRank(db, { code, roundId, playerId, rank }) {
  db.prepare('UPDATE buzzes SET rank = ? WHERE game_code = ? AND round_id = ? AND player_id = ?').run(
    rank,
    code,
    roundId,
    playerId,
  );
}

// ------------------------------------------------------ rechargement au boot

/**
 * Relit les sessions de moins de `hours` heures, avec joueurs et buzz de la
 * manche courante. C'est ce qui permet à une soirée de traverser un redémarrage.
 */
export function loadSessions(db, hours = 24) {
  const cutoff = `-${Number(hours)} hours`;
  const jeux = db
    .prepare("SELECT * FROM games WHERE created_at >= datetime('now', ?) ORDER BY created_at")
    .all(cutoff);

  return jeux.map((g) => ({
    code: g.code,
    hostToken: g.host_token,
    locked: g.locked === 1,
    openAt: g.open_at ?? null,
    roundId: g.round_id,
    createdAt: g.created_at,
    // ⚠️ Surtout PAS `ORDER BY joined_at` : `datetime('now')` a une résolution
    // d'UNE SECONDE, et quinze personnes qui scannent le QR ensemble arrivent
    // toutes dans la même seconde. Le tri retombait alors sur l'`id` aléatoire,
    // et la liste du maître ressortait dans le désordre après un redémarrage.
    // Le `rowid` implicite de SQLite, lui, EST l'ordre d'insertion.
    players: db
      .prepare('SELECT * FROM players WHERE game_code = ? ORDER BY rowid')
      .all(g.code)
      .map((p) => ({
        id: p.id,
        name: p.name,
        token: p.token,
        // Personne n'est connecté au redémarrage : les sockets sont mortes avec
        // le process. Les clients se reconnectent et repassent à `true`.
        connected: false,
        joinedAt: p.joined_at,
      })),
    // `rank` sert de départage à la relecture : il porte l'ordre d'arrivée
    // serveur d'origine, exactement le tie-break documenté dans game.mjs.
    buzzes: db
      .prepare('SELECT * FROM buzzes WHERE game_code = ? AND round_id = ? ORDER BY at_ms, rank')
      .all(g.code, g.round_id)
      .map((b) => ({ playerId: b.player_id, atMs: b.at_ms, rank: b.rank })),
  }));
}

// -------------------------------------------------------------------- purge

/** Une session dure une soirée. Au-delà de 24 h, plus personne ne la regarde. */
export function purgeOldGames(db, hours = 24) {
  const cutoff = `-${Number(hours)} hours`;
  const perimees = db
    .prepare("SELECT code FROM games WHERE created_at < datetime('now', ?)")
    .all(cutoff)
    .map((r) => r.code);
  for (const code of perimees) deleteGame(db, code);
  return perimees;
}
