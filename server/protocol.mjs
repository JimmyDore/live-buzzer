// Protocole applicatif (§4.2 du brief) : du JSON dans des trames texte.
// Cette couche traduit les messages en appels au registre (game.mjs) et diffuse
// les changements. Elle ne connaît de la WebSocket que l'objet `Conn` d'agent A
// (`send`, `close`, `on`, `data`, `isOpen`) — donc elle se teste avec un faux
// `conn` en trois lignes, sans socket.

/**
 * @param {ReturnType<import('./game.mjs').creerSalon>} registre
 */
export function creerProtocole(registre, { log = console.log, now = Date.now } = {}) {
  // ------------------------------------------------------------- émission

  function envoyer(conn, message) {
    try {
      return conn.send(JSON.stringify(message));
    } catch (err) {
      log(`[ws] envoi impossible : ${err?.message ?? err}`);
      return false;
    }
  }

  function erreur(conn, code) {
    return envoyer(conn, { t: 'error', code });
  }

  /** Diffuse à toutes les sockets de la session, éventuellement filtrées. */
  function diffuser(s, fabrique) {
    for (const conn of s.conns) {
      if (!conn.isOpen) continue;
      const message = fabrique(conn.data ?? {});
      if (message) envoyer(conn, message);
    }
  }

  /**
   * Instantané COMPLET, filtré par rôle.
   * Le joueur ne voit JAMAIS la liste des autres — seulement sa propre place.
   * Ce filtrage est côté serveur : ce qui n'est pas envoyé ne peut pas fuir.
   */
  function etatPour(s, data) {
    const inst = registre.instantane(s.code);
    if (!inst) return null;
    if (data.role === 'host') return { t: 'state', ...inst };
    return {
      t: 'state',
      locked: inst.locked,
      openAt: inst.openAt,
      players: inst.players,
      buzzes: inst.buzzes.filter((b) => b.playerId === data.playerId),
    };
  }

  function diffuserEtat(s) {
    diffuser(s, (data) => etatPour(s, data));
  }

  function diffuserJoueurs(s) {
    const players = registre.vueJoueurs(s);
    diffuser(s, () => ({ t: 'players', players }));
  }

  // --------------------------------------- opérations partagées WS + HTTP
  // Le repli HTTP (§3.4) passe EXACTEMENT par ici : même bornage, même rang,
  // mêmes diffusions. Deux chemins de code auraient fini par diverger.

  function appliquerBuzz(code, playerId, at, recuA = now()) {
    const s = registre.obtenir(code);
    const res = registre.buzz(code, playerId, at, recuA);
    if (res.error || !s) return res;

    if (!res.deja) {
      const nom = s.players.get(playerId)?.name ?? '?';
      const annonce = { t: 'buzz', playerId, name: nom, rank: res.rank, ms: res.ms };
      // L'hôte voit tout ; le joueur qui vient de buzzer voit son propre buzz ;
      // les autres joueurs ne reçoivent rien (ils n'ont pas à voir la liste).
      diffuser(s, (data) => (data.role === 'host' || data.playerId === playerId ? annonce : null));
      // Un buzz arrivé en retard mais horodaté plus tôt (4G contre wifi) fait
      // bouger les rangs déjà annoncés : on renvoie l'instantané complet plutôt
      // qu'un patch. La reconnexion et le reclassement empruntent le même
      // chemin bête et infaillible.
      if (res.reclasses.length > 0) diffuserEtat(s);
      else diffuser(s, (data) => (data.role === 'host' ? { t: 'players', players: registre.vueJoueurs(s) } : null));
    }
    return res;
  }

  function appliquerMancheSuivante(code, hostToken) {
    const res = registre.mancheSuivante(code, hostToken);
    if (res.error) return res;
    const s = registre.obtenir(code);
    // `open` d'abord : c'est le message sensible à la latence, chaque client
    // arme son buzzer sur `at` (horloge corrigée). L'instantané suit pour
    // effacer la liste et resynchroniser les pastilles joueurs.
    diffuser(s, () => ({ t: 'open', at: res.openAt }));
    diffuserEtat(s);
    return res;
  }

  function appliquerVerrou(code, hostToken, locked) {
    const res = registre.verrou(code, hostToken, locked);
    if (res.error) return res;
    const s = registre.obtenir(code);
    diffuser(s, () => ({ t: 'lock', locked: res.locked }));
    return res;
  }

  function appliquerExclusion(code, hostToken, playerId) {
    const s = registre.obtenir(code);
    const res = registre.exclure(code, hostToken, playerId);
    if (res.error) return res;

    // Le joueur exclu : son token n'existe plus, on le lui dit et on ferme.
    for (const conn of [...s.conns]) {
      if (conn.data?.playerId === playerId) {
        erreur(conn, 'BAD_TOKEN');
        s.conns.delete(conn);
        try {
          conn.close();
        } catch {
          /* socket déjà morte */
        }
      }
    }
    diffuserEtat(s);
    return res;
  }

  // ------------------------------------------------------------- réception

  /**
   * Détache une socket de la session à laquelle elle était rattachée : elle
   * sort du carnet de diffusion, et si plus aucune socket ne porte ce joueur,
   * il repasse déconnecté. C'est exactement ce que fait la fermeture — mais il
   * faut aussi le faire quand une socket VIVANTE change d'identité (`hello`
   * vers une autre session ou un autre joueur), sans quoi elle reste abonnée à
   * l'ancienne session (fuite d'état) et l'ancien joueur reste affiché
   * « connecté » toute la soirée dans la liste du maître.
   */
  function detacher(conn) {
    const { code, playerId } = conn.data ?? {};
    const s = code ? registre.obtenir(code) : null;
    if (!s) return;
    s.conns.delete(conn);
    if (!playerId) return;
    const encore = [...s.conns].some((c) => c.data?.playerId === playerId);
    if (!encore && registre.marquerConnecte(code, playerId, false)) diffuserJoueurs(s);
  }

  function onConnection(conn, _req) {
    conn.data = { role: null, code: null, playerId: null };

    conn.on('message', (texte) => {
      // `recuA` en toute première ligne : c'est la borne haute du bornage du
      // buzz (§3.3). Tout ce qu'on ferait avant (parse JSON, lookup) s'ajouterait
      // au temps de réaction du joueur.
      const recuA = now();
      let msg;
      try {
        msg = JSON.parse(texte);
      } catch {
        return; // trame malformée : on ignore, on ne tue pas la connexion
      }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      traiter(conn, msg, recuA);
    });

    // Un refresh ouvre la nouvelle socket avant que l'ancienne ne meure : on ne
    // marque déconnecté que s'il ne reste plus aucune socket à ce joueur.
    conn.on('close', () => detacher(conn));
  }

  function traiter(conn, msg, recuA) {
    switch (msg.t) {
      case 'sync':
        // Synchro d'horloge (§3.1) : on réémet `c` INTACT et on ajoute l'heure
        // serveur. Aucune authentification : c'est aussi le heartbeat.
        return envoyer(conn, { t: 'sync', c: msg.c, s: now() });

      case 'hello':
        return bonjour(conn, msg);

      case 'buzz': {
        const { code, playerId, role } = conn.data;
        if (role !== 'player' || !code || !playerId) return erreur(conn, 'BAD_TOKEN');
        const res = appliquerBuzz(code, playerId, msg.at, recuA);
        // `LOCKED` n'est pas un code du §4.2 : plutôt que d'inventer un message,
        // on renvoie l'état du verrou. Un joueur qui buzze alors que c'est fermé
        // a une UI désynchronisée — c'est exactement ce qu'il faut corriger.
        if (res.error === 'LOCKED') {
          const s = registre.obtenir(code);
          return envoyer(conn, { t: 'lock', locked: s ? s.locked : true });
        }
        if (res.error) return erreur(conn, res.error);
        return true;
      }

      case 'next': {
        const { code, hostToken, role } = conn.data;
        if (role !== 'host') return erreur(conn, 'BAD_TOKEN');
        const res = appliquerMancheSuivante(code, hostToken);
        return res.error ? erreur(conn, res.error) : true;
      }

      case 'lock': {
        const { code, hostToken, role } = conn.data;
        if (role !== 'host') return erreur(conn, 'BAD_TOKEN');
        const res = appliquerVerrou(code, hostToken, msg.locked);
        return res.error ? erreur(conn, res.error) : true;
      }

      case 'kick': {
        const { code, hostToken, role } = conn.data;
        if (role !== 'host') return erreur(conn, 'BAD_TOKEN');
        const res = appliquerExclusion(code, hostToken, msg.playerId);
        return res.error ? erreur(conn, res.error) : true;
      }

      default:
        return; // message inconnu : ignoré
    }
  }

  /**
   * RÈGLE D'OR : à chaque `hello` — donc à chaque reconnexion — on renvoie un
   * `state` COMPLET. Jamais de reprise incrémentale, jamais de « on reprend où
   * on en était ». Le client jette tout et adopte l'instantané.
   */
  function bonjour(conn, msg) {
    const code = typeof msg.code === 'string' ? msg.code.toUpperCase() : '';
    const role = msg.role === 'host' ? 'host' : 'player';
    const auth = registre.authentifier(code, role, msg.token);
    if (auth.error) return erreur(conn, auth.error);

    const s = auth.session;
    const playerId = auth.role === 'player' ? auth.player.id : null;

    // Cette socket avait peut-être DÉJÀ une identité (autre session, autre
    // joueur). On la détache avant d'en adopter une nouvelle. Sans ça, elle
    // resterait dans le carnet de diffusion de l'ancienne session et recevrait
    // ses `open` / `state` / `lock` — la fuite d'état entre deux sessions
    // simultanées que le brief interdit explicitement (§8).
    // Cas nominal (reconnexion à la même place) : rien à faire, on ne veut
    // surtout pas faire clignoter le joueur en « déconnecté » au passage.
    if (conn.data?.code !== s.code || conn.data?.playerId !== playerId) detacher(conn);

    // Une socket zombie du même client (mode avion, changement de réseau) ne
    // doit pas continuer à recevoir des diffusions.
    for (const ancienne of [...s.conns]) {
      const memeIdentite =
        auth.role === 'host' ? ancienne.data?.role === 'host' : ancienne.data?.playerId === playerId;
      if (memeIdentite && ancienne !== conn) {
        s.conns.delete(ancienne);
        try {
          ancienne.close();
        } catch {
          /* socket déjà morte */
        }
      }
    }

    conn.data = { role: auth.role, code: s.code, playerId, hostToken: auth.role === 'host' ? s.hostToken : null };
    s.conns.add(conn);

    const change = playerId ? registre.marquerConnecte(s.code, playerId, true) : false;
    envoyer(conn, etatPour(s, conn.data));
    if (change) diffuserJoueurs(s);
    return true;
  }

  return {
    onConnection,
    appliquerBuzz,
    appliquerMancheSuivante,
    appliquerVerrou,
    appliquerExclusion,
    diffuserEtat,
    diffuserJoueurs,
    etatPour,
  };
}
