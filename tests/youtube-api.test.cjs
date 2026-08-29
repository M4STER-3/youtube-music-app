"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const TOTAL_ITEMS = 420;
const PLAYLIST_ID = "PL1234567890ABCDE";
const DUPLICATE_POSITION = 17;

function makeVideoId(index) {
  return `V${String(index).padStart(10, "0")}`;
}

const UNAVAILABLE_ID = makeVideoId(300);

function makePlaylistItem(position) {
  const videoId = position === DUPLICATE_POSITION ? makeVideoId(DUPLICATE_POSITION - 1) : makeVideoId(position);
  return {
    id: `PLI${String(position).padStart(6, "0")}`,
    snippet: {
      position,
      title: `Titre ${position}`,
      description: "",
      publishedAt: "2026-01-01T00:00:00Z",
      videoOwnerChannelId: "CHANNEL123",
      videoOwnerChannelTitle: "Chaîne test",
      resourceId: { videoId },
      thumbnails: { medium: { url: `https://img.example/${videoId}.jpg`, width: 320, height: 180 } },
    },
    contentDetails: { videoId },
    status: { privacyStatus: "public" },
  };
}

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return headers[String(name).toLowerCase()] || headers[name] || null; } },
    async json() { return body; },
  };
}

function createMockFetch() {
  let failedFirstPlaylistItems = false;
  let totalCalls = 0;
  let videosCallsWithMaxResults = 0;

  const mockFetch = async (input) => {
    totalCalls += 1;
    const url = new URL(String(input));
    const resource = url.pathname.split("/").pop();

    if (resource === "playlists") {
      return response(200, {
        items: [{
          snippet: {
            title: "Playlist simulée",
            description: "",
            channelId: "CHANNEL123",
            channelTitle: "Chaîne test",
            publishedAt: "2026-01-01T00:00:00Z",
            thumbnails: { high: { url: "https://img.example/playlist.jpg", width: 480, height: 360 } },
          },
          contentDetails: { itemCount: TOTAL_ITEMS },
          status: { privacyStatus: "public" },
        }],
      });
    }

    if (resource === "playlistItems") {
      if (!failedFirstPlaylistItems) {
        failedFirstPlaylistItems = true;
        return response(500, {
          error: {
            message: "Backend temporairement indisponible",
            errors: [{ reason: "backendError", message: "Backend temporairement indisponible" }],
          },
        });
      }

      const token = url.searchParams.get("pageToken") || "p0";
      const page = Number(token.slice(1)) || 0;
      const start = page * 50;
      const end = Math.min(TOTAL_ITEMS, start + 50);
      const items = [];
      for (let index = start; index < end; index += 1) items.push(makePlaylistItem(index));
      return response(200, {
        nextPageToken: end < TOTAL_ITEMS ? `p${page + 1}` : undefined,
        pageInfo: { totalResults: TOTAL_ITEMS, resultsPerPage: items.length },
        items,
      });
    }

    if (resource === "videos") {
      if (url.searchParams.has("maxResults")) videosCallsWithMaxResults += 1;
      const ids = String(url.searchParams.get("id") || "").split(",").filter(Boolean);
      return response(200, {
        items: ids.filter((id) => id !== UNAVAILABLE_ID).map((id) => ({
          id,
          snippet: {
            title: `Détail ${id}`,
            description: "",
            channelId: "CHANNEL123",
            channelTitle: "Chaîne test",
            publishedAt: "2026-01-01T00:00:00Z",
            liveBroadcastContent: "none",
            thumbnails: { high: { url: `https://img.example/${id}.jpg`, width: 480, height: 360 } },
          },
          contentDetails: {
            duration: "PT3M5S",
            definition: "hd",
            caption: "false",
            licensedContent: true,
          },
          status: {
            privacyStatus: "public",
            uploadStatus: "processed",
            embeddable: true,
          },
        })),
      });
    }

    return response(404, { error: { message: "Unknown mock resource" } });
  };

  mockFetch.inspect = () => ({ totalCalls, videosCallsWithMaxResults });
  return mockFetch;
}

function createQuotaFetch() {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return response(403, {
      error: {
        message: "Quota dépassé",
        errors: [{ reason: "quotaExceeded", message: "Quota dépassé" }],
      },
    });
  };
  fn.calls = () => calls;
  return fn;
}

