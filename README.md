# live-buzzer

Un buzzer multijoueur temps réel, à jouer en soirée réelle depuis des téléphones.
En ligne sur **https://buzz.jimmydore.fr**.

C'est une reprise de [buzzin.live](https://buzzin.live/host), en français, et
surtout **radicalement plus simple** : là où l'original empile points, équipes,
chronos et modes de manche, celui-ci ne fait qu'une chose — dire **qui a buzzé le
premier**, honnêtement, même quand un joueur est en 4G et l'autre en wifi.

Tout est mobile-first, console du maître du jeu comprise. Cible : 375 px de large,
à une main, dans une pièce mal éclairée.

## Comment ça se joue

1. Le maître du jeu ouvre `/` et crée une session : **un tap**, pas de formulaire.
   Il obtient un code à 4 caractères et un QR code.
2. Les joueurs scannent le QR (ou tapent le code), saisissent un prénom, et
   voient **un buzzer plein écran**. Rien d'autre.
3. Le maître pose sa question **à voix haute**. L'app ne contient aucun contenu.
4. Les joueurs buzzent. La console affiche la **liste ordonnée** : le 1er avec son
   temps de réaction (`0,84 s`), les suivants avec leur écart (`+0,31 s`).
5. **Le premier buzz ne verrouille personne** : la liste continue de se remplir.
   Si le 1er se plante, le maître enchaîne sur le 2e sans rien relancer.
6. **MANCHE SUIVANTE** efface la liste et rouvre les buzzers. Question suivante.

Deux contrôles, et deux seulement :

| Contrôle | Effet |
|---|---|
| **MANCHE SUIVANTE** | Efface la liste **et** ouvre les buzzers. Bouton géant, en bas, dans la zone du pouce. |
| **Verrou** (cadenas) | Ferme / rouvre les buzzers **sans** effacer la liste. Bascule secondaire, dans l'en-tête. |

Plus un seul geste de gestion : **retirer un joueur** (appui long sur son nom).
Il existe parce qu'un joueur fantôme pollue la liste toute la soirée.

### Ce que l'app ne fait pas, volontairement

Ces absences sont le produit. Ne les « complète » pas.

- **Aucun score, aucun point, aucune équipe, aucun chrono, aucune manche
  numérotée.** Si tu te surprends à construire un compteur de points, tu as
  dérivé — relis ce paragraphe.
- **Aucun contenu de quiz** : ni questions, ni réponses, ni catégories. Le contenu
  est dans la tête du maître du jeu.
- **Aucun compte, aucun mot de passe, aucun email.** Un prénom suffit ; un token
  aléatoire en `localStorage` tient lieu d'identité.
- **Aucun anti-triche** au-delà du bornage serveur (voir plus bas). La triche est
  un problème social, pas logiciel.
- Le **maître du jeu ne joue pas** : pas de buzzer sur sa console.
- Ni chat, ni classement persistant, ni écran TV séparé, ni thème clair
  (`prefers-color-scheme` est ignoré : le jeu est sombre, point).

Limites dures : **40 joueurs** par session (refus lisible au 41ᵉ, jamais un
plantage), purge à **24 h**, prénom tronqué à 24 caractères.

## Les routes

| Route | Écran |
|---|---|
| `/` | Accueil : « Créer une session » + champ « Rejoindre » |
| `/m/:code` | Console du maître du jeu |
| `/:code` | Joueur : prénom, puis le buzzer |
| `/demo` | Galerie du système de design (tous les états, sans serveur) |

Le routeur tient en ~90 lignes (`src/router.tsx`) : quatre routes, React Router
pèserait plus lourd que l'application.

> ⚠️ **L'ordre des tests EST la spécification.** `/m/:code` se teste **avant**
> `/:code`, et `/demo` avant `/:code` aussi. `/:code` est la route attrape-tout à
> un segment : la tester en premier rendrait la console du maître inatteignable —
> la soirée n'aurait plus d'animateur. `src/router.test.ts` verrouille cet ordre.

