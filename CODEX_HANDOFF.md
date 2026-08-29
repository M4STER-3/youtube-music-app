# CODEX HANDOFF — YouTube Music App Android

Ce fichier est le contrat technique à suivre pour construire l'APK Android final à partir de ce dépôt.

## Objectif

Construire une application Android native en Java, inspirée ergonomiquement d'un lecteur musical, qui :

- importe des playlists YouTube complètes, y compris 200, 400 ou davantage de vidéos ;
- affiche les titres, chaînes, miniatures et durées ;
- lit les vidéos avec le moteur YouTube déjà fourni ;
- possède une barre de progression avec déplacement dans la vidéo ;
- gère précédent, suivant, play/pause, shuffle, loop et volume ;
- stocke les données localement sur Android ;
- possède un bouton manuel `Update` ;
- rafraîchit aussi les métadonnées YouTube avant leur limite de conservation ;
- ne dépend d'aucun serveur, Cloudflare, Firebase ou backend ;
- produit un APK installable localement.

## Contraintes à respecter

- Android natif.
- Java 17.
- `minSdk 26`.
- Utiliser un SDK Android déjà installé sur la machine ; `compileSdk 35` / `targetSdk 35` sont acceptables pour ce projet local.
- Ne pas installer de framework multiplateforme.
- Ne pas ajouter Capacitor, Tauri, Flutter, React Native ou Jetpack Compose.
- Ne pas ajouter ExoPlayer/Media3 pour YouTube.
- Ne pas ajouter Glide/Picasso : les miniatures peuvent être chargées avec les API Android natives si nécessaire.
- Ne pas réécrire le moteur YouTube sauf si un test reproductible démontre un bug.
- Ne pas télécharger, extraire, convertir ou stocker la vidéo/audio YouTube. La lecture reste dans l'IFrame Player API.

## Fichiers du moteur à utiliser tels quels

Placer dans `app/src/main/assets/` :

```text
player.html
youtube-api.js
android-bridge.js
```

Fichiers de référence Java :

```text
android-reference/AndroidYouTubePlayerHost.java
android-reference/YouTubeWebMessageBridge.java
```

Copier ces classes dans le package Java réel de l'application et ajouter la déclaration `package ...;` correspondante.

`index.html` est l'ancien moteur conservé comme référence. **Ne pas l'utiliser dans l'APK final.**

## Dépendances

Le moteur fourni utilise uniquement des API Android intégrées :

```text
android.webkit.WebView
android.webkit.WebMessage
android.webkit.WebMessagePort
android.webkit.WebSettings
android.webkit.WebViewClient
org.json
```

Aucune dépendance Maven supplémentaire n'est nécessaire pour le lecteur ou le bridge.

## Permission Android

Ajouter au manifeste :

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

## WebView

Utiliser `AndroidYouTubePlayerHost` au lieu de configurer la WebView à nouveau.

Cette classe :

- active JavaScript ;
- active le DOM storage ;
- autorise la lecture pilotée par l'interface native ;
- refuse `file://` et `content://` ;
- refuse le mixed content ;
- active Safe Browsing ;
- bloque les navigations top-level hors de l'origine locale ;
- charge `player.html` avec une origine HTTPS stable :

```text
https://app.local/player.html
```

- installe `youtube-api.js` et `android-bridge.js` uniquement dans la page principale de confiance ;
- utilise un `WebMessagePort`, pas `addJavascriptInterface` ;
- authentifie le handshake avec un nonce aléatoire par chargement.

Exemple conceptuel :

```java
AndroidYouTubePlayerHost host = new AndroidYouTubePlayerHost(webView, listener);
host.load();
```

Fermer le host dans le cycle de vie approprié :

```java
host.close();
```

## Taille du lecteur

Ne jamais utiliser un player YouTube invisible ou minuscule pour extraire seulement l'audio.

Le viewport de l'IFrame Player doit rester conforme aux exigences YouTube, notamment au minimum 200 x 200 px. Prévoir une vraie zone de lecteur visible dans l'interface.

## Bridge Android

Après réception de :

```json
{
  "kind": "bridgeReady"
}
```

Android peut envoyer les commandes au bridge.

### Lecture

Méthodes Java déjà prévues :

```text
sendCommand("play")
sendCommand("pause")
sendCommand("next")
sendCommand("previous")
seekTo(seconds)
getState()
getProgress()
loadVideo(...)
loadPlaylist(...)
```

Les commandes génériques du lecteur incluent :

```text
play
pause
toggle
next
previous
first
restart
seekTo
seekBy
setVolume
setMuted
setLoop
setShuffle
getState
getProgress
recover
```

## Barre de progression

Le lecteur envoie environ quatre événements `progress` par seconde pendant la lecture.

Données principales :

```json
{
  "currentTime": 97.4,
  "duration": 252,
  "progress": 0.3865,
  "loadedFraction": 0.82
}
```

L'UI Android doit :

- mettre à jour sa `SeekBar` à partir de `currentTime` et `duration` ;
- ne pas écraser la position pendant que l'utilisateur est en train de glisser ;
- au relâchement, appeler `seekTo(seconds)` ;
- afficher le temps courant et la durée avec un format `m:ss` ou `h:mm:ss`.

