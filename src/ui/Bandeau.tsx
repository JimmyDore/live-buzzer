import type { ReactNode } from 'react'

// Un mot discret et permanent, jamais un pop-up. La console du maître en porte
// un toute la soirée (« Garde cet écran allumé ») : s'il clignotait ou s'il se
// fermait, il ne servirait à rien — c'est justement le rappel qu'on doit
// pouvoir relire à la trentième question.

export interface ProprietesBandeau {
  children: ReactNode
  ton?: 'info' | 'attention'
  icone?: ReactNode
}

export function Bandeau({ children, ton = 'info', icone }: ProprietesBandeau) {
  return (
    <p className={`bandeau bandeau--${ton}`}>
      {icone ? (
        <span aria-hidden="true" className="mt-px shrink-0 leading-none">
          {icone}
        </span>
      ) : null}
      <span className="min-w-0">{children}</span>
    </p>
  )
}
