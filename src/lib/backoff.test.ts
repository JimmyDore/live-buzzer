import { describe, expect, it } from 'vitest'

import { DELAI_MAX_MS, DELAI_MIN_MS, GIGUE, delaiBackoff } from './backoff'

const SANS_GIGUE = () => 0.5

describe('delaiBackoff', () => {
  it('croît en doublant, de 250 ms à 4 s', () => {
    expect(delaiBackoff(0, SANS_GIGUE)).toBe(250)
    expect(delaiBackoff(1, SANS_GIGUE)).toBe(500)
    expect(delaiBackoff(2, SANS_GIGUE)).toBe(1000)
    expect(delaiBackoff(3, SANS_GIGUE)).toBe(2000)
    expect(delaiBackoff(4, SANS_GIGUE)).toBe(4000)
  })

  it('plafonne à 4 s et n’y remonte jamais au-dessus', () => {
    for (const essai of [4, 5, 8, 20, 1000]) {
      expect(delaiBackoff(essai, SANS_GIGUE)).toBe(DELAI_MAX_MS)
      expect(delaiBackoff(essai, () => 1)).toBeLessThanOrEqual(DELAI_MAX_MS)
    }
  })

  it('reste dans [250, 4000] quelle que soit la gigue, à l’infini', () => {
    for (let essai = 0; essai < 40; essai++) {
      for (const alea of [() => 0, () => 0.5, () => 1, Math.random]) {
        const d = delaiBackoff(essai, alea)
        expect(d).toBeGreaterThanOrEqual(DELAI_MIN_MS)
        expect(d).toBeLessThanOrEqual(DELAI_MAX_MS)
      }
    }
  })

  it('la croissance est monotone à gigue constante', () => {
    let precedent = 0
    for (let essai = 0; essai < 12; essai++) {
      const d = delaiBackoff(essai, SANS_GIGUE)
      expect(d).toBeGreaterThanOrEqual(precedent)
      precedent = d
    }
  })

  it('la gigue existe : deux tirages donnent des délais différents', () => {
    const bas = delaiBackoff(3, () => 0)
    const haut = delaiBackoff(3, () => 1)
    expect(bas).not.toBe(haut)
    expect(bas).toBeLessThan(haut)
  })

  it('la gigue est bornée à ±20 % du délai nominal', () => {
    for (const essai of [1, 2, 3]) {
      const nominal = delaiBackoff(essai, SANS_GIGUE)
      expect(delaiBackoff(essai, () => 0)).toBe(Math.round(nominal * (1 - GIGUE)))
      expect(delaiBackoff(essai, () => 1)).toBe(Math.round(nominal * (1 + GIGUE)))
    }
  })

  it('quinze téléphones qui reviennent ne retombent pas sur la même ms', () => {
    // essai 3 : plage [1600, 2400], soit 800 entiers possibles et aucun
    // écrêtage. Quinze tirages qui s'y regrouperaient sur moins de six valeurs
    // sont statistiquement impossibles : la gigue n'est pas décorative.
    const tirages = new Set(Array.from({ length: 15 }, () => delaiBackoff(3)))
    expect(tirages.size).toBeGreaterThan(5)
  })

  it('encaisse une entrée absurde sans rendre NaN', () => {
    expect(delaiBackoff(Number.NaN, SANS_GIGUE)).toBe(250)
    expect(delaiBackoff(-3, SANS_GIGUE)).toBe(250)
    expect(delaiBackoff(2, () => Number.NaN)).toBe(1000)
  })
})
