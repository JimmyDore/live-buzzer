// Point d'entrée unique du système de design. Les écrans importent d'ici et
// jamais d'un fichier de primitive en particulier : le jour où une primitive
// se scinde en deux, aucun écran ne bouge.

export { Bandeau } from './Bandeau'
export type { ProprietesBandeau } from './Bandeau'

export { Bouton } from './Bouton'
export type { ProprietesBouton, VarianteBouton } from './Bouton'

export { BoutonGeant } from './BoutonGeant'
export type { ProprietesBoutonGeant } from './BoutonGeant'

export { Buzzer } from './Buzzer'
export type { EtatBuzzer, ProprietesBuzzer } from './Buzzer'

// `ALPHABET`, `LONGUEUR_CODE` et `normaliserCode` ne sont PAS réexportés ici :
// ce n'est pas du design système, c'est du parsing de saisie. Une seule
// implémentation, dans `src/lib/format.ts`, et c'est celle que vitest teste.
export { ChampCode } from './ChampCode'
export type { ProprietesChampCode } from './ChampCode'

export {
  IconeCadenas,
  IconeCercle,
  IconeCroix,
  IconeEclair,
  IconeEcran,
  IconePartage,
  IconeSon,
} from './Icones'

export { Entete } from './Entete'
export type { ProprietesEntete } from './Entete'

export { EtatVide } from './EtatVide'
export type { ProprietesEtatVide } from './EtatVide'

export { LigneBuzz } from './LigneBuzz'
export type { ProprietesLigneBuzz } from './LigneBuzz'

export { Modale } from './Modale'
export type { ProprietesModale } from './Modale'

export { PastilleJoueur } from './PastilleJoueur'
export type { ProprietesPastilleJoueur } from './PastilleJoueur'

export { BandeauConnexion, PointConnexion } from './PointConnexion'
export type {
  EtatConnexion,
  ProprietesBandeauConnexion,
  ProprietesPointConnexion,
} from './PointConnexion'
