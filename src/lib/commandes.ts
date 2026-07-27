// Les trois commandes de l'hôte (`next`, `lock`, `kick`) et leur unique mode
// d'échec : la socket n'était pas OPEN au moment du geste.
//
// C'était un P0. `envoyer()` renvoyait bien `false`, mais les trois commandes
// jetaient ce booléen : le maître tapait MANCHE SUIVANTE, rien ne partait, rien
// ne s'affichait, et la console annonçait toujours « CONNECTÉ ». Une déconnexion
// silencieuse est le pire scénario possible (§4.2) — et celle-ci l'était deux
// fois, puisque même le geste perdu se taisait.
//
// ⚠️ CE QU'ON NE FAIT PAS, ET C'EST DÉLIBÉRÉ : mettre la commande en file pour
// la rejouer à la reconnexion. Un `next` rejoué trois secondes plus tard efface
// une liste que le maître est en train de lire et rouvre les buzzers au mauvais
// moment — pendant qu'il pose la question suivante, par exemple : manche
// fantôme, buzz attribués à côté, dispute. Une commande perdue se redit d'un
// tap ; une commande rejouée à contretemps ne se rattrape pas. On échoue donc
// FRANCHEMENT : on le dit à l'écran, et on rouvre la socket sur-le-champ.

/**
 * `WebSocket.OPEN`, en dur. Ce module se teste dans l'environnement `node` de
 * vitest, où le global `WebSocket` du navigateur n'a rien à faire — et la
 * valeur est figée par la spécification, elle ne bougera pas.
 */
export const SOCKET_OUVERTE = 1

/** Le strict nécessaire d'une `WebSocket` pour émettre : testable sans DOM. */
export interface SocketEmettrice {
  readyState: number
  send(donnees: string): void
}

/**
 * Le message affiché quand une commande n'a pas pu partir. Une seule source :
 * l'écran l'affiche, le test l'assère — ils ne peuvent pas diverger.
 */
export const MESSAGE_COMMANDE_ECHOUEE = 'Commande non transmise — reconnexion en cours'

/**
 * Durée minimale d'affichage de l'alerte, même quand la socket revient tout de
 * suite. Sans ce plancher, une reconnexion en 300 ms ferait clignoter le
 * bandeau trop vite pour être vu dans une pièce sombre : le maître croirait sa
 * manche lancée alors qu'elle ne l'est pas.
 */
export const DUREE_MIN_ALERTE_MS = 4000

/**
 * Écrit `message` sur `ws` si et seulement si elle est RÉELLEMENT ouverte.
 *
 * @returns `true` seulement si l'octet est effectivement parti. C'est ce
 *          booléen que l'ancien code jetait.
 */
export function envoyerSur(ws: SocketEmettrice | null | undefined, message: object): boolean {
  if (!ws || ws.readyState !== SOCKET_OUVERTE) return false
  try {
    ws.send(JSON.stringify(message))
    return true
  } catch {
    // `send` peut jeter sur une socket qui se dit encore OPEN (elle ment) :
    // c'est un échec comme un autre, l'appelant doit l'apprendre.
    return false
  }
}

/**
 * Envoie une commande d'hôte, et signale l'échec au lieu de l'avaler.
 *
 * `surEchec` n'est appelé QUE si rien n'est parti — et rien n'est mémorisé pour
 * plus tard : voir l'avertissement en tête de fichier.
 */
export function commander(
  ws: SocketEmettrice | null | undefined,
  message: object,
  surEchec: () => void,
): boolean {
  if (envoyerSur(ws, message)) return true
  surEchec()
  return false
}

/**
 * Combien de temps l'alerte « commande non transmise » doit-elle encore rester ?
 *
 * @param echecA     instant du dernier échec (`Date.now()`), `null` si aucun.
 * @param connecte   la socket est-elle de nouveau ouverte ?
 * @param maintenant `Date.now()`.
 * @returns `null` : rien à planifier — soit il n'y a rien à afficher, soit on
 *          est TOUJOURS coupé et l'alerte reste (elle ne s'efface jamais toute
 *          seule tant que la connexion n'est pas revenue).
 *          `0` : à masquer immédiatement. `n > 0` : à masquer dans `n` ms.
 */
export function delaiMasquageAlerte(
  echecA: number | null,
  connecte: boolean,
  maintenant: number,
  duree: number = DUREE_MIN_ALERTE_MS,
): number | null {
  if (echecA === null) return null
  if (!connecte) return null
  const restant = duree - (maintenant - echecA)
  return restant > 0 ? restant : 0
}
