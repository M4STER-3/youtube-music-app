# YouTube Music App — moteur

Ce dépôt contient le moteur YouTube destiné à une future application Android native en Java.

Le dépôt fournit la partie lecture, synchronisation YouTube et communication WebView. L'interface Android finale, le stockage SQLite et l'APK seront construits séparément autour de ce moteur.

## Objectifs

Le moteur permet de :

- lire une vidéo ou une playlist YouTube ;
- gérer play/pause, précédent/suivant, shuffle et loop ;
- récupérer le temps courant, la durée et le buffer ;
- déplacer la lecture avec une barre de progression ;
- importer des playlists de plus de 50 vidéos ;
- récupérer titres, chaînes, miniatures et durées ;
- synchroniser une playlist avec un bouton Update ;
- transmettre ces données à Android sans dépendance externe ;
- utiliser une WebView avec une origine HTTPS stable et un canal `WebMessagePort`.

## Règles d'architecture

Application cible :

- Android natif ;
- Java 17 ;
- `minSdk 26` ;
- aucune dépendance Android externe nécessaire pour ce moteur ;
- pas de Capacitor ;
- pas de Tauri ;
- pas de Flutter ;
- pas de React Native ;
- pas de Jetpack Compose requis ;
- pas d'ExoPlayer/Media3 requis pour YouTube ;
- lecture YouTube via l'IFrame Player API dans une WebView.

**Ne pas réécrire `player.html` dans l'application Android.** L'interface native doit utiliser les APIs documentées ici.

`index.html` est l'ancien moteur d'origine conservé comme référence. La nouvelle application doit utiliser `player.html`.

---

# Fichiers

## `player.html`

Moteur de lecture principal.

API JavaScript :

```js
window.YouTubePlayer
```

Version actuelle du contrat lecteur :

```text
1.1.x
```

Le lecteur peut démarrer sans média, puis recevoir une vidéo ou une playlist plus tard.

Il n'accepte le protocole `window.postMessage` historique que depuis un parent **same-origin** de confiance. Android n'utilise pas ce protocole : Android utilise le `WebMessagePort` décrit plus bas.

## `youtube-api.js`

Client YouTube Data API sans dépendance externe.

API publique :

```js
window.YouTubeData
```

Il gère :

- extraction de l'ID de playlist ;
- pagination `playlistItems.list` par groupes de 50 ;
- récupération des détails vidéo par groupes de 50 ;
- conservation de l'ordre et des doublons ;
- durées ISO 8601 -> secondes ;
- miniatures ;
- vidéos indisponibles ;
- vidéos non intégrables ;
- progression d'import ;
- synchronisation et diff d'Update.

## `android-bridge.js`

Adaptateur JavaScript entre Android et :

```text
YouTubePlayer
YouTubeData
```

Le bridge sait donc commander le lecteur **et** importer/synchroniser des playlists.

Le bridge est injecté depuis les assets de l'APK après le chargement de la page de confiance.

## `android-reference/YouTubeWebMessageBridge.java`

Classe Java de référence utilisant uniquement :

- `WebView` ;
- `WebMessage` ;
- `WebMessagePort` ;
- `org.json`.

Elle :

- injecte `youtube-api.js` ;
- injecte `android-bridge.js` ;
- crée le `WebMessagePort` ;
- envoie les commandes du lecteur ;
- envoie les commandes YouTube Data API ;
- reçoit les événements, progressions et réponses.

## `android-reference/AndroidYouTubePlayerHost.java`

Bootstrap WebView de référence.

Il configure une WebView native sans package supplémentaire et charge `player.html` depuis les assets avec :

```text
https://app.local/player.html
```

Cette URL est une identité locale logique : aucun serveur `app.local` n'est contacté pour charger `player.html`.

Le HTML est fourni directement à `loadDataWithBaseURL()`.

Le host :

