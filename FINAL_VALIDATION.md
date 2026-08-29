# Final validation

État avant handoff Codex : **validé**.

- GitHub Actions `Validate engine` : succès sur `main`.
- Syntaxe vérifiée pour `youtube-api.js`, `android-bridge.js` et les scripts inline HTML.
- Régression YouTube Data API simulée : 420 entrées, pagination, doublon, indisponible, retry/backoff, diff Update et dates de rafraîchissement.
- `player.html` : progression, durée, seek, erreurs YouTube normalisées, `onAutoplayBlocked`, shuffle/loop et fin de cycle.
- Bridge Android : `WebMessagePort`, origine HTTPS locale contrôlée, nonce par chargement, import/update playlists et événements.

Lire `CODEX_HANDOFF.md` avant l'intégration Android.
