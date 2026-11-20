package com.chevoink.app;

import android.os.SystemClock;
import android.content.Intent;
import android.view.View;
import android.webkit.WebView;
import android.webkit.WebViewRenderProcess;

import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.SdkSuppress;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry;
import androidx.test.runner.lifecycle.Stage;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

@RunWith(AndroidJUnit4.class)
public class WebViewResumeTest {
    @Test public void normalResumeKeepsTheSameDocumentAndWebView() throws Exception {
        try (ActivityScenario<EdgeToEdgeTestActivity> scenario = ActivityScenario.launch(EdgeToEdgeTestActivity.class)) {
            EdgeToEdgeTestActivity initial = awaitActivity(candidate -> true);
            WebView webView = webViewOf(initial);
            awaitDocument(webView);
            assertEquals("42", evaluate(webView, "window.resumeSentinel = 42"));

            scenario.moveToState(Lifecycle.State.CREATED);
            scenario.moveToState(Lifecycle.State.RESUMED);

            assertSame(initial, awaitActivity(candidate -> true));
            assertSame(webView, webViewOf(initial));
            assertEquals("42", evaluate(webView, "window.resumeSentinel"));
        }
    }

    @SdkSuppress(minSdkVersion = 29)
    @Test public void rendererExitRecreatesOnceAndShowsRetryIfItRepeats() throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        var intent = new Intent(instrumentation.getTargetContext(), EdgeToEdgeTestActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        var initial = (EdgeToEdgeTestActivity) instrumentation.startActivitySync(intent);
        try {
            WebView initialView = webViewOf(initial);
            awaitDocument(initialView);
            terminateRenderer(initialView);

            EdgeToEdgeTestActivity restored = awaitActivity(candidate -> candidate != initial);
            WebView restoredView = webViewOf(restored);
            awaitDocument(restoredView);
            onMain(() -> {
                assertEquals(View.GONE, restored.findViewById(R.id.offlineRoot).getVisibility());
                assertNull(initialView.getParent());
            });
            terminateRenderer(restoredView);
            awaitActivity(candidate -> candidate == restored
                    && candidate.findViewById(R.id.offlineRoot).getVisibility() == View.VISIBLE
                    && candidate.findViewById(R.id.offlineRetry).isEnabled());

            onMain(() -> assertTrue(restored.findViewById(R.id.offlineRetry).performClick()));
            EdgeToEdgeTestActivity retried = awaitActivity(candidate -> candidate != restored && candidate != initial);
            awaitDocument(webViewOf(retried));
        } finally {
            // ActivityScenario.close waits for main-queue idleness before
            // finishing. After a real renderer restart WebView can keep it busy.
            onMain(() -> {
                for (var activity : ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)) {
                    if (activity instanceof EdgeToEdgeTestActivity) activity.finish();
                }
            });
        }
    }

    private static EdgeToEdgeTestActivity awaitActivity(Predicate<EdgeToEdgeTestActivity> predicate) {
        long deadline = SystemClock.elapsedRealtime() + 10_000;
        AtomicReference<EdgeToEdgeTestActivity> match = new AtomicReference<>();
        while (match.get() == null && SystemClock.elapsedRealtime() < deadline) {
            onMain(() -> {
                for (android.app.Activity activity : ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)) {
                    if (activity instanceof EdgeToEdgeTestActivity candidate && predicate.test(candidate)) {
                        match.set(candidate);
                        break;
                    }
                }
            });
            if (match.get() == null) SystemClock.sleep(50);
        }
        assertNotNull("Expected a resumed Activity", match.get());
        return match.get();
    }

    private static WebView webViewOf(EdgeToEdgeTestActivity activity) {
        AtomicReference<WebView> view = new AtomicReference<>();
        onMain(() -> view.set(activity.getBridge().getWebView()));
        return view.get();
    }

    private static void awaitDocument(WebView webView) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 10_000;
        while (SystemClock.elapsedRealtime() < deadline) {
            if ("true".equals(evaluate(webView, "document.readyState === 'complete' && location.pathname === '/edge-insets.html'"))) return;
            SystemClock.sleep(50);
        }
        fail("The packaged test document did not finish loading");
    }

    private static String evaluate(WebView webView, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> response = new AtomicReference<>();
        onMain(() -> webView.evaluateJavascript(script, result -> {
            response.set(result);
            done.countDown();
        }));
        assertTrue("Expected JavaScript result from WebView", done.await(5, TimeUnit.SECONDS));
        return response.get();
    }

    private static void terminateRenderer(WebView webView) {
        onMain(() -> {
            WebViewRenderProcess renderer = webView.getWebViewRenderProcess();
            assertNotNull(renderer);
            assertTrue(renderer.terminate());
        });
    }

    private static void onMain(Runnable action) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(action);
    }
}
