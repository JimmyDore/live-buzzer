# live-buzzer — brief de build complet

> Ce document est un **prompt**. Il contient tout ce qu'il faut pour construire le
> projet de bout en bout, sans revenir poser de questions. Toutes les décisions
> produit ont déjà été tranchées avec le commanditaire — elles sont fermes.
> Ce qui reste, c'est de l'exécution : construire, vérifier, déployer.

---

## 0. Mission

Construire et **mettre en ligne** un système de buzzer multijoueur en temps réel,
utilisable en soirée réelle depuis des téléphones, à l'adresse
**https://buzz.jimmydore.fr**.

C'est une reprise de [buzzin.live](https://buzzin.live/host), **en français**,
**mieux dessinée**, et **radicalement plus simple** : là où l'original empile
points, équipes, chronos et modes de manche, celui-ci ne fait qu'une chose et la
fait parfaitement.

L'objectif n'est pas « du code qui compile ». L'objectif est : **une bande de
potes pose un téléphone sur la table, quinze personnes scannent un QR code, et
on joue au quiz toute la soirée sans qu'un seul buzz se perde.** Un bug ce
soir-là ne se debug pas — il tue la soirée. Construis en conséquence.

**Tout est mobile-first.** Console du maître du jeu comprise. Personne n'est sur
un ordinateur. Cible : **375 px de large**, utilisation à une main, dans une
pièce mal éclairée, par quelqu'un qui a bu un verre.

**Fan out des sous-agents** sur chaque chantier (§8), et fais **relire chaque
chantier par un sous-agent critique distinct et impitoyable**. Boucle tant que le
critique n'est pas convaincu. Un critique qui valide du premier coup un travail
non testé n'a pas fait son travail : exige des preuves (sortie de commande,
screenshot, code HTTP), jamais des affirmations.

**Ne t'arrête pas** tant que la Definition of Done (§9) n'est pas intégralement
vérifiée, preuve à l'appui, en production.

---

## 1. Le produit

### La boucle

1. Le **maître du jeu** ouvre le site et crée une session. Il obtient un **code à
   4 caractères** et un **QR code**.
2. Les joueurs scannent le QR (ou tapent le code), saisissent un prénom, et
   voient **un buzzer plein écran**. Rien d'autre.
3. Le maître du jeu pose sa question **à voix haute**. L'app ne contient aucune
   question, aucun contenu de quiz.
4. Les joueurs buzzent. La console du maître affiche **la liste ordonnée** de qui
   a buzzé, avec le temps de réaction du premier et l'écart des suivants.
5. Le premier répond. S'il se plante, le maître passe au deuxième — la liste est
   déjà là, il n'a rien à relancer.
6. Le maître appuie sur **MANCHE SUIVANTE** : la liste s'efface, les buzzers se
   rouvrent. Question suivante.

### Règles fermes — ne pas réinterpréter

- **Le premier buzz ne verrouille personne.** Tout le monde continue à pouvoir
  buzzer, la liste se remplit dans l'ordre : 1er, 2e, 3e… C'est ce qui permet
  d'enchaîner sur le suivant sans relancer une manche.
- **Un joueur ne buzze qu'une fois par manche.** Un second appui ne change pas sa
  position et n'ajoute pas de ligne.
- **Aucun contenu de quiz.** Pas de questions, pas de réponses, pas de catégories.
  L'app est un buzzer, pas un jeu. Le contenu est dans la tête du maître du jeu.
- **Aucun score, aucun point, aucune équipe, aucun chrono, aucune manche
  numérotée.** Le commanditaire a explicitement retiré tout cela du périmètre.
  Si tu te surprends à construire un compteur de points, tu as dérivé.
- **Aucun compte, aucun mot de passe, aucun email.** Un prénom suffit.
- Le **maître du jeu ne joue pas** : pas de buzzer sur sa console.

### Les deux seuls contrôles du maître du jeu

| Contrôle | Effet | Place dans l'UI |
|---|---|---|
| **MANCHE SUIVANTE** | Efface la liste **et** ouvre les buzzers | Bouton géant, pleine largeur, bas d'écran, atteignable au pouce |
| **Verrou** | Ferme / rouvre les buzzers **sans** effacer la liste | Bascule secondaire (cadenas) dans l'en-tête |

Le verrou est indispensable — le maître doit pouvoir couper les buzzers pendant
qu'il lit une question longue, ou pendant qu'on débat d'une réponse. Mais il est
**secondaire** : le geste de la soirée, celui qu'on fait cinquante fois, c'est
MANCHE SUIVANTE, et il doit être impossible à rater dans le noir.

L'état **OUVERT / VERROUILLÉ** doit être lisible en une fraction de seconde, des
deux côtés — sur la console **et** sur le téléphone du joueur. Un joueur qui
ignore que les buzzers sont fermés et qui tape dans le vide, c'est une dispute.

### Le seul geste de gestion admis

Le maître peut **retirer un joueur** de la liste (appui long sur son nom →
confirmation). C'est la seule affordance de gestion qui existe, et elle existe
parce qu'un joueur fantôme qui a fermé son navigateur pollue la liste toute la
soirée. **N'en ajoute aucune autre.**

### Limites

- **40 joueurs** par session (refus explicite et lisible au-delà, jamais un
  plantage). Le serveur tient 100, la limite produit est à 40.
