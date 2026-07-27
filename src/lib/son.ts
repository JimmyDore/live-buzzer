import { ecrireMuet, lireMuet } from './storage'

// Le son du buzz (§5). Généré à la Web Audio API : zéro octet à télécharger,
// zéro latence de chargement, et surtout aucun risque qu'un mp3 arrive après
// le premier buzz sur le wifi d'une salle des fêtes.
//
// Il ne joue QUE sur le téléphone du joueur qui buzze. Pas sur la console du
// maître (il n'a pas envie d'entendre quinze buzzers), pas de vibration.
//
// ⚠️ iOS Safari : un `AudioContext` créé hors d'un geste utilisateur naît
// `suspended` et n'en sort jamais. `jouerBuzz()` est donc conçue pour être
// appelée DEPUIS le gestionnaire `pointerdown` — elle y crée le contexte et le
// `resume()`. C'est la seule façon d'avoir du son au tout premier buzz, sans
// écran de déblocage préalable.

const DUREE_S = 0.12
const FREQ_DEPART = 880
const FREQ_ARRIVEE = 330

let ctx: AudioContext | null = null
let muet: boolean | null = null

type FabriqueAudioContext = typeof AudioContext

function fabrique(): FabriqueAudioContext | null {
  const w = globalThis as unknown as {
    AudioContext?: FabriqueAudioContext
    webkitAudioContext?: FabriqueAudioContext
  }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

export function estMuet(): boolean {
  if (muet === null) muet = lireMuet()
  return muet
}

export function reglerMuet(valeur: boolean): void {
  muet = valeur
  ecrireMuet(valeur)
}

/** Bascule et persiste. Rend le nouvel état. */
export function basculerMuet(): boolean {
  reglerMuet(!estMuet())
  return estMuet()
}

/**
 * Un « bip » court et sec, ~120 ms : oscillateur carré qui descend de 880 à
 * 330 Hz, enveloppe attaque quasi nulle / décroissance exponentielle. Franc,
 * audible dans une pièce bruyante, et fini avant qu'on ait le temps de le
 * trouver long.
 *
 * À appeler EN SYNCHRONE depuis le gestionnaire `pointerdown`. Ne lève jamais :
 * un téléphone sans audio ne doit pas empêcher un buzz de partir.
 */
export function jouerBuzz(): void {
  if (estMuet()) return
  try {
    const Fabrique = fabrique()
    if (!Fabrique) return
    if (ctx === null) ctx = new Fabrique()
    // `resume()` doit être appelé dans le geste : sur iOS c'est ici, et nulle
    // part ailleurs, que le contexte se débloque.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})

    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'square'
    osc.frequency.setValueAtTime(FREQ_DEPART, t)
    osc.frequency.exponentialRampToValueAtTime(FREQ_ARRIVEE, t + DUREE_S)

    // Attaque en 4 ms plutôt qu'instantanée : un saut de gain produit un clic
    // qui, sur un haut-parleur de téléphone, s'entend plus que la note.
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + DUREE_S)

    osc.connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + DUREE_S + 0.02)
    osc.onended = () => {
      try {
        osc.disconnect()
        gain.disconnect()
      } catch {
        /* déjà déconnecté */
      }
    }
  } catch {
    /* pas d'audio sur cet appareil : ce n'est pas une raison de casser le buzz */
  }
}

/**
 * Débloque l'audio sans jouer de son, depuis n'importe quel geste (le tap
 * « C'est parti » par exemple). Optionnel : `jouerBuzz()` se débloque toute
 * seule, mais le faire à l'inscription évite le tout premier bip amputé.
 */
export function prechaufferAudio(): void {
  try {
    const Fabrique = fabrique()
    if (!Fabrique) return
    if (ctx === null) ctx = new Fabrique()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  } catch {
    /* rien à faire */
  }
}
