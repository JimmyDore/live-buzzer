import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, ReactNode } from 'react'

import {
  BandeauConnexion,
  Bouton,
  Buzzer,
  Entete,
  EtatVide,
  IconeCroix,
  IconeSon,
  PointConnexion,
} from '../ui'
import type { EtatBuzzer } from '../ui'
import { ErreurApi, rejoindrePartie, resumePartie } from '../lib/api'
import { formatRang, formatSecondes } from '../lib/format'
import { basculerMuet, estMuet, jouerBuzz, prechaufferAudio } from '../lib/son'
import { ecrireJoueur, lireJoueur, oublierJoueur } from '../lib/storage'
import type { SessionJoueur } from '../lib/storage'
import { useRealtime } from '../lib/useRealtime'
import type { CodeErreur } from '../lib/useRealtime'
import { useWakeLock } from '../lib/wakelock'

// ---------------------------------------------------------------------------
// `/:code` — l'écran du joueur.
//
// Deux états, jamais trois (§2 du brief) :
//   1. avant de rejoindre — un prénom, un bouton « C'est parti » ;
//   2. en jeu — le buzzer, et RIEN d'autre.
//
// Ce qui n'existe pas ici, et qui n'existe nulle part dans le produit : aucun
// score, aucun point, aucune équipe, aucun chrono, aucun contenu de quiz.
//
// Et surtout : le joueur ne voit JAMAIS la liste des autres. Le serveur filtre
// déjà `state` par rôle (`server/protocol.mjs`, `etatPour`) et `useRealtime`
// laisse `buzzes` vide côté joueur — mais on ne rend ici ni `rt.buzzes` ni
// `rt.players`, uniquement `rt.moi`. Trois verrous plutôt qu'un : une fuite
// serveur resterait sans effet à l'écran.
// ---------------------------------------------------------------------------

export interface ProprietesJoueur {
  /** Code de session, déjà normalisé en majuscules par le routeur. */
  code: string
}

type Etape =
  | { nom: 'chargement' }
  | { nom: 'formulaire' }
  | { nom: 'inconnu' }
  | { nom: 'pleine' }
  | { nom: 'jeu'; session: SessionJoueur }

export function Joueur({ code }: ProprietesJoueur) {
  // Un joueur qui rouvre l'URL de sa session retrouve sa place et son prénom
  // sans rien retaper (§4.5). C'est lu dès l'initialisation du state, pas dans
  // un effet : sinon le formulaire clignoterait une frame avant de disparaître.
  const [etape, setEtape] = useState<Etape>(() => {
    const gardee = lireJoueur(code)
    return gardee ? { nom: 'jeu', session: gardee } : { nom: 'chargement' }
  })
  const [nomInitial, setNomInitial] = useState(() => lireJoueur(code)?.name ?? '')

  // Vérification d'existence du code. Elle sert deux cas :
  //  - pas de session gardée → on sait tout de suite s'il faut afficher le
  //    formulaire ou « code inconnu », sans attendre la WebSocket ;
  //  - session gardée mais partie purgée (24 h) ou base repartie de zéro → on
  //    nettoie le localStorage plutôt que de laisser le joueur devant un
  //    buzzer qui ne répondra jamais.
  useEffect(() => {
    let vivant = true
    resumePartie(code)
      .then((resume) => {
        if (!vivant) return
        if (resume.exists) {
          setEtape((e) => (e.nom === 'chargement' ? { nom: 'formulaire' } : e))
          return
        }
        oublierJoueur(code)
        setEtape({ nom: 'inconnu' })
      })
      .catch(() => {
        // Réseau coupé : on ne jette surtout pas dehors un joueur déjà en jeu.
        // Sans session gardée, on montre le formulaire — l'échec sera dit au
        // moment du « C'est parti », avec un message clair et en français.
        if (vivant) setEtape((e) => (e.nom === 'chargement' ? { nom: 'formulaire' } : e))
      })
    return () => {
      vivant = false
    }
  }, [code])

  const surRejoint = useCallback(
    (session: SessionJoueur) => {
      ecrireJoueur(code, session)
      setNomInitial(session.name)
      setEtape({ nom: 'jeu', session })
    },
    [code],
  )

  // Le serveur a refusé le jeton en pleine partie. Deux causes réelles : le
  // maître a retiré le joueur de la liste, ou la session n'existe plus. Dans
  // les deux cas on sort de l'écran mort — jamais un buzzer qui ne répond pas
  // sans dire pourquoi.
  const surJetonRefuse = useCallback(
    (erreur: CodeErreur) => {
      oublierJoueur(code)
      setEtape(erreur === 'GAME_NOT_FOUND' ? { nom: 'inconnu' } : { nom: 'formulaire' })
    },
    [code],
  )

  if (etape.nom === 'chargement') return <Chargement code={code} />

  if (etape.nom === 'inconnu') {
    return (
      <Impasse
        code={code}
        titre="Code inconnu"
        detail={
          <>
            Aucune session «&nbsp;{code}&nbsp;». Le code fait 4 caractères et change à chaque
            soirée&nbsp;: redemande-le au maître du jeu.
          </>
        }
      />
    )
  }

  if (etape.nom === 'pleine') {
    return (
      <Impasse
        code={code}
        titre="Session pleine"
        icone={<span className="font-titre text-3xl leading-none">40/40</span>}
        detail="40 joueurs, c'est le maximum. Demande au maître du jeu d'en retirer un, puis réessaie."
        action={
          <Bouton variante="secondaire" pleineLargeur onClick={() => setEtape({ nom: 'formulaire' })}>
            Réessayer
          </Bouton>
        }
      />
    )
  }

  if (etape.nom === 'jeu') {
    return (
      <EnJeu
        // `key` : changer d'identité (nouveau jeton après une exclusion) remonte
        // tout le temps réel à neuf plutôt que de recycler une socket
        // authentifiée avec l'ancien.
        key={etape.session.playerId}
        code={code}
        session={etape.session}
        onJetonRefuse={surJetonRefuse}
      />
    )
  }

  return (
    <Rejoindre
      code={code}
      nomInitial={nomInitial}
      onRejoint={surRejoint}
      onInconnu={() => setEtape({ nom: 'inconnu' })}
      onPleine={() => setEtape({ nom: 'pleine' })}
    />
  )
}