- Une session est **purgée au bout de 24 h**.
- Codes à 4 caractères, alphabet sans confusables :
  `ACDEFGHJKMNPQRTUVWXY346789` (ni `I`/`1`/`L`, ni `O`/`0`, ni `S`/`5`, ni
  `B`/`8` ensemble, ni `Z`/`2`).

---

## 2. Les trois écrans

### `/` — Accueil

Deux actions, rien d'autre :

- **« Créer une session »** — bouton primaire, énorme.
- **« Rejoindre »** — un champ de 4 caractères (`inputmode="text"`,
  `autocapitalize="characters"`, saisie tolérante : minuscules acceptées, espaces
  ignorés) + bouton.

La création est instantanée : pas d'options, pas de formulaire, pas d'écran
intermédiaire. Créer une session prend **un tap**.

### `/m/:code` — Console du maître du jeu (son téléphone)

De haut en bas :

1. **En-tête** : le code en gros, un bouton « Partager » (QR code plein écran en
   modale + `navigator.share` de l'URL si disponible, sinon copie dans le
   presse-papier), la bascule **verrou**, et un point d'état de connexion.
2. **La liste des buzz** — c'est le cœur de l'écran, elle occupe la majorité de
   la hauteur.
   - `1` en jaune, énorme, avec le **temps de réaction** (`0,84 s`) depuis
     l'ouverture des buzzers.
   - `2`, `3`, … en magenta, avec l'**écart au premier** (`+0,31 s`).
   - Une nouvelle ligne arrive avec une animation courte et franche (~150 ms),
     jamais un fondu mou. Le maître doit voir arriver le buzz du coin de l'œil.
   - Liste vide = état d'attente explicite (« Buzzers ouverts — personne n'a
     encore buzzé »), jamais un écran blanc.
3. **Les joueurs connectés** : pastilles compactes avec un indicateur de
   connexion. Ceux qui ont buzzé sont grisés dans cette zone (leur place est dans
   la liste au-dessus).
4. **MANCHE SUIVANTE** : bouton géant, collé en bas, dans la zone du pouce, au
   moins 72 px de haut, hors de portée accidentelle du verrou.

Un bandeau discret et permanent : **« Garde cet écran allumé et cette page au
premier plan. »** (le Wake Lock aide, il ne fait pas tout).

### `/:code` — Joueur

Deux états seulement.

**Avant de rejoindre** : un champ prénom, un bouton « C'est parti ». Si le code
n'existe pas, le dire tout de suite et clairement, avec un lien de retour.

**En jeu** : le **buzzer**, et rien d'autre.

- Un disque qui occupe l'essentiel de l'écran (≥ 260 px), centré, avec un halo
  concentrique qui respire quand il est armé.
- **Trois états visuellement incomparables** :
  - *armé* — cyan, halo pulsant, invitant ;
  - *verrouillé* — éteint, désaturé, mention « Buzzers fermés » ;
  - *buzzé* — sa position en **énorme** (`1er`, `2e`, `3e`…) et son temps de
    réaction en petit. Le `1er` a un traitement à part, jaune, célébratoire.
- Le joueur ne voit **jamais** la liste des autres. Seulement sa position.
- En haut, minuscule : son prénom, le code, un point d'état de connexion.

---

## 3. Le cœur technique : la correction de latence

**C'est la fonctionnalité qui distingue ce produit d'un `<button>` branché sur un
POST.** Deux joueurs buzzent à 30 ms d'écart ; l'un est en 4G, l'autre en wifi.
**C'est le doigt le plus rapide qui doit gagner, pas la meilleure connexion.**
Traite ce chapitre comme une spécification, pas comme une suggestion.

### 3.1 Synchronisation d'horloge (façon NTP)