Le segment `m` est accepté en majuscule (`/M/F9NJ`) : l'autocapitalisation d'un
téléphone ne doit pas coûter une session. La validation du code dans l'URL est en
revanche **stricte** (exactement 4 caractères de l'alphabet), contrairement à la
saisie clavier qui est tolérante — sinon `/F9NJX` ouvrirait la session `F9NJ` de
quelqu'un d'autre.

## Architecture

| | |
|---|---|
| Front | Vite · React 19 · TypeScript · Tailwind 4 · tests **vitest** |
| Back | Node 22, **zéro dépendance npm** : `node:http` + `node:crypto` + `node:sqlite`, tests `node --test` |
| Temps réel | WebSocket **écrite à la main** (RFC 6455), JSON en trames texte |
| Repli | `POST /api/games/:code/buzz` quand la socket n'est pas `OPEN` |
| Déploiement | 2 conteneurs Docker derrière le Caddy partagé du VPS |

### Zéro dépendance côté serveur — contrainte, pas coïncidence

`server/package.json` n'a **aucun** champ `dependencies`, et ce n'est pas un oubli.
Le serveur HTTP est `node:http`, la base est `node:sqlite` (`DatabaseSync`), le
SHA-1 du handshake est `node:crypto`, et le transport WebSocket est écrit à la
main dans `server/ws.mjs` (~540 lignes, sa propre suite de tests) : **pas de
paquet `ws`**.

La CI casse le build si le fichier gagne un `dependencies`, `optionalDependencies`
ou `peerDependencies` (`.github/workflows/deploy.yml`, étape « Le serveur reste à
zéro dépendance npm »). Un `npm install ws` glissé un soir de bug disparaîtrait
sinon sans bruit.

`deploy/Dockerfile.api` ne fait d'ailleurs aucun `npm ci` : il copie les `.mjs` et
lance `node index.mjs`.

## Développement

```bash
npm install
```

Deux terminaux :

```bash
npm run api     # API + WebSocket sur :8787 (node brut, aucun build)
npm run dev     # front sur :5173, /api et /ws sont proxifiés vers :8787
```

`npm run api` lance `node server/index.mjs` ; `cd server && node index.mjs` marche
aussi. **Attention au dossier de la base** : `DB_PATH` vaut `./data/livebuzzer.db`
et il est relatif au répertoire courant. Depuis la racine on obtient
`./data/livebuzzer.db`, depuis `server/` on obtient `server/data/livebuzzer.db` —
deux bases différentes, et la session créée dans l'une n'existe pas dans l'autre.
Le dossier est créé au démarrage, `data/` et `*.db` sont dans `.gitignore`.

```bash
PORT=8080 DB_PATH=/tmp/lb.db npm run api   # les deux sont surchargeables
DB_PATH=:memory:            npm run api   # base jetable, aucun fichier écrit
```

Au démarrage, l'API recharge depuis SQLite toutes les sessions de moins de 24 h et
l'annonce :

```
live-buzzer api sur :8787 (db: ./data/livebuzzer.db, 3 session(s) rechargée(s))
```

`node:sqlite` étant encore marqué expérimental, Node imprime un
`ExperimentalWarning: SQLite is an experimental feature` à chaque lancement.
C'est normal, ça n'a jamais rien cassé, et ça disparaîtra tout seul.

### Tests

```bash
npm test                                      # front, vitest — 68 tests
npm run test:server                           # back, node --test — 121 tests
cd server && node --test "test/*.test.mjs"    # strictement équivalent
npm run build                                 # tsc --noEmit && vite build
```

La suite serveur la plus fournie est celle du **transport WebSocket** : vecteur
canonique de la RFC 6455 pour `Sec-WebSocket-Accept`, frontières d'encodage
125 / 126 / 65 535 / 65 536, trame coupée en deux paquets TCP, deux trames dans un
paquet, continuation, ping → pong, close, trame binaire refusée, backpressure,
liveness. Ne touche pas à `server/ws.mjs` sans la relancer.

## Le protocole

Du JSON dans des trames texte, sur `/ws`. Le transport (`server/ws.mjs`) ne
connaît rien du jeu ; le protocole applicatif vit dans `server/protocol.mjs` et le
métier dans `server/game.mjs`.

### Client → serveur

| Message | Rôle requis | Effet |
|---|---|---|
| `{"t":"hello","role":"host"\|"player","code":"F9NJ","token":"…"}` | — | Authentifie et **rend un `state` complet**. `role` vaut `player` sauf si exactement `"host"`. |
| `{"t":"sync","c":<performance.now()>}` | aucun | Échantillon d'horloge. Sert **aussi** de heartbeat de liveness. |
| `{"t":"buzz","at":<horloge serveur estimée>}` | `player` | Buzz. `at` est borné côté serveur (voir plus bas). |
| `{"t":"next"}` | `host` | Nouvelle manche : efface la liste **et** ouvre les buzzers. |
| `{"t":"lock","locked":true\|false}` | `host` | Verrou seul, la liste reste. |
| `{"t":"kick","playerId":"…"}` | `host` | Retire un joueur, ferme sa socket. |

Un JSON malformé, un `t` absent ou un `t` inconnu sont **ignorés en silence** : on
ne tue jamais une connexion de soirée pour une trame bizarre.

### Serveur → client

| Message | Destinataires |
|---|---|
| `{"t":"state","locked":…,"openAt":…,"players":[…],"buzzes":[…]}` | Instantané **complet**, filtré par rôle |
| `{"t":"open","at":<serverNow+300>}` | Tout le monde, à chaque MANCHE SUIVANTE |
| `{"t":"buzz","playerId":…,"name":…,"rank":…,"ms":…}` | **L'hôte, et le joueur concerné uniquement** |
| `{"t":"lock","locked":…}` | Tout le monde |
| `{"t":"sync","c":<c réémis intact>,"s":<Date.now() serveur>}` | L'émetteur |
| `{"t":"players","players":[…]}` | Tout le monde |
| `{"t":"error","code":"GAME_NOT_FOUND"\|"BAD_TOKEN"}` | L'émetteur (ou le joueur exclu) |

Détails **tels qu'implémentés**, qui divergent du brief :

- Sur le canal WebSocket, les seuls codes d'erreur réellement émis sont
  `GAME_NOT_FOUND` et `BAD_TOKEN`. `GAME_FULL` n'existe qu'en HTTP (409 sur
  `POST /players`), et **`NAME_TAKEN` n'existe pas du tout** : deux « Marie » sont
  acceptées, la seconde devient « Marie (2) ». On ne bloque pas une soirée sur une
  homonymie.
- Un `buzz` envoyé alors que les buzzers sont fermés ne rend **pas** une erreur :
  le serveur répond `{"t":"lock","locked":…}`. Ce n'est pas un refus, c'est une
  resynchronisation — un joueur qui tape dans le vide a une UI désynchronisée, et
  c'est ça qu'il faut corriger.
- Après un buzz qui fait bouger des rangs déjà annoncés, le serveur renvoie un
  `state` complet plutôt qu'un patch (voir « reclassement » plus bas).

### La règle d'or : chaque `hello` rend un `state` complet

**À chaque `hello`, donc à chaque reconnexion, le serveur renvoie l'instantané
entier.** Jamais de reprise incrémentale, jamais de « on reprend où on en était ».
Le client jette son état local et adopte celui du serveur.

C'est ce qui rend la reconnexion **bête et infaillible**, et c'est indispensable
parce qu'un téléphone en soirée change de réseau, se met en veille et change de
pièce. Corollaire côté client : les rangs ne sont **pas** append-only. Un `state`
peut arriver à n'importe quel moment et rétrograder une ligne déjà affichée.

Un second `hello` sur la même socket est la façon normale de resynchroniser
(`tools/smoke.mjs` s'en sert). Un `hello` depuis une **nouvelle** socket avec la
même identité ferme l'ancienne : une socket zombie de mode avion ne doit pas
continuer à recevoir des diffusions.

### Le filtrage par rôle

Le filtrage est **côté serveur** : ce qui n'est pas envoyé ne peut pas fuir.

| | Hôte | Joueur |
|---|---|---|
| `state.buzzes` | la liste complète | **uniquement son propre buzz** |
| `state.players` | complète | complète (noms, connecté, a buzzé) |
| annonce `{"t":"buzz"}` | tous les buzz | **le sien seulement** |

Un joueur ne voit **jamais** la liste des autres, ni sur le fil ni à l'écran :
seulement sa position (`1er`, `2e`, …) et son temps de réaction.

### API HTTP

La WebSocket porte le jeu ; l'HTTP ne sert qu'à créer, à rejoindre et à secourir.

```
POST /api/games                  → 201 { code, hostToken }
GET  /api/games/:code            → 200 { exists, locked, playerCount }
POST /api/games/:code/players    → 201 { playerId, token, name }
                                   404 code inconnu · 409 session complète · 400 prénom vide
POST /api/games/:code/buzz       → 200 { rank, ms }        (secours si WS fermée)
                                   403 jeton invalide · 404 inconnue · 409 verrouillé
GET  /api/health                 → 200 { ok: true }
```

Le jeton du buzz de secours se passe en `Authorization: Bearer …` ou dans le corps.
Un code hors alphabet sur `GET /api/games/:code` rend `{ exists: false }` avec un
**200**, pas une erreur : ce n'est pas une panne, c'est une faute de frappe, et
l'écran d'accueil sait quoi en dire.

Le token hôte est le **seul** garde-fou sur `next`, `lock` et `kick`. Un joueur ne
doit jamais pouvoir déverrouiller les buzzers ni effacer la liste.

### Schéma SQLite

```
games(code PK, host_token, locked, open_at, round_id, created_at)
players(id PK, game_code, name, token, connected, joined_at)
buzzes(game_code, round_id, player_id, at_ms, rank,
       PRIMARY KEY(game_code, round_id, player_id))
```

La clé primaire composite de `buzzes` **est** la règle « un buzz par joueur par
manche » : un `INSERT` en doublon échoue, et c'est très bien.

**La vérité chaude vit en mémoire** (une `Map` de sessions dans `game.mjs`).
SQLite n'est qu'un journal d'écriture : le filet qui permet à une soirée de
survivre à un `docker compose up --build` ou à un `docker restart`. Au démarrage,
tout ce qui a moins de 24 h est rechargé ; la purge tourne toutes les heures.

## La correction de latence

**C'est la fonctionnalité qui distingue ce produit d'un `<button>` branché sur un
POST.** Deux joueurs buzzent à 30 ms d'écart, l'un en 4G, l'autre en wifi : c'est
**le doigt le plus rapide qui doit gagner, pas la meilleure connexion**.

### 1. Synchronisation d'horloge, façon NTP

Sur le **canal applicatif** — des messages JSON, pas les trames de contrôle
ping/pong de la WebSocket, que le navigateur n'expose pas :

```
client  → {"t":"sync","c":<t0>}                 t0 = performance.now()
serveur → {"t":"sync","c":<t0>,"s":<serverNow>} serverNow = Date.now() serveur
client  :  t1     = performance.now()
           rtt    = t1 - t0
           offset = s + rtt/2 - t1               // à ajouter à performance.now()
```

- **5 échantillons rapides** à 100 ms d'intervalle à la connexion, puis **1 toutes
  les 5 s** — cadence lente qui sert aussi de heartbeat (le serveur coupe une
  socket muette depuis 20 s).
- On retient l'échantillon de **plus faible RTT** parmi les **8 derniers**, jamais
  la moyenne. Un RTT bas est un RTT peu bruité : le paquet n'a fait la queue nulle
  part, donc l'hypothèse « aller = retour = rtt/2 » y est la moins fausse. Une
  moyenne, elle, intègre exactement le bruit qu'on cherche à éliminer.
- Les échantillons de **RTT > 1500 ms** sont rejetés : au-delà, ils ne disent plus
  rien d'utile sur l'heure serveur. Les RTT négatifs aussi (horloge monotone
  violée), ainsi que toute valeur non finie.
- Sans aucun échantillon valide, `offset = 0` : on retombe sur l'horodatage
  serveur. **Dégradation, pas panne.**

Le code vit dans `src/lib/horloge.ts`, pur et sans réseau, donc testable sans
dormir (`src/lib/horloge.test.ts`).

### 2. L'ouverture est datée dans le futur

Synchroniser les horloges ne suffit pas : la diffusion de « buzzers ouverts »
n'arrive pas au même instant chez tout le monde. Un joueur qui la reçoit 120 ms
plus tard partirait avec 120 ms de retard, correction d'horloge ou pas.

Donc le serveur ne dit jamais « ouvert **maintenant** ». Il dit **« ouvert à »** :

```
serveur → tous : {"t":"open","at":<serverNow + 300>}
```

Chaque client arme son buzzer **localement** quand `performance.now() + offset >= at`
(un `setTimeout` sur le délai calculé). 300 ms d'avance couvrent largement une
diffusion sur un wifi de salon, c'est invisible à l'usage, et c'est ce qui rend les
temps de réaction **comparables entre eux**.

Le temps de réaction affiché est **toujours relatif à `at`**, jamais à l'arrivée du
message : `ms = round(effectif - openAt)`.

### 3. Le bornage du buzz

```
client → {"t":"buzz","at":<performance.now() + offset>}
```

Le serveur ne fait **aucune** confiance à ce chiffre :

```js
const effectif = Math.min(Math.max(at, manche.openAt), recuA)
// recuA = Date.now() au moment de la réception, capturé en PREMIÈRE LIGNE
```

- **Borne basse `openAt`** : personne ne peut avoir buzzé avant l'ouverture.
- **Borne haute `recuA`** : personne ne peut avoir buzzé après que son paquet soit
  arrivé — la vraie émission a même eu lieu ~rtt/2 plus tôt, la borne est donc
  généreuse, jamais injuste.
- Un `at` absurde (absent, `NaN`, chaîne, `Infinity`) retombe sur `recuA`.

Un client hostile qui envoie `at: 0` se retrouve mécaniquement à `openAt`, donc
premier avec 0 ms. **C'est la seule triche possible, et on l'accepte** : elle
demande d'ouvrir la console développeur sur son téléphone en pleine soirée, devant
tout le monde. **La triche est un problème social, pas logiciel — ne construis
aucun anti-triche au-delà de ce bornage.**

Tout buzz borné est **journalisé côté serveur**. C'est le seul moyen de
diagnostiquer une dérive d'horloge après coup :

```
[buzz borné] partie=F9NJ manche=2 joueur=55bbaea51e5333a76d at=0 reçu=1785187687845
             openAt=1785187687642 → effectif=1785187687642 (écart -1785187687642 ms)
```

### 4. Le départage, et le reclassement

Les rangs sont ordonnés par `effectif` croissant. En cas d'**égalité stricte**, on
départage par un **numéro de séquence attribué à la réception par le serveur**,
strictement croissant : le paquet arrivé le premier prend le rang le plus petit.

Ce critère est total (jamais deux fois la même valeur), stable (il ne dépend
d'aucun tri instable ni de l'ordre d'itération d'une `Map`), reproductible, et
**inaccessible au client**. Un départage par `playerId` ou par ordre d'inscription
aurait avantagé les mêmes joueurs toute la soirée.

Conséquence directe de la correction de latence : un buzz peut arriver **en retard
mais horodaté plus tôt** (4G contre wifi) et **rétrograder un rang déjà annoncé**.
Le serveur retrie et renumérote à chaque insertion, puis diffuse un `state`
complet — pas un patch. La reconnexion et le reclassement empruntent le même
chemin bête et infaillible.

Le classement utilise `effectif` en pleine précision (`performance.now()` est
fractionnaire) ; seul l'affichage arrondit à la milliseconde. Deux buzz à 0,3 ms
d'écart restent départagés.

### 5. Les détails clients qui coûtent 300 ms

Chacun de ces points ruine à lui seul tout ce qui précède.

- **`pointerdown`, jamais `click`.** `click` ne part qu'au relâchement du doigt :
  80 à 200 ms offerts à l'adversaire.
- **Horodatage à la première ligne du gestionnaire**, avant tout rendu, tout state
  React, tout appel réseau. L'ordre des trois lignes de `surBuzz`
  (`src/screens/Joueur.tsx`) est la fonctionnalité, pas un détail de style :
  `rt.maintenant()` → son local → `rt.buzzer(at)`.
- **Retour visuel et sonore immédiats et locaux.** Le `.buzzer:active` est appliqué
  par le navigateur au `pointerdown`, sans JS ni frame d'attente ; le son est
  généré à la Web Audio API (oscillateur + enveloppe ~120 ms), `AudioContext`
  créé et `resume()` **dans le tap** — seule façon dont iOS Safari autorise le son.
- **`touch-action: manipulation`** et viewport sans zoom, sinon Safari attend
  300 ms pour distinguer un double-tap.
- **`socket.setNoDelay(true)`** côté serveur, posé dès la poignée de main, et
  **`tcp_nodelay on;`** côté nginx. L'algorithme de Nagle retient une petite trame
  jusqu'à 40 ms : la moitié du budget de latence d'un buzzer.
- **Repli HTTP** si la socket n'est pas `OPEN` : `POST /api/games/:code/buzz` avec
  **exactement le même `at`**, donc le même bornage et le même temps de réaction.
  Un buzz ne se perd jamais parce qu'une socket était en train de se reconnecter.

### La preuve chiffrée

```bash
node tools/latency-sim.mjs
```

Quatre clients simulés (RTT 0 / 150 / 400 ms, horloges décalées de −3 s à +3 s)
traversent le **vrai code serveur** avec une horloge virtuelle :

```
  client         RTT  horloge    réaction      serveur  écart  offset est.  rang
                (ms)     (ms)  vraie (ms)  mesuré (ms)   (ms)         (ms)
  ------------------------------------------------------------------------------
  Wifi salon       0        0         320          320      0          0.0     3
  Wifi cuisine   150    +3000         285          285      0      -2999.8     2
  4G couloir     400    -3000         240          239     -1       2998.9     1
  4G jardin      400    +1234         610          608     -2      -1236.4     4

  ordre des VRAIS temps de réaction : 4G couloir > Wifi cuisine > Wifi salon > 4G jardin
  ordre restitué par le serveur     : 4G couloir > Wifi cuisine > Wifi salon > 4G jardin
  ordre des ARRIVÉES de paquets     : Wifi salon > Wifi cuisine > 4G couloir > 4G jardin

  ✓ l'ordre restitué est exactement celui des vrais temps de réaction
  ✓ tous les écarts sont dans ± 20 ms (pire écart : 2 ms)
  ✓ l'écran du maître, reconstruit depuis les seuls messages reçus, égale l'état du serveur

  PASS — le doigt le plus rapide gagne, pas la meilleure connexion.
```

La troisième ligne d'ordre est celle qui compte : **sans correction, le classement
serait celui des arrivées de paquets**, et il est faux. Le script sort en code 1
si un seul écart dépasse ± 20 ms. Le générateur d'aléa est seedé : deux exécutions
donnent les mêmes chiffres, sinon « la preuve » dépendrait de la chance.

## Déboguer une reconnexion

C'est le scénario le plus fréquent d'une vraie soirée : mode avion, ascenseur,
veille de l'écran, passage wifi → 4G, changement de pièce. Tout le client temps
réel tient dans `src/lib/useRealtime.ts`.

### Les trois états de connexion

| État | Point | Libellé | Quand |
|---|---|---|---|
| `connexion` | orange | « Connexion… » | Socket en cours d'ouverture, ou **1re** tentative échouée |
| `ouvert` | vert | « Connecté » | Socket `OPEN` |
| `perdu` | rouge | « Hors ligne » | **2 tentatives** échouées d'affilée (~750 ms) |

En dessous de deux échecs, le point clignoterait à chaque micro-coupure. Le bandeau
rouge « **Connexion perdue** — on réessaie tout seul » sort immédiatement sur la
console du maître, et au bout de **6 s** sur l'écran joueur : un bandeau qui
clignote devient du bruit, et on cesse de le lire exactement le soir où il compte.

L'état est visible **en permanence des deux côtés**. Une déconnexion silencieuse
est le pire scénario du jeu : le maître croit que personne ne buzze, les joueurs
croient que le maître ne relance pas.

### La courbe de backoff

`src/lib/backoff.ts` — **250 ms → 4 s, ×2, gigue ±20 %, à l'infini** :

```
tentative 0 : 250 ms      tentative 3 : 2000 ms
tentative 1 : 500 ms      tentative 4 : 4000 ms
tentative 2 : 1000 ms     tentative 5+ : 4000 ms (plafond)
```

Chaque valeur est secouée de ±20 % puis ramenée dans `[250, 4000]`. Aux deux
extrémités la gigue est donc écrêtée par les bornes : c'est assumé, on préfère la
garantie dure « jamais moins de 250 ms, jamais plus de 4 s ».

**La gigue n'est pas cosmétique.** Quand le wifi de la salle revient, quinze
téléphones se reconnectent : sans gigue ils tapent tous à la même milliseconde, le
serveur en refuse une partie, et ils recommencent en chœur.

### Les déclencheurs immédiats

On n'attend pas le backoff quand on sait que quelque chose a changé :

- **`visibilitychange`** → `visible` : retour au premier plan.
- **`online`** : le réseau est revenu.

Dans les deux cas, `reveiller()` :

- si la socket est déjà `OPEN` → envoie une **sonde `sync` immédiate**. L'appareil
  a pu dormir ; ça rafraîchit l'offset et réveille le compteur de liveness serveur.
- si elle est `CONNECTING` → ne fait rien (doubler la tentative empire tout).
- sinon → annule le timer de backoff, remet `essai = 0` et reconnecte **tout de
  suite**.

> ⚠️ **L'horloge n'est PAS réinitialisée à la reconnexion.** `performance.now()`
> est le même d'une socket à l'autre, l'offset reste donc valide. Le jeter ferait
> repartir de `offset = 0` juste après un mode avion — exactement au moment où on
> en a besoin. `Horloge.reinitialiser()` ne s'appelle que sur **changement de
> session**.

### Le timeout de liveness serveur

Côté serveur, **20 s sans message applicatif** → la connexion est déclarée morte,
fermée avec un close `1001`, et le joueur passe « déconnecté ».

Seule une **trame texte applicative** réarme le compteur. Un ping/pong de contrôle
ne prouve rien sur la santé de l'onglet (et le navigateur ne l'expose pas), et
c'est explicitement testé : un flot ininterrompu de pings ne maintient **pas** la
connexion en vie.

C'est pour ça que la synchro d'horloge tourne toutes les 5 s : elle est le
heartbeat. Un client qui ne synchronise plus se fait couper au bout de 20 s, puis
se reconnecte tout seul. **Il n'existe pas, en revanche, de timeout côté client
qui déclarerait la synchro en échec** : sans échantillon valide, `offset` reste à
0 et on retombe silencieusement sur l'horodatage serveur. `useRealtime` expose
`offsetPret` et `rtt` pour le diagnostic, mais aucun écran ne les affiche
aujourd'hui.

### Ce qu'on regarde, et dans quel ordre

**1. Console du navigateur, onglet Réseau, filtre `WS`.**

- Un **`101 Switching Protocols`** : la socket s'est établie. Ouvre-la, l'onglet
  « Messages » montre le `hello` puis le `state` complet en réponse, et un `sync`
  toutes les 5 s. Si les `sync` s'arrêtent, l'onglet a été gelé (arrière-plan iOS).
- Un **`200`** ou un **`400`** au lieu de `101` : ce n'est pas le serveur, c'est un
  intermédiaire qui a mangé l'upgrade. En prod → le bloc `/ws` de nginx (voir
  Déploiement). En dev → `ws: true` manquant dans le proxy de `vite.config.ts`.
