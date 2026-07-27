# Anton — la display d'affiche du jeu

`anton-latin.woff2` : sous-ensemble latin d'**Anton** (Vernon Adams, Cyreal),
distribué sous **SIL Open Font License 1.1** — https://openfontlicense.org

Source : https://fonts.google.com/specimen/Anton
Fichier repris tel quel du projet voisin `music-bingo` (même sous-ensemble).

Auto-hébergée à dessein, jamais servie depuis un CDN Google Fonts :

- le wifi d'une salle des fêtes lâche, et une police qui n'arrive pas décale
  toute la mise en page au pire moment de la soirée ;
- aucune requête vers un tiers, donc aucune fuite d'IP des invités ;
- sur Android, la pile système ne propose rien d'équivalent : sans le fichier,
  l'identité typographique n'existerait que sur iOS.

Déclarée en `@font-face` sous le nom **`Plateau`** dans `src/index.css`, avec
`font-display: swap` et des surcharges de métrique (`ascent-override`,
`descent-override`) calées sur le repli `Arial Narrow` / `Haettenschweiler` :
le swap ne doit pas faire sauter un rang de trois pixels au moment exact où le
maître du jeu le lit.
