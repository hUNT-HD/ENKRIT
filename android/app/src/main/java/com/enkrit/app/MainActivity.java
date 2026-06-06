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
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RenderEffect;
import android.graphics.Shader;
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
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
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

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class MainActivity extends Activity {
    private static final int REQ_MEDIA_PERMISSION = 701;
    private static final int REQ_PICK_MEDIA = 702;
    private static final int REQ_DELETE_MEDIA = 703;

    private WebView webView;
    private TextureView playerTexture;
    private ExoPlayer player;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> filePathCallback;
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
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> filePath,
                    FileChooserParams fileChooserParams
            ) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = filePath;
                launchMediaPicker();
                return true;
            }
        });
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");

        webView.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    public void onBackPressed() {
        if (nativePlayerVisible) {
            stopNativePlayer();
            if (webView != null) {
                webView.evaluateJavascript(
                        "window.ENKRITAndroid&&window.ENKRITAndroid.onNativeStopped&&window.ENKRITAndroid.onNativeStopped();",
                        null
                );
            }
        } else if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        stopNativePlayer();
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }

    private ExoPlayer ensurePlayer() {
        if (player != null) return player;
        player = new ExoPlayer.Builder(this).build();
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
            }
        });
        return player;
    }

    private void showNativePlayer(boolean visible) {
        nativePlayerVisible = visible;
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
        if (requestCode == REQ_MEDIA_PERMISSION && webView != null) {
            webView.post(() -> webView.evaluateJavascript(
                    "window.ENKRITAndroid&&window.ENKRITAndroid.onPermissionReady&&window.ENKRITAndroid.onPermissionReady();",
                    null
            ));
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
        if (requestCode == REQ_DELETE_MEDIA) {
            notifyDeleteComplete(resultCode == RESULT_OK, pendingDeleteUri);
            pendingDeleteUri = null;
            return;
        }
        if (requestCode != REQ_PICK_MEDIA) return;

        List<Uri> uris = collectResultUris(resultCode, data);
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(uris.toArray(new Uri[0]));
            filePathCallback = null;
        }
        if (!uris.isEmpty()) notifyPickedMedia(uris);
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

    private void persistReadPermission(Uri uri, int flags) {
        try {
            getContentResolver().takePersistableUriPermission(uri, flags & Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {}
    }

    private void notifyPickedMedia(List<Uri> uris) {
        JSONArray arr = new JSONArray();
        for (Uri uri : uris) {
            JSONObject obj = describeOpenUri(uri);
            if (obj != null) arr.put(obj);
        }
        String script = "window.ENKRITAndroid&&window.ENKRITAndroid.onPickedMedia(" + arr + ");";
        webView.post(() -> webView.evaluateJavascript(script, null));
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
        String[] projection = new String[]{
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_MODIFIED,
                MediaStore.MediaColumns.MIME_TYPE,
                MediaStore.MediaColumns.DURATION
        };
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

            while (cursor.moveToNext() && added < 500) {
                long id = cursor.getLong(idCol);
                String name = cursor.getString(nameCol);
                long size = cursor.getLong(sizeCol);
                long modifiedMs = cursor.getLong(dateCol) * 1000L;
                String mime = cursor.getString(mimeCol);
                long durationMs = cursor.getLong(durationCol);
                Uri contentUri = ContentUris.withAppendedId(collection, id);
                out.put(mediaJson(name, contentUri.toString(), size, durationMs, mime, modifiedMs, kind));
                added++;
            }
        } catch (Exception ignored) {}
    }
}
