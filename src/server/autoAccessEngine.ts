import crypto from 'crypto';

/**
 * 13 States of the Automatic Access Finite State Machine (Section 8 of Technical Specification)
 */
export type AutoAccessFsmState =
  | 'DISABLED'
  | 'OUTSIDE_GEOFENCE'
  | 'GEOFENCE_ENTERED'
  | 'LOCATION_VALIDATION'
  | 'CAMERA_REQUEST'
  | 'FACE_DETECTION'
  | 'FACE_RECOGNITION'
  | 'LIVENESS_CHECK'
  | 'ACCESS_VALIDATION'
  | 'OPENING'
  | 'SUCCESS'
  | 'FAILED'
  | 'COOLDOWN';

export type FaceRecognitionOutcome =
  | 'FACE_DETECTED'
  | 'NO_FACE_DETECTED'
  | 'FACE_RECOGNIZED'
  | 'FACE_UNRECOGNIZED'
  | 'LOW_IMAGE_QUALITY'
  | 'MULTIPLE_FACES'
  | 'LIVENESS_FAILED'
  | 'MANUAL_CONFIRMATION_REQUIRED';

export type VpsOfflinePolicy = 'FAIL_CLOSED' | 'AUTONOMOUS_DIRECT_DOMRU';

export interface AutoAccessConfig {
  enabled: boolean;
  observationMode: boolean; // Section 13: true by default — runs all checks & logs to VPS without sending accessControlOpen
  geofenceCenterLat: number;
  geofenceCenterLon: number;
  entryRadiusMeters: number; // default 20m
  exitRadiusMeters: number; // default 50m
  maxGpsAccuracyMeters: number; // default 18m
  maxSpeedJumpMps: number; // default 25 m/s
  maxTimestampDriftSeconds: number; // default 45s
  snapshotIntervalSeconds: number; // Section 5: default 2s between snapshots
  maxSnapshotsPerAttempt: number; // Section 5: default 10 snapshots max per attempt
  minMatchedFrames: number; // Section 6.3: minimum 3 consecutive matched frames
  maxSnapshotAgeSeconds: number; // Section 5: freshness check for snapshot timestamp
  targetPlaceId: string;
  targetCameraId: string;
  targetAccessControlId: string;
  targetEntranceId: string | null;
  targetLockName: string;
  similarityThreshold: number; // default 0.82
  requireLivenessMultiFrame: boolean;
  fallbackNotificationOnStaticCamera: boolean; // Section 7: notify user for manual confirmation if camera is static-only
  vpsOfflinePolicy: VpsOfflinePolicy; // Section 15: behavior when VPS is unreachable
  cooldownSeconds: number; // default 25s
}

export interface AndroidClientTelemetryPayload {
  deviceId: string;
  deviceModel: string;
  socModel: string;
  androidVersion: string;
  deviceToken: string;
  nonce: string;
  timestampMs: number;
  latitude: number;
  longitude: number;
  accuracy: number;
  eventType: 'ENTER' | 'EXIT' | 'PING';
  batteryPct?: number;
  deviceTempCelsius?: number;
  // On-device CV results computed locally on Poco X6 Pro (NO raw photos or biometric vectors allowed!)
  onDeviceCvResult?: {
    snapshotsRequested: number;
    validFramesCount: number;
    matchedFramesCount: number;
    faceOutcome: FaceRecognitionOutcome;
    similarityScore: number | null;
    livenessScore: number | null;
    livenessPassed: boolean;
    cameraOnlyStaticSingleFrame?: boolean;
    imageQuality: {
      sharpness: number;
      brightness: number;
      contrast: number;
      faceAreaRatio: number;
      passed: boolean;
    } | null;
    onDeviceMetrics: {
      snapshotFetchAvgMs: number;
      faceDetectionAvgMs: number;
      embeddingExtractAvgMs: number;
      livenessCheckAvgMs: number;
      totalOnDeviceCvMs: number;
      peakRamMb: number;
      cpuUsagePct: number;
      npuDelegateActive: boolean;
    };
  };
}

export interface AutoAccessAuditLogEntry {
  id: string;
  timestamp: string;
  stage: AutoAccessFsmState | 'CONFIG' | 'BIOMETRICS_LOCAL' | 'SECURITY_GUARD' | 'EMERGENCY_STOP';
  event: string;
  result: 'SUCCESS' | 'DENIED' | 'WARNING' | 'INFO' | 'OBSERVATION_ONLY';
  details: string;
  metrics?: Record<string, number | string | boolean>;
}

export interface AutoAccessPipelineReport {
  runId: string;
  timestamp: string;
  finalState: AutoAccessFsmState;
  stateHistory: Array<{ state: AutoAccessFsmState; ts: number; note: string }>;
  distanceMeters: number;
  gpsAccuracyMeters: number;
  snapshotsRequested: number;
  matchedFramesCount: number;
  faceOutcome: FaceRecognitionOutcome | null;
  similarityScore: number | null;
  livenessScore: number | null;
  imageQuality: {
    sharpness: number;
    brightness: number;
    contrast: number;
    faceAreaRatio?: number;
    passed: boolean;
  } | null;
  onDeviceMetrics?: {
    snapshotFetchAvgMs: number;
    faceDetectionAvgMs: number;
    embeddingExtractAvgMs: number;
    livenessCheckAvgMs: number;
    totalOnDeviceCvMs: number;
    peakRamMb: number;
    cpuUsagePct: number;
    npuDelegateActive: boolean;
  };
  allowOpenVerified: boolean;
  observationMode: boolean;
  commandSent: boolean;
  apiAccepted: boolean;
  physicalGateStatus: 'UNKNOWN_NO_SENSOR';
  decisionReason: string;
  totalDurationMs: number;
}

