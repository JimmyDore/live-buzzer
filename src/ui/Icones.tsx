import type { ReactNode, SVGProps } from 'react'

// Jeu d'icônes minimal, dessiné au trait, `currentColor` partout.
//
// Pas d'emoji dans l'interface : sur iOS ils arrivent en couleurs Apple, sur
// Android en couleurs Google, et dans les deux cas ils crèvent la palette
// néon avec un orange ou un bleu qui ne vient de nulle part. Un trait de 2 px
// prend la couleur du contexte et reste lisible dans le noir.

type ProprietesIcone = Omit<SVGProps<SVGSVGElement>, 'children'> & { taille?: number }

function Trace({ taille = 24, children, ...reste }: ProprietesIcone & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={taille}
      height={taille}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...reste}
    >
      {children}
    </svg>
  )
}

export function IconeCadenas({ ferme = true, ...reste }: ProprietesIcone & { ferme?: boolean }) {
  return (
    <Trace {...reste}>
      <rect x="4" y="10.5" width="16" height="10.5" rx="2.5" />
      {/* L'anse bascule à droite quand c'est ouvert : la différence se voit de
          loin, contrairement à deux cadenas qui ne diffèrent que d'un pixel. */}
      <path d={ferme ? 'M8 10.5V7.5a4 4 0 0 1 8 0v3' : 'M8 10.5V7.5a4 4 0 0 1 8 0'} />
    </Trace>
  )
}

export function IconePartage(props: ProprietesIcone) {
  return (
    <Trace {...props}>
      <path d="M12 3v12" />
      <path d="M8 7l4-4 4 4" />
      <path d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" />
    </Trace>
  )
}

export function IconeSon({ coupe = false, ...reste }: ProprietesIcone & { coupe?: boolean }) {
  return (
    <Trace {...reste}>
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
      {coupe ? <path d="M16 9.5l5 5M21 9.5l-5 5" /> : <path d="M16 9a4.5 4.5 0 0 1 0 6" />}
    </Trace>
  )
}

export function IconeCroix(props: ProprietesIcone) {
  return (
    <Trace {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Trace>
  )
}

export function IconeEclair(props: ProprietesIcone) {
  return (
    <Trace {...props}>
      <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" />
    </Trace>
  )
}

export function IconeCercle(props: ProprietesIcone) {
  return (
    <Trace {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
    </Trace>
  )
}

export function IconeEcran(props: ProprietesIcone) {
  return (
    <Trace {...props}>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 20.5h8" />
    </Trace>
  )
}
