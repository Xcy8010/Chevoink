package com.chevoink.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class SystemBarAppearanceTransactionTest {
    private static final int NIGHT = 0xff111318, BLACK = 0xff000000, THEME = 0xff303030;

    private static final class Part implements SystemBarAppearanceTransaction.Part {
        Integer color;
        boolean dark;
        int writes, restores;
        RuntimeException failApply, failRestore, failCapture;
        Part(Integer color) { this.color = color; }
        @Override public Runnable snapshot() {
            if (failCapture != null) throw failCapture;
            Integer savedColor = color;
            boolean savedDark = dark;
            return () -> {
                restores++;
                if (failRestore != null) throw failRestore;
                color = savedColor;
                dark = savedDark;
            };
        }
        @Override public void apply(int color, boolean dark) {
            writes++;
            this.color = color;
            this.dark = dark;
            if (failApply != null) throw failApply;
        }
    }

    @Test public void paintsBarsDecorAndPaddedParentTogether() {
        Part bars = new Part(BLACK), decor = new Part(THEME), parent = new Part(null);
        SystemBarAppearanceTransaction.apply(NIGHT, true, bars, decor, parent);
        for (Part part : new Part[]{bars, decor, parent}) {
            assertEquals(Integer.valueOf(NIGHT), part.color);
            assertTrue(part.dark);
            assertEquals(1, part.writes);
        }
    }

    @Test public void everyPartialWriteFailureRestoresAllAttemptedParts() {
        for (int failed = 0; failed < 3; failed++) {
            Part[] parts = {new Part(BLACK), new Part(THEME), new Part(null)};
            RuntimeException failure = new RuntimeException("partial " + failed);
            parts[failed].failApply = failure;
            try { SystemBarAppearanceTransaction.apply(NIGHT, true, parts); fail("must reject"); }
            catch (RuntimeException actual) { assertSame(failure, actual); }
            assertEquals(Integer.valueOf(BLACK), parts[0].color);
            assertEquals(Integer.valueOf(THEME), parts[1].color);
            assertNull(parts[2].color);
            for (int i = 0; i < parts.length; i++) {
                assertFalse(parts[i].dark);
                assertEquals(i <= failed ? 1 : 0, parts[i].restores);
            }
        }
    }

    @Test public void failedCaptureDoesNotStartAnyWrite() {
        Part bars = new Part(BLACK), parent = new Part(null);
        RuntimeException failure = new RuntimeException("capture");
        parent.failCapture = failure;
        try { SystemBarAppearanceTransaction.apply(NIGHT, true, bars, parent); fail("must reject"); }
        catch (RuntimeException actual) { assertSame(failure, actual); }
        assertEquals(0, bars.writes);
        assertEquals(0, parent.writes);
    }

    @Test public void rollbackFailureDoesNotPreventRestoringOtherPartsOrHideOriginalError() {
        Part bars = new Part(BLACK), decor = new Part(THEME), parent = new Part(null);
        RuntimeException failure = new RuntimeException("paint"), rollback = new RuntimeException("rollback");
        parent.failApply = failure;
        decor.failRestore = rollback;
        try { SystemBarAppearanceTransaction.apply(NIGHT, true, bars, decor, parent); fail("must reject"); }
        catch (RuntimeException actual) {
            assertSame(failure, actual);
            assertArrayEquals(new Throwable[]{rollback}, actual.getSuppressed());
        }
        assertEquals(Integer.valueOf(BLACK), bars.color);
        assertNull(parent.color);
        assertEquals(1, bars.restores);
    }

    @Test public void normalCanvasSnapshotSurvivesRepeatedReaderPaintsAndCoreThemeRepaint() {
        Part decor = new Part(BLACK), parent = new Part(null);
        Runnable normal = SystemBarAppearanceTransaction.snapshot(decor, parent);
        decor.color = THEME; // Core SystemBars can repaint after the snapshot.
        SystemBarAppearanceTransaction.apply(NIGHT, true, decor, parent);
        SystemBarAppearanceTransaction.apply(0xffeee8da, false, decor, parent);
        normal.run();
        assertEquals(Integer.valueOf(BLACK), decor.color);
        assertNull(parent.color);
    }

    @Test public void latestOwnerWinsAfterExitAndConfigurationRestoration() {
        Part decor = new Part(BLACK), parent = new Part(BLACK);
        Runnable normal = SystemBarAppearanceTransaction.snapshot(decor, parent);
        SystemBarAppearanceTransaction.apply(NIGHT, true, decor, parent);
        normal.run();
        SystemBarAppearanceTransaction.apply(0xffffffff, false, decor, parent); // New Web owner after exit.
        decor.color = THEME; // Core configuration update.
        SystemBarAppearanceTransaction.apply(0xffffffff, false, decor, parent); // Latest desired reapply.
        assertEquals(Integer.valueOf(0xffffffff), decor.color);
        assertEquals(Integer.valueOf(0xffffffff), parent.color);
        assertFalse(decor.dark);
    }

    @Test public void snapshotRestoreAttemptsEverySurfaceEvenIfOneCannotRestore() {
        Part decor = new Part(BLACK), parent = new Part(null);
        Runnable normal = SystemBarAppearanceTransaction.snapshot(decor, parent);
        SystemBarAppearanceTransaction.apply(NIGHT, true, decor, parent);
        RuntimeException failure = new RuntimeException("parent restore");
        parent.failRestore = failure;
        try { normal.run(); fail("must report restore failure"); }
        catch (RuntimeException actual) { assertSame(failure, actual); }
        assertEquals(Integer.valueOf(BLACK), decor.color);
        assertEquals(1, decor.restores);
    }

    @Test public void canvasFailureCannotPreventWindowLayoutRestoration() {
        StringBuilder order = new StringBuilder();
        RuntimeException failure = new RuntimeException("canvas restore");
        Runnable[] restores = { () -> { order.append("canvas"); throw failure; },
                () -> order.append("window") };
        try { SystemBarAppearanceTransaction.restore(restores, restores.length, null); fail("must report"); }
        catch (RuntimeException actual) { assertSame(failure, actual); }
        assertEquals("windowcanvas", order.toString());
    }
}
