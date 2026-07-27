// Synchronisation d'horloge façon NTP (§3.1 du brief).
//
// C'est LA brique qui fait que « le doigt le plus rapide gagne, pas la
// meilleure connexion ». Elle est volontairement pure et sans réseau :
// `useRealtime` lui pousse des échantillons, elle rend un offset.
//
//   client  → {"t":"sync","c":<t0>}            t0 = performance.now()
//   serveur → {"t":"sync","c":<t0>,"s":<now>}  s  = Date.now() serveur
//   client  :  t1 = performance.now()
//              rtt = t1 - t0
//              offset = s + rtt/2 - t1     // à ajouter à performance.now()
//
// On garde l'échantillon de PLUS FAIBLE RTT parmi les 8 derniers, jamais la
// moyenne : un RTT bas est un RTT peu bruité (le paquet n'a fait la queue nulle
// part), tandis qu'une moyenne intègre justement le bruit qu'on cherche à
// éliminer.

/** Au-delà, l'échantillon ne dit plus rien d'utile sur l'heure serveur. */
export const RTT_MAX_MS = 1500

/** Fenêtre glissante : on ne compare que les 8 derniers échantillons valides. */
export const TAILLE_FENETRE = 8

/** 5 échantillons rapides à la connexion… */
export const ECHANTILLONS_RAPIDES = 5
export const INTERVALLE_RAPIDE_MS = 100

/** …puis 1 toutes les 5 s, ce qui sert aussi de heartbeat de liveness
 *  (le serveur coupe une socket muette depuis 20 s). */
export const INTERVALLE_LENT_MS = 5000

export interface Echantillon {
  /** `performance.now()` à l'émission. */
  t0: number
  /** `performance.now()` à la réception. */
  t1: number
  /** Aller-retour applicatif, en ms. */
  rtt: number
  /** À ajouter à `performance.now()` pour obtenir l'heure serveur estimée. */
  offset: number
}

/**
 * Calcule un échantillon, ou `null` s'il est inexploitable :
 * valeurs non finies, RTT négatif (horloge monotone violée), RTT > 1500 ms.
 */
export function calculerEchantillon(t0: number, s: number, t1: number): Echantillon | null {
  if (!Number.isFinite(t0) || !Number.isFinite(s) || !Number.isFinite(t1)) return null
  const rtt = t1 - t0
  if (rtt < 0 || rtt > RTT_MAX_MS) return null
  return { t0, t1, rtt, offset: s + rtt / 2 - t1 }
}

/** L'échantillon de plus faible RTT. À égalité, le plus récent gagne. */
export function meilleurEchantillon(echantillons: readonly Echantillon[]): Echantillon | null {
  let meilleur: Echantillon | null = null
  for (const e of echantillons) {
    if (meilleur === null || e.rtt <= meilleur.rtt) meilleur = e
  }
  return meilleur
}

/**
 * Horloge corrigée. Sans aucun échantillon valide, `offset` vaut 0 et `pret`
 * est faux : on retombe sur les horodatages serveur. Dégradation, pas panne.
 */
export class Horloge {
  #fenetre: Echantillon[] = []
  #meilleur: Echantillon | null = null
  readonly #now: () => number

  /** `now` est injectable pour que les tests n'aient pas à dormir. */
  constructor(now: () => number = () => performance.now()) {
    this.#now = now
  }

  /**
   * Enregistre la réponse `{c: t0, s}` du serveur.
   * @returns l'échantillon retenu, ou `null` s'il a été rejeté.
   */
  ajouter(t0: number, s: number, t1: number = this.#now()): Echantillon | null {
    const e = calculerEchantillon(t0, s, t1)
    if (e === null) return null
    this.#fenetre.push(e)
    if (this.#fenetre.length > TAILLE_FENETRE) this.#fenetre.shift()
    this.#meilleur = meilleurEchantillon(this.#fenetre)
    return e
  }

  /** 0 tant qu'aucun échantillon n'est valide. */
  get offset(): number {
    return this.#meilleur ? this.#meilleur.offset : 0
  }

  /** RTT de l'échantillon retenu, `null` s'il n'y en a pas. Diagnostic. */
  get rtt(): number | null {
    return this.#meilleur ? this.#meilleur.rtt : null
  }

  get pret(): boolean {
    return this.#meilleur !== null
  }

  get echantillons(): readonly Echantillon[] {
    return this.#fenetre
  }

  /** L'heure serveur estimée. */
  maintenant(): number {
    return this.#now() + this.offset
  }

  /**
   * Vide la fenêtre. À n'appeler QUE sur changement de session — surtout pas à
   * la reconnexion : `performance.now()` ne bouge pas d'une socket à l'autre,
   * l'offset précédent reste donc valide, et le jeter ferait retomber le client
   * à `offset = 0` juste après un mode avion, c'est-à-dire au pire moment.
   */
  reinitialiser(): void {
    this.#fenetre = []
    this.#meilleur = null
  }
}
