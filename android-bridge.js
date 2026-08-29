(function (global) {
  "use strict";

  const BRIDGE_VERSION = "1.4.0";
  const HANDSHAKE = "youtube-player-bridge";
  const EVENT_NAME = "youtube-player-event";
  const AUTOPLAY_GUARD_MS = 2500;
  const NATIVE_NONCE = String(global.__ANDROID_BRIDGE_NONCE || "");
  try { delete global.__ANDROID_BRIDGE_NONCE; } catch {}

  let port = null;
  let portGeneration = 0;
  let autoplayGuardTimer = 0;
  let shuffleVisited = new Set();
  let shuffleCycleSignature = "";

  function safeJsonParse(value) {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return null; }
  }

  function post(message) {
    if (!port) return false;
    try { port.postMessage(JSON.stringify(message)); return true; } catch { return false; }
  }

  function response(id, ok, result = null, error = null) {
    post({ bridge: HANDSHAKE, bridgeVersion: BRIDGE_VERSION, kind: "response", id: id ?? null,
      ok: !!ok, result, error, timestamp: Date.now() });
  }

  function bridgeEvent(event, data = null, requestId = null) {
    post({ bridge: HANDSHAKE, bridgeVersion: BRIDGE_VERSION, kind: "bridgeEvent", event,
      requestId, data, timestamp: Date.now() });
  }

  function normalizedError(error, fallbackCode = "javascriptError") {
    return {
      code: String(error?.code || error?.reason || fallbackCode),
      reason: String(error?.reason || ""),
      message: String(error?.message || error || "Erreur JavaScript"),
      status: Number(error?.status) || 0,
      retryable: !!error?.retryable,
      retryAfterMs: Math.max(0, Number(error?.retryAfterMs) || 0),
    };
  }

  function semanticPlayerError(code) {
    const numeric = Number(code) || 0;
    const map = {
      2: ["invalidVideoParameter", "Paramètre vidéo invalide."],
      5: ["html5PlayerError", "Le lecteur HTML5 YouTube n’a pas pu lire cette vidéo."],
      100: ["videoUnavailable", "La vidéo est supprimée, privée ou indisponible."],
      101: ["embeddingForbidden", "Le propriétaire interdit la lecture intégrée de cette vidéo."],
      150: ["embeddingForbidden", "Le propriétaire interdit la lecture intégrée de cette vidéo."],
      153: ["missingClientIdentification", "YouTube n’a pas reçu une identification d’origine/client valide."],
    };
    const value = map[numeric] || ["youtubePlayerError", `Erreur du lecteur YouTube (${numeric || "inconnue"}).`];
    return { code: value[0], message: value[1], youtubeCode: numeric };
  }

  function clearAutoplayGuard() {
    global.clearTimeout(autoplayGuardTimer);
    autoplayGuardTimer = 0;
  }

  function armAutoplayGuard(context = "play") {
    clearAutoplayGuard();
    autoplayGuardTimer = global.setTimeout(() => {
      autoplayGuardTimer = 0;
      const state = global.YouTubePlayer?.getState?.() || {};
      if (["playing", "buffering"].includes(String(state.stateName || ""))) return;
      bridgeEvent("autoplayBlocked", {
        inferred: true,
        context,
        stateName: String(state.stateName || "unknown"),
        currentVideoId: String(state.currentVideoId || ""),
      });
    }, AUTOPLAY_GUARD_MS);
  }

  function resetShuffleCycle() {
    shuffleVisited = new Set();
    shuffleCycleSignature = "";
  }

  function observeShuffleState(data) {
    if (!data || data.mediaType !== "playlist" || !data.shuffleEnabled) return;
    const length = Math.max(0, Number(data.playlistLength) || 0);
    const signature = `${String(data.playlistId || "")}|${length}|${Number(data.canonicalPlaylistLength) || 0}`;
    if (signature !== shuffleCycleSignature) {
      shuffleCycleSignature = signature;
      shuffleVisited = new Set();
    }
    const index = Number(data.playlistIndex);
    if (Number.isFinite(index) && index >= 0) shuffleVisited.add(Math.floor(index));
  }

  function compactThumbnail(thumbnail) {
    return {
      url: String(thumbnail?.url || ""), width: Math.max(0, Number(thumbnail?.width) || 0),
      height: Math.max(0, Number(thumbnail?.height) || 0), quality: String(thumbnail?.quality || ""),
    };
  }

  function compactPlaylistResult(result) {
    if (!result || typeof result !== "object") return result;
    const items = Array.isArray(result.items) ? result.items : [];
    return {
      apiVersion: String(result.apiVersion || ""), playlistId: String(result.playlistId || ""),
      title: String(result.title || ""), channelId: String(result.channelId || ""),
      channelTitle: String(result.channelTitle || ""), publishedAt: String(result.publishedAt || ""),
      thumbnail: compactThumbnail(result.thumbnail), reportedItemCount: Math.max(0, Number(result.reportedItemCount) || 0),
      privacyStatus: String(result.privacyStatus || ""), syncedAt: String(result.syncedAt || ""),
      refreshRecommendedAt: String(result.refreshRecommendedAt || ""), mustRefreshBy: String(result.mustRefreshBy || ""),
      elapsedMs: Math.max(0, Number(result.elapsedMs) || 0), requestsUsed: Math.max(0, Number(result.requestsUsed) || 0),
      retriesUsed: Math.max(0, Number(result.retriesUsed) || 0), stats: result.stats || null,
      videoIds: Array.isArray(result.videoIds) ? result.videoIds : [],
      playableVideoIds: Array.isArray(result.playableVideoIds) ? result.playableVideoIds : [],
      items: items.map((item) => ({
        playlistItemId: String(item.playlistItemId || ""), playlistId: String(item.playlistId || result.playlistId || ""),
        position: Math.max(0, Number(item.position) || 0), videoId: String(item.videoId || ""),
        title: String(item.title || ""), channelId: String(item.channelId || ""), channelTitle: String(item.channelTitle || ""),
        addedAt: String(item.addedAt || ""), publishedAt: String(item.publishedAt || ""), thumbnail: compactThumbnail(item.thumbnail),
        durationIso: String(item.durationIso || ""), durationSeconds: Math.max(0, Number(item.durationSeconds) || 0),
        durationText: String(item.durationText || ""), privacyStatus: String(item.privacyStatus || ""),
        uploadStatus: String(item.uploadStatus || ""), embeddable: item.embeddable !== false,
        available: !!item.available, playable: !!item.playable,
        liveBroadcastContent: String(item.liveBroadcastContent || "none"),
      })),
      diff: result.diff ? {
        counts: result.diff.counts || null,
        added: Array.isArray(result.diff.added) ? result.diff.added.map((item) => String(item.playlistItemId || "")) : [],
        removed: Array.isArray(result.diff.removed) ? result.diff.removed.map((item) => String(item.playlistItemId || "")) : [],
        moved: Array.isArray(result.diff.moved) ? result.diff.moved : [],
        changed: Array.isArray(result.diff.changed) ? result.diff.changed.map((item) => String(item.playlistItemId || "")) : [],
      } : null,
    };
  }

  async function executeDataRequest(request) {
    const id = request?.id ?? null;
    const action = String(request?.action || "");
    const dataApi = global.YouTubeData;
    if (!dataApi) {
      response(id, false, null, { code: "youtubeDataUnavailable", message: "YouTubeData n’est pas encore disponible" });
      return;
    }
    try {
      switch (action) {
        case "setYouTubeApiKey":
          response(id, true, { configured: dataApi.setApiKey(String(request?.apiKey || "")) }); return;
        case "clearYouTubeApiKey":
          dataApi.clearApiKey(); response(id, true, { configured: false }); return;
        case "hasYouTubeApiKey":
          response(id, true, { configured: !!dataApi.hasApiKey() }); return;
        case "getPlaylist":
        case "syncPlaylist": {
          const playlist = String(request?.playlist || request?.playlistId || "");
          const options = {
            includeVideoDetails: request?.includeVideoDetails !== false,
            maxRetries: request?.maxRetries,
            retryBaseDelayMs: request?.retryBaseDelayMs,
            retryMaxDelayMs: request?.retryMaxDelayMs,
            onProgress(progress) { bridgeEvent("youtubeDataProgress", progress, id); },
          };
          const result = action === "syncPlaylist"
            ? await dataApi.syncPlaylist(playlist, request?.previousPlaylist || null, options)
            : await dataApi.getPlaylist(playlist, options);
          response(id, true, compactPlaylistResult(result)); return;
        }
        default:
          response(id, false, null, { code: "unknownDataAction", message: `Action YouTube Data inconnue: ${action}` });
      }
    } catch (error) {
      response(id, false, null, normalizedError(error, "youtubeDataError"));
    }
  }

  async function executeRequest(request) {
    const id = request?.id ?? null;
    const action = String(request?.action || "");
    if (["setYouTubeApiKey", "clearYouTubeApiKey", "hasYouTubeApiKey", "getPlaylist", "syncPlaylist"].includes(action)) {
      await executeDataRequest(request); return;
    }

    const player = global.YouTubePlayer;
    if (!player) {
      response(id, false, null, { code: "playerUnavailable", message: "YouTubePlayer n’est pas encore disponible" });
      return;
    }
    const value = request?.value;
    try {
      switch (action) {
        case "command": {
          const command = String(request?.command || "");
          if (command === "loadMedia") {
            resetShuffleCycle();
            if (value?.autoplay !== false) armAutoplayGuard("loadMedia");
          } else if (command === "play") {
            armAutoplayGuard("play");
          } else if (command === "pause") {
            clearAutoplayGuard();
          } else if (command === "setShuffle") {
            resetShuffleCycle();
          }
          const accepted = player.command(command, value);
          response(id, true, { accepted: accepted !== false }); return;
        }
        case "getState": response(id, true, player.getState()); return;
        case "getProgress": response(id, true, player.getProgress()); return;
        case "isReady": response(id, true, { ready: !!player.isReady?.() }); return;
        case "loadVideo": {
          resetShuffleCycle();
          if (request?.options?.autoplay !== false) armAutoplayGuard("loadVideo");
          const accepted = player.loadVideo(String(request?.videoId || ""), request?.options || {});
          response(id, true, { accepted: accepted !== false }); return;
        }
        case "loadPlaylist": {
          resetShuffleCycle();
          if (request?.options?.autoplay !== false) armAutoplayGuard("loadPlaylist");
          const accepted = player.loadPlaylist(request?.options || {});
          response(id, true, { accepted: accepted !== false }); return;
        }
        default:
          response(id, false, null, { code: "unknownAction", message: `Action Android inconnue: ${action}` });
      }
    } catch (error) {
      response(id, false, null, normalizedError(error));
    }
  }

  function handlePortMessage(event, generation) {
    if (generation !== portGeneration) return;
    const request = safeJsonParse(event?.data);
    if (!request || typeof request !== "object") {
      response(null, false, null, { code: "invalidMessage", message: "Message Android invalide" }); return;
    }
    void executeRequest(request);
  }

  function attachPort(nextPort) {
    if (!nextPort || typeof nextPort.postMessage !== "function") return false;
    if (port && port !== nextPort) { try { port.close?.(); } catch {} }
    port = nextPort;
    const generation = ++portGeneration;
    port.onmessage = (event) => handlePortMessage(event, generation);
    port.start?.();
    post({ bridge: HANDSHAKE, bridgeVersion: BRIDGE_VERSION, kind: "bridgeReady",
      playerApiVersion: String(global.YouTubePlayer?.version || ""),
      youtubeDataApiVersion: String(global.YouTubeData?.version || ""),
      playerReady: !!global.YouTubePlayer?.isReady?.(), youtubeDataReady: !!global.YouTubeData,
      timestamp: Date.now() });
    return true;
  }

  global.addEventListener("message", (event) => {
    const message = safeJsonParse(event?.data);
    if (!message || message.bridge !== HANDSHAKE) return;
    if (!NATIVE_NONCE || message.nonce !== NATIVE_NONCE) return;
    const nextPort = event?.ports?.[0];
    if (nextPort) attachPort(nextPort);
  });

  global.addEventListener(EVENT_NAME, (event) => {
    const payload = event?.detail || null;
    if (!payload) return;
    const data = payload.data || {};

    if (["playing", "buffering"].includes(payload.event)) clearAutoplayGuard();
    if (["videoChanged", "playing", "cued"].includes(payload.event)) observeShuffleState(data);

    if (payload.event === "error") {
      clearAutoplayGuard();
      bridgeEvent("playerError", { ...semanticPlayerError(data.code), state: data });
    }

    if (payload.event === "ended") {
      observeShuffleState(data);
      const length = Math.max(0, Number(data.playlistLength) || 0);
      if (data.mediaType === "playlist" && data.shuffleEnabled && !data.loopEnabled && length > 0 && shuffleVisited.size >= length) {
        global.YouTubePlayer?.pause?.();
        bridgeEvent("playlistEnded", {
          reason: "shuffleCycleComplete", playlistId: String(data.playlistId || ""),
          visited: shuffleVisited.size, playlistLength: length,
        });
      }
    }

    if (port) {
      post({ bridge: HANDSHAKE, bridgeVersion: BRIDGE_VERSION, kind: "playerEvent",
        payload, timestamp: Date.now() });
    }
  });

  global.AndroidPlayerBridge = Object.freeze({
    version: BRIDGE_VERSION, handshake: HANDSHAKE,
    isConnected() { return !!port; }, attachPort,
    dispatch(request) { void executeRequest(typeof request === "string" ? safeJsonParse(request) : request); return true; },
  });
})(window);
