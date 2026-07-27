// Backoff de reconnexion (§4.2) : 250 ms → 4 s, avec gigue, à l'infini.
//
// La gigue n'est pas cosmétique : quand le wifi de la salle revient, quinze
// téléphones se reconnectent. Sans gigue ils tapent tous à la même
// milliseconde, le serveur en refuse une partie, et ils recommencent en chœur.

export const DELAI_MIN_MS = 250
export const DELAI_MAX_MS = 4000

/** ±20 % autour du délai nominal. */
export const GIGUE = 0.2

/**
 * Délai avant la tentative `essai` (0 = première reconnexion).
 * Croissance en 250, 500, 1000, 2000, 4000, puis plafond à 4000, chaque valeur
 * étant secouée de ±20 % puis ramenée dans [250, 4000].
 *
 * `alea` est injectable pour rendre les tests déterministes.
 */
// Aux deux extrémités (essai 0 et le plafond), la gigue est écrêtée par les
// bornes : c'est assumé. On préfère une garantie dure « jamais moins de 250 ms,
// jamais plus de 4 s » à une distribution parfaitement uniforme.
export function delaiBackoff(essai: number, alea: () => number = Math.random): number {
  const n = Number.isFinite(essai) ? Math.max(0, Math.floor(essai)) : 0
  // `2 ** n` déborde à +Infinity pour un n absurde : `Math.min` le rattrape.
  const base = Math.min(DELAI_MIN_MS * 2 ** n, DELAI_MAX_MS)
  const facteur = 1 - GIGUE + 2 * GIGUE * borner01(alea())
  return Math.round(Math.min(DELAI_MAX_MS, Math.max(DELAI_MIN_MS, base * facteur)))
}

function borner01(x: number): number {
  if (!Number.isFinite(x)) return 0.5
  return Math.min(1, Math.max(0, x))
}
