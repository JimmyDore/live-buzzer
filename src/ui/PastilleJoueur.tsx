import { useCallback, useEffect, useRef, useState } from 'react'

import { PointConnexion } from './PointConnexion'

// La pastille d'un joueur dans la console du maître. Compacte, parce qu'à 15
// joueurs cette zone ne doit pas manger la liste des buzz.
//
// L'appui long est la SEULE affordance de gestion du jeu (retirer un joueur
// fantôme). Elle est volontairement lente à déclencher — 600 ms — et suivie
// d'une confirmation : personne ne doit exclure un copain en effleurant
// l'écran pendant qu'il cherche le bouton MANCHE SUIVANTE.

const DELAI_APPUI_LONG = 600

export interface ProprietesPastilleJoueur {
  nom: string
  connecte: boolean
  /** A déjà buzzé cette manche : sa place est dans la liste, il s'efface ici. */
  aBuzze?: boolean
  /** Appui long → l'appelant ouvre une confirmation. Absent = pastille inerte. */
  onAppuiLong?: () => void
}

export function PastilleJoueur({ nom, connecte, aBuzze = false, onAppuiLong }: ProprietesPastilleJoueur) {
  const [pressee, setPressee] = useState(false)
  const minuterie = useRef<number | null>(null)

  const annuler = useCallback(() => {
    if (minuterie.current !== null) {
      window.clearTimeout(minuterie.current)
      minuterie.current = null
    }
    setPressee(false)
  }, [])

  // Une pastille démontée en plein appui (joueur exclu, manche suivante) ne
  // doit pas laisser un timer déclencher une exclusion dans le vide.
  useEffect(() => annuler, [annuler])

  const demarrer = () => {
    if (!onAppuiLong) return
    setPressee(true)
    minuterie.current = window.setTimeout(() => {
      minuterie.current = null
      setPressee(false)
      onAppuiLong()
    }, DELAI_APPUI_LONG)
  }

  const classes = [
    'pastille',
    aBuzze ? 'pastille--buzze' : '',
    !connecte ? 'pastille--absent' : '',
    pressee ? 'pastille--pressee' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const etatLu = !connecte ? 'déconnecté' : aBuzze ? 'a buzzé' : 'connecté'

  return (
    <button
      type="button"
      className={classes}
      disabled={!onAppuiLong}
      onPointerDown={demarrer}
      onPointerUp={annuler}
      onPointerLeave={annuler}
      onPointerCancel={annuler}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={`${nom} — ${etatLu}${onAppuiLong ? ' — appui long pour retirer' : ''}`}
    >
      <PointConnexion etat={connecte ? 'ouvert' : 'perdu'} />
      <span className="pastille-nom">{nom}</span>
      {aBuzze ? <span aria-hidden="true">✓</span> : null}
    </button>
  )
}
