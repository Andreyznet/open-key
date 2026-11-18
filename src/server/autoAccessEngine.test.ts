import assert from 'assert';
import {
  AutoAccessVpsController,
  assertNoBiometricOrSecretPayload,
  calculateDistanceMeters,
} from './autoAccessEngine.ts';
import {
  enrollOnDeviceFacePhotos,
  executeOnDeviceCvPipeline,
  getOrInitLocalBiometricTemplate,
} from '../utils/mobileOnDeviceCvEngine.ts';

async function runTests() {
  console.log('=== DomRu Lab (Poco X6 Pro On-Device CV + Zero-Biometrics VPS) Verification Suite ===\n');

  // 1. Haversine Geofence Entry (20m) & Exit (50m) Distance Calculation
  const centerLat = 55.0485;
  const centerLon = 82.9168;
  const lat12m = Number((centerLat + 12 / 111320).toFixed(6));
  const lat65m = Number((centerLat + 65 / 111320).toFixed(6));
  const dist12m = calculateDistanceMeters(centerLat, centerLon, lat12m, centerLon);
  assert(dist12m >= 11.5 && dist12m <= 12.5, `Expected ~12m, got ${dist12m}`);
  console.log(`[PASS] 1. Geofence distance calculation: entry=${dist12m.toFixed(2)}m (<=20m)`);

  // 2. Local On-Device Biometric Enrollment (Poco X6 Pro AndroidKeyStore simulation)
  const localEnroll = enrollOnDeviceFacePhotos('Андрей Семёнов (Poco X6 Pro)', [
    'DEMO_SYNTHETIC_FACE:owner:enroll1:brightness=127:sharpness=48:shift=0',
    'DEMO_SYNTHETIC_FACE:owner:enroll2:brightness=131:sharpness=52:shift=1',
    'DEMO_SYNTHETIC_FACE:owner:enroll3:brightness=124:sharpness=46:shift=2',
  ]);
  assert(localEnroll.ok, 'Local on-device face enrollment must succeed');
  const localTemplate = getOrInitLocalBiometricTemplate();
  assert(localTemplate.enrolled && localTemplate.vector?.length === 128, 'Local 128-D template must exist');
  console.log(`[PASS] 2. Local on-device biometric enrollment (128-D MobileFaceNet, 0 bytes on VPS)`);

  // 3. Zero-Biometrics VPS Security Guard (Rejects photos, embeddings, templates, secrets)
  const guardPhoto = assertNoBiometricOrSecretPayload({
    deviceId: 'Poco_X6_Pro',
    photos: ['data:image/jpeg;base64,/9j/4AAQ'],
  });
  assert(guardPhoto.safe === false, 'VPS must reject raw photos');

  const guardEmbedding = assertNoBiometricOrSecretPayload({
    deviceId: 'Poco_X6_Pro',
    embedding: [0.12, -0.34, 0.56],
  });
  assert(guardEmbedding.safe === false, 'VPS must reject biometric embeddings');
  console.log(`[PASS] 3. Zero-Biometrics VPS Guard actively blocks photo & embedding uploads`);

  // 4. Initialize VPS Controller & verify Observation Mode (Section 13)
  const vps = new AutoAccessVpsController();
  const token = vps.getStatus().deviceTokenFull;
  assert(vps.getStatus().vpsStoresBiometrics === false, 'VPS must report vpsStoresBiometrics=false');

  // Execute On-Device CV on Poco X6 Pro for 3 valid owner frames
  const ownerCvSummary = executeOnDeviceCvPipeline({
    frames: [
      'DEMO_SYNTHETIC_FACE:owner:frame1:brightness=126:sharpness=45:shift=0',
      'DEMO_SYNTHETIC_FACE:owner:frame2:brightness=128:sharpness=47:shift=2',
      'DEMO_SYNTHETIC_FACE:owner:frame3:brightness=125:sharpness=46:shift=4',
    ],
    similarityThreshold: 0.82,
    minMatchedFrames: 3,
    enrolledVector: localTemplate.vector,
  });
  assert(ownerCvSummary.faceOutcome === 'FACE_RECOGNIZED', 'Owner must be recognized locally');
  assert(ownerCvSummary.matchedFramesCount === 3, 'Must match 3 consecutive frames');

  let openCalled = false;
  const obsReport = await vps.processAndroidTelemetryAndValidateAccess(
    {
      telemetry: {
        deviceId: 'Poco_X6_Pro_2311DRK48G',
        deviceModel: 'Xiaomi Poco X6 Pro',
        socModel: 'MediaTek Dimensity 8300-Ultra',
        androidVersion: 'Android 16',
        deviceToken: token,
        nonce: 'nonce_obs_1',
        timestampMs: Date.now() - 35000,
        latitude: lat12m,
        longitude: centerLon,
        accuracy: 5.4,
        eventType: 'ENTER',
        onDeviceCvResult: ownerCvSummary,
      },
    },
    {
      verifyLockAccess: async () => ({ allowOpen: true, lockName: 'Калитка' }),
      executeOpenDoorCommand: async () => {
        openCalled = true;
        return { commandSent: true, apiAccepted: true, httpStatus: 200, message: '' };
      },
    }
  );
  assert(obsReport.observationMode === true && !obsReport.commandSent && !openCalled);
  console.log(
    `[PASS] 4. Observation Mode (Section 13): score=${ownerCvSummary.similarityScore}, commandSent=false`
  );

  // 5. Exit Geofence (>50m) resets Hysteresis Latch
  const exitReport = await vps.processAndroidTelemetryAndValidateAccess(
    {
      telemetry: {
        deviceId: 'Poco_X6_Pro_2311DRK48G',
        deviceModel: 'Xiaomi Poco X6 Pro',
        socModel: 'MediaTek Dimensity 8300-Ultra',
        androidVersion: 'Android 16',
        deviceToken: token,
        nonce: 'nonce_exit_1',
        timestampMs: Date.now() - 30000,
        latitude: lat65m,
        longitude: centerLon,
        accuracy: 6.0,
        eventType: 'EXIT',
      },
    },
    {
      verifyLockAccess: async () => ({ allowOpen: true, lockName: 'Калитка' }),
      executeOpenDoorCommand: async () => ({ commandSent: false, apiAccepted: false, httpStatus: 0, message: '' }),
    }
  );
  assert(exitReport.finalState === 'OUTSIDE_GEOFENCE' && !vps.getStatus().insideGeofenceLatch);
  console.log(`[PASS] 5. Geofence Exit (>50m) transitions to OUTSIDE_GEOFENCE and resets latch`);

  // 6. Single-Frame Match Forbidden (Section 6.3: < 3 matched frames must NOT open)
  vps.updateConfig({ observationMode: false }); // Switch to Active Mode
  const singleFrameCv = executeOnDeviceCvPipeline({
    frames: ['DEMO_SYNTHETIC_FACE:owner:frame1:brightness=126:sharpness=45:shift=0'],
    similarityThreshold: 0.82,
    minMatchedFrames: 3,
    enrolledVector: localTemplate.vector,
  });
  const singleFrameReport = await vps.processAndroidTelemetryAndValidateAccess(
    {
      telemetry: {
        deviceId: 'Poco_X6_Pro_2311DRK48G',
        deviceModel: 'Xiaomi Poco X6 Pro',
        socModel: 'MediaTek Dimensity 8300-Ultra',
        androidVersion: 'Android 16',
        deviceToken: token,
        nonce: 'nonce_single_frame',
        timestampMs: Date.now() - 10000,
        latitude: lat12m,
        longitude: centerLon,
        accuracy: 5.2,
        eventType: 'ENTER',
        onDeviceCvResult: singleFrameCv,
      },
    },
    {
      verifyLockAccess: async () => ({ allowOpen: true, lockName: 'Калитка' }),
      executeOpenDoorCommand: async () => ({ commandSent: true, apiAccepted: true, httpStatus: 200, message: '' }),
    }
  );
  assert(singleFrameReport.finalState === 'FAILED' && !singleFrameReport.commandSent);
  console.log(`[PASS] 6. Single-frame match rejected (requires >= 3 matched consecutive frames)`);

  // 7. Static Single-Snapshot Camera Fallback to Manual Notification (Section 7)
  const staticCamCv = executeOnDeviceCvPipeline({
    frames: [
      'DEMO_SYNTHETIC_FACE:owner:frame1:brightness=126:sharpness=45:shift=0',
      'DEMO_SYNTHETIC_FACE:owner:frame2:brightness=128:sharpness=47:shift=2',
      'DEMO_SYNTHETIC_FACE:owner:frame3:brightness=125:sharpness=46:shift=4',
    ],
    similarityThreshold: 0.82,
    minMatchedFrames: 3,
    cameraOnlyStaticSingleFrame: true,
    enrolledVector: localTemplate.vector,
  });
  const staticCamReport = await vps.processAndroidTelemetryAndValidateAccess(
    {
      telemetry: {
        deviceId: 'Poco_X6_Pro_2311DRK48G',
        deviceModel: 'Xiaomi Poco X6 Pro',
        socModel: 'MediaTek Dimensity 8300-Ultra',
        androidVersion: 'Android 16',
        deviceToken: token,
        nonce: 'nonce_static_cam',
        timestampMs: Date.now() - 8000,
        latitude: lat12m,
        longitude: centerLon,
        accuracy: 5.2,
        eventType: 'ENTER',
        onDeviceCvResult: staticCamCv,
      },
    },
    {
      verifyLockAccess: async () => ({ allowOpen: true, lockName: 'Калитка' }),
      executeOpenDoorCommand: async () => ({ commandSent: true, apiAccepted: true, httpStatus: 200, message: '' }),
    }
  );
  assert(
    staticCamReport.finalState === 'FAILED' &&
      staticCamReport.faceOutcome === 'MANUAL_CONFIRMATION_REQUIRED' &&
      !staticCamReport.commandSent
  );
  console.log(`[PASS] 7. Static camera blocks auto-open and requires manual confirmation (Section 7)`);

  // 8. 2D Photo Spoof Rejection (LIVENESS_FAILED)
  const spoofCv = executeOnDeviceCvPipeline({
    frames: [
      'DEMO_SYNTHETIC_FACE:spoof_static:frame1:brightness=126:sharpness=45:shift=0',
      'DEMO_SYNTHETIC_FACE:spoof_static:frame1:brightness=126:sharpness=45:shift=0',
      'DEMO_SYNTHETIC_FACE:spoof_static:frame1:brightness=126:sharpness=45:shift=0',
    ],
    similarityThreshold: 0.82,
    minMatchedFrames: 3,
    enrolledVector: localTemplate.vector,
  });
  assert(spoofCv.faceOutcome === 'LIVENESS_FAILED' && !spoofCv.livenessPassed);
  console.log(`[PASS] 8. On-device Anti-Spoofing rejects 2D static photo (LIVENESS_FAILED)`);

  // 9. Stranger Rejection (FACE_UNRECOGNIZED)
  const strangerCv = executeOnDeviceCvPipeline({
    frames: [
      'DEMO_SYNTHETIC_FACE:stranger:frame1:brightness=122:sharpness=42:shift=0',
      'DEMO_SYNTHETIC_FACE:stranger:frame2:brightness=124:sharpness=43:shift=2',
      'DEMO_SYNTHETIC_FACE:stranger:frame3:brightness=121:sharpness=41:shift=4',
    ],
    similarityThreshold: 0.82,
    minMatchedFrames: 3,
    enrolledVector: localTemplate.vector,
  });
  assert(strangerCv.faceOutcome === 'FACE_UNRECOGNIZED');
  console.log(`[PASS] 9. On-device MobileFaceNet rejects stranger (score=${strangerCv.similarityScore})`);

  // 10. Active Mode Full Valid Entry -> Checks allowOpen, sends accessControlOpen, enters COOLDOWN
  const activeReport = await vps.processAndroidTelemetryAndValidateAccess(
    {
      telemetry: {
        deviceId: 'Poco_X6_Pro_2311DRK48G',
        deviceModel: 'Xiaomi Poco X6 Pro',
        socModel: 'MediaTek Dimensity 8300-Ultra',
        androidVersion: 'Android 16',
        deviceToken: token,
        nonce: 'nonce_active_open_1',
        timestampMs: Date.now(),
        latitude: lat12m,
        longitude: centerLon,
        accuracy: 5.0,
        eventType: 'ENTER',
        onDeviceCvResult: ownerCvSummary,
      },
    },
    {
      verifyLockAccess: async () => ({ allowOpen: true, lockName: 'Калитка · Вход со двора' }),
      executeOpenDoorCommand: async () => ({
        commandSent: true,
        apiAccepted: true,
        httpStatus: 200,
        message: 'Команда принята, состояние калитки неизвестно',
      }),
    }
  );
  assert(activeReport.commandSent && activeReport.apiAccepted && activeReport.finalState === 'COOLDOWN');
  console.log(
    `[PASS] 10. Active Mode full pipeline: allowOpen verified, commandSent=true, state=COOLDOWN`
  );

  // 11. Emergency Stop
  vps.emergencyStop('Test Emergency Stop');
  assert(vps.getStatus().fsmState === 'DISABLED');
  console.log(`[PASS] 11. Emergency Stop transitions immediately to DISABLED`);

  // 12. Poco X6 Pro (Dimensity 8300-Ultra) Benchmark Comparison
  const bench = vps.getPocoX6ProBenchmarkComparison();
  assert(bench.pipelines.length === 3 && bench.pipelines[0].recommended);
  console.log(`\n[PASS] 12. Poco X6 Pro (Dimensity 8300-Ultra) Selected Stack Metrics:`);
  console.log(JSON.stringify(bench.pipelines[0], null, 2));
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
