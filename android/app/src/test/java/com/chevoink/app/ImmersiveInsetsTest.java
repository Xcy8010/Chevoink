package com.chevoink.app;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class ImmersiveInsetsTest {
    @Test public void stableMeasurementPreservesLegacyEnterBeforeLayout() {
        assertEquals(44, ImmersiveInsets.remaining(132, 132, 3f, true));
        assertEquals(0, ImmersiveInsets.remaining(132, 132, 3f, false));
    }

    @Test public void normalWebViewDoesNotReserveSystemBarTwice() {
        assertEquals(0, ImmersiveInsets.remaining(132, 132, 3f));
    }

    @Test public void edgeToEdgeWebViewReservesActualInsetInCssPixels() {
        assertEquals(44, ImmersiveInsets.remaining(132, 0, 3f));
    }

    @Test public void partiallyReservedCutoutOnlyAddsUncoveredSpace() {
        assertEquals(16, ImmersiveInsets.remaining(180, 132, 3f));
    }

    @Test public void keyboardResizeDoesNotBecomeBottomSafeArea() {
        assertEquals(0, ImmersiveInsets.remaining(72, 900, 3f));
    }

    @Test public void landscapeCutoutWorksOnEitherSide() {
        assertEquals(36, ImmersiveInsets.remaining(90, 0, 2.5f));
        assertEquals(0, ImmersiveInsets.remaining(90, 90, 2.5f));
    }

    @Test public void negativeViewOffsetDoesNotInflateSystemInset() {
        assertEquals(24, ImmersiveInsets.remaining(60, -20, 2.5f));
    }

    @Test public void noInsetNeverInventsNotchPadding() {
        assertEquals(0, ImmersiveInsets.remaining(0, 0, 3f));
    }
}
