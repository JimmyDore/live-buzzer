import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { buzzHttp } from './api'
import { delaiBackoff } from './backoff'
import { commander, delaiMasquageAlerte } from './commandes'
import { ECHANTILLONS_RAPIDES, Horloge, INTERVALLE_LENT_MS, INTERVALLE_RAPIDE_MS } from './horloge'
import { lireJoueur } from './storage'
import { DELAI_REPONSE_SYNC_MS, SurveillanceSync } from './surveillance'

// Le client temps réel, partagé par les deux rôles (CONTRACT §6).
//
// Trois principes, et tout le reste en découle :
//
// 1. RECONNEXION BÊTE ET INFAILLIBLE. À chaque `hello`, le serveur renvoie un
//    `state` COMPLET. On jette l'état local et on adopte l'instantané. Jamais
//    de reprise incrémentale, jamais de « on reprend où on en était ». Et un
//    `state` peut arriver À TOUT MOMENT (un buzz en retard mais horodaté plus
//    tôt rétrograde des rangs déjà annoncés) : les rangs ne sont pas
//    append-only, on les remplace.
//
// 2. LE BUZZ NE BLOQUE JAMAIS. `buzzer(at)` est synchrone, appelable depuis la
//    première ligne d'un `pointerdown`, et si la socket n'est pas OPEN elle
//    part en POST HTTP avec le MÊME `at`. Un buzz ne se perd jamais parce
//    qu'une socket se reconnectait.
//
// 3. L'ÉTAT DE CONNEXION EST TOUJOURS VISIBLE. Une déconnexion silencieuse est
//    le pire scénario possible — et une socket morte ne se signale pas
//    d'elle-même : `readyState` reste `OPEN` en mode avion. On ne l'écoute donc
//    pas, on surveille les RÉPONSES du serveur (`SurveillanceSync`, ~8 s au
//    pire au lieu des 20 s de la coupure de liveness serveur), et on réagit à
//    `offline` sur-le-champ.
//
// 4. UNE COMMANDE D'HÔTE QUI NE PART PAS SE DIT. Corollaire du point 3, et
//    ancien P0 : les trois commandes (`next`, `lock`, `kick`) jetaient le
//    booléen d'échec. Le maître tapait MANCHE SUIVANTE, rien ne partait, rien
//    ne s'affichait. Elles rendent maintenant ce booléen, lèvent
//    `commandeEchouee`, basculent `etat` en « perdu » et rouvrent la socket
//    tout de suite. Elles ne mettent RIEN en file : voir `commandes.ts`.

export type EtatConnexion = 'connexion' | 'ouvert' | 'perdu'

/** Codes d'erreur du §4.2. */
export type CodeErreur = 'GAME_NOT_FOUND' | 'GAME_FULL' | 'BAD_TOKEN' | 'NAME_TAKEN'

export interface Joueur {
  id: string
  name: string
  connected: boolean
  hasBuzzed: boolean
}

export interface Buzz {
  playerId: string
  name: string
  rank: number
  ms: number
}

export interface Realtime {
  etat: EtatConnexion
  locked: boolean
  /** Horodatage SERVEUR d'ouverture de la manche courante (`null` avant la 1re). */
  openAt: number | null
  /** `performance.now() + offset >= openAt && !locked`. */
  arme: boolean
  players: Joueur[]
  /** Toujours vide pour le rôle joueur : il ne voit jamais la liste des autres. */
  buzzes: Buzz[]
  /** Le buzz du joueur courant, s'il a buzzé. `null` côté hôte. */
  moi: Buzz | null
  offsetPret: boolean
  /**
   * Envoie le buzz. `at` DOIT être capturé à la toute première ligne du
   * gestionnaire `pointerdown` via `maintenant()` :
   *
   * ```tsx
   * onPointerDown={() => {
   *   const at = rt.maintenant()   // 1re ligne : avant tout rendu, tout state
   *   jouerBuzz()                  // retour local immédiat
   *   rt.buzzer(at)                // WS, ou repli HTTP si la socket est fermée
   * }}
   * ```
   *
   * Sans argument, l'instant est pris au moment de l'appel — acceptable mais
   * moins précis d'autant que le gestionnaire aura déjà fait autre chose.
   * @returns l'instant (horloge serveur estimée) réellement envoyé.
   */
  buzzer(at?: number): number
  /**
   * Les trois commandes de l'hôte. Elles rendent `false` quand RIEN n'est
   * parti — et dans ce cas elles lèvent `commandeEchouee`, basculent `etat` en
   * « perdu » et relancent la connexion. Elles ne rejouent jamais la commande
   * après coup : un `next` périmé ouvrirait une manche fantôme (`commandes.ts`).
   */
  mancheSuivante(): boolean
  verrouiller(locked: boolean): boolean
  exclure(playerId: string): boolean
  /**
   * Une commande de l'hôte vient d'être PERDUE (socket fermée), et elle ne sera
   * pas rejouée. À afficher franchement : c'est le seul indice que le maître
   * aura que son geste n'a pas eu lieu. Retombe à `false` tout seul une fois la
   * connexion revenue.
   */
  commandeEchouee: boolean
  /** `performance.now() + offset` — l'horloge serveur estimée. */
  maintenant(): number
  /**
   * Extension hors CONTRACT §6 : dernier code d'erreur reçu du serveur.
   * Sans lui, un joueur exclu ou un code inconnu se traduisent par une UI
   * muette. Additif : rien du contrat n'en dépend.
   */
  erreur: CodeErreur | null
  /** Extension : RTT retenu, en ms. Diagnostic dans l'UI, `null` si pas de sync. */
  rtt: number | null
}