export default Joueur

// ---------------------------------------------------------------- chargement

function Chargement({ code }: { code: string }) {
  return (
    <div className="ecran">
      <Entete titre="Buzz" legende={<span>{code}</span>} />
      <div className="flex w-full flex-1 items-center justify-center">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-texte2">Connexion…</p>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ impasses

function Impasse({
  code,
  titre,
  detail,
  icone,
  action,
}: {
  code: string
  titre: string
  detail: ReactNode
  icone?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="ecran">
      <Entete titre="Buzz" legende={<span>{code}</span>} />
      <div className="flex w-full flex-1 flex-col items-center justify-center gap-3 py-8">
        <EtatVide
          ton="erreur"
          icone={icone ?? <IconeCroix taille={28} />}
          titre={titre}
          detail={detail}
          action={action}
        />
        {/* Un vrai lien, pas un bouton : il marche même si le routeur n'est pas
            monté, et l'appui long propose « ouvrir dans un nouvel onglet ».
            Une impasse a toujours une sortie. */}
        <a className="bouton bouton--secondaire bouton--pleine max-w-[20rem]" href="/">
          Retour à l'accueil
        </a>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------- rejoindre

function Rejoindre({
  code,
  nomInitial,
  onRejoint,
  onInconnu,
  onPleine,
}: {
  code: string
  nomInitial: string
  onRejoint: (session: SessionJoueur) => void
  onInconnu: () => void
  onPleine: () => void
}) {
  const [nom, setNom] = useState(nomInitial)
  const [envoi, setEnvoi] = useState(false)
  const [erreur, setErreur] = useState<string | null>(null)

  const soumettre = useCallback(
    async (evenement: FormEvent) => {
      evenement.preventDefault()
      // Ce tap est un geste utilisateur : on en profite pour débloquer l'audio
      // iOS tout de suite. Sans ça, le tout premier bip du premier buzz peut
      // être amputé le temps que le contexte sorte de `suspended`.
      prechaufferAudio()

      const propre = nom.trim().replace(/\s+/g, ' ')
      if (propre.length === 0) {
        setErreur('Il faut un prénom pour buzzer.')
        return
      }

      setEnvoi(true)
      setErreur(null)
      try {
        onRejoint(await rejoindrePartie(code, propre))
      } catch (e) {
        setEnvoi(false)
        if (e instanceof ErreurApi) {
          if (e.status === 404) return onInconnu()
          // Session pleine : un refus lisible en français, jamais une chaîne
          // technique et jamais un plantage (§1, limites).
          if (e.status === 409) return onPleine()
          setErreur(e.message)
          return
        }
        setErreur('Impossible de rejoindre pour le moment. Réessaie dans un instant.')
      }
    },
    [code, nom, onInconnu, onPleine, onRejoint],
  )

  return (
    <div className="ecran">
      <Entete titre="Buzz" legende={<span>Session {code}</span>} />

      <form className="flex w-full flex-1 flex-col justify-center gap-5 py-6" onSubmit={soumettre}>
        <div>
          <h2 className="font-titre text-3xl uppercase leading-none tracking-[0.02em] text-texte">
            Ton prénom
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-texte2">
            C'est tout ce qu'on demande. Il s'affichera sur la console du maître du jeu quand tu
            buzzeras.
          </p>
        </div>

        <div>
          <input
            className={`champ ${erreur ? 'champ--erreur' : ''}`}
            id="prenom"
            name="prenom"
            type="text"
            value={nom}
            onChange={(e) => {
              setNom(e.target.value)
              if (erreur) setErreur(null)
            }}
            placeholder="Marie"
            maxLength={24}
            autoComplete="given-name"
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            aria-label="Ton prénom"
            aria-invalid={erreur ? true : undefined}
            aria-describedby={erreur ? 'prenom-erreur' : undefined}
          />
          {erreur ? (
            <p className="champ-message" id="prenom-erreur" role="alert">
              {erreur}
            </p>
          ) : null}
        </div>

        <Bouton type="submit" variante="primaire" taille="grande" pleineLargeur disabled={envoi}>
          {envoi ? 'Un instant…' : "C'est parti"}
        </Bouton>
      </form>

      <p className="pb-2 text-center text-xs leading-relaxed text-texte2">
        Deux «&nbsp;Marie&nbsp;»&nbsp;? Aucun problème, la deuxième devient «&nbsp;Marie (2)&nbsp;».
      </p>
    </div>
  )
}

// -------------------------------------------------------------------- en jeu

function EnJeu({
  code,
  session,
  onJetonRefuse,
}: {
  code: string
  session: SessionJoueur
  onJetonRefuse: (erreur: CodeErreur) => void
}) {
  const rt = useRealtime({ code, role: 'player', token: session.token })

  // L'écran reste allumé toute la soirée, et le verrou est réacquis au retour
  // au premier plan (le navigateur le relâche dès que l'onglet part derrière).
  useWakeLock()

  const [muet, setMuet] = useState(estMuet)
  const [envoye, setEnvoye] = useState(false)
  const [onde, setOnde] = useState(0)

  // Nouvelle manche : l'attente locale repart à zéro en même temps que le
  // buzzer se réarme. Sans ça, « Buzz envoyé… » survivrait à la manche.
  useEffect(() => {
    setEnvoye(false)
  }, [rt.openAt])

  // Jeton refusé (exclusion par le maître, session disparue) : on remonte au
  // parent plutôt que de laisser tourner une reconnexion qui échouera toujours.
  useEffect(() => {
    if (rt.erreur === 'BAD_TOKEN' || rt.erreur === 'GAME_NOT_FOUND') onJetonRefuse(rt.erreur)
  }, [rt.erreur, onJetonRefuse])

  // =====================================================================
  // §3.4 — LE gestionnaire de buzz. L'ordre de ces trois lignes est la
  // fonctionnalité, pas un détail de style.
  //
  // Il est branché sur `pointerdown`, jamais sur `click` : `click` ne part
  // qu'au relâchement du doigt, 80 à 200 ms offerts à l'adversaire. C'est
  // `Buzzer` qui garantit le branchement (`onPointerDown={onBuzz}`, voir
  // `src/ui/Buzzer.tsx`).
  //
  // Et le retour visuel est déjà parti avant même que cette fonction ne
  // s'exécute : `.buzzer:active { transform: scale(0.97) }` est appliqué par
  // le navigateur au pointerdown, sans JS et sans frame d'attente.
  // =====================================================================
  const surBuzz = useCallback(() => {
    const at = rt.maintenant() // 1. horodatage AVANT tout rendu, tout state, tout réseau
    jouerBuzz() // 2. retour sonore local (AudioContext resume() DANS le tap, iOS)
    rt.buzzer(at) // 3. envoi : WS, ou repli POST /buzz avec le MÊME `at` si fermée
    // Tout ce qui suit est cosmétique et n'entre jamais dans le temps mesuré.
    setEnvoye(true)
    setOnde((n) => n + 1)
  }, [rt])

  const surSon = useCallback(() => {
    setMuet(basculerMuet())
  }, [])

  // Compteur de coupure. Le bandeau ne sort qu'au bout de 6 s : un bandeau qui
  // clignote à chaque micro-reconnexion devient du bruit, et on cesse de le
  // lire exactement le soir où il compte.
  const [depuis, setDepuis] = useState(0)
  const debutCoupure = useRef<number | null>(null)
  useEffect(() => {
    if (rt.etat === 'ouvert') {
      debutCoupure.current = null
      setDepuis(0)
      return
    }
    if (debutCoupure.current === null) debutCoupure.current = Date.now()
    const tic = () =>
      setDepuis(Math.round((Date.now() - (debutCoupure.current ?? Date.now())) / 1000))
    tic()
    const id = window.setInterval(tic, 500)
    return () => window.clearInterval(id)
  }, [rt.etat])

  const moi = rt.moi
  // Trois états visuellement incomparables, et un seul à la fois. Priorité à
  // `moi` : une fois qu'il a sa place, un verrou du maître ne doit pas la lui
  // effacer de l'écran.
  const etatBuzzer: EtatBuzzer = moi ? 'buzze' : rt.arme ? 'arme' : 'verrouille'
  const enAttente = envoye && !moi && rt.arme

  return (
    <div className="ecran">
      <Entete
        titre={session.name}
        legende={
          <>
            <PointConnexion etat={rt.etat} avecLibelle />
            <span className="text-bord" aria-hidden="true">
              ·
            </span>
            <span>{code}</span>
          </>
        }
        actions={
          // `onClick` ici, et c'est volontaire : rien de sensible à la latence.
          // Seul le buzz est sur `pointerdown`.
          <button
            type="button"
            className="bouton-icone"
            onClick={surSon}
            aria-pressed={muet}
            aria-label={muet ? 'Réactiver le son du buzzer' : 'Couper le son du buzzer'}
          >
            <IconeSon taille={22} coupe={muet} />
          </button>
        }
      />

      {depuis >= 6 ? (
        <div className="mt-3 w-full">
          <BandeauConnexion etat={rt.etat} depuis={depuis} />
        </div>
      ) : null}

      <div className="relative flex w-full flex-1 items-center justify-center">
        <Buzzer
          etat={etatBuzzer}
          rang={moi?.rank}
          rangTexte={moi ? formatRang(moi.rank) : undefined}
          // SON temps de réaction absolu, jamais un écart au premier : un écart
          // lui apprendrait le temps de quelqu'un d'autre.
          temps={moi ? formatSecondes(moi.ms) : undefined}
          onBuzz={surBuzz}
        />
        {/* Onde de choc locale, tirée au moment du tap. Purement décorative :
            le vrai retour instantané est le `:active` du disque, appliqué par
            le navigateur avant même que le gestionnaire ne tourne. */}
        {onde > 0 ? (
          <span
            key={onde}
            aria-hidden="true"
            className="onde pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={
              {
                width: 'clamp(16.25rem, 74vw, 20.5rem)',
                aspectRatio: '1',
                '--onde-couleur': 'rgb(34 230 255 / 0.55)',
              } as CSSProperties
            }
          />
        ) : null}
      </div>

      {/* Ligne d'état sous le disque. Sa hauteur est réservée en permanence :
          un texte qui apparaît ne doit pas faire sauter le buzzer de 20 px
          sous le doigt du joueur. */}
      <p
        className="flex min-h-6 items-center justify-center pb-1 text-center text-xs font-bold uppercase tracking-[0.16em] text-cyan"
        role="status"
      >
        {enAttente ? 'Buzz envoyé…' : ''}
      </p>
    </div>
  )
}