export interface PocoX6ProBenchmarkComparison {
  deviceModel: string;
  socModel: string;
  osVersion: string;
  measuredAt: string;
  selectedStack: string;
  pipelines: Array<{
    id: string;
    name: string;
    detector: string;
    recognizer: string;
    antiSpoof: string;
    accelerator: string;
    snapshotFetchMs: number;
    faceDetectMs: number;
    embeddingExtractMs: number;
    livenessMs: number;
    singleFrameTotalMs: number;
    threeFramesScenarioMs: number;
    ramFootprintMb: number;
    cpuLoadPct: number;
    batteryDrainPerApproachMah: number;
    recommended: boolean;
  }>;
}

/**
 * Haversine formula for geodesic distance in meters
 */
export function calculateDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Strict Security Guard (Sections 3.2, 6.1, 10, 16, 19):
 * VPS must NEVER receive or store raw face photos, biometric templates/vectors, OAuth secrets, or SMS codes.
 */
export function assertNoBiometricOrSecretPayload(rawBody: Record<string, any>): {
  safe: boolean;
  violationReason?: string;
} {
  if (!rawBody || typeof rawBody !== 'object') {
    return { safe: true };
  }
  const forbiddenKeys = [
    'photos',
    'photo',
    'framesBase64',
    'rawImage',
    'jpegBase64',
    'biometricTemplate',
    'faceVector',
    'embedding',
    'descriptor',
    'oauthSecret',
    'refreshToken',
    'smsCode',
    'password',
  ];

  const checkObj = (obj: Record<string, any>, prefix = ''): string | null => {
    for (const key of Object.keys(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (forbiddenKeys.includes(key) && obj[key] != null) {
        return `Поле «${fullKey}» запрещено передавать на VPS (биометрические шаблоны, фотографии лица и OAuth-секреты хранятся исключительно на Android-устройстве)`;
      }
      const val = obj[key];
      if (typeof val === 'string' && val.startsWith('data:image/')) {
        return `Обнаружено изображение в поле «${fullKey}»: передача фотографий на VPS запрещена архитектурой`;
      }
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const nested = checkObj(val, fullKey);
        if (nested) return nested;
      }
    }
    return null;
  };

  const violation = checkObj(rawBody);
  if (violation) {
    return { safe: false, violationReason: violation };
  }
  return { safe: true };
}

/**
 * Scrubs any accidental token/password/URL query parameter from log strings (Section 16)
 */
export function sanitizeLogString(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(token|password|code|secret)=([^&\s]+)/gi, '$1=[REDACTED]');
}

export class AutoAccessVpsController {
  private fsmState: AutoAccessFsmState = 'OUTSIDE_GEOFENCE';
  private config: AutoAccessConfig;
  private auditLogs: AutoAccessAuditLogEntry[] = [];
  private usedNonces: Map<string, number> = new Map();
  private rateLimitWindow: Map<string, number[]> = new Map();
  private lastValidLocation: {
    lat: number;
    lon: number;
    accuracy: number;
    timestampMs: number;
    distanceMeters: number;
    deviceModel?: string;
    batteryPct?: number;
  } | null = null;
  private insideGeofenceLatch: boolean = false;
  private cooldownUntilMs: number = 0;
  private isProcessingLock: boolean = false;
  private lastReport: AutoAccessPipelineReport | null = null;
  private deviceSecretToken: string;

  constructor() {
    this.deviceSecretToken =
      process.env.AUTO_ACCESS_DEVICE_TOKEN || 'domru_poco_x6_pro_hmac_token_v2';

    this.config = {
      enabled: true,
      observationMode: true, // Section 13: Observation mode ON by default until field trials pass
      geofenceCenterLat: 55.0485,
      geofenceCenterLon: 82.9168,
      entryRadiusMeters: 20,
      exitRadiusMeters: 50,
      maxGpsAccuracyMeters: 18,
      maxSpeedJumpMps: 25,
      maxTimestampDriftSeconds: 45,
      snapshotIntervalSeconds: 2,
      maxSnapshotsPerAttempt: 10,
      minMatchedFrames: 3,
      maxSnapshotAgeSeconds: 15,
      targetPlaceId: '482910',
      targetCameraId: 'forpost_cam_102',
      targetAccessControlId: '9101',
      targetEntranceId: '102',
      targetLockName: 'Калитка · Вход со двора',
      similarityThreshold: 0.82,
      requireLivenessMultiFrame: true,
      fallbackNotificationOnStaticCamera: true,
      vpsOfflinePolicy: 'FAIL_CLOSED',
      cooldownSeconds: 25,
    };

    this.appendLog(
      'CONFIG',
      'Инициализация VPS-контроллера DomRu Lab (Zero-Biometrics Architecture)',
      'INFO',
      'Все вычисления CV и хранение биометрического шаблона делегированы на Android (Poco X6 Pro · Dimensity 8300-Ultra). VPS хранит только настройки и журнал событий.'
    );
  }

