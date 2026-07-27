import type { ReactNode } from 'react'

// Un écran blanc, c'est une panne pour celui qui le regarde. Chaque zone qui
// peut être vide dit donc ce qu'elle attend et de qui : « les buzzers sont
// ouverts, personne n'a encore buzzé » est une information, pas un trou.
//
// Le ton `erreur` sert aux impasses réelles (code inconnu, session pleine) :
// il est encadré de rouge et il porte toujours une sortie, jamais un
// cul-de-sac.

export interface ProprietesEtatVide {
  titre: string
  detail?: ReactNode
  /** Emoji ou SVG. Un seul, gros, jamais une illustration décorative. */
  icone?: ReactNode
  ton?: 'neutre' | 'erreur'
  /** Bouton de sortie (retour à l'accueil, réessayer…). */
  action?: ReactNode
}

export function EtatVide({ titre, detail, icone, ton = 'neutre', action }: ProprietesEtatVide) {
  return (
    <div className={`etat-vide ${ton === 'erreur' ? 'etat-vide--erreur' : ''}`} role="status">
      {icone ? (
        <span
          aria-hidden="true"
          className={`text-3xl leading-none ${ton === 'erreur' ? 'text-rouge' : 'text-texte2'}`}
        >
          {icone}
        </span>
      ) : null}
      <p className={`etat-vide-titre ${ton === 'erreur' ? 'text-rouge' : ''}`}>{titre}</p>
      {detail ? <p className="etat-vide-detail">{detail}</p> : null}
      {action ? <div className="mt-2 w-full max-w-[16rem]">{action}</div> : null}
    </div>
  )
}