## Événements de lecture

Événements importants :

```text
ready
playing
paused
pauseConfirmed
buffering
cued
ended
videoChanged
progress
seeked
volume
playlistMode
playlistEnded
autoplayBlocked
error
```

### Erreurs YouTube normalisées

Le moteur normalise notamment :

```text
2   -> invalidParameter
5   -> html5PlaybackError
100 -> videoUnavailable
101 -> embeddingForbidden
150 -> embeddingForbidden
153 -> missingClientIdentification
```

Pour une playlist, les vidéos supprimées/privées ou interdites à l'intégration sont automatiquement sautées lorsque c'est possible.

Si `autoplayBlocked` est reçu, afficher l'état en pause et attendre une action explicite de l'utilisateur au lieu de boucler sur `play()`.

## Shuffle et loop

Le moteur gère lui-même les modes YouTube.

Important : ne pas recréer le shuffle dans Java.

Avec `shuffle=true` et `loop=false`, le moteur suit les positions réellement visitées et émet `playlistEnded` lorsque le cycle shuffle est terminé. Les doublons de vidéos restent des entrées distinctes grâce à leur position.

## Import YouTube Data API

Après `bridgeReady`, configurer la clé API en mémoire :

```java
bridge.setYouTubeApiKey(apiKey);
```

Puis :

```java
bridge.getPlaylist(playlistUrlOrId);
```

ou pour Update :

```java
bridge.syncPlaylist(playlistUrlOrId, previousPlaylistJson);
```

Progression reçue :

```text
youtubeDataProgress
```

Étapes possibles :

```text
start
metadata
playlistItems
videoDetails
retry
done
```

Exemple visuel attendu :

```text
Playlist : 50 / 437
Playlist : 100 / 437
...
Durées/détails : 50 / 431
...
```

## Retry réseau

`youtube-api.js` effectue par défaut au maximum 2 retries automatiques uniquement sur les erreurs récupérables :

- panne réseau ;
- HTTP 429 ;
- HTTP 5xx ;
- `backendError` ;
- `internalError` ;
- `rateLimitExceeded` ;
- `userRateLimitExceeded`.

Le délai utilise un backoff exponentiel avec jitter.

Ne pas retenter automatiquement une erreur définitive comme :

```text
quotaExceeded
keyInvalid
playlistNotFound
invalidPlaylistId
```

Le résultat final fournit :

```text
requestsUsed
retriesUsed
```

## Données retournées pour une playlist

Au minimum :

```text
playlistId
title
channelId
channelTitle
thumbnail
reportedItemCount
items
videoIds
playableVideoIds
stats
syncedAt
refreshRecommendedAt
mustRefreshBy
requestsUsed
retriesUsed
```

Par entrée :

```text
playlistItemId
playlistId
position
videoId
title
channelId
channelTitle
thumbnail
durationIso
durationSeconds
durationText
privacyStatus
uploadStatus
available
embeddable
playable
```

Les doublons sont conservés.

Une vidéo disparue de `videos.list` reste dans la playlist mais devient :

```text
available = false
playable = false
```

## Stockage Android local

Utiliser les API Android natives.

### `SharedPreferences`

Pour les petits réglages :

```text
volume
muted
shuffle
loop
lastPlaylistId
lastVideoId
lastPositionSeconds
```

### SQLite avec `SQLiteOpenHelper`

Pour les données structurées.

Schéma recommandé :

```text
playlists
- playlist_id TEXT PRIMARY KEY
- title TEXT
- channel_title TEXT
- thumbnail_url TEXT
- synced_at TEXT
- refresh_recommended_at TEXT
- must_refresh_by TEXT
- reported_item_count INTEGER

playlist_items
- playlist_item_id TEXT PRIMARY KEY
- playlist_id TEXT
- position INTEGER
- video_id TEXT
- title TEXT
- channel_id TEXT
- channel_title TEXT
- thumbnail_url TEXT
- duration_seconds INTEGER
- available INTEGER
- embeddable INTEGER
- playable INTEGER

favorites
- video_id TEXT PRIMARY KEY
- created_at INTEGER

history
- id INTEGER PRIMARY KEY AUTOINCREMENT
- video_id TEXT
- playlist_id TEXT
- played_at INTEGER
- position_seconds REAL
```

Ajouter les index utiles :

```text
playlist_items(playlist_id, position)
history(played_at)
```

Lors d'un Update réussi, utiliser une transaction SQLite pour remplacer/mettre à jour la playlist de façon atomique.

Si l'Update échoue, **garder l'ancienne copie locale**.

## Règle de conservation des données YouTube

Les titres, miniatures, noms de chaînes, durées et autres métadonnées récupérées via les services API YouTube ne doivent pas être conservés indéfiniment sans rafraîchissement.

Le moteur fournit :

```text
syncedAt
refreshRecommendedAt     // J+25
mustRefreshBy            // J+30
```

Comportement attendu dans l'app :

