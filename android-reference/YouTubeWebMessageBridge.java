import android.content.Context;
import android.net.Uri;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Reference bridge for player.html <-> Android.
 *
 * Uses only Android framework APIs (WebMessagePort, API 23+) and org.json.
 * Call installAfterPageFinished() only after the trusted player document has loaded.
 * The targetOrigin must be the exact HTTPS origin used by loadDataWithBaseURL().
 *
 * android-bridge.js and youtube-api.js are loaded from APK assets and injected into
 * the trusted main frame. No JavaScript interface is exposed to the YouTube iframe.
 */
public final class YouTubeWebMessageBridge implements AutoCloseable {
    public static final String HANDSHAKE = "youtube-player-bridge";

    public interface Listener {
        /** Receives bridgeReady, playerEvent, bridgeEvent, response and nativeError JSON. */
        void onBridgeMessage(String json);
    }

    private final WebView webView;
    private final Context appContext;
    private final Uri targetOrigin;
    private final Listener listener;
    private final AtomicLong nextRequestId = new AtomicLong(1L);

    private WebMessagePort androidPort;
    private boolean installed;

    public YouTubeWebMessageBridge(
            WebView webView,
            Uri targetOrigin,
            Listener listener
    ) {
        if (webView == null) throw new IllegalArgumentException("webView == null");
        if (targetOrigin == null) throw new IllegalArgumentException("targetOrigin == null");
        if (!"https".equalsIgnoreCase(targetOrigin.getScheme())) {
            throw new IllegalArgumentException("targetOrigin must use https");
        }
        if (targetOrigin.getHost() == null || targetOrigin.getHost().isEmpty()) {
            throw new IllegalArgumentException("targetOrigin must have a host");
        }

        this.webView = webView;
        this.appContext = webView.getContext().getApplicationContext();
        this.targetOrigin = targetOrigin;
        this.listener = listener;
    }

    /**
     * Installs youtube-api.js then android-bridge.js and creates the WebMessage channel.
     * Invoke from WebViewClient.onPageFinished() for the trusted app origin only.
     */
    public void installAfterPageFinished() {
        webView.post(() -> {
            closePortOnly();
            installed = false;

            final String dataApiScript;
            final String bridgeScript;
            try {
                dataApiScript = readAsset("youtube-api.js");
                bridgeScript = readAsset("android-bridge.js");
            } catch (IOException error) {
                notifyListener(errorJson("bridgeAssetError", error.getMessage()));
                return;
            }

            // Both assets are code shipped inside the APK. They run only in the trusted main page.
            String installationScript = dataApiScript + "\n;\n" + bridgeScript;
            webView.evaluateJavascript(installationScript, ignored -> createMessageChannel());
        });
    }

