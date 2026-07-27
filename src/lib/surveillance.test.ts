import { describe, expect, it } from 'vitest'

import {
  DELAI_REPONSE_SYNC_MS,
  SONDES_SANS_REPONSE_MAX,
  SurveillanceSync,
} from './surveillance'

// Le scénario que ces tests protègent : le téléphone passe en mode avion, la
// socket reste `OPEN` pour le navigateur, et personne ne prévient le joueur.
// Ce qu'on mesure ici, c'est le DÉLAI DE VERDICT — il doit rester sous 8 s en
// partant d'une cadence de sync à 5 s.

/**
 * Rejoue la boucle de `useRealtime` avec un réseau MORT à l'instant 0 : sonde,
 * expiration, re-sonde, verdict.
 * @returns le délai entre la coupure et le verdict « perdu », en ms.
 */
function delaiDeVerdict(prochainSync: number): number | null {
  const s = new SurveillanceSync()
  let t = prochainSync
  s.surSyncEnvoye(t)
  for (let pas = 0; pas < 60; pas++) {
    t += DELAI_REPONSE_SYNC_MS
    const action = s.evaluer(t)
    if (action === 'perdu') return t
    if (action === 'sonder') s.surSyncEnvoye(t)
  }
  return null
}

describe('SurveillanceSync', () => {
  it('ne dit rien tant qu’aucune sonde n’attend', () => {
    const s = new SurveillanceSync()
    expect(s.evaluer(0)).toBe('rien')
    expect(s.evaluer(60_000)).toBe('rien')
    expect(s.enAttente).toBe(false)
  })

  it('ne dit rien avant l’expiration de la sonde', () => {
    const s = new SurveillanceSync()
    s.surSyncEnvoye(1000)
    expect(s.evaluer(1000)).toBe('rien')
    expect(s.evaluer(1000 + DELAI_REPONSE_SYNC_MS - 1)).toBe('rien')
    expect(s.sondesRatees).toBe(0)
  })

  it('re-sonde sur silence, puis déclare perdu à la 3e sonde muette', () => {
    const s = new SurveillanceSync()
    s.surSyncEnvoye(0)
    expect(s.evaluer(1000)).toBe('sonder')
    s.surSyncEnvoye(1000)
    expect(s.evaluer(2000)).toBe('sonder')
    s.surSyncEnvoye(2000)
    expect(s.evaluer(3000)).toBe('perdu')
    expect(s.sondesRatees).toBe(SONDES_SANS_REPONSE_MAX)
  })

  it('ne compte qu’un raté par sonde, même interrogée en boucle', () => {
    const s = new SurveillanceSync()
    s.surSyncEnvoye(0)
    expect(s.evaluer(1000)).toBe('sonder')
    // Sans nouvelle sonde envoyée, les évaluations suivantes ne comptent rien :
    // sinon un simple `setInterval` déclarerait « perdu » en deux tours.
    expect(s.evaluer(1001)).toBe('rien')
    expect(s.evaluer(9999)).toBe('rien')
    expect(s.sondesRatees).toBe(1)
  })

  it('UN paquet perdu ne déclenche RIEN (pas de faux positif)', () => {
    const s = new SurveillanceSync()
    s.surSyncEnvoye(0)
    expect(s.evaluer(1000)).toBe('sonder') // réponse perdue
    s.surSyncEnvoye(1000)
    s.surMessageRecu() // la sonde suivante répond
    expect(s.sondesRatees).toBe(0)
    expect(s.evaluer(5000)).toBe('rien')
  })

  it('deux paquets perdus d’affilée ne suffisent pas non plus', () => {
    const s = new SurveillanceSync()
    s.surSyncEnvoye(0)
    expect(s.evaluer(1000)).toBe('sonder')
    s.surSyncEnvoye(1000)
    expect(s.evaluer(2000)).toBe('sonder')
    s.surSyncEnvoye(2000)
    s.surMessageRecu()
    expect(s.sondesRatees).toBe(0)
  })

  it('n’importe quel message du serveur (state, buzz…) prouve la vie', () => {
    const s = new SurveillanceSync()
    s.surSyncEnvoye(0)
    expect(s.evaluer(1000)).toBe('sonder')
    s.surSyncEnvoye(1000)
    // Un `state` arrive à 1,5 s, pas une réponse de sync : ça compte quand même.
    s.surMessageRecu()
    expect(s.enAttente).toBe(false)
    expect(s.sondesRatees).toBe(0)
  })

  it('un aller-retour lent (1,2 s) ne déclare jamais la connexion perdue', () => {
    // RTT constant de 1200 ms : chaque sonde expire AVANT sa réponse, mais la
    // réponse arrive toujours et remet le compteur à zéro.
    const s = new SurveillanceSync()
    let t = 0
    for (let i = 0; i < 50; i++) {
      s.surSyncEnvoye(t)
      expect(s.evaluer(t + 1000)).toBe('sonder') // sonde expirée…
      s.surSyncEnvoye(t + 1000)
      s.surMessageRecu() // …mais la réponse au sync précédent arrive à t+1200
      expect(s.sondesRatees).toBe(0)
      t += 5000
    }
  })

  it('rend son verdict en 8 s au pire, ~5,5 s au cas moyen', () => {
    // Pire cas : le réseau meurt juste après une réponse, il faut attendre les
    // 5 s de la cadence lente avant même la première sonde.
    expect(delaiDeVerdict(5000)).toBe(8000)
    // Cas moyen : coupure à mi-chemin entre deux syncs.
    expect(delaiDeVerdict(2500)).toBe(5500)
    // Meilleur cas : coupure juste avant un sync.
    expect(delaiDeVerdict(0)).toBe(3000)
    // Dans tous les cas, loin sous les ~15 s observés avant le correctif et
    // sous la coupure de liveness serveur à 20 s.
    for (const prochainSync of [0, 1000, 2500, 4000, 5000]) {
      const delai = delaiDeVerdict(prochainSync)
      expect(delai).not.toBeNull()
      expect(delai as number).toBeLessThanOrEqual(8000)
    }
  })

  it('ne rend aucun verdict tant que le serveur répond', () => {
    // Deux minutes de cadence lente avec une réponse à chaque fois : le
    // bandeau ne doit jamais s'allumer sur une connexion saine.
    const s = new SurveillanceSync()
    for (let t = 0; t < 120_000; t += 5000) {
      s.surSyncEnvoye(t)
      s.surMessageRecu() // réponse ~40 ms plus tard
      expect(s.evaluer(t + 4999)).toBe('rien')
    }
    expect(s.sondesRatees).toBe(0)
  })

  it('se réarme proprement après une reconnexion', () => {
    const s = new SurveillanceSync()
    s.surSyncEnvoye(0)
    s.evaluer(1000)
    s.surSyncEnvoye(1000)
    s.evaluer(2000)
    expect(s.sondesRatees).toBe(2)
    s.reinitialiser()
    expect(s.sondesRatees).toBe(0)
    expect(s.enAttente).toBe(false)
    expect(s.evaluer(99_999)).toBe('rien')
  })

  it('accepte des seuils injectés (tests et réglages fins)', () => {
    const s = new SurveillanceSync({ delaiReponseMs: 200, sondesMax: 2 })
    s.surSyncEnvoye(0)
    expect(s.evaluer(199)).toBe('rien')
    expect(s.evaluer(200)).toBe('sonder')
    s.surSyncEnvoye(200)
    expect(s.evaluer(400)).toBe('perdu')
  })
})
