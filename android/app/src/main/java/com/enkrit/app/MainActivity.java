package com.enkrit.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Intent;
import android.content.IntentSender;
import android.content.UriPermission;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RenderEffect;
import android.graphics.Shader;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.view.TextureView;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.exoplayer.ExoPlayer;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public class MainActivity extends Activity {
    private static final int REQ_MEDIA_PERMISSION = 701;
    private static final int REQ_PICK_MEDIA = 702;
    private static final int REQ_DELETE_MEDIA = 703;
    private static final int REQ_FILE_CHOOSER = 704;
    private static final int REQ_SUBTITLE_FILE = 705;
    private static final int REQ_CAMERA = 706;
    private static final int REQ_VAULT_DELETE = 707;
    private android.webkit.PermissionRequest pendingWebPermission;
    private java.util.List<org.json.JSONObject> pendingVaultItems;
    private java.util.List<java.io.File> pendingVaultCopies;

    private WebView webView;
    private FrameLayout rootLayout;
    private FrameLayout browserOverlay;   // in-app browser for web links
    private WebView browserWebView;
    private TextureView playerTexture;
    private ExoPlayer player;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> filePathCallback;
    private boolean pendingPermissionRefresh = false;

    @Override
    protected void onResume() {
        super.onResume();
        // User may have granted media permission from system Settings — refresh
        // the library automatically instead of leaving the empty state stuck.
        if (pendingPermissionRefresh && hasMediaPermission()) {
            pendingPermissionRefresh = false;
            if (webView != null) {
                webView.post(() -> webView.evaluateJavascript(
                        "window.ENKRITAndroid&&window.ENKRITAndroid.onPermissionReady&&window.ENKRITAndroid.onPermissionReady();",
                        null));
            }
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Auto-lock the private vault the moment the app leaves the foreground.
        if (webView != null) {
            webView.evaluateJavascript(
                    "window.ENKRITAndroid&&window.ENKRITAndroid.onAppPaused&&window.ENKRITAndroid.onAppPaused();", null);
        }
    }
    private boolean nativePlayerVisible = false;
    private Uri pendingDeleteUri;
    private int nativeVideoWidth = 0;
    private int nativeVideoHeight = 0;
    private float nativePixelRatio = 1f;
    private final Paint texturePaint = new Paint();
    private final Runnable progressTicker = new Runnable() {
        @Override
        public void run() {
            sendNativeProgress();
            mainHandler.postDelayed(this, 500);
        }
    };

    @Override
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);

        FrameLayout root = new FrameLayout(this);
        rootLayout = root;
        playerTexture = new TextureView(this);
        playerTexture.setVisibility(View.GONE);
        root.addView(playerTexture, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));
        setContentView(root);

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        // The privileged AndroidBridge is attached to this WebView, so cross-origin
        // reads from file:// pages must stay disabled to prevent local-file exfiltration.
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Allow trusted embedded players (YouTube/Instagram/Vimeo official embeds)
                // to navigate inside their own iframes; everything else keeps the
                // existing behaviour (main-frame http/https → system browser).
                if (Build.VERSION.SDK_INT >= 24 && !request.isForMainFrame()) {
                    String h = request.getUrl().getHost() == null ? "" : request.getUrl().getHost().toLowerCase();
                    if (isTrustedEmbedHost(h)) return false;
                }
                return handleNavigation(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // Re-deliver insets to the freshly loaded document
                pushSafeInsetsToJS();
                view.requestApplyInsets();
            }
        });
        // Edge-to-edge (enforced on Android 15+ / targetSdk 35+): the WebView
        // draws under the status and navigation bars, so the web UI needs the
        // inset sizes as CSS vars (--safe-top / --safe-bottom) to pad itself.
        webView.setOnApplyWindowInsetsListener((v, insets) -> {
            int top, bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                top = bars.top;
                bottom = bars.bottom;
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
            }
            float density = getResources().getDisplayMetrics().density;
            lastSafeTopCss = Math.round(top / density);
            lastSafeBottomCss = Math.round(bottom / density);
            pushSafeInsetsToJS();
            return v.onApplyWindowInsets(insets);
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> filePath,
                    FileChooserParams fileChooserParams
            ) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = filePath;
                launchFileChooser(fileChooserParams);
                return true;
            }
            @Override
            public void onPermissionRequest(final android.webkit.PermissionRequest request) {
                // Grant camera to the page (used for the intruder selfie via getUserMedia).
                runOnUiThread(() -> {
                    try {
                        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                            request.grant(request.getResources());
                        } else {
                            pendingWebPermission = request;
                            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
                        }
                    } catch (Exception e) { try { request.deny(); } catch (Exception ig) {} }
                });
            }
        });
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");

        webView.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    public void onBackPressed() {
        // Delegate ALL back navigation to the web app, which knows what overlay,
        // panel, player or folder is currently showing. Only exit when the app
        // reports it has nothing left to pop (i.e. we're at the library root).
        if (webView != null) {
            webView.evaluateJavascript(
                "(window.ENKRITHandleBack ? ENKRITHandleBack() : false)",
                value -> {
                    if (!"true".equals(value)) {
                        // Not consumed → send to background (don't hard-kill so
                        // state/resume positions survive), like a normal app.
                        moveTaskToBack(true);
                    }
                });
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        // Audit #8: cancel all pending main-thread callbacks (progress ticker,
        // queued JS injections) so they can't fire against a dead activity.
        mainHandler.removeCallbacksAndMessages(null);
        stopNativePlayer();
        if (loudness != null) { try { loudness.release(); } catch (Exception ignored) {} loudness = null; }
        if (dynamics != null) { try { dynamics.release(); } catch (Exception ignored) {} dynamics = null; }
        if (previewRetriever != null) { try { previewRetriever.release(); } catch (Exception ignored) {} previewRetriever = null; }
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }

    private ExoPlayer ensurePlayer() {
        if (player != null) return player;
        player = new ExoPlayer.Builder(this).build();
        // Audit #3: request/abandon audio focus properly (pause when another
        // app takes focus, duck for notifications) and pause when headphones
        // are unplugged. Background play behaviour is unchanged.
        androidx.media3.common.AudioAttributes audioAttrs =
                new androidx.media3.common.AudioAttributes.Builder()
                        .setUsage(androidx.media3.common.C.USAGE_MEDIA)
                        .setContentType(androidx.media3.common.C.AUDIO_CONTENT_TYPE_MOVIE)
                        .build();
        player.setAudioAttributes(audioAttrs, /* handleAudioFocus= */ true);
        player.setHandleAudioBecomingNoisy(true);
        // Subtitles off by default — JS enables a specific embedded track on request.
        player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                .setTrackTypeDisabled(androidx.media3.common.C.TRACK_TYPE_TEXT, true).build());
        player.setVideoTextureView(playerTexture);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                sendNativeProgress();
                if (playbackState == Player.STATE_ENDED && webView != null) {
                    webView.post(() -> webView.evaluateJavascript(
                            "window.ENKRITAndroid&&window.ENKRITAndroid.onNativeEnded&&window.ENKRITAndroid.onNativeEnded();",
                            null
                    ));
                }
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                sendNativeProgress();
                updatePipParams();
            }

            @Override
            public void onCues(androidx.media3.common.text.CueGroup cueGroup) {
                StringBuilder sb = new StringBuilder();
                for (androidx.media3.common.text.Cue c : cueGroup.cues) {
                    if (c.text != null) {
                        if (sb.length() > 0) sb.append('\n');
                        sb.append(c.text);
                    }
                }
                String json = JSONObject.quote(sb.toString());
                if (webView != null) {
                    webView.post(() -> webView.evaluateJavascript(
                            "window.ENKRITAndroid&&window.ENKRITAndroid.onNativeCues&&window.ENKRITAndroid.onNativeCues(" + json + ");",
                            null));
                }
            }

            @Override
            public void onTracksChanged(androidx.media3.common.Tracks tracks) {
                if (webView != null) {
                    webView.post(() -> webView.evaluateJavascript(
                            "window.ENKRITAndroid&&window.ENKRITAndroid.onTracksChanged&&window.ENKRITAndroid.onTracksChanged();",
                            null));
                }
            }

            @Override
            public void onAudioSessionIdChanged(int audioSessionId) {
                applyAudioBoost();
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                String msg = JSONObject.quote(error.getMessage() == null ? "Playback failed" : error.getMessage());
                if (webView != null) {
                    webView.post(() -> webView.evaluateJavascript(
                            "window.ENKRITAndroid&&window.ENKRITAndroid.onNativeError&&window.ENKRITAndroid.onNativeError(" + msg + ");",
                            null
                    ));
                }
            }

            @Override
            public void onVideoSizeChanged(VideoSize videoSize) {
                int width = Math.max(0, videoSize.width);
                int height = Math.max(0, videoSize.height);
                if (videoSize.unappliedRotationDegrees == 90 || videoSize.unappliedRotationDegrees == 270) {
                    int tmp = width;
                    width = height;
                    height = tmp;
                }
                nativeVideoWidth = width;
                nativeVideoHeight = height;
                nativePixelRatio = videoSize.pixelWidthHeightRatio <= 0f ? 1f : videoSize.pixelWidthHeightRatio;
                applyTextureFit();
                updatePipParams();
            }
        });
        return player;
    }

    private void showNativePlayer(boolean visible) {
        nativePlayerVisible = visible;
        updatePipParams();
        if (playerTexture != null) {
            playerTexture.setVisibility(visible ? View.VISIBLE : View.GONE);
            if (visible) playerTexture.post(this::applyTextureFit);
            if (!visible) {
                nativeVideoWidth = 0;
                nativeVideoHeight = 0;
                nativePixelRatio = 1f;
                setTextureZoom(1f);
                setTextureFilter(100, 100, 100, 0, 0, 0, 0, 0);
            }
        }
        if (visible) mainHandler.post(progressTicker);
        else mainHandler.removeCallbacks(progressTicker);
        if (!visible) setImmersiveMode(false);
    }

    private void applyTextureFit() {
        if (playerTexture == null || playerTexture.getParent() == null) return;
        View parent = (View) playerTexture.getParent();
        int containerW = parent.getWidth();
        int containerH = parent.getHeight();
        if (containerW <= 0 || containerH <= 0) return;

        int targetW = containerW;
        int targetH = containerH;
        if (nativeVideoWidth > 0 && nativeVideoHeight > 0) {
            float videoAspect = (nativeVideoWidth * nativePixelRatio) / Math.max(1f, nativeVideoHeight);
            float containerAspect = containerW / (float) containerH;
            if (videoAspect > containerAspect) {
                targetW = containerW;
                targetH = Math.max(1, Math.round(containerW / videoAspect));
            } else {
                targetH = containerH;
                targetW = Math.max(1, Math.round(containerH * videoAspect));
            }
        }

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(targetW, targetH);
        lp.gravity = android.view.Gravity.CENTER;
        playerTexture.setLayoutParams(lp);
        setTextureZoom(1f);
    }

    private void setTextureZoom(float zoom) {
        if (playerTexture == null) return;
        float scale = Math.max(0.5f, Math.min(3f, zoom));
        playerTexture.setScaleX(scale);
        playerTexture.setScaleY(scale);
        if (scale <= 1.01f) {
            playerTexture.setTranslationX(0f);
            playerTexture.setTranslationY(0f);
        }
    }

    private void setTextureTransform(float zoom, float translateX, float translateY) {
        if (playerTexture == null) return;
        float scale = Math.max(0.5f, Math.min(3f, zoom));
        playerTexture.setScaleX(scale);
        playerTexture.setScaleY(scale);
        if (scale <= 1.01f) {
            playerTexture.setTranslationX(0f);
            playerTexture.setTranslationY(0f);
            return;
        }
        playerTexture.setTranslationX(translateX);
        playerTexture.setTranslationY(translateY);
    }

    private void setTextureFilter(
            int brightness,
            int contrast,
            int saturation,
            int grayscale,
            int hue,
            int sepia,
            int invert,
            int blurTenths
    ) {
        if (playerTexture == null) return;

        float b = Math.max(0, Math.min(260, brightness));
        float c = Math.max(0, Math.min(300, contrast)) / 100f;
        float s = Math.max(0, Math.min(300, saturation)) / 100f;
        float g = Math.max(0, Math.min(100, grayscale)) / 100f;
        float sp = Math.max(0, Math.min(100, sepia)) / 100f;
        float inv = Math.max(0, Math.min(100, invert)) / 100f;
        float blur = Math.max(0, Math.min(100, blurTenths)) / 10f;

        boolean identity = Math.abs(b - 100f) < 0.5f
                && Math.abs(c - 1f) < 0.01f
                && Math.abs(s - 1f) < 0.01f
                && g < 0.01f
                && sp < 0.01f
                && inv < 0.01f
                && Math.abs((hue % 360 + 360) % 360) < 1f
                && blur < 0.05f;
        if (identity) {
            if (Build.VERSION.SDK_INT >= 31) playerTexture.setRenderEffect(null);
            texturePaint.setColorFilter(null);
            playerTexture.setLayerType(View.LAYER_TYPE_HARDWARE, null);
            return;
        }

        ColorMatrix matrix = new ColorMatrix();
        ColorMatrix satMatrix = new ColorMatrix();
        satMatrix.setSaturation(s * (1f - g));
        matrix.postConcat(satMatrix);

        if (sp > 0.01f) matrix.postConcat(sepiaMatrix(sp));
        if (inv > 0.01f) matrix.postConcat(invertMatrix(inv));
        int normalizedHue = ((hue % 360) + 360) % 360;
        if (normalizedHue != 0) matrix.postConcat(hueRotateMatrix(normalizedHue));

        float offset = (b - 100f) * 2.55f;
        ColorMatrix contrastMatrix = new ColorMatrix(new float[]{
                c, 0, 0, 0, offset,
                0, c, 0, 0, offset,
                0, 0, c, 0, offset,
                0, 0, 0, 1, 0
        });
        matrix.postConcat(contrastMatrix);

        ColorMatrixColorFilter colorFilter = new ColorMatrixColorFilter(matrix);
        texturePaint.setColorFilter(colorFilter);

        if (Build.VERSION.SDK_INT >= 31) {
            RenderEffect colorEffect = RenderEffect.createColorFilterEffect(colorFilter);
            if (blur > 0.05f) {
                RenderEffect blurEffect = RenderEffect.createBlurEffect(blur, blur, Shader.TileMode.CLAMP);
                playerTexture.setRenderEffect(RenderEffect.createChainEffect(colorEffect, blurEffect));
            } else {
                playerTexture.setRenderEffect(colorEffect);
            }
        } else {
            playerTexture.setLayerType(View.LAYER_TYPE_HARDWARE, texturePaint);
        }
    }

    private ColorMatrix sepiaMatrix(float amount) {
        float inv = 1f - amount;
        ColorMatrix sepia = new ColorMatrix(new float[]{
                0.393f, 0.769f, 0.189f, 0, 0,
                0.349f, 0.686f, 0.168f, 0, 0,
                0.272f, 0.534f, 0.131f, 0, 0,
                0, 0, 0, 1, 0
        });
        ColorMatrix normal = new ColorMatrix();
        float[] sVals = sepia.getArray();
        float[] nVals = normal.getArray();
        float[] out = new float[20];
        for (int i = 0; i < 20; i++) out[i] = nVals[i] * inv + sVals[i] * amount;
        return new ColorMatrix(out);
    }

    private ColorMatrix invertMatrix(float amount) {
        float keep = 1f - (2f * amount);
        float offset = 255f * amount;
        return new ColorMatrix(new float[]{
                keep, 0, 0, 0, offset,
                0, keep, 0, 0, offset,
                0, 0, keep, 0, offset,
                0, 0, 0, 1, 0
        });
    }

    private ColorMatrix hueRotateMatrix(float degrees) {
        double rad = Math.toRadians(degrees);
        float cos = (float) Math.cos(rad);
        float sin = (float) Math.sin(rad);
        float lumR = 0.213f;
        float lumG = 0.715f;
        float lumB = 0.072f;
        return new ColorMatrix(new float[]{
                lumR + cos * (1 - lumR) + sin * (-lumR),
                lumG + cos * (-lumG) + sin * (-lumG),
                lumB + cos * (-lumB) + sin * (1 - lumB),
                0, 0,
                lumR + cos * (-lumR) + sin * 0.143f,
                lumG + cos * (1 - lumG) + sin * 0.140f,
                lumB + cos * (-lumB) + sin * -0.283f,
                0, 0,
                lumR + cos * (-lumR) + sin * (-(1 - lumR)),
                lumG + cos * (-lumG) + sin * lumG,
                lumB + cos * (1 - lumB) + sin * lumB,
                0, 0,
                0, 0, 0, 1, 0
        });
    }

    private void stopNativePlayer() {
        showNativePlayer(false);
        if (player != null) {
            player.stop();
            player.clearMediaItems();
        }
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
    }

    // ── Picture-in-Picture (audit #2) ───────────────────────────────────
    // Pressing Home while a native video plays shrinks the activity into a
    // PiP window. The web UI (WebView) is hidden in PiP so only the
    // ExoPlayer TextureView is visible.

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        maybeEnterPip();
    }

    private android.util.Rational pipAspectRatio() {
        if (nativeVideoWidth > 0 && nativeVideoHeight > 0) {
            float ar = (nativeVideoWidth * nativePixelRatio) / (float) nativeVideoHeight;
            // PiP allows aspect ratios between ~0.418 and ~2.39
            ar = Math.max(0.42f, Math.min(2.38f, ar));
            return new android.util.Rational(Math.round(ar * 1000f), 1000);
        }
        return new android.util.Rational(16, 9);
    }

    // Android 12+ gesture navigation does not reliably call onUserLeaveHint;
    // auto-enter PiP params must be kept registered while a video plays.
    private void updatePipParams() {
        if (Build.VERSION.SDK_INT < 31) return;
        try {
            boolean active = nativePlayerVisible && player != null && player.isPlaying();
            android.app.PictureInPictureParams.Builder b =
                    new android.app.PictureInPictureParams.Builder()
                            .setAutoEnterEnabled(active);
            if (active) b.setAspectRatio(pipAspectRatio());
            setPictureInPictureParams(b.build());
        } catch (Exception ignored) {}
    }

    private void maybeEnterPip() {
        if (Build.VERSION.SDK_INT < 26) return;
        if (!nativePlayerVisible || player == null || !player.isPlaying()) return;
        try {
            android.app.PictureInPictureParams params =
                    new android.app.PictureInPictureParams.Builder()
                            .setAspectRatio(pipAspectRatio())
                            .build();
            enterPictureInPictureMode(params);
        } catch (Exception ignored) {
            // Device/launcher may not support PiP — nothing to do.
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPipMode,
                                              android.content.res.Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPipMode, newConfig);
        if (webView != null) {
            // Hide the web controls overlay while in the PiP window.
            webView.setVisibility(isInPipMode ? View.GONE : View.VISIBLE);
        }
    }

    private int lastSafeTopCss = 0;
    private int lastSafeBottomCss = 0;

    private void pushSafeInsetsToJS() {
        if (webView == null) return;
        final String js = "document.documentElement.style.setProperty('--safe-top','" + lastSafeTopCss + "px');"
                + "document.documentElement.style.setProperty('--safe-bottom','" + lastSafeBottomCss + "px');";
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private void setImmersiveMode(boolean immersive) {
        View decor = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = decor.getWindowInsetsController();
            if (controller == null) return;
            if (immersive) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            } else {
                controller.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            }
        } else {
            decor.setSystemUiVisibility(immersive
                    ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    : View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    private void sendNativeProgress() {
        if (!nativePlayerVisible || player == null || webView == null) return;
        long position = Math.max(0, player.getCurrentPosition());
        long duration = Math.max(0, player.getDuration());
        boolean playing = player.isPlaying();
        String payload = "{\"position\":" + position
                + ",\"duration\":" + duration
                + ",\"playing\":" + playing + "}";
        webView.post(() -> webView.evaluateJavascript(
                "window.ENKRITAndroid&&window.ENKRITAndroid.onNativeProgress&&window.ENKRITAndroid.onNativeProgress(" + payload + ");",
                null
        ));
    }

    private void requestMediaPermissionsIfNeeded() {
        if (hasMediaPermission()) return;
        pendingPermissionRefresh = true;

        // If the user already denied once and selected "Don't ask again", Android silently
        // blocks requestPermissions(). Detect that case and send them to app Settings instead.
        SharedPreferences prefs = getPreferences(MODE_PRIVATE);
        boolean askedBefore = prefs.getBoolean("perm_asked", false);
        if (askedBefore && isPermanentlyDenied()) {
            showGoToSettingsDialog();
            return;
        }

        prefs.edit().putBoolean("perm_asked", true).apply();
        if (Build.VERSION.SDK_INT >= 34) {
            requestPermissions(new String[]{
                    Manifest.permission.READ_MEDIA_VIDEO,
                    Manifest.permission.READ_MEDIA_AUDIO,
                    Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED
            }, REQ_MEDIA_PERMISSION);
        } else if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{
                    Manifest.permission.READ_MEDIA_VIDEO,
                    Manifest.permission.READ_MEDIA_AUDIO
            }, REQ_MEDIA_PERMISSION);
        } else {
            requestPermissions(new String[]{Manifest.permission.READ_EXTERNAL_STORAGE}, REQ_MEDIA_PERMISSION);
        }
    }

    private boolean isPermanentlyDenied() {
        // shouldShowRequestPermissionRationale returns false when: (a) first time, or (b) permanently denied.
        // We only reach here after askedBefore=true, so false means permanently denied.
        if (Build.VERSION.SDK_INT >= 33) {
            return !shouldShowRequestPermissionRationale(Manifest.permission.READ_MEDIA_VIDEO)
                    && !shouldShowRequestPermissionRationale(Manifest.permission.READ_MEDIA_AUDIO);
        }
        return !shouldShowRequestPermissionRationale(Manifest.permission.READ_EXTERNAL_STORAGE);
    }

    private void showGoToSettingsDialog() {
        new AlertDialog.Builder(this)
                .setTitle("Storage Permission Required")
                .setMessage("ENKRIT needs access to your media files to show your library.\n\nPlease go to Settings → Permissions and allow storage/media access.")
                .setPositiveButton("Open Settings", (dialog, which) -> {
                    Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", getPackageName(), null));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                })
                .setNegativeButton("Not now", null)
                .show();
    }

    private boolean hasMediaPermission() {
        return hasVideoPermission() || hasAudioPermission() || hasSelectedVisualPermission();
    }

    private boolean hasVideoPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            return checkSelfPermission(Manifest.permission.READ_MEDIA_VIDEO) == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasAudioPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            return checkSelfPermission(Manifest.permission.READ_MEDIA_AUDIO) == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasSelectedVisualPermission() {
        return Build.VERSION.SDK_INT >= 34
                && checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (pendingWebPermission != null) {
                try {
                    if (granted) pendingWebPermission.grant(pendingWebPermission.getResources());
                    else pendingWebPermission.deny();
                } catch (Exception ignored) {}
                pendingWebPermission = null;
            }
            return;
        }
        if (requestCode != REQ_MEDIA_PERMISSION) return;

        boolean anyGranted = false;
        for (int r : grantResults) if (r == PackageManager.PERMISSION_GRANTED) { anyGranted = true; break; }

        if (anyGranted) {
            pendingPermissionRefresh = false;
            if (webView != null) {
                webView.post(() -> webView.evaluateJavascript(
                        "window.ENKRITAndroid&&window.ENKRITAndroid.onPermissionReady&&window.ENKRITAndroid.onPermissionReady();",
                        null));
            }
        } else {
            // All denied — if permanently denied, prompt to open Settings
            if (isPermanentlyDenied()) {
                showGoToSettingsDialog();
            }
        }
    }

    private void launchMediaPicker() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"video/*", "audio/*"});
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(intent, REQ_PICK_MEDIA);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_VAULT_DELETE) {
            if (resultCode == RESULT_OK) commitVaultMoves();
            else cancelVaultMoves();
            return;
        }
        if (requestCode == REQ_DELETE_MEDIA) {
            if (pendingDeleteBatch != null) {
                List<Uri> batch = pendingDeleteBatch;
                pendingDeleteBatch = null;
                notifyBatchDeleteComplete(resultCode == RESULT_OK,
                        resultCode == RESULT_OK ? batch : new ArrayList<>());
                return;
            }
            notifyDeleteComplete(resultCode == RESULT_OK, pendingDeleteUri);
            pendingDeleteUri = null;
            return;
        }
        if (requestCode == REQ_FILE_CHOOSER) {
            // Result of a WebView <input type="file"> request: deliver to that input only,
            // never push it into the player/library.
            deliverFileChooserResult(resultCode, data);
            return;
        }
        if (requestCode == REQ_SUBTITLE_FILE) {
            handleSubtitleResult(resultCode, data);
            return;
        }
        if (requestCode != REQ_PICK_MEDIA) return;

        List<Uri> uris = collectResultUris(resultCode, data);
        notifyPickedMedia(uris);
    }

    private void handleSubtitleResult(int resultCode, Intent data) {
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            Uri uri = data.getData();
            new Thread(() -> {
                String text = readUriAsText(uri);
                String script;
                if (text != null) {
                    String b64 = android.util.Base64.encodeToString(
                            text.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                            android.util.Base64.NO_WRAP);
                    script = "window.ENKRITAndroid&&window.ENKRITAndroid.onSubtitleFileB64('" + b64 + "');";
                } else {
                    script = "window.ENKRITAndroid&&window.ENKRITAndroid.onSubtitleFileB64(null);";
                }
                final String s = script;
                mainHandler.post(() -> { if (webView != null) webView.evaluateJavascript(s, null); });
            }).start();
        } else {
            mainHandler.post(() -> {
                if (webView != null)
                    webView.evaluateJavascript(
                            "window.ENKRITAndroid&&window.ENKRITAndroid.onSubtitleFileB64(null);", null);
            });
        }
    }

    private String readUriAsText(Uri uri) {
        try {
            java.io.InputStream is = getContentResolver().openInputStream(uri);
            if (is == null) return null;
            java.io.BufferedReader reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(is, java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
            reader.close();
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private void deliverFileChooserResult(int resultCode, Intent data) {
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            List<Uri> uris = new ArrayList<>();
            ClipData clipData = data.getClipData();
            if (clipData != null) {
                for (int i = 0; i < clipData.getItemCount(); i++) {
                    uris.add(clipData.getItemAt(i).getUri());
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            if (!uris.isEmpty()) results = uris.toArray(new Uri[0]);
        }
        if (filePathCallback != null) {
            // Must always fire (null on cancel) or the <input> stays stuck.
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    private void launchFileChooser(WebChromeClient.FileChooserParams params) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");

        String[] accept = params == null ? null : params.getAcceptTypes();
        if (accept != null && accept.length > 0) {
            List<String> mimes = new ArrayList<>();
            boolean unresolved = false;
            for (String entry : accept) {
                if (entry == null || entry.trim().isEmpty()) continue;
                String mime = resolveAcceptMime(entry.trim());
                if (mime == null) { unresolved = true; break; }
                mimes.add(mime);
            }
            // If any accept entry can't map to a MIME (e.g. ".srt"), leave the picker
            // unfiltered so those files stay selectable.
            if (!unresolved && !mimes.isEmpty()) {
                intent.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
            }
        }

        boolean multiple = params != null
                && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);

        try {
            startActivityForResult(intent, REQ_FILE_CHOOSER);
        } catch (Exception e) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
                filePathCallback = null;
            }
        }
    }

    private String resolveAcceptMime(String accept) {
        if (accept.contains("/")) return accept;
        String ext = accept.startsWith(".") ? accept.substring(1) : accept;
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
    }

    private boolean isTrustedEmbedHost(String h) {
        return h.endsWith("youtube.com") || h.endsWith("youtube-nocookie.com")
                || h.endsWith("ytimg.com") || h.endsWith("googlevideo.com")
                || h.endsWith("google.com") || h.endsWith("gstatic.com")
                || h.endsWith("instagram.com") || h.endsWith("cdninstagram.com")
                || h.endsWith("fbcdn.net") || h.endsWith("facebook.com")
                || h.endsWith("vimeo.com") || h.endsWith("vimeocdn.com")
                || h.endsWith("dailymotion.com") || h.endsWith("dmcdn.net");
    }

    private boolean handleNavigation(Uri url) {
        if (url == null) return false;
        String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase();
        if (scheme.equals("about") || scheme.equals("data") || scheme.equals("blob")) {
            return false;
        }
        if (scheme.equals("file")) {
            String path = url.getPath();
            // Only the bundled app assets may load inside the bridge-enabled WebView.
            if (path != null && path.startsWith("/android_asset/")) return false;
            return true;
        }
        // http/https/intent/etc. are handed to the OS so they never run with the bridge attached.
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) {}
        return true;
    }

    private List<Uri> pendingDeleteBatch;

    /* ── Audio boost via LoudnessEnhancer (ExoPlayer.setVolume clamps at 1.0) ── */
    private android.media.audiofx.LoudnessEnhancer loudness;
    private int boostPct = 100;
    private int loudnessSession = -1;

    private void applyAudioBoost() {
        try {
            if (player == null) return;
            int sid = player.getAudioSessionId();
            if (sid == androidx.media3.common.C.AUDIO_SESSION_ID_UNSET || sid == 0) return;
            if (loudness == null || loudnessSession != sid) {
                if (loudness != null) { try { loudness.release(); } catch (Exception ignored) {} }
                loudness = new android.media.audiofx.LoudnessEnhancer(sid);
                loudnessSession = sid;
            }
            // percent → millibels: 200% ≈ +602 mB, 500% ≈ +1398 mB
            int mB = boostPct <= 100 ? 0
                    : (int) Math.round(2000.0 * Math.log10(boostPct / 100.0));
            loudness.setTargetGain(Math.min(2000, mB));
            loudness.setEnabled(mB > 0);
        } catch (Exception ignored) {}
        applyDialogueEnhance();
    }

    /* ── Dialogue enhance: multiband compressor squashes loud FX, lifts quiet speech ── */
    private android.media.audiofx.DynamicsProcessing dynamics;
    private boolean dialogueOn = false;
    private int dynamicsSession = -1;

    private void applyDialogueEnhance() {
        if (Build.VERSION.SDK_INT < 28) return;
        try {
            if (player == null) return;
            int sid = player.getAudioSessionId();
            if (sid == androidx.media3.common.C.AUDIO_SESSION_ID_UNSET || sid == 0) return;
            if (!dialogueOn) {
                if (dynamics != null) dynamics.setEnabled(false);
                return;
            }
            if (dynamics == null || dynamicsSession != sid) {
                if (dynamics != null) { try { dynamics.release(); } catch (Exception ignored) {} }
                android.media.audiofx.DynamicsProcessing.Config.Builder b =
                        new android.media.audiofx.DynamicsProcessing.Config.Builder(
                                android.media.audiofx.DynamicsProcessing.VARIANT_FAVOR_TIME_RESOLUTION,
                                2,      // channels
                                false, 0,   // pre-EQ off
                                true, 1,    // MBC on, 1 band
                                false, 0,   // post-EQ off
                                true);      // limiter on
                dynamics = new android.media.audiofx.DynamicsProcessing(0, sid, b.build());
                for (int ch = 0; ch < 2; ch++) {
                    android.media.audiofx.DynamicsProcessing.MbcBand band =
                            dynamics.getMbcBandByChannelIndex(ch, 0);
                    band.setAttackTime(8f);
                    band.setReleaseTime(160f);
                    band.setRatio(5f);
                    band.setThreshold(-38f);
                    band.setKneeWidth(8f);
                    band.setPreGain(0f);
                    band.setPostGain(9f);  // lift quiet dialogue
                    dynamics.setMbcBandByChannelIndex(ch, 0, band);
                }
                dynamicsSession = sid;
            }
            dynamics.setEnabled(true);
        } catch (Exception ignored) {}
    }

    /* ── Clean screenshot of the video frame → Pictures + clipboard ── */
    private void captureVideoFrame() {
        try {
            if (playerTexture == null || !nativePlayerVisible) { notifyShot(false, ""); return; }
            Bitmap bmp = playerTexture.getBitmap();
            if (bmp == null) { notifyShot(false, ""); return; }
            android.content.ContentValues cv = new android.content.ContentValues();
            String name = "ENKRIT_" + System.currentTimeMillis() + ".png";
            cv.put(MediaStore.Images.Media.DISPLAY_NAME, name);
            cv.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
            if (Build.VERSION.SDK_INT >= 29)
                cv.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/ENKRIT");
            Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
            if (uri == null) { notifyShot(false, ""); return; }
            try (java.io.OutputStream os = getContentResolver().openOutputStream(uri)) {
                bmp.compress(Bitmap.CompressFormat.PNG, 100, os);
            }
            android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            try { cm.setPrimaryClip(ClipData.newUri(getContentResolver(), "ENKRIT screenshot", uri)); } catch (Exception ignored) {}
            notifyShot(true, name);
        } catch (Exception e) { notifyShot(false, ""); }
    }
    private void notifyShot(boolean ok, String name) {
        if (webView == null) return;
        String s = "window.ENKRITAndroid&&window.ENKRITAndroid.onShotSaved&&window.ENKRITAndroid.onShotSaved("
                + ok + "," + JSONObject.quote(name) + ");";
        mainHandler.post(() -> { if (webView != null) webView.evaluateJavascript(s, null); });
    }

    /* ── Extract audio track → M4A in Music/ENKRIT (no re-encode) ── */
    private void extractAudioTrack(String uriStr) {
        new Thread(() -> {
            boolean ok = false; String outName = "";
            android.media.MediaExtractor ex = new android.media.MediaExtractor();
            android.media.MediaMuxer mux = null;
            Uri outUri = null;
            try {
                ex.setDataSource(this, Uri.parse(uriStr), null);
                int track = -1; android.media.MediaFormat fmt = null;
                for (int i = 0; i < ex.getTrackCount(); i++) {
                    android.media.MediaFormat f = ex.getTrackFormat(i);
                    String mime = f.getString(android.media.MediaFormat.KEY_MIME);
                    if (mime != null && mime.startsWith("audio/")) { track = i; fmt = f; break; }
                }
                if (track < 0) throw new Exception("no audio");
                ex.selectTrack(track);
                outName = "ENKRIT_audio_" + System.currentTimeMillis() + ".m4a";
                android.content.ContentValues cv = new android.content.ContentValues();
                cv.put(MediaStore.Audio.Media.DISPLAY_NAME, outName);
                cv.put(MediaStore.Audio.Media.MIME_TYPE, "audio/mp4");
                if (Build.VERSION.SDK_INT >= 29)
                    cv.put(MediaStore.Audio.Media.RELATIVE_PATH, "Music/ENKRIT");
                outUri = getContentResolver().insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, cv);
                if (outUri == null) throw new Exception("mediastore");
                android.os.ParcelFileDescriptor pfd = getContentResolver().openFileDescriptor(outUri, "rw");
                mux = new android.media.MediaMuxer(pfd.getFileDescriptor(),
                        android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
                int dst = mux.addTrack(fmt);
                mux.start();
                java.nio.ByteBuffer buf = java.nio.ByteBuffer.allocate(1 << 20);
                android.media.MediaCodec.BufferInfo info = new android.media.MediaCodec.BufferInfo();
                while (true) {
                    int n = ex.readSampleData(buf, 0);
                    if (n < 0) break;
                    info.offset = 0; info.size = n;
                    info.presentationTimeUs = ex.getSampleTime();
                    info.flags = (ex.getSampleFlags() & android.media.MediaExtractor.SAMPLE_FLAG_SYNC) != 0
                            ? android.media.MediaCodec.BUFFER_FLAG_KEY_FRAME : 0;
                    mux.writeSampleData(dst, buf, info);
                    ex.advance();
                }
                ok = true;
            } catch (Exception e) {
                if (outUri != null) { try { getContentResolver().delete(outUri, null, null); } catch (Exception ignored) {} }
            } finally {
                try { if (mux != null) { mux.stop(); mux.release(); } } catch (Exception ignored) { ok = false; }
                try { ex.release(); } catch (Exception ignored) {}
            }
            final boolean fok = ok; final String fname = outName;
            String s = "window.ENKRITAndroid&&window.ENKRITAndroid.onAudioExtracted&&window.ENKRITAndroid.onAudioExtracted("
                    + fok + "," + JSONObject.quote(fname) + ");";
            mainHandler.post(() -> { if (webView != null) webView.evaluateJavascript(s, null); });
        }).start();
    }

    /* ── GIF maker: frames via retriever → Gif89Encoder → Pictures + share ── */
    private volatile boolean gifBusy = false;

    private void makeGif(String uriStr, long startMs, long durMs) {
        if (gifBusy) { notifyGif("busy", 0, null); return; }
        gifBusy = true;
        new Thread(() -> {
            Uri outUri = null;
            MediaMetadataRetriever r = new MediaMetadataRetriever();
            try {
                r.setDataSource(this, Uri.parse(uriStr));
                final int fps = 10;
                final int delayCs = 100 / fps;              // 10cs
                int frameCount = (int) Math.min(100, Math.max(10, durMs * fps / 1000));
                long stepUs = durMs * 1000L / frameCount;

                java.util.List<Bitmap> frames = new java.util.ArrayList<>(frameCount);
                final int targetW = 480;

                int rotation = 0;
                try {
                    String rs = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
                    if (rs != null) rotation = Integer.parseInt(rs.trim());
                } catch (Exception ignored) {}

                // FAST: sequential MediaCodec decode of just the selected segment.
                boolean fast = decodeSegment(uriStr, startMs * 1000L, durMs * 1000L,
                        frameCount, targetW, rotation, frames);

                // FALLBACK: per-frame retriever decode (slower but always works).
                if (!fast || frames.size() < 4) {
                    for (Bitmap f : frames) { try { f.recycle(); } catch (Exception ig) {} }
                    frames.clear();
                    for (int i = 0; i < frameCount; i++) {
                        long tUs = startMs * 1000L + i * stepUs;
                        Bitmap b = null;
                        try {
                            if (Build.VERSION.SDK_INT >= 27)
                                b = r.getScaledFrameAtTime(tUs, MediaMetadataRetriever.OPTION_CLOSEST, targetW, 0);
                        } catch (Exception ignored) {}
                        if (b == null) {
                            Bitmap raw = r.getFrameAtTime(tUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
                            if (raw == null) continue;
                            int h = Math.max(2, Math.round(raw.getHeight() * (targetW / (float) raw.getWidth())) & ~1);
                            b = Bitmap.createScaledBitmap(raw, targetW, h, true);
                            if (b != raw) raw.recycle();
                        } else if ((b.getHeight() & 1) == 1) {
                            Bitmap fixed = Bitmap.createScaledBitmap(b, b.getWidth(), b.getHeight() - 1, true);
                            if (fixed != b) b.recycle();
                            b = fixed;
                        }
                        frames.add(b);
                        notifyGif("progress", Math.round(i * 80f / frameCount), null);
                    }
                }

                if (frames.isEmpty()) throw new Exception("no frames");

                notifyGif("progress", 85, null);
                String name = "ENKRIT_" + System.currentTimeMillis() + ".gif";
                android.content.ContentValues cv = new android.content.ContentValues();
                cv.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                cv.put(MediaStore.Images.Media.MIME_TYPE, "image/gif");
                if (Build.VERSION.SDK_INT >= 29)
                    cv.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/ENKRIT");
                outUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                if (outUri == null) throw new Exception("mediastore");
                try (java.io.OutputStream os = getContentResolver().openOutputStream(outUri)) {
                    Gif89Encoder.encode(frames, delayCs, os);
                }
                for (Bitmap f : frames) { try { f.recycle(); } catch (Exception ignored) {} }
                notifyGif("done", 100, outUri.toString());
            } catch (Exception e) {
                if (outUri != null) { try { getContentResolver().delete(outUri, null, null); } catch (Exception ignored) {} }
                notifyGif("error", 0, null);
            } finally {
                try { r.release(); } catch (Exception ignored) {}
                gifBusy = false;
            }
        }).start();
    }

    /**
     * Sequentially decode the selected segment with MediaCodec → ImageReader (RGBA).
     * Every source frame is decoded once in order (no per-frame keyframe re-seek),
     * so this is dramatically faster than getScaledFrameAtTime per sample.
     */
    private boolean decodeSegment(String uriStr, long startUs, long durUs, int wantFrames,
                                  int targetW, int rotation, java.util.List<Bitmap> out) {
        MediaExtractor ex = new MediaExtractor();
        MediaCodec codec = null;
        ImageReader reader = null;
        try {
            ex.setDataSource(this, Uri.parse(uriStr), null);
            int track = -1;
            MediaFormat fmt = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("video/")) { track = i; fmt = f; break; }
            }
            if (track < 0) return false;
            ex.selectTrack(track);

            int srcW = fmt.getInteger(MediaFormat.KEY_WIDTH);
            int srcH = fmt.getInteger(MediaFormat.KEY_HEIGHT);
            if (srcW <= 0 || srcH <= 0) return false;

            int outW = targetW;
            int outH = Math.max(2, Math.round(srcH * (targetW / (float) srcW)) & ~1);
            reader = ImageReader.newInstance(outW, outH, android.graphics.PixelFormat.RGBA_8888, 3);

            String mime = fmt.getString(MediaFormat.KEY_MIME);
            codec = MediaCodec.createDecoderByType(mime);
            codec.configure(fmt, reader.getSurface(), null, 0);
            codec.start();

            ex.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);

            final long endUs = startUs + durUs;
            final long stepUs = durUs / Math.max(1, wantFrames);
            long nextWantUs = startUs;

            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false, outputDone = false;
            long startTime = System.currentTimeMillis();

            while (!outputDone && out.size() < wantFrames) {
                if (System.currentTimeMillis() - startTime > 30000) break;  // hard safety cap

                if (!inputDone) {
                    int inIdx = codec.dequeueInputBuffer(10000);
                    if (inIdx >= 0) {
                        java.nio.ByteBuffer ib = codec.getInputBuffer(inIdx);
                        int sz = ib == null ? -1 : ex.readSampleData(ib, 0);
                        if (sz < 0) {
                            codec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            codec.queueInputBuffer(inIdx, 0, sz, ex.getSampleTime(), 0);
                            ex.advance();
                        }
                    }
                }

                int outIdx = codec.dequeueOutputBuffer(info, 10000);
                if (outIdx >= 0) {
                    boolean eos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                    boolean want = info.presentationTimeUs >= nextWantUs
                            && info.presentationTimeUs <= endUs + stepUs;
                    codec.releaseOutputBuffer(outIdx, want);   // render to ImageReader only if wanted
                    if (info.presentationTimeUs > endUs) outputDone = true;
                    if (want) {
                        Bitmap bmp = acquireRgba(reader, outW, outH, rotation);
                        if (bmp != null) {
                            out.add(bmp);
                            nextWantUs += stepUs;
                            notifyGif("progress", Math.round(out.size() * 78f / wantFrames), null);
                        }
                    }
                    if (eos) outputDone = true;
                }
            }
            return out.size() >= 4;
        } catch (Throwable t) {
            return false;
        } finally {
            try { if (codec != null) { codec.stop(); codec.release(); } } catch (Exception ignored) {}
            try { if (reader != null) reader.close(); } catch (Exception ignored) {}
            try { ex.release(); } catch (Exception ignored) {}
        }
    }

    private Bitmap acquireRgba(ImageReader reader, int w, int h, int rotation) {
        Image img = null;
        try {
            for (int tries = 0; tries < 12 && img == null; tries++) {
                img = reader.acquireLatestImage();
                if (img == null) Thread.sleep(4);
            }
            if (img == null) return null;
            Image.Plane plane = img.getPlanes()[0];
            int rowStride = plane.getRowStride();
            java.nio.ByteBuffer buf = plane.getBuffer();
            Bitmap bmp = Bitmap.createBitmap(rowStride / 4, h, Bitmap.Config.ARGB_8888);
            bmp.copyPixelsFromBuffer(buf);
            if (rowStride / 4 != w) {
                Bitmap cropped = Bitmap.createBitmap(bmp, 0, 0, w, h);
                if (cropped != bmp) bmp.recycle();
                bmp = cropped;
            }
            if (rotation == 90 || rotation == 180 || rotation == 270) {
                android.graphics.Matrix m = new android.graphics.Matrix();
                m.postRotate(rotation);
                Bitmap rot = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
                if (rot != bmp) bmp.recycle();
                bmp = rot;
            }
            return bmp;
        } catch (Throwable t) {
            return null;
        } finally {
            if (img != null) img.close();
        }
    }

    /* ── In-app browser: a real WebView overlay so YouTube/Instagram/Facebook
       and any web link play inside the app (their own player handles it). ── */
    @SuppressLint({"SetJavaScriptEnabled"})
    private void showInAppBrowser(String url) {
        try {
            if (browserOverlay == null) {
                browserOverlay = new FrameLayout(this);
                browserOverlay.setBackgroundColor(Color.BLACK);

                browserWebView = new WebView(this);
                WebSettings ws = browserWebView.getSettings();
                ws.setJavaScriptEnabled(true);
                ws.setDomStorageEnabled(true);
                ws.setMediaPlaybackRequiresUserGesture(false);
                ws.setUseWideViewPort(true);
                ws.setLoadWithOverviewMode(true);
                ws.setSupportZoom(true);
                ws.setBuiltInZoomControls(true);
                ws.setDisplayZoomControls(false);
                browserWebView.setWebChromeClient(new WebChromeClient());
                browserWebView.setWebViewClient(new WebViewClient());   // keep navigation inside this WebView
                browserOverlay.addView(browserWebView, new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

                // Close button
                android.widget.TextView close = new android.widget.TextView(this);
                close.setText("✕");
                close.setTextColor(Color.WHITE);
                close.setTextSize(20);
                close.setPadding(36, 24, 36, 24);
                close.setBackgroundColor(0xCC000000);
                close.setOnClickListener(v -> {
                    hideInAppBrowser();
                    if (webView != null) webView.evaluateJavascript("window.__enkritBrowserOpen=false;", null);
                });
                FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
                clp.gravity = android.view.Gravity.TOP | android.view.Gravity.END;
                clp.topMargin = lastSafeTopPx();
                browserOverlay.addView(close, clp);
            }
            if (browserOverlay.getParent() == null && rootLayout != null) {
                rootLayout.addView(browserOverlay, new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            }
            browserOverlay.setVisibility(View.VISIBLE);
            browserWebView.loadUrl(url);
            if (webView != null) webView.evaluateJavascript("window.__enkritBrowserOpen=true;", null);
        } catch (Exception ignored) {}
    }

    /* ── TRUE Private vault: physically move files into app-internal storage
       (not in MediaStore → gone from Gallery and from ENKRIT's scan) ── */
    private void doMoveToPrivate(String jsonItems) {
        java.util.List<org.json.JSONObject> done = new java.util.ArrayList<>();
        java.util.List<java.io.File> copies = new java.util.ArrayList<>();
        java.util.List<Uri> origs = new java.util.ArrayList<>();
        try {
            java.io.File dir = new java.io.File(getFilesDir(), "vault");
            dir.mkdirs();
            JSONArray arr = new JSONArray(jsonItems);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                String uriStr = o.optString("path", "");
                String name = o.optString("name", "video");
                if (uriStr.isEmpty()) continue;
                Uri uri = Uri.parse(uriStr);
                String ext = "";
                int dot = name.lastIndexOf('.');
                if (dot >= 0) ext = name.substring(dot);
                java.io.File dst = new java.io.File(dir, System.currentTimeMillis() + "_" + i + ext);
                try (java.io.InputStream in = getContentResolver().openInputStream(uri);
                     java.io.OutputStream out = new java.io.FileOutputStream(dst)) {
                    if (in == null) continue;
                    byte[] buf = new byte[1 << 16]; int r;
                    while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
                }
                JSONObject item = new JSONObject();
                item.put("name", name);
                item.put("path", "file://" + dst.getAbsolutePath());
                item.put("size", dst.length());
                item.put("ext", ext.startsWith(".") ? ext.substring(1) : ext);
                item.put("kind", o.optString("kind", "video"));
                done.add(item); copies.add(dst); origs.add(uri);
            }
        } catch (Exception e) {
            for (java.io.File f : copies) { try { f.delete(); } catch (Exception ig) {} }
            notifyMoved("[]"); return;
        }
        if (done.isEmpty()) { notifyMoved("[]"); return; }
        pendingVaultItems = done; pendingVaultCopies = copies;
        final java.util.List<Uri> fOrigs = origs;
        mainHandler.post(() -> {
            if (Build.VERSION.SDK_INT >= 30) {
                try {
                    PendingIntent pi = MediaStore.createDeleteRequest(getContentResolver(), fOrigs);
                    startIntentSenderForResult(pi.getIntentSender(), REQ_VAULT_DELETE, null, 0, 0, 0);
                } catch (Exception e) { commitVaultMoves(); }
            } else {
                for (Uri u : fOrigs) { try { getContentResolver().delete(u, null, null); } catch (Exception ig) {} }
                commitVaultMoves();
            }
        });
    }

    private void commitVaultMoves() {
        JSONArray arr = new JSONArray();
        if (pendingVaultItems != null) for (org.json.JSONObject o : pendingVaultItems) arr.put(o);
        pendingVaultItems = null; pendingVaultCopies = null;
        notifyMoved(arr.toString());
    }
    private void cancelVaultMoves() {
        // user declined deleting originals → undo the copies (no duplicates)
        if (pendingVaultCopies != null) for (java.io.File f : pendingVaultCopies) { try { f.delete(); } catch (Exception ig) {} }
        pendingVaultItems = null; pendingVaultCopies = null;
        notifyMoved("[]");
    }
    private void notifyMoved(String json) {
        String s = "window.ENKRITAndroid&&window.ENKRITAndroid.onMovedToPrivate&&window.ENKRITAndroid.onMovedToPrivate(" + JSONObject.quote(json) + ");";
        mainHandler.post(() -> { if (webView != null) webView.evaluateJavascript(s, null); });
    }

    private void doRestoreFromPrivate(String privPath, String name) {
        boolean ok = false;
        try {
            String p = privPath.startsWith("file://") ? privPath.substring(7) : privPath;
            java.io.File src = new java.io.File(p);
            if (src.exists()) {
                android.content.ContentValues cv = new android.content.ContentValues();
                cv.put(MediaStore.Video.Media.DISPLAY_NAME, name);
                if (Build.VERSION.SDK_INT >= 29) cv.put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/ENKRIT");
                Uri out = getContentResolver().insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, cv);
                if (out != null) {
                    try (java.io.InputStream in = new java.io.FileInputStream(src);
                         java.io.OutputStream os = getContentResolver().openOutputStream(out)) {
                        byte[] buf = new byte[1 << 16]; int r;
                        while ((r = in.read(buf)) > 0) os.write(buf, 0, r);
                    }
                    src.delete();
                    ok = true;
                }
            }
        } catch (Exception ignored) {}
        final boolean fok = ok;
        String s = "window.ENKRITAndroid&&window.ENKRITAndroid.onRestoredFromPrivate&&window.ENKRITAndroid.onRestoredFromPrivate(" + fok + "," + JSONObject.quote(privPath) + ");";
        mainHandler.post(() -> { if (webView != null) webView.evaluateJavascript(s, null); });
    }

    private void sendBiometric(boolean ok) {
        if (webView == null) return;
        mainHandler.post(() -> {
            if (webView != null) webView.evaluateJavascript(
                "window.ENKRITAndroid&&window.ENKRITAndroid.onBiometric&&window.ENKRITAndroid.onBiometric(" + ok + ");", null);
        });
    }

    private void hideInAppBrowser() {
        try {
            if (browserWebView != null) {
                browserWebView.loadUrl("about:blank");
                browserWebView.onPause();
            }
            if (browserOverlay != null) browserOverlay.setVisibility(View.GONE);
        } catch (Exception ignored) {}
    }

    private int lastSafeTopPx() {
        try { return Math.round(lastSafeTopCss * getResources().getDisplayMetrics().density); }
        catch (Exception e) { return 48; }
    }

    private void notifyGif(String state, int pct, String uri) {
        if (webView == null) return;
        String s = "window.ENKRITAndroid&&window.ENKRITAndroid.onGifState&&window.ENKRITAndroid.onGifState("
                + JSONObject.quote(state) + "," + pct + "," + JSONObject.quote(uri == null ? "" : uri) + ");";
        mainHandler.post(() -> { if (webView != null) webView.evaluateJavascript(s, null); });
    }

    /* ── Seek preview thumbnails (scrubbing) ── */
    private MediaMetadataRetriever previewRetriever;
    private String previewUri;
    private final Object previewLock = new Object();

    private void seekPreview(String uriStr, long ms, int token) {
        new Thread(() -> {
            String b64 = null;
            synchronized (previewLock) {
                try {
                    if (!uriStr.equals(previewUri)) {
                        if (previewRetriever != null) { try { previewRetriever.release(); } catch (Exception ignored) {} }
                        previewRetriever = new MediaMetadataRetriever();
                        previewRetriever.setDataSource(this, Uri.parse(uriStr));
                        previewUri = uriStr;
                    }
                    Bitmap bmp = previewRetriever.getFrameAtTime(ms * 1000L,
                            MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
                    if (bmp != null) {
                        int w = bmp.getWidth(), h = bmp.getHeight();
                        float sc = 200f / Math.max(1, w);
                        if (sc < 1f) bmp = Bitmap.createScaledBitmap(bmp,
                                Math.max(1, Math.round(w * sc)), Math.max(1, Math.round(h * sc)), true);
                        ByteArrayOutputStream baos = new ByteArrayOutputStream();
                        bmp.compress(Bitmap.CompressFormat.JPEG, 55, baos);
                        b64 = android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.NO_WRAP);
                        bmp.recycle();
                    }
                } catch (Exception ignored) {}
            }
            if (b64 == null) return;
            final String safe = b64.replaceAll("[^A-Za-z0-9+/=]", "");
            String s = "window.ENKRITAndroid&&window.ENKRITAndroid.onSeekPreview&&window.ENKRITAndroid.onSeekPreview("
                    + token + ",'" + safe + "');";
            mainHandler.post(() -> { if (webView != null) webView.evaluateJavascript(s, null); });
        }).start();
    }

    private void requestDeleteMediaBatch(String jsonUris) {
        List<Uri> uris = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(jsonUris == null ? "[]" : jsonUris);
            for (int i = 0; i < arr.length(); i++) {
                String s = arr.optString(i, null);
                if (s != null && !s.trim().isEmpty()) uris.add(Uri.parse(s));
            }
        } catch (Exception ignored) {}
        if (uris.isEmpty()) { notifyBatchDeleteComplete(false, new ArrayList<>()); return; }

        if (Build.VERSION.SDK_INT >= 30) {
            try {
                pendingDeleteBatch = uris;
                PendingIntent request = MediaStore.createDeleteRequest(getContentResolver(), uris);
                startIntentSenderForResult(request.getIntentSender(), REQ_DELETE_MEDIA, null, 0, 0, 0);
                return;
            } catch (Exception e) {
                pendingDeleteBatch = null;
            }
        }
        // Pre-R (or createDeleteRequest failure): best-effort sequential delete
        List<Uri> deleted = new ArrayList<>();
        for (Uri u : uris) {
            try { if (getContentResolver().delete(u, null, null) > 0) deleted.add(u); } catch (Exception ignored) {}
        }
        notifyBatchDeleteComplete(!deleted.isEmpty(), deleted);
    }

    private void notifyBatchDeleteComplete(boolean success, List<Uri> uris) {
        if (webView == null) return;
        JSONArray arr = new JSONArray();
        for (Uri u : uris) arr.put(u.toString());
        String script = "window.ENKRITAndroid&&window.ENKRITAndroid.onBatchDeleteComplete&&window.ENKRITAndroid.onBatchDeleteComplete("
                + success + "," + JSONObject.quote(arr.toString()) + ");";
        mainHandler.post(() -> { if (webView != null) webView.evaluateJavascript(script, null); });
    }

    private void requestDeleteMedia(String uriText) {
        if (uriText == null || uriText.trim().isEmpty()) {
            notifyDeleteComplete(false, null);
            return;
        }

        Uri uri = Uri.parse(uriText);
        pendingDeleteUri = uri;
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                PendingIntent request = MediaStore.createDeleteRequest(
                        getContentResolver(),
                        Collections.singletonList(uri)
                );
                startIntentSenderForResult(
                        request.getIntentSender(),
                        REQ_DELETE_MEDIA,
                        null,
                        0,
                        0,
                        0
                );
            } else {
                int rows = getContentResolver().delete(uri, null, null);
                notifyDeleteComplete(rows > 0, uri);
                pendingDeleteUri = null;
            }
        } catch (IntentSender.SendIntentException e) {
            notifyDeleteComplete(false, uri);
            pendingDeleteUri = null;
        } catch (Exception e) {
            notifyDeleteComplete(false, uri);
            pendingDeleteUri = null;
        }
    }

    private void notifyDeleteComplete(boolean success, Uri uri) {
        if (webView == null) return;
        String uriJson = JSONObject.quote(uri == null ? "" : uri.toString());
        String script = "window.ENKRITAndroid&&window.ENKRITAndroid.onDeleteComplete&&window.ENKRITAndroid.onDeleteComplete("
                + success + "," + uriJson + ");";
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    private List<Uri> collectResultUris(int resultCode, Intent data) {
        List<Uri> uris = new ArrayList<>();
        if (resultCode != RESULT_OK || data == null) return uris;

        int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        ClipData clipData = data.getClipData();
        if (clipData != null) {
            for (int i = 0; i < clipData.getItemCount(); i++) {
                Uri uri = clipData.getItemAt(i).getUri();
                persistReadPermission(uri, flags);
                uris.add(uri);
            }
        } else if (data.getData() != null) {
            Uri uri = data.getData();
            persistReadPermission(uri, flags);
            uris.add(uri);
        }
        return uris;
    }

    private static final int MAX_PERSISTED_URI_PERMISSIONS = 128;

    private void persistReadPermission(Uri uri, int flags) {
        try {
            ContentResolver resolver = getContentResolver();
            // The OS caps persisted URI grants (historically 128). Without trimming, this
            // accumulates forever and new grants silently fail, breaking previously picked
            // files. Release the oldest grants first to stay under the cap.
            List<UriPermission> held = new ArrayList<>(resolver.getPersistedUriPermissions());
            if (held.size() >= MAX_PERSISTED_URI_PERMISSIONS) {
                Collections.sort(held, (a, b) -> Long.compare(a.getPersistedTime(), b.getPersistedTime()));
                int toRelease = held.size() - MAX_PERSISTED_URI_PERMISSIONS + 1;
                for (int i = 0; i < toRelease && i < held.size(); i++) {
                    UriPermission old = held.get(i);
                    try {
                        resolver.releasePersistableUriPermission(
                                old.getUri(),
                                Intent.FLAG_GRANT_READ_URI_PERMISSION
                        );
                    } catch (Exception ignored) {}
                }
            }
            resolver.takePersistableUriPermission(uri, flags & Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {}
    }

    private void notifyPickedMedia(List<Uri> uris) {
        // describeOpenUri() runs a ContentResolver query and MediaMetadataRetriever per file,
        // which is slow disk/parse work — do it off the UI thread to avoid an ANR, then post
        // the result back to the WebView.
        final List<Uri> picked = new ArrayList<>(uris);
        new Thread(() -> {
            JSONArray arr = new JSONArray();
            for (Uri uri : picked) {
                JSONObject obj = describeOpenUri(uri);
                if (obj != null) arr.put(obj);
            }
            final String script = "window.ENKRITAndroid&&window.ENKRITAndroid.onPickedMedia(" + arr + ");";
            mainHandler.post(() -> {
                if (webView != null) webView.evaluateJavascript(script, null);
            });
        }).start();
    }

    private JSONObject describeOpenUri(Uri uri) {
        String name = "Media";
        long size = 0;
        String mime = getContentResolver().getType(uri);
        long duration = readDuration(uri);

        try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameCol = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeCol = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameCol >= 0) name = cursor.getString(nameCol);
                if (sizeCol >= 0) size = cursor.getLong(sizeCol);
            }
        } catch (Exception ignored) {}

        return mediaJson(name, uri.toString(), size, duration, mime, 0, inferKind(name, mime));
    }

    private long readDuration(Uri uri) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(this, uri);
            String value = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            return value == null ? 0 : Long.parseLong(value);
        } catch (Exception ignored) {
            return 0;
        } finally {
            try { retriever.release(); } catch (Exception ignored) {}
        }
    }

    private JSONObject mediaJson(String name, String uri, long size, long durationMs, String mime, long modifiedMs, String kind) {
        return mediaJsonWithFolder(name, uri, size, durationMs, mime, modifiedMs, kind, "");
    }

    private JSONObject mediaJsonWithFolder(String name, String uri, long size, long durationMs, String mime, long modifiedMs, String kind, String folder) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("name", name);
            obj.put("path", uri);
            obj.put("size", size);
            obj.put("durationMs", durationMs);
            obj.put("type", mime == null ? "" : mime);
            obj.put("mtime", modifiedMs);
            obj.put("kind", kind);
            obj.put("ext", ext(name, mime, kind));
            obj.put("folder", folder == null ? "" : folder);
        } catch (Exception ignored) {}
        return obj;
    }

    private String ext(String name, String mime, String kind) {
        int dot = name == null ? -1 : name.lastIndexOf('.');
        if (dot >= 0 && dot < name.length() - 1) return name.substring(dot + 1).toLowerCase();
        if (mime != null && mime.contains("/")) return mime.substring(mime.indexOf('/') + 1).toLowerCase();
        return "audio".equals(kind) ? "audio" : "video";
    }

    private String inferKind(String name, String mime) {
        if (mime != null && mime.startsWith("audio/")) return "audio";
        if (name != null && name.matches("(?i).*\\.(mp3|wav|aac|flac|ogg|oga|m4a|opus|wma|aiff|aif|alac)$")) return "audio";
        return "video";
    }

    private String extractVideoThumbBase64(Uri uri) {
        Bitmap bmp = null;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                try {
                    bmp = getContentResolver().loadThumbnail(
                            uri, new android.util.Size(200, 150), null);
                } catch (Exception ignored) {}
            }
            if (bmp == null) {
                MediaMetadataRetriever retriever = new MediaMetadataRetriever();
                try {
                    retriever.setDataSource(this, uri);
                    bmp = retriever.getFrameAtTime(1_000_000L,
                            MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
                } finally {
                    try { retriever.release(); } catch (Exception ignored) {}
                }
            }
            if (bmp == null) return null;

            // Scale to max 160px wide/tall, maintain aspect ratio
            int w = bmp.getWidth(), h = bmp.getHeight();
            float scale = Math.min(160f / Math.max(1, w), 160f / Math.max(1, h));
            if (scale < 1f) {
                bmp = Bitmap.createScaledBitmap(
                        bmp, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), true);
            }
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 68, baos);
            return android.util.Base64.encodeToString(baos.toByteArray(),
                    android.util.Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        } finally {
            if (bmp != null) bmp.recycle();
        }
    }

    public class AndroidBridge {
        @JavascriptInterface
        public boolean hasMediaPermission() {
            return MainActivity.this.hasMediaPermission();
        }

        @JavascriptInterface
        public void requestMediaPermission() {
            runOnUiThread(MainActivity.this::requestMediaPermissionsIfNeeded);
        }

        @JavascriptInterface
        public void pickMedia() {
            runOnUiThread(MainActivity.this::launchMediaPicker);
        }

        @JavascriptInterface
        public void playNativeMedia(String uri, long startMs, float speed, int volumePercent) {
            runOnUiThread(() -> {
                try {
                    ExoPlayer p = ensurePlayer();
                    nativeVideoWidth = 0;
                    nativeVideoHeight = 0;
                    nativePixelRatio = 1f;
                    setTextureZoom(1f);
                    setTextureFilter(100, 100, 100, 0, 0, 0, 0, 0);
                    p.setMediaItem(MediaItem.fromUri(Uri.parse(uri)));
                    p.prepare();
                    if (startMs > 0) p.seekTo(startMs);
                    p.setPlaybackSpeed(Math.max(0.1f, Math.min(5f, speed)));
                    p.setVolume(Math.max(0f, Math.min(5f, volumePercent / 100f)));
                    showNativePlayer(true);
                    p.setPlayWhenReady(true);
                    p.play();
                    mainHandler.postDelayed(MainActivity.this::sendNativeProgress, 250);
                } catch (Exception e) {
                    String msg = JSONObject.quote(e.getMessage() == null ? "Playback failed" : e.getMessage());
                    if (webView != null) webView.evaluateJavascript(
                            "window.ENKRITAndroid&&window.ENKRITAndroid.onNativeError&&window.ENKRITAndroid.onNativeError(" + msg + ");",
                            null
                    );
                }
            });
        }

        @JavascriptInterface
        public void nativeSetPlaying(boolean playing) {
            runOnUiThread(() -> {
                if (player == null) return;
                if (playing) player.play();
                else player.pause();
                sendNativeProgress();
            });
        }

        @JavascriptInterface
        public void nativeSeekTo(long positionMs) {
            runOnUiThread(() -> {
                if (player == null) return;
                player.seekTo(Math.max(0, positionMs));
                sendNativeProgress();
            });
        }

        @JavascriptInterface
        public void nativeSetSpeed(float speed) {
            runOnUiThread(() -> {
                if (player != null) player.setPlaybackSpeed(Math.max(0.1f, Math.min(5f, speed)));
            });
        }

        @JavascriptInterface
        public void nativeSetVolume(int volumePercent) {
            runOnUiThread(() -> {
                if (player != null) player.setVolume(Math.max(0f, Math.min(5f, volumePercent / 100f)));
            });
        }

        @JavascriptInterface
        public void setVideoZoom(int percent) {
            runOnUiThread(() -> setTextureZoom(Math.max(50, Math.min(300, percent)) / 100f));
        }

        @JavascriptInterface
        public void setVideoTransform(int percent, int translateX, int translateY) {
            runOnUiThread(() -> setTextureTransform(
                    Math.max(50, Math.min(300, percent)) / 100f,
                    translateX,
                    translateY
            ));
        }

        @JavascriptInterface
        public void setVideoFilter(
                int brightness,
                int contrast,
                int saturation,
                int grayscale,
                int hue,
                int sepia,
                int invert,
                int blurTenths
        ) {
            runOnUiThread(() -> MainActivity.this.setTextureFilter(
                    brightness,
                    contrast,
                    saturation,
                    grayscale,
                    hue,
                    sepia,
                    invert,
                    blurTenths
            ));
        }

        @JavascriptInterface
        public void deleteMedia(String uri) {
            runOnUiThread(() -> MainActivity.this.requestDeleteMedia(uri));
        }

        @JavascriptInterface
        public void stopNativeMedia() {
            runOnUiThread(MainActivity.this::stopNativePlayer);
        }

        @JavascriptInterface
        public void setOrientationMode(String mode) {
            runOnUiThread(() -> {
                if ("landscape".equals(mode)) {
                    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
                } else if ("auto".equals(mode)) {
                    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR);
                } else {
                    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
                }
            });
        }

        @JavascriptInterface
        public void setScreenBrightness(int percent) {
            runOnUiThread(() -> {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.screenBrightness = Math.max(0.05f, Math.min(1f, percent / 100f));
                getWindow().setAttributes(lp);
            });
        }

        @JavascriptInterface
        public void setImmersive(boolean immersive) {
            runOnUiThread(() -> MainActivity.this.setImmersiveMode(immersive));
        }

        @JavascriptInterface
        public void requestVideoThumb(String uriString, int idx) {
            if (uriString == null || uriString.isEmpty()) return;
            final Uri uri;
            try { uri = Uri.parse(uriString); } catch (Exception e) { return; }
            new Thread(() -> {
                String base64 = extractVideoThumbBase64(uri);
                if (base64 == null || webView == null) return;
                // Audit #7: strictly whitelist base64 characters before embedding
                // in a JS string literal (defence in depth vs string injection).
                final String safe = base64.replaceAll("[^A-Za-z0-9+/=]", "");
                final String script = "window.ENKRITAndroid&&window.ENKRITAndroid.onVideoThumb&&"
                        + "window.ENKRITAndroid.onVideoThumb(" + idx + ",'" + safe + "');";
                mainHandler.post(() -> {
                    if (webView != null) webView.evaluateJavascript(script, null);
                });
            }).start();
        }

        @JavascriptInterface
        public void requestSubtitleTracks() {
            mainHandler.post(() -> {
                JSONArray arr = new JSONArray();
                try {
                    if (player != null) {
                        int i = 0;
                        for (androidx.media3.common.Tracks.Group g : player.getCurrentTracks().getGroups()) {
                            if (g.getType() != androidx.media3.common.C.TRACK_TYPE_TEXT) continue;
                            androidx.media3.common.Format f = g.getTrackFormat(0);
                            JSONObject o = new JSONObject();
                            o.put("index", i);
                            o.put("lang", f.language == null ? "" : f.language);
                            o.put("label", f.label == null ? "" : f.label);
                            o.put("selected", g.isSelected());
                            arr.put(o);
                            i++;
                        }
                    }
                } catch (Exception ignored) {}
                if (webView != null) {
                    webView.evaluateJavascript(
                            "window.ENKRITAndroid&&window.ENKRITAndroid.onSubtitleTracks&&window.ENKRITAndroid.onSubtitleTracks("
                                    + JSONObject.quote(arr.toString()) + ");", null);
                }
            });
        }

        @JavascriptInterface
        public void setSubtitleTrack(final int index) {
            mainHandler.post(() -> {
                try {
                    if (player == null) return;
                    if (index < 0) {
                        player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                                .setTrackTypeDisabled(androidx.media3.common.C.TRACK_TYPE_TEXT, true)
                                .clearOverridesOfType(androidx.media3.common.C.TRACK_TYPE_TEXT)
                                .build());
                        return;
                    }
                    int i = 0;
                    for (androidx.media3.common.Tracks.Group g : player.getCurrentTracks().getGroups()) {
                        if (g.getType() != androidx.media3.common.C.TRACK_TYPE_TEXT) continue;
                        if (i == index) {
                            player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                                    .setTrackTypeDisabled(androidx.media3.common.C.TRACK_TYPE_TEXT, false)
                                    .setOverrideForType(new androidx.media3.common.TrackSelectionOverride(
                                            g.getMediaTrackGroup(), 0))
                                    .build());
                            return;
                        }
                        i++;
                    }
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void deleteMediaBatch(String jsonUris) {
            runOnUiThread(() -> requestDeleteMediaBatch(jsonUris));
        }

        @JavascriptInterface
        public void setAudioBoost(final int percent) {
            mainHandler.post(() -> {
                boostPct = Math.max(100, Math.min(500, percent));
                applyAudioBoost();
            });
        }

        @JavascriptInterface
        public void setDialogueEnhance(final boolean on) {
            mainHandler.post(() -> { dialogueOn = on; applyDialogueEnhance(); });
        }

        @JavascriptInterface
        public void captureFrame() {
            mainHandler.post(MainActivity.this::captureVideoFrame);
        }

        @JavascriptInterface
        public void extractAudio(String uri) {
            if (uri != null && !uri.trim().isEmpty()) extractAudioTrack(uri);
        }

        @JavascriptInterface
        public void requestSeekPreview(String uri, long ms, int token) {
            if (uri != null && !uri.trim().isEmpty()) seekPreview(uri, ms, token);
        }

        @JavascriptInterface
        public void moveToPrivate(String jsonItems) {
            new Thread(() -> doMoveToPrivate(jsonItems)).start();
        }

        @JavascriptInterface
        public void restoreFromPrivate(String privPath, String name) {
            new Thread(() -> doRestoreFromPrivate(privPath, name)).start();
        }

        @JavascriptInterface
        public void setSecureMode(final boolean on) {
            runOnUiThread(() -> {
                try {
                    if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void requestBiometric(String title) {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT < 28) { sendBiometric(false); return; }
                try {
                    android.hardware.biometrics.BiometricPrompt prompt =
                        new android.hardware.biometrics.BiometricPrompt.Builder(MainActivity.this)
                            .setTitle(title == null || title.isEmpty() ? "Unlock" : title)
                            .setNegativeButton("Use PIN", getMainExecutor(),
                                    (d, w) -> sendBiometric(false))
                            .build();
                    prompt.authenticate(new android.os.CancellationSignal(), getMainExecutor(),
                        new android.hardware.biometrics.BiometricPrompt.AuthenticationCallback() {
                            @Override public void onAuthenticationSucceeded(
                                    android.hardware.biometrics.BiometricPrompt.AuthenticationResult result) {
                                sendBiometric(true);
                            }
                            @Override public void onAuthenticationError(int code, CharSequence err) {
                                sendBiometric(false);
                            }
                        });
                } catch (Exception e) { sendBiometric(false); }
            });
        }

        @JavascriptInterface
        public void openInAppBrowser(String url) {
            if (url != null && !url.trim().isEmpty())
                runOnUiThread(() -> showInAppBrowser(url.trim()));
        }

        @JavascriptInterface
        public void closeInAppBrowser() {
            runOnUiThread(MainActivity.this::hideInAppBrowser);
        }

        @JavascriptInterface
        public void createGif(String uri, long startMs, long durMs) {
            if (uri != null && !uri.trim().isEmpty())
                makeGif(uri, Math.max(0, startMs), Math.max(1000, Math.min(10000, durMs)));
        }

        @JavascriptInterface
        public void shareUri(String uriStr, String mime) {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_SEND);
                    i.setType(mime == null || mime.isEmpty() ? "*/*" : mime);
                    i.putExtra(Intent.EXTRA_STREAM, Uri.parse(uriStr));
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(i, "Share"));
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void requestClipboardText() {
            runOnUiThread(() -> {
                String txt = "";
                try {
                    android.content.ClipboardManager cm =
                            (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    if (cm != null && cm.hasPrimaryClip()
                            && cm.getPrimaryClip().getItemCount() > 0) {
                        CharSequence c = cm.getPrimaryClip().getItemAt(0).coerceToText(MainActivity.this);
                        if (c != null) txt = c.toString();
                    }
                } catch (Exception ignored) {}
                String s = "window.ENKRITAndroid&&window.ENKRITAndroid.onClipboardText&&window.ENKRITAndroid.onClipboardText("
                        + JSONObject.quote(txt) + ");";
                if (webView != null) webView.evaluateJavascript(s, null);
            });
        }

        @JavascriptInterface
        public void requestAudioTracks() {
            mainHandler.post(() -> {
                JSONArray arr = new JSONArray();
                try {
                    if (player != null) {
                        int i = 0;
                        for (androidx.media3.common.Tracks.Group g : player.getCurrentTracks().getGroups()) {
                            if (g.getType() != androidx.media3.common.C.TRACK_TYPE_AUDIO) continue;
                            androidx.media3.common.Format f = g.getTrackFormat(0);
                            JSONObject o = new JSONObject();
                            o.put("index", i);
                            o.put("lang", f.language == null ? "" : f.language);
                            o.put("label", f.label == null ? "" : f.label);
                            o.put("selected", g.isSelected());
                            arr.put(o);
                            i++;
                        }
                    }
                } catch (Exception ignored) {}
                if (webView != null) {
                    webView.evaluateJavascript(
                            "window.ENKRITAndroid&&window.ENKRITAndroid.onAudioTracks&&window.ENKRITAndroid.onAudioTracks("
                                    + JSONObject.quote(arr.toString()) + ");", null);
                }
            });
        }

        @JavascriptInterface
        public void setAudioTrack(final int index) {
            mainHandler.post(() -> {
                try {
                    if (player == null) return;
                    int i = 0;
                    for (androidx.media3.common.Tracks.Group g : player.getCurrentTracks().getGroups()) {
                        if (g.getType() != androidx.media3.common.C.TRACK_TYPE_AUDIO) continue;
                        if (i == index) {
                            player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                                    .setOverrideForType(new androidx.media3.common.TrackSelectionOverride(
                                            g.getMediaTrackGroup(), 0))
                                    .build());
                            return;
                        }
                        i++;
                    }
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void pickSubtitleFile() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(intent, REQ_SUBTITLE_FILE);
                } catch (Exception e) {
                    mainHandler.post(() -> {
                        if (webView != null)
                            webView.evaluateJavascript(
                                    "window.ENKRITAndroid&&window.ENKRITAndroid.onSubtitleFileB64(null);", null);
                    });
                }
            });
        }

        @JavascriptInterface
        public String scanLibrary() {
            if (!MainActivity.this.hasMediaPermission()) {
                runOnUiThread(MainActivity.this::requestMediaPermissionsIfNeeded);
                return "[]";
            }

            JSONArray arr = new JSONArray();
            if (MainActivity.this.hasVideoPermission() || MainActivity.this.hasSelectedVisualPermission()) {
                queryMediaStore(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, "video", arr);
            }
            if (MainActivity.this.hasAudioPermission()) {
                queryMediaStore(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, "audio", arr);
            }
            return arr.toString();
        }
    }

    private void queryMediaStore(Uri collection, String kind, JSONArray out) {
        List<String> proj = new ArrayList<>(Arrays.asList(
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_MODIFIED,
                MediaStore.MediaColumns.MIME_TYPE,
                MediaStore.MediaColumns.DURATION
        ));
        boolean hasRelPath = Build.VERSION.SDK_INT >= 29;
        if (hasRelPath) proj.add(MediaStore.MediaColumns.RELATIVE_PATH);
        String[] projection = proj.toArray(new String[0]);
        String sort = MediaStore.MediaColumns.DATE_MODIFIED + " DESC";
        int added = 0;

        try (Cursor cursor = getContentResolver().query(collection, projection, null, null, sort)) {
            if (cursor == null) return;
            int idCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID);
            int nameCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME);
            int sizeCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE);
            int dateCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED);
            int mimeCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE);
            int durationCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DURATION);
            int relPathCol = hasRelPath ? cursor.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH) : -1;

            while (cursor.moveToNext() && added < 500) {
                long id = cursor.getLong(idCol);
                String name = cursor.getString(nameCol);
                long size = cursor.getLong(sizeCol);
                long modifiedMs = cursor.getLong(dateCol) * 1000L;
                String mime = cursor.getString(mimeCol);
                long durationMs = cursor.getLong(durationCol);
                String relPath = (relPathCol >= 0) ? cursor.getString(relPathCol) : "";
                if (relPath == null) relPath = "";
                String folder = extractFolderLabel(relPath);
                Uri contentUri = ContentUris.withAppendedId(collection, id);
                out.put(mediaJsonWithFolder(name, contentUri.toString(), size, durationMs, mime, modifiedMs, kind, folder));
                added++;
            }
        } catch (Exception ignored) {}
    }

    private String extractFolderLabel(String relativePath) {
        if (relativePath == null || relativePath.isEmpty()) return "";
        String path = relativePath.endsWith("/") ? relativePath.substring(0, relativePath.length() - 1) : relativePath;
        int slash = path.lastIndexOf('/');
        return slash >= 0 ? path.substring(slash + 1) : path;
    }
}
