import type { PointerEventHandler, ReactNode } from 'react'

// MANCHE SUIVANTE. Le geste de la soirée, fait cinquante fois, au pouce, dans
// une pièce mal éclairée. Il est collé en bas, il fait 76 px de haut, il est
// écrit en capitales d'affiche, et il n'y a rien de dangereux à moins de
// 16 px : le verrou vit dans l'en-tête, à l'autre bout de l'écran.

export interface ProprietesBoutonGeant {
  children: ReactNode
  /** Rapide : on écoute la descente du doigt, pas le relâchement. */
  onPointerDown?: PointerEventHandler<HTMLButtonElement>
  /** Repli clavier / lecteur d'écran. Un `pointerdown` déclenche aussi `click`. */
  onClick?: () => void
  disabled?: boolean
  variante?: 'primaire' | 'danger'
  /** Ligne courte au-dessus du bouton (« Buzzers ouverts », un rappel…). */
  indice?: ReactNode
  /** Barre collée en bas d'écran (défaut) ou bouton posé dans le flux. */
  colle?: boolean
  'aria-label'?: string
}

export function BoutonGeant({
  children,
  onPointerDown,
  onClick,
  disabled = false,
  variante = 'primaire',
  indice,
  colle = true,
  'aria-label': ariaLabel,
}: ProprietesBoutonGeant) {
  const bouton = (
    <button
      type="button"
      className={`bouton-geant bouton-geant--${variante}`}
      onPointerDown={onPointerDown}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  )

  if (!colle) return bouton

  return (
    <div className="barre-basse">
      {indice ? (
        <p className="mb-2 text-center text-[0.6875rem] font-bold uppercase tracking-[0.18em] text-texte2">
          {indice}
        </p>
      ) : null}
      {bouton}
    </div>
  )
}