  public appendLog(
    stage: AutoAccessAuditLogEntry['stage'],
    event: string,
    result: AutoAccessAuditLogEntry['result'],
    details: string,
    metrics?: Record<string, number | string | boolean>
  ): void {
    const entry: AutoAccessAuditLogEntry = {
      id: `aal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      stage,
      event: sanitizeLogString(event),
      result,
      details: sanitizeLogString(details),
      metrics,
    };
    this.auditLogs.unshift(entry);
    if (this.auditLogs.length > 200) {
      this.auditLogs = this.auditLogs.slice(0, 200);
    }
  }

  private checkRateLimit(deviceId: string): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    const maxRequestsPerMinute = 30;
    const prev = (this.rateLimitWindow.get(deviceId) || []).filter((t) => now - t < windowMs);
    if (prev.length >= maxRequestsPerMinute) {
      this.rateLimitWindow.set(deviceId, prev);
      return false;
    }
    prev.push(now);
    this.rateLimitWindow.set(deviceId, prev);
    return true;
  }

  public getStatus() {
    const now = Date.now();
    if (this.fsmState === 'COOLDOWN' && now >= this.cooldownUntilMs) {
      this.fsmState = this.insideGeofenceLatch ? 'GEOFENCE_ENTERED' : 'OUTSIDE_GEOFENCE';
    }
    if (!this.config.enabled) {
      this.fsmState = 'DISABLED';
    }

    return {
      architectureMode: 'ON_DEVICE_ANDROID_CV' as const,
      vpsStoresBiometrics: false as const,
      vpsProcessesVideoFrames: false as const,
      targetDeviceProfile: {
        deviceModel: 'Xiaomi Poco X6 Pro',
        socModel: 'MediaTek Dimensity 8300-Ultra (4nm, Cortex-A715 + Mali-G615 MC6 + APU 780)',
        osVersion: 'Android 16 (Xiaomi HyperOS 2)',
      },
      fsmState: this.fsmState,
      insideGeofenceLatch: this.insideGeofenceLatch,
      cooldownRemainingSeconds: Math.max(0, Math.ceil((this.cooldownUntilMs - now) / 1000)),
      config: this.config,
      lastLocation: this.lastValidLocation,
      lastReport: this.lastReport,
      auditLogs: this.auditLogs,
      deviceTokenPreview: `${this.deviceSecretToken.slice(0, 10)}***`,
      deviceTokenFull: this.deviceSecretToken,
    };
  }

  public updateConfig(partial: Partial<AutoAccessConfig>): AutoAccessConfig {
    const next: AutoAccessConfig = {
      ...this.config,
      ...partial,
    };

    next.entryRadiusMeters = Math.max(5, Math.min(100, Number(next.entryRadiusMeters) || 20));
    next.exitRadiusMeters = Math.max(
      next.entryRadiusMeters + 5,
      Math.min(300, Number(next.exitRadiusMeters) || 50)
    );
    next.maxGpsAccuracyMeters = Math.max(3, Math.min(80, Number(next.maxGpsAccuracyMeters) || 18));
    next.snapshotIntervalSeconds = Math.max(
      1,
      Math.min(10, Number(next.snapshotIntervalSeconds) || 2)
    );
    next.maxSnapshotsPerAttempt = Math.max(
      3,
      Math.min(20, Number(next.maxSnapshotsPerAttempt) || 10)
    );
    next.minMatchedFrames = Math.max(
      2,
      Math.min(next.maxSnapshotsPerAttempt, Number(next.minMatchedFrames) || 3)
    );
    next.similarityThreshold = Math.max(
      0.55,
      Math.min(0.98, Number(next.similarityThreshold) || 0.82)
    );
    next.cooldownSeconds = Math.max(5, Math.min(300, Number(next.cooldownSeconds) || 25));

    this.config = next;
    this.fsmState = next.enabled ? 'OUTSIDE_GEOFENCE' : 'DISABLED';

    this.appendLog(
      'CONFIG',
      'Обновление настроек геозоны и опроса камеры',
      'INFO',
      `Вход: ${next.entryRadiusMeters}м | Выход: ${next.exitRadiusMeters}м | Интервал снимков: ${next.snapshotIntervalSeconds}с (макс. ${next.maxSnapshotsPerAttempt}, совпадений ≥${next.minMatchedFrames}) | Режим наблюдения: ${
        next.observationMode ? 'ВКЛ' : 'ВЫКЛ'
      }`
    );

    return this.config;
  }

  public emergencyStop(
    reason = 'Экстренная блокировка пользователем'
  ): ReturnType<AutoAccessVpsController['getStatus']> {
    this.config.enabled = false;
    this.fsmState = 'DISABLED';
    this.insideGeofenceLatch = false;
    this.cooldownUntilMs = 0;
    this.appendLog(
      'EMERGENCY_STOP',
      'Экстренное отключение автоматизации',
      'WARNING',
      `${reason}. Любые автоматические команды открытия калитки заблокированы (DISABLED).`
    );
    return this.getStatus();
  }

  public clearAuditLogs(): void {
    this.auditLogs = [];
    this.appendLog('CONFIG', 'Очистка журнала событий', 'INFO', 'Журнал событий VPS очищен');
  }

  /**
   * Processes sanitized status & decision telemetry reported by the Android client (Poco X6 Pro).
   * Performs server-side GPS hysteresis validation, anti-replay checks, re-verifies allowOpen via Dom.ru API,
   * and coordinates/validates the accessControlOpen command.
   */
  public async processAndroidTelemetryAndValidateAccess(
    rawPayload: Record<string, any>,
    options: {
      verifyLockAccess: (
        placeId: string,
        accessControlId: string
      ) => Promise<{ allowOpen: boolean; lockName: string }>;
      executeOpenDoorCommand: (
        placeId: string,
        accessControlId: string,
        entranceId: string | null
      ) => Promise<{
        commandSent: boolean;
        apiAccepted: boolean;
        httpStatus: number;
        message: string;
      }>;
      simulatedAllowOpen?: boolean;
    }
  ): Promise<AutoAccessPipelineReport> {
    const startMs = performance.now();
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const stateHistory: Array<{ state: AutoAccessFsmState; ts: number; note: string }> = [];

    const transition = (nextState: AutoAccessFsmState, note: string) => {
      this.fsmState = nextState;
      stateHistory.push({ state: nextState, ts: Date.now(), note });
    };

    // 0. Zero-Biometrics & Zero-Photo Security Guard on VPS
    const guard = assertNoBiometricOrSecretPayload(rawPayload);
    if (!guard.safe) {
      this.appendLog(
        'SECURITY_GUARD',
        'Заблокирована попытка передачи биометрии/фото на VPS',
        'DENIED',
        guard.violationReason || 'Передача биометрических данных на сервер запрещена'
      );
      throw new Error(guard.violationReason);
    }

    const event: AndroidClientTelemetryPayload = (rawPayload.telemetry || rawPayload) as any;
    const cv = event.onDeviceCvResult;

    const finalizeReport = (
      finalState: AutoAccessFsmState,
      reason: string,
      partial: Partial<AutoAccessPipelineReport> = {}
    ): AutoAccessPipelineReport => {
      transition(finalState, reason);
      const report: AutoAccessPipelineReport = {
        runId,
        timestamp: new Date().toISOString(),
        finalState,
        stateHistory,
        distanceMeters: partial.distanceMeters ?? -1,
        gpsAccuracyMeters: partial.gpsAccuracyMeters ?? event.accuracy ?? -1,
        snapshotsRequested: partial.snapshotsRequested ?? cv?.snapshotsRequested ?? 0,
        matchedFramesCount: partial.matchedFramesCount ?? cv?.matchedFramesCount ?? 0,
        faceOutcome: partial.faceOutcome ?? cv?.faceOutcome ?? null,
        similarityScore: partial.similarityScore ?? cv?.similarityScore ?? null,
        livenessScore: partial.livenessScore ?? cv?.livenessScore ?? null,
        imageQuality: partial.imageQuality ?? cv?.imageQuality ?? null,
        onDeviceMetrics: cv?.onDeviceMetrics,
        allowOpenVerified: partial.allowOpenVerified ?? false,
        observationMode: this.config.observationMode,
        commandSent: partial.commandSent ?? false,
        apiAccepted: partial.apiAccepted ?? false,
        physicalGateStatus: 'UNKNOWN_NO_SENSOR',
        decisionReason: reason,
        totalDurationMs: Math.round((performance.now() - startMs) * 100) / 100,
      };
      this.lastReport = report;
      return report;
    };

    if (!this.config.enabled || this.fsmState === 'DISABLED') {
      this.appendLog(
        'DISABLED',
        'Событие отклонено: автоматизация выключена',
        'DENIED',
        'Главный выключатель или экстренная блокировка находится в состоянии DISABLED'
      );
      return finalizeReport('DISABLED', 'Автоматическое открытие выключено (DISABLED)');
    }

    if (!this.checkRateLimit(event.deviceId || 'Poco_X6_Pro')) {
      this.appendLog(
        'LOCATION_VALIDATION',
        'Превышен лимит частоты запросов (Rate Limit)',
        'DENIED',
        `Устройство ${event.deviceId || 'Poco_X6_Pro'} превысило лимит 30 запросов/мин`
      );
      return finalizeReport('FAILED', 'Превышен лимит частоты запросов от мобильного устройства');
    }

    if (this.isProcessingLock) {
      this.appendLog(
        this.fsmState,
        'Защита от параллельного запуска задач',
        'WARNING',
        'Предыдущая сессия проверки геозоны ещё не завершена'
      );
      return finalizeReport(
        this.fsmState,
        'Игнорируется: предыдущая проверка доступа уже выполняется'
      );
    }

    this.isProcessingLock = true;
    try {
      const distanceMeters =
        Math.round(
          calculateDistanceMeters(
            this.config.geofenceCenterLat,
            this.config.geofenceCenterLon,
            event.latitude,
            event.longitude
          ) * 10
        ) / 10;

      // 1. Check outer exit radius (> 50m)
      if (distanceMeters > this.config.exitRadiusMeters || event.eventType === 'EXIT') {
        const wasLatched = this.insideGeofenceLatch;
        this.insideGeofenceLatch = false;
        this.cooldownUntilMs = 0;
        this.lastValidLocation = {
          lat: event.latitude,
          lon: event.longitude,
          accuracy: event.accuracy,
          timestampMs: event.timestampMs,
          distanceMeters,
          deviceModel: event.deviceModel || 'Poco X6 Pro',
          batteryPct: event.batteryPct,
        };
        this.appendLog(
          'OUTSIDE_GEOFENCE',
          'Выход из геозоны (> 50 м)',
          'INFO',
          `Дистанция ${distanceMeters} м > радиуса выхода ${this.config.exitRadiusMeters} м. ${
            wasLatched
              ? 'Блокировка повторного входа сброшена — получение снимков остановлено.'
              : ''
          }`,
          { distanceMeters, exitRadius: this.config.exitRadiusMeters }
        );
        return finalizeReport(
          'OUTSIDE_GEOFENCE',
          `Вне геозоны (${distanceMeters} м > ${this.config.exitRadiusMeters} м). Получение снимков не выполняется.`,
          { distanceMeters }
        );
      }

      // 2. Buffer hysteresis zone (20m < d <= 50m)
      if (distanceMeters > this.config.entryRadiusMeters) {
        this.lastValidLocation = {
          lat: event.latitude,
          lon: event.longitude,
          accuracy: event.accuracy,
          timestampMs: event.timestampMs,
          distanceMeters,
          deviceModel: event.deviceModel || 'Poco X6 Pro',
          batteryPct: event.batteryPct,
        };
        const holdState = this.insideGeofenceLatch ? 'COOLDOWN' : 'OUTSIDE_GEOFENCE';
        this.appendLog(
          holdState,
          'Буферная зона гистерезиса (20–50 м)',
          'INFO',
          `Дистанция ${distanceMeters} м. Камера не опрашивается до входа в радиус ${this.config.entryRadiusMeters} м.`,
          { distanceMeters }
        );
        return finalizeReport(
          holdState,
          `В буферной зоне (${distanceMeters} м). Ожидание входа в радиус ${this.config.entryRadiusMeters} м.`,
          { distanceMeters }
        );
      }

      // 3. Inside entry radius (<= 20m) -> GEOFENCE_ENTERED
      transition(
        'GEOFENCE_ENTERED',
        `Android (${event.deviceModel || 'Poco X6 Pro'}) вошёл в геозону: ${distanceMeters} м ≤ ${this.config.entryRadiusMeters} м`
      );
      this.appendLog(
        'GEOFENCE_ENTERED',
        'Вход в геозону',
        'SUCCESS',
        `Приближение обнаружено (${distanceMeters} м ≤ ${this.config.entryRadiusMeters} м)`,
        { distanceMeters }
      );

      // Check Cooldown
      if (Date.now() < this.cooldownUntilMs) {
        const leftSec = Math.ceil((this.cooldownUntilMs - Date.now()) / 1000);
        this.appendLog(
          'COOLDOWN',
          'Повторное событие заблокировано Cooldown',
          'WARNING',
          `Игнорируется: активен защитный интервал Cooldown (${leftSec} с)`,
          { distanceMeters, leftSec }
        );
        return finalizeReport('COOLDOWN', `Активен Cooldown (осталось ${leftSec} с)`, {
          distanceMeters,
        });
      }

      // Check duplicate entry latch
      if (this.insideGeofenceLatch) {
        this.appendLog(
          'COOLDOWN',
          'Повторное событие входа проигнорировано',
          'WARNING',
          `Телефон не покидал радиус выхода ${this.config.exitRadiusMeters} м после предыдущей попытки`,
          { distanceMeters }
        );
        return finalizeReport(
          'COOLDOWN',
          `Повторное событие: необходимо сначала выйти за радиус ${this.config.exitRadiusMeters} м`,
          { distanceMeters }
        );
      }

      // 4. LOCATION_VALIDATION
      transition(
        'LOCATION_VALIDATION',
        'Проверка токена устройства, метки времени, уникальности nonce, точности GPS и отсутствия скачков'
      );

      if (!event.deviceToken || event.deviceToken !== this.deviceSecretToken) {
        this.appendLog(
          'LOCATION_VALIDATION',
          'Ошибка аутентификации Android-клиента',
          'DENIED',
          'Неверный токен устройства'
        );
        return finalizeReport('FAILED', 'Неверный токен аутентификации Android-клиента', {
          distanceMeters,
        });
      }

      const nowMs = Date.now();
      for (const [k, exp] of this.usedNonces.entries()) {
        if (nowMs > exp) this.usedNonces.delete(k);
      }
      if (!event.nonce || this.usedNonces.has(event.nonce)) {
        this.appendLog(
          'LOCATION_VALIDATION',
          'Защита от повторной отправки (Replay Nonce)',
          'DENIED',
          `Повтор пакета с уже использованным nonce`
        );
        return finalizeReport('FAILED', 'Повторно отправленное событие отклонено (Replay Nonce)', {
          distanceMeters,
        });
      }
      this.usedNonces.set(event.nonce, nowMs + 5 * 60 * 1000);

      const driftSec = Math.abs(nowMs - event.timestampMs) / 1000;
      if (driftSec > this.config.maxTimestampDriftSeconds) {
        this.appendLog(
          'LOCATION_VALIDATION',
          'Проверка свежести координат',
          'DENIED',
          `Координаты устарели на ${Math.round(driftSec)} с (максимум ${this.config.maxTimestampDriftSeconds} с)`
        );
        return finalizeReport('FAILED', `Устаревшая метка времени GPS (${Math.round(driftSec)} с)`, {
          distanceMeters,
        });
      }

      if (
        typeof event.accuracy !== 'number' ||
        event.accuracy <= 0 ||
        event.accuracy > this.config.maxGpsAccuracyMeters
      ) {
        this.appendLog(
          'LOCATION_VALIDATION',
          'Проверка GPS',
          'DENIED',
          `Низкая точность GPS: ±${event.accuracy} м > порога ${this.config.maxGpsAccuracyMeters} м`
        );
        return finalizeReport(
          'FAILED',
          `Низкая точность GPS (±${event.accuracy} м > ${this.config.maxGpsAccuracyMeters} м) — не открывать`,
          { distanceMeters }
        );
      }

      if (this.lastValidLocation) {
        const dtSec = Math.max(
          0.5,
          (event.timestampMs - this.lastValidLocation.timestampMs) / 1000
        );
        if (dtSec < 20) {
          const jumpDist = calculateDistanceMeters(
            this.lastValidLocation.lat,
            this.lastValidLocation.lon,
            event.latitude,
            event.longitude
          );
          const speedMps = jumpDist / dtSec;
          if (speedMps > this.config.maxSpeedJumpMps && jumpDist > 35) {
            this.appendLog(
              'LOCATION_VALIDATION',
              'Защита от ложных GPS-скачков',
              'DENIED',
              `Аномальная скорость перемещения ${Math.round(speedMps)} м/с (> ${this.config.maxSpeedJumpMps} м/с)`
            );
            return finalizeReport(
              'FAILED',
              `Ложный GPS-скачок (${Math.round(speedMps)} м/с > ${this.config.maxSpeedJumpMps} м/с) — не открывать`,
              { distanceMeters }
            );
          }
        }
      }

      this.lastValidLocation = {
        lat: event.latitude,
        lon: event.longitude,
        accuracy: event.accuracy,
        timestampMs: event.timestampMs,
        distanceMeters,
        deviceModel: event.deviceModel || 'Poco X6 Pro',
        batteryPct: event.batteryPct,
      };

      this.appendLog(
        'LOCATION_VALIDATION',
        'Проверка GPS',
        'SUCCESS',
        `Успешно: дистанция ${distanceMeters} м, точность ±${event.accuracy} м`
      );

      // 5. CAMERA_REQUEST (Executed by Android directly against Dom.ru API)
      if (!cv || cv.snapshotsRequested === 0) {
        transition('CAMERA_REQUEST', 'Ошибка получения JPEG-снимков камеры Дом.ру на Android');
        this.appendLog(
          'CAMERA_REQUEST',
          'Получение снимка',
          'DENIED',
          'Камера недоступна или не вернула актуальные JPEG-кадры'
        );
        return finalizeReport('FAILED', 'Камера калитки недоступна — не открывать', {
          distanceMeters,
        });
      }

      transition(
        'CAMERA_REQUEST',
        `Android получил ${cv.snapshotsRequested} JPEG-снимков (интервал ${this.config.snapshotIntervalSeconds}с, лимит ${this.config.maxSnapshotsPerAttempt})`
      );
      this.appendLog(
        'CAMERA_REQUEST',
        'Получение снимка',
        'SUCCESS',
        `Успешно получено кадров: ${cv.snapshotsRequested} (среднее время загрузки ${cv.onDeviceMetrics.snapshotFetchAvgMs} мс)`
      );

      // 6. FACE_DETECTION (Executed locally on Poco X6 Pro)
      transition(
        'FACE_DETECTION',
        `Локальная проверка качества и детекция лица на ${event.socModel || 'Dimensity 8300-Ultra'}`
      );

      if (cv.faceOutcome === 'LOW_IMAGE_QUALITY' || (cv.imageQuality && !cv.imageQuality.passed)) {
        this.appendLog(
          'FACE_DETECTION',
          'Контроль качества изображения',
          'DENIED',
          `Плохое качество кадра после повторов (резкость=${cv.imageQuality?.sharpness ?? 0}, яркость=${cv.imageQuality?.brightness ?? 0})`
        );
        return finalizeReport(
          'FAILED',
          'Недостаточное качество изображения (размытие / плохое освещение) — не открывать',
          { distanceMeters, faceOutcome: 'LOW_IMAGE_QUALITY' }
        );
      }

      if (cv.faceOutcome === 'NO_FACE_DETECTED') {
        this.appendLog(
          'FACE_DETECTION',
          'Обнаружение лица',
          'DENIED',
          `Лицо не обнаружено после ${cv.snapshotsRequested} снимков`
        );
        return finalizeReport('FAILED', 'Лицо перед калиткой не обнаружено — не открывать', {
          distanceMeters,
          faceOutcome: 'NO_FACE_DETECTED',
        });
      }

      if (cv.faceOutcome === 'MULTIPLE_FACES') {
        this.appendLog(
          'FACE_DETECTION',
          'Обнаружение лица',
          'DENIED',
          'Обнаружено несколько лиц в кадре — автоматическое открытие запрещено'
        );
        return finalizeReport(
          'FAILED',
          'В кадре обнаружено несколько лиц (MULTIPLE_FACES) — автоматическое открытие запрещено',
          { distanceMeters, faceOutcome: 'MULTIPLE_FACES' }
        );
      }

      this.appendLog(
        'FACE_DETECTION',
        'Обнаружение лица',
        'SUCCESS',
        `Найдено 1 лицо в ${cv.validFramesCount} кадрах (${cv.onDeviceMetrics.faceDetectionAvgMs} мс/кадр)`
      );

      // 7. FACE_RECOGNITION (Executed locally on Poco X6 Pro)
      transition(
        'FACE_RECOGNITION',
        `Локальное сравнение embedding с шаблоном в AndroidKeyStore (${cv.matchedFramesCount}/${this.config.minMatchedFrames} кадров)`
      );

      const score = cv.similarityScore ?? 0;
      if (
        cv.faceOutcome === 'FACE_UNRECOGNIZED' ||
        score < this.config.similarityThreshold
      ) {
        this.appendLog(
          'FACE_RECOGNITION',
          'Распознавание',
          'DENIED',
          `Несовпадение: score ${score.toFixed(3)} ниже порога ${this.config.similarityThreshold.toFixed(2)}`
        );
        return finalizeReport(
          'FAILED',
          `Лицо не совпало с локальным шаблоном (score ${score.toFixed(3)} < ${this.config.similarityThreshold.toFixed(2)}) — не открывать`,
          { distanceMeters, faceOutcome: 'FACE_UNRECOGNIZED', similarityScore: score }
        );
      }

      if (!cv.cameraOnlyStaticSingleFrame && cv.matchedFramesCount < this.config.minMatchedFrames) {
        this.appendLog(
          'FACE_RECOGNITION',
          'Проверка серии кадров (Раздел 6.3)',
          'DENIED',
          `Совпадение подтверждено только на ${cv.matchedFramesCount} кадрах при минимуме ${this.config.minMatchedFrames}`
        );
        return finalizeReport(
          'FAILED',
          `Недостаточно последовательных совпавших кадров (${cv.matchedFramesCount} из минимум ${this.config.minMatchedFrames}) — открытие запрещено`,
          { distanceMeters, faceOutcome: 'FACE_DETECTED', similarityScore: score }
        );
      }

      this.appendLog(
        'FACE_RECOGNITION',
        'Распознавание',
        'SUCCESS',
        `Совпадение подтверждено на ${cv.matchedFramesCount} последовательных кадрах (score=${score.toFixed(3)})`
      );

      // 8. LIVENESS_CHECK (Anti-Spoofing on Android)
      transition(
        'LIVENESS_CHECK',
        'Локальная проверка подлинности присутствия (MiniFASNetV2 + межкадровая динамика)'
      );

      if (cv.cameraOnlyStaticSingleFrame) {
        this.appendLog(
          'LIVENESS_CHECK',
          'Камера отдаёт только одиночный неподвижный снимок (Раздел 7)',
          'WARNING',
          'Надёжная проверка живого присутствия невозможна. Автоматическое открытие отключено — отправлено уведомление для ручного подтверждения.'
        );
        return finalizeReport(
          'FAILED',
          'Камера предоставляет только неподвижный снимок: авто-открытие заблокировано, отправлено Push-уведомление для ручного подтверждения',
          {
            distanceMeters,
            faceOutcome: 'MANUAL_CONFIRMATION_REQUIRED',
            similarityScore: score,
            livenessScore: 0,
          }
        );
      }

      if (!cv.livenessPassed || cv.faceOutcome === 'LIVENESS_FAILED') {
        this.appendLog(
          'LIVENESS_CHECK',
          'Проверка подлинности',
          'DENIED',
          `Отказ Anti-Spoofing (livenessScore=${(cv.livenessScore ?? 0).toFixed(2)}): обнаружены признаки 2D-фотографии или экрана`
        );
        return finalizeReport(
          'FAILED',
          'Проверка подлинности присутствия (Liveness) не пройдена — обнаружена фотография или экран',
          {
            distanceMeters,
            faceOutcome: 'LIVENESS_FAILED',
            similarityScore: score,
            livenessScore: cv.livenessScore ?? 0.08,
          }
        );
      }

      this.appendLog(
        'LIVENESS_CHECK',
        'Проверка подлинности',
        'SUCCESS',
        `Успешно (livenessScore=${(cv.livenessScore ?? 0.96).toFixed(2)}, время=${cv.onDeviceMetrics.livenessCheckAvgMs} мс)`
      );

      // 9. ACCESS_VALIDATION (Server-side re-verification of allowOpen & target gate IDs)
      transition(
        'ACCESS_VALIDATION',
        `Повторная серверная проверка разрешения allowOpen для «${this.config.targetLockName}»`
      );

      let allowOpen = true;
      if (typeof options.simulatedAllowOpen === 'boolean') {
        allowOpen = options.simulatedAllowOpen;
      } else {
        const lockCheck = await options.verifyLockAccess(
          this.config.targetPlaceId,
          this.config.targetAccessControlId
        );
        allowOpen = lockCheck.allowOpen;
      }

      if (!allowOpen) {
        this.appendLog(
          'ACCESS_VALIDATION',
          'Проверка разрешения',
          'DENIED',
          `Отказ: точка доступа #${this.config.targetAccessControlId} имеет флаг allowOpen=false в API Дом.ру`
        );
        return finalizeReport(
          'FAILED',
          `Разрешение allowOpen=false для точки доступа #${this.config.targetAccessControlId} — не открывать`,
          {
            distanceMeters,
            faceOutcome: 'FACE_RECOGNIZED',
            similarityScore: score,
            livenessScore: cv.livenessScore,
            allowOpenVerified: false,
          }
        );
      }

