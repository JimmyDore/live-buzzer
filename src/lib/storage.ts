// Identité locale (§4.5) : le jeton hôte par code, et {playerId, token, name}
// par code. Un joueur qui rouvre l'URL de sa session retrouve sa place et son
// prénom sans rien retaper — c'est la différence entre « mon téléphone a
// redémarré » et « j'ai perdu ma place ».
//
// Tout passe par `lire`/`ecrire`/`effacer` qui n'échouent JAMAIS : Safari en
// navigation privée expose bien `localStorage` mais lève à l'écriture, et un
// écran blanc en pleine soirée pour un quota dépassé serait ridicule. Sans
// stockage, l'app marche encore : on retape son prénom, c'est tout.

const PREFIXE = 'lb'

export interface SessionJoueur {
  playerId: string
  token: string
  name: string
}

// -------------------------------------------------------------- primitives

/** Rend le `Storage` s'il est utilisable, `null` sinon. Jamais d'exception. */
function stock(): Storage | null {
  try {
    // Lu à chaque appel (et pas mis en cache) : les tests substituent un faux
    // `globalThis.localStorage`, et l'environnement node de vitest n'en a pas.
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function lire(cle: string): string | null {
  try {
    return stock()?.getItem(cle) ?? null
  } catch {
    return null
  }
}

function ecrire(cle: string, valeur: string): void {
  try {
    stock()?.setItem(cle, valeur)
  } catch {
    /* quota, navigation privée, stockage désactivé : on continue sans */
  }
}

function effacer(cle: string): void {
  try {
    stock()?.removeItem(cle)
  } catch {
    /* idem */
  }
}

/** Les codes sont toujours manipulés en MAJUSCULES (CONTRACT §7). */
function cleHote(code: string): string {
  return `${PREFIXE}:hote:${String(code).toUpperCase()}`
}

function cleJoueur(code: string): string {
  return `${PREFIXE}:joueur:${String(code).toUpperCase()}`
}

// ------------------------------------------------------------------ hôte

export function lireHostToken(code: string): string | null {
  const v = lire(cleHote(code))
  return v && v.length > 0 ? v : null
}

export function ecrireHostToken(code: string, token: string): void {
  if (!token) return
  ecrire(cleHote(code), token)
}

export function oublierHote(code: string): void {
  effacer(cleHote(code))
}

// ---------------------------------------------------------------- joueur

/** `null` si absent, illisible ou de forme inattendue (JSON bricolé à la main). */
export function lireJoueur(code: string): SessionJoueur | null {
  const brut = lire(cleJoueur(code))
  if (!brut) return null
  try {
    const o = JSON.parse(brut) as Partial<SessionJoueur>
    if (!o || typeof o !== 'object') return null
    if (typeof o.playerId !== 'string' || o.playerId.length === 0) return null
    if (typeof o.token !== 'string' || o.token.length === 0) return null
    if (typeof o.name !== 'string') return null
    return { playerId: o.playerId, token: o.token, name: o.name }
  } catch {
    return null
  }
}

export function ecrireJoueur(code: string, joueur: SessionJoueur): void {
  if (!joueur?.playerId || !joueur.token) return
  ecrire(cleJoueur(code), JSON.stringify({ playerId: joueur.playerId, token: joueur.token, name: joueur.name ?? '' }))
}

/** Après une exclusion par le maître : le jeton ne vaut plus rien. */
export function oublierJoueur(code: string): void {
  effacer(cleJoueur(code))
}

// -------------------------------------------------------------------- son

const CLE_MUET = `${PREFIXE}:muet`

export function lireMuet(): boolean {
  return lire(CLE_MUET) === '1'
}

export function ecrireMuet(muet: boolean): void {
  if (muet) ecrire(CLE_MUET, '1')
  else effacer(CLE_MUET)
}
