import type { ButtonHTMLAttributes, ReactNode } from 'react'

// Le bouton de base. Trois variantes, aucune autre : ajouter une couleur ici,
// c'est diluer le seul message que l'interface doit faire passer dans le noir
// — « ceci est l'action », « ceci est secondaire », « ceci est dangereux ».

export type VarianteBouton = 'primaire' | 'secondaire' | 'danger'

export interface ProprietesBouton extends ButtonHTMLAttributes<HTMLButtonElement> {
  variante?: VarianteBouton
  /** `grande` monte à 56 px : pour l'action principale d'un écran d'accueil. */
  taille?: 'normale' | 'grande'
  pleineLargeur?: boolean
  icone?: ReactNode
  children: ReactNode
}

const CLASSES: Record<VarianteBouton, string> = {
  primaire: 'bouton--primaire',
  secondaire: 'bouton--secondaire',
  danger: 'bouton--danger',
}

/**
 * `onPointerDown` passe tel quel jusqu'à l'élément : c'est volontaire et c'est
 * la raison d'être de ce composant. `click` n'est émis qu'au relâchement du
 * doigt — 80 à 200 ms offerts à l'adversaire. Tout ce qui doit être rapide
 * (le buzzer, MANCHE SUIVANTE) écoute `onPointerDown`.
 */
export function Bouton({
  variante = 'primaire',
  taille = 'normale',
  pleineLargeur = false,
  icone,
  children,
  className,
  type = 'button',
  ...reste
}: ProprietesBouton) {
  const classes = [
    'bouton',
    CLASSES[variante],
    taille === 'grande' ? 'bouton--grande' : '',
    pleineLargeur ? 'bouton--pleine' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button type={type} className={classes} {...reste}>
      {icone}
      <span className="min-w-0 truncate">{children}</span>
    </button>
  )
}
