package com.chevoink.app;

import android.app.Activity;
import android.os.Bundle;
import android.widget.FrameLayout;

/** A local, empty attached View tree; never loads a site or accesses author data. */
public class InsetsGeometryTestActivity extends Activity {
    FrameLayout root;
    FrameLayout parent;
    android.view.View webView;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        root = new FrameLayout(this);
        parent = new FrameLayout(this);
        webView = new android.view.View(this);
        parent.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-1, -1);
        params.setMargins(12, 72, 17, 24);
        root.addView(parent, params);
        setContentView(root);
    }
}
