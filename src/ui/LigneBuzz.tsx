// Une ligne de la liste du maître du jeu. C'est le cœur de sa console : il la
// lit du coin de l'œil pendant qu'il regarde la salle.
//
// Le 1er est jaune et énorme, avec son temps de réaction depuis l'ouverture.
// Les suivants sont magenta, plus compacts, avec l'écart au premier — c'est
// l'information qui sert vraiment : « le 2e est à 3 dixièmes, ça se discute ».
//
// L'arrivée dure 150 ms, avec une pointe de luminosité. Un fondu mou passerait
// inaperçu, et une ligne ratée c'est une dispute.

export interface ProprietesLigneBuzz {
  rang: number
  nom: string
  /** Déjà formaté : « 0,84 s » pour le 1er, « +0,31 s » pour les suivants. */
  temps: string
}

export function LigneBuzz({ rang, nom, temps }: ProprietesLigneBuzz) {
  const premier = rang === 1

  return (
    <li
      className={`ligne-buzz ${premier ? 'ligne-buzz--premier' : 'ligne-buzz--suivant'}`}
      // La clé de l'appelant remonte l'animation à chaque nouvelle manche.
      aria-label={`${rang === 1 ? '1er' : `${rang}e`} : ${nom}, ${temps}`}
    >
      <span
        className={`ligne-rang ${premier ? 'text-jaune' : 'text-magenta'}`}
        style={{
          width: premier ? '2.5rem' : '2rem',
          fontSize: premier ? 'clamp(2.25rem, 11vw, 2.75rem)' : 'clamp(1.5rem, 7.5vw, 1.875rem)',
          textShadow: premier ? '0 0 20px rgb(255 225 77 / 0.55)' : undefined,
        }}
        aria-hidden="true"
      >
        {rang}
      </span>

      <span
        className="ligne-nom text-texte"
        style={{
          // « Jean-Christophe » doit tenir sur une ligne à 320 px sans pousser
          // le temps hors de l'écran : la taille suit la largeur, le `truncate`
          // du CSS n'est que le dernier filet.
          fontSize: premier ? 'clamp(1.0625rem, 5.2vw, 1.375rem)' : 'clamp(0.9375rem, 4.4vw, 1.0625rem)',
        }}
      >
        {nom}
      </span>

      <span
        className={`ligne-temps ${premier ? 'text-jaune' : 'text-magenta'}`}
        style={{ fontSize: premier ? 'clamp(1.25rem, 6vw, 1.5rem)' : 'clamp(1rem, 4.8vw, 1.125rem)' }}
      >
        {temps}
      </span>
    </li>
  )
}
