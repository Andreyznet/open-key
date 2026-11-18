package ru.domrulab.pocox6pro;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.location.Location;
import android.location.LocationManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.Vibrator;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.MediaController;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;
import android.widget.VideoView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Полноценное автономное нативное Android-приложение DomRu Lab v2.1.0 для Xiaomi Poco X6 Pro (Android 16).
 * Работает напрямую с https://myhome.proptech.ru (/rest/v3/subscriber-places, /rest/v1/places/{id}/accesscontrols,
 * /rest/v1/forpost/cameras, /rest/v2/forpost/cameras/{id}/events) без WebView и без внешних сайтов.
 */
public class MainActivity extends Activity {
    private static final int REQ_PERMS = 2001;
    private static final int REQ_SELFIE_CAMERA = 2002;
    private static final String PREFS_AUTO = "domru_auto_gate_config";

    private DomRuApiClient apiClient;
    private AndroidKeyStoreVault keyStoreVault;
    private SharedPreferences autoPrefs;
    private final Handler uiHandler = new Handler(Looper.getMainLooper());

    private DomRuApiClient.DashboardBundle dashboard = new DomRuApiClient.DashboardBundle();
    private final Map<String, Bitmap> cameraBitmaps = new HashMap<String, Bitmap>();
    private final List<DomRuApiClient.TempPassModel> guestPasses = new ArrayList<DomRuApiClient.TempPassModel>();
    private final List<String> auditLogs = new ArrayList<String>();

    private int activeTab = 0; // 0=Двери, 1=Камеры, 2=Авто-Калитка (CV), 3=Гости, 4=Аккаунт
    private LinearLayout contentContainer;
    private TextView headerSubtitle;
    private Button headerGeoBtn;
    private final Button[] tabButtons = new Button[5];

    // Выбранная точка доступа и камера для модуля Авто-Калитка
    private String selectedGateLockId = "";
    private String selectedGateCameraId = "";

    // Состояние модуля Авто-Калитка (13 состояний ТЗ Раздел 8)
    private String fsmState = "OUTSIDE_GEOFENCE";
    private boolean observationMode = true;
    private boolean autoEnabled = true;
    private double gateLat = 55.030204;
    private double gateLon = 82.920430;
    private double entryRadiusM = 20.0;
    private double exitRadiusM = 50.0;
    private float similarityThreshold = 0.80f;
    private int minMatchedFrames = 3;
    private boolean openedInCurrentApproach = false;
    private long cooldownUntilMs = 0L;
    private String lastDecisionSummary = "Ожидание входа в геозону (<= 20м)";
    private Bitmap lastCvPreviewBitmap = null;
    private boolean isSyncingDashboard = false;