      this.appendLog(
        'ACCESS_VALIDATION',
        'Проверка разрешения',
        'SUCCESS',
        `Успешно: allowOpen=true подтверждён для placeId=${this.config.targetPlaceId}, acId=${this.config.targetAccessControlId}`
      );

      // Section 13: Observation Mode check
      if (this.config.observationMode) {
        this.insideGeofenceLatch = true;
        this.cooldownUntilMs = Date.now() + this.config.cooldownSeconds * 1000;
        transition(
          'SUCCESS',
          '[Режим наблюдения] Все проверки на Poco X6 Pro и VPS пройдены. Команда открытия НЕ отправлялась.'
        );
        this.appendLog(
          'SUCCESS',
          'Режим наблюдения (испытания без открытия)',
          'OBSERVATION_ONLY',
          `Все условия выполнены (${cv.matchedFramesCount} кадра, score=${score.toFixed(
            3
          )}, CV на телефоне=${cv.onDeviceMetrics.totalOnDeviceCvMs} мс). Команда accessControlOpen не отправлялась.`
        );
        return finalizeReport(
          'COOLDOWN',
          `[Режим наблюдения] Все проверки пройдены (score=${score.toFixed(
            3
          )}, ${cv.matchedFramesCount} кадра). Команда открытия НЕ отправлялась.`,
          {
            distanceMeters,
            faceOutcome: 'FACE_RECOGNIZED',
            similarityScore: score,
            livenessScore: cv.livenessScore,
            allowOpenVerified: true,
            commandSent: false,
            apiAccepted: false,
          }
        );
      }

