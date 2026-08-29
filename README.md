# YouTube Music App — moteur Android

Ce dépôt contient le moteur YouTube préparé pour une application Android native en Java.

Le moteur est désormais séparé de l'interface Android finale : Codex doit construire l'UI, le stockage local et l'APK **autour** des composants fournis, sans réécrire le lecteur.

## À lire en premier pour l'intégration Android

➡️ **`CODEX_HANDOFF.md`**

Ce fichier contient le contrat complet : architecture, WebView, bridge, SQLite, clé API, tests, contraintes YouTube et définition de terminé.

## Architecture cible

```text
Android Java natif
│
├── UI native
├── SQLiteOpenHelper / SharedPreferences
│
└── WebView
    └── https://app.local/player.html
        ├── player.html
        ├── youtube-api.js
        └── android-bridge.js
```

Aucun backend n'est requis.

Aucun framework multiplateforme n'est requis.

## Versions du contrat moteur

```text
YouTubePlayer : 1.2.0
YouTubeData   : 1.1.0
AndroidBridge : 1.3.0
```

## Fichiers principaux

### `player.html`

Lecteur YouTube IFrame API.

Fonctions principales :

```text
play / pause
next / previous
shuffle / loop
seekTo / seekBy
volume / mute
currentTime / duration
progress / loadedFraction
playlistEnded
autoplayBlocked
normalisation des erreurs YouTube
```

Le lecteur garde les doublons de playlist et gère la fin d'un cycle `shuffle=true` + `loop=false` sans réappliquer le shuffle à chaque changement d'état.

### `youtube-api.js`

Client YouTube Data API sans bibliothèque externe.

Il gère :

- playlists de plus de 50 vidéos ;
- pagination automatique ;
- titres, chaînes, miniatures et durées ;
- ordre et doublons ;
- vidéos indisponibles/non intégrables ;
- Update avec diff ;
- retry exponentiel avec jitter sur erreurs temporaires ;
- aucun retry automatique sur erreurs définitives de quota/clé ;
- dates de rafraîchissement recommandées et obligatoires.

Résultat d'import :

```text
syncedAt
refreshRecommendedAt   // J+25
mustRefreshBy          // J+30
requestsUsed
retriesUsed
```

### `android-bridge.js`

Bridge bidirectionnel Android ↔ JavaScript via `WebMessagePort`.

Il transporte :

- commandes lecteur ;
- événements lecteur ;
- import/synchronisation YouTube Data API ;
- progression de l'import ;
- erreurs structurées.

Le handshake Android est lié à l'origine `https://app.local` et protégé par un nonce aléatoire par chargement.

### `android-reference/AndroidYouTubePlayerHost.java`

Configuration WebView de référence, sans dépendance externe.

Elle :

- charge `player.html` depuis les assets ;
- donne à la page l'origine logique `https://app.local` ;
- bloque les navigations top-level non approuvées ;
- active les réglages nécessaires au lecteur ;
- installe le bridge après chargement de la page de confiance.

### `android-reference/YouTubeWebMessageBridge.java`

API Java de référence pour :

```text
play/pause/seek
loadVideo/loadPlaylist
getState/getProgress
setYouTubeApiKey
getPlaylist
syncPlaylist
```

### `test.html`

Test manuel réel du lecteur et de l'API YouTube.

À ouvrir via HTTP/HTTPS local, jamais directement avec `file://`.

### `offline-tests.html`

Test navigateur **sans réseau et sans quota**.

Il simule notamment une playlist de 420 entrées, un doublon, une vidéo indisponible, un retry 500 et une erreur `quotaExceeded`.

### `tests/youtube-api.test.cjs`

Même scénario sous Node, sans dépendance de test.

Commande locale :

```bash
node tests/youtube-api.test.cjs
```

### `.github/workflows/validate.yml`

Validation GitHub prévue pour :

- syntaxe de `youtube-api.js` ;
- syntaxe de `android-bridge.js` ;
- syntaxe des scripts inline HTML ;
- scénario de régression YouTube Data API.

Si GitHub Actions n'est pas activé sur le dépôt, le même test Node peut être lancé localement.

## Contraintes Android prévues

```text
Android natif
Java 17
minSdk 26
pas de Capacitor
pas de Tauri
pas de Flutter
pas de React Native
pas de Compose requis
pas d'ExoPlayer/Media3 pour YouTube
```

Les classes de référence Java n'ont volontairement pas de déclaration `package`; Codex doit les placer dans le package réel de l'application.

Permission manifeste :

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

## Données locales

Recommandation sans package externe :

```text
SharedPreferences
→ volume, mute, shuffle, loop, dernière lecture

SQLiteOpenHelper
→ playlists, entrées, favoris, historique
```

Toujours identifier une entrée de playlist avec `playlistItemId`, pas uniquement `videoId`, afin de préserver les doublons.

## Règle de rafraîchissement YouTube

Les métadonnées issues de l'API YouTube ne doivent pas rester stockées indéfiniment sans actualisation.

Le moteur calcule :

```text
refreshRecommendedAt = synchronisation + 25 jours
mustRefreshBy        = synchronisation + 30 jours
```

L'app doit conserver le bouton manuel `Update` et tenter une synchronisation avant la limite de 30 jours.

Les données créées uniquement par l'app — favoris, réglages, ordre personnel — peuvent rester locales indépendamment du refresh YouTube.

## Sécurité clé API

Ne jamais commiter une vraie clé dans ce dépôt.

La clé peut être injectée à l'exécution :

```java
bridge.setYouTubeApiKey(apiKey);
```

Sans backend, une clé incluse dans l'APK reste techniquement extractible. Limiter au minimum la clé à **YouTube Data API v3** dans Google Cloud et surveiller son quota.

## Contraintes YouTube de lecture

- Ne pas télécharger/cacher la vidéo ou l'audio YouTube.
- Ne pas extraire uniquement l'audio.
- Garder la lecture dans l'IFrame Player API.
- Prévoir un player visible avec un viewport conforme aux exigences YouTube, notamment au moins 200 × 200 px.

## Tests avant passage à Codex

Ordre conseillé :

```text
1. node tests/youtube-api.test.cjs
2. offline-tests.html
3. test.html avec une vraie vidéo
4. test.html avec une vraie playlist > 50 vidéos
5. test shuffle/loop/seek
6. test bridge simulé
```

Puis Codex peut commencer la partie Android en suivant **`CODEX_HANDOFF.md`**.

## Jalons Git

```text
backup-original-import
milestone-player-api-v1
milestone-playlist-android-bridge-v1
milestone-test-readme-v1
milestone-secure-android-integration-v1
```

Le jalon final destiné au handoff sera :

```text
milestone-codex-ready-v1
```

`test-youtube` n'est pas modifié par ce dépôt : l'ancien projet reste indépendant.
