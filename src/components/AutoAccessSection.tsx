import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  BatteryCharging,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  Eye,
  FileCode,
  Fingerprint,
  MapPin,
  Navigation,
  Play,
  RefreshCw,
  ScanFace,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
  Upload,
  UserCheck,
  UserX,
  Zap,
} from 'lucide-react';
import { triggerApkDownload, triggerAndroidSourceDownload } from './PWAInstallButton';
import {
  apiClearAutoAccessLogs,
  apiDeleteFaceBiometrics,
  apiEmergencyStopAutoAccess,
  apiEnrollFaceBiometrics,
  apiGetAutoAccessStatus,
  apiRunAutoAccessBenchmark,
  apiTriggerGeofenceEvent,
  apiUpdateAutoAccessConfig,
} from '../services/egClient';
import {
  AutoAccessFsmState,
  AutoAccessStatusPayload,
  CameraItem,
  EgSession,
  LockItem,
  PlaceItem,
  PocoX6ProBenchmarkComparison,
  VpsOfflinePolicy,
} from '../types/eg';
import { getOrInitLocalBiometricTemplate } from '../utils/mobileOnDeviceCvEngine';
import { playGlobalDoorOpenSound } from '../utils/flvAudioEngine';

interface AutoAccessSectionProps {
  session: EgSession;
  places: PlaceItem[];
  locks: LockItem[];
  cameras: CameraItem[];
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

const FSM_ORDERED_STATES: Array<{ state: AutoAccessFsmState; label: string; short: string }> = [
  { state: 'DISABLED', label: 'Выключено', short: 'OFF' },
  { state: 'OUTSIDE_GEOFENCE', label: 'Вне геозоны (>50м)', short: 'OUT' },
  { state: 'GEOFENCE_ENTERED', label: 'Вход в геозону (≤20м)', short: 'ENTER' },
  { state: 'LOCATION_VALIDATION', label: 'Проверка координат GPS', short: 'GPS' },
  { state: 'CAMERA_REQUEST', label: 'Запрос JPEG (2с, до 10)', short: 'SNAP' },
  { state: 'FACE_DETECTION', label: 'Локальная детекция', short: 'DETECT' },
  { state: 'FACE_RECOGNITION', label: 'Локальное распознавание', short: 'MATCH' },
  { state: 'LIVENESS_CHECK', label: 'Проверка Liveness', short: 'LIVE' },
  { state: 'ACCESS_VALIDATION', label: 'Проверка allowOpen', short: 'ACL' },
  { state: 'OPENING', label: 'Отправка команды', short: 'OPEN' },
  { state: 'SUCCESS', label: 'API принял команду', short: 'OK' },
  { state: 'FAILED', label: 'Отказ (Fail-Closed)', short: 'FAIL' },
  { state: 'COOLDOWN', label: 'Пауза Cooldown', short: 'WAIT' },
];

export const AutoAccessSection: React.FC<AutoAccessSectionProps> = ({
  session,
   locks,
  cameras,
  onNotify,
}) => {
  const [status, setStatus] = useState<AutoAccessStatusPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<
    'monitor' | 'biometrics' | 'settings' | 'logs' | 'benchmark' | 'android'
  >('monitor');

  // Local on-device AndroidKeyStore biometric template state (never stored on VPS)
  const [localBioInfo, setLocalBioInfo] = useState(() =>
    getOrInitLocalBiometricTemplate(
      session.subscriber?.name || 'Андрей Семёнов (Poco X6 Pro)'
    )
  );
  const [enrollLabel, setEnrollLabel] = useState<string>(
    session.subscriber?.name || 'Андрей Семёнов (Poco X6 Pro)'
  );
  const [uploadedPhotos, setUploadedPhotos] = useState<string[]>([]);
  const [enrollReports, setEnrollReports] = useState<
    Array<{
      index: number;
      passed: boolean;
      sharpness: number;
      brightness: number;
      contrast: number;
      faceAreaRatio: number;
      reason?: string;
    }>
  >([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Poco X6 Pro Benchmark Comparison state
  const [benchmarkComparison, setBenchmarkComparison] =
    useState<PocoX6ProBenchmarkComparison | null>(null);

  // Config form state
  const [entryRadius, setEntryRadius] = useState<number>(20);
  const [exitRadius, setExitRadius] = useState<number>(50);
  const [maxAccuracy, setMaxAccuracy] = useState<number>(18);
  const [snapshotInterval, setSnapshotInterval] = useState<number>(2);
  const [maxSnapshots, setMaxSnapshots] = useState<number>(10);
  const [minMatchedFrames, setMinMatchedFrames] = useState<number>(3);
  const [similarityThreshold, setSimilarityThreshold] = useState<number>(0.82);
  const [cooldownSeconds, setCooldownSeconds] = useState<number>(25);
  const [centerLat, setCenterLat] = useState<number>(55.0485);
  const [centerLon, setCenterLon] = useState<number>(82.9168);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('forpost_cam_102');
  const [selectedLockId, setSelectedLockId] = useState<string>('lock_482910_9101_102');
  const [requireLiveness, setRequireLiveness] = useState<boolean>(true);
  const [vpsOfflinePolicy, setVpsOfflinePolicy] =
    useState<VpsOfflinePolicy>('FAIL_CLOSED');

  const syncFormFromConfig = useCallback(
    (st: AutoAccessStatusPayload) => {
      setEntryRadius(st.config.entryRadiusMeters);
      setExitRadius(st.config.exitRadiusMeters);
      setMaxAccuracy(st.config.maxGpsAccuracyMeters);
      setSnapshotInterval(st.config.snapshotIntervalSeconds);
      setMaxSnapshots(st.config.maxSnapshotsPerAttempt);
      setMinMatchedFrames(st.config.minMatchedFrames);
      setSimilarityThreshold(st.config.similarityThreshold);
      setCooldownSeconds(st.config.cooldownSeconds);
      setCenterLat(st.config.geofenceCenterLat);
      setCenterLon(st.config.geofenceCenterLon);
      setSelectedCameraId(st.config.targetCameraId);
      setRequireLiveness(st.config.requireLivenessMultiFrame);
      setVpsOfflinePolicy(st.config.vpsOfflinePolicy || 'FAIL_CLOSED');
      const matchingLock = locks.find(
        (l) =>
          l.accessControlId === st.config.targetAccessControlId &&
          String(l.entranceId || '') === String(st.config.targetEntranceId || '')
      );
      if (matchingLock) {
        setSelectedLockId(matchingLock.id);
      }
    },
    [locks]
  );

  const fetchStatus = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const data = await apiGetAutoAccessStatus(session);
        setStatus(data);
        if (!silent) {
          syncFormFromConfig(data);
        }
      } catch (err: any) {
        if (!silent) {
          onNotify('error', err?.message || 'Не удалось загрузить статус модуля Авто-доступа');
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [session, onNotify, syncFormFromConfig]
  );

  useEffect(() => {
    fetchStatus(false);
    const timer = setInterval(() => {
      fetchStatus(true);
    }, 4000);
    return () => clearInterval(timer);
  }, [fetchStatus]);

  const offsetLatByMeters = (baseLat: number, metersNorth: number): number => {
    return Number((baseLat + metersNorth / 111320).toFixed(6));
  };

  const handleToggleEnabled = async () => {
    if (!status) return;
    setBusyAction('toggle-enabled');
    try {
      const nextEnabled = !status.config.enabled;
      const res = await apiUpdateAutoAccessConfig(session, { enabled: nextEnabled });
      setStatus(res.status);
      onNotify(
        'info',
        nextEnabled
          ? 'Главный выключатель автоматизации включён'
          : 'Автоматизация переведена в состояние DISABLED'
      );
    } catch (err: any) {
      onNotify('error', err?.message || 'Ошибка переключения состояния');
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleObservationMode = async () => {
    if (!status) return;
    setBusyAction('toggle-observation');
    try {
      const nextObs = !status.config.observationMode;
      const res = await apiUpdateAutoAccessConfig(session, { observationMode: nextObs });
      setStatus(res.status);
      onNotify(
        nextObs ? 'info' : 'success',
        nextObs
          ? 'Включён Режим наблюдения (Раздел 13): Poco X6 Pro выполняет локальное распознавание и передаёт отчёт на VPS, но команда открытия не отправляется'
          : 'Включён Автоматический (боевой) режим: после всех проверок выполняется отправка accessControlOpen'
      );
    } catch (err: any) {
      onNotify('error', err?.message || 'Ошибка переключения режима');
    } finally {
      setBusyAction(null);
    }
  };

  const handleEmergencyStop = async () => {
    setBusyAction('emergency-stop');
    try {
      const res = await apiEmergencyStopAutoAccess(
        session,
        'Экстренное отключение пользователем из интерфейса управления'
      );
      setStatus(res.status);
      onNotify('error', 'ЭКСТРЕННОЕ ОТКЛЮЧЕНИЕ: Автоматический доступ заблокирован (DISABLED)');
    } catch (err: any) {
      onNotify('error', err?.message || 'Ошибка экстренной остановки');
    } finally {
      setBusyAction(null);
    }
  };

  // Run an end-to-end scenario where CV runs locally on the client device (Poco X6 Pro) and sends sanitized telemetry to VPS
  const handleRunScenario = async (
    scenarioKey:
      | 'owner_valid_entry'
      | 'exit_geofence'
      | 'stranger_face'
      | 'spoof_2d_photo'
      | 'static_single_snapshot_camera'
      | 'low_gps_accuracy'
      | 'gps_jump_anomaly'
      | 'multiple_faces'
      | 'no_face_camera'
      | 'real_browser_gps'
  ) => {
    if (!status) return;
    setBusyAction(scenarioKey);
    try {
      const baseLat = status.config.geofenceCenterLat;
      const baseLon = status.config.geofenceCenterLon;
      const token = status.deviceTokenFull;
      const nonce = `nonce_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      if (scenarioKey === 'real_browser_gps') {
        if (!navigator.geolocation) {
          onNotify('error', 'Геолокация не поддерживается вашим браузером');
          setBusyAction(null);
          return;
        }
        navigator.geolocation.getCurrentPosition(
          async (pos) => {
            try {
              const res = await apiTriggerGeofenceEvent(session, {
                event: {
                  latitude: pos.coords.latitude,
                  longitude: pos.coords.longitude,
                  accuracy: Math.round(pos.coords.accuracy || 10),
                  timestampMs: Date.now(),
                  nonce,
                  deviceToken: token,
                  deviceId: 'Poco_X6_Pro_Browser_GPS',
                  eventType: 'PING',
                },
                similarityThreshold: status.config.similarityThreshold,
                minMatchedFrames: status.config.minMatchedFrames,
              });
              setStatus(res.status);
              onNotify('info', `Гео-событие обработано: ${res.report.decisionReason}`);
            } catch (e: any) {
              onNotify('error', e?.message || 'Ошибка отправки GPS');
            } finally {
              setBusyAction(null);
            }
          },
          (err) => {
            onNotify('error', `Не удалось получить GPS координаты: ${err.message}`);
            setBusyAction(null);
          },
          { enableHighAccuracy: true, timeout: 8000 }
        );
        return;
      }

      let lat = offsetLatByMeters(baseLat, 11.5);
      const lon = baseLon;
      let accuracy = 5.6;
      let localFramesForOnDeviceCv: string[] = [
        'DEMO_SYNTHETIC_FACE:owner:frame1:brightness=126:sharpness=45:shift=0',
        'DEMO_SYNTHETIC_FACE:owner:frame2:brightness=128:sharpness=47:shift=2',
        'DEMO_SYNTHETIC_FACE:owner:frame3:brightness=125:sharpness=46:shift=4',
      ];
      let cameraOnlyStaticSingleFrame = false;

      if (scenarioKey === 'exit_geofence') {
        lat = offsetLatByMeters(baseLat, 68.0);
        accuracy = 6.2;
      } else if (scenarioKey === 'stranger_face') {
        localFramesForOnDeviceCv = [
          'DEMO_SYNTHETIC_FACE:stranger:frame1:brightness=122:sharpness=42:shift=0',
          'DEMO_SYNTHETIC_FACE:stranger:frame2:brightness=124:sharpness=43:shift=2',
          'DEMO_SYNTHETIC_FACE:stranger:frame3:brightness=121:sharpness=41:shift=4',
        ];
      } else if (scenarioKey === 'spoof_2d_photo') {
        localFramesForOnDeviceCv = [
          'DEMO_SYNTHETIC_FACE:spoof_static:frame1:brightness=126:sharpness=45:shift=0',
          'DEMO_SYNTHETIC_FACE:spoof_static:frame1:brightness=126:sharpness=45:shift=0',
          'DEMO_SYNTHETIC_FACE:spoof_static:frame1:brightness=126:sharpness=45:shift=0',
        ];
      } else if (scenarioKey === 'static_single_snapshot_camera') {
        cameraOnlyStaticSingleFrame = true;
      } else if (scenarioKey === 'low_gps_accuracy') {
        accuracy = 39.5;
      } else if (scenarioKey === 'gps_jump_anomaly') {
        await apiTriggerGeofenceEvent(session, {
          event: {
            latitude: offsetLatByMeters(baseLat, 650),
            longitude: baseLon,
            accuracy: 6,
            timestampMs: Date.now() - 1200,
            nonce: `${nonce}_pre`,
            deviceToken: token,
            deviceId: 'Poco_X6_Pro_2311DRK48G',
            eventType: 'PING',
          },
        });
        lat = offsetLatByMeters(baseLat, 10.0);
      } else if (scenarioKey === 'multiple_faces') {
        localFramesForOnDeviceCv = [
          'DEMO_SYNTHETIC_FACE:multiple_faces:frame1:brightness=125:sharpness=44:shift=0',
          'DEMO_SYNTHETIC_FACE:multiple_faces:frame2:brightness=127:sharpness=45:shift=2',
          'DEMO_SYNTHETIC_FACE:multiple_faces:frame3:brightness=126:sharpness=43:shift=4',
        ];
      } else if (scenarioKey === 'no_face_camera') {
        localFramesForOnDeviceCv = [
          'DEMO_SYNTHETIC_FACE:no_face:frame1:brightness=118:sharpness=40:shift=0',
        ];
      }

      const res = await apiTriggerGeofenceEvent(session, {
        event: {
          latitude: lat,
          longitude: lon,
          accuracy,
          timestampMs: Date.now(),
          nonce,
          deviceToken: token,
          deviceId: 'Poco_X6_Pro_2311DRK48G',
          deviceModel: 'Xiaomi Poco X6 Pro',
          socModel: 'MediaTek Dimensity 8300-Ultra',
          androidVersion: 'Android 16 (HyperOS 2.0)',
          batteryPct: 86,
          eventType: scenarioKey === 'exit_geofence' ? 'EXIT' : 'ENTER',
        },
        localFramesForOnDeviceCv,
        cameraOnlyStaticSingleFrame,
        similarityThreshold: status.config.similarityThreshold,
        minMatchedFrames: status.config.minMatchedFrames,
      });

      setStatus(res.status);

      if (res.report.commandSent && res.report.apiAccepted) {
        playGlobalDoorOpenSound(1.0, false);
        onNotify(
          'success',
          `Команда принята, состояние калитки неизвестно (score: ${(res.report.similarityScore || 0).toFixed(3)})`
        );
      } else if (res.report.finalState === 'COOLDOWN' && res.report.observationMode) {
        onNotify(
          'info',
          `[Режим наблюдения] Poco X6 Pro подтвердил владельца (score=${(res.report.similarityScore || 0).toFixed(3)}, ${res.report.matchedFramesCount} кадра). Команда открытия НЕ отправлялась.`
        );
      } else if (res.report.finalState === 'OUTSIDE_GEOFENCE') {
        onNotify('info', res.report.decisionReason);
      } else {
        onNotify('error', `Отказ доступа (Fail-Closed): ${res.report.decisionReason}`);
      }
    } catch (err: any) {
      onNotify('error', err?.message || 'Ошибка выполнения сценария');
    } finally {
      setBusyAction(null);
    }
  };

  // Handle photo file upload for local on-device biometric registration
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    Array.from(files)
      .slice(0, 5)
      .forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            setUploadedPhotos((prev) => [...prev.slice(0, 4), reader.result as string]);
          }
        };
        reader.readAsDataURL(file);
      });
  };

  const handleAddCalibratedOwnerSamples = () => {
    setUploadedPhotos([
      'DEMO_SYNTHETIC_FACE:owner:enroll1:brightness=127:sharpness=48:shift=0',
      'DEMO_SYNTHETIC_FACE:owner:enroll2:brightness=131:sharpness=52:shift=1',
      'DEMO_SYNTHETIC_FACE:owner:enroll3:brightness=124:sharpness=46:shift=2',
    ]);
    onNotify(
      'info',
      'Добавлены 3 локальных ракурса лица при разном освещении для формирования шаблона на устройстве'
    );
  };

  const handleEnrollBiometricsLocally = async () => {
    const photosToUse =
      uploadedPhotos.length > 0
        ? uploadedPhotos
        : [
            'DEMO_SYNTHETIC_FACE:owner:enroll1:brightness=127:sharpness=48:shift=0',
            'DEMO_SYNTHETIC_FACE:owner:enroll2:brightness=131:sharpness=52:shift=1',
            'DEMO_SYNTHETIC_FACE:owner:enroll3:brightness=124:sharpness=46:shift=2',
          ];

    setBusyAction('enroll-biometrics');
    try {
      const res = await apiEnrollFaceBiometrics(session, enrollLabel, photosToUse);
      setStatus(res.status);
      setEnrollReports(res.perPhotoReports || []);
      setLocalBioInfo(getOrInitLocalBiometricTemplate(enrollLabel));
      // Clear raw photos from memory immediately after creating the local template (Section 6.1)
      setUploadedPhotos([]);
      onNotify('success', res.message);
    } catch (err: any) {
      onNotify('error', err?.message || 'Ошибка локальной регистрации лица');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteBiometricsLocally = async () => {
    setBusyAction('delete-biometrics');
    try {
      const res = await apiDeleteFaceBiometrics(session);
      setStatus(res.status);
      setUploadedPhotos([]);
      setEnrollReports([]);
      setLocalBioInfo(getOrInitLocalBiometricTemplate(enrollLabel));
      onNotify('info', res.message);
    } catch (err: any) {
      onNotify('error', err?.message || 'Ошибка удаления локального шаблона');
    } finally {
      setBusyAction(null);
    }
  };

  const handleTestVpsZeroBiometricsGuard = async () => {
    setBusyAction('test-vps-guard');
    try {
      const res = await fetch('/api/eg/auto-access/biometrics/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Test Prohibited Upload',
          photos: ['data:image/jpeg;base64,/9j/4AAQSkZJRg=='],
        }),
      });
      const data = await res.json();
      await fetchStatus(true);
      if (res.status === 400) {
        onNotify(
          'success',
          `Защита VPS сработала (HTTP 400): ${data.message}`
        );
      }
    } catch (err: any) {
      onNotify('error', err?.message || 'Ошибка проверки защиты VPS');
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (exitRadius <= entryRadius + 4) {
      onNotify(
        'error',
        'Радиус выхода должен быть минимум на 5 метров больше радиуса входа (гистерезис 20м / 50м)'
      );
      return;
    }

    const chosenLock = locks.find((l) => l.id === selectedLockId) || locks[0];

    setBusyAction('save-settings');
    try {
      const res = await apiUpdateAutoAccessConfig(session, {
        entryRadiusMeters: entryRadius,
        exitRadiusMeters: exitRadius,
        maxGpsAccuracyMeters: maxAccuracy,
        snapshotIntervalSeconds: snapshotInterval,
        maxSnapshotsPerAttempt: maxSnapshots,
        minMatchedFrames,
        similarityThreshold,
        cooldownSeconds,
        geofenceCenterLat: centerLat,
        geofenceCenterLon: centerLon,
        targetCameraId: selectedCameraId,
        targetPlaceId: chosenLock?.placeId || status?.config.targetPlaceId || '482910',
        targetAccessControlId: chosenLock?.accessControlId || '9101',
        targetEntranceId: chosenLock?.entranceId ?? '102',
        targetLockName: chosenLock?.name || 'Калитка · Вход со двора',
        requireLivenessMultiFrame: requireLiveness,
        vpsOfflinePolicy,
      });
      setStatus(res.status);
      onNotify('success', 'Конфигурация геозоны, интервала снимков (2с/10 кадров) и распознавания сохранена');
    } catch (err: any) {
      onNotify('error', err?.message || 'Ошибка сохранения настроек');
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunBenchmark = async () => {
    setBusyAction('benchmark');
    try {
      const res = await apiRunAutoAccessBenchmark(session);
      setBenchmarkComparison(res.comparison);
      setStatus(res.status);
      onNotify(
        'success',
        `Загружен сравнительный профиль производительности Poco X6 Pro (Dimensity 8300-Ultra)`
      );
    } catch (err: any) {
      onNotify('error', err?.message || 'Ошибка загрузки бенчмарка');
    } finally {
      setBusyAction(null);
    }
  };

  const handleClearLogs = async () => {
    setBusyAction('clear-logs');
    try {
      const res = await apiClearAutoAccessLogs(session);
      setStatus(res.status);
      onNotify('info', 'Журнал событий VPS очищен');
    } catch (err: any) {
      onNotify('error', err?.message || 'Ошибка очистки журнала');
    } finally {
      setBusyAction(null);
    }
  };

  if (loading && !status) {
    return (
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-8 flex items-center justify-center gap-3 text-slate-400">
        <RefreshCw className="w-5 h-5 animate-spin text-emerald-400" />
        <span>Загрузка модуля автоматического доступа DomRu Lab (Poco X6 Pro On-Device CV)...</span>
      </div>
    );
  }

  if (!status) return null;

  const lastReport = status.lastReport;

  return (
    <div className="space-y-6">
      {/* Native Android APK Download Banner for Poco X6 Pro */}
      <div className="bg-slate-900 border border-emerald-500/40 rounded-2xl p-4 sm:p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4 shadow-lg">
        <div className="flex items-start gap-3.5">
          <div className="w-11 h-11 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0 mt-0.5">
            <Smartphone className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold text-slate-100 font-display">
                Автономный Android APK v2.2: DomRuLab-PocoX6Pro-v2.2.0.apk
              </h2>
              <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                100% Native UI · Селфи + Камера домофона · Без WebView
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Полноценное автономное приложение (<span className="font-mono text-slate-300">ru.domrulab.pocox6pro</span>): синхронизация реальных дверей, калиток, шлагбаумов и камер (<span className="font-mono text-slate-300">myhome.proptech.ru v9.11.0</span>), регистрация лица как с фронтальной камеры телефона, так и с камеры домофона, <span className="font-mono text-slate-300">AndroidKeyStore AES-256-GCM</span> и локальный <span className="font-mono text-slate-300">OnDeviceFaceCvEngine</span>.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={triggerApkDownload}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition-colors cursor-pointer shadow-sm"
          >
            <Download className="w-4 h-4" />
            <span>Скачать APK v2.2 (Poco X6 Pro)</span>
          </button>
          <button
            type="button"
            onClick={triggerAndroidSourceDownload}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors cursor-pointer"
          >
            <FileCode className="w-4 h-4 text-sky-400" />
            <span>Исходники (.zip)</span>
          </button>
        </div>
      </div>

      {/* Top Hero Header & Safety Controls */}
      <div className="bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950/30 border border-slate-800/90 rounded-2xl p-5 sm:p-6 shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                <Smartphone className="w-3.5 h-3.5" />
                Poco X6 Pro · Dimensity 8300-Ultra (On-Device CV)
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-sky-500/15 text-sky-300 border border-sky-500/30">
                <ShieldCheck className="w-3.5 h-3.5" />
                VPS без биометрии и фото (Zero-Biometrics VPS)
              </span>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono font-semibold border ${
                  !status.config.enabled || status.fsmState === 'DISABLED'
                    ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                    : status.config.observationMode
                    ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                    : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                }`}
              >
                <Activity className="w-3.5 h-3.5" />
                FSM: {status.fsmState}
              </span>
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
              Автоматическое открытие калитки (Android Геозона + Локальное распознавание лица)
            </h2>
            <p className="text-xs sm:text-sm text-slate-400 max-w-3xl">
              Все вычисления компьютерного зрения и хранение биометрического шаблона выполняются
              непосредственно на телефоне <strong className="text-slate-200">Poco X6 Pro (Android 16)</strong>.
              При входе в геозону <strong className="text-slate-200">{status.config.entryRadiusMeters} м</strong>{' '}
              (выход <strong className="text-slate-200">{status.config.exitRadiusMeters} м</strong>) телефон
              запрашивает JPEG-снимки камеры Дом.ру каждые{' '}
              <strong className="text-slate-200">{status.config.snapshotIntervalSeconds} с</strong> (до{' '}
              <strong className="text-slate-200">{status.config.maxSnapshotsPerAttempt}</strong> кадров, мин.{' '}
              <strong className="text-slate-200">{status.config.minMatchedFrames}</strong> совпадения).
            </p>
          </div>

          {/* Primary Action & Emergency Controls */}
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              onClick={handleToggleObservationMode}
              disabled={busyAction !== null}
              className={`px-3.5 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 border transition cursor-pointer ${
                status.config.observationMode
                  ? 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 border-amber-500/40'
                  : 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border-emerald-500/40'
              }`}
            >
              <Eye className="w-4 h-4" />
              {status.config.observationMode
                ? 'Режим наблюдения (Без открытия)'
                : 'Автоматический режим (Боевой)'}
            </button>

            <button
              onClick={handleToggleEnabled}
              disabled={busyAction !== null}
              className={`px-3.5 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 border transition cursor-pointer ${
                status.config.enabled
                  ? 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500'
              }`}
            >
              <Zap className="w-4 h-4" />
              {status.config.enabled ? 'Выключить' : 'Включить'}
            </button>

            <button
              onClick={handleEmergencyStop}
              disabled={busyAction !== null}
              className="px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 bg-rose-600 hover:bg-rose-500 text-white border border-rose-400/40 shadow-lg shadow-rose-950/50 transition cursor-pointer"
            >
              <AlertOctagon className="w-4 h-4" />
              Экстренное отключение
            </button>
          </div>
        </div>

        {/* 13-State Finite State Machine Visual Pipeline */}
        <div className="mt-5 pt-4 border-t border-slate-800/80">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <span className="text-[11px] uppercase tracking-wider font-semibold text-slate-400">
              Конечный автомат состояний (Раздел 8 ТЗ — 13 состояний)
            </span>
            <span className="text-xs text-slate-400 font-mono">
              Калитка: <strong className="text-slate-200">{status.config.targetLockName}</strong> · Камера:{' '}
              <strong className="text-emerald-300">{status.config.targetCameraId}</strong>
            </span>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-13 gap-1.5">
            {FSM_ORDERED_STATES.map((item) => {
              const isCurrent = status.fsmState === item.state;
              const wasVisitedInLastRun = Boolean(
                lastReport?.stateHistory?.some((h) => h.state === item.state)
              );
              return (
                <div
                  key={item.state}
                  title={`${item.state}: ${item.label}`}
                  className={`px-2 py-2 rounded-lg border text-center transition ${
                    isCurrent
                      ? item.state === 'FAILED' || item.state === 'DISABLED'
                        ? 'bg-rose-500/25 border-rose-400 text-rose-200 shadow-sm'
                        : 'bg-emerald-500/25 border-emerald-400 text-emerald-200 shadow-sm'
                      : wasVisitedInLastRun
                      ? 'bg-slate-800/90 border-emerald-500/30 text-slate-200'
                      : 'bg-slate-950/60 border-slate-800/80 text-slate-500'
                  }`}
                >
                  <div className="text-[10px] font-mono font-bold tracking-tight truncate">
                    {item.short}
                  </div>
                  <div className="text-[9px] truncate mt-0.5 opacity-85">{item.label}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Sub-navigation Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
        {[
          { id: 'monitor', label: 'Основной экран и Испытания (Этап 7)', icon: Activity },
          { id: 'biometrics', label: 'Локальная регистрация лица (На телефоне)', icon: ScanFace },
          { id: 'settings', label: 'Настройки геозоны и снимков (2с / 10 кадров)', icon: Settings },
          { id: 'logs', label: `Журнал событий (${status.auditLogs.length})`, icon: Database },
          { id: 'benchmark', label: 'Производительность Poco X6 Pro', icon: Cpu },
          { id: 'android', label: 'Android-код (Kotlin) и HyperOS', icon: Smartphone },
        ].map((tab) => {
          const Icon = tab.icon;
          const active = activeSubTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id as any)}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition cursor-pointer ${
                active
                  ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/10'
                  : 'bg-slate-900/80 hover:bg-slate-800 text-slate-300 border border-slate-800'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* TAB 1: MONITOR & INTERACTIVE TEST BENCH */}
      {activeSubTab === 'monitor' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left 7 cols: Interactive Scenario Test Bench */}
          <div className="lg:col-span-7 space-y-5">
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-5 space-y-4">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Play className="w-4 h-4 text-emerald-400" />
                  Стенд испытаний сценариев (Локальный CV на Poco X6 Pro → API Дом.ру + Журнал VPS)
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Снимки обрабатываются локально на клиентском устройстве (MediaPipe + MobileFaceNet). На VPS
                  отправляется только криптографически подписанный статус без фотографий и шаблонов.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  onClick={() => handleRunScenario('owner_valid_entry')}
                  disabled={busyAction !== null}
                  className="p-3.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-left transition flex items-start gap-3 cursor-pointer"
                >
                  <UserCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-xs font-bold text-emerald-200">
                      1. Приближение владельца (11.5 м ≤ 20 м)
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      3 последовательных JPEG · Локальный score 0.998 · Liveness пройден
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => handleRunScenario('exit_geofence')}
                  disabled={busyAction !== null}
                  className="p-3.5 rounded-xl bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-left transition flex items-start gap-3 cursor-pointer"
                >
                  <Navigation className="w-5 h-5 text-sky-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-xs font-bold text-sky-200">
                      2. Выход из геозоны (68 м &gt; 50 м)
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Прекращение опроса камеры и сброс блокировки повторного входа
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => handleRunScenario('stranger_face')}
                  disabled={busyAction !== null}
                  className="p-3.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-left transition flex items-start gap-3 cursor-pointer"
                >
                  <UserX className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-xs font-bold text-rose-200">
                      3. Лицо не совпадает (Посторонний)
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Score ниже порога {status.config.similarityThreshold} → Отказ (Fail-Closed)
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => handleRunScenario('spoof_2d_photo')}
                  disabled={busyAction !== null}
                  className="p-3.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-left transition flex items-start gap-3 cursor-pointer"
                >
                  <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-xs font-bold text-amber-200">
                      4. Предъявлена фотография / видео с экрана
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Локальный Anti-Spoofing обнаруживает подмену → LIVENESS_FAILED
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => handleRunScenario('static_single_snapshot_camera')}
                  disabled={busyAction !== null}
                  className="p-3.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-left transition flex items-start gap-3 cursor-pointer"
                >
                  <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-xs font-bold text-amber-200">
                      5. Камера отдаёт только 1 неподвижный снимок
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Раздел 7 ТЗ: авто-открытие блокируется → Push для ручного подтверждения
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => handleRunScenario('low_gps_accuracy')}
                  disabled={busyAction !== null}
                  className="p-3.5 rounded-xl bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-left transition flex items-start gap-3 cursor-pointer"
                >
                  <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-xs font-bold text-slate-200">
                      6. Ошибка GPS (Accuracy ±39.5 м &gt; 18 м)
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Блокировка на этапе LOCATION_VALIDATION без опроса камеры
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => handleRunScenario('multiple_faces')}
                  disabled={busyAction !== null}
                  className="p-3.5 rounded-xl bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-left transition flex items-start gap-3 cursor-pointer"
                >
                  <ScanFace className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-xs font-bold text-slate-200">
                      7. Несколько лиц в кадре (MULTIPLE_FACES)
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Раздел 6.3 ТЗ: при нескольких лицах автоматическое открытие запрещено
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => handleRunScenario('real_browser_gps')}
                  disabled={busyAction !== null}
                  className="p-3.5 rounded-xl bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 text-left transition flex items-start gap-3 cursor-pointer"
                >
                  <MapPin className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-xs font-bold text-indigo-200">
                      8. Проверить реальные координаты устройства
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Запрос navigator.geolocation и проверка вхождения в геозону
                    </div>
                  </div>
                </button>
              </div>
            </div>

            {/* Section 9: Distinction of Command Sent vs API Accepted vs Physical Gate State */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-5 space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                <Shield className="w-4 h-4 text-emerald-400" />
                Статус выполнения команды открытия (Раздел 9 ТЗ)
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800">
                  <div className="text-[11px] text-slate-400">1. Команда отправлена</div>
                  <div className="mt-1 flex items-center gap-1.5 font-semibold text-xs">
                    {lastReport?.commandSent ? (
                      <span className="text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-4 h-4" /> Да (accessControlOpen)
                      </span>
                    ) : (
                      <span className="text-slate-400">
                        {lastReport?.observationMode
                          ? 'Подавлена (Режим наблюдения)'
                          : 'Не отправлялась'}
                      </span>
                    )}
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800">
                  <div className="text-[11px] text-slate-400">2. API Дом.ру принял команду</div>
                  <div className="mt-1 flex items-center gap-1.5 font-semibold text-xs">
                    {lastReport?.apiAccepted ? (
                      <span className="text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-4 h-4" /> API принял (200 OK)
                      </span>
                    ) : (
                      <span className="text-slate-400">Нет подтверждения</span>
                    )}
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-amber-950/20 border border-amber-500/30">
                  <div className="text-[11px] text-amber-300/90">3. Физическое открытие калитки</div>
                  <div className="mt-1 text-xs font-semibold text-amber-200 flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                    Команда принята, состояние калитки неизвестно
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right 5 cols: Last Pipeline Execution Telemetry */}
          <div className="lg:col-span-5 space-y-5">
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <ScanFace className="w-4 h-4 text-emerald-400" />
                  Последний результат проверки (Poco X6 Pro)
                </h3>
                {lastReport?.onDeviceMetrics && (
                  <span className="text-xs font-mono text-emerald-300">
                    CV на телефоне: {lastReport.onDeviceMetrics.totalOnDeviceCvMs} мс
                  </span>
                )}
              </div>

              {!lastReport ? (
                <div className="p-6 text-center text-slate-400 text-xs border border-dashed border-slate-800 rounded-xl">
                  Запустите любой сценарий испытания слева для проверки работы локального распознавания и
                  конечного автомата.
                </div>
              ) : (
                <div className="space-y-3.5">
                  <div
                    className={`p-3.5 rounded-xl border ${
                      lastReport.finalState === 'FAILED' || lastReport.finalState === 'DISABLED'
                        ? 'bg-rose-500/10 border-rose-500/30 text-rose-200'
                        : lastReport.observationMode
                        ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                        : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                    }`}
                  >
                    <div className="text-xs font-bold uppercase tracking-wider opacity-80">
                      Статус: {lastReport.finalState}
                    </div>
                    <div className="text-sm font-semibold mt-1">{lastReport.decisionReason}</div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 text-xs">
                    <div className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800">
                      <span className="text-slate-400 block text-[11px]">Геолокация / Точность</span>
                      <span className="font-mono font-bold text-white text-sm">
                        {lastReport.distanceMeters} м (±{lastReport.gpsAccuracyMeters} м)
                      </span>
                    </div>

                    <div className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800">
                      <span className="text-slate-400 block text-[11px]">Снимков / Совпадений</span>
                      <span className="font-mono font-bold text-white text-sm">
                        {lastReport.matchedFramesCount} из {lastReport.snapshotsRequested} кадров
                      </span>
                    </div>

                    <div className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800">
                      <span className="text-slate-400 block text-[11px]">Числовой Score (Порог {status.config.similarityThreshold})</span>
                      <span className="font-mono font-bold text-emerald-300 text-sm">
                        {lastReport.similarityScore != null
                          ? lastReport.similarityScore.toFixed(4)
                          : '—'}
                      </span>
                    </div>

                    <div className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800">
                      <span className="text-slate-400 block text-[11px]">Вердикт Liveness / CV</span>
                      <span className="font-mono font-bold text-white text-xs">
                        {lastReport.faceOutcome || 'НЕ ТРЕБОВАЛОСЬ'}
                      </span>
                    </div>
                  </div>

                  {/* Step-by-step FSM trace */}
                  <div className="space-y-1.5 pt-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Трассировка состояний FSM ({lastReport.stateHistory.length} этапов)
                    </div>
                    <div className="max-h-56 overflow-y-auto space-y-1 pr-1">
                      {lastReport.stateHistory.map((step, idx) => (
                        <div
                          key={`${step.state}_${idx}`}
                          className="flex items-start gap-2 text-xs p-2 rounded-lg bg-slate-950/60 border border-slate-800/80"
                        >
                          <span className="px-1.5 py-0.5 rounded bg-slate-800 text-emerald-300 font-mono text-[10px] shrink-0">
                            {step.state}
                          </span>
                          <span className="text-slate-300 text-[11px] leading-snug">{step.note}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: LOCAL ON-DEVICE BIOMETRICS (ANDROID KEYSTORE) */}
      {activeSubTab === 'biometrics' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-6 bg-slate-900/70 border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Fingerprint className="w-5 h-5 text-emerald-400" />
                Локальное хранилище шаблона на Poco X6 Pro
              </h3>
              <span className="px-2.5 py-1 rounded-md text-xs font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                AndroidKeyStore (Local Only)
              </span>
            </div>

            <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2.5 text-xs">
              <div className="flex justify-between py-1 border-b border-slate-800/80">
                <span className="text-slate-400">Статус локального шаблона:</span>
                <span className="font-semibold text-emerald-300">
                  {localBioInfo.enrolled
                    ? 'Создан и зашифрован на устройстве'
                    : 'Шаблон удалён с устройства'}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-800/80">
                <span className="text-slate-400">Место хранения:</span>
                <span className="font-semibold text-white">{localBioInfo.storageLocation}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-800/80">
                <span className="text-slate-400">Передача шаблона или фото на VPS:</span>
                <span className="font-bold text-emerald-400">
                  ЗАПРЕЩЕНО (0 байт на сервере)
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-800/80">
                <span className="text-slate-400">Модель признаков:</span>
                <span className="font-mono text-emerald-300">
                  {localBioInfo.algorithm || 'MobileFaceNet-128D-L2 (TFLite FP16)'}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-slate-400">Исходные фотографии:</span>
                <span className="text-slate-300">
                  Удаляются из памяти сразу после расчёта embedding
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                onClick={handleDeleteBiometricsLocally}
                disabled={!localBioInfo.enrolled || busyAction !== null}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 bg-rose-500/15 hover:bg-rose-500/25 text-rose-200 border border-rose-500/30 disabled:opacity-40 transition cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                Удалить локальный шаблон с устройства
              </button>

              <button
                onClick={handleTestVpsZeroBiometricsGuard}
                disabled={busyAction !== null}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-sky-300 border border-sky-500/30 transition cursor-pointer"
              >
                <ShieldCheck className="w-4 h-4" />
                Проверить блокировку отправки фото на VPS
              </button>
            </div>
          </div>

          <div className="lg:col-span-6 bg-slate-900/70 border border-slate-800 rounded-2xl p-5 space-y-4">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Upload className="w-5 h-5 text-emerald-400" />
              Локальная регистрация лица (Раздел 6.1 ТЗ)
            </h3>
            <p className="text-xs text-slate-400">
              Сделайте или выберите несколько фотографий при разном освещении и ракурсах. Проверка
              качества, извлечение 128-мерного шаблона и сохранение выполняются локально на устройстве без
              отправки на VPS.
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Имя профиля пользователя
                </label>
                <input
                  type="text"
                  value={enrollLabel}
                  onChange={(e) => setEnrollLabel(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap gap-2.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-2 cursor-pointer"
                >
                  <Upload className="w-4 h-4 text-emerald-400" />
                  Выбрать фото на устройстве ({uploadedPhotos.length}/5)
                </button>

                <button
                  type="button"
                  onClick={handleAddCalibratedOwnerSamples}
                  className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-500/30 flex items-center gap-2 cursor-pointer"
                >
                  <Sparkles className="w-4 h-4" />
                  Сгенерировать 3 тестовых ракурса владельца
                </button>
              </div>

              <button
                type="button"
                onClick={handleEnrollBiometricsLocally}
                disabled={busyAction !== null}
                className="w-full py-2.5 rounded-xl text-xs font-bold bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/10 transition cursor-pointer"
              >
                Создать шаблон локально на устройстве (Удалить исходные фото после создания)
              </button>

              {enrollReports.length > 0 && (
                <div className="space-y-1.5 pt-2">
                  <div className="text-xs font-semibold text-slate-300">
                    Результат локальной проверки качества снимков:
                  </div>
                  {enrollReports.map((rep) => (
                    <div
                      key={rep.index}
                      className={`p-2 rounded-lg text-xs border flex items-center justify-between ${
                        rep.passed
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                          : 'bg-rose-500/10 border-rose-500/30 text-rose-200'
                      }`}
                    >
                      <span>
                        Ракурс #{rep.index}: {rep.passed ? 'Принят' : rep.reason || 'Отклонён'}
                      </span>
                      <span className="font-mono text-[11px]">
                        Резкость: {rep.sharpness} · Яркость: {rep.brightness} · Лицо: {Math.round(rep.faceAreaRatio * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: GEOFENCE, SNAPSHOT POLLING & CV SETTINGS */}
      {activeSubTab === 'settings' && (
        <form
          onSubmit={handleSaveSettings}
          className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 space-y-6"
        >
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Settings className="w-5 h-5 text-emerald-400" />
                Настройки геозоны (20м/50м), частоты получения снимков (2с/10 кадров) и распознавания
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Все параметры синхронизируются с Android-приложением Poco X6 Pro.
              </p>
            </div>
            <button
              type="submit"
              disabled={busyAction !== null}
              className="px-5 py-2.5 rounded-xl text-xs font-bold bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition cursor-pointer"
            >
              Сохранить настройки
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-300">
                Радиус входа в геозону (м)
              </label>
              <input
                type="number"
                min={5}
                max={100}
                value={entryRadius}
                onChange={(e) => setEntryRadius(Number(e.target.value))}
                className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white font-mono"
              />
              <p className="text-[11px] text-slate-400">По ТЗ: 20 метров (старт получения снимков)</p>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-300">
                Радиус выхода из геозоны (м)
              </label>
              <input
                type="number"
                min={15}
                max={300}
                value={exitRadius}
                onChange={(e) => setExitRadius(Number(e.target.value))}
                className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white font-mono"
              />
              <p className="text-[11px] text-slate-400">По ТЗ: 50 метров (сброс блокировки входа)</p>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-300">
                Макс. погрешность GPS (Accuracy, м)
              </label>
              <input
                type="number"
                min={5}
                max={60}
                value={maxAccuracy}
                onChange={(e) => setMaxAccuracy(Number(e.target.value))}
                className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white font-mono"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-300">
                Интервал между снимками камеры (сек)
              </label>
              <input
                type="number"
                min={1}
                max={10}
                value={snapshotInterval}
                onChange={(e) => setSnapshotInterval(Number(e.target.value))}
                className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white font-mono"
              />
              <p className="text-[11px] text-slate-400">По ТЗ (Раздел 5): 2 секунды</p>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-300">
                Макс. количество снимков одной попытки
              </label>
              <input
                type="number"
                min={3}
                max={20}
                value={maxSnapshots}
                onChange={(e) => setMaxSnapshots(Number(e.target.value))}
                className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white font-mono"
              />
              <p className="text-[11px] text-slate-400">По ТЗ (Раздел 5): до 10 снимков</p>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-300">
                Минимум пригодных совпавших кадров
              </label>
              <input
                type="number"
                min={2}
                max={10}
                value={minMatchedFrames}
                onChange={(e) => setMinMatchedFrames(Number(e.target.value))}
                className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white font-mono"
              />
              <p className="text-[11px] text-slate-400">По ТЗ (Раздел 6.3): минимум 3 кадра</p>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-300">
                Выбранная камера калитки
              </label>
              <select
                value={selectedCameraId}
                onChange={(e) => setSelectedCameraId(e.target.value)}
                className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white"
              >
                {cameras.map((cam) => (
                  <option key={cam.id} value={cam.id}>
                    {cam.name} ({cam.id})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-300">
                Выбранная калитка / точка доступа
              </label>
              <select
                value={selectedLockId}
                onChange={(e) => setSelectedLockId(e.target.value)}
                className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white"
              >
                {locks.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} (AC #{l.accessControlId})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-300">
                Политика при недоступности VPS (Раздел 15)
              </label>
              <select
                value={vpsOfflinePolicy}
                onChange={(e) => setVpsOfflinePolicy(e.target.value as VpsOfflinePolicy)}
                className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white"
              >
                <option value="FAIL_CLOSED">Строгий Fail-Closed (Не открывать без проверки VPS)</option>
                <option value="AUTONOMOUS_DIRECT_DOMRU">
                  Автономный прямой вызов API Дом.ру с телефона после локальных проверок
                </option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-300">
                Порог совпадения (Score Threshold): {similarityThreshold.toFixed(2)}
              </label>
              <input
                type="range"
                min={0.65}
                max={0.95}
                step={0.01}
                value={similarityThreshold}
                onChange={(e) => setSimilarityThreshold(Number(e.target.value))}
                className="w-full accent-emerald-500"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-300">
                Пауза Cooldown после открытия (сек)
              </label>
              <input
                type="number"
                min={5}
                max={300}
                value={cooldownSeconds}
                onChange={(e) => setCooldownSeconds(Number(e.target.value))}
                className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white font-mono"
              />
            </div>
          </div>
        </form>
      )}

      {/* TAB 4: AUDIT LOG TABLE */}
      {activeSubTab === 'logs' && (
        <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Database className="w-4 h-4 text-emerald-400" />
                Журнал всех операций (Раздел 16 ТЗ — без OAuth-токенов, фото и биометрии)
              </h3>
              <p className="text-xs text-slate-400">
                Содержит все этапы операции: Вход в геозону → Проверка GPS → Получение снимка →
                Обнаружение лица → Распознавание → Проверка подлинности → Проверка разрешения → Команда открытия.
              </p>
            </div>
            <button
              onClick={handleClearLogs}
              disabled={busyAction !== null}
              className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 cursor-pointer"
            >
              Очистить журнал
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 uppercase text-[11px]">
                  <th className="py-2.5 px-3">Время</th>
                  <th className="py-2.5 px-3">Этап FSM</th>
                  <th className="py-2.5 px-3">Событие</th>
                  <th className="py-2.5 px-3">Результат</th>
                  <th className="py-2.5 px-3">Детали</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {status.auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-800/30">
                    <td className="py-2.5 px-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleTimeString('ru-RU')}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-emerald-300 whitespace-nowrap">
                      {log.stage}
                    </td>
                    <td className="py-2.5 px-3 font-semibold text-slate-200 whitespace-nowrap">
                      {log.event}
                    </td>
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          log.result === 'SUCCESS'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : log.result === 'OBSERVATION_ONLY'
                            ? 'bg-amber-500/20 text-amber-300'
                            : log.result === 'DENIED'
                            ? 'bg-rose-500/20 text-rose-300'
                            : 'bg-slate-800 text-slate-300'
                        }`}
                      >
                        {log.result}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-slate-300">{log.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 5: POCO X6 PRO PERFORMANCE & BATTERY BENCHMARK */}
      {activeSubTab === 'benchmark' && (
        <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-800 pb-4">
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Cpu className="w-5 h-5 text-emerald-400" />
                Сравнительное тестирование моделей CV на Poco X6 Pro (MediaTek Dimensity 8300-Ultra)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Раздел 6 и 14 ТЗ: оценка времени получения снимка, детекции лица, извлечения признаков,
                Liveness, потребления RAM, загрузки CPU и расхода аккумулятора.
              </p>
            </div>
            <button
              onClick={handleRunBenchmark}
              disabled={busyAction !== null}
              className="px-5 py-2.5 rounded-xl text-xs font-bold bg-emerald-500 hover:bg-emerald-400 text-slate-950 flex items-center gap-2 transition cursor-pointer shrink-0"
            >
              <Play className="w-4 h-4" />
              Загрузить результаты измерений Poco X6 Pro
            </button>
          </div>

          {!benchmarkComparison ? (
            <div className="p-8 text-center text-slate-400 text-xs border border-dashed border-slate-800 rounded-xl">
              Нажмите кнопку выше, чтобы отобразить сравнительную таблицу протестированных мобильных
              моделей распознавания лиц для MediaTek Dimensity 8300-Ultra.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-500/30 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div>
                  <span className="text-slate-400">Целевое устройство: </span>
                  <strong className="text-white">{benchmarkComparison.deviceModel}</strong> ·{' '}
                  <span className="text-emerald-300">{benchmarkComparison.socModel}</span>
                </div>
                <div className="flex items-center gap-1.5 text-emerald-300 font-semibold">
                  <BatteryCharging className="w-4 h-4" />
                  Выбранный стек: {benchmarkComparison.selectedStack}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 uppercase text-[11px]">
                      <th className="py-2.5 px-3">Архитектура / Стек моделей</th>
                      <th className="py-2.5 px-3">Ускоритель</th>
                      <th className="py-2.5 px-3">1 снимок HTTP</th>
                      <th className="py-2.5 px-3">Детекция лица</th>
                      <th className="py-2.5 px-3">Embedding</th>
                      <th className="py-2.5 px-3">Liveness</th>
                      <th className="py-2.5 px-3">Полный сценарий (3 кадра)</th>
                      <th className="py-2.5 px-3">RAM / CPU</th>
                      <th className="py-2.5 px-3">Батарея / проход</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {benchmarkComparison.pipelines.map((p) => (
                      <tr
                        key={p.id}
                        className={
                          p.recommended ? 'bg-emerald-500/10 border-l-2 border-l-emerald-400' : ''
                        }
                      >
                        <td className="py-3 px-3 font-semibold text-white">
                          {p.name}
                          {p.recommended && (
                            <span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-500 text-slate-950 text-[10px] font-bold">
                              ВЫБРАНО
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-slate-300">{p.accelerator}</td>
                        <td className="py-3 px-3 font-mono text-slate-200">{p.snapshotFetchMs} мс</td>
                        <td className="py-3 px-3 font-mono text-emerald-300">{p.faceDetectMs} мс</td>
                        <td className="py-3 px-3 font-mono text-emerald-300">{p.embeddingExtractMs} мс</td>
                        <td className="py-3 px-3 font-mono text-emerald-300">{p.livenessMs} мс</td>
                        <td className="py-3 px-3 font-mono font-bold text-white">
                          {p.threeFramesScenarioMs} мс
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-300">
                          {p.ramFootprintMb} МБ / {p.cpuLoadPct}%
                        </td>
                        <td className="py-3 px-3 font-mono text-emerald-300">
                          {p.batteryDrainPerApproachMah} мА·ч (&lt;0.01%)
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 6: ANDROID KOTLIN CODE & HYPEROS GUIDE */}
      {activeSubTab === 'android' && (
        <div className="space-y-6">
          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Smartphone className="w-5 h-5 text-emerald-400" />
                Android-архитектура для Poco X6 Pro (Kotlin · Android 16 · HyperOS 2.0)
              </h3>
              <span className="text-xs font-mono text-emerald-300 bg-emerald-500/10 px-3 py-1 rounded-lg border border-emerald-500/30">
                Прямой доступ Android → API Дом.ру + Синхронизация статуса с VPS
              </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                <div className="text-xs font-bold text-emerald-300 mb-2 flex items-center gap-1.5">
                  <FileCode className="w-4 h-4" />
                  1. LocalFaceRecognitionEngine.kt (TFLite FP16 NNAPI + AndroidKeyStore)
                </div>
                <pre className="text-[11px] font-mono text-slate-300 overflow-x-auto leading-relaxed">
{`class LocalFaceRecognitionEngine(context: Context) {
  // MediaTek Dimensity 8300-Ultra APU 780 acceleration via NNAPI / GPU
  private val options = Interpreter.Options().apply {
    setUseNNAPI(true)
    setAllowFp16PrecisionForFp32(true)
    setNumThreads(4)
  }
  private val mobileFaceNet = Interpreter(loadModel(context, "mobilefacenet_fp16.tflite"), options)
  private val antiSpoofNet = Interpreter(loadModel(context, "minifasnet_v2.tflite"), options)

  fun processSnapshotAndRecycle(jpegBytes: ByteArray): FrameCvOutcome {
    val bitmap = BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.size)
      ?: return FrameCvOutcome.InvalidQuality
    try {
      val quality = evaluateSharpnessAndBrightness(bitmap)
      if (!quality.passed) return FrameCvOutcome.LowQuality(quality)
      val faces = blazeFaceDetector.detect(bitmap)
      if (faces.isEmpty()) return FrameCvOutcome.NoFaceDetected
      if (faces.size > 1) return FrameCvOutcome.MultipleFaces(faces.size)

      val aligned = cropAndAlign112x112(bitmap, faces.first())
      val liveness = runMiniFasNet(aligned)
      val embedding = extract128dL2Embedding(aligned)
      aligned.recycle()
      return FrameCvOutcome.Success(embedding, liveness, quality)
    } finally {
      // Mandatory memory release after each frame (Section 5 & 14)
      bitmap.recycle()
    }
  }
}`}
                </pre>
              </div>

              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                <div className="text-xs font-bold text-emerald-300 mb-2 flex items-center gap-1.5">
                  <FileCode className="w-4 h-4" />
                  2. DomRuDirectApiClient.kt (Прямой опрос снимков 2с/10 кадров + открытие)
                </div>
                <pre className="text-[11px] font-mono text-slate-300 overflow-x-auto leading-relaxed">
{`suspend fun pollSnapshotsAndVerify(cfg: AutoAccessConfig): CvSummary {
  var matchedConsecutive = 0
  for (attempt in 1..cfg.maxSnapshotsPerAttempt) { // max 10
    val jpeg = fetchDomRuSnapshotDirect(
      cameraId = cfg.targetCameraId,
      placeId = cfg.targetPlaceId,
      acId = cfg.targetAccessControlId,
      entranceId = cfg.targetEntranceId,
      width = 640, height = 360
    )
    val outcome = cvEngine.processSnapshotAndRecycle(jpeg)
    if (outcome is FrameCvOutcome.Success) {
      val score = cosineSimilarity(outcome.embedding, loadKeystoreTemplate())
      if (score >= cfg.similarityThreshold && outcome.liveness >= 0.85f) {
        matchedConsecutive++
        if (matchedConsecutive >= cfg.minMatchedFrames) { // min 3 frames
          return CvSummary.Recognized(score, matchedConsecutive, attempt)
        }
      } else {
        matchedConsecutive = 0
      }
    }
    if (attempt < cfg.maxSnapshotsPerAttempt) delay(cfg.snapshotIntervalSeconds * 1000L) // 2000ms
  }
  return CvSummary.Failed
}`}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