- active JavaScript car le moteur en a besoin ;
- active DOM storage ;
- enlève la seconde barrière de geste WebView pour la lecture ;
- interdit l'accès aux fichiers locaux ;
- interdit les URL `content://` ;
- interdit le contenu mixte HTTP dans la page HTTPS ;
- active Safe Browsing ;
- bloque toute navigation **top-level** hors de `https://app.local` ;
- laisse les sous-frames YouTube fonctionner ;
- installe le bridge uniquement après le chargement de la page de confiance.

## `test.html`

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

---

# API du lecteur

## Charger une vidéo

```js
YouTubePlayer.loadVideo("VIDEO_ID", {
  autoplay: true,
  startSeconds: 0,
});
```

## Charger une playlist connue par l'application

```js
YouTubePlayer.loadPlaylist({
  playlistId: "PLAYLIST_ID",
  playlistIds: ["VIDEO_ID_1", "VIDEO_ID_2"],
  index: 0,
  autoplay: true,
  shuffle: false,
  loop: false,
  startSeconds: 0,
});
```

Les doublons dans `playlistIds` sont autorisés et conservés.

## Contrôles

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

## État et progression

```js
const state = YouTubePlayer.getState();
const progress = YouTubePlayer.getProgress();
const currentTime = YouTubePlayer.getCurrentTime();
const duration = YouTubePlayer.getDuration();
```

Exemple :

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

L'interface Android peut afficher :

```text
1:37  ━━━━━━━●━━━━━━━━━━  4:12
```

---

# Événements du lecteur

Canal logique :

```text
focus-hub-youtube
```

Événements principaux :

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
playlistEnded
snapshot
error
```

`progress` est émis régulièrement pendant la lecture afin que l'interface native puisse animer la barre sans interroger YouTube en boucle.

---

# Sécurité de l'origine

`player.html` calcule son origine de confiance à partir de :

```js
window.location.origin
```

Les origines `file:`, `data:` et les origines `null` ne sont pas considérées comme de confiance.

Android doit charger la page avec l'origine :

```text
https://app.local
```

Cette origine est aussi fournie au lecteur YouTube via le paramètre IFrame API :

```text
origin=https://app.local
```

Le protocole historique `window.postMessage` n'accepte que :

- le `window.parent` direct ;
- la même origine que `player.html`.

Il n'y a plus de `postMessage(..., "*")` dans le nouveau lecteur.

---

# YouTube Data API

## Premier import en JavaScript

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

Chaque entrée peut contenir :

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

## Update en JavaScript

```js
const updated = await YouTubeData.syncPlaylist(
  playlistUrlOrId,
  ancienneCopie,
  { apiKey, onProgress }
);
```

Diff :

```text
added
removed
moved
changed
```

---

# Clé YouTube API

**Ne jamais commiter une vraie clé API dans ce dépôt.**

En JavaScript :

```js
YouTubeData.setApiKey(apiKey);
```

Dans Android :

```java
bridge.setYouTubeApiKey(apiKey);
```

La clé est alors conservée seulement dans la mémoire JavaScript du WebView. `android-bridge.js` ne la renvoie jamais dans ses réponses.

L'application finale devra définir sa propre méthode de configuration de la clé et les restrictions Google Cloud appropriées.

---

# Bridge Android

Architecture :

```text
Android Java
     │
     │ WebMessagePort
     ▼
android-bridge.js
     ├─────────────► YouTubePlayer
     │
     └─────────────► YouTubeData
