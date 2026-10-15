package com.chevoink.app;

/** Deduplicate only a recognized system-bar inset already reserved outside the parent. */
final class FittedSystemBarPadding {
    private FittedSystemBarPadding() {}

    static int remaining(int padding, int barInset, int fittedSpace, boolean protectedEdge) {
        // Arbitrary/custom padding and IME padding are not ours to restore.
        // A partial ancestor offset may be an in-flight window/bar animation.
        // Keep the full reservation until it is wholly accounted for outside.
        if (protectedEdge || barInset <= 0 || padding != barInset || fittedSpace < barInset) return padding;
        return 0;
    }
}