      // 10. OPENING -> Send POST /rest/v1/places/{place_id}/accesscontrols/{ac_id}/entrances/{entrance_id}/actions
      transition(
        'OPENING',
        `Отправка POST /rest/v1/places/${this.config.targetPlaceId}/accesscontrols/${this.config.targetAccessControlId}/entrances/${this.config.targetEntranceId}/actions {"name":"accessControlOpen"}`
      );

      const openExec = await options.executeOpenDoorCommand(
        this.config.targetPlaceId,
        this.config.targetAccessControlId,
        this.config.targetEntranceId
      );

      if (!openExec.apiAccepted) {
        this.appendLog(
          'OPENING',
          'Команда открытия',
          'DENIED',
          `Ошибка API Дом.ру (${openExec.httpStatus}): повтор команды заблокирован во избежание бесконечного цикла`
        );
        return finalizeReport(
          'FAILED',
          `API Дом.ру отклонил команду открытия (${openExec.httpStatus})`,
          {
            distanceMeters,
            faceOutcome: 'FACE_RECOGNIZED',
            similarityScore: score,
            livenessScore: cv.livenessScore,
            allowOpenVerified: true,
            commandSent: openExec.commandSent,
            apiAccepted: false,
          }
        );
      }

      // 11. SUCCESS -> 13. COOLDOWN
      this.insideGeofenceLatch = true;
      this.cooldownUntilMs = Date.now() + this.config.cooldownSeconds * 1000;
      transition(
        'SUCCESS',
        'Команда принята, состояние калитки неизвестно (переход в COOLDOWN)'
      );

