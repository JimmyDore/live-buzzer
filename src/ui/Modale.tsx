import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

import { IconeCroix } from './Icones'

// Deux usages, deux seulement : le QR code en grand (pour le faire scanner par
// quinze personnes autour d'une table) et la confirmation de retrait d'un
// joueur. Rien d'autre ne mérite de couvrir l'écran pendant une soirée.
//
// La boîte est ancrée en bas : le pouce y arrive sans changer de main, et le
// fond flouté garde le contexte visible — on n'a jamais l'impression d'avoir
// changé d'écran.

export interface ProprietesModale {
  ouverte: boolean
  titre: string
  onFermer: () => void
  children: ReactNode
  /** Boutons du bas. Le premier doit être l'action, le dernier « Annuler ». */
  actions?: ReactNode
  /** `false` pour une confirmation destructrice : on veut un geste explicite. */
  fermetureParLeFond?: boolean
}

export function Modale({
  ouverte,
  titre,
  onFermer,
  children,
  actions,
  fermetureParLeFond = true,
}: ProprietesModale) {
  const boite = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ouverte) return
    const auClavier = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFermer()
    }
    window.addEventListener('keydown', auClavier)
    // Le focus part dans la modale : sans ça, un lecteur d'écran reste sur la
    // liste des buzz et l'utilisateur ne sait pas qu'on lui demande quelque chose.
    boite.current?.focus()
    return () => window.removeEventListener('keydown', auClavier)
  }, [ouverte, onFermer])

  if (!ouverte) return null

  return (
    <div
      className="modale-fond"
      onPointerDown={(e) => {
        if (fermetureParLeFond && e.target === e.currentTarget) onFermer()
      }}
    >
      <div
        ref={boite}
        className="modale-boite"
        role="dialog"
        aria-modal="true"
        aria-label={titre}
        tabIndex={-1}
      >
        <div className="flex items-start gap-3">
          <h2 className="modale-titre min-w-0 flex-1">{titre}</h2>
          <button
            type="button"
            className="bouton-icone -mr-1 -mt-1"
            onClick={onFermer}
            aria-label="Fermer"
          >
            <IconeCroix taille={22} />
          </button>
        </div>

        <div className="min-w-0">{children}</div>

        {actions ? <div className="flex flex-col gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}