- Une socket qui se rouvre toutes les 250 ms puis 500, 1000, 2000, 4000 : le
  backoff fait son travail, le serveur refuse. Regarde ses logs.
- Une socket `OPEN` mais aucun message : la socket est **zombie**. Elle sera
  coupée par la liveness serveur dans les 20 s, puis rouverte.

**2. Logs serveur** (`docker logs -f livebuzzer-api`, ou le terminal `npm run api`).

| Ligne | Ce que ça veut dire |
|---|---|
| `ws: silence applicatif, connexion considérée morte` | Liveness 20 s. Normal après un mode avion. |
| `ws: erreur de socket (read ECONNRESET)` | Le téléphone a coupé sans close propre. Bénin. |
| `ws: upgrade refusé (chemin …)` / `(version …)` | La requête n'est pas une WebSocket valide — souvent un proxy mal configuré. |
| `ws: trame invalide (…)` | Trame malformée : le décodeur ferme avec le bon code RFC. |
| `ws: tampon saturé (N octets), connexion coupée` | Backpressure > 1 Mo : client mort, on coupe plutôt que de gonfler la mémoire. |
| `[buzz borné] …` | Bornage. Le champ `écart` chiffre la dérive d'horloge du client. |

**3. Reproduire proprement.**

```bash
# 1. Ouvre /m/<code> sur un téléphone, /<code> sur un autre.
# 2. Mode avion 30 s sur le téléphone joueur.
#    → point rouge, bandeau « Connexion perdue » au bout de 6 s.
# 3. Coupe le mode avion.
#    → l'événement `online` déclenche une reconnexion IMMÉDIATE (pas le backoff),
#      `hello` part, un `state` complet revient, le buzzer se réarme si la manche
#      est ouverte. Le joueur retrouve sa place SANS retaper son prénom.
# 4. Même manip sur le téléphone du MAÎTRE : la liste doit revenir intacte.
```

