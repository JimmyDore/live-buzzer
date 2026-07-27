import { useState } from 'react'

import { ErreurApi, creerPartie, resumePartie } from '../lib/api'
import { LONGUEUR_CODE } from '../lib/format'
import { ecrireHostToken } from '../lib/storage'
import { naviguer } from '../router'
import { Bouton, BoutonGeant, ChampCode } from '../ui'

// `/` — l'accueil.
//
// Deux actions, rien d'autre (§2). La création est INSTANTANÉE : un tap, pas
// d'options, pas de formulaire, pas d'écran intermédiaire. Tout ce qu'on
// pourrait « configurer » ici a été retiré du produit exprès.
//
// Dans les faits, cet écran n'est vu que par une personne sur seize : les
// autres arrivent par le QR code, directement sur `/:code`. Il est donc taillé
// pour un seul geste — le pouce descend sur le gros bouton cyan — et le champ
// « Rejoindre » n'est là que pour celui dont l'appareil photo n'a pas voulu du
// QR, ou qui a reçu le code par SMS.

type Occupation = null | 'creation' | 'jonction'

export function Accueil() {
  const [code, setCode] = useState('')
  const [erreurCode, setErreurCode] = useState<string | null>(null)
  const [erreurCreation, setErreurCreation] = useState<string | null>(null)
  const [occupation, setOccupation] = useState<Occupation>(null)

  /** Un tap. On crée, on range le jeton d'hôte, on part sur la console. */
  async function creer() {
    if (occupation) return
    setOccupation('creation')
    setErreurCreation(null)
    try {
      const { code: nouveau, hostToken } = await creerPartie()
      // Le jeton AVANT la navigation : la console se monte immédiatement après
      // et le lit tout de suite. Dans l'autre ordre, le maître du jeu arrive
      // sur sa propre session sans les droits dessus.
      ecrireHostToken(nouveau, hostToken)
      naviguer(`/m/${nouveau}`)
    } catch (erreur) {
      setErreurCreation(
        erreur instanceof ErreurApi
          ? erreur.message
          : 'Impossible de créer la session. Vérifie ta connexion, puis réessaie.',
      )
      setOccupation(null)
    }
  }

  /** Rejoindre : on vérifie que la session existe AVANT d'y envoyer quelqu'un. */
  async function rejoindre() {
    if (occupation) return
    if (code.length < LONGUEUR_CODE) {
      // « il en manque 2 », jamais « il en manque 2 caractères » : le « en »
      // porte déjà le complément. Le commanditaire lit le français.
      setErreurCode(
        `Le code fait ${LONGUEUR_CODE} caractères — il en manque ${LONGUEUR_CODE - code.length}.`,
      )
      return
    }
    setOccupation('jonction')
    setErreurCode(null)
    try {
      const { exists } = await resumePartie(code)
      if (!exists) return introuvable()
      naviguer(`/${code}`)
    } catch (erreur) {
      // 404 et `{ exists: false }` disent la même chose : on couvre les deux,
      // parce qu'un code inconnu est de très loin le cas le plus fréquent et
      // qu'il ne doit JAMAIS ressortir en « Erreur serveur (404) ».
      if (erreur instanceof ErreurApi && erreur.status === 404) return introuvable()
      setErreurCode(
        erreur instanceof ErreurApi
          ? erreur.message
          : 'Connexion impossible. Vérifie ton réseau, puis réessaie.',
      )
      setOccupation(null)
    }

    // Dit tout de suite, en toutes lettres, avec le code sous les yeux : dans
    // le noir, on relit son propre écran avant de crier « c'est quoi le code
    // déjà ? » à l'autre bout de la table.
    function introuvable() {
      setErreurCode(`Aucune session au code ${code}. Redemande-le au maître du jeu.`)
      setOccupation(null)
    }
  }

  return (
    <main className="ecran justify-center gap-8 py-6">
      <header className="text-center">
        <p className="text-[0.6875rem] font-bold uppercase tracking-[0.24em] text-magenta">
          Le buzzer de soirée
        </p>
        <h1
          className="titre mt-2 text-cyan"
          style={{
            fontSize: 'clamp(2.75rem, 15vw, 4rem)',
            textShadow: '0 0 34px rgb(34 230 255 / 0.45)',
          }}
        >
          Live buzzer
        </h1>
        <p className="mx-auto mt-3 max-w-[30ch] text-sm leading-relaxed text-texte2">
          Un téléphone posé sur la table, les autres scannent le QR code. Le plus rapide passe en
          tête, les suivants s’empilent derrière.
        </p>
      </header>

      {/* --- Action n°1 : créer. Énorme, cyan, un seul tap. ----------------- */}
      <section>
        <p className="mb-2 text-center text-[0.6875rem] font-bold uppercase tracking-[0.18em] text-texte2">
          Un seul tap — aucune option à régler
        </p>
        <BoutonGeant
          colle={false}
          disabled={occupation !== null}
          onClick={creer}
          aria-label="Créer une session"
        >
          {occupation === 'creation' ? 'Création…' : 'Créer une session'}
        </BoutonGeant>
        {erreurCreation ? (
          <p className="champ-message justify-center text-center" role="alert">
            <span aria-hidden="true">✕</span>
            {erreurCreation}
          </p>
        ) : null}
      </section>

      {/* --- Action n°2 : rejoindre au clavier, faute de QR. ---------------- */}
      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-[color:var(--color-bord-fort)]" />
        <span className="text-[0.6875rem] font-bold uppercase tracking-[0.24em] text-texte2">ou</span>
        <span className="h-px flex-1 bg-[color:var(--color-bord-fort)]" />
      </div>

      <section className="flex flex-col gap-3">
        <ChampCode
          valeur={code}
          onChange={(saisie) => {
            setCode(saisie)
            // L'erreur disparaît dès qu'on retouche le code : la laisser
            // affichée pendant la correction, c'est faire douter quelqu'un qui
            // est en train de bien faire.
            if (erreurCode) setErreurCode(null)
          }}
          onValider={rejoindre}
          erreur={erreurCode}
        />
        <Bouton
          variante="secondaire"
          taille="grande"
          pleineLargeur
          disabled={occupation !== null}
          onClick={rejoindre}
        >
          {occupation === 'jonction' ? 'Vérification…' : 'Rejoindre'}
        </Bouton>
      </section>

      <p className="text-center text-xs leading-relaxed text-texte2">
        Aucun compte, aucun score, aucune équipe. Un prénom suffit.
      </p>
    </main>
  )
}
