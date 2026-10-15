package com.chevoink.app;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.view.View;
import android.widget.FrameLayout;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real Android View behavior; requires a device/emulator, never inferred from JVM policy tests. */
@RunWith(AndroidJUnit4.class)
public class NativeCanvasBackgroundTest {
    private static final int NIGHT = 0xff111318, BLACK = 0xff000000, THEME = 0xff303030;

    @Test public void paintsExposedParentAndDecorWithoutChangingPaddingOrMutatingSnapshot() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            View decor = new View(context);
            FrameLayout parent = new FrameLayout(context);
            decor.setBackgroundColor(BLACK);
            parent.setPadding(13, 52, 17, 29);
            ImmersiveModePlugin.CanvasTarget a = new ImmersiveModePlugin.CanvasTarget(decor);
            ImmersiveModePlugin.CanvasTarget b = new ImmersiveModePlugin.CanvasTarget(parent);
            Runnable normal = SystemBarAppearanceTransaction.snapshot(a, b);
            decor.setBackgroundColor(THEME); // Mutates the attached ColorDrawable in core SystemBars.
            SystemBarAppearanceTransaction.apply(NIGHT, true, a, b);
            assertEquals(NIGHT, ((ColorDrawable) decor.getBackground()).getColor());
            assertEquals(NIGHT, ((ColorDrawable) parent.getBackground()).getColor());
            assertPadding(parent, 13, 52, 17, 29);
            normal.run();
            assertEquals(BLACK, ((ColorDrawable) decor.getBackground()).getColor());
            assertNull(parent.getBackground());
            assertPadding(parent, 13, 52, 17, 29);
        });
    }

    @Test public void restoringPaddedDrawableRetainsCurrentRelativeImePadding() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            View parent = new View(InstrumentationRegistry.getInstrumentation().getTargetContext());
            parent.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
            Drawable original = new Drawable() {
                @Override public void draw(Canvas canvas) {}
                @Override public void setAlpha(int alpha) {}
                @Override public void setColorFilter(ColorFilter filter) {}
                @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
                @Override public boolean getPadding(Rect out) { out.set(1, 2, 3, 4); return true; }
            };
            parent.setBackground(original);
            parent.setPaddingRelative(11, 22, 33, 44);
            ImmersiveModePlugin.CanvasTarget target = new ImmersiveModePlugin.CanvasTarget(parent);
            Runnable normal = target.snapshot();
            target.apply(NIGHT, true);
            parent.setPaddingRelative(11, 22, 33, 333); // A later IME/insets update must not be rewound.
            normal.run();
            assertSame(original, parent.getBackground());
            assertTrue(parent.isPaddingRelative());
            assertEquals(11, parent.getPaddingStart());
            assertEquals(33, parent.getPaddingEnd());
            assertEquals(22, parent.getPaddingTop());
            assertEquals(333, parent.getPaddingBottom());
        });
    }

    @Test public void failedCanvasWriteRollsBackBothRealViewBackgrounds() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            View decor = new View(context), parent = new View(context);
            decor.setBackgroundColor(BLACK);
            parent.setPadding(0, 52, 0, 29);
            ImmersiveModePlugin.CanvasTarget a = new ImmersiveModePlugin.CanvasTarget(decor), b = new ImmersiveModePlugin.CanvasTarget(parent);
            RuntimeException failure = new RuntimeException("partial canvas");
            SystemBarAppearanceTransaction.Part failing = new SystemBarAppearanceTransaction.Part() {
                @Override public Runnable snapshot() { return b.snapshot(); }
                @Override public void apply(int color, boolean dark) { b.apply(color, dark); throw failure; }
            };
            try { SystemBarAppearanceTransaction.apply(NIGHT, true, a, failing); fail("must reject"); }
            catch (RuntimeException actual) { assertSame(failure, actual); }
            assertEquals(BLACK, ((ColorDrawable) decor.getBackground()).getColor());
            assertNull(parent.getBackground());
            assertPadding(parent, 0, 52, 0, 29);
        });
    }

    private static void assertPadding(View view, int left, int top, int right, int bottom) {
        assertEquals(left, view.getPaddingLeft()); assertEquals(top, view.getPaddingTop());
        assertEquals(right, view.getPaddingRight()); assertEquals(bottom, view.getPaddingBottom());
    }
}
