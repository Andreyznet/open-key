export interface UserAgentState {
  phone_manufacturer: string;
  phone_model: string;
  android_ver: string;
  app_version: { name: string; code: string };
  account_id: string;
  operator_id: string;
  uuid: string;
  place_id: string;
}

export interface ContractItem {
  accountId: string | number;
  subscriberId: string | number;
  address: string;
  operatorId: number | string;
  placeId: number | string;
}

export interface SubscriberProfile {
  id?: number | string;
  accountId?: string | number;
  name?: string;
  phone?: string;
}

export interface PlaceItem {
  id: string;
  subscriberId?: number | string;
  subscriberType?: string;
  subscriberState?: string;
  address: string;
  rawAddress?: Record<string, any>;
  location?: { longitude: number; latitude: number } | null;
}

export interface BalanceInfo {
  placeId: string;
  balance: number | null;
  blockType?: string | null;
  blocked?: boolean;
  paymentDate?: string | null;
  paymentSum?: number | null;
  paymentLink?: string | null;
  daysToBlock?: number | null;
  company?: string | null;
}

export interface LockItem {
  id: string;
  placeId: string;
  placeAddress: string;
  accessControlId: string;
  entranceId: string | null;
  name: string;
  acName: string;
  openable: boolean;
  allowVideo: boolean;
  externalCameraId: string | null;
  hidden: boolean;
  favorite: boolean;
  kind?: 'door' | 'gate' | 'barrier';
  controllerType?: 'intercom' | 'esp32';
  esp32Channel?: 1 | 2;
}

export interface CameraItem {
  id: string;
  name: string;
  originalName?: string;
  placeId: string;
  placeAddress: string;
  accessControlId: string | null;
  entranceId: string | null;
  source: 'intercom' | 'place' | 'public';
  hidden: boolean;
  favorite: boolean;
  timeZone: number;
  retentionDays: number;
  allowOpen: boolean;
  videoDownloadAvailable: boolean;
  demoScene?: 'entrance' | 'gate' | 'barrier' | 'elevator' | 'playground' | 'parking';
}

export interface CameraEventItem {
  id: string;
  cameraId: string;
  backendCameraId: string;
  timestamp: number; // Unix seconds UTC
  duration: number; // Seconds
  eventSubjectId: number;
  available: boolean;
  gotoEnabled: boolean;
  message: string | null;
}

export interface HistoryEventItem {
  id: string;
  placeId: string;
  eventType: string;
  timestamp: number; // Unix ms or s
  sourceType: string;
  sourceId: string;
  message: string;
  cameraId?: string | null;
  accessControlId?: string | null;
  entranceId?: string | null;
}

export interface DndItem {
  type: 'DO_NOT_DISTURB_ROOT' | 'INTERCOM_CALLS' | 'MANAGEMENT_COMPANY_CALLS' | string;
  name: string;
  status: boolean;
  hint?: string;
  editable?: boolean;
}

export interface GuestPassControlOption {
  id: number;
  name: string;
  originalName?: string;
  entranceId?: string | null;
  cameraId?: string | null;
  roleName?: string;
}

export interface TempPassItem {
  id: number | string;
  sharedLinkMessage?: string;
  label?: string;
  source?: 'personal' | 'operator';
  status?: string;
  createdAt?: number;
  expiredAt?: number | string;
  openCount?: number;
  lastOpenedAt?: number | null;
  availableAccessControl?: GuestPassControlOption[];
}

export interface DoorActionLog {
  id: string;
  lockId: string;
  lockName: string;
  placeAddress: string;
  timestamp: number;
  status: 'success' | 'error';
  message: string;
}

export interface EgSession {
  mode: 'live' | 'demo';
  accessToken: string;
  refreshToken: string | null;
  operatorId: string;
  phone?: string;
  subscriber: SubscriberProfile;
  userAgent: UserAgentState;
}

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
  observationMode: boolean;
  geofenceCenterLat: number;
  geofenceCenterLon: number;
  entryRadiusMeters: number;
  exitRadiusMeters: number;
  maxGpsAccuracyMeters: number;
  maxSpeedJumpMps: number;
  maxTimestampDriftSeconds: number;
  snapshotIntervalSeconds: number;
  maxSnapshotsPerAttempt: number;
  minMatchedFrames: number;
  maxSnapshotAgeSeconds: number;
  targetPlaceId: string;
  targetCameraId: string;
  targetAccessControlId: string;
  targetEntranceId: string | null;
  targetLockName: string;
  similarityThreshold: number;
  requireLivenessMultiFrame: boolean;
  fallbackNotificationOnStaticCamera: boolean;
  vpsOfflinePolicy: VpsOfflinePolicy;
  cooldownSeconds: number;
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

