package com.chevoink.app;

import android.view.View;
import android.widget.FrameLayout;
import androidx.core.graphics.Insets;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Attached Android Views with synthetic bar insets; not a device/OEM acceptance claim. */
@RunWith(AndroidJUnit4.class)
public class FittedSystemBarPaddingViewTest {
    private static WindowInsetsCompat bars(int left, int top, int right, int bottom, boolean ime) {
        return new WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(), Insets.of(left, top, right, bottom))
                .setVisible(WindowInsetsCompat.Type.ime(), ime).build();
    }

    @Test public void fittedParentRawPaddingBecomesSingleReservationAndThenFixedPoint() {
        try (ActivityScenario<InsetsGeometryTestActivity> scenario = ActivityScenario.launch(InsetsGeometryTestActivity.class)) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(a -> {
                a.parent.setPadding(12, 72, 17, 24);
                layout(a);
                assertTrue(ImmersiveModePlugin.reconcileFittedPadding(a.root, a.webView, a.parent, bars(12, 72, 17, 24, false)));
                assertEquals(0, a.parent.getPaddingTop());
                assertEquals(0, a.parent.getPaddingLeft());
                assertEquals(0, a.parent.getPaddingRight());
                assertEquals(0, a.parent.getPaddingBottom());
                layout(a);
                assertFalse(ImmersiveModePlugin.reconcileFittedPadding(a.root, a.webView, a.parent, bars(12, 72, 17, 24, false)));
            });
        }
    }

    @Test public void fullWindowPaddingAndModernWebViewZeroPaddingArePreserved() {
        try (ActivityScenario<InsetsGeometryTestActivity> scenario = ActivityScenario.launch(InsetsGeometryTestActivity.class)) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(a -> {
                FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) a.parent.getLayoutParams();
                params.setMargins(0, 0, 0, 0);
                a.parent.setLayoutParams(params);
                a.parent.setPadding(0, 72, 0, 24);
                layout(a);
                assertFalse(ImmersiveModePlugin.reconcileFittedPadding(a.root, a.webView, a.parent, bars(0, 72, 0, 24, false)));
                assertEquals(72, a.parent.getPaddingTop());
                a.parent.setPadding(0, 0, 0, 0);
                layout(a);
                assertFalse(ImmersiveModePlugin.reconcileFittedPadding(a.root, a.webView, a.parent, bars(0, 72, 0, 24, false)));
            });
        }
    }

    @Test public void recomputesChangedGeometryPreservesRtlImeAndSkipsPendingLayout() {
        try (ActivityScenario<InsetsGeometryTestActivity> scenario = ActivityScenario.launch(InsetsGeometryTestActivity.class)) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(a -> {
                FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) a.parent.getLayoutParams();
                params.setMargins(20, 32, 11, 24);
                a.parent.setLayoutParams(params);
                a.parent.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
                a.parent.setPaddingRelative(11, 52, 20, 24);
                assertFalse(ImmersiveModePlugin.reconcileFittedPadding(a.root, a.webView, a.parent, bars(20, 52, 11, 24, true)));
                layout(a);
                assertTrue(ImmersiveModePlugin.reconcileFittedPadding(a.root, a.webView, a.parent, bars(20, 52, 11, 24, true)));
                assertEquals(52, a.parent.getPaddingTop());
                assertEquals(24, a.parent.getPaddingBottom());
                assertTrue(a.parent.isPaddingRelative());
                assertEquals(0, a.parent.getPaddingStart());
                assertEquals(0, a.parent.getPaddingEnd());
            });
        }
    }

    @Test public void partialOffsetThenFullOffsetDoesNotLeaveIntermediatePadding() {
        try (ActivityScenario<InsetsGeometryTestActivity> scenario = ActivityScenario.launch(InsetsGeometryTestActivity.class)) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(a -> {
                FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) a.parent.getLayoutParams();
                params.topMargin = 48;
                a.parent.setLayoutParams(params);
                a.parent.setPadding(0, 80, 0, 0);
                layout(a);
                assertFalse(ImmersiveModePlugin.reconcileFittedPadding(a.root, a.webView, a.parent, bars(0, 80, 0, 0, false)));
                assertEquals(80, a.parent.getPaddingTop());
                params.topMargin = 80;
                a.parent.setLayoutParams(params);
                layout(a);
                assertTrue(ImmersiveModePlugin.reconcileFittedPadding(a.root, a.webView, a.parent, bars(0, 80, 0, 0, false)));
                assertEquals(0, a.parent.getPaddingTop());
            });
        }
    }

    @Test public void detachedOrReparentedViewsAndMissingInsetsAreNoOps() {
        try (ActivityScenario<InsetsGeometryTestActivity> scenario = ActivityScenario.launch(InsetsGeometryTestActivity.class)) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(a -> {
                a.parent.setPadding(0, 72, 0, 0);
                layout(a);
                assertFalse(ImmersiveModePlugin.reconcileFittedPadding(a.root, a.webView, a.parent, null));
                a.parent.removeView(a.webView);
                a.root.addView(a.webView, new FrameLayout.LayoutParams(-1, -1));
                layout(a);
                assertFalse(ImmersiveModePlugin.reconcileFittedPadding(a.root, a.webView, a.parent, bars(0, 72, 0, 0, false)));
                a.root.removeView(a.parent);
                assertFalse(ImmersiveModePlugin.reconcileFittedPadding(a.root, a.webView, a.parent, bars(0, 72, 0, 0, false)));
                assertEquals(72, a.parent.getPaddingTop());
            });
        }
    }

    @Test public void differentWindowCannotAuthorizePaddingRemoval() {
        try (ActivityScenario<InsetsGeometryTestActivity> first = ActivityScenario.launch(InsetsGeometryTestActivity.class)) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            final InsetsGeometryTestActivity[] saved = new InsetsGeometryTestActivity[1];
            first.onActivity(a -> { saved[0] = a; a.parent.setPadding(0, 72, 0, 0); layout(a); });
            try (ActivityScenario<InsetsGeometryTestActivity> second = ActivityScenario.launch(InsetsGeometryTestActivity.class)) {
                InstrumentationRegistry.getInstrumentation().waitForIdleSync();
                second.onActivity(b -> {
                    assertNotEquals(b.root.getWindowToken(), saved[0].parent.getWindowToken());
                    assertFalse(ImmersiveModePlugin.reconcileFittedPadding(b.root, saved[0].webView, saved[0].parent, bars(0, 72, 0, 0, false)));
                    assertEquals(72, saved[0].parent.getPaddingTop());
                });
            }
        }
    }

    private static void layout(InsetsGeometryTestActivity a) {
        int width = a.root.getWidth(), height = a.root.getHeight();
        assertTrue(width > 0 && height > 0);
        a.root.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        a.root.layout(a.root.getLeft(), a.root.getTop(), a.root.getRight(), a.root.getBottom());
    }
}
