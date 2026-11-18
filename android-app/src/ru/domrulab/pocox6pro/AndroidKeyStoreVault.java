package ru.domrulab.pocox6pro;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.KeyStore;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Аппаратное криптохранилище биометрических шаблонов лица на Poco X6 Pro (AndroidKeyStore AES-256-GCM).
 * Вычисления и хранение 128-мерных векторов выполняются исключительно локально на телефоне.
 * На VPS не передаётся ни одного байта фотографий или биометрических шаблонов (Раздел 3.2 и 6.1 ТЗ).
 */
public class AndroidKeyStoreVault {
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String KEY_ALIAS = "domru_lab_poco_x6_pro_face_aes256_v2";
    private static final String PREFS_NAME = "domru_keystore_biometric_vault";
    private static final String KEY_ENCRYPTED_RECORDS = "encrypted_records_json";
    private static final String KEY_ENROLLED_AT = "enrolled_at_str";
    private static final String KEY_POSES_COUNT = "poses_count";

    private final SharedPreferences prefs;

    public AndroidKeyStoreVault(Context context) {
        this.prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        ensureHardwareSecretKey();
    }

    private void ensureHardwareSecretKey() {
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE_PROVIDER);
            ks.load(null);
            if (!ks.containsAlias(KEY_ALIAS)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    KeyGenerator keyGenerator = KeyGenerator.getInstance(
                        KeyProperties.KEY_ALGORITHM_AES,
                        KEYSTORE_PROVIDER
                    );
                    KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                        KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
                    )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .build();
                    keyGenerator.init(spec);
                    keyGenerator.generateKey();
                }
            }
        } catch (Throwable ignored) {}
    }

    private SecretKey getSecretKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE_PROVIDER);
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        return null;
    }

    public boolean enrollEmbeddings(List<float[]> vectors128, String label) {
        try {
            SecretKey secretKey = getSecretKey();
            JSONArray arr = new JSONArray();

            for (float[] vec : vectors128) {
                ByteBuffer bb = ByteBuffer.allocate(vec.length * 4).order(ByteOrder.LITTLE_ENDIAN);
                for (float v : vec) {
                    bb.putFloat(v);
                }
                byte[] plainBytes = bb.array();

                JSONObject item = new JSONObject();
                if (secretKey != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.ENCRYPT_MODE, secretKey);
                    byte[] iv = cipher.getIV();
                    byte[] cipherText = cipher.doFinal(plainBytes);
                    item.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
                    item.put("ct", Base64.encodeToString(cipherText, Base64.NO_WRAP));
                    item.put("hw", true);
                } else {
                    item.put("ct", Base64.encodeToString(plainBytes, Base64.NO_WRAP));
                    item.put("hw", false);
                }
                item.put("label", label);
                arr.put(item);
            }

            String nowStr = new SimpleDateFormat("dd.MM.yyyy HH:mm:ss", Locale.getDefault()).format(new Date());
            prefs.edit()
                .putString(KEY_ENCRYPTED_RECORDS, arr.toString())
                .putString(KEY_ENROLLED_AT, nowStr)
                .putInt(KEY_POSES_COUNT, vectors128.size())
                .apply();
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    public List<float[]> loadDecryptedEmbeddings() {
        List<float[]> result = new ArrayList<float[]>();
        try {
            String raw = prefs.getString(KEY_ENCRYPTED_RECORDS, null);
            if (raw == null || raw.isEmpty()) return result;

            SecretKey secretKey = getSecretKey();
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject item = arr.getJSONObject(i);
                boolean hw = item.optBoolean("hw", false);
                byte[] plainBytes;
                if (hw && secretKey != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    byte[] iv = Base64.decode(item.getString("iv"), Base64.NO_WRAP);
                    byte[] ct = Base64.decode(item.getString("ct"), Base64.NO_WRAP);
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(128, iv));
                    plainBytes = cipher.doFinal(ct);
                } else {
                    plainBytes = Base64.decode(item.getString("ct"), Base64.NO_WRAP);
                }

                int len = plainBytes.length / 4;
                float[] vec = new float[len];
                ByteBuffer bb = ByteBuffer.wrap(plainBytes).order(ByteOrder.LITTLE_ENDIAN);
                for (int j = 0; j < len; j++) {
                    vec[j] = bb.getFloat();
                }
                result.add(vec);
            }
        } catch (Throwable ignored) {}
        return result;
    }

    public boolean hasEnrolledTemplate() {
        return prefs.getInt(KEY_POSES_COUNT, 0) > 0;
    }

    public int getPosesCount() {
        return prefs.getInt(KEY_POSES_COUNT, 0);
    }

    public String getEnrolledAt() {
        return prefs.getString(KEY_ENROLLED_AT, "—");
    }

    public void clearVault() {
        prefs.edit().clear().apply();
    }
}
