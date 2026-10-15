package com.chevoink.app;

import android.content.res.Configuration;
import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.util.TypedValue;
import android.util.Log;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Window-level immersive reading; all measurements are CSS pixels.
 * enter keeps the legacy stable physical safe area (measurement=stable).
 * getInsets, exit and insetsChanged report only WebView-uncovered space (measurement=remaining).
 */
@CapacitorPlugin(name = "ImmersiveMode")
public class ImmersiveModePlugin extends Plugin {
    private WindowState normalState;
    private View observedDecor;
    private String lastInsets;
    private Window appearanceWindow;
    private BarAppearance desiredAppearance;
    private final ViewTreeObserver.OnGlobalLayoutListener layoutListener = this::publishInsets;

    /** Appearance only: never changes bar visibility, decor fitting, cutouts or IME policy. */
    @PluginMethod
    public void setSystemBarAppearance(PluginCall call) {
        String color = call.getString("color");
        Boolean dark = call.getBoolean("dark");
        if (!SystemBarAppearancePolicy.validColor(color) || dark == null) {
            call.reject("Expected color #RRGGBB and boolean dark", "INVALID_APPEARANCE");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) { call.reject("Activity unavailable", "UNAVAILABLE"); return; }
        Window window = activity.getWindow();
        activity.runOnUiThread(() -> {
            if (!isCurrentWindow(activity, window)) { call.reject("Activity changed", "UNAVAILABLE"); return; }
            if (!canSetOpaqueBars(window)) {
                call.reject("This window requires edge-to-edge surface drawing", "UNSUPPORTED_LAYOUT");
                return;
            }
            try {
                BarAppearance next = new BarAppearance(Color.parseColor(color), dark);
                next.apply(window, webViewParent());
                appearanceWindow = window;
                desiredAppearance = next;
                call.resolve();
            } catch (RuntimeException error) {
                call.reject("System bar appearance failed", "APPEARANCE_FAILED", error);
            }
        });
    }

    private boolean isCurrentWindow(Activity activity, Window window) {
        return getActivity() == activity && !activity.isFinishing() && !activity.isDestroyed()
                && activity.getWindow() == window;
    }

    private boolean canSetOpaqueBars(Window window) {
        TypedValue optOut = new TypedValue();
        boolean optedOut = Build.VERSION.SDK_INT >= 35
                && window.getContext().getTheme().resolveAttribute(android.R.attr.windowOptOutEdgeToEdgeEnforcement, optOut, true)
                && optOut.data != 0;
        return SystemBarAppearancePolicy.canColor(Build.VERSION.SDK_INT,
                window.getContext().getApplicationInfo().targetSdkVersion, optedOut);
    }

    private void reapplyAppearance(Window window) {
        if (appearanceWindow == window && desiredAppearance != null && canSetOpaqueBars(window)) {
            desiredAppearance.apply(window, webViewParent());
        }
    }

    private View webViewParent() {
        View webView = getBridge().getWebView();
        if (webView == null || !(webView.getParent() instanceof View)) {
            throw new IllegalStateException("WebView canvas unavailable");
        }
        return (View) webView.getParent();
    }

    private void scheduleAppearanceRefresh() {
        Activity activity = getActivity();
        Window window = activity.getWindow();
        // Capacitor's core configuration handlers can update icon appearance too.
        window.getDecorView().post(() -> {
            if (isCurrentWindow(activity, window)) {
                try { reapplyAppearance(window); }
                catch (RuntimeException error) { Log.e("ImmersiveMode", "Appearance refresh failed; rollback attempted", error); }
            }
        });
    }

    @Override
    public void load() {
        getActivity().runOnUiThread(() -> {
            observedDecor = getActivity().getWindow().getDecorView();
            // Observe only. Capacitor SystemBars and Keyboard own their apply-insets listeners.
            observedDecor.getViewTreeObserver().addOnGlobalLayoutListener(layoutListener);
            ViewCompat.requestApplyInsets(observedDecor);
        });
    }

