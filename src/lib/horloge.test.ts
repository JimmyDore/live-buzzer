import { describe, expect, it } from 'vitest'

import {
  calculerEchantillon,
  Horloge,
  meilleurEchantillon,
  RTT_MAX_MS,
  TAILLE_FENETRE,
} from './horloge'

describe('calculerEchantillon', () => {
  it('applique la formule NTP du §3.1', () => {
    // t0=1000, t1=1100 -> rtt=100 ; offset = s + rtt/2 - t1
    const e = calculerEchantillon(1000, 50_000, 1100)
    expect(e).not.toBeNull()
    expect(e!.rtt).toBe(100)
    expect(e!.offset).toBe(50_000 + 50 - 1100)
  })

  it('rejette un RTT supérieur à 1500 ms', () => {
    expect(calculerEchantillon(0, 1000, RTT_MAX_MS)).not.toBeNull()
    expect(calculerEchantillon(0, 1000, RTT_MAX_MS + 0.001)).toBeNull()
    expect(calculerEchantillon(0, 1000, 5000)).toBeNull()
  })

  it('rejette un RTT négatif', () => {
    expect(calculerEchantillon(200, 1000, 100)).toBeNull()
  })

  it('rejette les valeurs non finies', () => {
    expect(calculerEchantillon(Number.NaN, 1000, 100)).toBeNull()
    expect(calculerEchantillon(0, Number.NaN, 100)).toBeNull()
    expect(calculerEchantillon(0, 1000, Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('meilleurEchantillon', () => {
  it('rend le plus faible RTT, pas la moyenne', () => {
    const liste = [
      calculerEchantillon(0, 1000, 400)!,
      calculerEchantillon(0, 1000, 20)!,
      calculerEchantillon(0, 1000, 900)!,
    ]
    expect(meilleurEchantillon(liste)!.rtt).toBe(20)
  })

  it('rend null sur une liste vide', () => {
    expect(meilleurEchantillon([])).toBeNull()
  })
})

describe('Horloge', () => {
  it('sans échantillon : offset 0, pas prête, retombe sur l’horloge locale', () => {
    const h = new Horloge(() => 5000)
    expect(h.pret).toBe(false)
    expect(h.offset).toBe(0)
    expect(h.rtt).toBeNull()
    expect(h.maintenant()).toBe(5000) // dégradation, pas panne
  })

  it('reste non prête si tous les échantillons sont rejetés', () => {
    const h = new Horloge(() => 0)
    expect(h.ajouter(0, 1_000_000, 3000)).toBeNull() // rtt 3000 > 1500
    expect(h.ajouter(0, 1_000_000, Number.NaN)).toBeNull()
    expect(h.pret).toBe(false)
    expect(h.offset).toBe(0)
  })

  it('retient l’échantillon de plus faible RTT et ignore les bruités', () => {
    const h = new Horloge(() => 0)
    // Serveur à 1_000_000. Client parfait : t1 = t0 + rtt, s = 1_000_000 + rtt/2
    // (le serveur répond au milieu de l’aller-retour) -> offset attendu 1_000_000.
    h.ajouter(0, 1_000_000 + 200, 400) // rtt 400, offset exact 1_000_000
    h.ajouter(1000, 1_001_010, 1020) // rtt 20, offset exact 1_000_000
    h.ajouter(2000, 1_002_400, 3200) // rtt 1200, asymétrique : offset faussé (999 800)
    expect(h.rtt).toBe(20)
    expect(h.offset).toBe(1_000_000)
    // La moyenne des trois offsets serait ailleurs : on vérifie qu’on ne
    // moyenne pas.
    const moyenne = h.echantillons.reduce((a, e) => a + e.offset, 0) / h.echantillons.length
    expect(moyenne).not.toBe(h.offset)
  })

  it('ne garde qu’une fenêtre glissante de 8 échantillons', () => {
    const h = new Horloge(() => 0)
    // Le tout premier a le meilleur RTT ; une fois sorti de la fenêtre, il ne
    // doit plus influencer l’offset.
    h.ajouter(0, 1_000_005, 10) // rtt 10 — le meilleur
    expect(h.rtt).toBe(10)
    for (let i = 1; i <= TAILLE_FENETRE - 1; i++) {
      h.ajouter(i * 1000, 1_000_000 + i * 1000 + 100, i * 1000 + 200) // rtt 200
    }
    expect(h.echantillons.length).toBe(TAILLE_FENETRE)
    expect(h.rtt).toBe(10) // encore dans la fenêtre

    h.ajouter(100_000, 1_100_050, 100_100) // rtt 100 -> évince le rtt 10
    expect(h.echantillons.length).toBe(TAILLE_FENETRE)
    expect(h.rtt).toBe(100)
  })

  it('maintenant() = horloge locale + offset retenu', () => {
    let local = 0
    const h = new Horloge(() => local)
    h.ajouter(0, 1_000_100, 200) // rtt 200, offset = 1_000_100 + 100 - 200
    const offset = 1_000_100 + 100 - 200
    local = 500
    expect(h.maintenant()).toBe(500 + offset)
  })

  it('reinitialiser() ramène à l’état dégradé', () => {
    const h = new Horloge(() => 0)
    h.ajouter(0, 1_000_000, 100)
    expect(h.pret).toBe(true)
    h.reinitialiser()
    expect(h.pret).toBe(false)
    expect(h.offset).toBe(0)
    expect(h.echantillons.length).toBe(0)
  })
})
