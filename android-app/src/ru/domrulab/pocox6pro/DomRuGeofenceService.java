package ru.domrulab.pocox6pro;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;

/**
 * Фоновый сервис контроля геозоны калитки (20м вход / 50м выход) для Poco X6 Pro (HyperOS 2.0 / Android 16).
 * Работает как ForegroundService с уведомлением, чтобы оболочка Xiaomi не выгружала процесс при подходе к дому.
 */
public class DomRuGeofenceService extends Service implements LocationListener {
    public static final String CHANNEL_ID = "domru_geofence_channel";
    public static final int NOTIFICATION_ID = 7041;
    public static final String ACTION_GPS_UPDATE = "ru.domrulab.pocox6pro.GPS_UPDATE";

    public static volatile boolean isRunning = false;
    public static volatile double targetLat = 55.030204;
    public static volatile double targetLon = 82.920430;
    public static volatile double entryRadiusMeters = 20.0;
    public static volatile double exitRadiusMeters = 50.0;
    public static volatile double lastDistanceMeters = -1.0;

    private LocationManager locationManager;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            if (intent.hasExtra("lat")) targetLat = intent.getDoubleExtra("lat", targetLat);
            if (intent.hasExtra("lon")) targetLon = intent.getDoubleExtra("lon", targetLon);
            if (intent.hasExtra("entryRadius")) entryRadiusMeters = intent.getDoubleExtra("entryRadius", entryRadiusMeters);
            if (intent.hasExtra("exitRadius")) exitRadiusMeters = intent.getDoubleExtra("exitRadius", exitRadiusMeters);
        }

        Notification notification = buildNotification("Контроль геозоны калитки активен (вход <= " + (int) entryRadiusMeters + "м)");
        startForeground(NOTIFICATION_ID, notification);
        isRunning = true;

        startLocationUpdates();
        return START_STICKY;
    }

    private void startLocationUpdates() {
        try {
            locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            if (locationManager != null) {
                if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                    locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 2000L, 1.0f, this);
                }
                if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 3000L, 2.0f, this);
                }
            }
        } catch (SecurityException ignored) {
            // Разрешение запрашивается в MainActivity
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        if (location == null) return;
        float[] results = new float[1];
        Location.distanceBetween(
            location.getLatitude(),
            location.getLongitude(),
            targetLat,
            targetLon,
            results
        );
        lastDistanceMeters = results[0];

        String zoneState = lastDistanceMeters <= entryRadiusMeters
            ? "ВНУТРИ ГЕОЗОНЫ (" + (int) lastDistanceMeters + "м) · Локальный CV"
            : "Дистанция до калитки: " + (int) lastDistanceMeters + "м";

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(NOTIFICATION_ID, buildNotification(zoneState));
        }

        Intent broadcast = new Intent(ACTION_GPS_UPDATE);
        broadcast.setPackage(getPackageName());
        broadcast.putExtra("lat", location.getLatitude());
        broadcast.putExtra("lon", location.getLongitude());
        broadcast.putExtra("accuracy", location.getAccuracy());
        broadcast.putExtra("speed", location.getSpeed());
        broadcast.putExtra("distance", lastDistanceMeters);
        broadcast.putExtra("timestamp", location.getTime());
        sendBroadcast(broadcast);
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(String provider) {}

    @Override
    public void onProviderDisabled(String provider) {}

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "DomRu Lab Авто-Калитка (Геозона + On-Device CV)",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Фоновый мониторинг приближения к калитке на Poco X6 Pro");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification(String contentText) {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        int pendingFlags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, notificationIntent, pendingFlags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);

        return builder
            .setContentTitle("DomRu Lab · Poco X6 Pro")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build();
    }

    @Override
    public void onDestroy() {
        isRunning = false;
        if (locationManager != null) {
            try {
                locationManager.removeUpdates(this);
            } catch (SecurityException ignored) {}
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
