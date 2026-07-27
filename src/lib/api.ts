// API HTTP (§4.3) — le strict minimum. La WebSocket porte le jeu ; l'HTTP ne
// sert qu'à créer, à rejoindre, et à secourir.
//
// Toutes les erreurs remontent en `ErreurApi` avec un message DÉJÀ en français
// (le serveur les rend en français) : un écran n'a jamais à traduire un code.

export interface Partie {
  code: string
  hostToken: string
}

export interface ResumePartie {
  exists: boolean
  locked: boolean
  playerCount: number
}

export interface Inscription {
  playerId: string
  token: string
  name: string
}

export interface ResultatBuzz {
  rank: number
  ms: number
}

export class ErreurApi extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ErreurApi'
    this.status = status
  }

  /** `true` quand le serveur est injoignable (avion, wifi coupé). */
  get horsLigne(): boolean {
    return this.status === 0
  }
}

async function requete<T>(chemin: string, init?: RequestInit): Promise<T> {
  let reponse: Response
  try {
    reponse = await fetch(chemin, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    // `fetch` ne rejette que sur panne réseau : on le dit clairement plutôt que
    // de laisser fuir un « Failed to fetch » en anglais dans l'UI.
    throw new ErreurApi(0, 'Connexion impossible. Vérifie ta connexion réseau.')
  }

  const texte = await reponse.text()
  let corps: unknown = null
  try {
    corps = texte.length > 0 ? JSON.parse(texte) : null
  } catch {
    corps = null
  }

  if (!reponse.ok) {
    const message =
      corps && typeof corps === 'object' && typeof (corps as { error?: unknown }).error === 'string'
        ? (corps as { error: string }).error
        : `Erreur serveur (${reponse.status}).`
    throw new ErreurApi(reponse.status, message)
  }
  return corps as T
}

/** `POST /api/games` → `{ code, hostToken }`. Un tap, pas de formulaire. */
export function creerPartie(): Promise<Partie> {
  return requete<Partie>('/api/games', { method: 'POST' })
}

/** `GET /api/games/:code` → existence + verrou + nombre de joueurs. */
export function resumePartie(code: string): Promise<ResumePartie> {
  return requete<ResumePartie>(`/api/games/${encodeURIComponent(code)}`)
}

/** `POST /api/games/:code/players`. 409 = session complète, 404 = code inconnu. */
export function rejoindrePartie(code: string, name: string): Promise<Inscription> {
  return requete<Inscription>(`/api/games/${encodeURIComponent(code)}/players`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

/**
 * `POST /api/games/:code/buzz` — repli quand la WebSocket n'est pas OPEN (§3.4).
 * On envoie EXACTEMENT le même `at` que par la socket : le serveur applique le
 * même bornage, le buzz garde donc son vrai temps de réaction.
 */
export function buzzHttp(code: string, token: string, at: number): Promise<ResultatBuzz> {
  return requete<ResultatBuzz>(`/api/games/${encodeURIComponent(code)}/buzz`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ at, token }),
  })
}

/** `GET /api/health` — utilisé par le déploiement et le diagnostic. */
export function sante(): Promise<{ ok: boolean }> {
  return requete<{ ok: boolean }>('/api/health')
}
