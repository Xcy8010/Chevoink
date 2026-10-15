package com.chevoink.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class SystemBarAppearancePolicyTest {
    @Test public void preAndroid15KeepsLegacyColorSupport() {
        assertTrue(SystemBarAppearancePolicy.canColor(24, 35, false));
        assertTrue(SystemBarAppearancePolicy.canColor(34, 36, false));
    }
    @Test public void android15HonorsOptOutEvenForTarget36() {
        assertTrue(SystemBarAppearancePolicy.canColor(35, 35, true));
        assertTrue(SystemBarAppearancePolicy.canColor(35, 36, true));
        assertFalse(SystemBarAppearancePolicy.canColor(35, 35, false));
    }
    @Test public void android16StillColorsPublishedTarget35WithOptOut() {
        assertTrue(SystemBarAppearancePolicy.canColor(36, 35, true));
        assertFalse(SystemBarAppearancePolicy.canColor(36, 35, false));
    }
    @Test public void enforcedTarget36DoesNotReportLegacyColorSuccess() {
        assertFalse(SystemBarAppearancePolicy.canColor(36, 36, true));
        assertFalse(SystemBarAppearancePolicy.canColor(36, 36, false));
    }
    @Test public void olderTargetsRemainCompatible() {
        assertTrue(SystemBarAppearancePolicy.canColor(36, 34, false));
    }
    @Test public void acceptsOnlyOpaqueCanonicalBridgeColorShape() {
        assertTrue(SystemBarAppearancePolicy.validColor("#000000"));
        assertTrue(SystemBarAppearancePolicy.validColor("#aAbBfF"));
        for (String invalid : new String[]{null, "#fff", "#00000000", "transparent", "rgb(0,0,0)", "#gg0000", "#000000\n"}) {
            assertFalse(String.valueOf(invalid), SystemBarAppearancePolicy.validColor(invalid));
        }
    }
}
