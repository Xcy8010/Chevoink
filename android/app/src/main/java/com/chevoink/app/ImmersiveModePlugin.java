package com.chevoink.app;

import android.content.res.Configuration;
import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.util.TypedValue;
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
                next.apply(window);
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
            desiredAppearance.apply(window);
        }
    }

    private void scheduleAppearanceRefresh() {
        Activity activity = getActivity();
        Window window = activity.getWindow();
        // Capacitor's core configuration handlers can update icon appearance too.
        window.getDecorView().post(() -> {
            if (isCurrentWindow(activity, window)) reapplyAppearance(window);
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
                if (normalState == null) normalState = new WindowState(window);
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
        JSObject result = readInsets();
        String serialized = result.toString();
        if (!serialized.equals(lastInsets)) {
            lastInsets = serialized;
            notifyListeners("insetsChanged", result);
        }
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

        void apply(Window window) {
            int mask = WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS
                    | WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS;
            int oldFlags = window.getAttributes().flags;
            int oldStatus = window.getStatusBarColor();
            int oldNavigation = window.getNavigationBarColor();
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            boolean oldLightStatus = controller.isAppearanceLightStatusBars();
            boolean oldLightNavigation = controller.isAppearanceLightNavigationBars();
            try {
                window.setFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS, mask);
                window.setStatusBarColor(color);
                window.setNavigationBarColor(color);
                controller.setAppearanceLightStatusBars(!dark);
                controller.setAppearanceLightNavigationBars(!dark);
            } catch (RuntimeException error) {
                window.setFlags(oldFlags, mask);
                window.setStatusBarColor(oldStatus);
                window.setNavigationBarColor(oldNavigation);
                controller.setAppearanceLightStatusBars(oldLightStatus);
                controller.setAppearanceLightNavigationBars(oldLightNavigation);
                throw error;
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

        WindowState(Window window) {
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