function loadYouTubeData() {
  const code = fs.readFileSync("youtube-api.js", "utf8");
  const sandbox = {
    console,
    URL,
    DOMException,
    setTimeout,
    clearTimeout,
    Math: Object.create(Math),
    fetch: null,
  };
  sandbox.Math.random = () => 0;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "youtube-api.js" });
  return { sandbox, YouTubeData: sandbox.YouTubeData };
}

async function main() {
  const { sandbox, YouTubeData } = loadYouTubeData();
  assert.ok(YouTubeData, "YouTubeData doit être exposé");
  assert.equal(YouTubeData.version, "1.1.0");
  assert.equal(YouTubeData.parseIso8601Duration("PT3M5S"), 185);
  assert.equal(YouTubeData.formatDuration(185), "3:05");

  const progressEvents = [];
  const mockFetch = createMockFetch();
  sandbox.fetch = mockFetch;
  YouTubeData.setApiKey("TEST_KEY_NOT_REAL");

  const result = await YouTubeData.getPlaylist(PLAYLIST_ID, {
    includeVideoDetails: true,
    maxRetries: 2,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 500,
    onProgress(event) { progressEvents.push(event); },
  });

  const inspect = mockFetch.inspect();
  assert.equal(result.items.length, TOTAL_ITEMS);
  assert.equal(progressEvents.filter((event) => event.stage === "playlistItems").length, 9);
  assert.equal(result.items[DUPLICATE_POSITION].videoId, result.items[DUPLICATE_POSITION - 1].videoId);
  assert.equal(result.stats.unavailable, 1);
  assert.equal(result.stats.playable, 419);
  assert.equal(result.items[0].durationSeconds, 185);
  assert.equal(result.items[0].durationText, "3:05");
  assert.equal(result.retriesUsed, 1);
  assert.equal(result.requestsUsed, 20);
  assert.ok(progressEvents.some((event) => event.stage === "retry" && event.retry === 1));
  assert.equal(inspect.videosCallsWithMaxResults, 0);
  assert.ok(Number.isFinite(Date.parse(result.refreshRecommendedAt)));
  assert.ok(Number.isFinite(Date.parse(result.mustRefreshBy)));

  const synced = Date.parse(result.syncedAt);
  assert.equal(YouTubeData.isRefreshDue(result.syncedAt, synced + 24 * 86400000), false);
  assert.equal(YouTubeData.isRefreshDue(result.syncedAt, synced + 26 * 86400000), true);
  assert.equal(YouTubeData.isExpired(result.syncedAt, synced + 30 * 86400000), true);

  const diff = YouTubeData.buildDiff(
    { items: [
      { playlistItemId: "A", position: 0, title: "A", channelTitle: "C", durationSeconds: 10, available: true, embeddable: true },
      { playlistItemId: "B", position: 1, title: "B", channelTitle: "C", durationSeconds: 10, available: true, embeddable: true },
    ] },
    { items: [
      { playlistItemId: "B", position: 0, title: "B modifié", channelTitle: "C", durationSeconds: 10, available: true, embeddable: true },
      { playlistItemId: "C", position: 1, title: "C", channelTitle: "C", durationSeconds: 10, available: true, embeddable: true },
    ] }
  );
  // diff.counts comes from a vm.Context, so compare primitive fields rather than object prototypes.
  assert.equal(diff.counts.added, 1);
  assert.equal(diff.counts.removed, 1);
  assert.equal(diff.counts.moved, 1);
  assert.equal(diff.counts.changed, 1);

  const quotaFetch = createQuotaFetch();
  sandbox.fetch = quotaFetch;
  let quotaError = null;
  try {
    await YouTubeData.getPlaylist(PLAYLIST_ID, {
      maxRetries: 2,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 500,
    });
  } catch (error) {
    quotaError = error;
  }
  assert.ok(quotaError);
  assert.equal(quotaError.reason, "quotaExceeded");
  assert.equal(quotaError.retryable, false);
  assert.equal(quotaFetch.calls(), 1);

  YouTubeData.clearApiKey();
  console.log("OK — YouTube Data regression tests passed");
  console.log(JSON.stringify({
    items: result.items.length,
    playable: result.stats.playable,
    unavailable: result.stats.unavailable,
    requestsUsed: result.requestsUsed,
    retriesUsed: result.retriesUsed,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
