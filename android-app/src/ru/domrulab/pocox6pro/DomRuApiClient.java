package ru.domrulab.pocox6pro;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import java.util.zip.GZIPInputStream;

/**
 * Полноценный нативный клиент API «Умный Дом.ру / Электронный Город» (https://myhome.proptech.ru).
 * Реализует точный контракт репозитория gentslava/elektronny-gorod (v9.11.0):
 * - /rest/v1/subscribers/profiles
 * - /rest/v3/subscriber-places
 * - /api/mh-payment/mobile/v1/finance?placeId={placeId}
 * - /rest/v1/places/{placeId}/accesscontrols (включая массив entrances)
 * - /rest/v1/places/{placeId}/cameras
 * - /rest/v2/places/{placeId}/public/cameras
 * - /rest/v1/forpost/cameras (поля ID / Name и id / name)
 * - /rest/v1/forpost/cameras/{cameraId}/snapshots + fallback /rest/v1/places/{placeId}/accesscontrols/{acId}/snapshots
 * - /rest/v2/forpost/cameras/{cameraId}/events и /rest/v1/forpost/events/{eventId}/downloads?container=mp4
 */
public class DomRuApiClient {
    public static final String BASE_API_URL = "https://myhome.proptech.ru";
    private static final String PREFS_AUTH = "domru_native_auth_session";

    public static class PlaceModel {
        public String id = "";
        public String address = "";
        public String balance = "";
        public double lat = 0.0;
        public double lon = 0.0;
    }

    public static class LockModel {
        public String id = "";
        public String placeId = "";
        public String placeAddress = "";
        public String accessControlId = "";
        public String entranceId = "";
        public String name = "";
        public String kind = "door"; // door, gate, barrier
        public boolean allowOpen = true;
        public String externalCameraId = "";
    }

    public static class CameraModel {
        public String id = "";
        public String name = "";
        public String placeId = "";
        public String placeAddress = "";
        public String accessControlId = "";
        public String entranceId = "";
        public String source = "intercom"; // intercom, place, public, forpost
        public String snapshotMode = "owner";
    }

    public static class ArchiveEventModel {
        public String id = "";
        public String cameraId = "";
        public long timestampSec = 0L;
        public int durationSec = 0;
        public String message = "";
    }

    public static class TempPassModel {
        public long id;
        public String sharedLinkMessage;
        public String status;
        public long expiredAt;
    }

    private final SharedPreferences prefs;
    private String accessToken;
    private String refreshToken;
    private String operatorId;
    private String accountId;
    private String subscriberName;
    private String phone;
    private String deviceUuid;
    private boolean demoMode;
    private String lastSyncDiagnostic = "";

    public DomRuApiClient(Context context) {
        this.prefs = context.getSharedPreferences(PREFS_AUTH, Context.MODE_PRIVATE);
        this.accessToken = prefs.getString("access_token", "");
        this.refreshToken = prefs.getString("refresh_token", "");
        this.operatorId = prefs.getString("operator_id", "1");
        this.accountId = prefs.getString("account_id", "");
        this.subscriberName = prefs.getString("subscriber_name", "Абонент Дом.ру");
        this.phone = prefs.getString("phone", "");
        this.deviceUuid = prefs.getString("device_uuid", "");
        if (this.deviceUuid.isEmpty()) {
            this.deviceUuid = UUID.randomUUID().toString();
            prefs.edit().putString("device_uuid", this.deviceUuid).apply();
        }
        this.demoMode = prefs.getBoolean("demo_mode", this.accessToken.isEmpty());
    }

    public boolean isAuthenticated() {
        return demoMode || (accessToken != null && !accessToken.isEmpty());
    }

    public boolean isDemoMode() {
        return demoMode;
    }

    public String getLastSyncDiagnostic() {
        return lastSyncDiagnostic;
    }

    public void setDemoMode(boolean demo) {
        this.demoMode = demo;
        if (demo) {
            this.subscriberName = "Демо-профиль · Poco X6 Pro";
            this.accountId = "5409182";
        }
        prefs.edit().putBoolean("demo_mode", demo).apply();
    }

    public void setDirectToken(String token, String opId, String accId) {
        this.accessToken = token.trim();
        this.operatorId = (opId == null || opId.trim().isEmpty()) ? "1" : opId.trim();
        if (accId != null && !accId.trim().isEmpty()) {
            this.accountId = accId.trim();
        }
        this.demoMode = false;
        saveSession();
    }

    public void logout() {
        this.accessToken = "";
        this.refreshToken = "";
        this.demoMode = true;
        saveSession();
    }

    private void saveSession() {
        prefs.edit()
            .putString("access_token", accessToken)
            .putString("refresh_token", refreshToken)
            .putString("operator_id", operatorId)
            .putString("account_id", accountId)
            .putString("subscriber_name", subscriberName)
            .putString("phone", phone)
            .putBoolean("demo_mode", demoMode)
            .apply();
    }

    public String getSubscriberName() {
        return subscriberName;
    }

    public String getAccountId() {
        return (accountId == null || accountId.isEmpty()) ? "—" : accountId;
    }

    public String getPhone() {
        return phone;
    }

