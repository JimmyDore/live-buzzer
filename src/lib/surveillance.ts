// Surveillance de la socket côté CLIENT (§4.2 : « une déconnexion silencieuse
// est le pire scénario possible »).
//
// Le problème qu'elle règle : une socket morte ne se signale pas. En mode avion,
// en sortie de zone, sur un wifi qui décroche, le navigateur garde une
// `WebSocket` en `readyState === OPEN` pendant des dizaines de secondes. Le
// serveur, lui, finit par couper au bout de 20 s de silence — mais c'est 20 s
// pendant lesquelles le joueur voit un buzzer armé qui n'envoie rien nulle part.
// C'est exactement le scénario où il tape dans le vide et croit à un bug.
//
// Le remède : on ne fait plus confiance à `readyState`, on fait confiance aux
// réponses. Le client envoie un `sync` toutes les 5 s et le serveur répond
// TOUJOURS. Donc : tout `sync` resté sans réponse au bout d'une seconde est une
// sonde ratée ; trois sondes ratées d'affilée, et la connexion est déclarée
// perdue puis rouverte.
//
// Pourquoi 3 × 1 s et pas 1 × 3 s : un paquet perdu isolé ne doit JAMAIS faire
// clignoter le bandeau. Avec ce réglage il faut trois silences consécutifs —
// et n'IMPORTE QUEL message du serveur (pas seulement la réponse attendue)
// remet le compteur à zéro, donc un aller-retour lent de 1,2 s sur une 4G
// médiocre ne déclenche rien : la réponse arrive et annule la sonde suivante.
//
// Budget de détection, cadence lente à 5 s :
//   au pire   5 s (prochain sync) + 3 × 1 s = 8 s
//   en moyenne             ~2,5 s + 3 × 1 s = 5,5 s
// contre ~15 s auparavant, où le client attendait la coupure de liveness du
// serveur (20 s) sans rien afficher.

/** Une réponse au-delà d'une seconde ne prouve plus rien sur la socket. */
export const DELAI_REPONSE_SYNC_MS = 1000

/** Trois sondes muettes d'affilée avant de déclarer la connexion perdue. */
export const SONDES_SANS_REPONSE_MAX = 3

/**
 * - `rien`   : rien à faire (aucune sonde en attente, ou pas encore l'heure).
 * - `sonder` : la sonde est restée muette, en renvoyer une tout de suite.
 * - `perdu`  : trop de sondes muettes — connexion morte, forcer la reconnexion.
 */
export type ActionSurveillance = 'rien' | 'sonder' | 'perdu'

export interface OptionsSurveillance {
  delaiReponseMs?: number
  sondesMax?: number
}

/**
 * Machine à états pure : aucun timer, aucune socket. `useRealtime` lui pousse
 * les événements (`surSyncEnvoye`, `surMessageRecu`) et l'interroge
 * (`evaluer`) — ce qui la rend testable sans dormir ni monter de serveur.
 */
export class SurveillanceSync {
  readonly #delai: number
  readonly #max: number
  /** Instant d'émission du `sync` en attente de réponse, `null` si aucun. */
  #envoyeA: number | null = null
  #ratees = 0

  constructor(options: OptionsSurveillance = {}) {
    this.#delai = options.delaiReponseMs ?? DELAI_REPONSE_SYNC_MS
    this.#max = options.sondesMax ?? SONDES_SANS_REPONSE_MAX
  }

  /** Une sonde attend-elle une réponse ? */
  get enAttente(): boolean {
    return this.#envoyeA !== null
  }

  /** Sondes muettes consécutives. Remis à zéro par le moindre message reçu. */
  get sondesRatees(): number {
    return this.#ratees
  }

  /** À appeler juste après un `sync` réellement écrit sur la socket. */
  surSyncEnvoye(t: number): void {
    this.#envoyeA = t
  }

  /**
   * À appeler sur TOUT message du serveur, pas seulement sur les `sync` : un
   * `state` ou un `buzz` prouve la même chose — la socket est vivante.
   */
  surMessageRecu(): void {
    this.#envoyeA = null
    this.#ratees = 0
  }

  /** Nouvelle socket : on repart d'une ardoise vierge. */
  reinitialiser(): void {
    this.#envoyeA = null
    this.#ratees = 0
  }

  /**
   * Verdict à l'instant `t`. Consomme la sonde en attente quand elle a expiré,
   * de sorte que deux appels rapprochés ne comptent jamais deux ratés pour une
   * seule sonde.
   */
  evaluer(t: number): ActionSurveillance {
    if (this.#envoyeA === null) return 'rien'
    if (t - this.#envoyeA < this.#delai) return 'rien'
    this.#envoyeA = null
    this.#ratees += 1
    return this.#ratees >= this.#max ? 'perdu' : 'sonder'
  }
}
