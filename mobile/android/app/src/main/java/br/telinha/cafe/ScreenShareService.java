package br.telinha.cafe;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

public class ScreenShareService extends Service {
    public static final String CHANNEL_ID = "telinha_screen_share";
    public static final String ACTION_STOP = "br.telinha.cafe.STOP_SCREEN_SHARE";
    public static final int NOTIF_ID = 4102;
    private static volatile Runnable pendingReady;
    private static volatile Runnable onStopRequested;

    public static void setOnReady(Runnable r) {
        pendingReady = r;
    }

    public static void setOnStopRequested(Runnable r) {
        onStopRequested = r;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            Runnable stop = onStopRequested;
            if (stop != null) stop.run();
            stopSelf();
            return START_NOT_STICKY;
        }
        createChannel();
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent pi = PendingIntent.getActivity(this, 0, openIntent, piFlags);

        Intent stopIntent = new Intent(this, ScreenShareService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stopIntent, piFlags);

        Notification notif = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Telinha Café")
            .setContentText("Compartilhando a tela do celular")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setContentIntent(pi)
            .addAction(0, "Parar", stopPi)
            .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIF_ID, notif);
        }
        Runnable r = pendingReady;
        pendingReady = null;
        if (r != null) r.run();
        return START_NOT_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID,
                "Compartilhamento de tela",
                NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