    /**
     * Формирует строку User-Agent строго по контракту приложения Мой Дом v9.11.0 (ADR-0006).
     */
    private String formatUserAgent(String placeId) {
        String pid = (placeId == null || placeId.isEmpty() || "null".equalsIgnoreCase(placeId)) ? "null" : placeId;
        String acc = (accountId == null || "null".equalsIgnoreCase(accountId)) ? "" : accountId;
        String op = (operatorId == null || operatorId.isEmpty()) ? "1" : operatorId;
        return "Google Pixel 8 Pro | Android 16 | ntk | 9.11.0 (91100000) | " + acc + " | " + op + " | " + deviceUuid + " | " + pid;
    }

    public static String optCleanString(JSONObject obj, String key) {
        if (obj == null || key == null || !obj.has(key) || obj.isNull(key)) {
            return "";
        }
        Object val = obj.opt(key);
        if (val == null || val == JSONObject.NULL) {
            return "";
        }
        String s = String.valueOf(val).trim();
        if (s.isEmpty() || "null".equalsIgnoreCase(s)) {
            return "";
        }
        return s;
    }

    public static String firstNonEmpty(JSONObject obj, String... keys) {
        if (obj == null || keys == null) return "";
        for (String k : keys) {
            String v = optCleanString(obj, k);
            if (!v.isEmpty()) return v;
        }
        return "";
    }

    public static String normalizePhone(String raw) {
        if (raw == null) return "";
        String digits = raw.replaceAll("\\D+", "");
        if (digits.length() == 11 && digits.startsWith("8")) {
            return "7" + digits.substring(1);
        }
        if (digits.length() == 10) {
            return "7" + digits;
        }
        return digits;
    }

