import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { QrCode } from '../components/QrCode'
import { resumePartie } from '../lib/api'
import { formatEcart, formatSecondes } from '../lib/format'
import { lireHostToken } from '../lib/storage'
import { useRealtime } from '../lib/useRealtime'
import type { Buzz, Joueur } from '../lib/useRealtime'
import { useWakeLock } from '../lib/wakelock'
import {
  Bandeau,
  BandeauConnexion,
  Bouton,
  BoutonGeant,
  Entete,
  EtatVide,
  IconeCadenas,
  IconeCercle,
  IconeEcran,
  IconePartage,
  LigneBuzz,
  Modale,
  PastilleJoueur,
  PointConnexion,
} from '../ui'

// `/m/:code` — la console du maître du jeu.
//
// Cet écran est utilisé cinquante fois dans la soirée, à une main, dans une
// pièce mal éclairée, par quelqu'un qui a bu un verre. C'est un TÉLÉPHONE, pas
// un tableau de bord : tout ce qui n'aide pas à enchaîner la question suivante
// a été retiré.
//
// Il n'y a que DEUX contrôles, et c'est volontaire :
//   • MANCHE SUIVANTE — efface la liste ET rouvre les buzzers. Géant, collé en
//     bas, dans la zone du pouce. C'est le geste de la soirée.
//   • Le verrou — ferme/rouvre les buzzers SANS effacer la liste. Secondaire,
//     dans l'en-tête, à l'autre bout de l'écran pour qu'on ne l'attrape jamais
//     par erreur en visant le bouton géant.
// Et UN SEUL geste de gestion : appui long sur un nom → confirmation de retrait.
//
// Le maître ne joue pas : il n'y a pas de buzzer ici. Il n'y a pas non plus de
// score, pas de points, pas d'équipes, pas de chrono, et surtout pas de son —
// personne n'a envie d'entendre quinze buzzers depuis sa propre console.

/**
 * Deux MANCHE SUIVANTE à moins d'une demi-seconde d'écart : le second est du
 * bruit. Personne n'enchaîne deux questions en 500 ms, mais un pouce nerveux
 * dans le noir tape volontiers trois fois de suite sur un bouton de 76 px.
 */
const GARDE_MANCHE_MS = 500

/**
 * Durée maximale entre le `pointerdown` et le `click` d'un même appui. Large :
 * un doigt qui reste posé deux secondes sur le bouton produit quand même un
 * `click` au relâchement, et ce `click`-là ne doit pas ouvrir une deuxième
 * manche. Au-delà, on considère que le `click` vient du clavier.
 */
const FENETRE_GESTE_MS = 5000

export function Maitre({ code }: { code: string }) {
  // L'autorité du maître tient au jeton rangé en `localStorage` à la création.
  // Sans lui, le serveur répondra `BAD_TOKEN` : autant le dire tout de suite et
  // clairement plutôt que d'afficher une console qui ne répond à rien.
  const jeton = useMemo(() => lireHostToken(code), [code])
  const [diagnostic, setDiagnostic] = useState<'attente' | 'inconnue' | 'pas-la-tienne'>('attente')

  useEffect(() => {
    if (jeton) return
    let vivant = true
    resumePartie(code)
      .then((r) => {
        if (vivant) setDiagnostic(r.exists ? 'pas-la-tienne' : 'inconnue')
      })
      .catch(() => {
        // Serveur injoignable : on ne peut pas trancher, et accuser à tort
        // « code inconnu » enverrait le maître recréer une session pour rien.
        if (vivant) setDiagnostic('pas-la-tienne')
      })
    return () => {
      vivant = false
    }
  }, [code, jeton])

  if (jeton) return <Console code={code} jeton={jeton} />

  return (
    <div className="ecran justify-center">
      {diagnostic === 'attente' ? (
        <EtatVide titre="Vérification…" detail={`On regarde si la session ${code} existe encore.`} />
      ) : (
        <EtatVide
          ton="erreur"
          icone={<IconeCadenas taille={30} />}
          titre={diagnostic === 'inconnue' ? 'Session introuvable' : 'Ce n’est pas ta console'}
          detail={
            diagnostic === 'inconnue'
              ? `Aucune session « ${code} ». Les sessions sont effacées au bout de 24 h.`
              : `La session « ${code} » existe, mais la console du maître du jeu est ouverte sur un autre téléphone — c’est celui qui a créé la session. Pour jouer, rejoins-la comme joueur.`
          }
          action={
            <Bouton variante="secondaire" pleineLargeur onClick={() => (window.location.href = '/')}>
              Retour à l’accueil
            </Bouton>
          }
        />
      )}
    </div>
  )
}

