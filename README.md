# YouTube Music App — moteur

Ce dépôt contient le moteur YouTube destiné à une future application Android native en Java.

Le but du dépôt n'est **pas** de contenir l'interface Android finale. Il fournit une base stable pour :

- lire des vidéos et playlists YouTube ;
- gérer play/pause, précédent/suivant, shuffle et loop ;
- récupérer le temps courant, la durée et le buffer ;
- déplacer la lecture avec une barre de progression ;
- importer des playlists de plus de 50 vidéos avec la YouTube Data API ;
- récupérer titres, chaînes, miniatures et durées ;
- synchroniser une playlist avec un bouton Update ;
- communiquer proprement avec une WebView Android native.

## Règles d'architecture

Application cible :

- Android natif ;
- Java 17 ;
- minSdk 26 ;
- aucune dépendance Android externe nécessaire pour ce moteur ;
- pas de Capacitor ;
- pas de Tauri ;
- pas de Flutter ;
- pas de React Native ;
- pas de Jetpack Compose requis ;
- pas d'ExoPlayer/Media3 requis pour YouTube ;
- lecture YouTube via l'IFrame Player API dans une WebView.

**Ne pas réécrire `player.html` dans l'application Android.** L'interface Android doit envoyer des commandes au moteur et afficher les événements qu'il retourne.

`index.html` est l'ancien moteur d'origine conservé comme référence. La nouvelle application doit utiliser `player.html`.

## Fichiers

### `player.html`

Moteur de lecture YouTube principal.

Il peut être chargé sans vidéo initiale, puis recevoir une vidéo ou une playlist plus tard.

API publique JavaScript :

```js
window.YouTubePlayer
```

### `youtube-api.js`

Client YouTube Data API sans dépendance externe.

API publique :

```js
window.YouTubeData
```

Il gère :

- extraction de l'ID d'une playlist ;
- pagination `playlistItems.list` par groupes de 50 ;
- récupération des détails vidéo par groupes de 50 ;
- durées ISO 8601 -> secondes ;
- miniatures ;
- vidéos indisponibles ;
- vidéos non intégrables ;
- progression d'import ;
- synchronisation et diff d'Update.

### `android-bridge.js`

Adaptateur JavaScript entre `player.html` et un `WebMessagePort` Android.

Il n'est pas nécessaire de modifier `player.html` pour le connecter à Android : Android peut injecter ce fichier après le chargement de la page.

### `android-reference/YouTubeWebMessageBridge.java`

Classe Java de référence utilisant uniquement les API Android :

- `WebView` ;
- `WebMessage` ;
- `WebMessagePort` ;
- `org.json`.

Elle sert de modèle pour l'application finale.

### `test.html`

Interface de développement uniquement.

Elle teste :

- vidéo unique ;
- play/pause ;
- précédent/suivant ;
- shuffle/loop ;
- progression ;
- durée ;
- seek ;
- buffer ;
- import d'une playlist complète ;
- affichage des métadonnées ;
- Update/diff ;
- simulation du bridge Android avec `MessageChannel`.

La clé API saisie dans `test.html` reste en mémoire et n'est pas enregistrée.

## API du lecteur

### Charger une vidéo

```js
YouTubePlayer.loadVideo("VIDEO_ID", {
  autoplay: true,
  startSeconds: 0,
});
```

### Charger une playlist déjà connue par l'application

```js
YouTubePlayer.loadPlaylist({
  playlistId: "PLAYLIST_ID",
  playlistIds: ["VIDEO_ID_1", "VIDEO_ID_2"],
  index: 0,
  autoplay: true,
  shuffle: false,
  loop: false,
});
```

Les doublons dans `playlistIds` sont autorisés et conservés.

### Contrôles

```js
YouTubePlayer.play();
YouTubePlayer.pause();
YouTubePlayer.toggle();
YouTubePlayer.next();
YouTubePlayer.previous();
YouTubePlayer.first();
YouTubePlayer.restart();

YouTubePlayer.seekTo(125);
YouTubePlayer.seekBy(10);
YouTubePlayer.seekBy(-10);

YouTubePlayer.setVolume(70);
YouTubePlayer.setMuted(false);
YouTubePlayer.setShuffle(true);
YouTubePlayer.setLoop(true);
```

### État

```js
const state = YouTubePlayer.getState();
const progress = YouTubePlayer.getProgress();
const currentTime = YouTubePlayer.getCurrentTime();
const duration = YouTubePlayer.getDuration();
```

Exemple de progression :

```json
{
  "state": 1,
  "stateName": "playing",
  "currentVideoId": "xxxxxxxxxxx",
  "currentTime": 97.4,
  "duration": 252,
  "progress": 0.3865,
  "loadedFraction": 0.82
}
```

L'interface Android peut utiliser ces données pour afficher une barre comme :

```text
1:37  ━━━━━━━●━━━━━━━━━━  4:12
```

## Événements du lecteur

`player.html` publie des événements structurés sur le canal :

```text
focus-hub-youtube
```

Événements principaux :

- `ready`
- `playing`
- `paused`
- `pauseConfirmed`
- `buffering`
- `cued`
- `ended`
- `videoChanged`
- `progress`
- `seeked`
- `volume`
- `playlistEnded`
- `snapshot`
- `error`

Pendant la lecture, `progress` est émis régulièrement afin que l'interface native puisse animer la barre sans interroger YouTube en boucle.

## Commandes génériques

Le lecteur accepte aussi le protocole historique :

```js
{
  channel: "focus-hub-youtube",
  kind: "command",
  command: "seekTo",
  value: { seconds: 120 }
}
```

