import type { ReactNode } from 'react'

// En-tête d'écran. Sur la console du maître, le code est l'information la
// plus demandée de la soirée (« c'est quoi le code déjà ? ») : il est écrit
// en gros, en cyan, et il reste sélectionnable pour être copié à la main si
// le partage natif n'existe pas sur le téléphone.
//
// Sur l'écran joueur, la même barre porte son prénom et le code en petit :
// il n'a besoin de rien d'autre en haut, le buzzer prend tout le reste.

export interface ProprietesEntete {
  /** Le code de session, écrit en très gros. Prioritaire sur `titre`. */
  code?: string
  /** Titre alternatif (le prénom du joueur, par exemple). */
  titre?: string
  /** Ligne d'appoint sous le titre : point de connexion, code en petit… */
  legende?: ReactNode
  /** Boutons alignés à droite (partager, verrou, son…). */
  actions?: ReactNode
}

export function Entete({ code, titre, legende, actions }: ProprietesEntete) {
  return (
    <header className="entete">
      <div className="min-w-0 flex-1">
        {code ? (
          <h1 className="entete-code selectionnable truncate">{code}</h1>
        ) : (
          <h1 className="font-titre truncate text-2xl uppercase leading-none tracking-[0.06em] text-texte">
            {titre}
          </h1>
        )}
        {legende ? <p className="entete-legende min-w-0">{legende}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}
