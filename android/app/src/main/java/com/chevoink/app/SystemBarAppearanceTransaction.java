package com.chevoink.app;

/** One presentation write across the bars and the two native canvas surfaces. */
final class SystemBarAppearanceTransaction {
    interface Part {
        Runnable snapshot();
        void apply(int color, boolean dark);
    }

    static Runnable snapshot(Part... parts) {
        Runnable[] restores = capture(parts);
        return () -> restore(restores, restores.length, null);
    }

    static void apply(int color, boolean dark, Part... parts) {
        Runnable[] restores = capture(parts);
        int attempted = 0;
        try {
            for (Part part : parts) {
                attempted++;
                part.apply(color, dark);
            }
        } catch (RuntimeException error) {
            restore(restores, attempted, error);
            throw error;
        }
    }

    private static Runnable[] capture(Part[] parts) {
        Runnable[] restores = new Runnable[parts.length];
        for (int i = 0; i < parts.length; i++) restores[i] = parts[i].snapshot();
        return restores;
    }

    static void restore(Runnable[] restores, int count, RuntimeException failure) {
        RuntimeException first = failure;
        for (int i = count - 1; i >= 0; i--) {
            try { restores[i].run(); }
            catch (RuntimeException error) {
                if (first == null) first = error;
                else if (error != first) first.addSuppressed(error);
            }
        }
        if (failure == null && first != null) throw first;
    }
}
