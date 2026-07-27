import { describe, expect, it } from 'vitest'

import { ALPHABET, estCodeValide, formatEcart, formatRang, formatSecondes, normaliserCode } from './format'

describe('formatSecondes', () => {
  it('rend la valeur figée du contrat', () => {
    expect(formatSecondes(842)).toBe('0,84 s')
  })

  it('utilise la virgule française, jamais le point', () => {
    expect(formatSecondes(1234)).toBe('1,23 s')
    expect(formatSecondes(1234)).not.toContain('.')
  })

  it('garde deux décimales même quand elles sont nulles', () => {
    expect(formatSecondes(0)).toBe('0,00 s')
    expect(formatSecondes(2000)).toBe('2,00 s')
  })

  it('arrondit à la milliseconde près', () => {
    expect(formatSecondes(845)).toBe('0,85 s') // 0.845 -> 0.85
    expect(formatSecondes(844)).toBe('0,84 s')
  })

  it('ne rend jamais NaN à l’écran', () => {
    expect(formatSecondes(Number.NaN)).toBe('—')
    expect(formatSecondes(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('formatEcart', () => {
  it('rend la valeur figée du contrat', () => {
    expect(formatEcart(310)).toBe('+0,31 s')
  })

  it('affiche toujours le signe, y compris à zéro', () => {
    expect(formatEcart(0)).toBe('+0,00 s')
  })

  it('gère un écart négatif (reclassement en vol) sans mentir', () => {
    expect(formatEcart(-40)).toBe('-0,04 s')
  })

  it('ne rend jamais NaN à l’écran', () => {
    expect(formatEcart(Number.NaN)).toBe('—')
  })
})

describe('formatRang', () => {
  it('rend les ordinaux français figés du contrat', () => {
    expect(formatRang(1)).toBe('1er')
    expect(formatRang(2)).toBe('2e')
    expect(formatRang(3)).toBe('3e')
  })

  it('ne bascule pas en « 21er » au-delà de 20', () => {
    expect(formatRang(11)).toBe('11e')
    expect(formatRang(21)).toBe('21e')
    expect(formatRang(40)).toBe('40e')
  })

  it('ne rend jamais NaN à l’écran', () => {
    expect(formatRang(Number.NaN)).toBe('—')
  })
})

describe('normaliserCode', () => {
  it('met en majuscules', () => {
    expect(normaliserCode('kj7m')).toBe('KJ7M')
  })

  it('ignore les espaces et les tirets', () => {
    expect(normaliserCode('kj 7m')).toBe('KJ7M')
    expect(normaliserCode('KJ-7M')).toBe('KJ7M')
    expect(normaliserCode('  k j 7 m  ')).toBe('KJ7M')
  })

  it('écarte les caractères hors alphabet plutôt que de refuser la saisie', () => {
    // I, O, S, B, L, Z, 0, 1, 2, 5, 8 sont des confusables : hors alphabet.
    expect(normaliserCode('KI0J')).toBe('KJ')
    expect(normaliserCode('ZBSLO')).toBe('')
    expect(normaliserCode('!!!')).toBe('')
    expect(normaliserCode('ébé')).toBe('')
  })

  it('tronque à 4 caractères', () => {
    expect(normaliserCode('ACDEFGH')).toBe('ACDE')
    expect(normaliserCode('a c d e f')).toBe('ACDE')
  })

  it('accepte une saisie vide', () => {
    expect(normaliserCode('')).toBe('')
  })

  // Régression : `ChampCode` portait un `maxLength={4}` qui tronquait la
  // saisie BRUTE avant d'arriver ici. Un code collé depuis un SMS (« kj 7m »,
  // 5 caractères) était coupé en « kj 7 » et devenait « KJ7 » — la saisie
  // tolérante du §2 échouait précisément sur le cas où elle sert. La longueur
  // n'est bornée QU'APRÈS le filtrage, et nulle part ailleurs.
  it('encaisse une saisie plus longue que 4 caractères une fois les séparateurs retirés', () => {
    expect(normaliserCode('kj 7m')).toBe('KJ7M') // 5 caractères bruts
    expect(normaliserCode('kj-7m')).toBe('KJ7M')
    expect(normaliserCode('k j - 7 m')).toBe('KJ7M') // 9 caractères bruts
    expect(normaliserCode('  KJ7M  ')).toBe('KJ7M')
    expect(normaliserCode('kj‑7m')).toBe('KJ7M') // tiret insécable d'un SMS
  })

  it('est idempotente sur tout l’alphabet', () => {
    for (const c of ALPHABET) {
      expect(normaliserCode(c.toLowerCase())).toBe(c)
    }
  })
})

describe('estCodeValide', () => {
  it('exige 4 caractères tous dans l’alphabet', () => {
    expect(estCodeValide('KJ7M')).toBe(true)
    expect(estCodeValide('KJ7')).toBe(false)
    expect(estCodeValide('KJ7MM')).toBe(false)
    expect(estCodeValide('kj7m')).toBe(false) // déjà normalisé attendu
    expect(estCodeValide('KI7M')).toBe(false) // I hors alphabet
    expect(estCodeValide('ZW4P')).toBe(false) // Z hors alphabet (confusable 2)
  })
})
