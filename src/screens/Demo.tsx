import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { normaliserCode } from '../lib/format'
import {
  Bandeau,
  BandeauConnexion,
  Bouton,
  BoutonGeant,
  Buzzer,
  ChampCode,
  Entete,
  EtatVide,
  IconeCadenas,
  IconeCercle,
  IconeCroix,
  IconeEcran,
  IconePartage,
  LigneBuzz,
  Modale,
  PastilleJoueur,
  PointConnexion,
} from '../ui'

// Page de démonstration du système de design (`/demo`).
//
// Elle n'existe pas pour la soirée : elle existe pour qu'on puisse voir TOUS
// les états côte à côte, sans monter une vraie partie à quinze. C'est ce qui
// permet de comparer « armé » et « verrouillé » sur la même capture, de
// vérifier « Jean-Christophe » à 320 px, et de relire les contrastes.
//
// Rien ici n'est importé par les trois écrans réels.

const DOUZE_BUZZ = [
  { nom: 'Marie', temps: '0,84 s' },
  { nom: 'Jean-Christophe', temps: '+0,31 s' },
  { nom: 'Paul', temps: '+0,44 s' },
  { nom: 'Anne-Sophie', temps: '+0,57 s' },
  { nom: 'Youssef', temps: '+0,63 s' },
  { nom: 'Lou', temps: '+0,78 s' },
  { nom: 'Bertrand', temps: '+0,91 s' },
  { nom: 'Maëlys', temps: '+1,02 s' },
  { nom: 'Théo', temps: '+1,18 s' },
  { nom: 'Farida', temps: '+1,33 s' },
  { nom: 'Guillaume', temps: '+1,49 s' },
  { nom: 'Zoé', temps: '+2,07 s' },
]

const JETONS: Array<{ nom: string; valeur: string; ratio: string }> = [
  { nom: 'fond', valeur: '#07070C', ratio: 'fond' },
  { nom: 'cyan', valeur: '#22E6FF', ratio: '13,24:1' },
  { nom: 'magenta', valeur: '#FF2FB9', ratio: '6,09:1' },
  { nom: 'jaune', valeur: '#FFE14D', ratio: '15,44:1' },
  { nom: 'rouge', valeur: '#FF4D5E', ratio: '6,20:1' },
  { nom: 'texte', valeur: '#F2F4FF', ratio: '18,34:1' },
  { nom: 'texte2', valeur: '#8C93B8', ratio: '6,68:1' },
]

