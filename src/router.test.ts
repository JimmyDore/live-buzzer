import { describe, expect, it } from 'vitest'

import { lienJoueur, parseRoute } from './router'

// Le routeur est la seule pièce du front dont une erreur est INVISIBLE en
// développement et FATALE en soirée : un `/m/:code` avalé par la route joueur
// donne un buzzer au maître du jeu et plus aucune console. On teste donc
// l'ordre des règles autant que les règles elles-mêmes.

describe('parseRoute — les trois routes', () => {
  it('sert l\'accueil à la racine', () => {
    expect(parseRoute('/')).toEqual({ nom: 'accueil' })
  })

  it('ouvre la console du maître sur /m/:code, et surtout PAS l\'écran joueur', () => {
    // La régression classique : `/:code` testé avant `/m/:code`. Elle rend la
    // console inatteignable, donc la soirée injouable.
    expect(parseRoute('/m/KJ7M')).toEqual({ nom: 'maitre', code: 'KJ7M' })
    expect(parseRoute('/m/KJ7M').nom).not.toBe('joueur')
  })

  it('ouvre l\'écran joueur sur /:code', () => {
    expect(parseRoute('/KJ7M')).toEqual({ nom: 'joueur', code: 'KJ7M' })
  })

  it('sert la démonstration du design sur /demo, et pas la route joueur', () => {
    expect(parseRoute('/demo')).toEqual({ nom: 'demo' })
    expect(parseRoute('/demo').nom).not.toBe('joueur')
  })
})

describe('parseRoute — normalisation des codes', () => {
  it('remonte le code en MAJUSCULES : un QR recopié à la main arrive en minuscules', () => {
    expect(parseRoute('/kj7m')).toEqual({ nom: 'joueur', code: 'KJ7M' })
    expect(parseRoute('/m/kj7m')).toEqual({ nom: 'maitre', code: 'KJ7M' })
  })

  it('accepte le préfixe /M/ en majuscule : les claviers mobiles capitalisent les URL', () => {
    expect(parseRoute('/M/KJ7M')).toEqual({ nom: 'maitre', code: 'KJ7M' })
  })
})

describe('parseRoute — codes invalides', () => {
  it('refuse un code trop court', () => {
    expect(parseRoute('/KJ7')).toEqual({ nom: 'inconnu' })
  })

  it('refuse un code trop long sans le tronquer en douce', () => {
    // Le piège : `normaliserCode` (saisie clavier) tronque à 4 caractères. Si
    // le routeur faisait pareil, « /KJ7MX » ouvrirait la session « KJ7M » —
    // celle de quelqu'un d'autre.
    expect(parseRoute('/KJ7MX')).toEqual({ nom: 'inconnu' })
  })

  it('refuse les caractères hors alphabet : ni 1 (confondu avec I/L)…', () => {
    expect(parseRoute('/KJ1M')).toEqual({ nom: 'inconnu' })
  })

  it('…ni O (confondu avec 0)', () => {
    expect(parseRoute('/KJ7O')).toEqual({ nom: 'inconnu' })
  })

  it('refuse aussi un code invalide derrière /m/ — pas de passe-droit pour l\'hôte', () => {
    expect(parseRoute('/m/KJ1M')).toEqual({ nom: 'inconnu' })
    expect(parseRoute('/m/KJ7')).toEqual({ nom: 'inconnu' })
    expect(parseRoute('/m/KJ7MX')).toEqual({ nom: 'inconnu' })
  })

  it('refuse un segment vide ou fait d\'espaces', () => {
    expect(parseRoute('/%20%20%20%20')).toEqual({ nom: 'inconnu' })
    expect(parseRoute('/    ')).toEqual({ nom: 'inconnu' })
  })
})

describe('parseRoute — formes d\'URL tordues', () => {
  it('ignore les barres obliques finales', () => {
    expect(parseRoute('/KJ7M/')).toEqual({ nom: 'joueur', code: 'KJ7M' })
    expect(parseRoute('/m/KJ7M/')).toEqual({ nom: 'maitre', code: 'KJ7M' })
    expect(parseRoute('/demo/')).toEqual({ nom: 'demo' })
  })

  it('ignore les barres obliques doublées', () => {
    expect(parseRoute('//KJ7M')).toEqual({ nom: 'joueur', code: 'KJ7M' })
    expect(parseRoute('/m//KJ7M')).toEqual({ nom: 'maitre', code: 'KJ7M' })
  })

  it('sert l\'accueil sur une racine écrite bizarrement', () => {
    expect(parseRoute('')).toEqual({ nom: 'accueil' })
    expect(parseRoute('//')).toEqual({ nom: 'accueil' })
  })

  it('rend « inconnu » sur un chemin profond inconnu', () => {
    expect(parseRoute('/m/KJ7M/reglages')).toEqual({ nom: 'inconnu' })
    expect(parseRoute('/api/games')).toEqual({ nom: 'inconnu' })
    expect(parseRoute('/m')).toEqual({ nom: 'inconnu' })
    expect(parseRoute('/m/')).toEqual({ nom: 'inconnu' })
    expect(parseRoute('/demo/etats')).toEqual({ nom: 'inconnu' })
  })
})

describe('lienJoueur', () => {
  it('produit un lien que notre propre routeur sait relire', () => {
    const lien = lienJoueur('https://buzz.jimmydore.fr', 'kj7m')
    expect(lien).toBe('https://buzz.jimmydore.fr/KJ7M')
    expect(parseRoute(new URL(lien).pathname)).toEqual({ nom: 'joueur', code: 'KJ7M' })
  })

  it('ne double pas la barre oblique quand l\'origine en porte déjà une', () => {
    expect(lienJoueur('https://buzz.jimmydore.fr/', 'KJ7M')).toBe('https://buzz.jimmydore.fr/KJ7M')
  })
})
