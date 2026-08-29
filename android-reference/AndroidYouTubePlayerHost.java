import android.graphics.Color;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * Reference host for the YouTube player WebView.
 *
 * No external dependency is required. This class uses only the Android framework.
 * It intentionally gives the local HTML a stable HTTPS origin with
 * loadDataWithBaseURL() so WebMessage targetOrigin checks are meaningful.
 *
 * Required manifest permission:
 *   <uses-permission android:name="android.permission.INTERNET" />
 *
 * Assets expected in app/src/main/assets/:
 *   player.html
 *   youtube-api.js
 *   android-bridge.js
 */
public final class AndroidYouTubePlayerHost implements AutoCloseable {
    public static final String APP_ORIGIN = "https://app.local";
    public static final String PLAYER_URL = APP_ORIGIN + "/player.html";
    public static final Uri APP_ORIGIN_URI = Uri.parse(APP_ORIGIN);

    public interface Listener extends YouTubeWebMessageBridge.Listener {
        /** Called when a top-level navigation outside APP_ORIGIN is blocked. */
        default void onBlockedNavigation(String url) {
        }
    }

    private final WebView webView;
    private final Listener listener;
    private final YouTubeWebMessageBridge bridge;
    private boolean closed;

    public AndroidYouTubePlayerHost(WebView webView, Listener listener) {
        if (webView == null) throw new IllegalArgumentException("webView == null");
        this.webView = webView;
        this.listener = listener;
        this.bridge = new YouTubeWebMessageBridge(webView, APP_ORIGIN_URI, listener);
        configureWebView();
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();

        // Required by player.html and the YouTube IFrame Player API.
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);

        // The native UI owns the play button. Do not add an extra WebView gesture gate.
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Local files/content URIs are not part of this architecture.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        // Keep the WebView as a single, controlled surface.
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);

        webView.setBackgroundColor(Color.BLACK);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request == null || !request.isForMainFrame()) {
                    // YouTube itself lives in a child iframe and must be able to navigate/load.
                    return false;
                }

                Uri uri = request.getUrl();
                if (isTrustedAppUri(uri)) return false;

                String blocked = uri != null ? uri.toString() : "";
                if (listener != null) listener.onBlockedNavigation(blocked);
                notifyNativeError("blockedNavigation", blocked);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (closed) return;

                Uri uri = null;
                try {
                    uri = Uri.parse(url);
                } catch (RuntimeException ignored) {
                }

                if (!isTrustedAppUri(uri)) {
                    notifyNativeError("untrustedPageFinished", url == null ? "" : url);
                    return;
                }

                bridge.installAfterPageFinished();
            }
        });
    }

    /** Loads player.html from APK assets using the stable APP_ORIGIN HTTPS identity. */
    public void load() {
        if (closed) throw new IllegalStateException("Host is closed");

        final String html;
        try {
            html = readAsset("player.html");
        } catch (IOException error) {
            notifyNativeError("playerAssetError", error.getMessage());
            return;
        }

        webView.post(() -> {
            if (closed) return;
            webView.loadDataWithBaseURL(
                    PLAYER_URL,
                    html,
                    "text/html",
                    "UTF-8",
                    PLAYER_URL
            );
        });
    }

    public YouTubeWebMessageBridge getBridge() {
        return bridge;
    }

    public WebView getWebView() {
        return webView;
    }

    public static boolean isTrustedAppUri(Uri uri) {
        if (uri == null) return false;
        return "https".equalsIgnoreCase(uri.getScheme())
                && "app.local".equalsIgnoreCase(uri.getHost())
                && effectivePort(uri) == 443;
    }

    private static int effectivePort(Uri uri) {
        int port = uri.getPort();
        return port == -1 ? 443 : port;
    }

    private String readAsset(String assetName) throws IOException {
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                webView.getContext().getApplicationContext().getAssets().open(assetName),
                StandardCharsets.UTF_8
        ))) {
            char[] buffer = new char[8192];
            int count;
            while ((count = reader.read(buffer)) != -1) {
                result.append(buffer, 0, count);
            }
        }
        return result.toString();
    }

    private void notifyNativeError(String code, String message) {
        if (listener == null) return;
        JSONObject root = new JSONObject();
        JSONObject error = new JSONObject();
        try {
            root.put("bridge", YouTubeWebMessageBridge.HANDSHAKE);
            root.put("kind", "nativeError");
            error.put("code", code == null ? "nativeError" : code);
            error.put("message", message == null ? "" : message);
            root.put("error", error);
        } catch (JSONException ignored) {
        }
        listener.onBridgeMessage(root.toString());
    }

    @Override
    public void close() {
        if (closed) return;
        closed = true;
        bridge.close();
        webView.post(() -> {
            webView.stopLoading();
            webView.setWebViewClient(null);
        });
    }
}