/** Deux échecs d'affilée (~750 ms) avant d'annoncer « perdu » plutôt que
 *  « connexion » : en dessous, le point clignoterait à chaque micro-coupure. */
const ESSAIS_AVANT_PERDU = 2

interface Vue {
  etat: EtatConnexion
  locked: boolean
  openAt: number | null
  players: Joueur[]
  buzzes: Buzz[]
  moi: Buzz | null
  offsetPret: boolean
  erreur: CodeErreur | null
  rtt: number | null
}

const VUE_INITIALE: Vue = {
  etat: 'connexion',
  locked: false,
  openAt: null,
  players: [],
  buzzes: [],
  moi: null,
  offsetPret: false,
  erreur: null,
  rtt: null,
}

export function useRealtime(opts: { code: string; role: 'host' | 'player'; token: string | null }): Realtime {
  const { code, role, token } = opts

  const [vue, setVue] = useState<Vue>(VUE_INITIALE)
  // `arme` vit à part : il est piloté par un `setTimeout` sur `openAt` et non
  // par un message, et le mélanger à `vue` ferait boucler l'effet qui l'arme.
  const [arme, setArme] = useState(false)
  // Instant (`Date.now()`) du dernier échec de commande, `null` si aucun. Un
  // instant plutôt qu'un booléen : c'est lui qui permet de tenir le bandeau
  // affiché un minimum de temps même si la socket revient en 300 ms.
  const [echecCommande, setEchecCommande] = useState<number | null>(null)

  const horlogeRef = useRef<Horloge | null>(null)
  if (horlogeRef.current === null) horlogeRef.current = new Horloge()
  const horloge = horlogeRef.current

  const wsRef = useRef<WebSocket | null>(null)
  const codeRef = useRef(code)
  const roleRef = useRef(role)
  const tokenRef = useRef(token)
  const monIdRef = useRef<string | null>(null)
  // Rouvrir la socket depuis l'extérieur de l'effet (une commande qui échoue).
  // La logique de reconnexion vit dans l'effet et n'en sortira pas : on n'en
  // expose qu'une poignée, remise à `null` au démontage.
  const reprendreRef = useRef<(() => void) | null>(null)
  codeRef.current = code
  roleRef.current = role
  tokenRef.current = token

  // ------------------------------------------------------------- connexion

  useEffect(() => {
    // Une alerte de commande perdue parle de la socket PRÉCÉDENTE : elle ne
    // survit pas à un changement de session ni à un remontage.
    setEchecCommande(null)

    // Pas de jeton (le joueur n'a pas encore saisi son prénom) : rien à ouvrir.
    if (!code || !token) {
      setVue(VUE_INITIALE)
      setArme(false)
      return
    }

    // Nouvelle session : l'offset précédent parlait d'un autre serveur.
    horloge.reinitialiser()
    monIdRef.current = lireJoueur(code)?.playerId ?? null

    let vivant = true
    let essai = 0
    let syncFaits = 0
    let timerReconnexion: ReturnType<typeof setTimeout> | null = null
    let timerSync: ReturnType<typeof setTimeout> | null = null
    let timerVeille: ReturnType<typeof setTimeout> | null = null
    const surveillance = new SurveillanceSync()

    const majVue = (f: (v: Vue) => Vue) => {
      if (vivant) setVue(f)
    }

    // ------------------------------------------------------ synchro d'horloge

    /** @returns `true` si le `sync` est réellement parti sur la socket. */
    const envoyerSync = (): boolean => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return false
      try {
        // `c` = `performance.now()` brut ; le serveur le réémet intact.
        ws.send(JSON.stringify({ t: 'sync', c: performance.now() }))
      } catch {
        /* socket morte : le onclose va enchaîner */
        return false
      }
      // Le serveur répond TOUJOURS à un `sync` : on arme la surveillance.
      surveillance.surSyncEnvoye(performance.now())
      armerVeille()
      return true
    }

    const boucleSync = () => {
      envoyerSync()
      syncFaits += 1
      // 5 échantillons rapides à 100 ms, puis 1 toutes les 5 s. La cadence
      // lente sert AUSSI de heartbeat : le serveur coupe une socket muette
      // depuis 20 s.
      const delai = syncFaits < ECHANTILLONS_RAPIDES ? INTERVALLE_RAPIDE_MS : INTERVALLE_LENT_MS
      timerSync = setTimeout(boucleSync, delai)
    }

    // ----------------------------------------------- veille de la socket
    //
    // Une socket morte reste `OPEN` : c'est le pire scénario du §4.2. On juge
    // donc la connexion sur les réponses du serveur, pas sur `readyState`.

    const armerVeille = () => {
      if (timerVeille !== null) clearTimeout(timerVeille)
      timerVeille = setTimeout(verifierVeille, DELAI_REPONSE_SYNC_MS)
    }

    const verifierVeille = () => {
      timerVeille = null
      if (!vivant) return
      switch (surveillance.evaluer(performance.now())) {
        case 'sonder':
          // Sonde muette : on en renvoie une TOUT DE SUITE, sans attendre la
          // cadence lente. C'est ce qui ramène la détection sous les 8 s.
          envoyerSync()
          return
        case 'perdu':
          forcerReconnexion()
          return
        default:
          // Une réponse est arrivée entre-temps : la prochaine sonde réarmera.
          return
      }
    }

    /** Socket muette : on la jette et on rouvre, en le DISANT à l'écran. */
    const forcerReconnexion = () => {
      if (!vivant) return
      const ws = wsRef.current
      wsRef.current = null
      if (timerSync !== null) clearTimeout(timerSync)
      timerSync = null
      if (timerVeille !== null) clearTimeout(timerVeille)
      timerVeille = null
      surveillance.reinitialiser()
      if (ws) {
        // Handlers détachés d'abord : le `onclose` qui suit ne doit pas
        // reprogrammer une seconde reconnexion par-dessus celle-ci.
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        try {
          ws.close()
        } catch {
          /* déjà fermée */
        }
      }
      // `true` : « perdu » immédiatement, sans les deux essais de grâce. On
      // vient de prouver que la socket ne répond plus, ce n'est pas une
      // micro-coupure à masquer.
      planifierReconnexion(true)
    }

    // ---------------------------------------------------------- réception

    const surMessage = (brut: string) => {
      // Horodater la réception AVANT de parser : le JSON.parse d'un instantané
      // à 40 joueurs n'a pas à s'ajouter au RTT mesuré.
      const t1 = performance.now()
      // N'IMPORTE quel message prouve que la socket vit — même illisible, même
      // pas une réponse de `sync`. La surveillance repart de zéro.
      surveillance.surMessageRecu()
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(brut)
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return

      switch (msg.t) {
        case 'sync': {
          const e = horloge.ajouter(Number(msg.c), Number(msg.s), t1)
          if (e) majVue((v) => (v.offsetPret && v.rtt === horloge.rtt ? v : { ...v, offsetPret: true, rtt: horloge.rtt }))
          return
        }

        case 'state':
          return appliquerEtat(msg)

        case 'open': {
          // Ouverture programmée (§3.2). Nouvelle manche : la liste s'efface.
          const at = typeof msg.at === 'number' ? msg.at : null
          majVue((v) => ({ ...v, openAt: at, locked: false, buzzes: [], moi: null }))
          return
        }

        case 'lock':
          // Reçu aussi en réponse à un buzz envoyé alors que c'était verrouillé :
          // ce n'est pas une erreur, c'est une resynchro de l'UI.
          return majVue((v) => ({ ...v, locked: Boolean(msg.locked) }))

        case 'players':
          return majVue((v) => ({ ...v, players: lireJoueurs(msg.players) }))

        case 'buzz':
          return appliquerBuzz(msg)

        case 'error':
          return majVue((v) => ({ ...v, erreur: (msg.code as CodeErreur) ?? null }))

        default:
          return
      }
    }

    /** Instantané complet : on jette tout et on adopte. */
    const appliquerEtat = (msg: Record<string, unknown>) => {
      const players = lireJoueurs(msg.players)
      const recus = lireBuzzes(msg.buzzes)
      const estHote = roleRef.current === 'host'
      // Côté joueur, le serveur a déjà filtré : `buzzes` ne contient que le
      // sien. On le range dans `moi` et on laisse la liste vide — il ne doit
      // jamais pouvoir afficher celle des autres, même par erreur d'écran.
      const mien = recus.find((b) => b.playerId === monIdRef.current) ?? recus[0] ?? null
      if (!estHote && mien) monIdRef.current = mien.playerId
      majVue((v) => ({
        ...v,
        locked: Boolean(msg.locked),
        openAt: typeof msg.openAt === 'number' ? msg.openAt : null,
        players,
        buzzes: estHote ? [...recus].sort((a, b) => a.rank - b.rank) : [],
        moi: estHote ? null : mien,
        // Un instantané reçu = `hello` accepté : l'erreur précédente est levée.
        erreur: null,
      }))
    }

    /** Annonce d'un buzz. Côté hôte : upsert + retri (les rangs bougent). */
    const appliquerBuzz = (msg: Record<string, unknown>) => {
      const b = lireBuzz(msg)
      if (!b) return
      if (roleRef.current !== 'host') {
        monIdRef.current = b.playerId
        return majVue((v) => ({ ...v, moi: b }))
      }
      majVue((v) => ({
        ...v,
        buzzes: [...v.buzzes.filter((x) => x.playerId !== b.playerId), b].sort((x, y) => x.rank - y.rank),
        players: v.players.map((p) => (p.id === b.playerId ? { ...p, hasBuzzed: true } : p)),
      }))
    }

    // ---------------------------------------------------------- connexion

    const connecter = () => {
      if (!vivant) return
      const ancienne = wsRef.current
      if (ancienne && (ancienne.readyState === WebSocket.OPEN || ancienne.readyState === WebSocket.CONNECTING)) return

      majVue((v) => (v.etat === 'ouvert' ? { ...v, etat: 'connexion' } : v))

      let ws: WebSocket
      try {
        ws = new WebSocket(urlWebSocket())
      } catch {
        planifierReconnexion()
        return
      }
      wsRef.current = ws

      ws.onopen = () => {
        if (!vivant || wsRef.current !== ws) return
        essai = 0
        syncFaits = 0
        surveillance.reinitialiser()
        majVue((v) => ({ ...v, etat: 'ouvert' }))
        try {
          ws.send(JSON.stringify({ t: 'hello', role: roleRef.current, code: codeRef.current, token: tokenRef.current }))
        } catch {
          /* le onclose enchaînera */
        }
        // ⚠️ On NE réinitialise PAS l'horloge à la reconnexion :
        // `performance.now()` est le même d'une socket à l'autre, l'offset
        // reste donc valide. Le jeter ferait repartir de `offset = 0` juste
        // après un mode avion — exactement au moment où on en a besoin.
        boucleSync()
      }

      ws.onmessage = (ev) => {
        if (!vivant || wsRef.current !== ws) return
        if (typeof ev.data === 'string') surMessage(ev.data)
      }

      ws.onerror = () => {
        /* `onclose` suit toujours : rien à faire ici, sinon doubler le backoff */
      }

      ws.onclose = () => {
        if (!vivant || wsRef.current !== ws) return
        wsRef.current = null
        if (timerSync !== null) clearTimeout(timerSync)
        timerSync = null
        if (timerVeille !== null) clearTimeout(timerVeille)
        timerVeille = null
        surveillance.reinitialiser()
        planifierReconnexion()
      }
    }

    const planifierReconnexion = (perduImmediat = false) => {
      if (!vivant) return
      essai += 1
      const perdu = perduImmediat || essai >= ESSAIS_AVANT_PERDU
      majVue((v) => ({ ...v, etat: perdu ? 'perdu' : 'connexion' }))
      if (timerReconnexion !== null) clearTimeout(timerReconnexion)
      timerReconnexion = setTimeout(connecter, delaiBackoff(essai - 1))
    }

    /** Retour au premier plan / réseau retrouvé : on ne fait pas attendre le
     *  backoff, on retente tout de suite. */
    const reveiller = () => {
      if (!vivant) return
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Socket vivante en apparence : une sonde `sync` immédiate rafraîchit
        // l'offset (l'appareil a pu dormir) et réveille le liveness serveur.
        envoyerSync()
        return
      }
      if (ws && ws.readyState === WebSocket.CONNECTING) return
      if (timerReconnexion !== null) clearTimeout(timerReconnexion)
      timerReconnexion = null
      essai = 0
      connecter()
    }

    /**
     * Une commande de l'hôte n'a pas pu partir. On ne fait pas attendre le
     * backoff : le maître est en train de regarder son écran, et la prochaine
     * chose qu'il fera sera de re-taper.
     */
    const reprendre = () => {
      const ws = wsRef.current
      // `send` a jeté sur une socket qui se dit OPEN : elle ment, on la jette
      // plutôt que de lui envoyer une sonde de plus.
      if (ws && ws.readyState === WebSocket.OPEN) forcerReconnexion()
      else reveiller()
    }

    const surVisibilite = () => {
      if (document.visibilityState === 'visible') reveiller()
    }

    /** `offline` : le système SAIT déjà qu'il n'y a plus de réseau. Inutile
     *  d'attendre les 8 s de la surveillance — on l'affiche tout de suite. */
    const surHorsLigne = () => {
      forcerReconnexion()
    }

    reprendreRef.current = reprendre
    connecter()
    window.addEventListener('online', reveiller)
    window.addEventListener('offline', surHorsLigne)
    document.addEventListener('visibilitychange', surVisibilite)

    return () => {
      vivant = false
      reprendreRef.current = null
      window.removeEventListener('online', reveiller)
      window.removeEventListener('offline', surHorsLigne)
      document.removeEventListener('visibilitychange', surVisibilite)
      if (timerReconnexion !== null) clearTimeout(timerReconnexion)
      if (timerSync !== null) clearTimeout(timerSync)
      if (timerVeille !== null) clearTimeout(timerVeille)
      const ws = wsRef.current
      wsRef.current = null
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        try {
          ws.close()
        } catch {
          /* déjà fermée */
        }
      }
    }
  }, [code, role, token, horloge])

  // --------------------------------------------------- armement du buzzer

  useEffect(() => {
    if (vue.openAt === null || vue.locked) {
      setArme(false)
      return
    }
    const delta = vue.openAt - (performance.now() + horloge.offset)
    if (delta <= 0) {
      setArme(true)
      return
    }
    // §3.2 : on arme LOCALEMENT sur l'horloge corrigée, pas à l'arrivée du
    // message. C'est ce qui rend les temps de réaction comparables entre un
    // téléphone en 4G et un autre en wifi.
    setArme(false)
    const id = setTimeout(() => setArme(true), delta)
    return () => clearTimeout(id)
  }, [vue.openAt, vue.locked, vue.offsetPret, horloge])

  // ------------------------------------------------------------- commandes

  /**
   * Les trois commandes de l'hôte passent par ici, et l'échec n'y est plus
   * jamais avalé (ancien P0, §4.2) :
   *   • on le DIT — `commandeEchouee` allume un bandeau franc sur la console ;
   *   • on bascule en « perdu » — le point d'état ne peut pas continuer
   *     d'afficher « CONNECTÉ » à la seconde où un geste vient de se perdre ;
   *   • on rouvre la socket sur-le-champ, sans attendre le backoff.
   * Et on ne met RIEN en file : rejouer un `next` périmé ouvrirait une manche
   * fantôme et rouvrirait les buzzers au mauvais moment (`commandes.ts`).
   */
  const commanderHote = useCallback(
    (message: object): boolean =>
      commander(wsRef.current, message, () => {
        setEchecCommande(Date.now())
        setVue((v) => (v.etat === 'perdu' ? v : { ...v, etat: 'perdu' }))
        reprendreRef.current?.()
      }),
    [],
  )

  const maintenant = useCallback(() => performance.now() + horloge.offset, [horloge])

  const buzzer = useCallback(
    (at?: number): number => {
      // Une seule opération avant l'envoi : choisir l'instant. Rien d'autre ne
      // doit s'intercaler entre le doigt et `ws.send`.
      const instant = typeof at === 'number' && Number.isFinite(at) ? at : performance.now() + horloge.offset

      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ t: 'buzz', at: instant }))
          return instant
        } catch {
          /* on tombe dans le repli HTTP ci-dessous */
        }
      }

      // Repli HTTP (§3.4), MÊME `at` : le serveur applique le même bornage, le
      // temps de réaction est donc identique à celui d'un buzz par la socket.
      const c = codeRef.current
      const tk = tokenRef.current
      if (c && tk && roleRef.current === 'player') {
        void buzzHttp(c, tk, instant)
          .then((r) => {
            // La socket étant fermée, aucune annonce `buzz` ne viendra : c'est
            // la réponse HTTP qui donne sa place au joueur.
            setVue((v) =>
              v.moi
                ? v
                : { ...v, moi: { playerId: monIdRef.current ?? '', name: '', rank: r.rank, ms: r.ms } },
            )
          })
          .catch(() => {
            /* vraiment hors ligne : la reconnexion + `state` rattraperont */
          })
      }
      return instant
    },
    [horloge],
  )

  const mancheSuivante = useCallback((): boolean => commanderHote({ t: 'next' }), [commanderHote])

  const verrouiller = useCallback(
    (locked: boolean): boolean => commanderHote({ t: 'lock', locked }),
    [commanderHote],
  )

  const exclure = useCallback(
    (playerId: string): boolean => commanderHote({ t: 'kick', playerId }),
    [commanderHote],
  )

  // ------------------------------------- alerte « commande non transmise »
  //
  // Elle reste tant qu'on est coupé — c'est le seul message qui dit au maître
  // que son geste s'est perdu — et s'efface d'elle-même une fois la connexion
  // revenue. Jamais avant le plancher : une reconnexion en 300 ms ferait
  // clignoter le bandeau trop vite pour être vu dans une pièce sombre.
  useEffect(() => {
    const delai = delaiMasquageAlerte(echecCommande, vue.etat === 'ouvert', Date.now())
    if (delai === null) return
    if (delai === 0) {
      setEchecCommande(null)
      return
    }
    const id = setTimeout(() => setEchecCommande(null), delai)
    return () => clearTimeout(id)
  }, [echecCommande, vue.etat])

  return useMemo<Realtime>(
    () => ({
      etat: vue.etat,
      locked: vue.locked,
      openAt: vue.openAt,
      arme,
      players: vue.players,
      buzzes: vue.buzzes,
      moi: vue.moi,
      offsetPret: vue.offsetPret,
      erreur: vue.erreur,
      rtt: vue.rtt,
      commandeEchouee: echecCommande !== null,
      buzzer,
      mancheSuivante,
      verrouiller,
      exclure,
      maintenant,
    }),
    [vue, arme, echecCommande, buzzer, mancheSuivante, verrouiller, exclure, maintenant],
  )
}