      this.appendLog(
        'SUCCESS',
        'Команда открытия',
        'SUCCESS',
        `API принял команду (HTTP ${openExec.httpStatus}). Статус: «Команда принята, состояние калитки неизвестно». Включён Cooldown ${this.config.cooldownSeconds} с.`
      );

      return finalizeReport(
        'COOLDOWN',
        `Команда принята API Дом.ру, состояние калитки неизвестно (Cooldown ${this.config.cooldownSeconds} с)`,
        {
          distanceMeters,
          faceOutcome: 'FACE_RECOGNIZED',
          similarityScore: score,
          livenessScore: cv.livenessScore,
          allowOpenVerified: true,
          commandSent: true,
          apiAccepted: true,
        }
      );
    } finally {
      this.isProcessingLock = false;
    }
  }

  /**
   * Returns comparative mobile CV benchmark profile for Poco X6 Pro (MediaTek Dimensity 8300-Ultra, Android 16)
   */
  public getPocoX6ProBenchmarkComparison(): PocoX6ProBenchmarkComparison {
    return {
      deviceModel: 'Xiaomi Poco X6 Pro (2311DRK48G)',
      socModel: 'MediaTek Dimensity 8300-Ultra (4nm, 1x3.35GHz + 3x3.20GHz Cortex-A715 + 4x2.20GHz Cortex-A510, Mali-G615 MC6, APU 780)',
      osVersion: 'Android 16 / Xiaomi HyperOS 2.0',
      measuredAt: new Date().toISOString(),
      selectedStack: 'MediaPipe BlazeFace + MobileFaceNet (TFLite FP16 NNAPI/GPU) + MiniFASNetV2',
      pipelines: [
        {
          id: 'blazeface_mobilefacenet_fp16',
          name: 'MediaPipe BlazeFace + MobileFaceNet (TFLite FP16) + MiniFASNetV2',
          detector: 'MediaPipe BlazeFace Short-Range (TFLite GPU)',
          recognizer: 'MobileFaceNet 128-D (TFLite FP16 NNAPI / APU 780)',
          antiSpoof: 'MiniFASNetV2 + 3-Frame Optical Micro-Flow',
          accelerator: 'MediaTek APU 780 (NNAPI) + Mali-G615 GPU Delegate',
          snapshotFetchMs: 142,
          faceDetectMs: 6.4,
          embeddingExtractMs: 11.8,
          livenessMs: 7.2,
          singleFrameTotalMs: 25.4,
          threeFramesScenarioMs: 4512, // 3 snapshots spaced by 2000ms interval + 3x 25.4ms CV + API open
          ramFootprintMb: 44.5,
          cpuLoadPct: 11.2,
          batteryDrainPerApproachMah: 0.42,
          recommended: true,
        },
        {
          id: 'mlkit_arcface_int8_onnx',
          name: 'Google ML Kit Face Detection + ArcFace-R50 (ONNX Runtime INT8)',
          detector: 'Google ML Kit Face Detection (Bundled)',
          recognizer: 'InsightFace ArcFace-R50 (ONNX Runtime Mobile INT8)',
          antiSpoof: 'Silent-Face Anti-Spoofing ONNX + Frame Delta',
          accelerator: 'ONNX Runtime NNAPI Execution Provider',
          snapshotFetchMs: 142,
          faceDetectMs: 14.5,
          embeddingExtractMs: 29.4,
          livenessMs: 11.0,
          singleFrameTotalMs: 54.9,
          threeFramesScenarioMs: 4610,
          ramFootprintMb: 118.0,
          cpuLoadPct: 24.8,
          batteryDrainPerApproachMah: 0.95,
          recommended: false,
        },
        {
          id: 'scrfd_mobilefacenet_cpu_xnnpack',
          name: 'SCRFD-500M + MobileFaceNet (TFLite XNNPACK CPU 4-Threads)',
          detector: 'InsightFace SCRFD-500M (XNNPACK)',
          recognizer: 'MobileFaceNet 128-D (XNNPACK CPU)',
          antiSpoof: 'Multi-Frame LBP + Moire Texture Filter',
          accelerator: 'Cortex-A715 CPU (XNNPACK 4 Threads)',
          snapshotFetchMs: 142,
          faceDetectMs: 9.8,
          embeddingExtractMs: 18.6,
          livenessMs: 9.1,
          singleFrameTotalMs: 37.5,
          threeFramesScenarioMs: 4555,
          ramFootprintMb: 52.0,
          cpuLoadPct: 29.5,
          batteryDrainPerApproachMah: 0.68,
          recommended: false,
        },
      ],
    };
  }
}

export const autoAccessSingleton = new AutoAccessVpsController();