Sur le canal applicatif (messages JSON dans des trames texte — **pas** les trames
de contrôle ping/pong WebSocket, que le navigateur n'expose pas) :

```
client → {"t":"sync","c":<t0>}                 t0 = performance.now() du client
serveur→ {"t":"sync","c":<t0>,"s":<serverNow>} serverNow = Date.now() du serveur
client :  t1  = performance.now()
          rtt = t1 - t0
          offset = s + rtt/2 - t1        // à ajouter à performance.now() du client
```

- **5 échantillons rapides** à la connexion (100 ms d'intervalle), puis **1 toutes
  les 5 s** (ce qui sert aussi de heartbeat de liveness).
- On retient **l'échantillon de plus faible RTT** parmi les 8 derniers — pas la
  moyenne. Un RTT bas est un RTT peu bruité ; la moyenne, elle, intègre le bruit.
- Rejeter les échantillons de RTT > 1500 ms.
- Si aucun échantillon n'est encore valide, `offset = 0` et on retombe sur
  l'horodatage serveur. Dégradation, pas panne.

### 3.2 Ouverture programmée des buzzers

Synchroniser les horloges ne suffit pas : la diffusion de « buzzers ouverts »
n'arrive pas au même instant chez tout le monde. Un joueur qui la reçoit 120 ms
plus tard part avec 120 ms de retard, correction d'horloge ou pas.

Donc : **l'ouverture est datée dans le futur.**

```
serveur → tous : {"t":"open","at":<serverNow + 300>}
```

Chaque client arme son buzzer localement quand `performance.now() + offset >= at`
(un `setTimeout` sur le délai calculé). 300 ms d'avance couvrent largement une
diffusion sur un wifi de salon ; c'est invisible à l'usage, et c'est ce qui rend
les temps de réaction **comparables entre eux**.

Le temps de réaction affiché est **relatif à `at`**, jamais à l'arrivée du message.

### 3.3 Horodatage du buzz et garde anti-triche

```
client → {"t":"buzz","at":<performance.now() + offset>}
```

Le serveur ne fait pas confiance à ce chiffre. Il le **borne** :

```js
const effectif = Math.min(Math.max(at, manche.openAt), recuA)
// recuA = Date.now() au moment de la réception
```

- Borne basse `openAt` : personne ne peut avoir buzzé avant l'ouverture.
- Borne haute `recuA` : personne ne peut avoir buzzé après que le paquet soit
  arrivé (la vraie émission a même eu lieu ~rtt/2 plus tôt).

Un client hostile qui envoie `at = 0` se retrouve mécaniquement à `openAt`, donc
premier — c'est la seule triche possible, elle demande d'ouvrir la console sur son
téléphone en pleine soirée, et **on l'accepte** : la triche est un problème
social, pas logiciel. Ne construis **aucun** anti-triche au-delà de ce bornage.

Quand un buzz est borné (`at` hors intervalle), **journalise-le côté serveur**.
C'est le seul moyen de diagnostiquer une dérive d'horloge après coup.

### 3.4 Latence côté client — les détails qui coûtent 300 ms

Ce sont des erreurs classiques ; chacune ruine à elle seule la correction de
latence ci-dessus.

- Écouter **`pointerdown`**, jamais `click`. `click` ne part qu'au relâchement du
  doigt : 80 à 200 ms offerts à l'adversaire.
- `touch-action: manipulation` et une balise viewport sans zoom sur le buzzer,
  sinon Safari attend 300 ms pour distinguer un double-tap.
- Horodater **à la première ligne du gestionnaire**, avant tout rendu, tout state
  React, tout appel réseau.
- **Retour visuel et sonore immédiats et locaux** : le buzzer réagit avant que le
  moindre paquet ne parte. On ne fait jamais attendre le réseau à un doigt.
- **`socket.setNoDelay(true)`** côté serveur. L'algorithme de Nagle peut retenir
  une petite trame jusqu'à 40 ms. Non négociable.
- Si la WebSocket n'est pas `OPEN` au moment du buzz : **replier immédiatement sur
  `POST /api/games/:code/buzz`** avec le même `at`. Un buzz ne se perd jamais
  parce qu'une socket était en train de se reconnecter.

---

## 4. Architecture technique

Le commanditaire a trois jeux déjà en prod sur ce VPS. **Épouse leurs
conventions**, ne réinvente rien. Lis `/Users/jimmydore/Projets/music-bingo` en
entier avant de commencer — c'est le modèle le plus proche, et son `README.md` et
son `PROMPT.md` disent explicitement pourquoi chaque choix a été fait.

### Front — calqué sur `music-bingo`

Vite · **React 19** · TypeScript · **Tailwind 4**. Tests **vitest**.
Routeur : un mini-routeur maison (~40 lignes), pas React Router. Le projet a
trois routes. QR code via `qrcode-generator` (déjà éprouvé sur music-bingo).

Attention à l'ordre des routes : `/m/:code` doit être testé **avant** `/:code`.

### Back — Node 22, **zéro dépendance npm**

`node:http` pour le serveur, `node:crypto` pour le handshake WebSocket,
`node:sqlite` (`DatabaseSync`) pour la base. Tests via `node --test`.

C'est une contrainte esthétique assumée du commanditaire, pas une suggestion :
**`server/package.json` ne doit avoir aucun champ `dependencies`.** Cela vaut
aussi pour la WebSocket : **pas de paquet `ws`**.

### 4.1 WebSocket écrite à la main — spécification

C'est la partie la plus risquée du projet. **Confie-la à un sous-agent dédié, avec
sa propre suite de tests unitaires, et fais-la relire par un critique distinct.**

**Handshake** (RFC 6455), sur l'événement `upgrade` de `node:http` :

```js
import { createHash } from 'node:crypto'
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B39'
const accept = createHash('sha1')
  .update(req.headers['sec-websocket-key'] + GUID).digest('base64')
socket.write(
  'HTTP/1.1 101 Switching Protocols\r\n' +
  'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
  `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
socket.setNoDelay(true)
```

**Ne jamais renvoyer d'en-tête `Sec-WebSocket-Extensions`.** Ne pas négocier
`permessage-deflate` : le navigateur s'en passe très bien, et l'implémenter
doublerait la surface de bug pour compresser des messages de 60 octets.

**Trames à décoder** — le navigateur masque toujours ses trames :

| Champ | Détail |
|---|---|
| Octet 0 | `FIN` (bit 7), `opcode` (bits 0-3) |
| Octet 1 | `MASK` (bit 7, **toujours 1** depuis un navigateur), `len` (bits 0-6) |
| Longueur étendue | `len == 126` → 2 octets big-endian · `len == 127` → 8 octets |
| Masque | 4 octets, puis `payload[i] ^= mask[i % 4]` |

Opcodes à gérer : `0x0` continuation, `0x1` texte, `0x8` close (répondre puis
fermer), `0x9` ping (répondre `0xA` avec le même payload), `0xA` pong.
Les trames binaires (`0x2`) sont refusées.

**À l'émission** : trames serveur **non masquées**, opcode `0x1`, longueur
encodée sur 7 / 7+16 / 7+64 bits selon la taille.

**Pièges à couvrir par des tests, pas par de l'espoir :**

- Une trame peut arriver **fragmentée sur plusieurs paquets TCP** : accumuler dans
  un buffer et ne consommer que des trames complètes.
- Plusieurs trames peuvent arriver **dans un seul paquet** : boucler.
- Une trame texte peut être **fragmentée en continuation** (`FIN=0` puis opcode
  `0x0`) : réassembler. Rare depuis un navigateur, obligatoire quand même.
- Payload > 125 octets (`len == 126`) : c'est le cas de l'instantané d'état à 40
  joueurs. **Teste explicitement la frontière 125 / 126 / 65 535 / 65 536.**
- Backpressure : si `socket.write` renvoie `false`, ne pas empiler indéfiniment ;
  au-delà d'un seuil, fermer la connexion — un client mort ne doit pas faire
  gonfler la mémoire du serveur.
- Timeout de liveness : pas de message applicatif reçu depuis 20 s → connexion
  considérée morte, joueur marqué déconnecté.

### 4.2 Protocole applicatif (JSON en trames texte)

**Client → serveur**

```jsonc
{"t":"hello","role":"host"|"player","code":"ZK4P","token":"…"}
{"t":"sync","c":123456.7}
{"t":"buzz","at":1753630000123}
{"t":"next"}                                   // hôte : efface + ouvre
{"t":"lock","locked":true}                     // hôte : verrou seul
{"t":"kick","playerId":"…"}                    // hôte
```

**Serveur → client**

```jsonc
{"t":"state","locked":false,"openAt":…,"players":[…],"buzzes":[…]}  // instantané complet
{"t":"open","at":1753630000456}
{"t":"buzz","playerId":"…","name":"Marie","rank":1,"ms":842}
{"t":"lock","locked":true}
{"t":"sync","c":…,"s":…}
{"t":"players","players":[…]}
{"t":"error","code":"GAME_NOT_FOUND"|"GAME_FULL"|"BAD_TOKEN"|"NAME_TAKEN"}
```

**Règle d'or : à chaque `hello` (donc à chaque reconnexion), le serveur renvoie un
`state` complet.** Jamais de reprise incrémentale, jamais de « on reprend où on en
était ». La reconnexion doit être bête et infaillible : le client jette tout et
adopte l'instantané. C'est la même philosophie que le polling de music-bingo, pour
la même raison — un téléphone en soirée change de réseau, se met en veille,
change de pièce.

**Reconnexion client** : backoff exponentiel 250 ms → 4 s avec gigue, infini,
plus une tentative immédiate sur `visibilitychange` (retour au premier plan) et
sur l'événement `online`. L'état de connexion est **visible en permanence** dans
l'UI : un point vert / orange / rouge, et un bandeau franc en cas de coupure
prolongée. Une déconnexion silencieuse est le pire scénario possible.

### 4.3 API HTTP (le strict minimum)

La WebSocket porte le jeu. L'HTTP ne sert qu'à créer, à rejoindre, et à secourir.

```
POST /api/games                  → { code, hostToken }
GET  /api/games/:code            → { exists, locked, playerCount }
POST /api/games/:code/players    → { playerId, token, name }
POST /api/games/:code/buzz       → { rank, ms }      (secours si WS fermée)
GET  /api/health                 → { ok: true }
```

### 4.4 Schéma SQLite

```
games(code PK, host_token, locked, open_at, round_id, created_at)
players(id PK, game_code, name, token, connected, joined_at)
buzzes(game_code, round_id, player_id, at_ms, rank, PRIMARY KEY(game_code, round_id, player_id))
```

La clé primaire composite de `buzzes` **est** la règle « un buzz par joueur par
manche » : un `INSERT` en doublon échoue, et c'est très bien.

`round_id` s'incrémente à chaque MANCHE SUIVANTE. Les buzz des manches passées ne
sont jamais affichés — ils restent en base parce que les supprimer coûterait plus
cher que les garder 24 h.

La vérité chaude vit **en mémoire** (une `Map` de sessions) ; SQLite est le filet
qui permet à une soirée de survivre à un redéploiement ou à un `docker restart`.
Au démarrage, le serveur recharge les sessions de moins de 24 h. Purge horaire.

### 4.5 Identité

Un token aléatoire par joueur, un pour l'hôte, rendus à la création et gardés en
`localStorage`. Aucun compte. Le token hôte est le seul garde-fou sur `next`,
`lock` et `kick` — **un joueur ne doit jamais pouvoir déverrouiller les buzzers ni
effacer la liste.** Un joueur qui rouvre l'URL de sa session retrouve sa place et
son prénom sans rien retaper.

Deux joueurs qui saisissent le même prénom : accepté (« Marie » et « Marie (2) »),
jamais un refus. On ne bloque pas une soirée sur une homonymie.

---

## 5. Design — néon plateau TV

**Un rendu Tailwind par défaut, gris et centré, est un échec.** C'est un jeu de
fête, pas un back-office. Le repère de qualité : est-ce que ça tient la
comparaison avec un jeu de soirée soigné du commerce ?

### Direction validée

Fond très sombre, accents **cyan** et **magenta** électriques, typographie
condensée massive, halo lumineux sur le buzzer. Ambiance plateau de quiz télé.

```
████████████████████
█  BUZZ  ·  ZK4P   █
█                  █
█   ╭──────────╮   █
█  │ ((( ● ))) │   █   ← halo cyan pulsant
█  │  BUZZ !   │   █
█   ╰──────────╯   █
█                  █
█ ▸1  MARIE  0.84s █   ← jaune
█  2  PAUL  +0.31s █   ← magenta
████████████████████
```

### Jetons

| | |
|---|---|
| Fond | `#07070C`, avec un dégradé radial très sombre pour éviter l'aplat mort |
| Cyan (armé, actions) | `#22E6FF` |
| Magenta (buzz, rangs 2+) | `#FF2FB9` |
| Jaune (1er, victoire) | `#FFE14D` |
| Rouge (verrouillé, erreur) | `#FF4D5E` |
| Texte | blanc cassé `#F2F4FF`, secondaire `#8C93B8` |

Halo = superposition de plusieurs `box-shadow` de rayons croissants, pas un seul
flou mou. Animation de respiration ~2 s sur le buzzer armé.

### Typographie

Une display condensée massive pour les chiffres, les rangs et les titres ; la
pile système pour le texte courant. **Auto-hébergée en `woff2` dans `public/fonts`,
jamais un CDN Google Fonts** : le wifi d'une salle des fêtes est mauvais, et une
police qui n'arrive pas décale toute la mise en page au pire moment. `font-display:
swap` et une métrique de repli proche.

### Non négociables mobiles

- Pas de scroll horizontal entre **320 px** et 430 px. Vérifié, pas supposé.
- Zones tactiles ≥ 44 px, aucune mine antipersonnel à côté de MANCHE SUIVANTE.
- `env(safe-area-inset-*)` respecté : le bouton du bas ne passe pas sous la barre
  d'accueil de l'iPhone.
- `-webkit-tap-highlight-color: transparent`, `user-select: none`,
  `overscroll-behavior: none` (le pull-to-refresh en plein buzz est fatal).
- **Wake Lock API** sur les deux rôles, réacquis au retour au premier plan.
- Contraste **WCAG AA** sur tout texte, y compris le néon sur fond noir.
- `prefers-reduced-motion` : les animations tombent, les états restent lisibles.
- **`prefers-color-scheme` ignoré** : le jeu est sombre, point. Pas de thème clair.
- Un `manifest.webmanifest` + icônes + `apple-mobile-web-app-capable`, pour que
  l'ajout à l'écran d'accueil donne quelque chose de propre.

### Son

**Un son court sur le téléphone du joueur qui buzze, et uniquement là.** Pas de son
sur la console de l'hôte (il n'a pas envie d'entendre quinze buzzers), pas de
vibration.

Généré à la **Web Audio API** (oscillateur + enveloppe courte, ~120 ms), pas un
fichier : zéro octet à télécharger, zéro latence de chargement. `AudioContext`
créé **et repris (`resume()`) à l'intérieur du gestionnaire de tap** — c'est la
seule façon dont iOS Safari autorise le son. Un bouton de coupure du son
persisté en `localStorage`.

---

## 6. Infra & déploiement

Cible : VPS Hetzner, `root@77.42.23.215`, déjà en service. Accès SSH root
fonctionnel depuis cette machine, vérifié.

### État actuel du VPS (constaté, pas supposé)

```
ravetycoon-caddy-1   caddy:2-alpine   ← TLS + reverse-proxy partagé
ravetycoon-web-1 / ravetycoon-api-1
socialcircle-web
mppstats-web
musicbingo-web / musicbingo-api
```

Toutes les stacks sont sur le réseau Docker externe **`ravetycoon_default`** et
**ne publient aucun port**.

### Ce qu'il faut créer

- Deux conteneurs : **`livebuzzer-web`** (nginx : SPA + proxy `/api` et `/ws`) et
  **`livebuzzer-api`** (volume `/data` pour le SQLite).
- ⚠️ **Ne jamais nommer un service `web` ni `api`** : ces alias DNS appartiennent
  déjà à RaveTycoon sur le réseau partagé. Le piège a déjà coûté un incident.
- Route Caddy :
  ```
  buzz.jimmydore.fr {
      reverse_proxy livebuzzer-web:80
  }
  ```
  Caddy 2 gère l'`Upgrade` WebSocket nativement : **rien de spécial à configurer
  de ce côté.**

### ⚠️ Piège n°1 — nginx et la WebSocket

nginx, lui, **coupe** l'upgrade par défaut. Sans ce bloc, tout marche en local et
rien ne marche en prod :

```nginx
location /ws {
    proxy_pass http://livebuzzer-api:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
}
```

Plus `tcp_nodelay on;` — le pendant nginx de `setNoDelay`, même raison, mêmes
40 ms en jeu.

### ⚠️ Piège n°2 — le Caddyfile vit dans le dépôt RaveTycoon

`/root/ravetycoon/deploy/Caddyfile` est **monté depuis le dépôt RaveTycoon**. Une
route ajoutée à la main sur le VPS disparaît au prochain déploiement de
RaveTycoon. Ajoute donc la route `buzz` **aux deux endroits** :

- sur le serveur : `/root/ravetycoon/deploy/Caddyfile`, puis rechargement de Caddy ;
- dans le dépôt : `/Users/jimmydore/Projets/RaveTycoon/deploy/Caddyfile`, committé
  et poussé.

À l'heure d'écriture les deux fichiers sont **identiques et à jour** (routes
`ravetycoon`, `mppstats`, `socialcircle`, `bingo`). Vérifie-le avant d'éditer — si
ça a divergé, réconcilie plutôt que d'écraser.

### ✅ Piège n°3 — le DNS : **déjà fait et vérifié, n'y touche pas**

Ce point était bloquant à l'ouverture du chantier — `buzz.jimmydore.fr` pointait
sur le parking IONOS, `AAAA` compris, exactement le piège déjà rencontré sur
`bingo`. **Le commanditaire l'a corrigé le 27 juillet 2026 et l'état a été
vérifié**, sur les serveurs autoritatifs comme sur les résolveurs publics :

```
buzz.jimmydore.fr.  3600  IN  A  77.42.23.215   ✅ le VPS
buzz.jimmydore.fr.            (aucun AAAA)      ✅ voulu
```

Confirmé sur `ns1040.ui-dns.de` (autoritatif), sur `1.1.1.1`, sur `8.8.8.8` et en
local : même réponse partout, propagation terminée. Et surtout,
`http://buzz.jimmydore.fr/` renvoie déjà **`308` depuis `77.42.23.215`** — le
trafic atteint donc bien Caddy. **Tu n'as rien à faire côté DNS.**

**Ne recrée jamais d'enregistrement `AAAA` sur ce nom.** L'ancien pointait sur le
parking IONOS : les clients double-pile préférant l'IPv6, les invités en 4G
atterrissaient sur la page de parking pendant que le site paraissait parfaitement
fonctionnel en wifi, et le challenge Let's Encrypt échouait par intermittence.
C'est un bug qui coûte une soirée entière à diagnostiquer.

**Conséquence directe pour toi, et c'est l'état constaté aujourd'hui :**
`https://buzz.jimmydore.fr/` échoue à la poignée de main TLS, alors que
`http://` répond `308`. **Ce n'est ni le DNS ni le réseau** — c'est simplement
Caddy qui n'a aucun certificat à présenter pour un hostname qu'il ne connaît pas
encore. Ajoute le bloc `buzz.jimmydore.fr`, recharge Caddy, et le certificat est
émis dans la foulée. Ne pars surtout pas debugger le DNS sur ce symptôme.

Témoin pour discriminer : `https://bingo.jimmydore.fr/` répond `200`, donc Caddy
et l'émission de certificats sont sains.

### Dépôt et CI

Le dépôt local `/Users/jimmydore/Projets/live-buzzer` existe, avec un unique
commit vide et **aucun remote**. `gh` est authentifié en tant que `JimmyDore`
(scope `repo`).

1. `gh repo create JimmyDore/live-buzzer --public --source=. --remote=origin`
2. Les secrets `DEPLOY_SSH_KEY` / `DEPLOY_KNOWN_HOSTS` sont **par dépôt** : ceux
   de `music-bingo` ne s'appliquent pas ici. Génère une paire dédiée :
   ```bash
   ssh-keygen -t ed25519 -N '' -C 'deploy-live-buzzer' -f /tmp/lb_deploy
   ssh root@77.42.23.215 "cat >> ~/.ssh/authorized_keys" < /tmp/lb_deploy.pub
   gh secret set DEPLOY_SSH_KEY      -R JimmyDore/live-buzzer < /tmp/lb_deploy
   ssh-keyscan -H 77.42.23.215 | gh secret set DEPLOY_KNOWN_HOSTS -R JimmyDore/live-buzzer
   shred -u /tmp/lb_deploy /tmp/lb_deploy.pub
   ```
   Vérifie la nouvelle clé (`ssh -i /tmp/lb_deploy root@…`) **avant** de la
   supprimer, et n'écrase jamais `authorized_keys` — on ajoute, on ne remplace pas.
3. Workflow calqué sur `music-bingo/.github/workflows/deploy.yml` : push sur
   `main` → tests front + serveur + build → ssh → `git clone`/`git pull` →
   `docker compose up -d --build` → `docker image prune -f` → health check en
   boucle. Répertoire cible : `/root/livebuzzer`.

---

## 7. Tests

### Front (vitest)

- Calcul de l'offset d'horloge : sélection du meilleur RTT, rejet des
  échantillons > 1500 ms, comportement à zéro échantillon.
- Formatage des rangs et des écarts (`0,84 s`, `+0,31 s`, ordinaux français).
- Backoff de reconnexion : croissance, plafond, gigue.
- Parsing du code (minuscules, espaces, caractères hors alphabet).

### Serveur (`node --test`)

- **La WebSocket a sa propre suite, et c'est la plus fournie du projet :**
  valeur de `Sec-WebSocket-Accept` sur le vecteur de la RFC 6455 ; encodage et
  décodage aux frontières 125 / 126 / 65 535 / 65 536 ; trame coupée en deux
  paquets ; deux trames dans un paquet ; continuation ; ping → pong ; close ;
  trame binaire refusée.
- Bornage du buzz : `at` avant `openAt`, `at` après réception, `at` absurde.
- Ordre et rangs : buzz concurrents, égalité stricte (départage déterministe et
  documenté), second buzz du même joueur ignoré.
- Autorisation : un token joueur sur `next` / `lock` / `kick` → refusé.
- Session pleine (41ᵉ joueur), session inconnue, token invalide.
- Redémarrage : sessions rechargées depuis SQLite, purge à 24 h.

### Outils

- `tools/smoke.mjs <url>` — crée une vraie session, connecte N joueurs en
  WebSocket, buzze dans un ordre connu, vérifie la liste. **Doit tourner contre la
  prod comme contre le local.** (Modèle : `music-bingo/tools/smoke.mjs`.)
- `tools/latency-sim.mjs` — simule des clients avec des offsets d'horloge et des
  RTT artificiels (0 ms, 150 ms, 400 ms, horloge décalée de ±3 s) et **prouve que
  l'ordre restitué est celui des vrais temps de réaction**, pas celui des
  arrivées. C'est la preuve chiffrée de la fonctionnalité phare : sans elle, la
  correction de latence est une affirmation.

---

## 8. Fan out des sous-agents

**Ne construis rien séquentiellement dans le contexte principal.** Découpe, lance
en parallèle, fais relire par des critiques distincts, boucle.

### Vague 1 — parallèle, sans dépendances entre eux

| Sous-agent | Livrable |
|---|---|
| **A. Transport WebSocket** | `server/ws.mjs` + sa suite de tests. Aucun métier dedans : handshake, trames, ping/pong, backpressure, liveness. C'est une brique isolée et testable seule. |
| **B. Cœur métier serveur** | Sessions, joueurs, manches, bornage, autorisation, SQLite, purge. Consomme A derrière une interface minimale (`onMessage`, `send`, `close`). |
| **C. Système de design** | Jetons Tailwind, police auto-hébergée, primitives (bouton géant, halo, liste), page de démonstration des états. Livré **avant** les écrans. |
| **D. Infra** | `docker-compose.yml`, `deploy/Dockerfile.web`, `deploy/Dockerfile.api`, `deploy/nginx.conf` (avec le bloc `/ws`), workflow GitHub Actions, création du dépôt et des secrets. |

### Vague 2 — dès que A+B+C sont verts

| Sous-agent | Livrable |
|---|---|
| **E. Client temps réel** | Hook `useRealtime` : connexion, `hello`, sync d'horloge, offset, reconnexion, repli HTTP. Partagé par les deux rôles. |
| **F. Écran joueur** | `/:code` : join, buzzer, les trois états, son Web Audio, position. |
| **G. Console maître** | `/m/:code` : liste des buzz, MANCHE SUIVANTE, verrou, QR, kick. |
| **H. Accueil + routeur** | `/`, mini-routeur, gestion des codes invalides. |

### Vague 3 — critiques, tous distincts des producteurs

**Un critique ne valide pas, il cherche la faute.** Un critique qui rend « c'est
bon » sans preuve est relancé.

- **Critique protocole** — relit A et B en adversaire : que se passe-t-il sur une
  trame malformée, un `hello` sans token, un `next` envoyé par un joueur, 40
  connexions simultanées, une socket qui meurt en plein `state` ?
- **Critique latence** — exécute `tools/latency-sim.mjs` et exige des **chiffres**.
  Trois clients à 0 / 150 / 400 ms de RTT qui buzzent aux mêmes instants réels
  doivent ressortir dans le bon ordre, avec des écarts justes à **± 20 ms**. Il
  vérifie aussi `pointerdown`, `setNoDelay`, `tcp_nodelay`, `touch-action`, et
  l'horodatage en première ligne de gestionnaire. Chacun de ces points est un
  échec s'il manque.
- **Critique visuel** — screenshots réels en **375 × 812** *et* **320 × 568**
  (pas un desktop rétréci), des trois écrans et de **tous** les états : buzzer
  armé / verrouillé / buzzé 1er / buzzé 5e, liste vide / à 1 / à 12 entrées,
  déconnecté, session pleine, code inconnu. Contrôle : lisibilité à bout de bras
  dans une pièce sombre, contraste AA, pas de débordement, prénoms longs
  (« Jean-Christophe »), zone du pouce, safe areas.
- **Critique soirée — adversarial.** Il n'essaie pas le chemin heureux, il essaie
  de **casser la soirée** :
  - 15 joueurs rejoignent en 5 secondes → tous présents, aucun doublon d'id.
  - 12 joueurs buzzent dans la même seconde → 12 rangs distincts, ordre stable,
    aucun ex æquo mal départagé.
  - Un joueur buzze deux fois → une seule ligne, rang inchangé.
  - Un joueur rejoint **au milieu** d'une manche déjà buzzée → il voit l'état
    correct, il peut buzzer si les buzzers sont ouverts.
  - Refresh en pleine partie → prénom et place retrouvés sans rien retaper.
  - **Mode avion 30 s puis retour** → reconnexion automatique, état correct,
    buzz de nouveau fonctionnel. Idem sur le téléphone **du maître du jeu**.
  - Le maître appuie 5 fois sur MANCHE SUIVANTE en 2 s → aucune manche fantôme,
    aucun buzz attribué à la mauvaise manche.
  - Un joueur bricole l'URL / le protocole pour envoyer `next` ou `lock` → refusé.
  - Un joueur envoie `{"t":"buzz","at":0}` → borné à `openAt`, pas de plantage.
  - Deux sessions simultanées → aucune fuite d'état de l'une vers l'autre.
  - 41ᵉ joueur → message clair, pas une erreur technique.
  - `docker compose restart` en pleine session → tout le monde se reconnecte et
    retrouve son état.
- **Critique déploiement** — ne croit aucune affirmation de succès. Exige des
  codes HTTP, la sortie de `docker ps`, le résultat de `tools/smoke.mjs` contre
  la prod, et un `dig` frais.

Boucle sur chaque chantier tant que son critique n'est pas franchement convaincu.

---

## 9. Definition of Done

Chaque ligne se vérifie par une commande ou un screenshot. **Ne coche rien sur la
foi d'une intention.**

- [ ] `https://buzz.jimmydore.fr/` renvoie **200** en HTTPS, certificat valide.
- [ ] `https://buzz.jimmydore.fr/api/health` renvoie **200** et `{"ok":true}`.
- [ ] `dig +short buzz.jimmydore.fr A` → `77.42.23.215`, et
      `dig +short buzz.jimmydore.fr AAAA` → **vide**.
- [ ] La WebSocket s'établit **en `wss://` à travers Caddy et nginx** — prouvé
      par `tools/smoke.mjs https://buzz.jimmydore.fr`, pas en local.
- [ ] Une session réelle a été jouée **en production**, depuis **au moins 3
      appareils/navigateurs distincts** : création → QR scanné → 3 joueurs →
      buzz → liste ordonnée correcte → manche suivante → verrou → déverrouillage.
- [ ] `tools/latency-sim.mjs` prouve la correction de latence, **chiffres à
      l'appui** : ordre juste et écarts corrects à ± 20 ms malgré des RTT de 0,
      150 et 400 ms et des horloges décalées.
- [ ] `npm test` (vitest, front) **vert**, `node --test` (back) **vert**, avec la
      suite WebSocket couvrant les frontières de trames listées en §4.1.
- [ ] `server/package.json` n'a **aucune** `dependencies`.
- [ ] Le pipeline GitHub Actions passe **au vert de bout en bout** sur `main`.
- [ ] Vérifié sur un vrai téléphone à 375 px **et** 320 px : trois écrans, tous
      les états, sans scroll horizontal ni débordement.
- [ ] Le bloc `/ws` avec les en-têtes `Upgrade` est bien dans `deploy/nginx.conf`.
- [ ] La route `buzz` est présente **dans le Caddyfile du serveur ET dans le dépôt
      RaveTycoon** (poussé), sans avoir perdu les quatre routes existantes.
- [ ] Le son se déclenche sur un **iPhone réel** au premier buzz, sans tap de
      déblocage préalable.
- [ ] `README.md` écrit : ce que c'est, comment lancer en dev, comment le
      protocole fonctionne, comment déboguer une reconnexion.

---

## 10. Ce qui compte, et ce qui n'existe pas

**Rappels finaux, parce que ce sont les endroits où un agent dérive :**

- L'UI est **en français**. Intégralement. Y compris les messages d'erreur.
- **N'existent pas, et ne doivent pas être construits** : points, scores, équipes,
  chrono, mode manche numéroté, pénalité de buzz anticipé, questions de quiz,
  chat, classement persistant, comptes, écran TV séparé, thème clair,
  anti-triche au-delà du bornage de §3.3. buzzin.live a tout ça ; c'est
  précisément ce qu'on retire. **Si tu te surprends à en construire un, tu as
  dérivé** — relis §1.
- Le commanditaire est développeur backend et lira le code. Les conventions maison
  (français dans les commentaires, zéro dépendance côté serveur, Docker + Caddy
  partagé, mini-routeur plutôt que React Router) ne sont pas décoratives.
- **Le DNS est déjà réglé et vérifié — n'y touche pas, et ne recrée jamais
  d'`AAAA`.** Un `https://` qui échoue avant que la route Caddy existe est
  attendu : ce n'est pas un problème de DNS (§6, piège n°3).
- **Si quelque chose est bloqué, finis tout le reste** et dis explicitement ce qui
  manque et pourquoi. Aucun blocage connu ne subsiste au moment d'écrire ce
  brief : tout ce qui suit est de l'exécution.

---

## 11. Invocation

```
Lis PROMPT.md et construis le projet en entier jusqu'à ce que la Definition of
Done soit intégralement vérifiée en production.

Le DNS est déjà en place et vérifié : rien ne te bloque, tout est de l'exécution.

Fan out des sous-agents sur chaque chantier selon les trois vagues du §8 :
transport WebSocket, cœur métier, système de design et infra en parallèle, puis
les écrans, puis les critiques. Fais relire chaque chantier par un sous-agent
critique distinct et impitoyable, qui exige des preuves et non des affirmations.
Boucle sur chaque item tant que le critique n'est pas convaincu.

Ne t'arrête pas avant qu'une vraie session ait été jouée depuis trois téléphones
sur https://buzz.jimmydore.fr, et que tools/latency-sim.mjs ait prouvé la
correction de latence chiffres à l'appui. Ultracode.
```