export interface AutoAccessAuditLogEntry {
  id: string;
  timestamp: string;
  stage: AutoAccessFsmState | 'CONFIG' | 'BIOMETRICS_LOCAL' | 'SECURITY_GUARD' | 'EMERGENCY_STOP';
  event: string;
  result: 'SUCCESS' | 'DENIED' | 'WARNING' | 'INFO' | 'OBSERVATION_ONLY';
  details: string;
  metrics?: Record<string, number | string | boolean>;
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

export interface AutoAccessStatusPayload {
  architectureMode: 'ON_DEVICE_ANDROID_CV';
  vpsStoresBiometrics: false;
  vpsProcessesVideoFrames: false;
  targetDeviceProfile: {
    deviceModel: string;
    socModel: string;
    osVersion: string;
  };
  fsmState: AutoAccessFsmState;
  insideGeofenceLatch: boolean;
  cooldownRemainingSeconds: number;
  config: AutoAccessConfig;
  lastLocation: {
    lat: number;
    lon: number;
    accuracy: number;
    timestampMs: number;
    distanceMeters: number;
    deviceModel?: string;
    batteryPct?: number;
  } | null;
  lastReport: AutoAccessPipelineReport | null;
  auditLogs: AutoAccessAuditLogEntry[];
  deviceTokenPreview: string;
  deviceTokenFull: string;
}

export type BillingSubscriptionStatus = 'trial' | 'active' | 'expired' | 'blocked';

export interface BillingUserRecord {
  userId: string;
  phone: string;
  accountId: string;
  subscriberId?: string;
  name: string;
  address: string;
  role: 'admin' | 'user';
  balanceRub: number;
  status: BillingSubscriptionStatus;
  autoRenew: boolean;
  trialEndsAt: number;
  paidUntil: number | null;
  createdAt: number;
  lastSeenAt: number;
  notes: string;
}

export interface BillingTransaction {
  id: string;
  userId: string;
  userName: string;
  userPhone: string;
  type: 'topup' | 'subscription_charge' | 'manual_adjust' | 'refund';
  status: 'completed' | 'pending' | 'rejected';
  amountRub: number;
  description: string;
  paymentChannel: 'sbp' | 'yookassa_npd' | 'manual' | 'auto_renew' | 'system';
  npdReceiptStatus: 'issued' | 'pending' | 'not_required';
  npdReceiptNumber?: string | null;
  yookassaPaymentId?: string | null;
  confirmationUrl?: string | null;
  createdAt: number;
}

export interface BillingConfig {
  monthlyPriceRub: number;
  trialDays: number;
  selfEmployedName: string;
  selfEmployedInn: string;
  sbpPhoneOrLink: string;
  paymentMethodLabel: string;
  npdTaxRatePct: number;
  supportEmail?: string;
  supportTelegram?: string;
  supportPhone?: string;
  supportHours?: string;
  sellerCity?: string;
  hasAdminPin?: boolean;
  yookassaEnabled?: boolean;
}

export interface BillingMePayload {
  user: BillingUserRecord;
  transactions: BillingTransaction[];
  config: BillingConfig;
}

export interface AdminOverviewPayload {
  users: BillingUserRecord[];
  transactions: BillingTransaction[];
  config: BillingConfig;
  stats: {
    totalUsers: number;
    activeUsers: number;
    trialUsers: number;
    expiredOrBlockedUsers: number;
    totalUserBalancesRub: number;
    revenueLast30DaysRub: number;
    npdTaxRub: number;
    netIncomeRub: number;
    pendingTopupsCount: number;
    unreceiptedPaymentsCount: number;
  };
}

export interface Esp32GateConfig {
  enabled: boolean;
  mode: 'poll' | 'http_direct' | 'hybrid';
  gate1HttpUrl: string;
  gate2HttpUrl: string;
  pulseDurationMs: number;
  deviceToken: string;
  gpioGate1Pin: number;
  gpioGate2Pin: number;
}

export interface Esp32GateStatusPayload {
  config: Esp32GateConfig;
  lastPollAt: number | null;
  pendingCommandsCount: number;
  recentTriggers: Array<{
    id: string;
    channel: 1 | 2;
    gateName: string;
    pulseMs: number;
    timestamp: number;
    deliveryMode: 'http_direct' | 'queued_poll';
    deliveredAt: number | null;
  }>;
}
