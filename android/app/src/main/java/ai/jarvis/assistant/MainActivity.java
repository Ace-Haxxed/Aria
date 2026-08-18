package ai.jarvis.assistant;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;

import com.getcapacitor.BridgeActivity;

/**
 * Hosts the Capacitor web view and translates Android entry points — share
 * sheet, deep link, widget, quick tile — into a single message the web layer
 * can act on.
 */
public class MainActivity extends BridgeActivity {

    /** Set by the widget and the quick settings tile to open straight into listening. */
    public static final String EXTRA_START_LISTENING = "ai.jarvis.START_LISTENING";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // singleTask means a second launch reuses this activity rather than
        // creating another, so the new intent arrives here instead of onCreate.
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) {
            return;
        }

        String action = intent.getAction();
        String message = null;

        if (Intent.ACTION_SEND.equals(action)) {
            message = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (TextUtils.isEmpty(message)) {
                // An image share has no text; describe the intent instead so
                // the assistant can ask what to do with it.
                Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (stream != null) {
                    message = "The user shared an image with you.";
                }
            }
        } else if ("android.intent.action.PROCESS_TEXT".equals(action)) {
            CharSequence selected = intent.getCharSequenceExtra("android.intent.extra.PROCESS_TEXT");
            if (selected != null) {
                message = selected.toString();
            }
        } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            message = intent.getData().getQueryParameter("message");
        }

        if (intent.getBooleanExtra(EXTRA_START_LISTENING, false)) {
            dispatch("jarvis:start-listening", "");
            return;
        }

        if (!TextUtils.isEmpty(message)) {
            dispatch("jarvis:shared-text", message);
        }
    }

    /**
     * Forward to the web layer as a DOM event.
     *
     * The bridge may not have finished loading when an intent arrives on a cold
     * start, so this is posted to the web view's own thread and queued behind
     * whatever it is already doing.
     */
    private void dispatch(final String eventName, final String payload) {
        if (getBridge() == null || getBridge().getWebView() == null) {
            return;
        }

        final String escaped = payload
                .replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\n", "\\n")
                .replace("\r", "");

        final String script =
                "window.dispatchEvent(new CustomEvent('" + eventName + "', "
                        + "{ detail: '" + escaped + "' }));";

        getBridge().getWebView().post(new Runnable() {
            @Override
            public void run() {
                getBridge().getWebView().evaluateJavascript(script, null);
            }
        });
    }
}
