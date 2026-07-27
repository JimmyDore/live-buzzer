// Formatage FR (CONTRACT §10) — figé.
//
// Tout ce qui s'affiche à l'écran passe d'ici. Trois règles, non négociables :
// virgule décimale française, deux décimales (au-delà on lit du bruit de
// mesure, en deçà deux buzz à 40 ms d'écart deviennent identiques), ordinaux
// français.
//
// La normalisation des codes de session vit ici aussi (voir plus bas) : c'est
// du parsing de saisie, pas du composant, et vitest ne regarde que `.ts`.

/** `842` → `« 0,84 s »`. */
export function formatSecondes(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  return `${deuxDecimales(ms)} s`
}

/** Écart au premier : `310` → `« +0,31 s »`. Le signe est toujours présent. */
export function formatEcart(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  // Un écart négatif ne devrait pas exister (le rang 1 est le plus petit
  // `effectif`), mais un reclassement en vol peut faire passer un écart par
  // -1 ms le temps d'un rendu : on l'affiche plutôt que de mentir.
  const signe = ms < 0 ? '-' : '+'
  return `${signe}${deuxDecimales(Math.abs(ms))} s`
}

/** Ordinal français : `1` → `« 1er »`, `2` → `« 2e »`, `12` → `« 12e »`. */
export function formatRang(rang: number): string {
  if (!Number.isFinite(rang)) return '—'
  const n = Math.trunc(rang)
  return n === 1 ? '1er' : `${n}e`
}

function deuxDecimales(ms: number): string {
  // Arrondi fait en entier AVANT la division : `(0.845).toFixed(2)` rend
  // « 0.84 » (0,845 n'est pas représentable en binaire), ce qui afficherait
  // deux temps de réaction différents comme identiques.
  return (Math.round(ms / 10) / 100).toFixed(2).replace('.', ',')
}

// ---------------------------------------------------------------- codes
//
// Alphabet sans confusables, identique à `server/codes.mjs` (CONTRACT §8).
// SEULE implémentation de la normalisation : `src/ui/ChampCode.tsx` importe
// d'ici, `src/router.tsx` y prend `ALPHABET` / `LONGUEUR_CODE`. Deux copies qui
// divergent, c'est un code accepté au clavier et refusé dans l'URL.
//
// ⚠️ Le routeur, lui, ne doit JAMAIS appeler `normaliserCode` : il valide
// strictement (§`codeValide`). Tolérant au clavier, strict dans l'URL.

export const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY346789'
export const LONGUEUR_CODE = 4

/**
 * Saisie tolérante : minuscules acceptées, espaces et tirets ignorés, tout
 * caractère hors alphabet écarté en silence. On ne fait jamais clignoter une
 * erreur à quelqu'un qui tape « zk 4p » sur un clavier de téléphone.
 * Rend une chaîne d'au plus 4 caractères, éventuellement vide.
 */
export function normaliserCode(saisie: string): string {
  if (typeof saisie !== 'string') return ''
  let sortie = ''
  for (const c of saisie.toUpperCase()) {
    if (ALPHABET.includes(c)) sortie += c
    if (sortie.length === LONGUEUR_CODE) break
  }
  return sortie
}

/** Un code n'est valide qu'à 4 caractères, tous dans l'alphabet. */
export function estCodeValide(code: string): boolean {
  return typeof code === 'string' && code.length === LONGUEUR_CODE && normaliserCode(code) === code
}
