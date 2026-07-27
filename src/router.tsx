import { useEffect, useState } from 'react'

import { ALPHABET, LONGUEUR_CODE } from './lib/format'

// Mini-routeur maison. Le jeu a trois routes plus une page de démonstration :
// React Router pèserait plus lourd que l'application entière. On écoute
// `popstate` (retour arrière du navigateur) et un événement maison pour les
// navigations programmatiques.

export type Route =
  | { nom: 'accueil' }
  | { nom: 'maitre'; code: string }
  | { nom: 'joueur'; code: string }
  | { nom: 'demo' }
  | { nom: 'inconnu' }

const NAVIGATION = 'buzz:navigation'

/**
 * L'ORDRE DES TESTS EST LA SPÉCIFICATION, pas un détail d'écriture.
 * `/m/:code` se teste AVANT `/:code`, et `/demo` avant `/:code`. Inverser
 * les deux premiers rend la console du maître du jeu inatteignable : la
 * soirée n'a alors plus d'animateur.
 */
export function parseRoute(pathname: string): Route {
  // `filter(Boolean)` absorbe les barres obliques finales et doublées :
  // `/m/KJ7M/`, `//KJ7M` et `/KJ7M` mènent tous au bon endroit. Un QR code mal
  // recopié ne doit pas coûter une session.
  const segments = pathname.split('/').filter(Boolean)

  if (segments.length === 0) return { nom: 'accueil' }

  // 1. La console du maître, EN PREMIER.
  //    `m` accepté en majuscule : sur mobile, l'autocapitalisation d'une URL
  //    tapée à la main donne « /M/KJ7M ». Aucune ambiguïté possible avec un
  //    code, qui fait toujours 4 caractères.
  if (segments.length === 2 && segments[0].toLowerCase() === 'm') {
    const code = codeValide(segments[1])
    return code ? { nom: 'maitre', code } : { nom: 'inconnu' }
  }

  // 2. La démonstration du système de design, AVANT la route joueur.
  if (segments.length === 1 && segments[0].toLowerCase() === 'demo') return { nom: 'demo' }

  // 3. Le joueur, en dernier : c'est la route attrape-tout à un segment.
  if (segments.length === 1) {
    const code = codeValide(segments[0])
    return code ? { nom: 'joueur', code } : { nom: 'inconnu' }
  }

  return { nom: 'inconnu' }
}

/**
 * Validation STRICTE d'un code d'URL : exactement 4 caractères de l'alphabet,
 * ni plus ni moins. On ne réutilise surtout pas `normaliserCode`
 * (`src/lib/format.ts`), qui est volontairement tolérant et *filtre* la saisie :
 * « KJ7MX » y devient « KJ7M », et « /KJ7MX » ouvrirait alors la session de
 * quelqu'un d'autre.
 * Tolérant au clavier, strict dans l'URL.
 * @returns le code en MAJUSCULES, ou `null` si l'URL ne porte pas un code.
 */
function codeValide(segment: string): string | null {
  const majuscules = segment.toUpperCase()
  if (majuscules.length !== LONGUEUR_CODE) return null
  for (const caractere of majuscules) if (!ALPHABET.includes(caractere)) return null
  return majuscules
}

/**
 * Le lien qu'on partage aux joueurs (QR code, `navigator.share`, copie).
 * Il doit toujours retomber sur la route joueur : un QR que notre propre
 * routeur ne sait pas lire, c'est la soirée qui ne démarre pas.
 */
export function lienJoueur(origine: string, code: string): string {
  return `${origine.replace(/\/+$/, '')}/${code.toUpperCase()}`
}

export function naviguer(path: string): void {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new Event(NAVIGATION))
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname))

  useEffect(() => {
    const synchroniser = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener('popstate', synchroniser)
    window.addEventListener(NAVIGATION, synchroniser)
    return () => {
      window.removeEventListener('popstate', synchroniser)
      window.removeEventListener(NAVIGATION, synchroniser)
    }
  }, [])

  return route
}
