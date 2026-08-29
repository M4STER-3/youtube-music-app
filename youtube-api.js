(function (global) {
  "use strict";

  const API_VERSION = "1.0.0";
  const API_ROOT = "https://www.googleapis.com/youtube/v3";
  const MAX_RESULTS = 50;
  const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{6,120}$/;
  const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

  let configuredApiKey = "";

  class YouTubeApiError extends Error {
    constructor(message, details = {}) {
      super(message);
      this.name = "YouTubeApiError";
      this.status = Number(details.status) || 0;
      this.reason = String(details.reason || "");
      this.code = String(details.code || this.reason || "youtubeApiError");
      this.retryable = !!details.retryable;
      this.details = details.details || null;
    }
  }

  function cleanApiKey(value) {
    return String(value || "").trim();
  }

  function requireApiKey(explicitKey = "") {
    const key = cleanApiKey(explicitKey || configuredApiKey);
    if (!key) {
      throw new YouTubeApiError("Clé API YouTube manquante", {
        code: "missingApiKey",
        reason: "missingApiKey",
      });
    }
    return key;
  }

  function extractPlaylistId(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (PLAYLIST_ID_PATTERN.test(raw) && !raw.includes("/")) return raw;

    try {
      const url = new URL(raw);
      const list = String(url.searchParams.get("list") || "").trim();
      return PLAYLIST_ID_PATTERN.test(list) ? list : "";
    } catch {
      const match = raw.match(/[?&]list=([A-Za-z0-9_-]{6,120})/);
      return match && PLAYLIST_ID_PATTERN.test(match[1]) ? match[1] : "";
    }
  }

  function parseIso8601Duration(value) {
    const text = String(value || "").trim();
    if (!text) return 0;
    const match = text.match(
      /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
    );
    if (!match) return 0;

    const weeks = Number(match[3]) || 0;
    const days = Number(match[4]) || 0;
    const hours = Number(match[5]) || 0;
    const minutes = Number(match[6]) || 0;
    const seconds = Number(match[7]) || 0;
    return Math.max(0, Math.round(
      weeks * 7 * 86400 +
      days * 86400 +
      hours * 3600 +
      minutes * 60 +
      seconds
    ));
  }

  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
    }
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function bestThumbnail(thumbnails = {}) {
    const candidates = ["maxres", "standard", "high", "medium", "default"];
    for (const name of candidates) {
      const candidate = thumbnails?.[name];
      if (candidate?.url) {
        return {
          url: String(candidate.url),
          width: Math.max(0, Number(candidate.width) || 0),
          height: Math.max(0, Number(candidate.height) || 0),
          quality: name,
        };
      }
    }
    return { url: "", width: 0, height: 0, quality: "" };
  }

  function chunk(values, size = MAX_RESULTS) {
    const result = [];
    const safeSize = Math.max(1, Math.min(MAX_RESULTS, Math.floor(Number(size) || MAX_RESULTS)));
    for (let index = 0; index < values.length; index += safeSize) {
      result.push(values.slice(index, index + safeSize));
    }
    return result;
  }

  function emitProgress(callback, payload) {
    if (typeof callback !== "function") return;
    try {
      callback(Object.freeze({ timestamp: Date.now(), ...payload }));
    } catch {
      // Un callback de progression ne doit jamais interrompre l'import.
    }
  }

  function apiErrorFromResponse(status, body) {
    const first = body?.error?.errors?.[0] || {};
    const reason = String(first.reason || body?.error?.status || "");
    const message = String(body?.error?.message || first.message || `Erreur YouTube API (${status})`);
    const retryable = status === 429 || status >= 500 || [
      "backendError",
      "internalError",
      "rateLimitExceeded",
      "userRateLimitExceeded",
    ].includes(reason);
    return new YouTubeApiError(message, {
      status,
      reason,
      code: reason || `http${status}`,
      retryable,
      details: body?.error || null,
    });
  }

  async function apiFetch(resource, params, options = {}) {
    const apiKey = requireApiKey(options.apiKey);
    const url = new URL(`${API_ROOT}/${resource}`);
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set("key", apiKey);

    let response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        signal: options.signal,
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new YouTubeApiError("Impossible de contacter l’API YouTube", {
        code: "networkError",
        reason: "networkError",
        retryable: true,
        details: String(error?.message || error || ""),
      });
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) throw apiErrorFromResponse(response.status, body);
    return body || {};
  }

  async function fetchPlaylistMetadata(playlistId, options, counters) {
    const response = await apiFetch("playlists", {
      part: "snippet,contentDetails,status",
      id: playlistId,
      maxResults: 1,
    }, options);
    counters.requests += 1;

    const playlist = response?.items?.[0];
    if (!playlist) {
      throw new YouTubeApiError("Playlist introuvable ou non accessible", {
        code: "playlistNotFound",
        reason: "playlistNotFound",
        status: 404,
      });
    }

    const snippet = playlist.snippet || {};
    return {
      playlistId,
      title: String(snippet.title || ""),
      description: String(snippet.description || ""),
      channelId: String(snippet.channelId || ""),
      channelTitle: String(snippet.channelTitle || ""),
      publishedAt: String(snippet.publishedAt || ""),
      thumbnail: bestThumbnail(snippet.thumbnails),
      reportedItemCount: Math.max(0, Number(playlist.contentDetails?.itemCount) || 0),
      privacyStatus: String(playlist.status?.privacyStatus || ""),
    };
  }

  async function fetchAllPlaylistItems(playlistId, options, counters) {
    const items = [];
    let nextPageToken = "";
    let page = 0;
    let reportedTotal = 0;

    do {
      const response = await apiFetch("playlistItems", {
        part: "snippet,contentDetails,status",
        playlistId,
        maxResults: MAX_RESULTS,
        pageToken: nextPageToken,
      }, options);
      counters.requests += 1;
      page += 1;
      reportedTotal = Math.max(reportedTotal, Number(response?.pageInfo?.totalResults) || 0);

      for (const rawItem of response?.items || []) {
        const snippet = rawItem.snippet || {};
        const contentDetails = rawItem.contentDetails || {};
        const resourceId = snippet.resourceId || {};
        const currentVideoId = String(contentDetails.videoId || resourceId.videoId || "");

        items.push({
          playlistItemId: String(rawItem.id || ""),
          playlistId,
          position: Number.isFinite(Number(snippet.position)) ? Number(snippet.position) : items.length,
          videoId: VIDEO_ID_PATTERN.test(currentVideoId) ? currentVideoId : "",
          title: String(snippet.title || ""),
          description: String(snippet.description || ""),
          channelId: String(snippet.videoOwnerChannelId || ""),
          channelTitle: String(snippet.videoOwnerChannelTitle || ""),
          addedAt: String(snippet.publishedAt || ""),
          thumbnail: bestThumbnail(snippet.thumbnails),
          playlistItemPrivacyStatus: String(rawItem.status?.privacyStatus || ""),
        });
      }

      nextPageToken = String(response?.nextPageToken || "");
      emitProgress(options.onProgress, {
        stage: "playlistItems",
        page,
        loaded: items.length,
        total: reportedTotal || null,
        requests: counters.requests,
      });
    } while (nextPageToken);

    items.sort((a, b) => a.position - b.position);
    return { items, reportedTotal };
  }

  async function fetchVideoDetails(videoIds, options, counters) {
    const uniqueVideoIds = [...new Set(videoIds.filter((id) => VIDEO_ID_PATTERN.test(id)))];
    const detailMap = new Map();
    const batches = chunk(uniqueVideoIds, MAX_RESULTS);
    let completed = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const ids = batches[batchIndex];
      const response = await apiFetch("videos", {
        part: "snippet,contentDetails,status",
        id: ids.join(","),
        maxResults: MAX_RESULTS,
      }, options);
      counters.requests += 1;

      for (const video of response?.items || []) {
        const currentVideoId = String(video.id || "");
        if (!VIDEO_ID_PATTERN.test(currentVideoId)) continue;
        const snippet = video.snippet || {};
        const details = video.contentDetails || {};
        const status = video.status || {};
        const durationIso = String(details.duration || "");
        const durationSeconds = parseIso8601Duration(durationIso);

        detailMap.set(currentVideoId, {
          videoId: currentVideoId,
          title: String(snippet.title || ""),
          description: String(snippet.description || ""),
          channelId: String(snippet.channelId || ""),
          channelTitle: String(snippet.channelTitle || ""),
          publishedAt: String(snippet.publishedAt || ""),
          thumbnail: bestThumbnail(snippet.thumbnails),
          durationIso,
          durationSeconds,
          durationText: formatDuration(durationSeconds),
          definition: String(details.definition || ""),
          caption: String(details.caption || ""),
          licensedContent: !!details.licensedContent,
          privacyStatus: String(status.privacyStatus || ""),
          uploadStatus: String(status.uploadStatus || ""),
          embeddable: status.embeddable !== false,
          madeForKids: status.madeForKids === true,
          liveBroadcastContent: String(snippet.liveBroadcastContent || "none"),
        });
      }

      completed += ids.length;
      emitProgress(options.onProgress, {
        stage: "videoDetails",
        batch: batchIndex + 1,
        batches: batches.length,
        loaded: Math.min(completed, uniqueVideoIds.length),
        total: uniqueVideoIds.length,
        requests: counters.requests,
      });
    }

    return detailMap;
  }

  function mergePlaylistItems(rawItems, detailMap) {
    return rawItems.map((item, index) => {
      const detail = item.videoId ? detailMap.get(item.videoId) : null;
      const available = !!detail;
      const embeddable = detail ? detail.embeddable !== false : false;
      return {
        ...item,
        position: Number.isFinite(Number(item.position)) ? Number(item.position) : index,
        title: detail?.title || item.title || "Vidéo indisponible",
        description: detail?.description || item.description || "",
        channelId: detail?.channelId || item.channelId || "",
        channelTitle: detail?.channelTitle || item.channelTitle || "",
        thumbnail: detail?.thumbnail?.url ? detail.thumbnail : item.thumbnail,
        publishedAt: detail?.publishedAt || "",
        durationIso: detail?.durationIso || "",
        durationSeconds: detail?.durationSeconds || 0,
        durationText: detail?.durationText || "",
        definition: detail?.definition || "",
        caption: detail?.caption || "",
        privacyStatus: detail?.privacyStatus || item.playlistItemPrivacyStatus || "",
        uploadStatus: detail?.uploadStatus || "",
        embeddable,
        available,
        playable: available && embeddable,
        liveBroadcastContent: detail?.liveBroadcastContent || "none",
      };
    });
  }

  function summarizeItems(items) {
    let available = 0;
    let playable = 0;
    let unavailable = 0;
    for (const item of items) {
      if (item.available) available += 1;
      else unavailable += 1;
      if (item.playable) playable += 1;
    }
    return {
      total: items.length,
      available,
      unavailable,
      playable,
    };
  }

  function buildDiff(previousPlaylist, currentPlaylist) {
    const previous = Array.isArray(previousPlaylist?.items) ? previousPlaylist.items : [];
    const current = Array.isArray(currentPlaylist?.items) ? currentPlaylist.items : [];
    const previousByItemId = new Map(previous.filter((item) => item.playlistItemId).map((item) => [item.playlistItemId, item]));
    const currentByItemId = new Map(current.filter((item) => item.playlistItemId).map((item) => [item.playlistItemId, item]));

    const added = current.filter((item) => item.playlistItemId && !previousByItemId.has(item.playlistItemId));
    const removed = previous.filter((item) => item.playlistItemId && !currentByItemId.has(item.playlistItemId));
    const moved = [];
    const changed = [];

    for (const item of current) {
      const old = previousByItemId.get(item.playlistItemId);
      if (!old) continue;
      if (Number(old.position) !== Number(item.position)) {
        moved.push({ playlistItemId: item.playlistItemId, videoId: item.videoId, from: old.position, to: item.position });
      }
      if (
        old.title !== item.title ||
        old.channelTitle !== item.channelTitle ||
        Number(old.durationSeconds || 0) !== Number(item.durationSeconds || 0) ||
        !!old.available !== !!item.available ||
        !!old.embeddable !== !!item.embeddable
      ) {
        changed.push(item);
      }
    }

    return {
      added,
      removed,
      moved,
      changed,
      counts: {
        added: added.length,
        removed: removed.length,
        moved: moved.length,
        changed: changed.length,
      },
    };
  }

  async function getPlaylist(value, options = {}) {
    const playlistId = extractPlaylistId(value);
    if (!playlistId) {
      throw new YouTubeApiError("URL ou identifiant de playlist YouTube invalide", {
        code: "invalidPlaylistId",
        reason: "invalidPlaylistId",
      });
    }

    requireApiKey(options.apiKey);
    const counters = { requests: 0 };
    const startedAt = Date.now();

    emitProgress(options.onProgress, {
      stage: "start",
      playlistId,
      loaded: 0,
      total: null,
      requests: 0,
    });

    const metadata = await fetchPlaylistMetadata(playlistId, options, counters);
    emitProgress(options.onProgress, {
      stage: "metadata",
      playlistId,
      loaded: 0,
      total: metadata.reportedItemCount || null,
      requests: counters.requests,
    });

    const pageResult = await fetchAllPlaylistItems(playlistId, options, counters);
    const details = options.includeVideoDetails === false
      ? new Map()
      : await fetchVideoDetails(pageResult.items.map((item) => item.videoId), options, counters);

    const items = options.includeVideoDetails === false
      ? pageResult.items.map((item) => ({ ...item, available: !!item.videoId, playable: !!item.videoId }))
      : mergePlaylistItems(pageResult.items, details);

    const finishedAt = Date.now();
    const result = {
      apiVersion: API_VERSION,
      ...metadata,
      playlistId,
      items,
      videoIds: items.filter((item) => item.videoId).map((item) => item.videoId),
      playableVideoIds: items.filter((item) => item.playable && item.videoId).map((item) => item.videoId),
      stats: summarizeItems(items),
      reportedItemCount: Math.max(metadata.reportedItemCount, pageResult.reportedTotal),
      syncedAt: new Date(finishedAt).toISOString(),
      elapsedMs: finishedAt - startedAt,
      requestsUsed: counters.requests,
    };

    emitProgress(options.onProgress, {
      stage: "done",
      playlistId,
      loaded: items.length,
      total: items.length,
      requests: counters.requests,
      elapsedMs: result.elapsedMs,
    });

    return result;
  }

  async function syncPlaylist(value, previousPlaylist, options = {}) {
    const current = await getPlaylist(value, options);
    return {
      ...current,
      diff: buildDiff(previousPlaylist, current),
    };
  }

  global.YouTubeData = Object.freeze({
    version: API_VERSION,
    YouTubeApiError,
    setApiKey(apiKey) {
      configuredApiKey = cleanApiKey(apiKey);
      return !!configuredApiKey;
    },
    clearApiKey() {
      configuredApiKey = "";
    },
    hasApiKey() {
      return !!configuredApiKey;
    },
    extractPlaylistId,
    parseIso8601Duration,
    formatDuration,
    getPlaylist,
    syncPlaylist,
  });
})(window);
