(function (global) {
  "use strict";

  const BRIDGE_VERSION = "1.1.1";
  const HANDSHAKE = "youtube-player-bridge";
  const EVENT_NAME = "youtube-player-event";
  let port = null;
  let portGeneration = 0;

  function safeJsonParse(value) {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function post(message) {
    if (!port) return false;
    try {
      port.postMessage(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function response(id, ok, result = null, error = null) {
    post({
      bridge: HANDSHAKE,
      bridgeVersion: BRIDGE_VERSION,
      kind: "response",
      id: id ?? null,
      ok: !!ok,
      result,
      error,
      timestamp: Date.now(),
    });
  }

  function bridgeEvent(event, data = null, requestId = null) {
    post({
      bridge: HANDSHAKE,
      bridgeVersion: BRIDGE_VERSION,
      kind: "bridgeEvent",
      event,
      requestId,
      data,
      timestamp: Date.now(),
    });
  }

  function normalizedError(error, fallbackCode = "javascriptError") {
    return {
      code: String(error?.code || error?.reason || fallbackCode),
      reason: String(error?.reason || ""),
      message: String(error?.message || error || "Erreur JavaScript"),
      status: Number(error?.status) || 0,
      retryable: !!error?.retryable,
    };
  }

  function playerUnavailable(id) {
    response(id, false, null, {
      code: "playerUnavailable",
      message: "YouTubePlayer n’est pas encore disponible",
    });
  }

  function dataApiUnavailable(id) {
    response(id, false, null, {
      code: "youtubeDataUnavailable",
      message: "YouTubeData n’est pas encore disponible",
    });
  }

  function compactThumbnail(thumbnail) {
    return {
      url: String(thumbnail?.url || ""),
      width: Math.max(0, Number(thumbnail?.width) || 0),
      height: Math.max(0, Number(thumbnail?.height) || 0),
      quality: String(thumbnail?.quality || ""),
    };
  }

  // Keep bridge messages reasonably small. Android does not need video descriptions.
  function compactPlaylistResult(result) {
    if (!result || typeof result !== "object") return result;
    const items = Array.isArray(result.items) ? result.items : [];
    return {
      apiVersion: String(result.apiVersion || ""),
      playlistId: String(result.playlistId || ""),
      title: String(result.title || ""),
      channelId: String(result.channelId || ""),
      channelTitle: String(result.channelTitle || ""),
      publishedAt: String(result.publishedAt || ""),
      thumbnail: compactThumbnail(result.thumbnail),
      reportedItemCount: Math.max(0, Number(result.reportedItemCount) || 0),
      privacyStatus: String(result.privacyStatus || ""),
      syncedAt: String(result.syncedAt || ""),
      elapsedMs: Math.max(0, Number(result.elapsedMs) || 0),
      requestsUsed: Math.max(0, Number(result.requestsUsed) || 0),
      stats: result.stats || null,
      videoIds: Array.isArray(result.videoIds) ? result.videoIds : [],
      playableVideoIds: Array.isArray(result.playableVideoIds) ? result.playableVideoIds : [],
      items: items.map((item) => ({
        playlistItemId: String(item.playlistItemId || ""),
        playlistId: String(item.playlistId || result.playlistId || ""),
        position: Math.max(0, Number(item.position) || 0),
        videoId: String(item.videoId || ""),
        title: String(item.title || ""),
        channelId: String(item.channelId || ""),
        channelTitle: String(item.channelTitle || ""),
        addedAt: String(item.addedAt || ""),
        publishedAt: String(item.publishedAt || ""),
        thumbnail: compactThumbnail(item.thumbnail),
        durationIso: String(item.durationIso || ""),
        durationSeconds: Math.max(0, Number(item.durationSeconds) || 0),
        durationText: String(item.durationText || ""),
        privacyStatus: String(item.privacyStatus || ""),
        uploadStatus: String(item.uploadStatus || ""),
        embeddable: item.embeddable !== false,
        available: !!item.available,
        playable: !!item.playable,
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
      dataApiUnavailable(id);
      return;
    }

    try {
      switch (action) {
        case "setYouTubeApiKey": {
          const configured = dataApi.setApiKey(String(request?.apiKey || ""));
          response(id, true, { configured });
          return;
        }
        case "clearYouTubeApiKey":
          dataApi.clearApiKey();
          response(id, true, { configured: false });
          return;
        case "hasYouTubeApiKey":
          response(id, true, { configured: !!dataApi.hasApiKey() });
          return;
        case "getPlaylist":
        case "syncPlaylist": {
          const playlist = String(request?.playlist || request?.playlistId || "");
          const options = {
            includeVideoDetails: request?.includeVideoDetails !== false,
            onProgress(progress) {
              bridgeEvent("youtubeDataProgress", progress, id);
            },
          };
          const result = action === "syncPlaylist"
            ? await dataApi.syncPlaylist(playlist, request?.previousPlaylist || null, options)
            : await dataApi.getPlaylist(playlist, options);
          response(id, true, compactPlaylistResult(result));
          return;
        }
        default:
          response(id, false, null, {
            code: "unknownDataAction",
            message: `Action YouTube Data inconnue: ${action}`,
          });
      }
    } catch (error) {
      response(id, false, null, normalizedError(error, "youtubeDataError"));
    }
  }

  async function executeRequest(request) {
    const id = request?.id ?? null;
    const action = String(request?.action || "");

    if ([
      "setYouTubeApiKey",
      "clearYouTubeApiKey",
      "hasYouTubeApiKey",
      "getPlaylist",
      "syncPlaylist",
    ].includes(action)) {
      await executeDataRequest(request);
      return;
    }

    const value = request?.value;
    const player = global.YouTubePlayer;
    if (!player) {
      playerUnavailable(id);
      return;
    }

    try {
      switch (action) {
        case "command": {
          const command = String(request?.command || "");
          const accepted = player.command(command, value);
          response(id, true, { accepted: accepted !== false });
          break;
        }
        case "getState":
          response(id, true, player.getState());
          break;
        case "getProgress":
          response(id, true, player.getProgress());
          break;
        case "isReady":
          response(id, true, { ready: !!player.isReady?.() });
          break;
        case "loadVideo": {
          const videoId = String(request?.videoId || "");
          const accepted = player.loadVideo(videoId, request?.options || {});
          response(id, true, { accepted: accepted !== false });
          break;
        }
        case "loadPlaylist": {
          const accepted = player.loadPlaylist(request?.options || {});
          response(id, true, { accepted: accepted !== false });
          break;
        }
        default:
          response(id, false, null, {
            code: "unknownAction",
            message: `Action Android inconnue: ${action}`,
          });
      }
    } catch (error) {
      response(id, false, null, normalizedError(error));
    }
  }

  function handlePortMessage(event, generation) {
    if (generation !== portGeneration) return;
    const request = safeJsonParse(event?.data);
    if (!request || typeof request !== "object") {
      response(null, false, null, {
        code: "invalidMessage",
        message: "Message Android invalide",
      });
      return;
    }
    void executeRequest(request);
  }

  function attachPort(nextPort) {
    if (!nextPort || typeof nextPort.postMessage !== "function") return false;

    if (port && port !== nextPort) {
      try { port.close?.(); } catch {}
    }

    port = nextPort;
    const generation = ++portGeneration;
    port.onmessage = (event) => handlePortMessage(event, generation);
    port.start?.();

    post({
      bridge: HANDSHAKE,
      bridgeVersion: BRIDGE_VERSION,
      kind: "bridgeReady",
      playerApiVersion: String(global.YouTubePlayer?.version || ""),
      youtubeDataApiVersion: String(global.YouTubeData?.version || ""),
      playerReady: !!global.YouTubePlayer?.isReady?.(),
      youtubeDataReady: !!global.YouTubeData,
      timestamp: Date.now(),
    });
    return true;
  }

  global.addEventListener("message", (event) => {
    // postWebMessage() from Android may not expose a normal web sender origin/source.
    // targetOrigin is enforced on the native side. If a browser frame is the sender,
    // reject it unless it is the main same-origin window.
    if (event.source && event.source !== global) return;
    if (event.origin && event.origin !== global.location.origin) return;
    if (event?.data !== HANDSHAKE) return;
    const nextPort = event?.ports?.[0];
    if (nextPort) attachPort(nextPort);
  });

  global.addEventListener(EVENT_NAME, (event) => {
    if (!port) return;
    post({
      bridge: HANDSHAKE,
      bridgeVersion: BRIDGE_VERSION,
      kind: "playerEvent",
      payload: event?.detail || null,
      timestamp: Date.now(),
    });
  });

  global.AndroidPlayerBridge = Object.freeze({
    version: BRIDGE_VERSION,
    handshake: HANDSHAKE,
    isConnected() { return !!port; },
    attachPort,
    dispatch(request) {
      void executeRequest(typeof request === "string" ? safeJsonParse(request) : request);
      return true;
    },
  });
})(window);
