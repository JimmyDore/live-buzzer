import { afterEach, describe, expect, it } from 'vitest'

import {
  ecrireHostToken,
  ecrireJoueur,
  ecrireMuet,
  lireHostToken,
  lireJoueur,
  lireMuet,
  oublierHote,
  oublierJoueur,
} from './storage'

// vitest tourne en environnement `node` : il n'y a pas de `localStorage`.
// C'est exactement la condition qu'on veut tester (navigation privée, stockage
// désactivé), et pour le reste on en substitue un faux.

type Cle = 'localStorage'

function poser(faux: Storage | undefined): void {
  const g = globalThis as unknown as Record<Cle, Storage | undefined>
  if (faux === undefined) delete g.localStorage
  else g.localStorage = faux
}

function fauxStockage(): Storage {
  const carte = new Map<string, string>()
  return {
    get length() {
      return carte.size
    },
    clear: () => carte.clear(),
    getItem: (k: string) => carte.get(k) ?? null,
    key: (i: number) => [...carte.keys()][i] ?? null,
    removeItem: (k: string) => void carte.delete(k),
    setItem: (k: string, v: string) => void carte.set(k, String(v)),
  }
}

/** Le cas Safari en navigation privée : l'objet existe, tout lève. */
function stockageQuiLeve(): Storage {
  const boum = () => {
    throw new DOMException('QuotaExceededError')
  }
  return {
    get length(): number {
      return boum()
    },
    clear: boum,
    getItem: boum,
    key: boum,
    removeItem: boum,
    setItem: boum,
  }
}

afterEach(() => poser(undefined))

describe('storage — aller-retour', () => {
  it('rend le jeton hôte tel qu’écrit', () => {
    poser(fauxStockage())
    expect(lireHostToken('KJ7M')).toBeNull()
    ecrireHostToken('KJ7M', 'jeton-hote-123')
    expect(lireHostToken('KJ7M')).toBe('jeton-hote-123')
  })

  it('ne mélange pas deux sessions', () => {
    poser(fauxStockage())
    ecrireHostToken('KJ7M', 'A')
    ecrireHostToken('MN7Q', 'B')
    expect(lireHostToken('KJ7M')).toBe('A')
    expect(lireHostToken('MN7Q')).toBe('B')
  })

  it('normalise la casse du code dans la clé', () => {
    poser(fauxStockage())
    ecrireHostToken('kj7m', 'A')
    expect(lireHostToken('KJ7M')).toBe('A')
  })

  it('rend le joueur tel qu’écrit — prénom et place retrouvés sans rien retaper', () => {
    poser(fauxStockage())
    expect(lireJoueur('KJ7M')).toBeNull()
    ecrireJoueur('KJ7M', { playerId: 'p1', token: 'tk', name: 'Jean-Christophe' })
    expect(lireJoueur('KJ7M')).toEqual({ playerId: 'p1', token: 'tk', name: 'Jean-Christophe' })
  })

  it('oublie sur demande (exclusion par le maître)', () => {
    poser(fauxStockage())
    ecrireJoueur('KJ7M', { playerId: 'p1', token: 'tk', name: 'Marie' })
    ecrireHostToken('KJ7M', 'A')
    oublierJoueur('KJ7M')
    oublierHote('KJ7M')
    expect(lireJoueur('KJ7M')).toBeNull()
    expect(lireHostToken('KJ7M')).toBeNull()
  })

  it('persiste la coupure du son', () => {
    poser(fauxStockage())
    expect(lireMuet()).toBe(false)
    ecrireMuet(true)
    expect(lireMuet()).toBe(true)
    ecrireMuet(false)
    expect(lireMuet()).toBe(false)
  })
})

describe('storage — robustesse', () => {
  it('rend null sur un JSON bricolé à la main', () => {
    const s = fauxStockage()
    poser(s)
    s.setItem('lb:joueur:KJ7M', 'pas du json {')
    expect(lireJoueur('KJ7M')).toBeNull()
  })

  it('rend null sur une forme inattendue', () => {
    const s = fauxStockage()
    poser(s)
    s.setItem('lb:joueur:KJ7M', JSON.stringify({ playerId: 'p1' })) // token manquant
    expect(lireJoueur('KJ7M')).toBeNull()
    s.setItem('lb:joueur:KJ7M', JSON.stringify({ playerId: 1, token: 2, name: 3 }))
    expect(lireJoueur('KJ7M')).toBeNull()
    s.setItem('lb:joueur:KJ7M', JSON.stringify(null))
    expect(lireJoueur('KJ7M')).toBeNull()
    s.setItem('lb:joueur:KJ7M', JSON.stringify([1, 2, 3]))
    expect(lireJoueur('KJ7M')).toBeNull()
  })

  it('dégrade sans lever quand localStorage n’existe pas', () => {
    poser(undefined)
    expect(() => ecrireHostToken('KJ7M', 'A')).not.toThrow()
    expect(() => ecrireJoueur('KJ7M', { playerId: 'p1', token: 'tk', name: 'Marie' })).not.toThrow()
    expect(() => ecrireMuet(true)).not.toThrow()
    expect(() => oublierJoueur('KJ7M')).not.toThrow()
    expect(lireHostToken('KJ7M')).toBeNull()
    expect(lireJoueur('KJ7M')).toBeNull()
    expect(lireMuet()).toBe(false)
  })

  it('dégrade sans lever quand localStorage lève (navigation privée)', () => {
    poser(stockageQuiLeve())
    expect(() => ecrireHostToken('KJ7M', 'A')).not.toThrow()
    expect(() => ecrireJoueur('KJ7M', { playerId: 'p1', token: 'tk', name: 'Marie' })).not.toThrow()
    expect(() => oublierHote('KJ7M')).not.toThrow()
    expect(lireHostToken('KJ7M')).toBeNull()
    expect(lireJoueur('KJ7M')).toBeNull()
    expect(lireMuet()).toBe(false)
  })

  it('refuse d’écrire une identité incomplète', () => {
    const s = fauxStockage()
    poser(s)
    ecrireJoueur('KJ7M', { playerId: '', token: 'tk', name: 'Marie' })
    ecrireHostToken('KJ7M', '')
    expect(lireJoueur('KJ7M')).toBeNull()
    expect(lireHostToken('KJ7M')).toBeNull()
  })
})