// ------------------------------------------------------------------ outils

/** Même origine que la page : en dev Vite proxifie `/ws`, en prod c'est nginx. */
function urlWebSocket(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

function lireJoueurs(brut: unknown): Joueur[] {
  if (!Array.isArray(brut)) return []
  const sortie: Joueur[] = []
  for (const p of brut) {
    if (!p || typeof p !== 'object') continue
    const o = p as Record<string, unknown>
    if (typeof o.id !== 'string') continue
    sortie.push({
      id: o.id,
      name: typeof o.name === 'string' ? o.name : '?',
      connected: Boolean(o.connected),
      hasBuzzed: Boolean(o.hasBuzzed),
    })
  }
  return sortie
}

function lireBuzz(brut: unknown): Buzz | null {
  if (!brut || typeof brut !== 'object') return null
  const o = brut as Record<string, unknown>
  if (typeof o.playerId !== 'string' || typeof o.rank !== 'number') return null
  return {
    playerId: o.playerId,
    name: typeof o.name === 'string' ? o.name : '?',
    rank: o.rank,
    ms: typeof o.ms === 'number' ? o.ms : 0,
  }
}

function lireBuzzes(brut: unknown): Buzz[] {
  if (!Array.isArray(brut)) return []
  const sortie: Buzz[] = []
  for (const b of brut) {
    const lu = lireBuzz(b)
    if (lu) sortie.push(lu)
  }
  return sortie
}
