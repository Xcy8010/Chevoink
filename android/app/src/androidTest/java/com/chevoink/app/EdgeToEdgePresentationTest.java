package com.chevoink.app;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Build;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Predicate;

import org.junit.Test;
import org.junit.runner.RunWith;

import static org.junit.Assert.*;

@SuppressWarnings("deprecation")
@RunWith(AndroidJUnit4.class)
public class EdgeToEdgePresentationTest {
    private static final int BARS = WindowInsetsCompat.Type.systemBars();
    private static final int IME = WindowInsetsCompat.Type.ime();

    @Test public void newDocumentStartsFittedAndReaderExitRestoresCurrentMode() {
        try (ActivityScenario<EdgeToEdgeTestActivity> scenario = ActivityScenario.launch(EdgeToEdgeTestActivity.class)) {
            await(scenario, "fitted startup", a -> hasLoaded(a) && topInWindow(webView(a)) > 0);
            AtomicBoolean fittedContrast = new AtomicBoolean();
            scenario.onActivity(a -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    // The old fitted document can choose contrast independently of edge-to-edge.
                    fittedContrast.set(true);
                    a.getWindow().setNavigationBarContrastEnforced(fittedContrast.get());
                }
                assertFalse(read(a).optBoolean("edgeToEdge"));
                plugin(a).setSystemBarAppearance(new ResultCall(new JSObject().put("color", "#575757").put("dark", true)
                        .put("navigationColor", "#20242b").put("navigationDark", true)));
                assertEquals(0xff575757, a.getWindow().getStatusBarColor());
                assertEquals(0xff20242b, a.getWindow().getNavigationBarColor());
                plugin(a).enter(new ResultCall());
            });
            await(scenario, "legacy reader bars hidden", EdgeToEdgePresentationTest::barsHidden);
            scenario.onActivity(a -> plugin(a).exit(new ResultCall()));
            await(scenario, "legacy reader exit fitted", a -> barsVisible(a) && topInWindow(webView(a)) > 0);
            scenario.onActivity(a -> {
                ResultCall enable = new ResultCall();
                plugin(a).enableEdgeToEdge(enable);
                assertTrue(enable.result.optBoolean("edgeToEdge"));
                assertTrue(enable.result.optInt("top") > 0);
                assertEquals("remaining", enable.result.optString("measurement"));
                plugin(a).enableEdgeToEdge(new ResultCall());
                plugin(a).setSystemBarAppearance(new ResultCall(new JSObject().put("color", "#FCFAF6").put("dark", false)
                        .put("navigationColor", "#20242b").put("navigationDark", true)));
                assertEquals(Color.TRANSPARENT, a.getWindow().getStatusBarColor());
                assertEquals(Color.TRANSPARENT, a.getWindow().getNavigationBarColor());
                assertTrue(WindowCompat.getInsetsController(a.getWindow(), a.getWindow().getDecorView()).isAppearanceLightStatusBars());
                assertFalse(WindowCompat.getInsetsController(a.getWindow(), a.getWindow().getDecorView()).isAppearanceLightNavigationBars());
            });
            await(scenario, "visible edge-to-edge bars", a -> barsVisible(a) && topInWindow(webView(a)) == 0);
            scenario.onActivity(a -> {
                assertTransparentNavigationSurface(a);
                assertTrue(read(a).optInt("top") > 0);
                ResultCall enter = new ResultCall();
                plugin(a).enter(enter);
                assertEquals("stable", enter.result.optString("measurement"));
                assertTrue(enter.result.optBoolean("immersive"));
                assertTrue(enter.result.optInt("top") > 0);
            });
            await(scenario, "opted-in reader bars hidden", EdgeToEdgePresentationTest::barsHidden);
            scenario.onActivity(a -> plugin(a).exit(new ResultCall()));
            await(scenario, "edge-to-edge reader exit", a -> barsVisible(a) && read(a).optBoolean("edgeToEdge") && topInWindow(webView(a)) == 0);
            scenario.onActivity(a -> {
                assertTransparentNavigationSurface(a);
                plugin(a).enter(new ResultCall());
                webView(a).reload();
            });
            await(scenario, "reload restores fitted document", a -> hasLoaded(a) && barsVisible(a)
                    && topInWindow(webView(a)) > 0 && !read(a).optBoolean("edgeToEdge") && !read(a).optBoolean("immersive"));
            scenario.onActivity(a -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
                assertEquals(fittedContrast.get(), a.getWindow().isNavigationBarContrastEnforced());

                // Reapplying the page appearance must remove an opaque system treatment.
                plugin(a).enableEdgeToEdge(new ResultCall());
                a.getWindow().setNavigationBarContrastEnforced(true);
                a.getWindow().setNavigationBarDividerColor(Color.WHITE);
                plugin(a).setSystemBarAppearance(new ResultCall(new JSObject().put("color", "#FCFAF6").put("dark", false)));
                assertTransparentNavigationSurface(a);
            });
        }
    }

    private static void assertTransparentNavigationSurface(EdgeToEdgeTestActivity a) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            assertFalse(a.getWindow().isNavigationBarContrastEnforced());
            assertEquals(Color.TRANSPARENT, a.getWindow().getNavigationBarDividerColor());
            assertEquals(Color.TRANSPARENT, a.getWindow().getNavigationBarColor());
        }
    }

    @Test public void webViewBackgroundReachesBelowTheVisibleSystemNavigation() {
        try (ActivityScenario<EdgeToEdgeTestActivity> scenario = ActivityScenario.launch(EdgeToEdgeTestActivity.class)) {
            await(scenario, "fixture loaded", EdgeToEdgePresentationTest::hasLoaded);
            scenario.onActivity(a -> {
                plugin(a).enableEdgeToEdge(new ResultCall());
                webView(a).evaluateJavascript(
                        "document.documentElement.style.backgroundColor = '#d06b9f'", null);
            });
            await(scenario, "visible bottom navigation over the WebView",
                    a -> barsVisible(a) && read(a).optInt("bottom") > 0
                            && webView(a).getHeight() == a.getWindow().getDecorView().getHeight());
            int[] bottom = new int[1];
            scenario.onActivity(a -> bottom[0] = rootInsets(a)
                    .getInsets(WindowInsetsCompat.Type.navigationBars()).bottom);
            assertTrue("Run this portrait test with visible bottom navigation", bottom[0] > 4);
            int expected = Color.rgb(208, 107, 159);
            long deadline = SystemClock.uptimeMillis() + 4_000;
            int below = Color.TRANSPARENT;
            int above = Color.TRANSPARENT;
            do {
                Bitmap frame = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
                assertNotNull(frame);
                // Avoid the system icons and compare pixels on both sides of the navigation boundary.
                int x = frame.getWidth() / 12;
                below = frame.getPixel(x, frame.getHeight() - bottom[0] / 2);
                above = frame.getPixel(x, frame.getHeight() - bottom[0] - 8);
                frame.recycle();
                if (below == expected && above == expected) return;
                SystemClock.sleep(50);
            } while (SystemClock.uptimeMillis() < deadline);
            assertEquals("WebView background above system navigation", expected, above);
            assertEquals("System navigation must not add a second background", expected, below);
        }
    }

    @Test public void dockedKeyboardResizesEdgeToEdgeViewportAndRestoresGestureInset() {
        try (ActivityScenario<EdgeToEdgeTestActivity> scenario = ActivityScenario.launch(EdgeToEdgeTestActivity.class)) {
            await(scenario, "fixture loaded", EdgeToEdgePresentationTest::hasLoaded);
            scenario.onActivity(a -> plugin(a).enableEdgeToEdge(new ResultCall()));
            await(scenario, "gesture inset measured", a -> topInWindow(webView(a)) == 0 && read(a).optInt("bottom") > 0);
            int[] height = new int[1];
            float[] center = new float[2];
            scenario.onActivity(a -> {
                View web = webView(a);
                height[0] = web.getHeight();
                int[] position = new int[2];
                web.getLocationOnScreen(position);
                center[0] = position[0] + web.getWidth() / 2f;
                center[1] = position[1] + web.getHeight() / 2f;
            });
            long now = SystemClock.uptimeMillis();
            MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, center[0], center[1], 0);
            MotionEvent up = MotionEvent.obtain(now, now, MotionEvent.ACTION_UP, center[0], center[1], 0);
            try {
                InstrumentationRegistry.getInstrumentation().sendPointerSync(down);
                InstrumentationRegistry.getInstrumentation().sendPointerSync(up);
            } finally {
                down.recycle();
                up.recycle();
            }
            await(scenario, "IME reserves viewport once", a -> visible(a, IME) && webView(a).getHeight() < height[0]
                    && a.findViewById(R.id.edgeToEdgeLayout).getPaddingBottom() == rootInsets(a).getInsets(IME).bottom
                    && read(a).optInt("bottom") == 0);
            scenario.onActivity(a -> WindowCompat.getInsetsController(a.getWindow(), webView(a)).hide(IME));
            await(scenario, "IME dismissal restores gesture inset", a -> !visible(a, IME)
                    && webView(a).getHeight() == height[0] && read(a).optInt("bottom") > 0);
        }
    }

    @Test public void normalLandscapeKeepsLateralSafetyAndImmersiveReleasesIt() {
        try (ActivityScenario<InsetsGeometryTestActivity> scenario = ActivityScenario.launch(InsetsGeometryTestActivity.class)) {
            scenario.onActivity(a -> {
                EdgeToEdgeLayout layout = new EdgeToEdgeLayout(a, null);
                a.root.addView(layout);
                WindowInsetsCompat insets = new WindowInsetsCompat.Builder()
                        .setInsets(BARS, Insets.of(0, 48, 17, 24))
                        .setInsetsIgnoringVisibility(BARS, Insets.of(0, 50, 18, 25))
                        .setInsets(WindowInsetsCompat.Type.displayCutout(), Insets.of(32, 0, 0, 0))
                        .setInsets(IME, Insets.of(0, 0, 0, 280))
                        .setVisible(EdgeToEdgeLayout.SYSTEM_SAFE_AREA | IME, true).build();
                assertSame(insets, layout.applyInsets(insets));
                layout.setPresentation(true, false);
                WindowInsetsCompat child = layout.applyInsets(insets);
                assertEquals(32, layout.getPaddingLeft());
                assertEquals(0, layout.getPaddingTop());
                assertEquals(17, layout.getPaddingRight());
                assertEquals(280, layout.getPaddingBottom());
                assertEquals(Insets.NONE, child.getInsets(EdgeToEdgeLayout.SYSTEM_SAFE_AREA | IME));
                assertEquals(Insets.NONE, child.getInsetsIgnoringVisibility(EdgeToEdgeLayout.SYSTEM_SAFE_AREA));
                layout.setPresentation(true, true);
                layout.applyInsets(insets);
                assertEquals(0, layout.getPaddingLeft());
                assertEquals(0, layout.getPaddingRight());
                assertEquals(280, layout.getPaddingBottom());
                layout.setPresentation(false, false);
                assertSame(insets, layout.applyInsets(insets));
                assertEquals(0, layout.getPaddingBottom());
            });
        }
    }

    private static void await(ActivityScenario<EdgeToEdgeTestActivity> scenario, String state, Predicate<EdgeToEdgeTestActivity> ready) {
        AtomicBoolean matched = new AtomicBoolean();
        long deadline = SystemClock.uptimeMillis() + 10_000;
        do {
            scenario.onActivity(a -> matched.set(ready.test(a)));
            if (matched.get()) return;
            SystemClock.sleep(50);
        } while (SystemClock.uptimeMillis() < deadline);
        fail("Timed out waiting for " + state);
    }

    private static boolean hasLoaded(EdgeToEdgeTestActivity a) {
        WebView view = webView(a);
        return view.getProgress() == 100 && "https://localhost/edge-insets.html".equals(view.getUrl());
    }

    private static boolean visible(EdgeToEdgeTestActivity a, int types) {
        WindowInsetsCompat insets = rootInsets(a);
        return insets != null && insets.isVisible(types);
    }

    private static boolean barsVisible(EdgeToEdgeTestActivity a) {
        return visible(a, WindowInsetsCompat.Type.statusBars()) && visible(a, WindowInsetsCompat.Type.navigationBars());
    }

    private static boolean barsHidden(EdgeToEdgeTestActivity a) {
        return rootInsets(a) != null && !visible(a, WindowInsetsCompat.Type.statusBars()) && !visible(a, WindowInsetsCompat.Type.navigationBars());
    }

    private static WindowInsetsCompat rootInsets(EdgeToEdgeTestActivity a) {
        return ViewCompat.getRootWindowInsets(a.getWindow().getDecorView());
    }

    private static int topInWindow(View view) {
        int[] result = new int[2];
        view.getLocationInWindow(result);
        return result[1];
    }

    private static WebView webView(EdgeToEdgeTestActivity a) { return a.getBridge().getWebView(); }

    private static ImmersiveModePlugin plugin(EdgeToEdgeTestActivity a) {
        return (ImmersiveModePlugin) a.getBridge().getPlugin("ImmersiveMode").getInstance();
    }

    private static JSObject read(EdgeToEdgeTestActivity a) {
        ResultCall call = new ResultCall();
        plugin(a).getInsets(call);
        return call.result;
    }

    private static final class ResultCall extends PluginCall {
        JSObject result;
        ResultCall() { this(new JSObject()); }
        ResultCall(JSObject data) { super(null, "ImmersiveMode", "test", "", data); }
        @Override public void resolve(JSObject data) { result = data; }
        @Override public void resolve() { result = new JSObject(); }
        @Override public void reject(String message, String code, Exception cause, JSObject data) {
            throw new AssertionError(message, cause);
        }
    }
}