export function Demo() {
  const [code, setCode] = useState('')
  const [qrOuvert, setQrOuvert] = useState(false)
  const [kickOuvert, setKickOuvert] = useState(false)
  const [verrou, setVerrou] = useState(false)
  const [largeur, setLargeur] = useState(0)

  // Repère de largeur : le critique visuel doit shooter à 375 et à 320 px et
  // pouvoir prouver sur la capture qu'il y était.
  useEffect(() => {
    const mesurer = () => setLargeur(window.innerWidth)
    mesurer()
    window.addEventListener('resize', mesurer)
    return () => window.removeEventListener('resize', mesurer)
  }, [])

  return (
    <div className="ecran gap-8 pb-24">
      <header className="pt-2">
        <p className="text-[0.6875rem] font-bold uppercase tracking-[0.22em] text-magenta">
          Système de design
        </p>
        <h1 className="font-titre mt-1 text-4xl uppercase leading-none tracking-[0.02em] text-texte">
          Néon plateau TV
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-texte2">
          Toutes les primitives, dans tous leurs états. Largeur courante&nbsp;:{' '}
          <span className="font-bold text-cyan">{largeur} px</span>.
        </p>
      </header>

      {/* ---------------------------------------------------------------- */}
      <Section titre="Jetons" note="Contraste mesuré sur le fond #07070C (WCAG 2.1).">
        <ul className="flex flex-col gap-1.5">
          {JETONS.map((j) => (
            <li
              key={j.nom}
              className="flex items-center gap-3 rounded-xl border-2 border-bord bg-surface px-3 py-2"
            >
              <span
                className="h-8 w-8 shrink-0 rounded-lg border border-[color:var(--color-bord-fort)]"
                style={{ backgroundColor: j.valeur }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-texte">--color-{j.nom}</span>
                <span className="block text-xs text-texte2">{j.valeur}</span>
              </span>
              <span className="shrink-0 text-xs font-bold text-texte2" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {j.ratio}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-4 rounded-xl border-2 border-bord bg-surface p-3">
          <p className="font-titre text-3xl uppercase leading-none text-cyan">Anton 0123456789</p>
          <p className="mt-2 text-sm leading-relaxed text-texte2">
            Display condensée auto-hébergée pour les chiffres, les rangs et les titres. Pile système
            pour le texte courant, comme celui-ci.
          </p>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section titre="Entête" note="Le code est l'information la plus demandée de la soirée.">
        <Entete
          code="KJ7M"
          legende={
            <>
              <PointConnexion etat="ouvert" avecLibelle />
              <span className="text-bord">·</span>
              <span>12 joueurs</span>
            </>
          }
          actions={
            <>
              <button
                type="button"
                className="bouton-icone"
                onClick={() => setQrOuvert(true)}
                aria-label="Partager la session"
              >
                <IconePartage taille={22} />
              </button>
              <button
                type="button"
                className="bouton-icone"
                aria-pressed={verrou}
                onClick={() => setVerrou((v) => !v)}
                aria-label={verrou ? 'Rouvrir les buzzers' : 'Fermer les buzzers'}
              >
                <IconeCadenas taille={22} ferme={verrou} />
              </button>
            </>
          }
        />
        <div className="mt-4">
          <Entete
            titre="Marie"
            legende={
              <>
                <PointConnexion etat="connexion" avecLibelle />
                <span className="text-bord">·</span>
                <span>KJ7M</span>
              </>
            }
          />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section titre="Boutons" note="48 px minimum, 56 px en taille « grande ». Tous ≥ 44 px.">
        <div className="flex flex-col gap-2.5">
          <Bouton variante="primaire" taille="grande" pleineLargeur>
            Créer une session
          </Bouton>
          <Bouton variante="secondaire" pleineLargeur>
            Rejoindre
          </Bouton>
          <Bouton variante="danger" pleineLargeur>
            Retirer Bertrand
          </Bouton>
          <Bouton variante="primaire" pleineLargeur disabled>
            Désactivé
          </Bouton>
          <div className="flex gap-2">
            <Bouton variante="secondaire">Copier</Bouton>
            <Bouton variante="secondaire">Partager</Bouton>
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section titre="Bouton géant" note="76 px de haut, zone du pouce, safe-area en bas d'écran.">
        <div className="flex flex-col gap-3">
          <BoutonGeant colle={false}>Manche suivante</BoutonGeant>
          <BoutonGeant colle={false} variante="danger">
            Fermer les buzzers
          </BoutonGeant>
          <BoutonGeant colle={false} disabled>
            Manche suivante
          </BoutonGeant>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section titre="Buzzer — armé" note="Halo cyan concentrique, respiration 2 s.">
        <Buzzer etat="arme" onBuzz={() => undefined} />
      </Section>

      <Section titre="Buzzer — verrouillé" note="Éteint, désaturé, sans halo. Aucun doute possible.">
        <Buzzer etat="verrouille" />
      </Section>

      <Section titre="Buzzer — buzzé 1er" note="Jaune, célébratoire, temps de réaction.">
        <Buzzer etat="buzze" rang={1} rangTexte="1er" temps="0,84 s" />
      </Section>

      <Section titre="Buzzer — buzzé 5e" note="Magenta, franc mais pas fêté.">
        <Buzzer etat="buzze" rang={5} rangTexte="5e" temps="+1,12 s" />
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section titre="Liste — vide" note="Jamais un écran blanc : on dit ce qu'on attend.">
        <EtatVide
          icone={<IconeCercle taille={30} />}
          titre="Buzzers ouverts"
          detail="Personne n'a encore buzzé. Pose ta question."
        />
      </Section>

      <Section titre="Liste — une entrée">
        <ul className="flex flex-col gap-2">
          <LigneBuzz rang={1} nom="Marie" temps="0,84 s" />
        </ul>
      </Section>

      <Section
        titre="Liste — douze entrées"
        note="Prénom long « Jean-Christophe » : tronqué proprement, le temps reste lisible."
      >
        <ul className="flex flex-col gap-2">
          {DOUZE_BUZZ.map((b, i) => (
            <LigneBuzz key={b.nom} rang={i + 1} nom={b.nom} temps={b.temps} />
          ))}
        </ul>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        titre="Pastilles joueurs"
        note="Appui long (600 ms) sur une pastille active → confirmation de retrait."
      >
        <div className="flex flex-wrap gap-2">
          <PastilleJoueur nom="Marie" connecte onAppuiLong={() => setKickOuvert(true)} />
          <PastilleJoueur nom="Jean-Christophe" connecte onAppuiLong={() => setKickOuvert(true)} />
          <PastilleJoueur nom="Paul" connecte aBuzze />
          <PastilleJoueur nom="Bertrand" connecte={false} onAppuiLong={() => setKickOuvert(true)} />
          <PastilleJoueur nom="Zoé" connecte aBuzze />
          <PastilleJoueur nom="Anne-Sophie" connecte onAppuiLong={() => setKickOuvert(true)} />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section titre="Connexion" note="Point permanent, bandeau seulement quand ça coupe vraiment.">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <PointConnexion etat="ouvert" avecLibelle />
            <PointConnexion etat="connexion" avecLibelle />
            <PointConnexion etat="perdu" avecLibelle />
          </div>
          <BandeauConnexion etat="connexion" />
          <BandeauConnexion etat="perdu" depuis={14} />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section titre="Bandeau permanent" note="Le rappel qu'on doit pouvoir relire à la 30e question.">
        <Bandeau icone={<IconeEcran taille={18} />}>
          Garde cet écran allumé et cette page au premier plan.
        </Bandeau>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section titre="Champ code" note="Minuscules acceptées, espaces et tirets ignorés.">
        <div className="flex flex-col gap-5">
          <ChampCode valeur={code} onChange={setCode} />
          <ChampCode valeur={normaliserCode('kj-7m')} onChange={() => undefined} />
          <ChampCode
            valeur="KJ7M"
            onChange={() => undefined}
            erreur="Aucune session avec ce code. Redemande-le au maître du jeu."
          />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section titre="Impasses" note="Toujours une sortie, jamais un cul-de-sac.">
        <div className="flex flex-col gap-3">
          <EtatVide
            ton="erreur"
            icone={<IconeCroix taille={28} />}
            titre="Code inconnu"
            detail="Aucune session « KJ7M ». Le code fait 4 caractères et change à chaque soirée."
            action={
              <Bouton variante="secondaire" pleineLargeur>
                Retour à l'accueil
              </Bouton>
            }
          />
          <EtatVide
            ton="erreur"
            icone={<span className="font-titre text-3xl leading-none">40/40</span>}
            titre="Session pleine"
            detail="40 joueurs, c'est le maximum. Demande au maître du jeu d'en retirer un."
            action={
              <Bouton variante="secondaire" pleineLargeur>
                Réessayer
              </Bouton>
            }
          />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section titre="Modales" note="Le QR en grand, et la seule confirmation destructrice du jeu.">
        <div className="flex flex-col gap-2.5">
          <Bouton variante="secondaire" pleineLargeur onClick={() => setQrOuvert(true)}>
            Ouvrir le QR
          </Bouton>
          <Bouton variante="danger" pleineLargeur onClick={() => setKickOuvert(true)}>
            Ouvrir la confirmation
          </Bouton>
        </div>
      </Section>

      <Modale ouverte={qrOuvert} titre="Rejoindre KJ7M" onFermer={() => setQrOuvert(false)}>
        <div className="flex flex-col items-center gap-3">
          <div
            className="grid h-56 w-56 place-items-center rounded-xl bg-white text-xs font-bold text-fond"
            aria-hidden="true"
          >
            QR (agent G)
          </div>
          <p className="entete-code">KJ7M</p>
          <p className="text-center text-sm text-texte2">buzz.jimmydore.fr/KJ7M</p>
        </div>
      </Modale>

      <Modale
        ouverte={kickOuvert}
        titre="Retirer Bertrand\u202f?"
        onFermer={() => setKickOuvert(false)}
        fermetureParLeFond={false}
        actions={
          <>
            <Bouton variante="danger" pleineLargeur onClick={() => setKickOuvert(false)}>
              Retirer
            </Bouton>
            <Bouton variante="secondaire" pleineLargeur onClick={() => setKickOuvert(false)}>
              Annuler
            </Bouton>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-texte2">
          Il disparaît de la liste. Il peut revenir en rescannant le QR code.
        </p>
      </Modale>

      <BoutonGeant indice="Collé en bas, safe-area comprise">Manche suivante</BoutonGeant>
    </div>
  )
}

function Section({ titre, note, children }: { titre: string; note?: string; children: ReactNode }) {
  return (
    <section className="w-full">
      <h2 className="font-titre text-lg uppercase leading-none tracking-[0.1em] text-magenta">
        {titre}
      </h2>
      {note ? <p className="mb-3 mt-1.5 text-xs leading-relaxed text-texte2">{note}</p> : <div className="mb-3" />}
      {children}
    </section>
  )
}
