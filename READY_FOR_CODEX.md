# Ready for Codex

Le moteur GitHub est prêt pour l'intégration Android.

Point de départ obligatoire : lire `CODEX_HANDOFF.md` avant de modifier le projet.

Fichiers moteur à réutiliser :

- `player.html`
- `youtube-api.js`
- `android-bridge.js`
- `android-reference/AndroidYouTubePlayerHost.java`
- `android-reference/YouTubeWebMessageBridge.java`

Validation automatique : `.github/workflows/validate.yml`.

Tests principaux :

- `tests/youtube-api.test.cjs`
- `offline-tests.html`
- `test-simulated.html`
- `test.html`

Ne pas réécrire le moteur sans bug reproductible. Ne pas ajouter de framework ou dépendance Android externe inutile.