Rafraîchir la page en pleine partie est un autre cas à tester : le jeton en
`localStorage` (`lb:joueur:<CODE>` / `lb:hote:<CODE>`) rend le prénom et la place
sans rien retaper. Le serveur ouvre la nouvelle socket avant que l'ancienne ne
meure : il ne marque « déconnecté » que s'il ne reste **plus aucune** socket pour
ce joueur, sinon un simple refresh ferait clignoter la pastille.

**4. Distinguer une socket morte d'un serveur mort.**

```bash
curl -s https://buzz.jimmydore.fr/api/health      # {"ok":true} → le serveur vit
node tools/smoke.mjs https://buzz.jimmydore.fr    # → la WebSocket vit aussi
```

- `/api/health` **200** et smoke qui échoue sur `poignée de main refusée : …` →
  le serveur va bien, c'est le chemin d'**upgrade** qui est cassé (nginx, Caddy).
  Le message contient la ligne de statut reçue, qui dit lequel.
- `/api/health` injoignable → le conteneur API est tombé :
  `docker ps --filter name=livebuzzer` et `docker logs livebuzzer-api`.
- Les deux verts, mais un seul téléphone qui ne se reconnecte pas → c'est ce
  téléphone (onglet gelé, réseau captif, économiseur de batterie). Repasse au
  premier plan : `visibilitychange` reconnecte immédiatement.