    @PluginMethod
    public void enter(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                Window window = getActivity().getWindow();
                // Repeated enter must not overwrite the normal state with the hidden state.
                if (normalState == null) normalState = new WindowState(window, webViewParent());
                applyImmersive(window);
                // Preserve old Web clients that only consume enter's top/bottom once.
                call.resolve(readInsets(true));
            } catch (Exception e) {
                if (normalState != null) {
                    try {
                        normalState.restore(getActivity().getWindow());
                        normalState = null;
                    } catch (Exception restoreError) {
                        // Retain the snapshot so exit can retry restoration after a partial failure.
                        e.addSuppressed(restoreError);
                    }
                }
                call.reject("enter immersive failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void exit(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (normalState != null) {
                    normalState.restore(getActivity().getWindow());
                    normalState = null;
                }
                reapplyAppearance(getActivity().getWindow());
                // An immediate result may precede layout; insetsChanged supplies settled geometry.
                ViewCompat.requestApplyInsets(getActivity().getWindow().getDecorView());
                call.resolve(readInsets());
            } catch (Exception e) {
                call.reject("exit immersive failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void getInsets(PluginCall call) {
        getActivity().runOnUiThread(() -> call.resolve(readInsets()));
    }

    private void applyImmersive(Window window) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attrs = window.getAttributes();
            attrs.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(attrs);
        }
        WindowCompat.setDecorFitsSystemWindows(window, false);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
        ViewCompat.requestApplyInsets(window.getDecorView());
    }

    private JSObject readInsets() {
        return readInsets(false);
    }

    private JSObject readInsets(boolean stableMeasurement) {
        View decor = getActivity().getWindow().getDecorView();
        View webView = getBridge().getWebView();
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
        boolean immersive = normalState != null;
        Insets safe = Insets.NONE;
        if (insets != null) {
            int types = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
            // Unlike visible insets, these stay valid after hiding bars and on repeated enter.
            // Never include IME: the keyboard plugin retains ownership of resize/IME padding.
            safe = immersive ? insets.getInsetsIgnoringVisibility(types) : insets.getInsets(types);
        }
        int[] decorPosition = new int[2];
        int[] webPosition = new int[2];
        decor.getLocationInWindow(decorPosition);
        webView.getLocationInWindow(webPosition);
        float density = getActivity().getResources().getDisplayMetrics().density;
        JSObject result = new JSObject();
        result.put("top", ImmersiveInsets.remaining(safe.top, webPosition[1] - decorPosition[1], density, stableMeasurement));
        result.put("left", ImmersiveInsets.remaining(safe.left, webPosition[0] - decorPosition[0], density, stableMeasurement));
        result.put("right", ImmersiveInsets.remaining(safe.right,
                decorPosition[0] + decor.getWidth() - webPosition[0] - webView.getWidth(), density, stableMeasurement));
        result.put("bottom", ImmersiveInsets.remaining(safe.bottom,
                decorPosition[1] + decor.getHeight() - webPosition[1] - webView.getHeight(), density, stableMeasurement));
        result.put("immersive", immersive);
        result.put("measurement", stableMeasurement ? "stable" : "remaining");
        return result;
    }

    private void publishInsets() {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing() || activity.isDestroyed() || getBridge() == null) return;
        Window window = activity.getWindow();
        if (window == null || window.getDecorView() != observedDecor) return;
        View decor = window.getDecorView();
        View webView = getBridge().getWebView();
        View parent = webView != null && webView.getParent() instanceof View ? (View) webView.getParent() : null;
        // A global-layout callback is observation, not an explicit bridge call:
        // detached/reparented/unfinished trees must not throw or publish stale geometry.
        if (!geometryReady(decor, webView, parent)) return;
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
        if (insets == null) return;
        // The core SystemBars fallback may retain raw bar padding from the
        // edge-to-edge reading layout after the window starts fitting again.
        // Observe settled geometry without replacing its insets/IME listener.
        if (normalState == null && Build.VERSION.SDK_INT >= 35
                && "css".equals(getBridge().getConfig().getPluginConfiguration("SystemBars")
                        .getString("insetsHandling", "css"))) {
            // Padding schedules another layout. Do not label the old WebView
            // rectangle as settled; the next global layout publishes it.
            if (reconcileFittedPadding(decor, webView, parent, insets)) return;
        }
        JSObject result = readInsets();
        String serialized = result.toString();
        if (!serialized.equals(lastInsets)) {
            lastInsets = serialized;
            notifyListeners("insetsChanged", result);
        }
    }

    /** Geometry is in physical pixels. Only core's identifiable bar padding is adjusted. */
    static boolean reconcileFittedPadding(View decor, View webView, View parent, WindowInsetsCompat insets) {
        if (insets == null || !geometryReady(decor, webView, parent)) return false;
        Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        int[] root = new int[2], content = new int[2];
        decor.getLocationInWindow(root);
        parent.getLocationInWindow(content);
        int left = FittedSystemBarPadding.remaining(parent.getPaddingLeft(), bars.left, content[0] - root[0], false);
        int top = FittedSystemBarPadding.remaining(parent.getPaddingTop(), bars.top, content[1] - root[1], false);
        int right = FittedSystemBarPadding.remaining(parent.getPaddingRight(), bars.right,
                root[0] + decor.getWidth() - content[0] - parent.getWidth(), false);
        int bottom = FittedSystemBarPadding.remaining(parent.getPaddingBottom(), bars.bottom,
                root[1] + decor.getHeight() - content[1] - parent.getHeight(), insets.isVisible(WindowInsetsCompat.Type.ime()));
        if (left == parent.getPaddingLeft() && top == parent.getPaddingTop()
                && right == parent.getPaddingRight() && bottom == parent.getPaddingBottom()) return false;
        if (parent.isPaddingRelative()) {
            boolean rtl = parent.getLayoutDirection() == View.LAYOUT_DIRECTION_RTL;
            parent.setPaddingRelative(rtl ? right : left, top, rtl ? left : right, bottom);
        } else parent.setPadding(left, top, right, bottom);
        return true;
    }

    static boolean geometryReady(View decor, View webView, View parent) {
        if (decor == null || webView == null || parent == null || webView.getParent() != parent) return false;
        for (View view : new View[] {decor, webView, parent}) {
            if (!ViewCompat.isAttachedToWindow(view) || !ViewCompat.isLaidOut(view) || view.isLayoutRequested()
                    || view.getWidth() <= 0 || view.getHeight() <= 0 || view.getWindowToken() == null
                    || !view.getWindowToken().equals(decor.getWindowToken())) return false;
        }
        View ancestor = parent;
        while (ancestor != decor) {
            if (!(ancestor.getParent() instanceof View)) return false;
            ancestor = (View) ancestor.getParent();
        }
        return true;
    }

    @Override
    protected void handleOnResume() {
        if (normalState != null) applyImmersive(getActivity().getWindow());
        ViewCompat.requestApplyInsets(getActivity().getWindow().getDecorView());
        scheduleAppearanceRefresh();
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        if (normalState != null) applyImmersive(getActivity().getWindow());
        ViewCompat.requestApplyInsets(getActivity().getWindow().getDecorView());
        scheduleAppearanceRefresh();
    }

    @Override
    protected void handleOnDestroy() {
        if (observedDecor != null && observedDecor.getViewTreeObserver().isAlive()) {
            observedDecor.getViewTreeObserver().removeOnGlobalLayoutListener(layoutListener);
        }
        observedDecor = null;
        desiredAppearance = null;
        appearanceWindow = null;
        if (normalState != null) {
            normalState.restore(getActivity().getWindow());
            normalState = null;
        }
    }

    @SuppressWarnings("deprecation")
    private static final class BarAppearance {
        final int color;
        final boolean dark;
        BarAppearance(int color, boolean dark) { this.color = color; this.dark = dark; }

        void apply(Window window, View webViewParent) {
            SystemBarAppearanceTransaction.apply(color, dark, new BarTarget(window),
                    new CanvasTarget(window.getDecorView()), new CanvasTarget(webViewParent));
        }
    }

    @SuppressWarnings("deprecation")
    private static final class BarTarget implements SystemBarAppearanceTransaction.Part {
        private final Window window;
        BarTarget(Window window) { this.window = window; }

        @Override public Runnable snapshot() {
            int mask = WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS
                    | WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS;
            int oldFlags = window.getAttributes().flags;
            int oldStatus = window.getStatusBarColor();
            int oldNavigation = window.getNavigationBarColor();
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            boolean oldLightStatus = controller.isAppearanceLightStatusBars();
            boolean oldLightNavigation = controller.isAppearanceLightNavigationBars();
            return () -> {
                Runnable[] restores = { () -> controller.setAppearanceLightNavigationBars(oldLightNavigation),
                        () -> controller.setAppearanceLightStatusBars(oldLightStatus),
                        () -> window.setNavigationBarColor(oldNavigation), () -> window.setStatusBarColor(oldStatus),
                        () -> window.setFlags(oldFlags, mask) };
                SystemBarAppearanceTransaction.restore(restores, restores.length, null);
            };
        }

        @Override public void apply(int color, boolean dark) {
            window.setFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS,
                    WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS | WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
            window.setStatusBarColor(color);
            window.setNavigationBarColor(color);
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(!dark);
            controller.setAppearanceLightNavigationBars(!dark);
        }
    }

    /** Never mutate an attached ColorDrawable: SystemBars may repaint it after capture. */
    static final class CanvasTarget implements SystemBarAppearanceTransaction.Part {
        private final View view;
        CanvasTarget(View view) { this.view = view; }

        @Override public Runnable snapshot() {
            Drawable background = view.getBackground();
            Drawable.ConstantState state = background == null ? null : background.getConstantState();
            Drawable saved = state == null ? background : state.newDrawable(view.getResources()).mutate();
            if (saved != null && background != null) {
                saved.setBounds(background.getBounds());
                saved.setState(background.getState().clone());
                saved.setLevel(background.getLevel());
            }
            return () -> setBackgroundPreservingPadding(saved);
        }

        @Override public void apply(int color, boolean dark) {
            setBackgroundPreservingPadding(new ColorDrawable(color));
        }

        private void setBackgroundPreservingPadding(Drawable background) {
            int left = view.getPaddingLeft(), top = view.getPaddingTop();
            int right = view.getPaddingRight(), bottom = view.getPaddingBottom();
            boolean relative = view.isPaddingRelative();
            int start = view.getPaddingStart(), end = view.getPaddingEnd();
            try { view.setBackground(background); }
            finally {
                // setBackground can adopt a special drawable's own padding. Undo only
                // that incidental change, preserving the CURRENT insets/IME padding.
                if (view.getPaddingLeft() != left || view.getPaddingTop() != top
                        || view.getPaddingRight() != right || view.getPaddingBottom() != bottom
                        || view.isPaddingRelative() != relative) {
                    if (relative) view.setPaddingRelative(start, top, end, bottom);
                    else view.setPadding(left, top, right, bottom);
                }
            }
        }
    }

    /** Only window presentation is restored; never replace softInputMode or unrelated flags. */
    @SuppressWarnings("deprecation")
    private static final class WindowState {
        private static final int LEGACY_LAYOUT_FLAGS = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
        final int legacyLayoutFlags;
        final int cutoutMode;
        final int statusBarColor;
        final int navigationBarColor;
        final int navigationBarDividerColor;
        final boolean statusBarContrast;
        final boolean navigationBarContrast;
        final boolean lightStatusBars;
        final boolean lightNavigationBars;
        final int behavior;
        final Runnable restoreCanvas;
        final Window owner;

        WindowState(Window window, View webViewParent) {
            owner = window;
            restoreCanvas = SystemBarAppearanceTransaction.snapshot(new CanvasTarget(window.getDecorView()), new CanvasTarget(webViewParent));
            legacyLayoutFlags = window.getDecorView().getSystemUiVisibility() & LEGACY_LAYOUT_FLAGS;
            cutoutMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? window.getAttributes().layoutInDisplayCutoutMode : 0;
            statusBarColor = window.getStatusBarColor();
            navigationBarColor = window.getNavigationBarColor();
            navigationBarDividerColor = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? window.getNavigationBarDividerColor() : 0;
            statusBarContrast = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && window.isStatusBarContrastEnforced();
            navigationBarContrast = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && window.isNavigationBarContrastEnforced();
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            lightStatusBars = controller.isAppearanceLightStatusBars();
            lightNavigationBars = controller.isAppearanceLightNavigationBars();
            behavior = controller.getSystemBarsBehavior();
        }

        void restore(Window window) {
            if (window != owner) return;
            Runnable restoreWindow = () -> {
            // MainActivity explicitly establishes this normal layout on every creation.
            WindowCompat.setDecorFitsSystemWindows(window, true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                WindowManager.LayoutParams attrs = window.getAttributes();
                attrs.layoutInDisplayCutoutMode = cutoutMode;
                window.setAttributes(attrs);
                window.setNavigationBarDividerColor(navigationBarDividerColor);
            }
            window.setStatusBarColor(statusBarColor);
            window.setNavigationBarColor(navigationBarColor);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.setStatusBarContrastEnforced(statusBarContrast);
                window.setNavigationBarContrastEnforced(navigationBarContrast);
            }
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(lightStatusBars);
            controller.setAppearanceLightNavigationBars(lightNavigationBars);
            controller.setSystemBarsBehavior(behavior);
            controller.show(WindowInsetsCompat.Type.systemBars());
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                View decor = window.getDecorView();
                decor.setSystemUiVisibility((decor.getSystemUiVisibility() & ~LEGACY_LAYOUT_FLAGS) | legacyLayoutFlags);
            }
            ViewCompat.requestApplyInsets(window.getDecorView());
            };
            // A drawable failure must not prevent the established window-layout
            // restoration, and a window error must not skip either canvas rollback.
            Runnable[] restores = { restoreCanvas, restoreWindow };
            SystemBarAppearanceTransaction.restore(restores, restores.length, null);
        }
    }
}

/** Pure geometry shared by all four edges; no device names, screen-height guesses or IME. */
final class ImmersiveInsets {
    private ImmersiveInsets() {}

    static int remaining(int safeInset, int nativeSpace, float density) {
        return remaining(safeInset, nativeSpace, density, false);
    }

    static int remaining(int safeInset, int nativeSpace, float density, boolean stableMeasurement) {
        int reserved = stableMeasurement ? 0 : Math.max(0, nativeSpace);
        return Math.round(Math.max(0, safeInset - reserved) / density);
    }
}

/** Android 16 disables opt-out by TARGET SDK, not just the device API level. */
final class SystemBarAppearancePolicy {
    private SystemBarAppearancePolicy() {}
    static boolean canColor(int deviceSdk, int targetSdk, boolean optOut) {
        return deviceSdk < 35 || targetSdk < 35 || (optOut && (deviceSdk < 36 || targetSdk < 36));
    }
    static boolean validColor(String color) {
        return color != null && color.matches("#[0-9a-fA-F]{6}");
    }
}
