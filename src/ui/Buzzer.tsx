import type { PointerEvent as EvenementPointeur } from 'react'

import { formatRang } from '../lib/format'
import { IconeCadenas } from './Icones'

// Le buzzer. C'est l'écran du joueur en entier : un disque, trois états, et
// rien d'autre. Les trois états doivent être reconnaissables en une fraction
// de seconde, à bout de bras, dans le noir, par quelqu'un qui a bu un verre —
// donc ils ne diffèrent pas par une nuance mais par la couleur, la forme du
// halo, le mouvement et le mot affiché, tout à la fois.

export type EtatBuzzer = 'arme' | 'verrouille' | 'buzze'

export interface ProprietesBuzzer {
  etat: EtatBuzzer
  /** Position du joueur (1, 2, 3…). Requis quand `etat === 'buzze'`. */
  rang?: number
  /** Rang déjà formaté (« 1er », « 2e »). À défaut, calculé localement. */
  rangTexte?: string
  /** Temps de réaction déjà formaté (« 0,84 s »), relatif à l'ouverture. */
  temps?: string
  /**
   * Appelé sur `pointerdown`, jamais sur `click`. L'horodatage doit être pris
   * à la PREMIÈRE ligne du gestionnaire de l'appelant, avant tout rendu, tout
   * `setState` et tout appel réseau.
   */
  onBuzz?: (evenement: EvenementPointeur<HTMLButtonElement>) => void
}

export function Buzzer({ etat, rang, rangTexte, temps, onBuzz }: ProprietesBuzzer) {
  const premier = etat === 'buzze' && rang === 1

  const modificateur =
    etat === 'arme'
      ? 'buzzer--arme'
      : etat === 'verrouille'
        ? 'buzzer--verrouille'
        : premier
          ? 'buzzer--premier'
          : 'buzzer--suivant'

  const libelle =
    etat === 'arme'
      ? 'Buzzer armé — appuie pour buzzer'
      : etat === 'verrouille'
        ? 'Buzzers fermés'
        : `Tu as buzzé ${rangTexte ?? formatRang(rang ?? 1)}${temps ? `, en ${temps}` : ''}`

  return (
    <div className="buzzer-zone">
      <button
        type="button"
        className={`buzzer ${modificateur}`}
        // Jamais `onClick` pour déclencher le buzz : `click` ne part qu'au
        // relâchement du doigt et coûte 80 à 200 ms.
        onPointerDown={etat === 'arme' ? onBuzz : undefined}
        disabled={etat !== 'arme'}
        aria-live="assertive"
        aria-label={libelle}
      >
        {etat === 'arme' ? (
          <>
            <span className="buzzer-mot text-cyan" style={{ textShadow: '0 0 28px rgb(34 230 255 / 0.6)' }}>
              Buzz
            </span>
            <span className="buzzer-legende text-texte2">Le premier doigt gagne</span>
          </>
        ) : null}

        {etat === 'verrouille' ? (
          <>
            <IconeCadenas taille={56} className="text-[color:var(--color-eteint)]" />
            <span className="buzzer-legende mt-4 text-texte">Buzzers fermés</span>
            <span className="mt-1 text-xs font-semibold uppercase tracking-[0.16em] text-texte2">
              Attends le maître du jeu
            </span>
          </>
        ) : null}

        {etat === 'buzze' ? (
          <>
            <span
              className={`buzzer-rang ${premier ? 'text-jaune' : 'text-magenta'}`}
              style={{
                textShadow: premier
                  ? '0 0 36px rgb(255 225 77 / 0.65)'
                  : '0 0 30px rgb(255 47 185 / 0.55)',
              }}
              aria-hidden="true"
            >
              {rang ?? 1}
              <span className="buzzer-rang-suffixe">{premier ? 'er' : 'e'}</span>
            </span>
            {temps ? (
              <span className={`buzzer-detail ${premier ? 'text-jaune' : 'text-texte2'}`}>{temps}</span>
            ) : null}
            <span className="buzzer-legende text-texte2">
              {premier ? 'À toi de répondre' : 'Prêt si le premier se plante'}
            </span>
          </>
        ) : null}
      </button>
    </div>
  )
}

