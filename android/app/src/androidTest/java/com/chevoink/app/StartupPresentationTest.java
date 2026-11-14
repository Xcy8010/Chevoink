package com.chevoink.app;

import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Build;
import android.util.TypedValue;
import android.view.ContextThemeWrapper;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import org.junit.Test;
import org.junit.runner.RunWith;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

@SuppressWarnings("deprecation")
@RunWith(AndroidJUnit4.class)
public class StartupPresentationTest {
    private static final int PAPER = 0xfffcfaf6;
    private static final int DARK_BOOT = 0xff111318;

    @Test public void launchAndPostSplashThemesAgreeInDayAndNight() {
        for (int mode : new int[] {Configuration.UI_MODE_NIGHT_NO, Configuration.UI_MODE_NIGHT_YES}) {
            Configuration override = new Configuration();
            override.uiMode = mode;
            Context context = targetContext().createConfigurationContext(override);
            assertLightTheme(context, R.style.AppTheme_NoActionBarLaunch);
            assertLightTheme(context, R.style.AppTheme_NoActionBar);
        }
    }

    @Test public void nativeStartupPaintsPaperWithReadableSystemIcons() throws InterruptedException {
        try (ActivityScenario<EdgeToEdgeTestActivity> scenario = launch(false)) {
            awaitDraw(scenario);
            scenario.onActivity(activity -> {
                assertBars(activity.getWindow(), PAPER,
                        Build.VERSION.SDK_INT < Build.VERSION_CODES.O ? Color.BLACK : PAPER, true);
                WebView webView = activity.getBridge().getWebView();
                // The fixture has a transparent document away from its input. Sample the
                // WebView's own background, independent of the containing window color.
                Bitmap pixel = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
                try {
                    webView.draw(new Canvas(pixel));
                    assertEquals(PAPER, pixel.getPixel(0, 0));
                } finally {
                    pixel.recycle();
                }
            });
        }
    }

    @Test public void webStartupThemeSurvivesSplashExit() throws InterruptedException {
        try (ActivityScenario<EdgeToEdgeTestActivity> scenario = launch(true)) {
            awaitDraw(scenario);
            scenario.onActivity(activity -> assertBars(activity.getWindow(), DARK_BOOT, DARK_BOOT, false));
        }
    }

    private static void awaitDraw(ActivityScenario<EdgeToEdgeTestActivity> scenario) throws InterruptedException {
        CountDownLatch drawn = new CountDownLatch(1);
        scenario.onActivity(activity -> {
            View decor = activity.getWindow().getDecorView();
            ViewTreeObserver.OnDrawListener listener = new ViewTreeObserver.OnDrawListener() {
                @Override public void onDraw() {
                    decor.post(() -> {
                        decor.getViewTreeObserver().removeOnDrawListener(this);
                        drawn.countDown();
                    });
                }
            };
            decor.getViewTreeObserver().addOnDrawListener(listener);
            decor.invalidate();
        });
        assertTrue("The Activity drew after the splash screen", drawn.await(10, TimeUnit.SECONDS));
    }

    private static void assertLightTheme(Context context, int style) {
        Context themed = new ContextThemeWrapper(context, style);
        assertEquals(PAPER, themeValue(themed, android.R.attr.windowBackground));
        assertEquals(PAPER, themeValue(themed, android.R.attr.statusBarColor));
        assertEquals(Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1 ? Color.BLACK : PAPER,
                themeValue(themed, android.R.attr.navigationBarColor));
        assertTrue(themeValue(themed, android.R.attr.windowLightStatusBar) != 0);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            assertTrue(themeValue(themed, android.R.attr.windowLightNavigationBar) != 0);
        }
    }

    private static int themeValue(Context context, int attr) {
        TypedValue value = new TypedValue();
        assertTrue(context.getTheme().resolveAttribute(attr, value, true));
        return value.data;
    }

    private static void assertBars(Window window, int status, int navigation, boolean isLight) {
        assertEquals(status, window.getStatusBarColor());
        assertEquals(navigation, window.getNavigationBarColor());
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        assertEquals(isLight, controller.isAppearanceLightStatusBars());
        assertEquals(isLight && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O,
                controller.isAppearanceLightNavigationBars());
    }

    private static ActivityScenario<EdgeToEdgeTestActivity> launch(boolean dark) {
        Intent intent = new Intent(targetContext(), EdgeToEdgeTestActivity.class).putExtra("darkStartup", dark);
        return ActivityScenario.launch(intent);
    }

    private static Context targetContext() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }
}
