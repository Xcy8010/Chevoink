package com.chevoink.app;

import com.getcapacitor.CapConfig;

/** Real shell with a packaged, network-free document and no user account. */
public class EdgeToEdgeTestActivity extends MainActivity {
    @Override protected void load() {
        config = new CapConfig.Builder(this).setStartPath("/edge-insets.html").create();
        super.load();
    }
}
