package com.chevoink.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.widget.TextView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
    private static final String LAST_RENDERER_RESTART = "chevoink.lastRendererRestart";
    private static final long RENDERER_RESTART_COOLDOWN_MS = 30_000L;
    private static final Executor COOKIE_DISK_IO = Executors.newSingleThreadExecutor();

    private View offlineOverlay;
    private boolean offlineShown = false;
    private boolean mainFrameFailed = false;
    private boolean reloading = false;
    private boolean resumed = false;
    private boolean rendererGone = false;
    private boolean rendererRestartRequested = false;
    private long lastRendererRestart = -1L;
    private ConnectivityManager.NetworkCallback networkCallback;
    private Network autoRetriedNetwork;

    @Override
    @SuppressWarnings("deprecation")
    public void onCreate(Bundle savedInstanceState) {
        if (savedInstanceState != null) {
            lastRendererRestart = savedInstanceState.getLong(LAST_RENDERER_RESTART, -1L);
        }
        // 阅读区全屏沉浸自定义插件（官方 StatusBar 的 overlay 在 Android 15+ 失效，见插件注释）；
        // 必须在 super.onCreate 之前注册，Bridge 初始化时才能收进插件表
        registerPlugin(ImmersiveModePlugin.class);
        registerPlugin(ChevoinkSpeechPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() == null) return;
        // Older documents start fitted. Updated documents explicitly opt in through the bridge.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        getBridge().getWebView().setWebChromeClient(new SpeechWebChromeClient(getBridge()));

        // API 26 supports dark navigation icons at runtime (SystemBars), but not in a launch theme.
        if (Build.VERSION.SDK_INT == Build.VERSION_CODES.O) {
            getWindow().setNavigationBarColor(getColor(R.color.splashBackground));
        }

        // 阅读区要全屏沉浸（StatusBar.hide()）。系统默认行为是「任意触摸即恢复系统栏」，
        // 翻页时的每一次点按都会把状态栏拽回来，而临时恢复出来的状态栏自带黑色蒙层且忽略
        // 一切颜色设置——这就是阅读页顶部出现黑带的原因。改成「上滑才临时显示」后隐藏才稳定。
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);

        setupOfflineFallback();
    }

    /** 断网兜底：接管 WebView 加载失败 + 联网自动恢复 */
    private void setupOfflineFallback() {
        final WebView webView = getBridge().getWebView();
        if (webView == null) return;

        // 离线覆盖层挂在 WebView 的 CoordinatorLayout 父容器上。
        ViewGroup parent = (ViewGroup) webView.getParent();
        offlineOverlay = getLayoutInflater().inflate(R.layout.layout_offline, parent, false);
        parent.addView(offlineOverlay);
        offlineOverlay.setVisibility(View.GONE);
        offlineOverlay.findViewById(R.id.offlineRetry).setOnClickListener(v -> {
            if (rendererGone) restartRenderer();
            else reloadSite();
        });

        // 加载失败接管：主文档失败才出离线页（子资源失败不打断已加载内容）。
        // API 23+ 的错误（如 ERR_INTERNET_DISCONNECTED）走新签名回调，必须覆写新版；
        // 且冷启动首载失败时 view.getUrl() 还是 null，不能用「failingUrl 等于当前 URL」判主文档
        getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    mainFrameFailed = true;
                    reloading = false;
                    showOffline();
                    return;
                }
                super.onReceivedError(view, request, error);
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (rendererGone) return;
                super.onPageStarted(view, url, favicon);
                ImmersiveModePlugin immersive = (ImmersiveModePlugin) getBridge().getPlugin("ImmersiveMode").getInstance();
                immersive.resetDocumentPresentation();
                // 新一轮加载开始（含重试/联网自动重载）：重置失败标记
                mainFrameFailed = false;
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                super.onPageCommitVisible(view, url);
                // Only reveal the WebView when the new main document has a drawable frame.
                if (!mainFrameFailed && !rendererGone) {
                    reloading = false;
                    autoRetriedNetwork = null;
                    hideOffline();
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                return recoverRenderer(view);
            }
        });

        registerNetworkRecovery();
    }

    /** 联网恢复监听：断网态下网络一恢复就自动重载站点 */
    private void registerNetworkRecovery() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;

        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                boolean validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                runOnUiThread(() -> {
                    if (validated) retryOverValidatedNetwork(network);
                    else clearAutoRetriedNetwork(network);
                });
            }

            @Override
            public void onLost(Network network) {
                runOnUiThread(() -> clearAutoRetriedNetwork(network));
            }
        };
        cm.registerDefaultNetworkCallback(networkCallback);
    }

    private void clearAutoRetriedNetwork(Network network) {
        if (network.equals(autoRetriedNetwork)) autoRetriedNetwork = null;
    }

    private void retryOverValidatedNetwork(Network network) {
        if (!resumed || isFinishing() || isDestroyed() || !offlineShown || rendererGone || reloading
                || network == null || network.equals(autoRetriedNetwork)) return;
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null || !network.equals(cm.getActiveNetwork())) return;
        NetworkCapabilities caps = cm.getNetworkCapabilities(network);
        if (caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
            autoRetriedNetwork = network;
            reloadSite();
        }
    }

    private void showOffline() {
        offlineShown = true;
        offlineOverlay.setVisibility(View.VISIBLE);
        offlineOverlay.findViewById(R.id.offlineRetry).setEnabled(!reloading);
    }

    private void hideOffline() {
        offlineShown = false;
        offlineOverlay.setVisibility(View.GONE);
    }

    /** 手动/自动重试：有网则重载站点，无网保持离线页 */
    private void reloadSite() {
        if (!resumed || isFinishing() || isDestroyed() || rendererGone || reloading) return;
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkCapabilities caps = cm == null ? null : cm.getNetworkCapabilities(cm.getActiveNetwork());
        if (caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return;
        WebView webView = getBridge().getWebView();
        reloading = true;
        offlineOverlay.findViewById(R.id.offlineRetry).setEnabled(false);
        if (webView.getUrl() == null) webView.loadUrl(getBridge().getAppUrl());
        else webView.reload();
    }

    private boolean recoverRenderer(WebView webView) {
        if (rendererGone) return true;
        rendererGone = true;
        reloading = false;
        ((TextView) offlineOverlay.findViewById(R.id.offlineTitle)).setText(R.string.renderer_recovery_title);
        ((TextView) offlineOverlay.findViewById(R.id.offlineHint)).setText(R.string.renderer_recovery_hint);
        showOffline();
        // A WebView cannot be used again once its renderer has exited. Recreate
        // the Activity so Capacitor builds a fresh view and bridge together.
        ImmersiveModePlugin immersive = (ImmersiveModePlugin) getBridge().getPlugin("ImmersiveMode").getInstance();
        immersive.detachRenderer();
        if (webView.getParent() instanceof ViewGroup parent) parent.removeView(webView);
        webView.destroy();
        maybeRestartRenderer();
        return true;
    }

    private void maybeRestartRenderer() {
        if (lastRendererRestart < 0 || SystemClock.elapsedRealtime() - lastRendererRestart >= RENDERER_RESTART_COOLDOWN_MS) {
            restartRenderer();
        }
    }

    private void restartRenderer() {
        if (!resumed || isFinishing() || isDestroyed() || rendererRestartRequested) return;
        rendererRestartRequested = true;
        lastRendererRestart = SystemClock.elapsedRealtime();
        offlineOverlay.findViewById(R.id.offlineRetry).setEnabled(false);
        recreate();
    }

    @Override
    public void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putLong(LAST_RENDERER_RESTART, lastRendererRestart);
    }

    @Override
    public void onResume() {
        super.onResume();
        resumed = true;
        if (rendererGone) {
            maybeRestartRenderer();
        } else if (offlineShown) {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) retryOverValidatedNetwork(cm.getActiveNetwork());
        }
    }

    @Override
    public void onPause() {
        resumed = false;
        super.onPause();
        // CookieManager.flush blocks for disk I/O. Keep it off the lifecycle thread.
        if (getBridge() != null) COOKIE_DISK_IO.execute(() -> CookieManager.getInstance().flush());
    }

    @Override
    public void onDestroy() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null && networkCallback != null) {
            cm.unregisterNetworkCallback(networkCallback);
        }
        super.onDestroy();
    }
}
