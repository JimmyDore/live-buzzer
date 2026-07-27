// Codes de session : quatre caractères, lus à voix haute dans une pièce
// bruyante et retapés sur un clavier de téléphone par quelqu'un qui a bu un
// verre. L'alphabet exclut tous les confusables classiques.

/**
 * Alphabet sans confusables : ni I/1/L, ni O/0, ni S/5, ni B/8, ni Z/2.
 * 26 caractères → 26⁴ = 456 976 combinaisons, très largement assez pour des
 * sessions qui vivent 24 h.
 */
export const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY346789';
export const LONGUEUR_CODE = 4;

/** Tire un code au hasard. `rng` doit rendre [0,1[ (injectable pour les tests). */
export function genererCode(rng = Math.random, longueur = LONGUEUR_CODE) {
  let code = '';
  for (let i = 0; i < longueur; i++) {
    code += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  }
  return code;
}

/**
 * Saisie tolérante : on accepte les minuscules, on jette espaces et tirets.
 * Rend `null` si ce qui reste n'est pas un code valide — refuser proprement
 * vaut mieux que d'aller interroger la base avec n'importe quoi.
 */
export function normaliserCode(saisie) {
  if (typeof saisie !== 'string') return null;
  const propre = saisie.replace(/[\s-]+/g, '').toUpperCase();
  return estCodeValide(propre) ? propre : null;
}

export function estCodeValide(code) {
  if (typeof code !== 'string' || code.length !== LONGUEUR_CODE) return false;
  for (const c of code) {
    if (!ALPHABET.includes(c)) return false;
  }
  return true;
}
