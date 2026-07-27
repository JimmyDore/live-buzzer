import { describe, expect, it, vi } from 'vitest'

import {
  commander,
  delaiMasquageAlerte,
  DUREE_MIN_ALERTE_MS,
  envoyerSur,
  MESSAGE_COMMANDE_ECHOUEE,
  SOCKET_OUVERTE,
  type SocketEmettrice,
} from './commandes'

// Le scénario que ces tests protègent, et il vaut la soirée entière : le maître
// tape MANCHE SUIVANTE, la socket est morte, et RIEN ne le dit. C'est le P0 —
// la console affichait « CONNECTÉ », le geste partait dans le vide, et le
// maître recommençait en croyant à un bouton mou.

/** `WebSocket` de laboratoire : on choisit son `readyState`, on lit ce qui part. */
function socket(readyState = SOCKET_OUVERTE, quiJette = false): SocketEmettrice & { envoyes: string[] } {
  return {
    readyState,
    envoyes: [] as string[],
    send(donnees: string) {
      if (quiJette) throw new Error('socket morte')
      this.envoyes.push(donnees)
    },
  }
}

/** Les trois `readyState` qui ne sont PAS `OPEN` (CONNECTING, CLOSING, CLOSED). */
const FERMEES = [0, 2, 3]

describe('envoyerSur', () => {
  it('écrit sur une socket ouverte et le confirme', () => {
    const ws = socket()
    expect(envoyerSur(ws, { t: 'next' })).toBe(true)
    expect(ws.envoyes).toEqual(['{"t":"next"}'])
  })

  it('n’écrit rien et renvoie false quand la socket n’est pas OPEN', () => {
    for (const etat of FERMEES) {
      const ws = socket(etat)
      expect(envoyerSur(ws, { t: 'next' })).toBe(false)
      expect(ws.envoyes).toEqual([])
    }
  })

  it('renvoie false sans socket du tout', () => {
    expect(envoyerSur(null, { t: 'next' })).toBe(false)
    expect(envoyerSur(undefined, { t: 'next' })).toBe(false)
  })

  it('renvoie false quand `send` jette sur une socket qui se dit OPEN', () => {
    // Le cas le plus vicieux : `readyState` annonce OPEN, la socket ment.
    const ws = socket(SOCKET_OUVERTE, true)
    expect(envoyerSur(ws, { t: 'next' })).toBe(false)
  })
})

describe('commander', () => {
  it('ne signale rien quand la commande part vraiment', () => {
    const ws = socket()
    const surEchec = vi.fn()
    expect(commander(ws, { t: 'lock', locked: true }, surEchec)).toBe(true)
    expect(surEchec).not.toHaveBeenCalled()
    expect(ws.envoyes).toEqual(['{"t":"lock","locked":true}'])
  })

  it('signale l’échec — exactement une fois — quand rien ne part', () => {
    for (const etat of FERMEES) {
      const surEchec = vi.fn()
      expect(commander(socket(etat), { t: 'next' }, surEchec)).toBe(false)
      expect(surEchec).toHaveBeenCalledTimes(1)
    }
  })

  it('signale aussi l’échec quand il n’y a plus de socket', () => {
    const surEchec = vi.fn()
    expect(commander(null, { t: 'kick', playerId: 'p1' }, surEchec)).toBe(false)
    expect(surEchec).toHaveBeenCalledTimes(1)
  })

  it('ne met JAMAIS la commande en file : rien n’est rejoué à la reconnexion', () => {
    // Régression volontaire : un `next` rejoué après coup ouvrirait une manche
    // fantôme et rouvrirait les buzzers au mauvais moment. On échoue, on le
    // dit, et on n'y revient plus.
    const morte = socket(3)
    const echecs: number[] = []
    expect(commander(morte, { t: 'next' }, () => echecs.push(1))).toBe(false)

    // La socket revient : c'est une AUTRE socket, et elle ne doit rien recevoir
    // tant que le maître n'a pas re-tapé.
    const neuve = socket()
    expect(neuve.envoyes).toEqual([])
    expect(echecs).toHaveLength(1)

    // Le maître re-tape : là, et seulement là, la commande part.
    expect(commander(neuve, { t: 'next' }, () => echecs.push(1))).toBe(true)
    expect(neuve.envoyes).toEqual(['{"t":"next"}'])
    expect(echecs).toHaveLength(1)
  })

  it('les trois commandes de l’hôte gardent leur forme du §4.2', () => {
    const ws = socket()
    const jamais = vi.fn()
    commander(ws, { t: 'next' }, jamais)
    commander(ws, { t: 'lock', locked: false }, jamais)
    commander(ws, { t: 'kick', playerId: 'abc' }, jamais)
    expect(ws.envoyes.map((t) => JSON.parse(t))).toEqual([
      { t: 'next' },
      { t: 'lock', locked: false },
      { t: 'kick', playerId: 'abc' },
    ])
    expect(jamais).not.toHaveBeenCalled()
  })
})

describe('delaiMasquageAlerte', () => {
  it('ne planifie rien tant qu’aucune commande n’a échoué', () => {
    expect(delaiMasquageAlerte(null, true, 10_000)).toBeNull()
    expect(delaiMasquageAlerte(null, false, 10_000)).toBeNull()
  })

  it('garde l’alerte indéfiniment tant que la connexion n’est pas revenue', () => {
    // Le pire scénario du §4.2 : on ne fait pas disparaître le seul message qui
    // dit au maître que son geste s'est perdu.
    expect(delaiMasquageAlerte(1000, false, 1000)).toBeNull()
    expect(delaiMasquageAlerte(1000, false, 1000 + 60_000)).toBeNull()
  })

  it('tient l’affichage un minimum même si la socket revient tout de suite', () => {
    // Reconnexion en 300 ms : sans plancher, personne ne verrait rien.
    expect(delaiMasquageAlerte(1000, true, 1300)).toBe(DUREE_MIN_ALERTE_MS - 300)
    expect(delaiMasquageAlerte(1000, true, 1000)).toBe(DUREE_MIN_ALERTE_MS)
  })

  it('masque dès que le plancher est atteint', () => {
    expect(delaiMasquageAlerte(1000, true, 1000 + DUREE_MIN_ALERTE_MS)).toBe(0)
    expect(delaiMasquageAlerte(1000, true, 1000 + DUREE_MIN_ALERTE_MS + 5000)).toBe(0)
  })

  it('accepte un plancher injecté (réglage fin et tests)', () => {
    expect(delaiMasquageAlerte(0, true, 100, 500)).toBe(400)
    expect(delaiMasquageAlerte(0, true, 500, 500)).toBe(0)
  })

  it('un second échec pendant l’attente repousse le masquage', () => {
    // t=1000 : échec. t=1200 : reconnexion, il reste DUREE-200.
    expect(delaiMasquageAlerte(1000, true, 1200)).toBe(DUREE_MIN_ALERTE_MS - 200)
    // t=3000 : nouvel échec, le compte repart de zéro.
    expect(delaiMasquageAlerte(3000, true, 3200)).toBe(DUREE_MIN_ALERTE_MS - 200)
  })
})

describe('MESSAGE_COMMANDE_ECHOUEE', () => {
  it('est en français, franc, et dit ce qui se passe ensuite', () => {
    // L'UI est intégralement en français (§10), messages d'erreur compris — et
    // celui-ci doit dire les deux choses qui comptent : le geste est perdu, et
    // la machine s'en occupe déjà.
    expect(MESSAGE_COMMANDE_ECHOUEE).toBe('Commande non transmise — reconnexion en cours')
  })
})
