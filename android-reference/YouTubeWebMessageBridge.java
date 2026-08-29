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
 * Call installAfterPageFinished() after the trusted local player page has finished loading.
 * The app should prevent this WebView from navigating to untrusted top-level pages.
 */
public final class YouTubeWebMessageBridge implements AutoCloseable {
    public static final String HANDSHAKE = "youtube-player-bridge";
    public static final Uri WILDCARD_ORIGIN = Uri.parse("*");

    public interface Listener {
        /** Receives bridgeReady, playerEvent and response JSON messages. */
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
        this.webView = webView;
        this.appContext = webView.getContext().getApplicationContext();
        this.targetOrigin = targetOrigin != null ? targetOrigin : WILDCARD_ORIGIN;
        this.listener = listener;
    }

    /**
     * Installs android-bridge.js and creates the WebMessage channel.
     * Invoke from WebViewClient.onPageFinished() for player.html.
     */
    public void installAfterPageFinished() {
        webView.post(() -> {
            closePortOnly();
            installed = false;

            final String bridgeScript;
            try {
                bridgeScript = readAsset("android-bridge.js");
            } catch (IOException error) {
                notifyListener(errorJson("bridgeAssetError", error.getMessage()));
                return;
            }

            webView.evaluateJavascript(bridgeScript, ignored -> createMessageChannel());
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

        // ports[1] is transferred to JavaScript and must not be reused by Java afterwards.
        WebMessage handshake = new WebMessage(HANDSHAKE, new WebMessagePort[]{ports[1]});
        webView.postWebMessage(handshake, targetOrigin);
        installed = true;
    }

    public boolean isInstalled() {
        return installed && androidPort != null;
    }

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
