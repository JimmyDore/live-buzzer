import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

// Le QR code est l'objet le plus regardé des trente premières secondes d'une
// soirée : quinze personnes le scannent de travers, à un mètre, dans une pièce
// mal éclairée, sur un téléphone tenu par quelqu'un d'autre.
//
// Rendu en SVG plutôt qu'en canvas : net à toutes les tailles, aucun flou de
// rééchantillonnage, et il s'imprime bien si quelqu'un veut le coller au mur.
// Correction 'M' : assez robuste pour un écran un peu sale, sans gonfler la
// densité au point de gêner la lecture à distance.
//
// Le fond est BLANC PUR et la zone de silence est respectée (4 modules) : sur
// un fond sombre ou avec une marge trop courte, beaucoup d'appareils Android
// refusent tout simplement de décoder. C'est le seul endroit du jeu où le noir
// n'a pas sa place.

export interface ProprietesQrCode {
  /** L'URL à encoder, telle quelle. */
  valeur: string
  /** Côté en pixels CSS. Le SVG reste net quelle que soit la valeur. */
  taille?: number
  className?: string
}

/** Zone de silence exigée par la spécification QR : 4 modules, pas moins. */
const MARGE = 4

export function QrCode({ valeur, taille = 260, className }: ProprietesQrCode) {
  const { chemin, modules } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(valeur)
    qr.make()
    const n = qr.getModuleCount()

    // Un seul `<path>` de carrés 1×1 : quelques centaines de sous-chemins
    // valent toujours mieux que quelques centaines de nœuds SVG.
    let d = ''
    for (let ligne = 0; ligne < n; ligne++) {
      for (let col = 0; col < n; col++) {
        if (qr.isDark(ligne, col)) d += `M${col} ${ligne}h1v1h-1z`
      }
    }
    return { chemin: d, modules: n }
  }, [valeur])

  const cote = modules + MARGE * 2

  return (
    <svg
      viewBox={`0 0 ${cote} ${cote}`}
      width={taille}
      height={taille}
      role="img"
      aria-label={`QR code vers ${valeur}`}
      className={className}
      // Sans `crispEdges`, l'antialiasing bave sur les modules et les lecteurs
      // les plus lents décrochent sur un écran un peu incliné.
      shapeRendering="crispEdges"
    >
      <rect width={cote} height={cote} fill="#ffffff" />
      <g transform={`translate(${MARGE} ${MARGE})`} fill="#07070c">
        <path d={chemin} />
      </g>
    </svg>
  )
}
