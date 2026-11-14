package com.chevoink.app;

import com.getcapacitor.CapConfig;

import java.util.HashMap;
import java.util.Map;

import org.json.JSONObject;

/** Real shell with a packaged, network-free document and no user account. */
public class EdgeToEdgeTestActivity extends MainActivity {
    @Override protected void load() {
        CapConfig packaged = CapConfig.loadDefault(this);
        Map<String, JSONObject> startupPlugins = new HashMap<>();
        for (String name : new String[] {"SplashScreen", "StatusBar", "SystemBars"}) {
            startupPlugins.put(name, packaged.getPluginConfiguration(name).getConfigJSON());
        }
        String startPath = getIntent().getBooleanExtra("darkStartup", false)
                ? "/edge-insets.html?darkStartup" : "/edge-insets.html";
        config = new CapConfig.Builder(this)
                .setStartPath(startPath)
                .setBackgroundColor(packaged.getBackgroundColor())
                .setPluginsConfiguration(new JSONObject(startupPlugins))
                .create();
        super.load();
    }
}