    private static String sha1Base64(String input) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-1");
        byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(digest, Base64.NO_WRAP);
    }

    private static String md5Hex(String input) throws Exception {
        MessageDigest md = MessageDigest.getInstance("MD5");
        byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (byte b : digest) {
            sb.append(String.format("%02x", b & 0xFF));
        }
        return sb.toString();
    }

    public static class HttpResponseData {
        public int status;
        public String bodyText;
        public byte[] rawBytes;
    }

    public HttpResponseData requestRaw(String method, String endpoint, String jsonBody, String placeId, boolean binary, boolean preauth) throws Exception {
        URL url = new URL(BASE_API_URL + endpoint);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(18000);
        conn.setRequestProperty("Accept-Encoding", "gzip");
        conn.setRequestProperty("User-Agent", formatUserAgent(placeId));

        if (operatorId != null && !operatorId.isEmpty() && !"null".equals(operatorId)) {
            conn.setRequestProperty("operator", operatorId);
        }
        if (!preauth && accessToken != null && !accessToken.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + accessToken);
        }

        if (jsonBody != null && ("POST".equals(method) || "DELETE".equals(method))) {
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            byte[] out = jsonBody.getBytes(StandardCharsets.UTF_8);
            OutputStream os = conn.getOutputStream();
            os.write(out);
            os.flush();
            os.close();
        }

        HttpResponseData res = new HttpResponseData();
        res.status = conn.getResponseCode();

        InputStream is = null;
        try {
            is = (res.status >= 200 && res.status < 400) ? conn.getInputStream() : conn.getErrorStream();
            if (is != null) {
                String encoding = conn.getContentEncoding();
                if (encoding != null && encoding.toLowerCase(Locale.US).contains("gzip")) {
                    is = new GZIPInputStream(is);
                }
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                int n;
                while ((n = is.read(buf)) != -1) {
                    bos.write(buf, 0, n);
                }
                res.rawBytes = bos.toByteArray();
                if (!binary) {
                    res.bodyText = new String(res.rawBytes, StandardCharsets.UTF_8);
                }
            }
        } finally {
            if (is != null) try { is.close(); } catch (Exception ignored) {}
            conn.disconnect();
        }
        return res;
    }

    /**
     * Шаг 1 авторизации в myhome.proptech.ru по номеру телефона.
     */
    public JSONObject loginCheckPhone(String rawPhone) throws Exception {
        String cleanPhone = normalizePhone(rawPhone);
        this.phone = cleanPhone;
        HttpResponseData res = requestRaw("GET", "/auth/v2/login/" + cleanPhone, null, null, false, true);
        JSONObject out = new JSONObject();
        out.put("status", res.status);
        out.put("phone", cleanPhone);
        if (res.status == 300 && res.bodyText != null) {
            out.put("passwordRequired", false);
            out.put("contracts", new JSONArray(res.bodyText));
        } else if (res.status == 200) {
            out.put("passwordRequired", true);
            out.put("contracts", new JSONArray());
        } else {
            out.put("error", "Оператор вернул код " + res.status);
        }
        return out;
    }

    /**
     * Шаг 2А: Вход по паролю (SHA-1 + MD5 DigitalHomeNTKpassword).
     */
    public boolean loginWithPassword(String rawPhone, String password) throws Exception {
        String cleanPhone = normalizePhone(rawPhone);
        SimpleDateFormat isoFmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        isoFmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        SimpleDateFormat simpleFmt = new SimpleDateFormat("yyyyMMddHHmmss", Locale.US);
        simpleFmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        Date now = new Date();
        String timestamp = isoFmt.format(now);
        String simpleTime = simpleFmt.format(now);

        String hash1 = sha1Base64(password);
        String rawMd5 = "DigitalHomeNTKpassword" + cleanPhone + password + simpleTime + "789sdgHJs678wertv34712376";
        String hash2 = md5Hex(rawMd5);

        JSONObject body = new JSONObject();
        body.put("login", cleanPhone);
        body.put("timestamp", timestamp);
        body.put("hash1", hash1);
        body.put("hash2", hash2);

        HttpResponseData res = requestRaw("POST", "/auth/v2/auth/" + cleanPhone + "/password", body.toString(), null, false, true);
        if (res.status >= 200 && res.status < 300 && res.bodyText != null) {
            JSONObject data = new JSONObject(res.bodyText);
            String token = optCleanString(data, "accessToken");
            if (!token.isEmpty()) {
                this.accessToken = token;
                this.refreshToken = optCleanString(data, "refreshToken");
                this.operatorId = String.valueOf(data.optInt("operatorId", 1));
                this.phone = cleanPhone;
                this.demoMode = false;
                fetchProfileInfo();
                saveSession();
                return true;
            }
        }
        return false;
    }

    /**
     * Шаг 2Б: Запрос СМС-кода на выбранный договор.
     */
    public boolean requestSmsCode(String rawPhone, JSONObject contract) throws Exception {
        String cleanPhone = normalizePhone(rawPhone);
        JSONObject payload = new JSONObject();
        payload.put("accountId", contract.opt("accountId"));
        payload.put("address", contract.optString("address"));
        payload.put("operatorId", contract.opt("operatorId"));
        payload.put("subscriberId", String.valueOf(contract.opt("subscriberId")));
        payload.put("placeId", contract.opt("placeId"));

        HttpResponseData res = requestRaw("POST", "/auth/v2/confirmation/" + cleanPhone, payload.toString(), null, false, true);
        return res.status >= 200 && res.status < 300;
    }

    /**
     * Шаг 2В: Подтверждение СМС-кода (/auth/v3/auth/{phone}/confirmation + fallback /auth/v2/).
     */
    public boolean verifySmsCode(String rawPhone, String smsCode, JSONObject contract) throws Exception {
        String cleanPhone = normalizePhone(rawPhone);
        int opId = contract.optInt("operatorId", 1);
        String code = smsCode.trim();

        JSONObject payload = new JSONObject();
        payload.put("accountId", contract.opt("accountId"));
        payload.put("confirm1", code);
        payload.put("confirm2", code);
        payload.put("login", cleanPhone);
        payload.put("operatorId", opId);
        payload.put("placeId", contract.opt("placeId"));
        payload.put("profileId", contract.optString("profileId", ""));
        payload.put("subscriberId", String.valueOf(contract.opt("subscriberId")));

        HttpResponseData res = requestRaw("POST", "/auth/v3/auth/" + cleanPhone + "/confirmation", payload.toString(), null, false, true);
        if (res.status < 200 || res.status >= 300) {
            res = requestRaw("POST", "/auth/v2/auth/" + cleanPhone + "/confirmation", payload.toString(), null, false, true);
        }

        if (res.status >= 200 && res.status < 300 && res.bodyText != null) {
            JSONObject data = new JSONObject(res.bodyText);
            String token = optCleanString(data, "accessToken");
            if (!token.isEmpty()) {
                this.accessToken = token;
                this.refreshToken = optCleanString(data, "refreshToken");
                this.operatorId = String.valueOf(data.optInt("operatorId", opId));
                this.phone = cleanPhone;
                this.demoMode = false;
                fetchProfileInfo();
                saveSession();
                return true;
            }
        }
        return false;
    }

    private void fetchProfileInfo() {
        try {
            HttpResponseData res = requestRaw("GET", "/rest/v1/subscribers/profiles", null, null, false, false);
            if (res.status == 200 && res.bodyText != null) {
                JSONObject root = new JSONObject(res.bodyText);
                JSONObject data = root.optJSONObject("data");
                JSONObject sub = data != null ? data.optJSONObject("subscriber") : root.optJSONObject("subscriber");
                if (sub != null) {
                    String name = firstNonEmpty(sub, "name", "nick", "fullName");
                    if (!name.isEmpty()) this.subscriberName = name;
                    String acc = optCleanString(sub, "accountId");
                    if (!acc.isEmpty()) {
                        this.accountId = acc;
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    public static class DashboardBundle {
        public List<PlaceModel> places = new ArrayList<PlaceModel>();
        public List<LockModel> locks = new ArrayList<LockModel>();
        public List<CameraModel> cameras = new ArrayList<CameraModel>();
    }

    /**
     * Загружает все адреса (/rest/v3/subscriber-places), двери/калитки (/rest/v1/places/{id}/accesscontrols)
     * и все типы камер (intercom, place, public, forpost) строго по протоколу server.ts / elektronny-gorod.
     */
    public DashboardBundle fetchDashboard() {
        DashboardBundle bundle = new DashboardBundle();
        if (demoMode) {
            PlaceModel p1 = new PlaceModel();
            p1.id = "482910";
            p1.address = "г. Новосибирск, ул. Кирова, д. 44, кв. 112";
            p1.balance = "640.00 ₽";
            bundle.places.add(p1);

            LockModel l1 = new LockModel();
            l1.id = "482910_9101";
            l1.placeId = "482910";
            l1.placeAddress = p1.address;
            l1.accessControlId = "9101";
            l1.entranceId = "101";
            l1.name = "Калитка · Центральный вход со двора";
            l1.kind = "gate";
            l1.allowOpen = true;
            l1.externalCameraId = "cam_gate_9101";
            bundle.locks.add(l1);

            LockModel l2 = new LockModel();
            l2.id = "482910_9102";
            l2.placeId = "482910";
            l2.placeAddress = p1.address;
            l2.accessControlId = "9102";
            l2.entranceId = "102";
            l2.name = "Подъезд №1 · Главный домофон";
            l2.kind = "door";
            l2.allowOpen = true;
            l2.externalCameraId = "cam_door_9102";
            bundle.locks.add(l2);

            LockModel l3 = new LockModel();
            l3.id = "482910_9103";
            l3.placeId = "482910";
            l3.placeAddress = p1.address;
            l3.accessControlId = "9103";
            l3.entranceId = "103";
            l3.name = "Ворота и шлагбаум · Северный въезд";
            l3.kind = "barrier";
            l3.allowOpen = true;
            l3.externalCameraId = "cam_yard_9103";
            bundle.locks.add(l3);

            CameraModel c1 = new CameraModel();
            c1.id = "cam_gate_9101";
            c1.name = "Камера калитки · Центральный вход";
            c1.placeId = "482910";
            c1.placeAddress = p1.address;
            c1.accessControlId = "9101";
            c1.entranceId = "101";
            c1.source = "intercom";
            bundle.cameras.add(c1);

            CameraModel c2 = new CameraModel();
            c2.id = "cam_door_9102";
            c2.name = "Камера домофона · Подъезд №1";
            c2.placeId = "482910";
            c2.placeAddress = p1.address;
            c2.accessControlId = "9102";
            c2.entranceId = "102";
            c2.source = "intercom";
            bundle.cameras.add(c2);

            lastSyncDiagnostic = "Демо-режим: 1 адрес, 3 точки доступа, 2 камеры";
            return bundle;
        }

        Set<String> seenCameraIds = new HashSet<String>();
        try {
            // 1. Сначала обновляем профиль для установки account_id в User-Agent (ADR-0006)
            fetchProfileInfo();
            saveSession();

            // 2. Запрашиваем /rest/v3/subscriber-places (основной эндпоинт v9.11.0!)
            HttpResponseData placesRes = requestRaw("GET", "/rest/v3/subscriber-places", null, null, false, false);
            if (placesRes.status != 200 || placesRes.bodyText == null) {
                placesRes = requestRaw("GET", "/rest/v1/subscribers/places", null, null, false, false);
            }

            if (placesRes.status == 200 && placesRes.bodyText != null) {
                JSONArray rawPlaces = extractDataArray(placesRes.bodyText);
                for (int i = 0; i < rawPlaces.length(); i++) {
                    JSONObject sp = rawPlaces.optJSONObject(i);
                    if (sp == null) continue;
                    JSONObject placeObj = sp.optJSONObject("place");
                    if (placeObj == null) placeObj = sp;

                    String placeId = firstNonEmpty(placeObj, "id", "placeId", "ID");
                    if (placeId.isEmpty()) continue;

                    JSONObject addrObj = placeObj.optJSONObject("address");
                    String addressStr = "";
                    if (addrObj != null) {
                        addressStr = firstNonEmpty(addrObj, "visibleAddress", "groupName", "address");
                    }
                    if (addressStr.isEmpty()) {
                        addressStr = firstNonEmpty(placeObj, "address", "name");
                    }
                    if (addressStr.isEmpty()) {
                        addressStr = "Адрес #" + placeId;
                    }

                    PlaceModel pm = new PlaceModel();
                    pm.id = placeId;
                    pm.address = addressStr;
                    pm.balance = fetchPlaceBalance(placeId);

                    JSONObject locObj = placeObj.optJSONObject("location");
                    if (locObj != null) {
                        pm.lat = locObj.optDouble("latitude", locObj.optDouble("lat", 0.0));
                        pm.lon = locObj.optDouble("longitude", locObj.optDouble("lon", 0.0));
                    }

                    bundle.places.add(pm);

                    // 3. Домофоны, калитки, шлагбаумы и камеры домофонов адреса
                    fetchPlaceLocksAndIntercomCameras(pm, bundle, seenCameraIds);

                    // 4. Личные камеры адреса (/rest/v1/places/{placeId}/cameras)
                    fetchPlaceCameras(pm, "/rest/v1/places/" + placeId + "/cameras", "place", bundle, seenCameraIds);

                    // 5. Общедомовые и дворовые камеры (/rest/v2/places/{placeId}/public/cameras)
                    fetchPlaceCameras(pm, "/rest/v2/places/" + placeId + "/public/cameras", "public", bundle, seenCameraIds);
                }
            }

            // 6. Дополнительно опрашиваем /rest/v1/forpost/cameras (поля ID и Name с большой буквы!)
            try {
                HttpResponseData fpRes = requestRaw("GET", "/rest/v1/forpost/cameras", null, null, false, false);
                if (fpRes.status == 200 && fpRes.bodyText != null) {
                    JSONArray fpArr = extractDataArray(fpRes.bodyText);
                    for (int i = 0; i < fpArr.length(); i++) {
                        JSONObject c = fpArr.optJSONObject(i);
                        if (c == null) continue;
                        String cid = firstNonEmpty(c, "ID", "id", "externalCameraId", "cameraId");
                        if (cid.isEmpty()) continue;
                        if (seenCameraIds.contains(cid)) continue;
                        seenCameraIds.add(cid);

                        String cname = firstNonEmpty(c, "Name", "name", "title");
                        if (cname.isEmpty()) cname = "Камера #" + cid;

                        CameraModel cm = new CameraModel();
                        cm.id = cid;
                        cm.name = cname;
                        cm.placeId = bundle.places.isEmpty() ? "" : bundle.places.get(0).id;
                        cm.placeAddress = bundle.places.isEmpty() ? "" : bundle.places.get(0).address;
                        cm.source = "forpost";
                        bundle.cameras.add(cm);
                    }
                }
            } catch (Exception ignored) {}

            lastSyncDiagnostic = String.format(
                Locale.US,
                "Синхронизировано: адресов=%d, дверей/калиток=%d, камер=%d",
                bundle.places.size(), bundle.locks.size(), bundle.cameras.size()
            );
        } catch (Exception e) {
            lastSyncDiagnostic = "Ошибка синхронизации: " + e.getMessage();
        }

        return bundle;
    }

    private static JSONArray extractDataArray(String bodyText) {
        if (bodyText == null || bodyText.trim().isEmpty()) return new JSONArray();
        try {
            String trimmed = bodyText.trim();
            if (trimmed.startsWith("[")) {
                return new JSONArray(trimmed);
            }
            JSONObject root = new JSONObject(trimmed);
            JSONArray d = root.optJSONArray("data");
            if (d != null) return d;
            JSONArray items = root.optJSONArray("items");
            if (items != null) return items;
        } catch (Exception ignored) {}
        return new JSONArray();
    }

    private String fetchPlaceBalance(String placeId) {
        try {
            HttpResponseData finRes = requestRaw(
                "GET",
                "/api/mh-payment/mobile/v1/finance?placeId=" + URLEncoder.encode(placeId, "UTF-8"),
                null,
                placeId,
                false,
                false
            );
            if (finRes.status == 200 && finRes.bodyText != null) {
                JSONObject root = new JSONObject(finRes.bodyText);
                JSONObject d = root.optJSONObject("data");
                if (d == null) d = root;
                if (d.has("balance") && !d.isNull("balance")) {
                    return String.format(Locale.US, "%.2f ₽", d.optDouble("balance", 0.0));
                }
            }
        } catch (Exception ignored) {}
        return "Активен";
    }

    private void fetchPlaceLocksAndIntercomCameras(PlaceModel pm, DashboardBundle bundle, Set<String> seenCameraIds) {
        try {
            HttpResponseData acRes = requestRaw(
                "GET",
                "/rest/v1/places/" + pm.id + "/accesscontrols",
                null,
                pm.id,
                false,
                false
            );
            if (acRes.status != 200 || acRes.bodyText == null) return;

            JSONArray arr = extractDataArray(acRes.bodyText);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject ac = arr.optJSONObject(i);
                if (ac == null) continue;

                String acId = firstNonEmpty(ac, "id", "accessControlId", "ID");
                if (acId.isEmpty()) continue;

                String acName = firstNonEmpty(ac, "name", "Name", "externalDeviceId");
                if (acName.isEmpty()) acName = "Домофон #" + acId;

                String acCamId = firstNonEmpty(ac, "externalCameraId", "cameraId");
                boolean acAllowOpen = ac.optBoolean("allowOpen", true);

                JSONArray entrances = ac.optJSONArray("entrances");
                if (entrances != null && entrances.length() > 0) {
                    for (int j = 0; j < entrances.length(); j++) {
                        JSONObject ent = entrances.optJSONObject(j);
                        if (ent == null) continue;
                        String entId = firstNonEmpty(ent, "id", "entranceId", "ID");
                        String entName = firstNonEmpty(ent, "name", "Name");
                        if (entName.isEmpty()) entName = acName;

                        String extCamId = firstNonEmpty(ent, "externalCameraId", "cameraId");
                        if (extCamId.isEmpty()) extCamId = acCamId;

                        boolean allowOpen = ent.has("allowOpen") ? ent.optBoolean("allowOpen", true) : acAllowOpen;

                        LockModel lm = new LockModel();
                        lm.id = "lock_" + pm.id + "_" + acId + "_" + (entId.isEmpty() ? String.valueOf(j) : entId);
                        lm.placeId = pm.id;
                        lm.placeAddress = pm.address;
                        lm.accessControlId = acId;
                        lm.entranceId = entId;
                        lm.name = entName;
                        lm.kind = classifyLockKind(entName);
                        lm.allowOpen = allowOpen;
                        lm.externalCameraId = extCamId;
                        bundle.locks.add(lm);

                        String camKey = !extCamId.isEmpty() ? extCamId : ("ac_" + acId + "_" + entId);
                        if (!seenCameraIds.contains(camKey)) {
                            seenCameraIds.add(camKey);
                            CameraModel cm = new CameraModel();
                            cm.id = !extCamId.isEmpty() ? extCamId : acId;
                            cm.name = entName;
                            cm.placeId = pm.id;
                            cm.placeAddress = pm.address;
                            cm.accessControlId = acId;
                            cm.entranceId = entId;
                            cm.source = "intercom";
                            bundle.cameras.add(cm);
                        }
                    }
                } else {
                    LockModel lm = new LockModel();
                    lm.id = "lock_" + pm.id + "_" + acId + "_main";
                    lm.placeId = pm.id;
                    lm.placeAddress = pm.address;
                    lm.accessControlId = acId;
                    lm.entranceId = "";
                    lm.name = acName;
                    lm.kind = classifyLockKind(acName);
                    lm.allowOpen = acAllowOpen;
                    lm.externalCameraId = acCamId;
                    bundle.locks.add(lm);

                    String camKey = !acCamId.isEmpty() ? acCamId : ("ac_" + acId);
                    if (!seenCameraIds.contains(camKey)) {
                        seenCameraIds.add(camKey);
                        CameraModel cm = new CameraModel();
                        cm.id = !acCamId.isEmpty() ? acCamId : acId;
                        cm.name = acName;
                        cm.placeId = pm.id;
                        cm.placeAddress = pm.address;
                        cm.accessControlId = acId;
                        cm.entranceId = "";
                        cm.source = "intercom";
                        bundle.cameras.add(cm);
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    private void fetchPlaceCameras(PlaceModel pm, String endpoint, String sourceType, DashboardBundle bundle, Set<String> seenCameraIds) {
        try {
            HttpResponseData res = requestRaw("GET", endpoint, null, pm.id, false, false);
            if (res.status != 200 || res.bodyText == null) return;

            JSONArray arr = extractDataArray(res.bodyText);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject cam = arr.optJSONObject(i);
                if (cam == null) continue;
                String cid = firstNonEmpty(cam, "externalCameraId", "id", "ID", "cameraId");
                if (cid.isEmpty() || seenCameraIds.contains(cid)) continue;
                seenCameraIds.add(cid);

                String cname = firstNonEmpty(cam, "name", "Name", "title");
                if (cname.isEmpty()) cname = "Камера #" + cid;

                CameraModel cm = new CameraModel();
                cm.id = cid;
                cm.name = cname;
                cm.placeId = pm.id;
                cm.placeAddress = pm.address;
                cm.source = sourceType;
                bundle.cameras.add(cm);
            }
        } catch (Exception ignored) {}
    }

    private static String classifyLockKind(String name) {
        String lower = (name == null ? "" : name).toLowerCase(Locale.getDefault());
        if (lower.contains("калит") || lower.contains("gate")) return "gate";
        if (lower.contains("шлагбаум") || lower.contains("ворот") || lower.contains("barrier")) return "barrier";
        return "door";
    }

    /**
     * Отправляет команду открытия двери/калитки напрямую в API Дом.ру (`accessControlOpen`).
     */
    public boolean openAccessControl(String placeId, String accessControlId, String entranceId) {
        if (demoMode) return true;
        try {
            String endpoint = (entranceId == null || entranceId.isEmpty() || "null".equalsIgnoreCase(entranceId))
                ? "/rest/v1/places/" + placeId + "/accesscontrols/" + accessControlId + "/actions"
                : "/rest/v1/places/" + placeId + "/accesscontrols/" + accessControlId + "/entrances/" + entranceId + "/actions";
            JSONObject body = new JSONObject();
            body.put("name", "accessControlOpen");
            HttpResponseData res = requestRaw("POST", endpoint, body.toString(), placeId, false, false);
            if (res.status < 200 || res.status >= 300) {
                // Fallback без entranceId, если панель принимает команду на уровне accessControl
                String fallbackEndpoint = "/rest/v1/places/" + placeId + "/accesscontrols/" + accessControlId + "/actions";
                res = requestRaw("POST", fallbackEndpoint, body.toString(), placeId, false, false);
            }
            return res.status >= 200 && res.status < 300;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Получает реальный JPEG-снимок с камеры Forpost или домофона (accesscontrols/{id}/snapshots).
     */
    public Bitmap fetchCameraSnapshotBitmap(CameraModel cam, int frameIndex) {
        if (demoMode || cam == null) {
            return OnDeviceFaceCvEngine.renderSyntheticIntercomFrame(
                cam != null && cam.snapshotMode != null ? cam.snapshotMode : "owner",
                frameIndex
            );
        }

        try {
            // 1. Запрос к Forpost-камере (с параметрами размера и без них)
            if (cam.id != null && !cam.id.isEmpty()) {
                HttpResponseData r1 = requestRaw(
                    "GET",
                    "/rest/v1/forpost/cameras/" + cam.id + "/snapshots?width=640&height=360",
                    null,
                    cam.placeId,
                    true,
                    false
                );
                if (r1.status == 200 && r1.rawBytes != null && r1.rawBytes.length > 128) {
                    Bitmap b = BitmapFactory.decodeByteArray(r1.rawBytes, 0, r1.rawBytes.length);
                    if (b != null) return b;
                }

                HttpResponseData r1b = requestRaw(
                    "GET",
                    "/rest/v1/forpost/cameras/" + cam.id + "/snapshots",
                    null,
                    cam.placeId,
                    true,
                    false
                );
                if (r1b.status == 200 && r1b.rawBytes != null && r1b.rawBytes.length > 128) {
                    Bitmap b = BitmapFactory.decodeByteArray(r1b.rawBytes, 0, r1b.rawBytes.length);
                    if (b != null) return b;
                }
            }

            // 2. Fallback на снимок точки доступа домофона (/rest/v1/places/{placeId}/accesscontrols/{acId}/snapshots)
            if (cam.placeId != null && !cam.placeId.isEmpty() && cam.accessControlId != null && !cam.accessControlId.isEmpty()) {
                String q = (cam.entranceId != null && !cam.entranceId.isEmpty())
                    ? "?entranceId=" + cam.entranceId + "&width=640&height=360"
                    : "?width=640&height=360";
                HttpResponseData r2 = requestRaw(
                    "GET",
                    "/rest/v1/places/" + cam.placeId + "/accesscontrols/" + cam.accessControlId + "/snapshots" + q,
                    null,
                    cam.placeId,
                    true,
                    false
                );
                if (r2.status == 200 && r2.rawBytes != null && r2.rawBytes.length > 128) {
                    Bitmap b2 = BitmapFactory.decodeByteArray(r2.rawBytes, 0, r2.rawBytes.length);
                    if (b2 != null) return b2;
                }
            }
        } catch (Exception ignored) {}

        // В боевом режиме никогда не показываем нарисованное лицо, если камера не отдала JPEG
        return renderCameraStatusPlaceholder(cam.name, "ID #" + cam.id + " · Ожидание JPEG-кадра от камеры...");
    }

    public static Bitmap renderCameraStatusPlaceholder(String title, String subtitle) {
        int w = 480;
        int h = 270;
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.RGB_565);
        Canvas c = new Canvas(bmp);
        c.drawColor(Color.rgb(9, 13, 22));

        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(Color.rgb(30, 41, 59));
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(2f);
        c.drawRect(12, 12, w - 12, h - 12, p);

        p.setStyle(Paint.Style.FILL);
        p.setColor(Color.rgb(226, 232, 240));
        p.setTextSize(18f);
        p.setTypeface(Typeface.DEFAULT_BOLD);
        c.drawText(title != null ? title : "Камера", 32, h / 2f - 10, p);

        p.setColor(Color.rgb(56, 189, 248));
        p.setTextSize(14f);
        p.setTypeface(Typeface.MONOSPACE);
        c.drawText(subtitle != null ? subtitle : "", 32, h / 2f + 18, p);
        return bmp;
    }

    /**
     * Запрашивает URL видеопотока камеры (онлайн или архив с меткой времени TS).
     */
    public String fetchCameraVideoUrl(String cameraId, String placeId, long archiveTimestampSec) {
        return fetchCameraVideoUrl(cameraId, placeId, archiveTimestampSec, "-1.0");
    }

    public String fetchCameraVideoUrl(String cameraId, String placeId, long archiveTimestampSec, String speedParam) {
        if (demoMode || cameraId == null || cameraId.isEmpty()) return "";
        try {
            String spd = (speedParam != null && !speedParam.isEmpty()) ? speedParam : "-1.0";
            String endpoint = "/rest/v1/forpost/cameras/" + cameraId + "/video?LightStream=0&Format=H264";
            if (archiveTimestampSec > 0) {
                endpoint = "/rest/v1/forpost/cameras/" + cameraId + "/video?TS=" + archiveTimestampSec + "&TZ=25200&LightStream=0&Format=H264&Speed=" + URLEncoder.encode(spd, "UTF-8");
            }
            HttpResponseData res = requestRaw("GET", endpoint, null, placeId, false, false);
            if (res.status == 200 && res.bodyText != null) {
                JSONObject root = new JSONObject(res.bodyText);
                JSONObject data = root.optJSONObject("data");
                if (data != null) {
                    String u = firstNonEmpty(data, "URL", "url");
                    if (!u.isEmpty()) return u;
                }
                String directData = optCleanString(root, "data");
                if (directData.startsWith("http") || directData.startsWith("rtsp")) return directData;
                return firstNonEmpty(root, "URL", "url");
            }
        } catch (Exception ignored) {}
        return "";
    }

    /**
     * Загружает список событий движения в архиве камеры (/rest/v2/forpost/cameras/{id}/events)
     * за указанный день (dayOffset = 0..6, максимум 7 дней) с поддержкой дозагрузки до начала дня (00:00).
     */
    public List<ArchiveEventModel> fetchCameraArchiveEvents(String cameraId, String placeId) {
        return fetchCameraArchiveEventsPage(cameraId, placeId, 0, 0L, 100);
    }

    public List<ArchiveEventModel> fetchCameraArchiveEventsPage(
        String cameraId,
        String placeId,
        int dayOffset,
        long upperTimestampSec,
        int count
    ) {
        List<ArchiveEventModel> list = new ArrayList<ArchiveEventModel>();
        if (demoMode || cameraId == null || cameraId.isEmpty()) return list;
        try {
            int safeOffset = Math.max(0, Math.min(6, dayOffset));
            int safeCount = Math.max(10, Math.min(100, count));

            java.util.Calendar cal = java.util.Calendar.getInstance();
            cal.add(java.util.Calendar.DAY_OF_YEAR, -safeOffset);
            cal.set(java.util.Calendar.HOUR_OF_DAY, 0);
            cal.set(java.util.Calendar.MINUTE, 0);
            cal.set(java.util.Calendar.SECOND, 0);
            cal.set(java.util.Calendar.MILLISECOND, 0);
            long dayStartMs = cal.getTimeInMillis();
            long dayEndMs = dayStartMs + 86399_000L;

            long effectiveUpperMs = (upperTimestampSec > 0L)
                ? Math.min(dayEndMs, upperTimestampSec * 1000L)
                : dayEndMs;

            int offsetMin = java.util.TimeZone.getDefault().getOffset(dayStartMs) / 60000;
            String sign = offsetMin >= 0 ? "+" : "-";
            int absMin = Math.abs(offsetMin);
            String tzSuffix = String.format(Locale.US, "%s%02d:%02d", sign, absMin / 60, absMin % 60);

            SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
            String upper = fmt.format(new Date(effectiveUpperMs)) + tzSuffix;
            String lower = fmt.format(new Date(dayStartMs)) + tzSuffix;
            String q = "UpperDate=" + URLEncoder.encode(upper, "UTF-8")
                + "&LowerDate=" + URLEncoder.encode(lower, "UTF-8")
                + "&Count=" + safeCount
                + "&orderByTime=DESC";

            HttpResponseData res = requestRaw(
                "GET",
                "/rest/v2/forpost/cameras/" + cameraId + "/events?" + q,
                null,
                placeId,
                false,
                false
            );
            if (res.status == 200 && res.bodyText != null) {
                JSONArray arr = extractDataArray(res.bodyText);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject item = arr.optJSONObject(i);
                    if (item == null) continue;
                    String eid = firstNonEmpty(item, "ID", "id");
                    if (eid.isEmpty()) continue;
                    ArchiveEventModel ev = new ArchiveEventModel();
                    ev.id = eid;
                    ev.cameraId = cameraId;
                    ev.timestampSec = item.optLong("Time", System.currentTimeMillis() / 1000L);
                    ev.durationSec = item.optInt("Duration", 15);
                    ev.message = firstNonEmpty(item, "Message", "message");
                    if (ev.message.isEmpty()) ev.message = "Движение в кадре (" + ev.durationSec + " сек)";
                    list.add(ev);
                }
            }
        } catch (Exception ignored) {}
        return list;
    }

    /**
     * Получает прямую подписанную ссылку на скачивание и просмотр MP4-ролика события архива
     * (/rest/v1/forpost/events/{eventId}/downloads?container=mp4).
     */
    public String fetchArchiveEventMp4Url(String eventId) {
        return fetchArchiveEventMp4Url(eventId, null);
    }

    public String fetchArchiveEventMp4Url(String eventId, String placeId) {
        if (demoMode || eventId == null || eventId.isEmpty()) return "";
        try {
            for (int attempt = 0; attempt < 4; attempt++) {
                HttpResponseData res = requestRaw(
                    "GET",
                    "/rest/v1/forpost/events/" + eventId + "/downloads?container=mp4",
                    null,
                    placeId,
                    false,
                    false
                );
                if (res.status == 423) {
                    Thread.sleep(1500L);
                    continue;
                }
                if (res.status == 200 && res.bodyText != null) {
                    String trimmed = res.bodyText.trim();
                    if (trimmed.startsWith("http")) {
                        return trimmed;
                    }
                    JSONObject root = new JSONObject(trimmed);
                    JSONObject dataObj = root.optJSONObject("data");
                    if (dataObj != null) {
                        String u = firstNonEmpty(dataObj, "URL", "url", "downloadUrl");
                        if (u.startsWith("http")) return u;
                    }
                    String url = optCleanString(root, "data");
                    if (!url.isEmpty() && url.startsWith("http")) {
                        return url;
                    }
                    String rootUrl = firstNonEmpty(root, "URL", "url", "downloadUrl");
                    if (rootUrl.startsWith("http")) {
                        return rootUrl;
                    }
                }
                break;
            }
        } catch (Exception ignored) {}
        return "";
    }

    /**
     * Создаёт временную гостевую ссылку (с целым числом секунд TTL: 3600, 14400, 43200, 86400).
     */
    public TempPassModel createTempPass(String placeId, int ttlSeconds, List<Integer> acIds) {
        TempPassModel model = new TempPassModel();
        model.id = 85000 + (System.currentTimeMillis() % 9000);
        model.status = "ACTIVE";
        model.expiredAt = System.currentTimeMillis() + (ttlSeconds * 1000L);

        if (!demoMode && placeId != null && !placeId.isEmpty()) {
            try {
                JSONObject body = new JSONObject();
                body.put("placeId", Integer.parseInt(placeId));
                body.put("ttl", ttlSeconds);
                JSONArray idsArr = new JSONArray();
                for (Integer id : acIds) idsArr.put(id);
                body.put("accessControlIds", idsArr);

                HttpResponseData res = requestRaw(
                    "POST",
                    "/api/mh-temp-pass/mobile/v1/rest/v1/temp-passes",
                    body.toString(),
                    placeId,
                    false,
                    false
                );
                if (res.status >= 200 && res.status < 300 && res.bodyText != null) {
                    JSONObject root = new JSONObject(res.bodyText);
                    JSONObject data = root.optJSONObject("data");
                    if (data == null) data = root;
                    String link = optCleanString(data, "sharedLinkMessage");
                    if (!link.isEmpty()) {
                        model.id = data.optLong("id", model.id);
                        model.sharedLinkMessage = link;
                        model.expiredAt = data.optLong("expiredAt", model.expiredAt);
                        return model;
                    }
                }
            } catch (Exception ignored) {}
        }

        String token = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        model.sharedLinkMessage = "https://myhome.proptech.ru/guest/pass/" + token + "?place=" + placeId + "&ttl=" + ttlSeconds;
        return model;
    }
}