    private void createMessageChannel() {
        WebMessagePort[] ports = webView.createWebMessageChannel();
        if (ports == null || ports.length != 2) {
            notifyListener(errorJson("messageChannelError", "Canal WebMessage indisponible"));
            return;
        }

        androidPort = ports[0];
        androidPort.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override
            public void onMessage(WebMessagePort port, WebMessage message) {
                String data = message != null ? message.getData() : null;
                if (data != null) notifyListener(data);
            }
        });

        // ports[1] is transferred to JavaScript and must never be reused by Java afterwards.
        WebMessage handshake = new WebMessage(HANDSHAKE, new WebMessagePort[]{ports[1]});
        webView.postWebMessage(handshake, targetOrigin);
        installed = true;
    }

    public boolean isInstalled() {
        return installed && androidPort != null;
    }

    public Uri getTargetOrigin() {
        return targetOrigin;
    }

    // -------------------------------------------------------------------------
    // Player commands
    // -------------------------------------------------------------------------

    public long sendCommand(String command) {
        return sendCommand(command, null);
    }

    public long sendCommand(String command, Object value) {
        JSONObject request = baseRequest("command");
        try {
            request.put("command", command == null ? "" : command);
            if (value != null) request.put("value", value);
        } catch (JSONException ignored) {
        }
        return postRequest(request);
    }

    public long getState() {
        return postRequest(baseRequest("getState"));
    }

    public long getProgress() {
        return postRequest(baseRequest("getProgress"));
    }

    public long isPlayerReady() {
        return postRequest(baseRequest("isReady"));
    }

    public long loadVideo(String videoId, boolean autoplay, double startSeconds) {
        JSONObject request = baseRequest("loadVideo");
        JSONObject options = new JSONObject();
        try {
            request.put("videoId", videoId == null ? "" : videoId);
            options.put("autoplay", autoplay);
            options.put("startSeconds", Math.max(0.0, startSeconds));
            request.put("options", options);
        } catch (JSONException ignored) {
        }
        return postRequest(request);
    }

    public long loadPlaylist(
            String playlistId,
            JSONArray videoIds,
            int index,
            boolean autoplay,
            boolean shuffle,
            boolean loop,
            double startSeconds
    ) {
        JSONObject request = baseRequest("loadPlaylist");
        JSONObject options = new JSONObject();
        try {
            if (playlistId != null && !playlistId.isEmpty()) {
                options.put("playlistId", playlistId);
            }
            if (videoIds != null) options.put("playlistIds", videoIds);
            options.put("index", Math.max(0, index));
            options.put("autoplay", autoplay);
            options.put("shuffle", shuffle);
            options.put("loop", loop);
            options.put("startSeconds", Math.max(0.0, startSeconds));
            request.put("options", options);
        } catch (JSONException ignored) {
        }
        return postRequest(request);
    }

    public long seekTo(double seconds) {
        JSONObject value = new JSONObject();
        try {
            value.put("seconds", Math.max(0.0, seconds));
            value.put("allowSeekAhead", true);
        } catch (JSONException ignored) {
        }
        return sendCommand("seekTo", value);
    }

    // -------------------------------------------------------------------------
    // YouTube Data API commands
    // -------------------------------------------------------------------------

    /**
     * Stores the YouTube Data API key only in the WebView JavaScript memory.
     * The bridge never persists or echoes the key back to Android.
     */
    public long setYouTubeApiKey(String apiKey) {
        JSONObject request = baseRequest("setYouTubeApiKey");
        try {
            request.put("apiKey", apiKey == null ? "" : apiKey);
        } catch (JSONException ignored) {
        }
        return postRequest(request);
    }

    public long clearYouTubeApiKey() {
        return postRequest(baseRequest("clearYouTubeApiKey"));
    }

    public long hasYouTubeApiKey() {
        return postRequest(baseRequest("hasYouTubeApiKey"));
    }

    /**
     * Imports a complete playlist. Progress arrives as bridgeEvent/youtubeDataProgress.
     * The final response contains a compact playlist structure suitable for local storage.
     */
    public long getPlaylist(String playlistUrlOrId) {
        JSONObject request = baseRequest("getPlaylist");
        try {
            request.put("playlist", playlistUrlOrId == null ? "" : playlistUrlOrId);
            request.put("includeVideoDetails", true);
        } catch (JSONException ignored) {
        }
        return postRequest(request);
    }

    /**
     * Refreshes a playlist and computes a diff against the previously stored JSON object.
     * previousPlaylist may be null for a normal import.
     */
    public long syncPlaylist(String playlistUrlOrId, JSONObject previousPlaylist) {
        JSONObject request = baseRequest("syncPlaylist");
        try {
            request.put("playlist", playlistUrlOrId == null ? "" : playlistUrlOrId);
            request.put("includeVideoDetails", true);
            if (previousPlaylist != null) request.put("previousPlaylist", previousPlaylist);
        } catch (JSONException ignored) {
        }
        return postRequest(request);
    }

    // -------------------------------------------------------------------------
    // Request transport
    // -------------------------------------------------------------------------

    private JSONObject baseRequest(String action) {
        JSONObject request = new JSONObject();
        try {
            request.put("id", nextRequestId.getAndIncrement());
            request.put("action", action);
        } catch (JSONException ignored) {
        }
        return request;
    }

    private long postRequest(JSONObject request) {
        long id = request.optLong("id", -1L);
        String json = request.toString();
        webView.post(() -> {
            WebMessagePort currentPort = androidPort;
            if (currentPort == null) {
                notifyListener(errorJson("bridgeNotReady", "Pont Android non connecté"));
                return;
            }
            try {
                currentPort.postMessage(new WebMessage(json));
            } catch (IllegalStateException error) {
                notifyListener(errorJson("bridgeClosed", error.getMessage()));
            }
        });
        return id;
    }

    private String readAsset(String assetName) throws IOException {
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                appContext.getAssets().open(assetName),
                StandardCharsets.UTF_8
        ))) {
            char[] buffer = new char[4096];
            int count;
            while ((count = reader.read(buffer)) != -1) {
                result.append(buffer, 0, count);
            }
        }
        return result.toString();
    }

    private void notifyListener(String json) {
        if (listener != null) listener.onBridgeMessage(json);
    }

    private static String errorJson(String code, String message) {
        JSONObject root = new JSONObject();
        JSONObject error = new JSONObject();
        try {
            root.put("bridge", HANDSHAKE);
            root.put("kind", "nativeError");
            error.put("code", code == null ? "nativeError" : code);
            error.put("message", message == null ? "" : message);
            root.put("error", error);
        } catch (JSONException ignored) {
        }
        return root.toString();
    }

    private void closePortOnly() {
        installed = false;
        WebMessagePort currentPort = androidPort;
        androidPort = null;
        if (currentPort != null) {
            try {
                currentPort.close();
            } catch (RuntimeException ignored) {
            }
        }
    }

    @Override
    public void close() {
        webView.post(this::closePortOnly);
    }
}
