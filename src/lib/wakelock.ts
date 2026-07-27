import { useEffect } from 'react'

// Wake Lock API (§5, non négociables mobiles). L'écran du maître du jeu doit
// rester allumé toute la soirée ; celui du joueur aussi, sinon il rate une
// question à rallumer son téléphone.
//
// Deux subtilités qui font toute la différence :
//  - le verrou est AUTOMATIQUEMENT relâché par le navigateur dès que l'onglet
//    passe en arrière-plan. Sans réacquisition au retour au premier plan, il
//    ne tient qu'une fois, et personne ne s'en aperçoit avant la vraie soirée ;
//  - l'API n'existe pas partout (iOS < 16.4, Firefox mobile). Tout est
//    enveloppé : là où elle manque, on ne fait rien, on ne casse rien, et le
//    bandeau « garde cet écran allumé » fait le reste.

/** Ce qu'on utilise du sentinel, sans dépendre de la version de lib.dom. */
interface Sentinelle {
  released: boolean
  release(): Promise<void>
}

interface NavigateurAvecWakeLock {
  wakeLock?: { request(type: 'screen'): Promise<Sentinelle> }
}

export function wakeLockDisponible(): boolean {
  return typeof navigator !== 'undefined' && Boolean((navigator as NavigateurAvecWakeLock).wakeLock)
}

/** Demande un verrou d'écran. Rend `null` si indisponible ou refusé. */
export async function demanderWakeLock(): Promise<Sentinelle | null> {
  const api = (navigator as NavigateurAvecWakeLock).wakeLock
  if (!api) return null
  try {
    return await api.request('screen')
  } catch {
    // Refusé (batterie faible, onglet caché au moment de la demande) : ce n'est
    // pas une erreur d'application.
    return null
  }
}

/**
 * Maintient l'écran allumé tant que `actif` est vrai ET que la page est au
 * premier plan. Réacquiert au retour de l'arrière-plan.
 */
export function useWakeLock(actif = true): void {
  useEffect(() => {
    if (!actif || !wakeLockDisponible()) return

    let vivant = true
    let sentinelle: Sentinelle | null = null

    const acquerir = async () => {
      if (!vivant || document.visibilityState !== 'visible') return
      if (sentinelle && !sentinelle.released) return
      sentinelle = await demanderWakeLock()
      // Démonté pendant l'await : on relâche tout de suite, sinon l'écran reste
      // allumé après avoir quitté l'écran de jeu.
      if (!vivant) void sentinelle?.release().catch(() => {})
    }

    const surVisibilite = () => {
      if (document.visibilityState === 'visible') void acquerir()
    }

    void acquerir()
    document.addEventListener('visibilitychange', surVisibilite)

    return () => {
      vivant = false
      document.removeEventListener('visibilitychange', surVisibilite)
      void sentinelle?.release().catch(() => {})
      sentinelle = null
    }
  }, [actif])
}
