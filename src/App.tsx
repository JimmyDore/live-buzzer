import { naviguer, useRoute } from './router'
import { Accueil } from './screens/Accueil'
import { Demo } from './screens/Demo'
import { Joueur } from './screens/Joueur'
import { Maitre } from './screens/Maitre'
import { Bouton, EtatVide, IconeCroix } from './ui'

// La coquille de l'application : une lecture de route, un aiguillage, rien de
// plus. Aucun état global, aucun fournisseur de contexte — chaque écran est
// autonome et se reconstruit entièrement quand la route change, ce qui est
// exactement le comportement voulu quand quelqu'un scanne un QR code depuis
// une session déjà ouverte.

export function App() {
  const route = useRoute()

  switch (route.nom) {
    case 'accueil':
      return <Accueil />
    case 'maitre':
      return <Maitre code={route.code} />
    case 'joueur':
      return <Joueur code={route.code} />
    case 'demo':
      return <Demo />
    default:
      return <Introuvable />
  }
}

/**
 * Le cul-de-sac : URL inconnue, ou code mal recopié depuis le téléphone d'en
 * face. Dans les deux cas la personne est debout, dans le noir, à côté de gens
 * qui jouent déjà. Elle doit lire en une seconde ce qui ne va pas, et avoir
 * une sortie sous le pouce — jamais un écran mort.
 */
function Introuvable() {
  return (
    <main className="ecran items-center justify-center gap-6 text-center">
      <p className="text-[0.6875rem] font-bold uppercase tracking-[0.22em] text-magenta">
        Live buzzer
      </p>
      <EtatVide
        ton="erreur"
        icone={<IconeCroix taille={34} />}
        titre="Page introuvable"
        detail={
          <>
            Ce lien ne mène à aucune session. Un code de session fait{' '}
            <strong className="text-texte">4 caractères</strong>, sans O, sans I, sans Z ni S —
            redemande-le au maître du jeu.
          </>
        }
        action={
          <Bouton pleineLargeur onClick={() => naviguer('/')}>
            Retour à l’accueil
          </Bouton>
        }
      />
    </main>
  )
}
