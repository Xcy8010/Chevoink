package com.chevoink.app;

import android.content.Context;
import android.util.AttributeSet;
import android.webkit.ValueCallback;

import com.getcapacitor.CapacitorWebView;

/** The old bridge can still deliver lifecycle events while a dead renderer is being replaced. */
public final class ShellWebView extends CapacitorWebView {
    private boolean disposed;

    public ShellWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override public void destroy() {
        if (disposed) return;
        disposed = true;
        super.destroy();
    }

    @Override public void evaluateJavascript(String script, ValueCallback<String> resultCallback) {
        if (!disposed) super.evaluateJavascript(script, resultCallback);
    }

    @Override public void onPause() {
        if (!disposed) super.onPause();
    }

    @Override public void onResume() {
        if (!disposed) super.onResume();
    }

    @Override public void pauseTimers() {
        if (!disposed) super.pauseTimers();
    }

    @Override public void resumeTimers() {
        if (!disposed) super.resumeTimers();
    }
}