function Console({ code, jeton }: { code: string; jeton: string }) {
  const rt = useRealtime({ code, role: 'host', token: jeton })

  // L'écran doit rester allumé toute la soirée. Le Wake Lock aide ; il ne fait
  // pas tout, d'où le bandeau permanent plus bas.
  useWakeLock(true)

  const [qrOuvert, setQrOuvert] = useState(false)
  const [aExclure, setAExclure] = useState<Joueur | null>(null)

  const lien = useMemo(() => `${window.location.origin}/${code}`, [code])

  // --- MANCHE SUIVANTE ----------------------------------------------------
  // Deux pièges, deux garde-fous distincts.
  //
  // 1. Le bouton écoute `pointerdown` (le `click` ne part qu'au relâchement du
  //    doigt) MAIS garde `onClick` pour le clavier et les lecteurs d'écran.
  //    Un doigt qui descend puis se relève déclenche donc les DEUX : sans
  //    filtre, une seule pression ouvre deux manches. Un simple délai ne suffit
  //    pas — un appui maintenu 800 ms passerait au travers. On marque donc le
  //    geste : le `click` qui suit un `pointerdown` est avalé, celui qui vient
  //    seul (clavier) passe.
  // 2. Cinq appuis en deux secondes ne doivent produire ni manche fantôme, ni
  //    buzz attribué à la mauvaise manche. Le serveur tranche avec son
  //    `round_id` ; côté client on refuse d'envoyer une rafale.
  const dernierAppui = useRef(0)
  /** Instant du dernier `pointerdown` — 0 quand il a déjà été « consommé ». */
  const viaPointeur = useRef(0)

  const declencher = useCallback(() => {
    const t = Date.now()
    if (t - dernierAppui.current < GARDE_MANCHE_MS) return
    dernierAppui.current = t
    rt.mancheSuivante()
  }, [rt])

  const surPointerDown = useCallback(() => {
    viaPointeur.current = Date.now()
    declencher()
  }, [declencher])

  const surClick = useCallback(() => {
    // Le `click` du même geste, aussi lent qu'ait été le relâchement : avalé,
    // et la marque est consommée pour qu'une validation au clavier juste après
    // ne le soit pas à son tour.
    if (Date.now() - viaPointeur.current < FENETRE_GESTE_MS) {
      viaPointeur.current = 0
      return
    }
    declencher()
  }, [declencher])

  const basculerVerrou = useCallback(() => rt.verrouiller(!rt.locked), [rt])

  const confirmerExclusion = useCallback(() => {
    if (aExclure) rt.exclure(aExclure.id)
    setAExclure(null)
  }, [aExclure, rt])

  // Le serveur peut RÉVISER les rangs : un buzz arrivé en retard mais horodaté
  // plus tôt (4G contre wifi) rétrograde légitimement ceux déjà affichés, et le
  // serveur rediffuse un `state` complet. On repart donc toujours de
  // l'instantané, jamais d'un ajout en fin de liste.
  const liste = useMemo(() => [...rt.buzzes].sort((a, b) => a.rank - b.rank), [rt.buzzes])
  const premier: Buzz | undefined = liste[0]

  // La clé change à chaque manche : sans ça, React réutilise le <li> et
  // l'animation d'arrivée ne rejoue pas — le maître ne verrait plus rien passer
  // du coin de l'œil. `openAt` est l'identifiant naturel de la manche courante.
  const cleManche = rt.openAt ?? 0

  const joueurs = rt.players
  const connectes = joueurs.filter((j) => j.connected).length

  // « Les buzzers sont-ils ouverts ? » — la seule question que le maître se
  // pose. Le verrou n'est qu'une des deux façons de les fermer : avant la
  // première MANCHE SUIVANTE, aucune manche n'est ouverte et personne ne peut
  // buzzer non plus. Afficher « ouvert » à ce moment-là, c'est promettre au
  // premier joueur un buzzer qui ne répondra pas — et c'est une dispute.
  const buzzersOuverts = rt.openAt !== null && !rt.locked

  // Le serveur a refusé le `hello`. Sans message, la console resterait
  // silencieuse et le maître croirait que « rien ne marche ».
  if (rt.erreur === 'BAD_TOKEN' || rt.erreur === 'GAME_NOT_FOUND') {
    const disparue = rt.erreur === 'GAME_NOT_FOUND'
    return (
      <div className="ecran justify-center">
        <EtatVide
          ton="erreur"
          icone={<IconeCadenas taille={30} />}
          titre={disparue ? 'Session expirée' : 'Jeton refusé'}
          detail={
            disparue
              ? `La session « ${code} » n’existe plus — les sessions sont effacées au bout de 24 h. Crée-en une nouvelle, le code changera.`
              : `Le serveur ne reconnaît pas le jeton de cette console. Il a sans doute été créé avant un redémarrage. Crée une nouvelle session.`
          }
          action={
            <Bouton variante="primaire" pleineLargeur onClick={() => (window.location.href = '/')}>
              Retour à l’accueil
            </Bouton>
          }
        />
      </div>
    )
  }

  return (
    // Coquille à hauteur fixe : l'en-tête (donc le verrou) et MANCHE SUIVANTE
    // ne défilent JAMAIS. Sur une liste de douze buzz, un verrou parti hors
    // écran, c'est le maître qui n'a plus de moyen de couper les buzzers
    // pendant qu'il lit une question longue.
    // Les interlignes se resserrent sur les écrans courts (iPhone SE) : c'est
    // la liste des buzz qui doit gagner les pixels, pas les respirations.
    <div className="ecran h-dvh gap-2 overflow-hidden [@media(min-height:700px)]:gap-3">
      <Entete
        code={code}
        legende={
          <>
            {/* Pas de séparateur « · » ici : la légende de la console passe à
                la ligne dès 375 px (le code en gros et les deux boutons d'en-tête
                prennent la largeur), et le point restait alors orphelin en fin
                ou en début de ligne. L'écran joueur, lui, tient sur une ligne
                et garde son séparateur. */}
            <PointConnexion etat={rt.etat} avecLibelle />
            <span>
              {joueurs.length} joueur{joueurs.length > 1 ? 's' : ''}
            </span>
          </>
        }
        actions={
          <>
            <button
              type="button"
              className="bouton-icone"
              onClick={() => setQrOuvert(true)}
              aria-label="Partager la session : QR code et lien"
            >
              <IconePartage taille={22} />
            </button>

            {/* Le verrou est secondaire, mais son état doit se lire en une
                fraction de seconde : cadenas + mot, et un aplat rouge dès que
                c'est fermé. Un cadenas seul se confond dans le noir. */}
            <button
              type="button"
              className="bouton-icone w-auto gap-1.5 px-3"
              aria-pressed={rt.locked}
              onClick={basculerVerrou}
              aria-label={
                rt.locked
                  ? 'Buzzers verrouillés — rouvrir les buzzers'
                  : buzzersOuverts
                    ? 'Buzzers ouverts — fermer les buzzers'
                    : 'Verrou ouvert, aucune manche en cours — fermer les buzzers'
              }
            >
              <IconeCadenas taille={20} ferme={!buzzersOuverts} />
              <span className="text-[0.6875rem] font-extrabold uppercase tracking-[0.1em]">
                {buzzersOuverts ? 'Ouvert' : 'Fermé'}
              </span>
            </button>
          </>
        }
      />

      {/* Le Wake Lock ne survit pas à tout (onglet en arrière-plan, économiseur
          agressif). Le rappel est discret, permanent, et jamais un pop-up. */}
      <Bandeau icone={<IconeEcran taille={18} />}>
        Garde cet écran allumé et cette page au premier plan.
      </Bandeau>

      {rt.etat === 'perdu' ? <BandeauConnexion etat="perdu" /> : null}

      {/* --- Le cœur de l'écran : la liste des buzz ------------------------ */}
      <section
        className={`-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1 ${
          // Liste vide : le message se pose au milieu de la zone, là où l'œil
          // tombe. Dès qu'il y a des lignes, elles repartent du haut — le 1er
          // doit toujours être au même endroit, manche après manche.
          liste.length === 0 ? 'justify-center' : ''
        }`}
        style={{
          overscrollBehavior: 'contain',
          // Même dégradé que la zone des pastilles : sans lui, la ligne du bas
          // est tranchée net au milieu de sa pilule et se lit comme un bug
          // d'affichage plutôt que comme « il y en a d'autres en dessous ».
          // On coupe à 92 % pour ne pas ternir la dernière ligne LISIBLE.
          // (préfixe `-webkit-` obligatoire pour Safari iOS)
          ...(liste.length === 0
            ? null
            : {
                maskImage: 'linear-gradient(to bottom, #000 92%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, #000 92%, transparent 100%)',
              }),
        }}
        aria-label="Ordre des buzz"
      >
        {liste.length === 0 ? (
          rt.openAt === null ? (
            // Aucune manche encore ouverte : les buzzers ne s'arment jamais
            // tout seuls, et un « buzzers ouverts » mensonger ici vaudrait une
            // dispute au premier joueur qui tape dans le vide.
            <EtatVide
              icone={<IconeCadenas taille={30} />}
              titre="Aucune manche ouverte"
              detail="Appuie sur MANCHE SUIVANTE : la liste s’efface et les buzzers s’ouvrent."
            />
          ) : rt.locked ? (
            <EtatVide
              icone={<IconeCadenas taille={30} />}
              titre="Buzzers verrouillés"
              detail="Personne ne peut buzzer. Rouvre avec le cadenas, ou lance la manche suivante."
            />
          ) : (
            <EtatVide
              icone={<IconeCercle taille={30} />}
              titre="Buzzers ouverts"
              detail="Personne n’a encore buzzé. Pose ta question."
            />
          )
        ) : (
          <ul className="flex flex-col gap-2">
            {liste.map((b) => (
              <LigneBuzz
                key={`${cleManche}-${b.playerId}`}
                rang={b.rank}
                nom={b.name}
                // Le 1er porte son temps de réaction depuis l'ouverture ; les
                // suivants portent l'écart au 1er — c'est l'information qui
                // sert vraiment (« le 2e est à 3 dixièmes, ça se discute »).
                temps={b.rank === 1 ? formatSecondes(b.ms) : formatEcart(b.ms - (premier?.ms ?? 0))}
              />
            ))}
          </ul>
        )}
      </section>

      {/* --- Les joueurs connectés ----------------------------------------- */}
      <section className="shrink-0" aria-label="Joueurs connectés">
        {/* Légende sur UNE ligne jusqu'à 320 px : à deux lignes elle coûtait
            16 px à la liste des buzz, qui est le cœur de l'écran (§2). */}
        <p className="mb-1.5 text-[0.625rem] font-bold uppercase tracking-[0.1em] text-texte2">
          {joueurs.length === 0
            ? 'Aucun joueur'
            : `${connectes}/${joueurs.length} en ligne — appui long pour retirer`}
        </p>
        {joueurs.length === 0 ? (
          <p className="text-sm leading-snug text-texte2">
            Fais scanner le QR code, ou dicte le code <span className="font-bold text-cyan">{code}</span>.
          </p>
        ) : (
          // Deux rangées visibles et un tiers de la troisième qui dépasse : la
          // zone ne mange jamais la liste des buzz, et le bord coupé dit
          // qu'il y a du monde en dessous.
          <div
            // 12vh (et non 15) sur les écrans courts : à 320 × 568, la zone des
            // pastilles était PLUS HAUTE que la liste des buzz (121 px contre
            // 112). Le §2 dit l'inverse — la liste est le cœur, les pastilles
            // sont « compactes ».
            className="-mx-1 flex max-h-[min(7.5rem,12vh)] flex-wrap content-start gap-2 overflow-y-auto px-1"
            // Le dégradé de bas de zone dit « ça continue » au lieu de laisser
            // une rangée coupée net, qui se lit comme un bug d'affichage.
            // (le préfixe `-webkit-` reste obligatoire pour Safari iOS, qui est
            // exactement le navigateur du téléphone posé sur la table)
            style={{
              maskImage: 'linear-gradient(to bottom, #000 84%, transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, #000 84%, transparent 100%)',
            }}
          >
            {joueurs.map((j) => (
              <PastilleJoueur
                key={j.id}
                nom={j.name}
                connecte={j.connected}
                // Ceux qui ont buzzé sont grisés ici : leur place est dans la
                // liste au-dessus, les répéter en double brouille la lecture.
                aBuzze={j.hasBuzzed}
                onAppuiLong={() => setAExclure(j)}
              />
            ))}
          </div>
        )}
      </section>

      {/* --- Le geste de la soirée ----------------------------------------- */}
      <BoutonGeant
        onPointerDown={surPointerDown}
        onClick={surClick}
        disabled={rt.etat === 'perdu'}
        aria-label="Manche suivante : effacer la liste et rouvrir les buzzers"
        indice={
          rt.etat === 'perdu' ? (
            <span className="text-rouge">Hors ligne — reconnexion…</span>
          ) : rt.locked ? (
            <span className="text-rouge">Buzzers verrouillés</span>
          ) : rt.openAt === null ? (
            <span>Buzzers fermés — aucune manche</span>
          ) : (
            <span className="text-cyan">Buzzers ouverts</span>
          )
        }
      >
        Manche suivante
      </BoutonGeant>

      <PartageModale
        ouverte={qrOuvert}
        code={code}
        lien={lien}
        onFermer={() => setQrOuvert(false)}
      />

      <Modale
        ouverte={aExclure !== null}
        // Espace fine insécable avant le « ? » : typographie française, et
        // surtout un « ? » qui ne part jamais seul à la ligne suivante.
        titre={`Retirer ${aExclure?.name ?? ''} ?`}
        onFermer={() => setAExclure(null)}
        // Confirmation destructrice : un tap à côté ne doit pas la valider,
        // et fermer par le fond en pleine soirée serait trop facile.
        fermetureParLeFond={false}
        actions={
          <>
            <Bouton variante="danger" pleineLargeur onClick={confirmerExclusion}>
              Retirer
            </Bouton>
            <Bouton variante="secondaire" pleineLargeur onClick={() => setAExclure(null)}>
              Annuler
            </Bouton>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-texte2">
          Il disparaît de la liste et ses buzz de la manche en cours. Il peut revenir en rescannant le
          QR code.
        </p>
      </Modale>
    </div>
  )
}

// --------------------------------------------------------------------------
// Partage : le QR en grand, et un repli qui marche partout.
// `navigator.share` n'existe pas sur tous les navigateurs (Firefox desktop,
// Chrome sous Linux…) : dans ce cas on copie le lien, et on le DIT — un bouton
// qui ne donne aucun retour passe pour cassé.
// --------------------------------------------------------------------------

function PartageModale({
  ouverte,
  code,
  lien,
  onFermer,
}: {
  ouverte: boolean
  code: string
  lien: string
  onFermer: () => void
}) {
  const [copie, setCopie] = useState(false)

  useEffect(() => {
    if (!copie) return
    const t = window.setTimeout(() => setCopie(false), 2200)
    return () => window.clearTimeout(t)
  }, [copie])

  const copier = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(lien)
      setCopie(true)
      return
    } catch {
      /* pas de presse-papier (http non sécurisé, permission refusée) */
    }
    // Repli historique : moche, mais il marche là où l'API moderne est absente.
    const zone = document.createElement('textarea')
    zone.value = lien
    zone.setAttribute('readonly', '')
    zone.style.position = 'fixed'
    zone.style.opacity = '0'
    document.body.appendChild(zone)
    zone.select()
    try {
      setCopie(document.execCommand('copy'))
    } catch {
      setCopie(false)
    }
    document.body.removeChild(zone)
  }, [lien])

  const partager = useCallback(async () => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: `Buzzer — ${code}`, text: `Rejoins la session ${code}`, url: lien })
        return
      } catch {
        // Partage annulé par l'utilisateur : ne rien faire, surtout ne pas
        // enchaîner sur une copie qu'il n'a pas demandée.
        return
      }
    }
    await copier()
  }, [code, copier, lien])

  return (
    <Modale ouverte={ouverte} titre="Rejoindre la session" onFermer={onFermer}>
      <div className="flex flex-col items-center gap-3">
        <QrCode valeur={lien} className="h-auto w-full max-w-[17rem] rounded-xl" />
        <p className="entete-code selectionnable">{code}</p>
        <p className="selectionnable break-all text-center text-sm text-texte2">{lien}</p>
        <div className="mt-1 flex w-full flex-col gap-2">
          <Bouton
            variante="primaire"
            pleineLargeur
            icone={<IconePartage taille={20} />}
            onClick={partager}
          >
            {typeof navigator !== 'undefined' && typeof navigator.share === 'function'
              ? 'Partager le lien'
              : 'Copier le lien'}
          </Bouton>
          <p className="min-h-[1.25rem] text-center text-xs font-bold uppercase tracking-[0.14em] text-cyan">
            {copie ? 'Lien copié' : ' '}
          </p>
        </div>
      </div>
    </Modale>
  )
}
