# Bot d'entraînement crypto

Bot de trading **d'entraînement** : prix réels (Kraken, Coinbase en secours), **argent fictif** (1 000 € au départ).
Aucun compte de trading, aucun argent réel, aucune clé d'API.

Deux portefeuilles fictifs tournent en parallèle sur les mêmes signaux et les mêmes règles de sécurité :
- **Bot prudent (A)** : mise fixe de 25 % du portefeuille par achat.
- **Bot rattrapage (B)** : double sa mise après chaque perte (25 %, 50 %, puis 100 %, jamais plus), revient à 25 % après un gain.
  C'est une martingale, ajoutée pour comparer les deux approches avec de vrais prix.

- **Le bot** (`bot/run.js`) tourne sur GitHub Actions toutes les 5 minutes (`.github/workflows/bot.yml`).
  Il rejoue les bougies de 5 minutes terminées depuis son dernier passage, applique la stratégie et les règles de sécurité,
  puis enregistre l'état du portefeuille sur la branche `data` (`state.json`).
- **Le tableau de bord** (`index.html`) est publié par GitHub Pages. Il lit l'état du bot et affiche les prix
  et la valeur du portefeuille en direct.
- **Les règles** (`bot/engine.js`) sont codées en dur : pas d'effet de levier, 25 % maximum par crypto,
  stop-loss −2 %, objectif +4 %, arrêt du jour à −5 %, coupe-circuit à −20 %, frais simulés.

## Piloter le bot
- **Pause** : onglet Actions → « Bot de trading fictif » → « … » → *Disable workflow*.
- **Remise à zéro** : même page → *Run workflow* → cocher « Remettre le portefeuille à 1 000 € fictifs ».

Ceci n'est pas un conseil en investissement. Un bon résultat en argent fictif ne garantit rien en argent réel.