Commandes :

```text
loadMedia
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
setPresentationMode
setViewportSize
getState
getProgress
recover
```

## YouTube Data API

### Premier import

```js
const playlist = await YouTubeData.getPlaylist(playlistUrlOrId, {
  apiKey,
  includeVideoDetails: true,
  onProgress(info) {
    console.log(info);
  },
});
```

Le résultat contient notamment :

```text
playlistId
title
channelTitle
thumbnail
reportedItemCount
items
videoIds
playableVideoIds
stats
syncedAt
requestsUsed
```

Chaque entrée de `items` peut contenir :

```text
playlistItemId
position
videoId
title
channelId
channelTitle
thumbnail
durationIso
durationSeconds
durationText
available
embeddable
playable
privacyStatus
uploadStatus
```

### Update

```js
const updated = await YouTubeData.syncPlaylist(
  playlistUrlOrId,
  ancienneCopie,
  { apiKey, onProgress }
);
```

Le résultat contient aussi :

```js
updated.diff.counts
```

avec :

```text
added
removed
moved
changed
```

L'application Android peut ensuite remplacer sa copie locale par `updated` après une synchronisation réussie.

## Clé YouTube API

**Ne jamais commiter une vraie clé API dans ce dépôt.**

Le moteur accepte une clé injectée à l'exécution :

```js
YouTubeData.setApiKey(apiKey);
```

ou directement pour une requête :

```js
YouTubeData.getPlaylist(id, { apiKey });
```

L'application Android devra conserver la clé hors des fichiers publics du dépôt et appliquer les restrictions disponibles dans Google Cloud.

## Bridge Android recommandé

Pour ce projet, préférer `WebMessagePort` à `addJavascriptInterface`.

Architecture :

```text
Java Android
    │
    │ WebMessagePort
    ▼
android-bridge.js
    │
    ▼
YouTubePlayer
    │
    ▼
IFrame Player API
```

Le handshake JavaScript est :

```text
youtube-player-bridge
```

### Exemple Android -> JavaScript

```json
{
  "id": 12,
  "action": "command",
  "command": "seekTo",
  "value": {
    "seconds": 135
  }
}
```

### Exemple réponse

```json
{
  "bridge": "youtube-player-bridge",
  "kind": "response",
  "id": 12,
  "ok": true,
  "result": {
    "accepted": true
  }
}
```

### Événement player -> Android

```json
{
  "bridge": "youtube-player-bridge",
  "kind": "playerEvent",
  "payload": {
    "channel": "focus-hub-youtube",
    "kind": "event",
    "event": "progress",
    "data": {
      "currentTime": 42.5,
      "duration": 240
    }
  }
}
```

## Chargement dans la WebView

Recommandation sans package supplémentaire : lire `player.html` depuis les assets Android puis utiliser un contexte local contrôlé pour la page. Le bridge doit être installé seulement après le chargement du `player.html` de confiance.

Le `targetOrigin` du `WebMessagePort` doit être explicite quand l'intégration choisie fournit une origine stable.

Si l'intégration finale doit utiliser `*` pour amorcer le canal avec une page locale, la WebView doit empêcher toute navigation top-level vers une page non approuvée.

Ne pas exposer le canal Android à une page web arbitraire.

## Données locales de l'application Android

Ce dépôt ne choisit pas l'interface ni la base finale, mais l'application native peut stocker sans package externe :

- réglages simples dans `SharedPreferences` ;
- playlists, vidéos, favoris et historique dans SQLite via `SQLiteOpenHelper`.

Données utiles à persister pour une playlist :

```text
playlistId
title
thumbnail
syncedAt
```

Données utiles par entrée :

```text
playlistItemId
playlistId
position
videoId
title
channelTitle
thumbnail URL
durationSeconds
available
embeddable
playable
```

État de lecture utile :

```text
currentVideoId
playlistId
playlistIndex
currentTime
volume
muted
shuffle
loop
```

## Test manuel avant intégration Android

Servir le dossier avec un serveur HTTP/HTTPS local, puis ouvrir :

```text
test.html
```

Ordre conseillé :

1. vérifier que le lecteur devient `ready` ;
2. charger une vidéo unique ;
3. tester play/pause ;
4. tester la barre seek et ±10 s ;
5. vérifier `duration` et `currentTime` ;
6. saisir temporairement une clé API et une playlist ;
7. importer une playlist de plus de 50 vidéos ;
8. vérifier titres, miniatures et durées ;
9. lancer la playlist dans le player ;
10. tester shuffle/loop/suivant/précédent ;
11. lancer Update et vérifier le diff ;
12. cliquer sur « Tester le bridge Android ».

## Points de restauration Git

Branches de jalon créées pendant le développement :

```text
backup-original-import
milestone-player-api-v1
milestone-playlist-android-bridge-v1
```

`backup-original-import` correspond à la copie initiale avant les nouvelles modifications.

`milestone-player-api-v1` correspond au lecteur avec durée, progression et seek.

`milestone-playlist-android-bridge-v1` correspond au lecteur + grandes playlists + pont Android.

## Ce que Codex devra faire plus tard

Codex devra principalement :

1. créer l'application Android Java native ;
2. placer les fichiers web nécessaires dans les assets ;
3. intégrer le `WebView` et le `WebMessagePort` ;
4. construire l'interface type lecteur musical ;
5. stocker les données localement ;
6. relier boutons, barre de progression et listes aux APIs documentées ici ;
7. produire et tester l'APK.

Il ne devrait pas être nécessaire de remplacer le moteur YouTube ni d'ajouter un framework multiplateforme.
