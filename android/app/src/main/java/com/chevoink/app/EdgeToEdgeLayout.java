package com.chevoink.app;

import android.content.Context;
import android.util.AttributeSet;
import android.widget.FrameLayout;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import java.util.function.Consumer;

/** Adapts insets before Capacitor's WebView-parent listener, leaving Keyboard's listener intact. */
public class EdgeToEdgeLayout extends FrameLayout {
    static final int SYSTEM_SAFE_AREA = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
    private boolean enabled;
    private boolean immersive;
    private Consumer<WindowInsetsCompat> onInsets;

    public EdgeToEdgeLayout(Context context, AttributeSet attrs) {
        super(context, attrs);
        ViewCompat.setOnApplyWindowInsetsListener(this, (view, insets) -> applyInsets(insets));
    }

    void setPresentation(boolean enabled, boolean immersive) {
        this.enabled = enabled;
        this.immersive = immersive;
        if (!enabled) setPadding(0, 0, 0, 0);
        ViewCompat.requestApplyInsets(this);
    }

    void setEdgeInsetsListener(Consumer<WindowInsetsCompat> listener) {
        onInsets = listener;
    }

    WindowInsetsCompat applyInsets(WindowInsetsCompat insets) {
        if (!enabled) return insets;
        if (onInsets != null) onInsets.accept(insets);

        Insets safe = insets.getInsets(SYSTEM_SAFE_AREA);
        int ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
        // Normal pages retain physical landscape margins. The reader measures all four overlay edges.
        setPadding(immersive ? 0 : safe.left, 0, immersive ? 0 : safe.right, ime);

        // Core SystemBars would otherwise pad the WebView parent on older WebViews.
        // The bridge publishes overlay safety to CSS; IME is already reserved above.
        return new WindowInsetsCompat.Builder(insets)
                .setDisplayCutout(null)
                .setInsets(SYSTEM_SAFE_AREA | WindowInsetsCompat.Type.ime(), Insets.NONE)
                .setInsetsIgnoringVisibility(SYSTEM_SAFE_AREA, Insets.NONE)
                .build();
    }
}