1. Le bouton manuel `Update` fonctionne à tout moment.
2. À partir de `refreshRecommendedAt`, tenter une synchronisation silencieuse quand le réseau est disponible.
3. Ne pas laisser les métadonnées API dépasser `mustRefreshBy` sans les rafraîchir ou les supprimer.
4. Les données créées uniquement par l'app (favoris, réglages, ordre perso, etc.) peuvent rester locales indépendamment du refresh YouTube.

## Miniatures

Pour rester sans bibliothèque externe :

- charger les images réseau hors du thread UI avec `HttpURLConnection` ;
- décoder avec `BitmapFactory` ;
- utiliser `LruCache` en mémoire ;
- si un cache disque est ajouté, l'expirer avec les métadonnées YouTube et le nettoyer lors d'un refresh/suppression.

Ne jamais télécharger/cacher la vidéo ou l'audio YouTube.

## Clé API

Ne jamais commiter la clé dans GitHub.

Pour le développement local, utiliser par exemple une valeur dans `local.properties`, puis l'injecter dans `BuildConfig`.

La clé reste extractible depuis un APK : ce n'est pas un secret parfait sans backend.

Dans Google Cloud :

- limiter la clé à **YouTube Data API v3** ;
- surveiller le quota ;
- si une restriction Android par package/certificat est activée, vérifier que les requêtes REST portent également les en-têtes Android requis avant de compter sur cette restriction.

## Interface recommandée

L'interface est à construire nativement par Codex.

Écrans/sections minimum :

```text
Accueil / Bibliothèque
Playlists
Favoris
Historique
Paramètres
```

Écran playlist :

```text
Nom playlist                       🔄 Update
437 vidéos • synchronisée ...

🔍 Recherche

[miniature] Titre                 3:42
             Chaîne
[miniature] Titre                 4:18
             Chaîne
...
```

Lecteur :

```text
zone vidéo YouTube visible

Titre
Chaîne

1:37 ━━━━━━━●━━━━━━━━ 4:12

⏮   ▶/⏸   ⏭   🔀   🔁   🔊
```

## Performance

Pour plusieurs centaines de vidéos :

- ne pas créer toutes les lignes si une `RecyclerView` suffit ;
- utiliser `RecyclerView` natif ;
- charger les miniatures à la demande ;
- ne jamais faire réseau/SQLite lourd sur le thread UI ;
- conserver l'ordre via `position` ;
- utiliser `playlistItemId` comme identité d'entrée, pas seulement `videoId`, afin de préserver les doublons.

## Tests avant APK

### Tests hors ligne

Ouvrir via serveur local :

```text
offline-tests.html
```

Ce fichier doit réussir les tests simulés sans clé API :

- 420 entrées ;
- pagination ;
- doublon ;
- vidéo indisponible ;
- durée ;
- retry sur erreur 500 ;
- pas de retry sur `quotaExceeded` ;
- dates J+25/J+30 ;
- diff Update ;
- `videos.list` sans `maxResults` lorsqu'un filtre `id` est utilisé.

### Tests réels navigateur

Ouvrir :

```text
test.html
```

Tester :

- `ready` ;
- vidéo unique ;
- progression ;
- seek ;
- playlist > 50 ;
- Update ;
- shuffle ;
- loop ;
- précédent/suivant ;
- bridge simulé.

### Tests Android

Avant de livrer l'APK :

- compiler sans dépendance externe supplémentaire ;
- tester sur émulateur et/ou appareil réel ;
- vérifier `bridgeReady` ;
- vérifier le chargement d'une vidéo ;
- vérifier une playlist de plusieurs centaines d'entrées ;
- tester seek ;
- tester passage automatique à la vidéo suivante ;
- tester shuffle sans loop jusqu'à `playlistEnded` ;
- tester vidéo privée/non intégrable ;
- tester retour réseau après une coupure ;
- tester rotation/resize ;
- tester fermeture/réouverture et restauration de l'état local ;
- tester Update sans perte de données si réseau indisponible.

## Fichiers à ne pas modifier sans raison

```text
player.html
youtube-api.js
android-bridge.js
```

Si une modification est nécessaire, exécuter `offline-tests.html` et `test.html` après la modification.

## Jalons Git disponibles

```text
backup-original-import
milestone-player-api-v1
milestone-playlist-android-bridge-v1
milestone-test-readme-v1
milestone-secure-android-integration-v1
```

Le prochain jalon `milestone-codex-ready-v1` doit représenter la version finale validée avant le travail Android.

## Définition de terminé pour Codex

Le travail est terminé quand :

- le projet Android Java compile ;
- aucun package externe inutile n'a été ajouté ;
- l'interface est utilisable au téléphone ;
- playlists, favoris, historique et réglages survivent au redémarrage ;
- une grande playlist s'importe et se met à jour ;
- la barre de progression est fluide et seek fonctionne ;
- shuffle/loop/précédent/suivant fonctionnent ;
- les erreurs YouTube sont affichées proprement ;
- les métadonnées sont rafraîchies avant la limite de 30 jours ;
- la clé API n'est pas commitée ;
- l'APK est généré et installable.