```

Handshake :

```text
youtube-player-bridge
```

Le `targetOrigin` Java doit être exactement :

```text
https://app.local
```

Il ne faut pas utiliser `*` dans l'intégration finale.

## Commandes lecteur côté Java

Exemples :

```java
bridge.sendCommand("play");
bridge.sendCommand("pause");
bridge.seekTo(135);
bridge.getProgress();
bridge.getState();
bridge.loadVideo(videoId, true, 0);
bridge.loadPlaylist(playlistId, ids, 0, true, false, false, 0);
```

## Commandes Data API côté Java

Configurer la clé :

```java
bridge.setYouTubeApiKey(apiKey);
```

Importer :

```java
long requestId = bridge.getPlaylist(playlistUrlOrId);
```

Mettre à jour :

```java
long requestId = bridge.syncPlaylist(playlistUrlOrId, previousPlaylistJson);
```

Pendant l'import, Android reçoit :

```json
{
  "bridge": "youtube-player-bridge",
  "kind": "bridgeEvent",
  "event": "youtubeDataProgress",
  "requestId": 42,
  "data": {
    "stage": "playlistItems",
    "loaded": 150,
    "total": 437
  }
}
```

À la fin, Android reçoit une réponse compacte : les descriptions longues ne sont volontairement pas renvoyées par le bridge afin d'éviter des messages inutilement volumineux.

## Réponse générique

```json
{
  "bridge": "youtube-player-bridge",
  "kind": "response",
  "id": 12,
  "ok": true,
  "result": {}
}
```

## Événement lecteur vers Android

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

---

# Intégration Android recommandée

Assets à copier dans :

```text
app/src/main/assets/
```

Fichiers :

```text
player.html
youtube-api.js
android-bridge.js
```

Classes Java de référence :

```text
AndroidYouTubePlayerHost.java
YouTubeWebMessageBridge.java
```

Permission manifeste obligatoire :

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

Création :

```java
AndroidYouTubePlayerHost host = new AndroidYouTubePlayerHost(
    webView,
    new AndroidYouTubePlayerHost.Listener() {
        @Override
        public void onBridgeMessage(String json) {
            // parser les événements/réponses
        }
    }
);

host.load();
```

Puis, après réception du message `bridgeReady` :

```java
YouTubeWebMessageBridge bridge = host.getBridge();
bridge.setYouTubeApiKey(apiKey);
```

À la destruction de l'écran :

```java
host.close();
```

---

# Données locales Android

Sans package externe :

- réglages simples : `SharedPreferences` ;
- playlists, vidéos, favoris, historique : SQLite avec `SQLiteOpenHelper`.

Données playlist utiles :

```text
playlistId
title
thumbnail
syncedAt
```

Données par entrée :

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

---

# Test manuel navigateur

`player.html` n'accepte plus une origine `file://` pour le protocole parent. Il faut donc servir les fichiers avec un serveur HTTP/HTTPS local.

Ouvrir :

```text
test.html
```

Ordre conseillé :

1. vérifier `ready` ;
2. charger une vidéo ;
3. tester play/pause ;
4. tester seek et ±10 s ;
5. vérifier `duration` / `currentTime` ;
6. saisir temporairement une clé API ;
7. importer une playlist > 50 vidéos ;
8. vérifier miniatures et durées ;
9. lancer la playlist ;
10. tester shuffle/loop/précédent/suivant ;
11. lancer Update ;
12. tester le bridge simulé.

---

# Points de restauration Git

```text
backup-original-import
milestone-player-api-v1
milestone-playlist-android-bridge-v1
milestone-test-readme-v1
```

- `backup-original-import` : copie initiale ;
- `milestone-player-api-v1` : durée, progression, seek ;
- `milestone-playlist-android-bridge-v1` : grandes playlists + premier pont Android ;
- `milestone-test-readme-v1` : page de test + premier contrat complet.

Un nouveau jalon doit être créé après validation des améliorations de sécurité Android.

---

# Ce que Codex devra faire plus tard

Codex devra principalement :

1. créer l'application Android Java native ;
2. copier les trois assets web ;
3. reprendre les deux classes Java de référence ;
4. construire l'interface type lecteur musical ;
5. créer le stockage SQLite local ;
6. relier boutons, barre, playlists et bibliothèque aux APIs documentées ;
7. produire et tester l'APK.

Codex ne devrait pas remplacer le moteur YouTube, recréer la pagination YouTube Data API ou changer le bridge sans raison précise.