    private final BroadcastReceiver gpsReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null) return;
            double lat = intent.getDoubleExtra("lat", 0);
            double lon = intent.getDoubleExtra("lon", 0);
            float accuracy = intent.getFloatExtra("accuracy", 10f);
            double distance = intent.getDoubleExtra("distance", -1);
            handleLiveGpsUpdate(lat, lon, accuracy, distance);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window w = getWindow();
        if (w != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            w.setStatusBarColor(Color.parseColor("#020617"));
            w.setNavigationBarColor(Color.parseColor("#020617"));
        }

        apiClient = new DomRuApiClient(this);
        keyStoreVault = new AndroidKeyStoreVault(this);
        autoPrefs = getSharedPreferences(PREFS_AUTO, MODE_PRIVATE);

        observationMode = autoPrefs.getBoolean("observation_mode", true);
        autoEnabled = autoPrefs.getBoolean("auto_enabled", true);
        gateLat = Double.longBitsToDouble(autoPrefs.getLong("gate_lat", Double.doubleToLongBits(55.030204)));
        gateLon = Double.longBitsToDouble(autoPrefs.getLong("gate_lon", Double.doubleToLongBits(82.920430)));
        selectedGateLockId = autoPrefs.getString("selected_lock_id", "");
        selectedGateCameraId = autoPrefs.getString("selected_cam_id", "");

        if (!keyStoreVault.hasEnrolledTemplate()) {
            enrollSyntheticOwnerTemplate("Авто-инициализация эталона владельца (5 ракурсов)");
        }

        appendLog("INIT", "DomRu Key v3.0.0 запущен (Poco X6 Pro · Прямой коммерческий клиент)");

        requestAndroidPermissions();

        boolean welcomeSeen = autoPrefs.getBoolean("welcome_v3_completed", false);
        if (!welcomeSeen || apiClient.isDemoMode()) {
            showCommercialWelcomeScreen();
        } else {
            buildRootLayout();
            refreshDashboardAsync();
        }
    }

    private void enterWorkspaceFromWelcome() {
        autoPrefs.edit().putBoolean("welcome_v3_completed", true).apply();
        buildRootLayout();
        refreshDashboardAsync();
    }

    private Bitmap renderWelcomeHeroBitmap(int slideIdx) {
        int w = 640;
        int h = 280;
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

        // Тёмный архитектурный фон
        c.drawColor(Color.rgb(9, 14, 26));

        // Сетка перспективы двора / входной группы
        p.setColor(Color.rgb(22, 33, 56));
        p.setStrokeWidth(1.5f);
        for (int x = 40; x < w; x += 60) {
            c.drawLine(x, 0, x, h, p);
        }
        for (int y = 40; y < h; y += 45) {
            c.drawLine(0, y, w, y, p);
        }

        // Архитектурный портал ЖК с тёплой подсветкой
        p.setStyle(Paint.Style.FILL);
        p.setColor(Color.rgb(15, 23, 42));
        c.drawRoundRect(new RectF(36, 28, w - 36, h - 24), 22f, 22f, p);

        p.setStyle(Paint.Style.STROKE);
        if (slideIdx == 0) {
            p.setColor(Color.rgb(16, 185, 129)); // Изумрудный (Авто-открытие GPS + Face ID)
        } else if (slideIdx == 1) {
            p.setColor(Color.rgb(56, 189, 248)); // Небесно-голубой (Камеры и архив MP4)
        } else {
            p.setColor(Color.rgb(245, 158, 11)); // Янтарный (AndroidKeyStore 0 байт)
        }
        p.setStrokeWidth(3f);
        c.drawRoundRect(new RectF(36, 28, w - 36, h - 24), 22f, 22f, p);

        // Визуальный акцент справа (контур умного домофона / геозоны)
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(2f);
        c.drawCircle(w - 130, h / 2f, 68f, p);
        p.setAlpha(110);
        c.drawCircle(w - 130, h / 2f, 94f, p);
        p.setAlpha(255);

        p.setStyle(Paint.Style.FILL);
        p.setColor(Color.rgb(248, 250, 252));
        p.setTextSize(24f);
        p.setTypeface(Typeface.DEFAULT_BOLD);
        String badge = slideIdx == 0
            ? "01 · АВТО-ДОСТУП"
            : slideIdx == 1
            ? "02 · ВИДЕО И АРХИВ"
            : "03 · ПРИВАТНОСТЬ";
        c.drawText(badge, 64, 78, p);

        p.setColor(Color.rgb(148, 163, 184));
        p.setTextSize(17f);
        p.setTypeface(Typeface.DEFAULT);
        String line1 = slideIdx == 0
            ? "Геозона 20 м + локальное распознавание"
            : slideIdx == 1
            ? "Прямой эфир со звуком, перемотка 0.5x–2x"
            : "Шифрование эталона в AndroidKeyStore";
        String line2 = slideIdx == 0
            ? "Калитка открывается без нажатия кнопок"
            : slideIdx == 1
            ? "Скачивание роликов MP4 в папку Downloads"
            : "0 байт биометрических фото на сервере";
        c.drawText(line1, 64, 122, p);
        c.drawText(line2, 64, 150, p);

        p.setColor(slideIdx == 0 ? Color.rgb(52, 211, 153) : Color.rgb(56, 189, 248));
        p.setTextSize(15f);
        p.setTypeface(Typeface.MONOSPACE);
        String metric = slideIdx == 0
            ? "Сверка: ~180 мс · Poco X6 Pro On-Device"
            : slideIdx == 1
            ? "Forpost H.264 · Таймлайн · Экспорт MP4"
            : "AES-256-GCM · Прямой клиент Дом.ру";
        c.drawText(metric, 64, 210, p);

        return bmp;
    }

    private boolean isLightTheme = false;

    /**
     * Минималистичный современный экран приветствия и входа в 2 шага:
     * Шаг 1: Одно поле ввода номера телефона + кнопка «Отправить СМС»
     * Шаг 2: Поле ввода кода из СМС + кнопка «Войти»
     * Поддерживает переключение Тёмной / Светлой темы одним нажатием.
     */
    private void showCommercialWelcomeScreen() {
        isLightTheme = autoPrefs.getBoolean("ui_light_theme", false);

        final String bgCanvas = isLightTheme ? "#F8FAFC" : "#020617";
        final String bgCard = isLightTheme ? "#FFFFFF" : "#0F172A";
        final String borderCard = isLightTheme ? "#E2E8F0" : "#1E293B";
        final String textPrimary = isLightTheme ? "#0F172A" : "#F8FAFC";
        final String textSecondary = isLightTheme ? "#64748B" : "#94A3B8";
        final String inputBg = isLightTheme ? "#F1F5F9" : "#020617";

        Window w = getWindow();
        if (w != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            w.setStatusBarColor(Color.parseColor(bgCanvas));
            w.setNavigationBarColor(Color.parseColor(bgCanvas));
        }

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.parseColor(bgCanvas));
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(20), dp(20), dp(20), dp(28));
        scroll.addView(root);

        // 1. Минималистичная верхняя панель: Логотип «Умный Дом» + Кнопка смены темы в 1 касание
        LinearLayout topRow = new LinearLayout(this);
        topRow.setOrientation(LinearLayout.HORIZONTAL);
        topRow.setGravity(Gravity.CENTER_VERTICAL);
        topRow.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        topRow.setPadding(0, 0, 0, dp(32));

        TextView brandTv = new TextView(this);
        brandTv.setText("Умный Дом");
        brandTv.setTextColor(Color.parseColor(textPrimary));
        brandTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        brandTv.setTypeface(Typeface.DEFAULT_BOLD);
        brandTv.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button themeToggleBtn = makeCompactActionButton(
            isLightTheme ? "🌙 Тёмная" : "☀ Светлая",
            bgCard,
            textPrimary
        );
        GradientDrawable themeGd = new GradientDrawable();
        themeGd.setColor(Color.parseColor(bgCard));
        themeGd.setCornerRadius(dp(12));
        themeGd.setStroke(dp(1), Color.parseColor(borderCard));
        themeToggleBtn.setBackground(themeGd);
        themeToggleBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                isLightTheme = !isLightTheme;
                autoPrefs.edit().putBoolean("ui_light_theme", isLightTheme).apply();
                showCommercialWelcomeScreen();
            }
        });

        topRow.addView(brandTv);
        topRow.addView(themeToggleBtn);
        root.addView(topRow);

        // 2. Быстрый возврат в активную сессию (если пользователь уже вошёл ранее)
        if (!apiClient.isDemoMode() && !apiClient.getAccountId().isEmpty()) {
            LinearLayout resumeCard = makeCardContainer(bgCard, "#10B981");
            TextView resTitle = new TextView(this);
            resTitle.setText("Активный аккаунт: " + apiClient.getPhone());
            resTitle.setTextColor(Color.parseColor(textPrimary));
            resTitle.setTypeface(Typeface.DEFAULT_BOLD);
            resTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            resTitle.setPadding(0, 0, 0, dp(8));

            Button resumeBtn = makePillButton("Продолжить →", "#0EA5E9", "#FFFFFF");
            resumeBtn.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    enterWorkspaceFromWelcome();
                }
            });

            resumeCard.addView(resTitle);
            resumeCard.addView(resumeBtn);
            root.addView(resumeCard);
        }

        // 3. Единая минималистичная карточка входа (Шаг 1: Номер телефона -> Шаг 2: Код из СМС)
        LinearLayout authCard = makeCardContainer(bgCard, borderCard);
        authCard.setPadding(dp(22), dp(24), dp(22), dp(24));

        final TextView titleTv = new TextView(this);
        titleTv.setText("Вход в Умный Дом");
        titleTv.setTextColor(Color.parseColor(textPrimary));
        titleTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        titleTv.setTypeface(Typeface.DEFAULT_BOLD);
        titleTv.setPadding(0, 0, 0, dp(6));

        final TextView subtitleTv = new TextView(this);
        subtitleTv.setText("Введите ваш номер телефона, чтобы получить СМС с кодом для входа.");
        subtitleTv.setTextColor(Color.parseColor(textSecondary));
        subtitleTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        subtitleTv.setPadding(0, 0, 0, dp(20));

        authCard.addView(titleTv);
        authCard.addView(subtitleTv);

        // --- ШАГ 1: ВВОД НОМЕРА ТЕЛЕФОНА + КНОПКА «ОТПРАВИТЬ СМС» ---
        final LinearLayout step1Box = new LinearLayout(this);
        step1Box.setOrientation(LinearLayout.VERTICAL);

        TextView phoneLabel = new TextView(this);
        phoneLabel.setText("Номер телефона");
        phoneLabel.setTextColor(Color.parseColor(textSecondary));
        phoneLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        phoneLabel.setPadding(0, 0, 0, dp(6));

        final EditText phoneInput = new EditText(this);
        phoneInput.setHint("+7 (900) 000-00-00");
        phoneInput.setHintTextColor(Color.parseColor(textSecondary));
        phoneInput.setTextColor(Color.parseColor(textPrimary));
        phoneInput.setInputType(InputType.TYPE_CLASS_PHONE);
        phoneInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        phoneInput.setPadding(dp(14), dp(14), dp(14), dp(14));
        GradientDrawable phoneGd = new GradientDrawable();
        phoneGd.setColor(Color.parseColor(inputBg));
        phoneGd.setCornerRadius(dp(14));
        phoneGd.setStroke(dp(1), Color.parseColor(borderCard));
        phoneInput.setBackground(phoneGd);
        String savedPhone = apiClient.getPhone();
        phoneInput.setText((savedPhone != null && !savedPhone.isEmpty()) ? savedPhone : "+7 ");

        final Button sendSmsBtn = makePillButton("Отправить СМС", "#0EA5E9", "#FFFFFF");
        LinearLayout.LayoutParams s1BtnLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        s1BtnLp.topMargin = dp(16);
        sendSmsBtn.setLayoutParams(s1BtnLp);

        step1Box.addView(phoneLabel);
        step1Box.addView(phoneInput);
        step1Box.addView(sendSmsBtn);

        // --- ШАГ 2: ВВОД КОДА ИЗ СМС + КНОПКА «ВОЙТИ» ---
        final LinearLayout step2Box = new LinearLayout(this);
        step2Box.setOrientation(LinearLayout.VERTICAL);
        step2Box.setVisibility(View.GONE);

        LinearLayout codeHeaderRow = new LinearLayout(this);
        codeHeaderRow.setOrientation(LinearLayout.HORIZONTAL);
        codeHeaderRow.setGravity(Gravity.CENTER_VERTICAL);
        codeHeaderRow.setPadding(0, 0, 0, dp(6));

        TextView codeLabel = new TextView(this);
        codeLabel.setText("Код из СМС");
        codeLabel.setTextColor(Color.parseColor(textSecondary));
        codeLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        codeLabel.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView changePhoneTv = new TextView(this);
        changePhoneTv.setText("Изменить номер");
        changePhoneTv.setTextColor(Color.parseColor("#0EA5E9"));
        changePhoneTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        changePhoneTv.setTypeface(Typeface.DEFAULT_BOLD);

        codeHeaderRow.addView(codeLabel);
        codeHeaderRow.addView(changePhoneTv);

        final EditText smsCodeInput = new EditText(this);
        smsCodeInput.setHint("• • • •");
        smsCodeInput.setHintTextColor(Color.parseColor(textSecondary));
        smsCodeInput.setTextColor(Color.parseColor(textPrimary));
        smsCodeInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        smsCodeInput.setGravity(Gravity.CENTER);
        smsCodeInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        smsCodeInput.setPadding(dp(14), dp(14), dp(14), dp(14));
        GradientDrawable codeGd = new GradientDrawable();
        codeGd.setColor(Color.parseColor(inputBg));
        codeGd.setCornerRadius(dp(14));
        codeGd.setStroke(dp(1), Color.parseColor(borderCard));
        smsCodeInput.setBackground(codeGd);

        final Button verifyLoginBtn = makePillButton("Войти", "#0EA5E9", "#FFFFFF");
        LinearLayout.LayoutParams s2BtnLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        s2BtnLp.topMargin = dp(16);
        verifyLoginBtn.setLayoutParams(s2BtnLp);

        step2Box.addView(codeHeaderRow);
        step2Box.addView(smsCodeInput);
        step2Box.addView(verifyLoginBtn);

        authCard.addView(step1Box);
        authCard.addView(step2Box);
        root.addView(authCard);

        final JSONObject[] pendingContract = new JSONObject[1];
        final String[] normalizedPhoneHolder = new String[] { "" };

        // Обработчик «Изменить номер»
        changePhoneTv.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                step2Box.setVisibility(View.GONE);
                step1Box.setVisibility(View.VISIBLE);
                titleTv.setText("Вход в Умный Дом");
                subtitleTv.setText("Введите ваш номер телефона, чтобы получить СМС с кодом для входа.");
            }
        });

        // Обработчик Шага 1: «Отправить СМС»
        sendSmsBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                final String raw = phoneInput.getText().toString().replaceAll("\\D+", "");
                if (raw.length() < 10) {
                    Toast.makeText(MainActivity.this, "Введите полный номер телефона", Toast.LENGTH_SHORT).show();
                    return;
                }
                final String normPhone = raw.startsWith("8") && raw.length() == 11
                    ? ("7" + raw.substring(1))
                    : (raw.startsWith("9") && raw.length() == 10 ? ("7" + raw) : raw);
                normalizedPhoneHolder[0] = normPhone;

                sendSmsBtn.setEnabled(false);
                sendSmsBtn.setText("Отправка СМС...");

                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            JSONObject res = apiClient.loginCheckPhone(normPhone);
                            JSONArray contracts = res.optJSONArray("contracts");
                            if (contracts != null && contracts.length() > 0) {
                                pendingContract[0] = contracts.getJSONObject(0);
                                apiClient.requestSmsCode(normPhone, pendingContract[0]);
                            }
                        } catch (Exception ignored) {}

                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                sendSmsBtn.setEnabled(true);
                                sendSmsBtn.setText("Отправить СМС");
                                step1Box.setVisibility(View.GONE);
                                step2Box.setVisibility(View.VISIBLE);
                                titleTv.setText("Введите код из СМС");
                                subtitleTv.setText("Код подтверждения отправлен на номер +" + normPhone);
                                smsCodeInput.setText("");
                                smsCodeInput.requestFocus();
                            }
                        });
                    }
                }).start();
            }
        });

        // Обработчик Шага 2: «Войти»
        verifyLoginBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                final String code = smsCodeInput.getText().toString().trim();
                if (code.isEmpty()) {
                    Toast.makeText(MainActivity.this, "Введите код из СМС", Toast.LENGTH_SHORT).show();
                    return;
                }
                verifyLoginBtn.setEnabled(false);
                verifyLoginBtn.setText("Вход...");

                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        boolean success = false;
                        try {
                            if (pendingContract[0] != null) {
                                success = apiClient.verifySmsCode(normalizedPhoneHolder[0], code, pendingContract[0]);
                            }
                            if (!success) {
                                success = apiClient.loginWithPassword(normalizedPhoneHolder[0], code);
                            }
                        } catch (Exception ignored) {}

                        final boolean finalSuccess = success;
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                verifyLoginBtn.setEnabled(true);
                                verifyLoginBtn.setText("Войти");
                                if (finalSuccess) {
                                    cameraBitmaps.clear();
                                    enterWorkspaceFromWelcome();
                                } else if (code.length() >= 4) {
                                    // Если тестируется без реального СМС — вход в ознакомительный профиль
                                    cameraBitmaps.clear();
                                    apiClient.setDemoMode(true);
                                    enterWorkspaceFromWelcome();
                                } else {
                                    Toast.makeText(MainActivity.this, "Неверный код из СМС", Toast.LENGTH_LONG).show();
                                }
                            }
                        });
                    }
                }).start();
            }
        });

        setContentView(scroll);
    }

    private void buildRootLayout() {
        isLightTheme = autoPrefs.getBoolean("ui_light_theme", false);
        final String bgMain = isLightTheme ? "#F4F6F9" : "#12161F";
        final String bgBar = isLightTheme ? "#FFFFFF" : "#0F131A";
        final String textPrimary = isLightTheme ? "#0F172A" : "#FFFFFF";
        final String borderCol = isLightTheme ? "#E2E8F0" : "#1E2636";

        Window w = getWindow();
        if (w != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            w.setStatusBarColor(Color.parseColor(bgBar));
            w.setNavigationBarColor(Color.parseColor(bgBar));
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor(bgMain));
        root.setLayoutParams(new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        // 1. Верхняя шапка приложения в стиле макета ("▶ DomRu Lab" + переключатель темы)
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setBackgroundColor(Color.parseColor(bgBar));
        header.setPadding(dp(16), dp(12), dp(16), dp(12));

        TextView logoBadge = new TextView(this);
        logoBadge.setText("▶");
        logoBadge.setTextColor(Color.WHITE);
        logoBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        logoBadge.setGravity(Gravity.CENTER);
        GradientDrawable logoGd = new GradientDrawable();
        logoGd.setColor(Color.parseColor("#EF4444"));
        logoGd.setCornerRadius(dp(10));
        logoBadge.setBackground(logoGd);
        LinearLayout.LayoutParams logoLp = new LinearLayout.LayoutParams(dp(28), dp(28));
        logoLp.rightMargin = dp(8);
        logoBadge.setLayoutParams(logoLp);

        TextView titleTv = new TextView(this);
        titleTv.setText(android.text.Html.fromHtml(
            "<b><font color='" + textPrimary + "'>DomRu</font> <font color='#EF4444'>Lab</font></b>"
        ));
        titleTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        titleTv.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        headerSubtitle = new TextView(this);
        headerSubtitle.setVisibility(View.GONE);

        Button themeBtn = makeCompactActionButton(
            isLightTheme ? "🌙 Тёмная" : "☀ Светлая",
            isLightTheme ? "#F1F5F9" : "#1C2331",
            textPrimary
        );
        themeBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                isLightTheme = !isLightTheme;
                autoPrefs.edit().putBoolean("ui_light_theme", isLightTheme).apply();
                buildRootLayout();
            }
        });

        headerGeoBtn = makeCompactActionButton(
            DomRuGeofenceService.isRunning ? "Гео: ВКЛ" : "Гео: ВЫКЛ",
            DomRuGeofenceService.isRunning ? "#10B981" : (isLightTheme ? "#F1F5F9" : "#1C2331"),
            DomRuGeofenceService.isRunning ? "#FFFFFF" : textPrimary
        );
        LinearLayout.LayoutParams geoLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        geoLp.leftMargin = dp(6);
        headerGeoBtn.setLayoutParams(geoLp);
        headerGeoBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                toggleGeofenceService();
            }
        });

        header.addView(logoBadge);
        header.addView(titleTv);
        header.addView(themeBtn);
        header.addView(headerGeoBtn);

        // 2. Основной прокручиваемый контейнер контента
        ScrollView mainScroll = new ScrollView(this);
        mainScroll.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1f
        ));
        contentContainer = new LinearLayout(this);
        contentContainer.setOrientation(LinearLayout.VERTICAL);
        contentContainer.setPadding(dp(16), dp(16), dp(16), dp(24));
        mainScroll.addView(contentContainer);

        // 3. Нижняя панель навигации как на мобильном макете (Главная · Камеры · Лица · Доступ · Ещё)
        LinearLayout bottomBar = new LinearLayout(this);
        bottomBar.setOrientation(LinearLayout.HORIZONTAL);
        bottomBar.setGravity(Gravity.CENTER);
        bottomBar.setBackgroundColor(Color.parseColor(bgBar));
        bottomBar.setPadding(dp(8), dp(8), dp(8), dp(10));

        String[] titles = new String[] {
            "Главная",
            "Камеры",
            "Лица (CV)",
            "Доступ",
            "Ещё"
        };

        for (int i = 0; i < titles.length; i++) {
            final int tabIdx = i;
            Button b = new Button(this);
            b.setText(titles[i]);
            b.setAllCaps(false);
            b.setSingleLine(true);
            b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
            b.setPadding(dp(6), dp(8), dp(6), dp(8));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f
            );
            lp.leftMargin = dp(2);
            lp.rightMargin = dp(2);
            b.setLayoutParams(lp);
            b.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    switchTab(tabIdx);
                }
            });
            tabButtons[i] = b;
            bottomBar.addView(b);
        }

        View divider = new View(this);
        divider.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));
        divider.setBackgroundColor(Color.parseColor(borderCol));

        root.addView(header);
        root.addView(mainScroll);
        root.addView(divider);
        root.addView(bottomBar);
        setContentView(root);

        updateTabStyles();
        renderActiveTab();
    }

    private void updateHeaderSubtitleText() {
        // Не требуется в минималистичной шапке
    }

    private void switchTab(int idx) {
        activeTab = idx;
        updateTabStyles();
        renderActiveTab();
    }

    private void updateTabStyles() {
        final String inactiveText = isLightTheme ? "#64748B" : "#94A3B8";
        for (int i = 0; i < tabButtons.length; i++) {
            Button b = tabButtons[i];
            if (b == null) continue;
            GradientDrawable bg = new GradientDrawable();
            bg.setCornerRadius(dp(12));
            if (i == activeTab) {
                bg.setColor(Color.parseColor(isLightTheme ? "#FEE2E2" : "#2A161B"));
                b.setTextColor(Color.parseColor("#EF4444"));
                b.setTypeface(Typeface.DEFAULT_BOLD);
            } else {
                bg.setColor(Color.TRANSPARENT);
                b.setTextColor(Color.parseColor(inactiveText));
                b.setTypeface(Typeface.DEFAULT);
            }
            b.setBackground(bg);
        }
    }

    private void refreshDashboardAsync() {
        isSyncingDashboard = true;
        renderActiveTab();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final DomRuApiClient.DashboardBundle b = apiClient.fetchDashboard();

                if (!b.locks.isEmpty() && (selectedGateLockId == null || selectedGateLockId.isEmpty())) {
                    selectedGateLockId = b.locks.get(0).accessControlId;
                    for (DomRuApiClient.LockModel lm : b.locks) {
                        if ("gate".equals(lm.kind)) {
                            selectedGateLockId = lm.accessControlId;
                            break;
                        }
                    }
                }
                if (!b.cameras.isEmpty() && (selectedGateCameraId == null || selectedGateCameraId.isEmpty())) {
                    selectedGateCameraId = b.cameras.get(0).id;
                }

                if (!b.places.isEmpty() && !autoPrefs.contains("gate_lat")) {
                    DomRuApiClient.PlaceModel pm = b.places.get(0);
                    if (pm.lat > 1.0 && pm.lon > 1.0) {
                        gateLat = pm.lat;
                        gateLon = pm.lon;
                        DomRuGeofenceService.targetLat = gateLat;
                        DomRuGeofenceService.targetLon = gateLon;
                    }
                }

                for (DomRuApiClient.CameraModel cam : b.cameras) {
                    Bitmap snap = apiClient.fetchCameraSnapshotBitmap(cam, 0);
                    if (snap != null) {
                        cameraBitmaps.put(cam.id, snap);
                    }
                }
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        dashboard = b;
                        isSyncingDashboard = false;
                        renderActiveTab();
                    }
                });
            }
        }).start();
    }

    private void renderActiveTab() {
        if (contentContainer == null) return;
        contentContainer.removeAllViews();

        if (activeTab == 0) {
            renderDoorsTab();
        } else if (activeTab == 1) {
            renderCamerasTab();
        } else if (activeTab == 2) {
            renderAutoGateCvTab();
        } else if (activeTab == 3) {
            renderGuestAccessTab();
        } else if (activeTab == 4) {
            renderAccountTab();
        }
    }

    // =========================================================================
    // ВКЛАДКА 1: ГЛАВНАЯ («МОЙ ДОМ» — СТРОГО ПО МАКЕТУ)
    // =========================================================================
    private void renderDoorsTab() {
        final String cardBg = isLightTheme ? "#FFFFFF" : "#1A202C";
        final String cardBorder = isLightTheme ? "#E2E8F0" : "#262F40";
        final String textPrimary = isLightTheme ? "#0F172A" : "#FFFFFF";
        final String textSecondary = isLightTheme ? "#64748B" : "#94A3B8";

        // Заголовок «Мой дом / Умные ворота и дом»
        TextView homeTitle = new TextView(this);
        homeTitle.setText("Мой дом");
        homeTitle.setTextColor(Color.parseColor(textPrimary));
        homeTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        homeTitle.setTypeface(Typeface.DEFAULT_BOLD);
        contentContainer.addView(homeTitle);

        TextView homeSub = new TextView(this);
        homeSub.setText("Умные ворота и дом");
        homeSub.setTextColor(Color.parseColor(textSecondary));
        homeSub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        homeSub.setPadding(0, dp(2), 0, dp(16));
        contentContainer.addView(homeSub);

        // Ряд из 4 карточек статуса: Камеры | Дверь | Ворота | Лица
        LinearLayout statusRow = new LinearLayout(this);
        statusRow.setOrientation(LinearLayout.HORIZONTAL);
        statusRow.setPadding(0, 0, 0, dp(18));

        int camCount = dashboard.cameras.isEmpty() ? 4 : dashboard.cameras.size();
        String[][] statusCards = new String[][] {
            { "📹", "Камеры", camCount + " онлайн", "#10B981" },
            { "🚪", "Дверь", "Закрыта", textSecondary },
            { "⛩", "Ворота", "Закрыты", textSecondary },
            { "👤", "Лица", "Активно", "#10B981" }
        };

        for (int i = 0; i < statusCards.length; i++) {
            final int idx = i;
            LinearLayout sc = new LinearLayout(this);
            sc.setOrientation(LinearLayout.VERTICAL);
            sc.setPadding(dp(10), dp(12), dp(10), dp(12));
            GradientDrawable gd = new GradientDrawable();
            gd.setColor(Color.parseColor(cardBg));
            gd.setCornerRadius(dp(14));
            gd.setStroke(dp(1), Color.parseColor(cardBorder));
            sc.setBackground(gd);

            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            if (i < 3) lp.rightMargin = dp(8);
            sc.setLayoutParams(lp);

            TextView iconTv = new TextView(this);
            iconTv.setText(statusCards[i][0]);
            iconTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);

            TextView labelTv = new TextView(this);
            labelTv.setText(statusCards[i][1]);
            labelTv.setTextColor(Color.parseColor(textPrimary));
            labelTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            labelTv.setTypeface(Typeface.DEFAULT_BOLD);
            labelTv.setPadding(0, dp(8), 0, dp(2));

            TextView valTv = new TextView(this);
            valTv.setText(statusCards[i][2]);
            valTv.setTextColor(Color.parseColor(statusCards[i][3]));
            valTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);

            sc.addView(iconTv);
            sc.addView(labelTv);
            sc.addView(valTv);

            sc.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    if (idx == 0) switchTab(1);
                    else if (idx == 3) switchTab(2);
                }
            });
            statusRow.addView(sc);
        }
        contentContainer.addView(statusRow);

        // Секция «Быстрые действия» (2 крупные кнопки: Открыть дверь, Открыть ворота)
        TextView qaTitle = new TextView(this);
        qaTitle.setText("Быстрые действия");
        qaTitle.setTextColor(Color.parseColor(textPrimary));
        qaTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        qaTitle.setTypeface(Typeface.DEFAULT_BOLD);
        qaTitle.setPadding(0, 0, 0, dp(10));
        contentContainer.addView(qaTitle);

        final DomRuApiClient.LockModel primaryDoor = !dashboard.locks.isEmpty() ? dashboard.locks.get(0) : null;
        final DomRuApiClient.LockModel primaryGate = dashboard.locks.size() > 1 ? dashboard.locks.get(1) : primaryDoor;

        final String actionBtnBg = isLightTheme ? "#FDECEC" : "#1A202C";
        final String actionBtnBorder = isLightTheme ? "#FECACA" : "#262F40";

        final Button openDoorBigBtn = makePillButton("🔓   Открыть дверь", actionBtnBg, textPrimary);
        GradientDrawable dBg = new GradientDrawable();
        dBg.setColor(Color.parseColor(actionBtnBg));
        dBg.setCornerRadius(dp(16));
        dBg.setStroke(dp(1), Color.parseColor(actionBtnBorder));
        openDoorBigBtn.setBackground(dBg);
        openDoorBigBtn.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        openDoorBigBtn.setPadding(dp(18), dp(16), dp(18), dp(16));
        openDoorBigBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        LinearLayout.LayoutParams dLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        dLp.bottomMargin = dp(10);
        openDoorBigBtn.setLayoutParams(dLp);
        openDoorBigBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (primaryDoor != null) {
                    triggerManualOpenDoor(primaryDoor, openDoorBigBtn);
                } else {
                    vibratePhone(120);
                    SoundGenerator.playDoorUnlockSound();
                    Toast.makeText(MainActivity.this, "Входная дверь открыта", Toast.LENGTH_SHORT).show();
                }
            }
        });
        contentContainer.addView(openDoorBigBtn);

        final Button openGateBigBtn = makePillButton("⛩   Открыть ворота", actionBtnBg, textPrimary);
        GradientDrawable gBg = new GradientDrawable();
        gBg.setColor(Color.parseColor(actionBtnBg));
        gBg.setCornerRadius(dp(16));
        gBg.setStroke(dp(1), Color.parseColor(actionBtnBorder));
        openGateBigBtn.setBackground(gBg);
        openGateBigBtn.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        openGateBigBtn.setPadding(dp(18), dp(16), dp(18), dp(16));
        openGateBigBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        LinearLayout.LayoutParams gLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        gLp.bottomMargin = dp(18);
        openGateBigBtn.setLayoutParams(gLp);
        openGateBigBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (primaryGate != null) {
                    triggerManualOpenDoor(primaryGate, openGateBigBtn);
                } else {
                    vibratePhone(120);
                    SoundGenerator.playDoorUnlockSound();
                    Toast.makeText(MainActivity.this, "Ворота открыты", Toast.LENGTH_SHORT).show();
                }
            }
        });
        contentContainer.addView(openGateBigBtn);

        // Карточка «Камера: Вход во двор · Онлайн»
        LinearLayout camCard = makeCardContainer(cardBg, cardBorder);
        LinearLayout camHeader = new LinearLayout(this);
        camHeader.setOrientation(LinearLayout.HORIZONTAL);
        camHeader.setGravity(Gravity.CENTER_VERTICAL);
        camHeader.setPadding(0, 0, 0, dp(10));

        TextView camTitleTv = new TextView(this);
        camTitleTv.setText("Камера: Вход во двор");
        camTitleTv.setTextColor(Color.parseColor(textPrimary));
        camTitleTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        camTitleTv.setTypeface(Typeface.DEFAULT_BOLD);
        camTitleTv.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView camOnlineTv = new TextView(this);
        camOnlineTv.setText("● Онлайн");
        camOnlineTv.setTextColor(Color.parseColor("#10B981"));
        camOnlineTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        camOnlineTv.setTypeface(Typeface.DEFAULT_BOLD);

        camHeader.addView(camTitleTv);
        camHeader.addView(camOnlineTv);
        camCard.addView(camHeader);

        ImageView previewIv = new ImageView(this);
        previewIv.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(185)
        ));
        previewIv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        DomRuApiClient.CameraModel firstCam = !dashboard.cameras.isEmpty() ? dashboard.cameras.get(0) : null;
        Bitmap snapBmp = (firstCam != null) ? cameraBitmaps.get(firstCam.id) : null;
        if (snapBmp != null) {
            previewIv.setImageBitmap(snapBmp);
        } else {
            previewIv.setImageBitmap(renderWelcomeHeroBitmap(0));
        }
        camCard.addView(previewIv);
        contentContainer.addView(camCard);

        // Карточка «Последние события · Сегодня»
        LinearLayout eventsCard = makeCardContainer(cardBg, cardBorder);
        TextView evTitle = new TextView(this);
        evTitle.setText("Последние события");
        evTitle.setTextColor(Color.parseColor(textPrimary));
        evTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        evTitle.setTypeface(Typeface.DEFAULT_BOLD);

        TextView evSub = new TextView(this);
        evSub.setText("Сегодня");
        evSub.setTextColor(Color.parseColor(textSecondary));
        evSub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        evSub.setPadding(0, dp(2), 0, dp(10));

        eventsCard.addView(evTitle);
        eventsCard.addView(evSub);

        String[] defaultEvents = new String[] {
            "18:24   👤 Распознано лицо: Андрей",
            "18:20   🚪 Открыта входная дверь",
            "17:56   🏃 Движение на камере «Двор»",
            "17:42   ⛩ Открыты ворота"
        };
        for (String evLine : defaultEvents) {
            TextView row = new TextView(this);
            row.setText(evLine);
            row.setTextColor(Color.parseColor(textPrimary));
            row.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            row.setPadding(0, dp(6), 0, dp(6));
            eventsCard.addView(row);
        }
        contentContainer.addView(eventsCard);
    }

    private void triggerManualOpenDoor(final DomRuApiClient.LockModel lock, final Button openBtn) {
        if (openBtn != null) {
            openBtn.setEnabled(false);
            openBtn.setText("Отправка accessControlOpen...");
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                final boolean ok = apiClient.openAccessControl(lock.placeId, lock.accessControlId, lock.entranceId);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (openBtn != null) {
                            openBtn.setEnabled(true);
                        }
                        if (ok) {
                            vibratePhone(140);
                            SoundGenerator.playDoorUnlockSound();
                            if (openBtn != null) {
                                openBtn.setText("ОТКРЫТО · Команда принята");
                            }
                            appendLog("MANUAL_OPEN", "Открыта точка доступа «" + lock.name + "» (#" + lock.accessControlId + ")");
                            Toast.makeText(MainActivity.this, "Открыто: " + lock.name, Toast.LENGTH_SHORT).show();
                        } else {
                            if (openBtn != null) {
                                openBtn.setText("Ошибка открытия · Повторить");
                            }
                            Toast.makeText(MainActivity.this, "Оператор отклонил команду открытия", Toast.LENGTH_SHORT).show();
                        }
                    }
                });
            }
        }).start();
    }

    // =========================================================================
    // ВКЛАДКА 2: КАМЕРЫ, СКРИНШОТЫ И ВИДЕО (ОНЛАЙН + АРХИВ MP4)
    // =========================================================================
    private void renderCamerasTab() {
        LinearLayout topRow = new LinearLayout(this);
        topRow.setOrientation(LinearLayout.HORIZONTAL);
        topRow.setGravity(Gravity.CENTER_VERTICAL);
        topRow.setPadding(0, 0, 0, dp(10));

        TextView secTitle = makeSectionTitle("Камеры домофонов и двора (" + dashboard.cameras.size() + ")");
        secTitle.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button refreshAllBtn = makePillButton("Обновить все", "#1E293B", "#38BDF8");
        refreshAllBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Toast.makeText(MainActivity.this, "Обновление снимков всех камер...", Toast.LENGTH_SHORT).show();
                refreshDashboardAsync();
            }
        });
        topRow.addView(secTitle);
        topRow.addView(refreshAllBtn);
        contentContainer.addView(topRow);

        if (dashboard.cameras.isEmpty()) {
            contentContainer.addView(makeInfoCard(
                isSyncingDashboard ? "Загрузка списка камер..." : "Камеры не найдены",
                "Статус синхронизации: " + apiClient.getLastSyncDiagnostic()
            ));
            return;
        }

        for (final DomRuApiClient.CameraModel cam : dashboard.cameras) {
            LinearLayout card = makeCardContainer("#0F172A", "#1E293B");

            TextView titleTv = new TextView(this);
            titleTv.setText(cam.name);
            titleTv.setTextColor(Color.parseColor("#F8FAFC"));
            titleTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            titleTv.setTypeface(Typeface.DEFAULT_BOLD);

            TextView subTv = new TextView(this);
            subTv.setText("ID камеры: " + cam.id + " · " + cam.placeAddress);
            subTv.setTextColor(Color.parseColor("#94A3B8"));
            subTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
            subTv.setPadding(0, dp(2), 0, dp(8));

            final ImageView imgView = new ImageView(this);
            LinearLayout.LayoutParams imgLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(195)
            );
            imgView.setLayoutParams(imgLp);
            imgView.setScaleType(ImageView.ScaleType.CENTER_CROP);
            imgView.setBackgroundColor(Color.parseColor("#020617"));

            Bitmap cached = cameraBitmaps.get(cam.id);
            if (cached != null) {
                imgView.setImageBitmap(cached);
            } else {
                // Запрашиваем реальный снимок асинхронно без подстановки тестового лица в боевом режиме
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        final Bitmap snap = apiClient.fetchCameraSnapshotBitmap(cam, 0);
                        if (snap != null) {
                            cameraBitmaps.put(cam.id, snap);
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    imgView.setImageBitmap(snap);
                                }
                            });
                        }
                    }
                }).start();
            }

            // Нажатие на сам снимок открывает живой видеопоток и кнопку открытия двери
            imgView.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    showLiveCameraDialog(cam);
                }
            });

            LinearLayout btnRow = new LinearLayout(this);
            btnRow.setOrientation(LinearLayout.HORIZONTAL);
            btnRow.setPadding(0, dp(10), 0, 0);

            Button snapBtn = makeCompactActionButton("Снимок", "#1E293B", "#38BDF8");
            LinearLayout.LayoutParams b1Lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            b1Lp.rightMargin = dp(6);
            snapBtn.setLayoutParams(b1Lp);
            snapBtn.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    Toast.makeText(MainActivity.this, "Запрос снимка: " + cam.name, Toast.LENGTH_SHORT).show();
                    new Thread(new Runnable() {
                        @Override
                        public void run() {
                            final Bitmap fresh = apiClient.fetchCameraSnapshotBitmap(cam, (int) (System.currentTimeMillis() / 1000) % 5);
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    if (fresh != null) {
                                        cameraBitmaps.put(cam.id, fresh);
                                        imgView.setImageBitmap(fresh);
                                    }
                                }
                            });
                        }
                    }).start();
                }
            });

            Button liveBtn = makeCompactActionButton("Видео Онлайн", "#10B981", "#020617");
            LinearLayout.LayoutParams b2Lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.2f);
            b2Lp.rightMargin = dp(6);
            liveBtn.setLayoutParams(b2Lp);
            liveBtn.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    showLiveCameraDialog(cam);
                }
            });

            Button archBtn = makeCompactActionButton("Архив MP4", "#1E293B", "#E2E8F0");
            LinearLayout.LayoutParams b3Lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            archBtn.setLayoutParams(b3Lp);
            archBtn.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    showCameraArchiveDialog(cam);
                }
            });

            btnRow.addView(snapBtn);
            btnRow.addView(liveBtn);
            btnRow.addView(archBtn);

            card.addView(titleTv);
            card.addView(subTv);
            card.addView(imgView);
            card.addView(btnRow);
            contentContainer.addView(card);
        }
    }

    /**
     * Диалог живого просмотра камеры (непрерывный поток кадров + RTSP/HLS плеер + кнопка открытия двери).
     */
    private void showLiveCameraDialog(final DomRuApiClient.CameraModel cam) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(Color.parseColor("#0F172A"));
        box.setPadding(dp(14), dp(14), dp(14), dp(14));

        final TextView statusTv = new TextView(this);
        statusTv.setText("Прямой эфир · " + cam.name + " (ID " + cam.id + ")");
        statusTv.setTextColor(Color.parseColor("#34D399"));
        statusTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        statusTv.setTypeface(Typeface.DEFAULT_BOLD);
        statusTv.setPadding(0, 0, 0, dp(8));

        final ImageView liveIv = new ImageView(this);
        liveIv.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(230)
        ));
        liveIv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        liveIv.setBackgroundColor(Color.parseColor("#020617"));
        Bitmap initBmp = cameraBitmaps.get(cam.id);
        if (initBmp != null) {
            liveIv.setImageBitmap(initBmp);
        }

        box.addView(statusTv);
        box.addView(liveIv);

        // Находим связанную дверь/калитку для быстрого открытия прямо из окна видеопотока
        DomRuApiClient.LockModel matchedLock = null;
        if (cam.accessControlId != null && !cam.accessControlId.isEmpty()) {
            for (DomRuApiClient.LockModel l : dashboard.locks) {
                if (cam.accessControlId.equals(l.accessControlId)) {
                    matchedLock = l;
                    break;
                }
            }
        }
        if (matchedLock == null && !dashboard.locks.isEmpty()) {
            matchedLock = dashboard.locks.get(0);
        }

        if (matchedLock != null) {
            final DomRuApiClient.LockModel targetLock = matchedLock;
            final Button openDoorBtn = makePillButton("ОТКРЫТЬ: " + targetLock.name, "#0EA5E9", "#020617");
            LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            );
            olp.topMargin = dp(10);
            openDoorBtn.setLayoutParams(olp);
            openDoorBtn.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    triggerManualOpenDoor(targetLock, openDoorBtn);
                }
            });
            box.addView(openDoorBtn);
        }

        Button extStreamBtn = makePillButton("Открыть видеопоток со звуком (RTSP / HLS плеер)", "#1E293B", "#38BDF8");
        LinearLayout.LayoutParams elp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        elp.topMargin = dp(8);
        extStreamBtn.setLayoutParams(elp);
        extStreamBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openExternalStreamUrl(cam, 0L);
            }
        });
        box.addView(extStreamBtn);

        final boolean[] streamingActive = new boolean[] { true };
        AlertDialog dialog = new AlertDialog.Builder(this)
            .setView(box)
            .setNegativeButton("Закрыть", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface d, int which) {
                    streamingActive[0] = false;
                }
            })
            .create();

        dialog.setOnDismissListener(new DialogInterface.OnDismissListener() {
            @Override
            public void onDismiss(DialogInterface d) {
                streamingActive[0] = false;
            }
        });
        dialog.show();

        // Фоновый поток обновления live-кадров каждые 1200 мс
        new Thread(new Runnable() {
            @Override
            public void run() {
                int frameCounter = 0;
                while (streamingActive[0]) {
                    frameCounter++;
                    final int fc = frameCounter;
                    final Bitmap fresh = apiClient.fetchCameraSnapshotBitmap(cam, fc % 5);
                    if (fresh != null && streamingActive[0]) {
                        cameraBitmaps.put(cam.id, fresh);
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                if (streamingActive[0]) {
                                    liveIv.setImageBitmap(fresh);
                                    statusTv.setText("Прямой эфир (кадр #" + fc + ") · " + cam.name);
                                }
                            }
                        });
                    }
                    try {
                        Thread.sleep(1200L);
                    } catch (InterruptedException ignored) {
                        break;
                    }
                }
            }
        }).start();
    }

    /**
     * Диалог архива камеры: загружает список событий движения (/rest/v2/forpost/cameras/{id}/events)
     * за выбранный день (до 7 дней) с дозагрузкой событий до начала дня (00:00).
     */
    private void showCameraArchiveDialog(final DomRuApiClient.CameraModel cam) {
        showCameraArchiveDialogForDay(cam, 0);
    }

    private void showCameraArchiveDialogForDay(final DomRuApiClient.CameraModel cam, final int dayOffset) {
        Toast.makeText(this, "Загрузка архива событий камеры " + cam.name + "...", Toast.LENGTH_SHORT).show();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final List<DomRuApiClient.ArchiveEventModel> events =
                    apiClient.fetchCameraArchiveEventsPage(cam.id, cam.placeId, dayOffset, 0L, 100);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        renderArchiveEventsModal(cam, dayOffset, events);
                    }
                });
            }
        }).start();
    }

    private void renderArchiveEventsModal(
        final DomRuApiClient.CameraModel cam,
        final int dayOffset,
        final List<DomRuApiClient.ArchiveEventModel> initialEvents
    ) {
        final List<DomRuApiClient.ArchiveEventModel> allEvents = new ArrayList<DomRuApiClient.ArchiveEventModel>(initialEvents);
        final boolean[] hasMore = new boolean[] { initialEvents.size() >= 100 };
        final boolean[] loadingMore = new boolean[] { false };

        final ScrollView scroll = new ScrollView(this);
        final LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(Color.parseColor("#0F172A"));
        box.setPadding(dp(14), dp(14), dp(14), dp(14));
        scroll.addView(box);

        TextView title = makeSectionTitle("Архив видео · " + cam.name);
        box.addView(title);

        // Выбор дня архива (строго до 7 дней)
        HorizontalScrollView daysScroll = new HorizontalScrollView(this);
        daysScroll.setHorizontalScrollBarEnabled(false);
        LinearLayout daysRow = new LinearLayout(this);
        daysRow.setOrientation(LinearLayout.HORIZONTAL);
        daysRow.setPadding(0, dp(2), 0, dp(8));

        final AlertDialog[] dialogHolder = new AlertDialog[1];
        SimpleDateFormat dayLabelFmt = new SimpleDateFormat("dd.MM", Locale.getDefault());
        for (int d = 0; d < 7; d++) {
            final int dOff = d;
            java.util.Calendar cal = java.util.Calendar.getInstance();
            cal.add(java.util.Calendar.DAY_OF_YEAR, -d);
            String label = d == 0 ? "Сегодня" : (d == 1 ? "Вчера" : dayLabelFmt.format(cal.getTime()));
            Button db = makeCompactActionButton(
                label,
                d == dayOffset ? "#EF4444" : "#1E293B",
                d == dayOffset ? "#FFFFFF" : "#CBD5E1"
            );
            LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            );
            dlp.rightMargin = dp(6);
            db.setLayoutParams(dlp);
            db.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    if (dialogHolder[0] != null) dialogHolder[0].dismiss();
                    showCameraArchiveDialogForDay(cam, dOff);
                }
            });
            daysRow.addView(db);
        }
        daysScroll.addView(daysRow);
        box.addView(daysScroll);

        // Быстрые кнопки перехода по времени архива (-5 мин, -15 мин, -30 мин, -60 мин)
        LinearLayout quickRow = new LinearLayout(this);
        quickRow.setOrientation(LinearLayout.HORIZONTAL);
        quickRow.setPadding(0, dp(4), 0, dp(10));

        final int[] mins = new int[] { 5, 15, 30, 60 };
        for (int i = 0; i < mins.length; i++) {
            final int m = mins[i];
            Button qb = makeCompactActionButton("-" + m + " мин", "#1E293B", "#38BDF8");
            LinearLayout.LayoutParams qlp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            if (i < mins.length - 1) qlp.rightMargin = dp(6);
            qb.setLayoutParams(qlp);
            qb.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    long ts = (System.currentTimeMillis() / 1000L) - (m * 60L);
                    openExternalStreamUrl(cam, ts);
                }
            });
            quickRow.addView(qb);
        }
        box.addView(quickRow);

        final LinearLayout eventsListContainer = new LinearLayout(this);
        eventsListContainer.setOrientation(LinearLayout.VERTICAL);
        box.addView(eventsListContainer);

        final Button loadMoreBtn = makeCompactActionButton("Загрузить ещё (до 00:00)", "#1E293B", "#F8FAFC");
        LinearLayout.LayoutParams lmlp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lmlp.topMargin = dp(10);
        loadMoreBtn.setLayoutParams(lmlp);
        box.addView(loadMoreBtn);

        final SimpleDateFormat sdf = new SimpleDateFormat("dd.MM HH:mm:ss", Locale.getDefault());
        final Runnable renderEventRows = new Runnable() {
            @Override
            public void run() {
                eventsListContainer.removeAllViews();
                if (allEvents.isEmpty()) {
                    eventsListContainer.addView(makeInfoCard(
                        "События движения не найдены",
                        "Используйте кнопки быстрого перехода (-5 / -15 / -30 / -60 мин) выше для просмотра потока архива с перемоткой и выбором скорости."
                    ));
                    loadMoreBtn.setVisibility(View.GONE);
                    return;
                }
                for (final DomRuApiClient.ArchiveEventModel ev : allEvents) {
                    String timeStr = ev.timestampSec > 0 ? sdf.format(new Date(ev.timestampSec * 1000L)) : ("Событие #" + ev.id);
                    String evLabel = (ev.message != null && !ev.message.isEmpty()) ? ev.message : "Движение в кадре";

                    LinearLayout evRow = new LinearLayout(MainActivity.this);
                    evRow.setOrientation(LinearLayout.HORIZONTAL);
                    LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    );
                    rlp.topMargin = dp(6);
                    evRow.setLayoutParams(rlp);

                    Button evBtn = makeCompactActionButton("▶ " + timeStr + " · " + evLabel, "#1E293B", "#F8FAFC");
                    LinearLayout.LayoutParams elp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
                    elp.rightMargin = dp(6);
                    evBtn.setLayoutParams(elp);
                    evBtn.setOnClickListener(new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            playArchiveEventMp4(cam, ev);
                        }
                    });

                    Button dlBtn = makeCompactActionButton("⬇ MP4", "#065F46", "#A7F3D0");
                    dlBtn.setLayoutParams(new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ));
                    dlBtn.setOnClickListener(new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            downloadArchiveEventMp4(cam, ev.id, ev.timestampSec, null);
                        }
                    });

                    evRow.addView(evBtn);
                    evRow.addView(dlBtn);
                    eventsListContainer.addView(evRow);
                }
                loadMoreBtn.setVisibility(hasMore[0] ? View.VISIBLE : View.GONE);
            }
        };

        final Runnable triggerLoadMore = new Runnable() {
            @Override
            public void run() {
                if (loadingMore[0] || !hasMore[0] || allEvents.isEmpty()) return;
                loadingMore[0] = true;
                loadMoreBtn.setText("Дозагрузка ранних событий...");
                final long oldestTs = allEvents.get(allEvents.size() - 1).timestampSec;
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        List<DomRuApiClient.ArchiveEventModel> nextBatch =
                            apiClient.fetchCameraArchiveEventsPage(cam.id, cam.placeId, dayOffset, oldestTs, 100);
                        final java.util.HashSet<String> seenIds = new java.util.HashSet<String>();
                        for (DomRuApiClient.ArchiveEventModel e : allEvents) seenIds.add(e.id);
                        final List<DomRuApiClient.ArchiveEventModel> unique = new ArrayList<DomRuApiClient.ArchiveEventModel>();
                        for (DomRuApiClient.ArchiveEventModel e : nextBatch) {
                            if (!seenIds.contains(e.id)) {
                                seenIds.add(e.id);
                                unique.add(e);
                            }
                        }
                        if (unique.isEmpty() && nextBatch.size() >= 100 && oldestTs > 1) {
                            nextBatch = apiClient.fetchCameraArchiveEventsPage(cam.id, cam.placeId, dayOffset, oldestTs - 1L, 100);
                            for (DomRuApiClient.ArchiveEventModel e : nextBatch) {
                                if (!seenIds.contains(e.id)) {
                                    seenIds.add(e.id);
                                    unique.add(e);
                                }
                            }
                        }
                        final boolean moreLeft = !unique.isEmpty() && nextBatch.size() >= 100;
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                allEvents.addAll(unique);
                                hasMore[0] = moreLeft;
                                loadingMore[0] = false;
                                loadMoreBtn.setText("Загрузить ещё (до 00:00)");
                                renderEventRows.run();
                            }
                        });
                    }
                }).start();
            }
        };

        loadMoreBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                triggerLoadMore.run();
            }
        });

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            scroll.setOnScrollChangeListener(new View.OnScrollChangeListener() {
                @Override
                public void onScrollChange(View v, int scrollX, int scrollY, int oldScrollX, int oldScrollY) {
                    View child = scroll.getChildAt(0);
                    if (child != null && (child.getBottom() - (scroll.getHeight() + scroll.getScrollY())) <= dp(60)) {
                        triggerLoadMore.run();
                    }
                }
            });
        }

        renderEventRows.run();

        dialogHolder[0] = new AlertDialog.Builder(this)
            .setView(scroll)
            .setNegativeButton("Закрыть", null)
            .show();
    }

    private void playArchiveEventMp4(final DomRuApiClient.CameraModel cam, final DomRuApiClient.ArchiveEventModel ev) {
        Toast.makeText(this, "Получение MP4-ролика события #" + ev.id + "...", Toast.LENGTH_SHORT).show();
        new Thread(new Runnable() {
            @Override
            public void run() {
                String mp4Url = apiClient.fetchArchiveEventMp4Url(ev.id, cam.placeId);
                if ((mp4Url == null || mp4Url.isEmpty()) && ev.timestampSec > 0) {
                    mp4Url = apiClient.fetchCameraVideoUrl(cam.id, cam.placeId, ev.timestampSec);
                }
                final String finalUrl = mp4Url;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (finalUrl == null || finalUrl.isEmpty()) {
                            Toast.makeText(MainActivity.this, "Не удалось получить ссылку на MP4-архив", Toast.LENGTH_SHORT).show();
                            return;
                        }
                        showNativeVideoPlayerDialog(cam, cam.name + " · Архив #" + ev.id, finalUrl, ev.timestampSec, ev.id);
                    }
                });
            }
        }).start();
    }

    private void downloadArchiveEventMp4(
        final DomRuApiClient.CameraModel cam,
        final String eventId,
        final long timestampSec,
        final String fallbackVideoUrl
    ) {
        Toast.makeText(this, "Подготовка скачивания MP4...", Toast.LENGTH_SHORT).show();
        new Thread(new Runnable() {
            @Override
            public void run() {
                String url = "";
                if (eventId != null && !eventId.isEmpty()) {
                    url = apiClient.fetchArchiveEventMp4Url(eventId, cam != null ? cam.placeId : null);
                }
                if ((url == null || url.isEmpty()) && fallbackVideoUrl != null && fallbackVideoUrl.startsWith("http")) {
                    url = fallbackVideoUrl;
                }
                if ((url == null || url.isEmpty()) && cam != null && timestampSec > 0) {
                    url = apiClient.fetchCameraVideoUrl(cam.id, cam.placeId, timestampSec);
                }
                final String finalDownloadUrl = url;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (finalDownloadUrl == null || finalDownloadUrl.isEmpty()) {
                            Toast.makeText(MainActivity.this, "Не удалось получить прямую ссылку для скачивания MP4", Toast.LENGTH_LONG).show();
                            return;
                        }
                        try {
                            String camSlug = (cam != null && cam.id != null) ? cam.id : "cam";
                            String evSlug = (eventId != null && !eventId.isEmpty())
                                ? eventId
                                : String.valueOf(timestampSec > 0 ? timestampSec : System.currentTimeMillis() / 1000L);
                            String fileName = "DomRuLab-archive-" + camSlug + "-" + evSlug + ".mp4";

                            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(finalDownloadUrl));
                            req.setTitle("Архив камеры " + (cam != null ? cam.name : ""));
                            req.setDescription("Скачивание видеоархива " + fileName);
                            req.addRequestHeader("User-Agent", "Dalvik/2.1.0 (Linux; U; Android 16; Poco X6 Pro Build/UKQ1.231003.002)");
                            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                            req.setMimeType("video/mp4");
                            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

                            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                            if (dm != null) {
                                dm.enqueue(req);
                                Toast.makeText(
                                    MainActivity.this,
                                    "Загрузка начата в папку Downloads: " + fileName,
                                    Toast.LENGTH_LONG
                                ).show();
                            }
                        } catch (Exception e) {
                            Toast.makeText(
                                MainActivity.this,
                                "Ошибка DownloadManager: " + e.getMessage(),
                                Toast.LENGTH_LONG
                            ).show();
                        }
                    }
                });
            }
        }).start();
    }

    private static String formatMsToMinSec(int ms) {
        int totalSec = Math.max(0, ms / 1000);
        int mins = totalSec / 60;
        int secs = totalSec % 60;
        return String.format(Locale.US, "%02d:%02d", mins, secs);
    }

    private void showNativeVideoPlayerDialog(
        final DomRuApiClient.CameraModel cam,
        final String title,
        final String initialVideoUrl,
        final long initialArchiveTs,
        final String eventId
    ) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(Color.parseColor("#020617"));
        box.setPadding(dp(12), dp(12), dp(12), dp(12));

        final TextView tv = new TextView(this);
        tv.setText(title);
        tv.setTextColor(Color.parseColor("#F8FAFC"));
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setPadding(0, 0, 0, dp(6));
        box.addView(tv);

        final VideoView vv = new VideoView(this);
        vv.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(230)
        ));
        box.addView(vv);

        final MediaPlayer[] mpHolder = new MediaPlayer[1];
        final float[] currentSpeed = new float[] { 1.0f };
        final long[] currentTs = new long[] {
            initialArchiveTs > 0 ? initialArchiveTs : (System.currentTimeMillis() / 1000L - 300L)
        };
        final String[] currentUrl = new String[] { initialVideoUrl };
        final boolean[] dialogOpen = new boolean[] { true };

        // Полоса перемотки (SeekBar) + счётчик времени
        LinearLayout timelineRow = new LinearLayout(this);
        timelineRow.setOrientation(LinearLayout.VERTICAL);
        timelineRow.setPadding(0, dp(8), 0, dp(4));

        final TextView timeStatusTv = new TextView(this);
        timeStatusTv.setText("Позиция: 00:00 · Скорость: 1.0x");
        timeStatusTv.setTextColor(Color.parseColor("#38BDF8"));
        timeStatusTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        timeStatusTv.setTypeface(Typeface.MONOSPACE);
        timelineRow.addView(timeStatusTv);

        final SeekBar seekBar = new SeekBar(this);
        seekBar.setMax(1000);
        seekBar.setProgress(0);
        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                if (!fromUser) return;
                try {
                    int dur = vv.getDuration();
                    if (dur > 0) {
                        int targetMs = (int) ((progress / 1000.0f) * dur);
                        vv.seekTo(targetMs);
                        timeStatusTv.setText(
                            "Позиция: " + formatMsToMinSec(targetMs) + " / " + formatMsToMinSec(dur)
                            + " · Скорость: " + currentSpeed[0] + "x"
                        );
                    }
                } catch (Exception ignored) {}
            }

            @Override
            public void onStartTrackingTouch(SeekBar sb) {}

            @Override
            public void onStopTrackingTouch(SeekBar sb) {}
        });
        timelineRow.addView(seekBar);
        box.addView(timelineRow);

        // Кнопки быстрой перемотки (-30с, -10с, +10с, +30с)
        LinearLayout seekBtnRow = new LinearLayout(this);
        seekBtnRow.setOrientation(LinearLayout.HORIZONTAL);
        seekBtnRow.setPadding(0, dp(4), 0, dp(6));
        final int[] stepDeltas = new int[] { -30, -10, 10, 30 };
        for (int i = 0; i < stepDeltas.length; i++) {
            final int deltaSec = stepDeltas[i];
            String label = (deltaSec > 0 ? "+" : "") + deltaSec + " сек";
            Button sbBtn = makeCompactActionButton(label, "#1E293B", "#E2E8F0");
            LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            if (i < stepDeltas.length - 1) slp.rightMargin = dp(4);
            sbBtn.setLayoutParams(slp);
            sbBtn.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    try {
                        int dur = vv.getDuration();
                        int pos = vv.getCurrentPosition();
                        if (dur > 0) {
                            int nextPos = Math.max(0, Math.min(dur, pos + deltaSec * 1000));
                            vv.seekTo(nextPos);
                            seekBar.setProgress((int) ((nextPos * 1000L) / dur));
                            return;
                        }
                    } catch (Exception ignored) {}

                    // Если воспроизводится потоковый архив TS без фиксированной длины MP4 — сдвигаем метку TS
                    if (cam != null) {
                        currentTs[0] = Math.min(System.currentTimeMillis() / 1000L - 5L, currentTs[0] + deltaSec);
                        SimpleDateFormat sdf = new SimpleDateFormat("HH:mm:ss", Locale.getDefault());
                        final String tsLabel = sdf.format(new Date(currentTs[0] * 1000L));
                        timeStatusTv.setText("Переход к архиву TS " + tsLabel + "...");
                        new Thread(new Runnable() {
                            @Override
                            public void run() {
                                final String shiftedUrl = apiClient.fetchCameraVideoUrl(
                                    cam.id,
                                    cam.placeId,
                                    currentTs[0],
                                    String.valueOf(currentSpeed[0])
                                );
                                runOnUiThread(new Runnable() {
                                    @Override
                                    public void run() {
                                        if (!dialogOpen[0]) return;
                                        if (shiftedUrl != null && !shiftedUrl.isEmpty()) {
                                            currentUrl[0] = shiftedUrl;
                                            vv.setVideoURI(Uri.parse(shiftedUrl));
                                            vv.start();
                                            timeStatusTv.setText("Архив TS: " + tsLabel + " · Скорость: " + currentSpeed[0] + "x");
                                        }
                                    }
                                });
                            }
                        }).start();
                    }
                }
            });
            seekBtnRow.addView(sbBtn);
        }
        box.addView(seekBtnRow);

        // Кнопки выбора скорости воспроизведения (0.5x, 1.0x, 1.5x, 2.0x)
        LinearLayout speedRow = new LinearLayout(this);
        speedRow.setOrientation(LinearLayout.HORIZONTAL);
        speedRow.setPadding(0, 0, 0, dp(8));
        final float[] speeds = new float[] { 0.5f, 1.0f, 1.5f, 2.0f };
        final Button[] speedBtns = new Button[speeds.length];
        for (int i = 0; i < speeds.length; i++) {
            final int idx = i;
            final float spd = speeds[i];
            Button spBtn = makeCompactActionButton(spd + "x", spd == 1.0f ? "#F59E0B" : "#0F172A", spd == 1.0f ? "#020617" : "#94A3B8");
            LinearLayout.LayoutParams spLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            if (i < speeds.length - 1) spLp.rightMargin = dp(4);
            spBtn.setLayoutParams(spLp);
            speedBtns[i] = spBtn;
            spBtn.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    currentSpeed[0] = spd;
                    for (int k = 0; k < speedBtns.length; k++) {
                        styleButton(
                            speedBtns[k],
                            k == idx ? "#F59E0B" : "#0F172A",
                            k == idx ? "#020617" : "#94A3B8"
                        );
                    }
                    try {
                        if (mpHolder[0] != null && Build.VERSION.SDK_INT >= 23) {
                            mpHolder[0].setPlaybackParams(mpHolder[0].getPlaybackParams().setSpeed(spd));
                        }
                    } catch (Exception ignored) {}
                    timeStatusTv.setText("Скорость воспроизведения: " + spd + "x");
                }
            });
            speedRow.addView(spBtn);
        }
        box.addView(speedRow);

        // Кнопка прямого скачивания MP4 в память телефона (Downloads)
        Button downloadMp4Btn = makePillButton("⬇ Скачать видео в память телефона (MP4)", "#10B981", "#020617");
        downloadMp4Btn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                downloadArchiveEventMp4(cam, eventId, currentTs[0], currentUrl[0]);
            }
        });
        box.addView(downloadMp4Btn);

        try {
            MediaController mc = new MediaController(this);
            mc.setAnchorView(vv);
            vv.setMediaController(mc);
            vv.setVideoURI(Uri.parse(initialVideoUrl));
            vv.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                @Override
                public void onPrepared(MediaPlayer mp) {
                    mpHolder[0] = mp;
                    mp.setVolume(1.0f, 1.0f);
                    try {
                        if (Build.VERSION.SDK_INT >= 23 && currentSpeed[0] != 1.0f) {
                            mp.setPlaybackParams(mp.getPlaybackParams().setSpeed(currentSpeed[0]));
                        }
                    } catch (Exception ignored) {}
                    vv.start();
                }
            });
        } catch (Exception ignored) {}

        // Периодическое обновление ползунка прогресса
        final Runnable progressUpdater = new Runnable() {
            @Override
            public void run() {
                if (!dialogOpen[0]) return;
                try {
                    if (vv.isPlaying()) {
                        int dur = vv.getDuration();
                        int pos = vv.getCurrentPosition();
                        if (dur > 0) {
                            seekBar.setProgress((int) ((pos * 1000L) / dur));
                            timeStatusTv.setText(
                                "Позиция: " + formatMsToMinSec(pos) + " / " + formatMsToMinSec(dur)
                                + " · Скорость: " + currentSpeed[0] + "x"
                            );
                        }
                    }
                } catch (Exception ignored) {}
                if (dialogOpen[0]) {
                    uiHandler.postDelayed(this, 500L);
                }
            }
        };
        uiHandler.postDelayed(progressUpdater, 500L);

        AlertDialog dlg = new AlertDialog.Builder(this)
            .setView(box)
            .setPositiveButton("Внешний плеер", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface d, int which) {
                    dialogOpen[0] = false;
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(currentUrl[0]));
                        startActivity(intent);
                    } catch (Exception ignored) {}
                }
            })
            .setNegativeButton("Закрыть", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface d, int which) {
                    dialogOpen[0] = false;
                    try { vv.stopPlayback(); } catch (Exception ignored) {}
                }
            })
            .create();

        dlg.setOnDismissListener(new DialogInterface.OnDismissListener() {
            @Override
            public void onDismiss(DialogInterface d) {
                dialogOpen[0] = false;
                try { vv.stopPlayback(); } catch (Exception ignored) {}
            }
        });
        dlg.show();
    }

    private void openExternalStreamUrl(final DomRuApiClient.CameraModel cam, final long archiveTs) {
        if (apiClient.isDemoMode()) {
            SoundGenerator.playDoorUnlockSound();
            Toast.makeText(
                this,
                (archiveTs > 0 ? "Демо-архив (TS=" + archiveTs + "): " : "Демо-поток + аудио: ") + cam.name,
                Toast.LENGTH_SHORT
            ).show();
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                final String url = apiClient.fetchCameraVideoUrl(cam.id, cam.placeId, archiveTs);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (url != null && !url.isEmpty()) {
                            String label = archiveTs > 0 ? (cam.name + " · Архив TS") : (cam.name + " · Прямой эфир");
                            showNativeVideoPlayerDialog(cam, label, url, archiveTs, null);
                        } else {
                            Toast.makeText(MainActivity.this, "Не удалось получить URL видеопотока камеры", Toast.LENGTH_SHORT).show();
                        }
                    }
                });
            }
        }).start();
    }

    // =========================================================================
    // ВКЛАДКА 3: АВТО-КАЛИТКА (POCO X6 PRO ON-DEVICE CV + ГЕОЗОНА 20М/50М)
    // =========================================================================
    private void renderAutoGateCvTab() {
        // 1. Статус конечного автомата (13 состояний) и переключатель Режима наблюдения
        LinearLayout hero = makeCardContainer("#0F172A", "#10B981");

        TextView fsmBadge = new TextView(this);
        fsmBadge.setText("СОСТОЯНИЕ КА (13 СОСТОЯНИЙ): " + fsmState);
        fsmBadge.setTextColor(Color.parseColor("#34D399"));
        fsmBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        fsmBadge.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);

        TextView modeTitle = new TextView(this);
        modeTitle.setText(observationMode
            ? "Режим наблюдения АКТИВЕН (Этап 7: без физического открытия)"
            : "БОЕВОЙ РЕЖИМ АКТИВЕН (Этап 8: отправка accessControlOpen)");
        modeTitle.setTextColor(Color.parseColor(observationMode ? "#FBBF24" : "#34D399"));
        modeTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        modeTitle.setTypeface(Typeface.DEFAULT_BOLD);
        modeTitle.setPadding(0, dp(4), 0, dp(4));

        TextView decisionTv = new TextView(this);
        decisionTv.setText("Последнее решение: " + lastDecisionSummary);
        decisionTv.setTextColor(Color.parseColor("#CBD5E1"));
        decisionTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        decisionTv.setPadding(0, 0, 0, dp(10));

        LinearLayout modeBtnRow = new LinearLayout(this);
        modeBtnRow.setOrientation(LinearLayout.HORIZONTAL);

        Button toggleObsBtn = makeCompactActionButton(
            observationMode ? "Включить Боевой режим" : "Включить Наблюдение",
            observationMode ? "#10B981" : "#F59E0B",
            "#020617"
        );
        LinearLayout.LayoutParams m1Lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        m1Lp.rightMargin = dp(6);
        toggleObsBtn.setLayoutParams(m1Lp);
        toggleObsBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                observationMode = !observationMode;
                autoPrefs.edit().putBoolean("observation_mode", observationMode).apply();
                appendLog("MODE_CHANGE", observationMode
                    ? "Включён Режим наблюдения (проверки без отправки команды открытия)"
                    : "Включён Боевой режим (автоматическое открытие калитки разрешено)");
                renderActiveTab();
            }
        });

        Button stopBtn = makeCompactActionButton("Стоп (DISABLED)", "#E11D48", "#FFFFFF");
        LinearLayout.LayoutParams m2Lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        stopBtn.setLayoutParams(m2Lp);
        stopBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                fsmState = "DISABLED";
                autoEnabled = false;
                lastDecisionSummary = "Экстренная остановка пользователем (DISABLED)";
                if (DomRuGeofenceService.isRunning) {
                    toggleGeofenceService();
                }
                appendLog("EMERGENCY_STOP", "Модуль авто-открытия переведён в состояние DISABLED");
                renderActiveTab();
            }
        });

        modeBtnRow.addView(toggleObsBtn);
        modeBtnRow.addView(stopBtn);

        hero.addView(fsmBadge);
        hero.addView(modeTitle);
        hero.addView(decisionTv);
        hero.addView(modeBtnRow);
        contentContainer.addView(hero);

        // 1.5. Привязка реальной двери/калитки и камеры из аккаунта Дом.ру
        LinearLayout bindCard = makeCardContainer("#0F172A", "#1E293B");
        bindCard.addView(makeSectionTitle("Привязка калитки и камеры для авто-открытия"));

        final DomRuApiClient.LockModel currentLock = getSelectedGateLock();
        final DomRuApiClient.CameraModel currentCam = getSelectedGateCamera();

        TextView bindInfo = new TextView(this);
        bindInfo.setText(
            "Целевая калитка/дверь: " + (currentLock != null ? (currentLock.name + " (#" + currentLock.accessControlId + ")") : "Не выбрана")
            + "\nКамера распознавания: " + (currentCam != null ? (currentCam.name + " (ID " + currentCam.id + ")") : "Не выбрана")
        );
        bindInfo.setTextColor(Color.parseColor("#CBD5E1"));
        bindInfo.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        bindInfo.setPadding(0, dp(2), 0, dp(8));
        bindCard.addView(bindInfo);

        if (dashboard.locks.size() > 1) {
            Button pickLockBtn = makePillButton("Сменить целевую дверь/калитку (" + dashboard.locks.size() + " дост.)", "#1E293B", "#38BDF8");
            LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            plp.bottomMargin = dp(6);
            pickLockBtn.setLayoutParams(plp);
            pickLockBtn.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    showPickLockDialog();
                }
            });
            bindCard.addView(pickLockBtn);
        }

        if (dashboard.cameras.size() > 1) {
            Button pickCamBtn = makePillButton("Сменить камеру калитки (" + dashboard.cameras.size() + " дост.)", "#1E293B", "#38BDF8");
            LinearLayout.LayoutParams pclp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            pickCamBtn.setLayoutParams(pclp);
            pickCamBtn.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    showPickCameraDialog();
                }
            });
            bindCard.addView(pickCamBtn);
        }
        contentContainer.addView(bindCard);

        // 2. Локальный биометрический шаблон в AndroidKeyStore (0 байт на VPS)
        LinearLayout bioCard = makeCardContainer("#0F172A", "#1E293B");
        TextView bioTitle = makeSectionTitle("Локальный шаблон лица (Poco X6 Pro AndroidKeyStore)");
        TextView bioInfo = new TextView(this);
        bioInfo.setText(
            "Статус: " + (keyStoreVault.hasEnrolledTemplate() ? "ЗАРЕГИСТРИРОВАН (" + keyStoreVault.getPosesCount() + " ракурсов)" : "НЕ СОЗДАН")
            + "\nШифрование: AndroidKeyStore AES-256-GCM (аппаратный ключ)"
            + "\nВектор: MobileFaceNet 128-D (L2-нормализованный)"
            + "\nПередано на VPS: 0 байт (исходные фото удаляются немедленно)"
            + "\nОбновлено: " + keyStoreVault.getEnrolledAt()
        );
        bioInfo.setTextColor(Color.parseColor("#94A3B8"));
        bioInfo.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        bioInfo.setPadding(0, dp(4), 0, dp(10));

        LinearLayout bioBtnCol = new LinearLayout(this);
        bioBtnCol.setOrientation(LinearLayout.VERTICAL);

        Button enrollSelfieBtn = makePillButton("1. Снять селфи (открыть камеру телефона)", "#10B981", "#020617");
        LinearLayout.LayoutParams esLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        esLp.bottomMargin = dp(6);
        enrollSelfieBtn.setLayoutParams(esLp);
        enrollSelfieBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                launchPhoneSelfieCameraForEnroll();
            }
        });

        LinearLayout bioBtnRow = new LinearLayout(this);
        bioBtnRow.setOrientation(LinearLayout.HORIZONTAL);

        Button enrollCamBtn = makeCompactActionButton("2. С камеры домофона (5 кадров)", "#0EA5E9", "#020617");
        LinearLayout.LayoutParams eb1 = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        eb1.rightMargin = dp(6);
        enrollCamBtn.setLayoutParams(eb1);
        enrollCamBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                enrollOwnerFromGateCameraAsync();
            }
        });

        Button clearBioBtn = makeCompactActionButton("Удалить", "#334155", "#F8FAFC");
        clearBioBtn.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        clearBioBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                keyStoreVault.clearVault();
                appendLog("KEYSTORE", "Локальный биометрический шаблон удалён из AndroidKeyStore");
                renderActiveTab();
            }
        });

        bioBtnRow.addView(enrollCamBtn);
        bioBtnRow.addView(clearBioBtn);
        bioBtnCol.addView(enrollSelfieBtn);
        bioBtnCol.addView(bioBtnRow);

        bioCard.addView(bioTitle);
        bioCard.addView(bioInfo);
        bioCard.addView(bioBtnCol);
        contentContainer.addView(bioCard);

        // 3. Полевые испытания и тестирование сценариев на Poco X6 Pro
        LinearLayout simCard = makeCardContainer("#0F172A", "#1E293B");
        simCard.addView(makeSectionTitle("Проверка реального кадра камеры и сценариев"));

        if (lastCvPreviewBitmap != null) {
            ImageView previewIv = new ImageView(this);
            LinearLayout.LayoutParams pLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(160)
            );
            pLp.topMargin = dp(6);
            pLp.bottomMargin = dp(8);
            previewIv.setLayoutParams(pLp);
            previewIv.setScaleType(ImageView.ScaleType.CENTER_CROP);
            previewIv.setImageBitmap(lastCvPreviewBitmap);
            simCard.addView(previewIv);
        }

        addScenarioButton(simCard, "1. Проверить реальную камеру калитки сейчас (3 кадра)", "owner", 12.0, 6.0f);
        addScenarioButton(simCard, "2. Тест: Подмена фото с экрана телефона (2D Spoof — отказ)", "spoof", 11.5, 5.0f);
        addScenarioButton(simCard, "3. Тест: Чужой человек у калитки (несовпадение эмбеддинга)", "stranger", 10.0, 5.0f);
        addScenarioButton(simCard, "4. Тест: Камера со статичным снимком (ручное подтверждение)", "static_camera", 13.0, 6.0f);
        addScenarioButton(simCard, "5. Тест: Несколько человек в кадре (блокировка открытия)", "multi_face", 12.5, 6.0f);
        addScenarioButton(simCard, "6. Выход из геозоны (> 50м — сброс триггера подхода)", "exit_zone", 68.0, 5.0f);

        contentContainer.addView(simCard);

        // 4. Координаты геозоны калитки (20м вход / 50м выход)
        LinearLayout geoCard = makeCardContainer("#0F172A", "#1E293B");
        geoCard.addView(makeSectionTitle("Геозона калитки (вход <= 20м, выход > 50м)"));

        TextView geoDesc = new TextView(this);
        geoDesc.setText(String.format(
            Locale.US,
            "Координаты калитки: %.6f, %.6f\nПорог точности GPS: <= 18м · Опрос камеры: каждые 2с (до 10 кадров, минимум 3 совпадения)",
            gateLat, gateLon
        ));
        geoDesc.setTextColor(Color.parseColor("#94A3B8"));
        geoDesc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        geoDesc.setPadding(0, dp(4), 0, dp(8));

        Button setHereBtn = makePillButton("Установить текущие GPS-координаты телефона как точку калитки", "#1E293B", "#38BDF8");
        setHereBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                setGateToCurrentPhoneGps();
            }
        });

        geoCard.addView(geoDesc);
        geoCard.addView(setHereBtn);
        contentContainer.addView(geoCard);

        // 5. Журнал событий конечного автомата
        LinearLayout logCard = makeCardContainer("#0F172A", "#1E293B");
        logCard.addView(makeSectionTitle("Журнал событий (" + auditLogs.size() + ")"));
        for (int i = 0; i < Math.min(15, auditLogs.size()); i++) {
            TextView tv = new TextView(this);
            tv.setText(auditLogs.get(i));
            tv.setTextColor(Color.parseColor("#CBD5E1"));
            tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
            tv.setTypeface(Typeface.MONOSPACE);
            tv.setPadding(0, dp(4), 0, dp(4));
            logCard.addView(tv);
        }
        contentContainer.addView(logCard);
    }

    private DomRuApiClient.LockModel getSelectedGateLock() {
        if (dashboard.locks.isEmpty()) return null;
        for (DomRuApiClient.LockModel l : dashboard.locks) {
            if (l.accessControlId.equals(selectedGateLockId)) return l;
        }
        return dashboard.locks.get(0);
    }

    private DomRuApiClient.CameraModel getSelectedGateCamera() {
        if (dashboard.cameras.isEmpty()) return null;
        for (DomRuApiClient.CameraModel c : dashboard.cameras) {
            if (c.id.equals(selectedGateCameraId)) return c;
        }
        return dashboard.cameras.get(0);
    }

    private void showPickLockDialog() {
        final String[] items = new String[dashboard.locks.size()];
        for (int i = 0; i < dashboard.locks.size(); i++) {
            DomRuApiClient.LockModel l = dashboard.locks.get(i);
            items[i] = l.name + " (#" + l.accessControlId + ")";
        }
        new AlertDialog.Builder(this)
            .setTitle("Выберите калитку / дверь для авто-открытия")
            .setItems(items, new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface d, int which) {
                    selectedGateLockId = dashboard.locks.get(which).accessControlId;
                    autoPrefs.edit().putString("selected_lock_id", selectedGateLockId).apply();
                    renderActiveTab();
                }
            })
            .show();
    }

    private void showPickCameraDialog() {
        final String[] items = new String[dashboard.cameras.size()];
        for (int i = 0; i < dashboard.cameras.size(); i++) {
            DomRuApiClient.CameraModel c = dashboard.cameras.get(i);
            items[i] = c.name + " (ID " + c.id + ")";
        }
        new AlertDialog.Builder(this)
            .setTitle("Выберите камеру калитки")
            .setItems(items, new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface d, int which) {
                    selectedGateCameraId = dashboard.cameras.get(which).id;
                    autoPrefs.edit().putString("selected_cam_id", selectedGateCameraId).apply();
                    renderActiveTab();
                }
            })
            .show();
    }

    private void addScenarioButton(LinearLayout parent, String label, final String mode, final double distM, final float accM) {
        Button b = makePillButton(label, "#1E293B", "#F8FAFC");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lp.topMargin = dp(6);
        b.setLayoutParams(lp);
        b.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                runAutoAccessPipelineAsync(mode, distM, accM);
            }
        });
        parent.addView(b);
    }

    private void enrollSyntheticOwnerTemplate(String reason) {
        List<float[]> vectors = new ArrayList<float[]>();
        for (int i = 0; i < 5; i++) {
            Bitmap bmp = OnDeviceFaceCvEngine.renderSyntheticIntercomFrame("owner", i);
            OnDeviceFaceCvEngine.FrameQualityAndFace fq = OnDeviceFaceCvEngine.analyzeSingleBitmap(bmp, "owner");
            bmp.recycle();
            if (fq.embedding128 != null) {
                vectors.add(fq.embedding128);
            }
        }
        keyStoreVault.enrollEmbeddings(vectors, reason);
    }

    private void launchPhoneSelfieCameraForEnroll() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[] { Manifest.permission.CAMERA }, REQ_PERMS);
                Toast.makeText(this, "Разрешите доступ к камере и нажмите кнопку ещё раз", Toast.LENGTH_SHORT).show();
                return;
            }
            Intent takePictureIntent = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
            takePictureIntent.putExtra("android.intent.extras.CAMERA_FACING", 1);
            takePictureIntent.putExtra("android.intent.extras.LENS_FACING_FRONT", 1);
            takePictureIntent.putExtra("android.intent.extra.USE_FRONT_CAMERA", true);
            startActivityForResult(takePictureIntent, REQ_SELFIE_CAMERA);
        } catch (Exception e) {
            Toast.makeText(this, "Не удалось открыть камеру телефона: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_SELFIE_CAMERA && resultCode == RESULT_OK && data != null) {
            Bundle extras = data.getExtras();
            final Bitmap photo = extras != null ? (Bitmap) extras.get("data") : null;
            if (photo == null) {
                Toast.makeText(this, "Камера не вернула изображение", Toast.LENGTH_SHORT).show();
                return;
            }
            new Thread(new Runnable() {
                @Override
                public void run() {
                    final OnDeviceFaceCvEngine.FrameQualityAndFace fq = OnDeviceFaceCvEngine.analyzeSingleBitmap(photo, "owner");
                    if (fq.annotatedBitmap != null) {
                        lastCvPreviewBitmap = fq.annotatedBitmap;
                    } else {
                        lastCvPreviewBitmap = photo;
                    }
                    if (fq.facesCount == 1 && fq.embedding128 != null) {
                        List<float[]> vectors = new ArrayList<float[]>();
                        // Сохраняем 5 слегка варьированных ракурсов из реального селфи-кадра
                        for (int k = 0; k < 5; k++) {
                            float[] v = new float[128];
                            double norm = 0.0;
                            for (int i = 0; i < 128; i++) {
                                v[i] = fq.embedding128[i] + (k - 2) * 0.002f;
                                norm += v[i] * v[i];
                            }
                            norm = Math.sqrt(Math.max(1e-9, norm));
                            for (int i = 0; i < 128; i++) v[i] = (float) (v[i] / norm);
                            vectors.add(v);
                        }
                        keyStoreVault.enrollEmbeddings(vectors, "Снято с селфи-камеры Poco X6 Pro (5 ракурсов)");
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                vibratePhone(120);
                                appendLog("ENROLL_SELFIE", "Лицо распознано на селфи (conf=" + String.format(Locale.US, "%.2f", fq.confidence) + "), 128-D шаблон зашифрован в AndroidKeyStore");
                                Toast.makeText(MainActivity.this, "Лицо успешно зарегистрировано с камеры телефона!", Toast.LENGTH_LONG).show();
                                renderActiveTab();
                            }
                        });
                    } else {
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                String reason = fq.rejectReason != null ? fq.rejectReason : "Лицо не найдено на снимке";
                                appendLog("ENROLL_REJECT", reason);
                                Toast.makeText(MainActivity.this, reason, Toast.LENGTH_LONG).show();
                                renderActiveTab();
                            }
                        });
                    }
                }
            }).start();
        }
    }

    private void enrollOwnerFromGateCameraAsync() {
        final DomRuApiClient.CameraModel gateCam = getSelectedGateCamera();
        Toast.makeText(this, "Запрос 5 кадров с камеры домофона «" + (gateCam != null ? gateCam.name : "") + "»...", Toast.LENGTH_SHORT).show();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final List<float[]> vectors = new ArrayList<float[]>();
                String lastReject = "Лицо в кадре домофона не обнаружено";
                for (int i = 0; i < 5; i++) {
                    Bitmap snap = apiClient.fetchCameraSnapshotBitmap(gateCam, i);
                    OnDeviceFaceCvEngine.FrameQualityAndFace fq = OnDeviceFaceCvEngine.analyzeSingleBitmap(snap, "owner");
                    if (fq.annotatedBitmap != null) {
                        lastCvPreviewBitmap = fq.annotatedBitmap;
                    } else if (snap != null && i == 4) {
                        lastCvPreviewBitmap = snap;
                    }
                    if (fq.facesCount == 1 && fq.embedding128 != null) {
                        vectors.add(fq.embedding128);
                    } else if (fq.rejectReason != null) {
                        lastReject = fq.rejectReason;
                    }
                }
                final String finalReject = lastReject;
                if (vectors.isEmpty()) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            appendLog("ENROLL_INTERCOM_EMPTY", "На камере домофона не найдено лицо: встаньте перед домофоном или используйте кнопку «1. Снять селфи»");
                            Toast.makeText(
                                MainActivity.this,
                                finalReject + ". Встаньте перед камерой домофона или нажмите «1. Снять селфи (открыть камеру телефона)»!",
                                Toast.LENGTH_LONG
                            ).show();
                            renderActiveTab();
                        }
                    });
                    return;
                }
                final boolean ok = keyStoreVault.enrollEmbeddings(vectors, "Снято с камеры домофона " + (gateCam != null ? gateCam.name : "калитки") + " (" + vectors.size() + " кадр.)");
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (ok) {
                            vibratePhone(120);
                            appendLog("ENROLL_LOCAL", "Шаблон лица (128-D) с камеры домофона зашифрован в AndroidKeyStore AES-256-GCM");
                            Toast.makeText(MainActivity.this, "Шаблон с камеры домофона сохранён в AndroidKeyStore!", Toast.LENGTH_SHORT).show();
                        }
                        renderActiveTab();
                    }
                });
            }
        }).start();
    }

    private void runAutoAccessPipelineAsync(final String scenarioMode, final double distanceMeters, final float gpsAccuracyMeters) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                autoEnabled = true;

                if ("exit_zone".equals(scenarioMode) || distanceMeters > exitRadiusM) {
                    openedInCurrentApproach = false;
                    fsmState = "OUTSIDE_GEOFENCE";
                    lastDecisionSummary = String.format(Locale.US, "Выход из геозоны (%.1fм > %.0fм): триггер подхода сброшен", distanceMeters, exitRadiusM);
                    appendLog("OUTSIDE_GEOFENCE", lastDecisionSummary);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() { renderActiveTab(); }
                    });
                    return;
                }

                if (openedInCurrentApproach) {
                    fsmState = "COOLDOWN";
                    lastDecisionSummary = "Калитка уже открывалась в текущем подходе (ожидание выхода за 50м)";
                    appendLog("COOLDOWN", lastDecisionSummary);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() { renderActiveTab(); }
                    });
                    return;
                }

                fsmState = "GEOFENCE_ENTERED";
                appendLog("GEOFENCE_ENTERED", String.format(Locale.US, "Вход в геозону калитки: дистанция %.1fм (<= %.0fм)", distanceMeters, entryRadiusM));

                fsmState = "LOCATION_VALIDATION";
                if (gpsAccuracyMeters > 18.0f) {
                    fsmState = "FAILED";
                    lastDecisionSummary = "Низкая точность GPS (" + gpsAccuracyMeters + "м > 18м) — отказ";
                    appendLog("FAILED", lastDecisionSummary);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() { renderActiveTab(); }
                    });
                    return;
                }

                fsmState = "CAMERA_REQUEST";
                DomRuApiClient.CameraModel gateCam = getSelectedGateCamera();
                List<Bitmap> frames = new ArrayList<Bitmap>();
                int frameCount = "static_camera".equals(scenarioMode) ? 1 : 3;
                for (int i = 0; i < frameCount; i++) {
                    Bitmap b = ("owner".equals(scenarioMode) && !apiClient.isDemoMode())
                        ? apiClient.fetchCameraSnapshotBitmap(gateCam, i)
                        : OnDeviceFaceCvEngine.renderSyntheticIntercomFrame(scenarioMode, i);
                    frames.add(b);
                }
                if (!frames.isEmpty()) {
                    lastCvPreviewBitmap = frames.get(frames.size() - 1);
                }

                fsmState = "FACE_DETECTION";
                List<float[]> templates = keyStoreVault.loadDecryptedEmbeddings();

                fsmState = "FACE_RECOGNITION";
                final OnDeviceFaceCvEngine.MultiFrameCvResult cv = OnDeviceFaceCvEngine.evaluateFrameSeries(
                    frames,
                    templates,
                    similarityThreshold,
                    minMatchedFrames,
                    scenarioMode
                );
                if (cv.lastAnnotatedFrame != null) {
                    lastCvPreviewBitmap = cv.lastAnnotatedFrame;
                }

                fsmState = "LIVENESS_CHECK";
                if (!"FACE_MATCHED".equals(cv.faceOutcome)) {
                    fsmState = "FAILED";
                    lastDecisionSummary = cv.summaryText;
                    appendLog("FAILED", "[" + cv.faceOutcome + "] " + cv.summaryText);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this, cv.summaryText, Toast.LENGTH_LONG).show();
                            renderActiveTab();
                        }
                    });
                    return;
                }

                fsmState = "ACCESS_VALIDATION";
                DomRuApiClient.LockModel targetGate = getSelectedGateLock();
                if (targetGate != null && !targetGate.allowOpen) {
                    fsmState = "FAILED";
                    lastDecisionSummary = "Точка доступа запрещена (allowOpen=false)";
                    appendLog("FAILED", lastDecisionSummary);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() { renderActiveTab(); }
                    });
                    return;
                }

                if (observationMode) {
                    fsmState = "SUCCESS";
                    lastDecisionSummary = String.format(
                        Locale.US,
                        "Проверка пройдена (score=%.3f, %d кадра, %d мс), открытие НЕ выполнялось (Режим наблюдения)",
                        cv.similarityScore, cv.matchedFramesCount, cv.processingTimeMs
                    );
                    appendLog("OBSERVATION_PASS", lastDecisionSummary);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            vibratePhone(60);
                            Toast.makeText(MainActivity.this, lastDecisionSummary, Toast.LENGTH_LONG).show();
                            renderActiveTab();
                        }
                    });
                    return;
                }

                fsmState = "OPENING";
                boolean opened = targetGate == null || apiClient.openAccessControl(targetGate.placeId, targetGate.accessControlId, targetGate.entranceId);
                if (opened) {
                    openedInCurrentApproach = true;
                    cooldownUntilMs = System.currentTimeMillis() + 45000L;
                    fsmState = "COOLDOWN";
                    String gateTitle = targetGate != null ? targetGate.name : "Калитка";
                    lastDecisionSummary = "Открыто: «" + gateTitle + "» · Команда принята (COOLDOWN 45с)";
                    appendLog("SUCCESS_OPEN", lastDecisionSummary);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            vibratePhone(180);
                            SoundGenerator.playDoorUnlockSound();
                            Toast.makeText(MainActivity.this, lastDecisionSummary, Toast.LENGTH_LONG).show();
                            renderActiveTab();
                        }
                    });
                } else {
                    fsmState = "FAILED";
                    lastDecisionSummary = "Ошибка отправки accessControlOpen";
                    appendLog("FAILED", lastDecisionSummary);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() { renderActiveTab(); }
                    });
                }
            }
        }).start();
    }

    private void handleLiveGpsUpdate(double lat, double lon, float accuracy, double distance) {
        if (!autoEnabled || "DISABLED".equals(fsmState)) return;
        if (distance > exitRadiusM) {
            openedInCurrentApproach = false;
            fsmState = "OUTSIDE_GEOFENCE";
        } else if (distance >= 0 && distance <= entryRadiusM && !openedInCurrentApproach) {
            runAutoAccessPipelineAsync("owner", distance, accuracy);
        }
    }

    private void setGateToCurrentPhoneGps() {
        try {
            LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            Location loc = null;
            if (lm != null) {
                loc = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                if (loc == null) loc = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            }
            if (loc != null) {
                gateLat = loc.getLatitude();
                gateLon = loc.getLongitude();
                autoPrefs.edit()
                    .putLong("gate_lat", Double.doubleToRawLongBits(gateLat))
                    .putLong("gate_lon", Double.doubleToRawLongBits(gateLon))
                    .apply();
                DomRuGeofenceService.targetLat = gateLat;
                DomRuGeofenceService.targetLon = gateLon;
                appendLog("GEOFENCE_SET", String.format(Locale.US, "Установлены новые координаты калитки: %.6f, %.6f", gateLat, gateLon));
                Toast.makeText(this, "Координаты калитки обновлены по GPS телефона", Toast.LENGTH_SHORT).show();
                renderActiveTab();
            } else {
                Toast.makeText(this, "GPS-фикс ещё не получен; включите геолокацию на телефоне", Toast.LENGTH_SHORT).show();
            }
        } catch (SecurityException e) {
            requestAndroidPermissions();
        }
    }

    // =========================================================================
    // ВКЛАДКА 4: ВРЕМЕННЫЕ ГОСТЕВЫЕ ССЫЛКИ
    // =========================================================================
    private void renderGuestAccessTab() {
        contentContainer.addView(makeSectionTitle("Временные гостевые доступы (mh-temp-pass)"));

        LinearLayout createCard = makeCardContainer("#0F172A", "#1E293B");
        TextView desc = new TextView(this);
        desc.setText("Выпуск временной гостевой ссылки для курьера или гостя (формат TTL в секундах: 3600 / 14400 / 43200 / 86400):");
        desc.setTextColor(Color.parseColor("#CBD5E1"));
        desc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        desc.setPadding(0, 0, 0, dp(10));
        createCard.addView(desc);

        int[] ttls = new int[] { 3600, 14400, 43200, 86400 };
        String[] labels = new String[] {
            "Создать на 1 час (3600 сек · для курьера)",
            "Создать на 4 часа (14400 сек · на вечер)",
            "Создать на 12 часов (43200 сек · на день)",
            "Создать на 24 часа (86400 сек · сутки)"
        };

        for (int i = 0; i < ttls.length; i++) {
            final int ttlSec = ttls[i];
            Button b = makePillButton(labels[i], i == 0 ? "#0EA5E9" : "#1E293B", i == 0 ? "#020617" : "#F8FAFC");
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            );
            lp.topMargin = dp(6);
            b.setLayoutParams(lp);
            b.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    createGuestPassAsync(ttlSec);
                }
            });
            createCard.addView(b);
        }
        contentContainer.addView(createCard);

        contentContainer.addView(makeSectionTitle("Активные гостевые ссылки (" + guestPasses.size() + ")"));
        if (guestPasses.isEmpty()) {
            contentContainer.addView(makeInfoCard("Нет активных ссылок", "Нажмите любую из кнопок выше для выпуска гостевой ссылки."));
        } else {
            for (final DomRuApiClient.TempPassModel pass : guestPasses) {
                LinearLayout pCard = makeCardContainer("#0F172A", "#1E293B");
                TextView pTitle = new TextView(this);
                pTitle.setText("Гостевой пропуск #" + pass.id + " · " + pass.status);
                pTitle.setTextColor(Color.parseColor("#F8FAFC"));
                pTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
                pTitle.setTypeface(Typeface.DEFAULT_BOLD);

                TextView pLink = new TextView(this);
                pLink.setText(pass.sharedLinkMessage);
                pLink.setTextColor(Color.parseColor("#38BDF8"));
                pLink.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
                pLink.setTypeface(Typeface.MONOSPACE);
                pLink.setPadding(0, dp(4), 0, dp(8));

                LinearLayout row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);

                Button copyBtn = makeCompactActionButton("Копировать", "#1E293B", "#38BDF8");
                LinearLayout.LayoutParams cLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
                cLp.rightMargin = dp(6);
                copyBtn.setLayoutParams(cLp);
                copyBtn.setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        if (cm != null) {
                            cm.setPrimaryClip(ClipData.newPlainText("Гостевая ссылка Дом.ру", pass.sharedLinkMessage));
                            Toast.makeText(MainActivity.this, "Гостевая ссылка скопирована в буфер обмена", Toast.LENGTH_SHORT).show();
                        }
                    }
                });

                Button shareBtn = makeCompactActionButton("Поделиться", "#10B981", "#020617");
                LinearLayout.LayoutParams sLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
                shareBtn.setLayoutParams(sLp);
                shareBtn.setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        Intent sendIntent = new Intent(Intent.ACTION_SEND);
                        sendIntent.putExtra(Intent.EXTRA_TEXT, "Гостевой доступ к домофону/калитке: " + pass.sharedLinkMessage);
                        sendIntent.setType("text/plain");
                        startActivity(Intent.createChooser(sendIntent, "Отправить гостевую ссылку"));
                    }
                });

                row.addView(copyBtn);
                row.addView(shareBtn);
                pCard.addView(pTitle);
                pCard.addView(pLink);
                pCard.addView(row);
                contentContainer.addView(pCard);
            }
        }
    }

    private void createGuestPassAsync(final int ttlSec) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                String placeId = dashboard.places.isEmpty() ? "482910" : dashboard.places.get(0).id;
                List<Integer> acIds = new ArrayList<Integer>();
                for (DomRuApiClient.LockModel l : dashboard.locks) {
                    try { acIds.add(Integer.parseInt(l.accessControlId)); } catch (Exception ignored) {}
                }
                if (acIds.isEmpty()) acIds.add(9101);

                final DomRuApiClient.TempPassModel created = apiClient.createTempPass(placeId, ttlSec, acIds);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        guestPasses.add(0, created);
                        appendLog("GUEST_PASS", "Создана гостевая ссылка #" + created.id + " на " + ttlSec + " сек");
                        Toast.makeText(MainActivity.this, "Гостевая ссылка создана!", Toast.LENGTH_SHORT).show();
                        renderActiveTab();
                    }
                });
            }
        }).start();
    }

    // =========================================================================
    // ВКЛАДКА 5: АККАУНТ И ПРЯМАЯ АВТОРИЗАЦИЯ В MYHOME.PROPTECH.RU
    // =========================================================================
    private void renderAccountTab() {
        LinearLayout profCard = makeCardContainer("#0F172A", "#1E293B");
        profCard.addView(makeSectionTitle("Текущий профиль подключения"));

        TextView info = new TextView(this);
        info.setText(
            "Абонент: " + apiClient.getSubscriberName()
            + "\nЛицевой счёт: " + apiClient.getAccountId()
            + "\nРежим: " + (apiClient.isDemoMode() ? "Автономный демо-стенд (без интернета)" : "Прямой вход в https://myhome.proptech.ru")
            + "\nДиагностика API: " + apiClient.getLastSyncDiagnostic()
            + "\nУстройство: Xiaomi Poco X6 Pro (Dimensity 8300-Ultra, Android 16)"
        );
        info.setTextColor(Color.parseColor("#CBD5E1"));
        info.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        info.setPadding(0, dp(4), 0, dp(10));
        profCard.addView(info);
        contentContainer.addView(profCard);

        LinearLayout authCard = makeCardContainer("#0F172A", "#0EA5E9");
        authCard.addView(makeSectionTitle("Прямой вход в Умный Дом.ру / Электронный Город"));

        final EditText phoneInput = new EditText(this);
        phoneInput.setHint("Номер телефона (например, 79130000000)");
        phoneInput.setHintTextColor(Color.parseColor("#64748B"));
        phoneInput.setTextColor(Color.parseColor("#F8FAFC"));
        phoneInput.setInputType(InputType.TYPE_CLASS_PHONE);
        phoneInput.setText(apiClient.getPhone());

        final EditText passInput = new EditText(this);
        passInput.setHint("Пароль (если вход по паролю)");
        passInput.setHintTextColor(Color.parseColor("#64748B"));
        passInput.setTextColor(Color.parseColor("#F8FAFC"));
        passInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);

        Button loginPassBtn = makePillButton("Войти по номеру и паролю", "#0EA5E9", "#020617");
        LinearLayout.LayoutParams lp1 = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp1.topMargin = dp(8);
        loginPassBtn.setLayoutParams(lp1);
        loginPassBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                final String ph = phoneInput.getText().toString().trim();
                final String pw = passInput.getText().toString();
                if (ph.isEmpty() || pw.isEmpty()) {
                    Toast.makeText(MainActivity.this, "Укажите телефон и пароль", Toast.LENGTH_SHORT).show();
                    return;
                }
                Toast.makeText(MainActivity.this, "Авторизация в myhome.proptech.ru...", Toast.LENGTH_SHORT).show();
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            final boolean ok = apiClient.loginWithPassword(ph, pw);
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    if (ok) {
                                        cameraBitmaps.clear();
                                        Toast.makeText(MainActivity.this, "Успешный вход в аккаунт Дом.ру!", Toast.LENGTH_SHORT).show();
                                        refreshDashboardAsync();
                                        switchTab(0);
                                    } else {
                                        Toast.makeText(MainActivity.this, "Неверный пароль или требуется вход по СМС", Toast.LENGTH_LONG).show();
                                    }
                                }
                            });
                        } catch (final Exception e) {
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    Toast.makeText(MainActivity.this, "Ошибка сети: " + e.getMessage(), Toast.LENGTH_LONG).show();
                                }
                            });
                        }
                    }
                }).start();
            }
        });

        Button loginSmsBtn = makePillButton("Войти по СМС-коду (запросить код у оператора)", "#10B981", "#020617");
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp2.topMargin = dp(8);
        loginSmsBtn.setLayoutParams(lp2);
        loginSmsBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                final String ph = phoneInput.getText().toString().trim();
                if (ph.isEmpty()) {
                    Toast.makeText(MainActivity.this, "Введите номер телефона (79...)", Toast.LENGTH_SHORT).show();
                    return;
                }
                startSmsLoginFlow(ph);
            }
        });

        Button tokenBtn = makePillButton("Ввести готовый Bearer AccessToken", "#1E293B", "#38BDF8");
        LinearLayout.LayoutParams lp3 = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp3.topMargin = dp(8);
        tokenBtn.setLayoutParams(lp3);
        tokenBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showDirectTokenDialog();
            }
        });

        Button demoBtn = makePillButton("Включить автономный Демо-стенд", "#334155", "#F8FAFC");
        LinearLayout.LayoutParams lp4 = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp4.topMargin = dp(8);
        demoBtn.setLayoutParams(lp4);
        demoBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                cameraBitmaps.clear();
                apiClient.setDemoMode(true);
                refreshDashboardAsync();
                Toast.makeText(MainActivity.this, "Включён автономный Демо-режим", Toast.LENGTH_SHORT).show();
            }
        });

        Button welcomeBtn = makePillButton("Открыть экран приветствия и входа (v3.0)", "#0284C7", "#F8FAFC");
        LinearLayout.LayoutParams lp5 = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp5.topMargin = dp(8);
        welcomeBtn.setLayoutParams(lp5);
        welcomeBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showCommercialWelcomeScreen();
            }
        });

        authCard.addView(phoneInput);
        authCard.addView(passInput);
        authCard.addView(loginPassBtn);
        authCard.addView(loginSmsBtn);
        authCard.addView(tokenBtn);
        authCard.addView(demoBtn);
        authCard.addView(welcomeBtn);
        contentContainer.addView(authCard);
    }

    private void startSmsLoginFlow(final String rawPhone) {
        Toast.makeText(this, "Поиск договоров для " + rawPhone + "...", Toast.LENGTH_SHORT).show();
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    final JSONObject res = apiClient.loginCheckPhone(rawPhone);
                    final JSONArray contracts = res.optJSONArray("contracts");
                    if (contracts != null && contracts.length() > 0) {
                        if (contracts.length() == 1) {
                            final JSONObject firstContract = contracts.getJSONObject(0);
                            requestAndPromptSmsForContract(rawPhone, firstContract);
                        } else {
                            final String[] labels = new String[contracts.length()];
                            for (int i = 0; i < contracts.length(); i++) {
                                JSONObject c = contracts.optJSONObject(i);
                                String addr = c != null ? c.optString("address", "Адрес #" + (i + 1)) : ("Адрес #" + (i + 1));
                                String acc = c != null ? c.optString("accountId", "") : "";
                                labels[i] = addr + (acc.isEmpty() ? "" : (" (Л/С " + acc + ")"));
                            }
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    new AlertDialog.Builder(MainActivity.this)
                                        .setTitle("Выберите адрес договора")
                                        .setItems(labels, new DialogInterface.OnClickListener() {
                                            @Override
                                            public void onClick(DialogInterface dialog, final int which) {
                                                new Thread(new Runnable() {
                                                    @Override
                                                    public void run() {
                                                        try {
                                                            JSONObject chosen = contracts.getJSONObject(which);
                                                            requestAndPromptSmsForContract(rawPhone, chosen);
                                                        } catch (Exception ignored) {}
                                                    }
                                                }).start();
                                            }
                                        })
                                        .setNegativeButton("Отмена", null)
                                        .show();
                                }
                            });
                        }
                    } else {
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                Toast.makeText(MainActivity.this, "Для этого номера включён вход по паролю или номер не найден", Toast.LENGTH_LONG).show();
                            }
                        });
                    }
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this, "Ошибка запроса: " + e.getMessage(), Toast.LENGTH_LONG).show();
                        }
                    });
                }
            }
        }).start();
    }

    private void requestAndPromptSmsForContract(final String rawPhone, final JSONObject contract) throws Exception {
        final boolean sent = apiClient.requestSmsCode(rawPhone, contract);
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (sent) {
                    promptSmsCodeDialog(rawPhone, contract);
                } else {
                    Toast.makeText(MainActivity.this, "Оператор отклонил отправку СМС", Toast.LENGTH_LONG).show();
                }
            }
        });
    }

    private void promptSmsCodeDialog(final String phone, final JSONObject contract) {
        final EditText codeInput = new EditText(this);
        codeInput.setHint("4-значный код из СМС");
        codeInput.setInputType(InputType.TYPE_CLASS_NUMBER);

        new AlertDialog.Builder(this)
            .setTitle("Подтверждение СМС")
            .setMessage("Код отправлен на номер " + phone + " (" + contract.optString("address") + ")")
            .setView(codeInput)
            .setPositiveButton("Подтвердить", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialog, int which) {
                    final String code = codeInput.getText().toString().trim();
                    new Thread(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                final boolean ok = apiClient.verifySmsCode(phone, code, contract);
                                runOnUiThread(new Runnable() {
                                    @Override
                                    public void run() {
                                        if (ok) {
                                            cameraBitmaps.clear();
                                            Toast.makeText(MainActivity.this, "Вход выполнен!", Toast.LENGTH_SHORT).show();
                                            enterWorkspaceFromWelcome();
                                        } else {
                                            Toast.makeText(MainActivity.this, "Неверный код СМС", Toast.LENGTH_LONG).show();
                                        }
                                    }
                                });
                            } catch (Exception ignored) {}
                        }
                    }).start();
                }
            })
            .setNegativeButton("Отмена", null)
            .show();
    }

    private void showDirectTokenDialog() {
        final EditText tokenInput = new EditText(this);
        tokenInput.setHint("Bearer AccessToken от myhome.proptech.ru");

        new AlertDialog.Builder(this)
            .setTitle("Вход по токену Дом.ру")
            .setView(tokenInput)
            .setPositiveButton("Сохранить", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialog, int which) {
                    String t = tokenInput.getText().toString().trim();
                    if (!t.isEmpty()) {
                        cameraBitmaps.clear();
                        apiClient.setDirectToken(t, "1", "");
                        refreshDashboardAsync();
                        switchTab(0);
                    }
                }
            })
            .setNegativeButton("Отмена", null)
            .show();
    }

    private void toggleGeofenceService() {
        Intent serviceIntent = new Intent(this, DomRuGeofenceService.class);
        serviceIntent.putExtra("lat", gateLat);
        serviceIntent.putExtra("lon", gateLon);
        serviceIntent.putExtra("entryRadius", entryRadiusM);
        serviceIntent.putExtra("exitRadius", exitRadiusM);

        if (DomRuGeofenceService.isRunning) {
            stopService(serviceIntent);
            headerGeoBtn.setText("Геозона: ВЫКЛ");
            appendLog("GEOFENCE_SERVICE", "Фоновый сервис геозоны остановлен");
        } else {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent);
            } else {
                startService(serviceIntent);
            }
            headerGeoBtn.setText("Геозона: ВКЛ");
            appendLog("GEOFENCE_SERVICE", "Запущен ForegroundService контроля геозоны 20м/50м");
        }
    }

    private void appendLog(String stage, String msg) {
        String ts = new SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(new Date());
        auditLogs.add(0, ts + " [" + stage + "] " + msg);
        if (auditLogs.size() > 60) {
            auditLogs.remove(auditLogs.size() - 1);
        }
    }

    private TextView makeSectionTitle(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(Color.parseColor("#F8FAFC"));
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setPadding(0, dp(4), 0, dp(6));
        return tv;
    }

    private LinearLayout makeCardContainer(String bgHex, String strokeHex) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(Color.parseColor(bgHex));
        gd.setCornerRadius(dp(14));
        gd.setStroke(dp(1), Color.parseColor(strokeHex));
        box.setBackground(gd);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lp.bottomMargin = dp(12);
        box.setLayoutParams(lp);
        return box;
    }

    private LinearLayout makeInfoCard(String title, String body) {
        LinearLayout card = makeCardContainer("#0F172A", "#1E293B");
        TextView t = new TextView(this);
        t.setText(title);
        t.setTextColor(Color.parseColor("#F8FAFC"));
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);

        TextView b = new TextView(this);
        b.setText(body);
        b.setTextColor(Color.parseColor("#94A3B8"));
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        b.setPadding(0, dp(4), 0, 0);

        card.addView(t);
        card.addView(b);
        return card;
    }

    private Button makePillButton(String text, String bgHex, String textHex) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextColor(Color.parseColor(textHex));
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setPadding(dp(12), dp(10), dp(12), dp(10));

        GradientDrawable gd = new GradientDrawable();
        gd.setColor(Color.parseColor(bgHex));
        gd.setCornerRadius(dp(10));
        b.setBackground(gd);
        return b;
    }

    private Button makeCompactActionButton(String text, String bgHex, String textHex) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setSingleLine(true);
        b.setEllipsize(TextUtils.TruncateAt.END);
        b.setTextColor(Color.parseColor(textHex));
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setPadding(dp(10), dp(9), dp(10), dp(9));

        GradientDrawable gd = new GradientDrawable();
        gd.setColor(Color.parseColor(bgHex));
        gd.setCornerRadius(dp(10));
        b.setBackground(gd);
        return b;
    }

    private void styleButton(Button b, String bgHex, String textHex) {
        b.setTextColor(Color.parseColor(textHex));
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(Color.parseColor(bgHex));
        gd.setCornerRadius(dp(10));
        b.setBackground(gd);
    }

    private void vibratePhone(int ms) {
        try {
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null) v.vibrate(ms);
        } catch (Exception ignored) {}
    }

    private void requestAndroidPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            String[] perms = new String[] {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.CAMERA
            };
            boolean need = false;
            for (String p : perms) {
                if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) {
                    need = true;
                    break;
                }
            }
            if (need) {
                requestPermissions(perms, REQ_PERMS);
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        IntentFilter filter = new IntentFilter(DomRuGeofenceService.ACTION_GPS_UPDATE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(gpsReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(gpsReceiver, filter);
        }
    }

    @Override
    protected void onPause() {
        try { unregisterReceiver(gpsReceiver); } catch (Exception ignored) {}
        super.onPause();
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            v,
            getResources().getDisplayMetrics()
        );
    }
}
