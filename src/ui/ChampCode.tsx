import { useId } from 'react'

import { normaliserCode } from '../lib/format'

// Le champ de code. Il est tapé une fois par personne, souvent par quelqu'un
// qui lit le code sur le téléphone d'en face. La saisie est donc tolérante :
// minuscules acceptées, espaces et tirets ignorés, le reste refusé en
// silence. On ne renvoie jamais l'utilisateur à une erreur pour une majuscule.
//
// `normaliserCode` vit dans `src/lib/format.ts` — seule implémentation, seule
// testée. Ce fichier en a longtemps porté une copie : deux normalisations qui
// divergent, c'est un code accepté ici et refusé là.

export interface ProprietesChampCode {
  valeur: string
  /** Reçoit déjà la valeur normalisée : l'appelant n'a rien à nettoyer. */
  onChange: (code: string) => void
  /** Entrée clavier ou code complet : l'appelant décide quoi en faire. */
  onValider?: () => void
  erreur?: string | null
  autoFocus?: boolean
}

export function ChampCode({ valeur, onChange, onValider, erreur, autoFocus = false }: ProprietesChampCode) {
  const id = useId()

  return (
    <div className="w-full">
      <label
        htmlFor={id}
        className="mb-2 block text-[0.6875rem] font-bold uppercase tracking-[0.18em] text-texte2"
      >
        Code de la session
      </label>
      <input
        id={id}
        // `inputmode="text"` et pas `numeric` : le code mélange lettres et
        // chiffres. `autocapitalize="characters"` évite l'aller-retour par la
        // touche majuscule sur un clavier mobile.
        inputMode="text"
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="go"
        // PAS de `maxLength` : il tronquerait la saisie BRUTE avant que
        // `normaliserCode` n'en retire les séparateurs. Un code collé depuis un
        // SMS (« kj 7m », « kj-7m ») deviendrait « KJ7 » — la saisie tolérante
        // du §2 tomberait précisément dans le cas où elle sert. La valeur
        // affichée est de toute façon bornée à 4 caractères : `normaliserCode`
        // filtre puis coupe, et le champ est contrôlé.
        // eslint-disable-next-line jsx-a11y/no-autofocus -- l'écran n'a qu'un champ
        autoFocus={autoFocus}
        className={`champ champ--code ${erreur ? 'champ--erreur' : ''}`}
        placeholder="KJ7M"
        value={valeur}
        aria-invalid={erreur ? true : undefined}
        aria-describedby={erreur ? `${id}-erreur` : undefined}
        onChange={(e) => onChange(normaliserCode(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onValider) onValider()
        }}
      />
      {erreur ? (
        <p id={`${id}-erreur`} className="champ-message" role="alert">
          <span aria-hidden="true">✕</span>
          {erreur}
        </p>
      ) : null}
    </div>
  )
}
