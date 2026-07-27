import type { ReactNode } from 'react'

import { IconeEclair } from './Icones'

// L'état de connexion est visible en permanence, des deux côtés. Une
// déconnexion silencieuse est le pire scénario du jeu : le maître croit que
// personne ne buzze, les joueurs croient que le maître ne relance pas, et
// personne ne comprend pourquoi la soirée s'arrête.
//
// Le point suffit tant que ça va. Dès que la coupure dure, on passe au
// bandeau : franc, rouge, impossible à confondre avec de la décoration.

/** Aligné sur `EtatConnexion` de `src/lib/useRealtime.ts` (CONTRACT §6). */
export type EtatConnexion = 'connexion' | 'ouvert' | 'perdu'

const LIBELLES: Record<EtatConnexion, string> = {
  ouvert: 'Connecté',
  connexion: 'Connexion…',
  perdu: 'Hors ligne',
}

const TEINTES: Record<EtatConnexion, string> = {
  ouvert: 'text-vert',
  connexion: 'text-orange',
  perdu: 'text-rouge',
}

export interface ProprietesPointConnexion {
  etat: EtatConnexion
  /** Affiche le libellé à côté du point (en-tête). Sinon, point seul. */
  avecLibelle?: boolean
}

export function PointConnexion({ etat, avecLibelle = false }: ProprietesPointConnexion) {
  const point = <span className={`point point--${etat}`} aria-hidden="true" />

  if (!avecLibelle) {
    // `role="status"` : un lecteur d'écran annonce le changement d'état.
    return (
      <span className="inline-flex items-center" role="status" aria-label={LIBELLES[etat]}>
        {point}
      </span>
    )
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[0.6875rem] font-bold uppercase tracking-[0.16em] ${TEINTES[etat]}`}
      role="status"
    >
      {point}
      {LIBELLES[etat]}
    </span>
  )
}

export interface ProprietesBandeauConnexion {
  etat: EtatConnexion
  /** Secondes écoulées depuis la coupure, si l'appelant les connaît. */
  depuis?: number
  action?: ReactNode
}

/**
 * Bandeau de coupure prolongée. À n'afficher que quand `etat === 'perdu'` :
 * un bandeau qui clignote à chaque micro-reconnexion devient du bruit, et on
 * cesse de le lire exactement le soir où il compte.
 */
export function BandeauConnexion({ etat, depuis, action }: ProprietesBandeauConnexion) {
  if (etat === 'ouvert') return null

  const coupe = etat === 'perdu'

  return (
    <div className={`bandeau ${coupe ? 'bandeau--coupure' : 'bandeau--attention'}`} role="alert">
      {coupe ? (
        <IconeEclair taille={18} className="mt-px shrink-0" />
      ) : (
        <span className="point point--connexion mt-1.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0">
        {coupe ? (
          <>
            <strong className="font-extrabold uppercase tracking-[0.08em]">Connexion perdue</strong>
            {' — on réessaie tout seul'}
            {typeof depuis === 'number' ? ` (${depuis} s)` : ''}. Reviens sur cette page si tu l'as
            quittée.
          </>
        ) : (
          <>Reconnexion en cours…</>
        )}
      </span>
      {action ? <span className="ml-auto shrink-0">{action}</span> : null}
    </div>
  )
}
