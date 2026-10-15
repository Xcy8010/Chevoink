package com.chevoink.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class FittedSystemBarPaddingTest {
    @Test public void removesBarInsetAlreadyReservedByNormalWindow() {
        assertEquals(0, FittedSystemBarPadding.remaining(72, 72, 72, false));
        assertEquals(0, FittedSystemBarPadding.remaining(72, 72, 90, false));
    }

    @Test public void partialAnimationWaitsForWholeInsetToBeReservedOutside() {
        int midway = FittedSystemBarPadding.remaining(80, 80, 48, false);
        assertEquals(80, midway);
        assertEquals(0, FittedSystemBarPadding.remaining(midway, 80, 80, false));
    }

    @Test public void edgeToEdgeStillNeedsFullNativePadding() {
        assertEquals(72, FittedSystemBarPadding.remaining(72, 72, 0, false));
        assertEquals(72, FittedSystemBarPadding.remaining(72, 72, -8, false));
    }

    @Test public void passthroughAndCustomPaddingRemainUntouched() {
        assertEquals(0, FittedSystemBarPadding.remaining(0, 72, 72, false));
        assertEquals(91, FittedSystemBarPadding.remaining(91, 72, 72, false));
        assertEquals(11, FittedSystemBarPadding.remaining(11, 0, 72, false));
    }

    @Test public void visibleImeIsProtectedEvenWhenHeightCoincidesWithBar() {
        assertEquals(48, FittedSystemBarPadding.remaining(48, 48, 48, true));
        assertEquals(660, FittedSystemBarPadding.remaining(660, 48, 660, true));
    }

    @Test public void repeatedSettledLayoutIsIdempotentAndFreshCoreWriteIsCorrected() {
        int corrected = FittedSystemBarPadding.remaining(80, 80, 80, false);
        assertEquals(0, FittedSystemBarPadding.remaining(corrected, 80, 80, false));
        assertEquals(0, FittedSystemBarPadding.remaining(80, 80, 80, false));
    }

    @Test public void rotationUsesNewInsetAndFittedGeometryInsteadOfCapturedPortraitHeight() {
        assertEquals(0, FittedSystemBarPadding.remaining(72, 72, 72, false));
        assertEquals(52, FittedSystemBarPadding.remaining(52, 52, 32, false));
        assertEquals(0, FittedSystemBarPadding.remaining(28, 28, 28, false));
    }
}
