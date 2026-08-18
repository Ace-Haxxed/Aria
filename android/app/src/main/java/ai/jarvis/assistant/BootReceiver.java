package ai.jarvis.assistant;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

/**
 * Restarts wake-word listening after a reboot — but only if the user turned it
 * on. Auto-starting a microphone service that the user never enabled would be
 * both a privacy problem and a Play Store policy violation.
 */
public class BootReceiver extends BroadcastReceiver {

    /** Capacitor Preferences writes into this SharedPreferences file. */
    private static final String PREFS = "CapacitorStorage";
    private static final String KEY = "jarvis.autostart";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }

        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            return;
        }

        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        // Capacitor stores everything as a string, so this is "true"/"false".
        if (!"true".equals(prefs.getString(KEY, "false"))) {
            return;
        }

        Intent service = new Intent(context, WakeWordService.class);
        service.setAction(WakeWordService.ACTION_START);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(service);
        } else {
            context.startService(service);
        }
    }
}
