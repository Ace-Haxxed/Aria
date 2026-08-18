package ai.jarvis.assistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Keeps Jarvis reachable by voice while the app is not in the foreground.
 *
 * Android will not let an app record audio indefinitely from the background:
 * a foreground service with an ongoing notification is the only supported
 * mechanism, and from API 34 it must declare a `microphone` service type. The
 * notification is deliberately non-dismissible and states plainly that Jarvis
 * is listening.
 */
public class WakeWordService extends Service {

    private static final String CHANNEL_ID = "jarvis_wake_word";
    private static final int NOTIFICATION_ID = 4711;

    public static final String ACTION_START = "ai.jarvis.WAKE_WORD_START";
    public static final String ACTION_STOP = "ai.jarvis.WAKE_WORD_STOP";

    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        startForegroundCompat();
        acquireWakeLock();

        // START_STICKY: if the system reclaims the process under memory
        // pressure, restart the service so wake-word listening resumes.
        return START_STICKY;
    }

    private void startForegroundCompat() {
        Notification notification = buildNotification();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent openPending = PendingIntent.getActivity(
                this,
                0,
                open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Intent stop = new Intent(this, WakeWordService.class);
        stop.setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
                this,
                1,
                stop,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return builder
                .setContentTitle("Jarvis is listening")
                .setContentText("Say your wake word to start a request.")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentIntent(openPending)
                .addAction(new Notification.Action.Builder(
                        null, "Stop listening", stopPending).build())
                .setOngoing(true)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Wake word",
                // LOW: the service must be visible, but it should not make noise.
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while Jarvis is listening for its wake word.");
        channel.setShowBadge(false);

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            return;
        }

        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power == null) {
            return;
        }

        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Jarvis::WakeWord");
        // Time-boxed so a crash can never drain the battery indefinitely; the
        // service re-acquires it on each restart.
        wakeLock.acquire(4 * 60 * 60 * 1000L);
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        // Started, not bound.
        return null;
    }
}
