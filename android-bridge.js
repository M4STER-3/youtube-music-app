(function (global) {
  "use strict";

  const BRIDGE_VERSION = "1.0.0";
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

  function playerUnavailable(id) {
    response(id, false, null, {
      code: "playerUnavailable",
      message: "YouTubePlayer n’est pas encore disponible",
    });
  }

  function executeRequest(request) {
    const id = request?.id ?? null;
    const action = String(request?.action || "");
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
      response(id, false, null, {
        code: "javascriptError",
        message: String(error?.message || error || "Erreur JavaScript"),
      });
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
    executeRequest(request);
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
      playerReady: !!global.YouTubePlayer?.isReady?.(),
      timestamp: Date.now(),
    });
    return true;
  }

  global.addEventListener("message", (event) => {
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
      executeRequest(typeof request === "string" ? safeJsonParse(request) : request);
      return true;
    },
  });
})(window);