## Les outils

Zéro dépendance là aussi : le client WebSocket de `smoke.mjs` (poignée de main
RFC 6455, trames masquées, TLS) est écrit à la main.

### `tools/smoke.mjs` — jouer une vraie soirée de bout en bout

```bash
node tools/smoke.mjs                             # défaut : http://localhost:8787
node tools/smoke.mjs http://localhost:5173       # à travers le proxy Vite
node tools/smoke.mjs https://buzz.jimmydore.fr   # prod, donc wss:// à travers Caddy + nginx
```

Il crée une vraie session, connecte 4 joueurs en WebSocket, synchronise les
horloges, ouvre une manche, buzze **dans l'ordre inverse des temps de réaction**
(si le serveur classait par arrivée de paquet, la liste sortirait à l'envers),
vérifie le rejeu, la sécurité (`next`/`lock`/`kick` envoyés par un joueur), le
verrou, le repli HTTP socket fermée, la triche `at: 0`, l'exclusion et le 41ᵉ
joueur. Sortie 0 si tout passe, 1 sinon.

```
40/40 vérifications passées sur https://buzz.jimmydore.fr
Session F9NJ jouée de bout en bout, WebSocket comprise. Tout est vert.
```

Le `wss://` n'est pas un détail : c'est la seule façon de prouver que la chaîne
**Caddy → nginx → node** laisse passer l'upgrade. Un test local ne le prouve pas.

### `tools/latency-sim.mjs` — la preuve chiffrée

Voir « La correction de latence » plus haut. Sans dépendance, sans réseau, sans
serveur à démarrer : il importe directement `server/game.mjs` et
`server/protocol.mjs`.

## Déploiement

Push sur `main` → GitHub Actions lance les tests front, les tests serveur, la
**vérification du zéro-dépendance**, le build ; puis SSH sur le VPS, `git pull`,
`docker compose up -d --build`, `docker image prune -f`, et deux sondes de santé.

Les deux sondes ne disent pas la même chose, d'où leur ordre :

1. **Conteneurs, depuis le réseau Docker** : prouve que la stack est saine,
   indépendamment de Caddy et du certificat.
2. **URL publique en HTTPS** : prouve la chaîne complète DNS → Caddy → nginx →
   node, certificat compris. **Si la 2 est rouge alors que la 1 est verte, le
   problème est dans le Caddyfile, pas dans la stack.**

Deux conteneurs, **aucun port publié** : le Caddy partagé (stack RaveTycoon) fait
le TLS et le reverse-proxy sur le réseau Docker externe **`ravetycoon_default`**.

| Conteneur | Rôle |
|---|---|
| `livebuzzer-web` | nginx : SPA buildée + proxy `/api` et `/ws` |
| `livebuzzer-api` | node brut sur `:8787`, volume nommé `livebuzzer-data` monté sur `/data` |

Route Caddy :

```
buzz.jimmydore.fr {
	reverse_proxy livebuzzer-web:80
}
```

Caddy 2 gère l'`Upgrade` WebSocket nativement : **rien de spécial à configurer de
ce côté.**

> ⚠️ **Ne jamais nommer un service `web` ni `api`** dans ce `docker-compose.yml`.
> Ces alias DNS appartiennent déjà à RaveTycoon sur le réseau partagé, et un
> service homonyme capterait le trafic de l'autre stack. Le piège a déjà coûté un
> incident. D'où les préfixes `livebuzzer-`.

> ⚠️ **Piège n°1 — nginx coupe l'upgrade WebSocket par défaut.** Sans le bloc
> ci-dessous, **tout marche en local** (Vite proxifie) **et rien ne marche en
> prod** : le navigateur reçoit un 200 au lieu d'un 101 et la socket ne s'ouvre
> jamais. Il est dans `deploy/nginx.conf`, ne le perds pas.
>
> ```nginx
> location /ws {
>     proxy_pass http://livebuzzer-api:8787;
>     proxy_http_version 1.1;
>     proxy_set_header Upgrade $http_upgrade;
>     proxy_set_header Connection "upgrade";
>     proxy_set_header Host $host;
>     proxy_read_timeout 3600s;   # une soirée dure plus d'une heure : sans ça,
>     proxy_send_timeout 3600s;   # nginx coupe à 60 s et le client boucle
>     proxy_buffering off;        # tamponner un flux temps réel, c'est le retarder
>     gzip off;
> }
> ```
>
> Plus `tcp_nodelay on;` au niveau du `server` : le pendant nginx de
> `socket.setNoDelay(true)`, même raison, mêmes 40 ms en jeu.

> ⚠️ **Piège n°2 — le Caddyfile vit dans le dépôt RaveTycoon.**
> `/root/ravetycoon/deploy/Caddyfile` est **monté depuis le dépôt**. Une route
> ajoutée à la main sur le VPS **disparaît au prochain déploiement de
> RaveTycoon**. La route `buzz` doit donc exister **aux deux endroits** :
>
> - sur le serveur, `/root/ravetycoon/deploy/Caddyfile`, puis rechargement de Caddy ;
> - dans le dépôt, `RaveTycoon/deploy/Caddyfile`, **committé et poussé**.
>
> Si les deux fichiers ont divergé, **réconcilie plutôt que d'écraser** : les
> routes des autres sites (`ravetycoon`, `mppstats`, `socialcircle`, `bingo`) y
> vivent aussi, et les perdre couperait quatre sites d'un coup.

> ⚠️ **DNS : `buzz.jimmydore.fr` a un `A` vers le VPS et aucun `AAAA`.** Ne recrée
> jamais d'enregistrement `AAAA` sur ce nom : l'ancien pointait sur un parking
> IONOS, les clients double-pile préféraient l'IPv6, et les invités en 4G
> atterrissaient sur la page de parking pendant que le site paraissait
> parfaitement fonctionnel en wifi. Un `https://` qui échoue à la poignée de main
> TLS alors que `http://` répond `308` n'est **pas** un problème de DNS : c'est
> Caddy qui n'a pas encore de certificat pour un hostname qu'il ne connaît pas.
> Témoin pour discriminer : `https://bingo.jimmydore.fr/` répond 200 → Caddy et
> l'émission de certificats sont sains.

## Pièges et détails qui ont coûté du temps

### L'alphabet des codes exclut les confusables

```
ACDEFGHJKMNPQRTUVWXY346789
```

26 caractères, 26⁴ = 456 976 combinaisons. Sont **absents** : `Z`, `I`, `L`, `O`,
`S`, `B`, `1`, `0`, `2`, `5`, `8` — un code est lu à voix haute dans une pièce
bruyante et retapé par quelqu'un qui a bu un verre.

> Conséquence pratique : **`ZK4P` est un code impossible** (`Z` n'existe pas dans
> l'alphabet). Il traîne pourtant dans `PROMPT.md` et dans quelques commentaires
> comme exemple. Ne l'utilise pas dans un test ni dans une doc : les vrais codes
> ressemblent à `F9NJ`, `R37K`, `WQHQ`.

La saisie clavier est **tolérante** (minuscules, espaces et tirets ignorés), la
validation d'URL est **stricte**. Les deux ne partagent volontairement pas le même
code.

### Le GUID de la RFC 6455 se termine par `B11`

```js
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
```

Pas `B39`. **`PROMPT.md` §4.1 contient une coquille sur ce point**, et c'est la
seule erreur du projet qu'aucun navigateur ne pardonne : la poignée de main échoue
à tous les coups, sur tous les navigateurs, **sans message utile**. Le premier test
de `server/test/ws.test.mjs` est le vecteur canonique de la RFC — ne touche jamais
à cette constante sans le relancer.

### Le reste

- **`ws: true` dans le proxy Vite.** Sans lui, Vite répond `400` à l'upgrade et la
  WebSocket ne s'établit jamais *en dev seulement* — le pire endroit pour
  découvrir le problème.
- **Aucune extension WebSocket n'est négociée.** Le serveur ne renvoie jamais
  d'en-tête `Sec-WebSocket-Extensions` : `permessage-deflate` doublerait la surface
  de bug pour compresser des messages de 60 octets. `smoke.mjs` échoue exprès si le
  serveur en négocie une.
- **`node:sqlite` exige Node ≥ 22.5** (`engines` de `server/package.json`).
  L'image `node:22-alpine` est bien au-delà.
- **Les buzz des manches passées restent en base.** Ils ne sont jamais affichés ;
  les supprimer coûterait plus cher que de les garder 24 h.
- **La police est auto-hébergée** en `woff2` dans `public/fonts`, jamais un CDN
  Google Fonts : le wifi d'une salle des fêtes est mauvais, et une police qui
  n'arrive pas décale toute la mise en page au pire moment.
- **`/demo`** affiche tous les états de tous les composants (buzzer armé /
  verrouillé / 1er / 5e, liste vide / à 1 / à 12 entrées, déconnecté, session
  pleine, code inconnu) sans serveur. C'est là qu'on vérifie un rendu à 320 px
  avant de toucher un écran réel.
