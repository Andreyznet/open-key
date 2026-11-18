import {
  AdminDomruUserProfile,
  AdminOverviewPayload,
  AdminSubscriberLogsPayload,
  AutoAccessConfig,
  AutoAccessPipelineReport,
  AutoAccessStatusPayload,
  BalanceInfo,
  BillingConfig,
  BillingMePayload,
  BillingSubscriptionStatus,
  BillingTransaction,
  CameraEventItem,
  CameraItem,
  ContractItem,
  DndItem,
  EgSession,
  Esp32GateConfig,
  Esp32GateStatusPayload,
  GuestPassControlOption,
  HistoryEventItem,
  LockItem,
  PlaceItem,
  PocoX6ProBenchmarkComparison,
  TempPassItem,
  UserAgentState,
} from '../types/eg';
import {
  deleteLocalBiometricTemplate,
  enrollOnDeviceFacePhotos,
  executeOnDeviceCvPipeline,
} from '../utils/mobileOnDeviceCvEngine';

const SESSION_STORAGE_KEY = 'eg_home_portal_session_v1';
const UA_STORAGE_KEY = 'eg_home_portal_ua_v1';

export function getOrCreateUserAgent(): UserAgentState {
  try {
    const raw = localStorage.getItem(UA_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.uuid) {
        return {
          ...parsed,
          app_version: { name: '9.11.0', code: '91100000' },
        };
      }
    }
  } catch {
    // ignore
  }

  const models = ['Pixel 8 Pro', 'Pixel 9', 'Pixel 9 Pro', 'Pixel 9 Pro XL'];
  const model = models[Math.floor(Math.random() * models.length)];
  const ua: UserAgentState = {
    phone_manufacturer: 'Google',
    phone_model: model,
    android_ver: '16',
    app_version: { name: '9.11.0', code: '91100000' },
    account_id: '',
    operator_id: '1',
    uuid: crypto.randomUUID ? crypto.randomUUID() : 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    place_id: 'null',
  };
  saveUserAgent(ua);
  return ua;
}

export function saveUserAgent(ua: UserAgentState): void {
  try {
    localStorage.setItem(UA_STORAGE_KEY, JSON.stringify(ua));
  } catch {
    // ignore
  }
}

export function loadSavedSession(): EgSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EgSession;
    if (parsed?.mode === 'demo') {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: EgSession | null): void {
  try {
    if (!session) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } else if (session.mode !== 'demo') {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      if (session.userAgent) {
        saveUserAgent(session.userAgent);
      }
    }
  } catch {
    // ignore
  }
}

function encodeUaHeader(ua: UserAgentState): string {
  try {
    return btoa(unescape(encodeURIComponent(JSON.stringify(ua))));
  } catch {
    return '';
  }
}

function buildHeaders(session?: EgSession | null, customUa?: UserAgentState): Record<string, string> {
  const ua = session?.userAgent || customUa || getOrCreateUserAgent();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-eg-ua': encodeUaHeader(ua),
  };
  if (session?.accessToken) {
    headers['x-eg-token'] = session.accessToken;
  }
  if (session?.operatorId) {
    headers['x-eg-operator'] = session.operatorId;
  }
  return headers;
}

function notifySubscriptionRestricted(status: number, data: any) {
  if (typeof window === 'undefined') return;
  if (status === 402 || data?.error === 'subscription_required') {
    window.dispatchEvent(
      new CustomEvent('eg-subscription-restricted', {
        detail: {
          status: data?.status || 'blocked',
          message: data?.message || 'Доступ к этой функции ограничен',
        },
      })
    );
  }
}

async function safeFetchJson(
  url: string,
  init: RequestInit,
  maxRetries: number = 2
): Promise<{ ok: boolean; status: number; data: any }> {
  let lastError: string = 'Сервер временно недоступен';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);
      const rawText = await res.text();
      let parsed: any = null;
      if (rawText && rawText.trim().length > 0) {
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = null;
        }
      }

      if (parsed !== null && typeof parsed === 'object') {
        if (!res.ok) {
          notifySubscriptionRestricted(res.status, parsed);
        }
        return { ok: res.ok, status: res.status, data: parsed };
      }

      // Received HTML/non-JSON (e.g. 502/503/504 gateway page or aborted connection)
      lastError =
        res.status >= 500
          ? `Сервер видеопотока временно занят (HTTP ${res.status})`
          : 'Некорректный ответ сервера, попробуйте переподключить';
    } catch (err: any) {
      lastError = err?.message || 'Ошибка сетевого соединения';
    }

    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 450 * (attempt + 1)));
    }
  }

  return {
    ok: false,
    status: 502,
    data: { message: lastError },
  };
}

// --- Authentication API ---

export async function apiLoginPhone(phone: string): Promise<{
  phone: string;
  passwordRequired: boolean;
  contracts: ContractItem[];
  userAgent: UserAgentState;
}> {
  const ua = getOrCreateUserAgent();
  const res = await fetch('/api/eg/auth/login-phone', {
    method: 'POST',
    headers: buildHeaders(null, ua),
    body: JSON.stringify({ phone }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка проверки номера телефона');
  }
  return data;
}

export async function apiVerifyPassword(phone: string, password: string): Promise<EgSession> {
  const ua = getOrCreateUserAgent();
  const res = await fetch('/api/eg/auth/verify-password', {
    method: 'POST',
    headers: buildHeaders(null, ua),
    body: JSON.stringify({ phone, password }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Неверный пароль');
  }
  const session: EgSession = {
    mode: 'live',
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || null,
    operatorId: String(data.operatorId || '1'),
    phone,
    subscriber: data.subscriber || {},
    userAgent: data.userAgent || ua,
  };
  saveSession(session);
  return session;
}

export async function apiRequestSms(phone: string, contract: ContractItem): Promise<void> {
  const ua = getOrCreateUserAgent();
  const res = await fetch('/api/eg/auth/request-sms', {
    method: 'POST',
    headers: buildHeaders(null, ua),
    body: JSON.stringify({ phone, contract }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Не удалось отправить СМС');
  }
}

export async function apiVerifySms(
  phone: string,
  contract: ContractItem,
  code: string
): Promise<EgSession> {
  const ua = getOrCreateUserAgent();
  const res = await fetch('/api/eg/auth/verify-sms', {
    method: 'POST',
    headers: buildHeaders(null, ua),
    body: JSON.stringify({ phone, contract, code }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Неверный код подтверждения');
  }
  const session: EgSession = {
    mode: 'live',
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || null,
    operatorId: String(data.operatorId || contract.operatorId || '1'),
    phone,
    subscriber: data.subscriber || {},
    userAgent: data.userAgent || ua,
  };
  saveSession(session);
  return session;
}

export async function apiVerifyToken(
  accessToken: string,
  operatorId: string = '1',
  customUaJson?: string
): Promise<EgSession> {
  let ua = getOrCreateUserAgent();
  if (customUaJson && customUaJson.trim()) {
    try {
      const parsed = JSON.parse(customUaJson);
      ua = { ...ua, ...parsed, app_version: { name: '9.11.0', code: '91100000' } };
    } catch {
      throw new Error('Некорректный JSON в поле User-Agent');
    }
  }
  const res = await fetch('/api/eg/auth/verify-token', {
    method: 'POST',
    headers: buildHeaders(null, ua),
    body: JSON.stringify({ accessToken, operatorId }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Токен недействителен');
  }
  const session: EgSession = {
    mode: 'live',
    accessToken: data.accessToken,
    refreshToken: null,
    operatorId: String(data.operatorId || operatorId || '1'),
    subscriber: data.subscriber || {},
    userAgent: data.userAgent || ua,
  };
  saveSession(session);
  return session;
}

export async function apiLogout(
  session: EgSession,
  reason: 'manual' | 'session_expired' = 'manual'
): Promise<void> {
  if (!session || session.mode === 'demo') return;
  try {
    await fetch('/api/eg/auth/logout', {
      method: 'POST',
      headers: buildHeaders(session),
      keepalive: true,
      body: JSON.stringify({
        reason,
        ...buildBillingIdentity(session),
      }),
    });
  } catch {
    // Non-blocking logout notification
  }
}

// --- Demo Stand Session & Data ---

export function createDemoSession(): EgSession {
  const baseUa = getOrCreateUserAgent();
  const ua: UserAgentState = {
    ...baseUa,
    account_id: '2094815',
    operator_id: '1',
    place_id: '482910',
  };
  return {
    mode: 'demo',
    accessToken: 'demo_ntk_token_2094815',
    refreshToken: 'demo_refresh_token',
    operatorId: '1',
    phone: '79139004512',
    subscriber: {
      id: 894120,
      accountId: '2094815',
      name: 'Андрей Семёнов',
      phone: '79139004512',
    },
    userAgent: ua,
  };
}

export interface SyncPayload {
  subscriber: any;
  places: PlaceItem[];
  balances: Record<string, BalanceInfo>;
  locks: LockItem[];
  cameras: CameraItem[];
  cameraAliases?: Record<string, string>;
  dnd: Record<string, DndItem[]>;
}

function getCameraAliasesStorageKey(session: EgSession): string {
  const userKey =
    session.phone ||
    (session.subscriber?.accountId ? String(session.subscriber.accountId) : '') ||
    session.userAgent?.account_id ||
    'default';
  return `openkey_camera_aliases_v1_${session.mode}_${userKey}`;
}

export function loadLocalCameraAliases(session: EgSession): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(getCameraAliasesStorageKey(session));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveLocalCameraAliases(
  session: EgSession,
  aliases: Record<string, string>
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(getCameraAliasesStorageKey(session), JSON.stringify(aliases));
  } catch {
    // ignore storage quota errors
  }
}

function getDemoSyncPayload(session: EgSession): SyncPayload {
  const place1Id = '482910';
  const place2Id = '519044';
  const addr1 = 'г. Новосибирск, Красный проспект, д. 102, кв. 45';
  const addr2 = 'г. Новосибирск, ул. Орджоникидзе, д. 38, кв. 12';

  const places: PlaceItem[] = [
    {
      id: place1Id,
      subscriberId: 894120,
      subscriberType: 'OWNER',
      subscriberState: 'ACTIVE',
      address: addr1,
      location: { latitude: 55.0485, longitude: 82.9168 },
    },
    {
      id: place2Id,
      subscriberId: 894121,
      subscriberType: 'OWNER',
      subscriberState: 'ACTIVE',
      address: addr2,
      location: { latitude: 55.0312, longitude: 82.9274 },
    },
  ];

  const balances: Record<string, BalanceInfo> = {
    [place1Id]: {
      placeId: place1Id,
      balance: 845.5,
      blocked: false,
      paymentDate: '2026-12-01',
      paymentSum: 650.0,
      company: 'ООО «Новотелеком» (Электронный город)',
      daysToBlock: 27,
    },
    [place2Id]: {
      placeId: place2Id,
      balance: 420.0,
      blocked: false,
      paymentDate: '2026-12-01',
      paymentSum: 390.0,
      company: 'ООО «Новотелеком» (Электронный город)',
      daysToBlock: 27,
    },
  };

  const locks: LockItem[] = [
    {
      id: 'lock_482910_9101_101',
      placeId: place1Id,
      placeAddress: addr1,
      accessControlId: '9101',
      entranceId: '101',
      name: 'Калитка 1 - 3-Й Мкр 6 б',
      acName: 'Домофон · Калитка №1',
      openable: true,
      allowVideo: true,
      externalCameraId: 'forpost_cam_101',
      hidden: false,
      favorite: true,
      kind: 'gate',
      controllerType: 'intercom',
    },
    {
      id: 'lock_482910_9101_102',
      placeId: place1Id,
      placeAddress: addr1,
      accessControlId: '9101',
      entranceId: '102',
      name: 'Калитка 2 - 3-Й Мкр 6 б',
      acName: 'Домофон · Калитка №2',
      openable: true,
      allowVideo: true,
      externalCameraId: 'forpost_cam_102',
      hidden: false,
      favorite: true,
      kind: 'gate',
      controllerType: 'intercom',
    },
    {
      id: 'lock_482910_9102_103',
      placeId: place1Id,
      placeAddress: addr1,
      accessControlId: '9102',
      entranceId: '103',
      name: '3-Й Мкр 6 б (п. 2)',
      acName: 'Домофон подъезда №2',
      openable: true,
      allowVideo: true,
      externalCameraId: 'forpost_cam_103',
      hidden: false,
      favorite: true,
      kind: 'door',
      controllerType: 'intercom',
    },
    {
      id: 'lock_esp32_482910_gate_1',
      placeId: place1Id,
      placeAddress: addr1,
      accessControlId: '990001',
      entranceId: 'esp32_gate_1',
      name: 'Камера фасад 1 - 3-Й Мкр 6 б',
      acName: 'Ворота №1',
      openable: true,
      allowVideo: true,
      externalCameraId: 'forpost_cam_facade_1',
      hidden: false,
      favorite: true,
      kind: 'gate',
      controllerType: 'esp32',
      esp32Channel: 1,
    },
    {
      id: 'lock_esp32_482910_gate_2',
      placeId: place1Id,
      placeAddress: addr1,
      accessControlId: '990002',
      entranceId: 'esp32_gate_2',
      name: 'Камера фасад 2 - 3-Й Мкр 6 б',
      acName: 'Ворота №2',
      openable: true,
      allowVideo: true,
      externalCameraId: 'forpost_cam_facade_2',
      hidden: false,
      favorite: true,
      kind: 'gate',
      controllerType: 'esp32',
      esp32Channel: 2,
    },
  ];

  const cameras: CameraItem[] = [
    {
      id: 'forpost_cam_101',
      name: 'Калитка 1 - 3-Й Мкр 6 б',
      placeId: place1Id,
      placeAddress: addr1,
      accessControlId: '9101',
      entranceId: '101',
      source: 'intercom',
      hidden: false,
      favorite: true,
      timeZone: 25200,
      retentionDays: 7,
      allowOpen: true,
      videoDownloadAvailable: true,
      demoScene: 'gate',
    },
    {
      id: 'forpost_cam_102',
      name: 'Калитка 2 - 3-Й Мкр 6 б',
      placeId: place1Id,
      placeAddress: addr1,
      accessControlId: '9101',
      entranceId: '102',
      source: 'intercom',
      hidden: false,
      favorite: true,
      timeZone: 25200,
      retentionDays: 7,
      allowOpen: true,
      videoDownloadAvailable: true,
      demoScene: 'gate',
    },
    {
      id: 'forpost_cam_103',
      name: '3-Й Мкр 6 б (п. 2)',
      placeId: place1Id,
      placeAddress: addr1,
      accessControlId: '9102',
      entranceId: '103',
      source: 'intercom',
      hidden: false,
      favorite: true,
      timeZone: 25200,
      retentionDays: 7,
      allowOpen: true,
      videoDownloadAvailable: true,
      demoScene: 'entrance',
    },
    {
      id: 'forpost_cam_facade_1',
      name: 'Камера фасад 1 - 3-Й Мкр 6 б',
      placeId: place1Id,
      placeAddress: addr1,
      accessControlId: '990001',
      entranceId: 'esp32_gate_1',
      source: 'public',
      hidden: false,
      favorite: true,
      timeZone: 25200,
      retentionDays: 7,
      allowOpen: true,
      videoDownloadAvailable: true,
      demoScene: 'barrier',
    },
    {
      id: 'forpost_cam_facade_2',
      name: 'Камера фасад 2 - 3-Й Мкр 6 б',
      placeId: place1Id,
      placeAddress: addr1,
      accessControlId: '990002',
      entranceId: 'esp32_gate_2',
      source: 'public',
      hidden: false,
      favorite: true,
      timeZone: 25200,
      retentionDays: 7,
      allowOpen: true,
      videoDownloadAvailable: true,
      demoScene: 'parking',
    },
    {
      id: 'forpost_cam_104',
      name: 'Лифт №1 · Пассажирский (Подъезд 2)',
      placeId: place1Id,
      placeAddress: addr1,
      accessControlId: null,
      entranceId: null,
      source: 'public',
      hidden: false,
      favorite: false,
      timeZone: 25200,
      retentionDays: 7,
      allowOpen: false,
      videoDownloadAvailable: true,
      demoScene: 'elevator',
    },
    {
      id: 'forpost_cam_105',
      name: 'Двор · Детская площадка',
      placeId: place1Id,
      placeAddress: addr1,
      accessControlId: null,
      entranceId: null,
      source: 'public',
      hidden: false,
      favorite: false,
      timeZone: 25200,
      retentionDays: 7,
      allowOpen: false,
      videoDownloadAvailable: true,
      demoScene: 'playground',
    },
  ];

  const dnd: Record<string, DndItem[]> = {
    [place1Id]: [
      {
        type: 'DO_NOT_DISTURB_ROOT',
        name: 'Не беспокоить (общий режим)',
        status: false,
        hint: 'Отключает входящие вызовы с домофона на смартфон',
        editable: true,
      },
      {
        type: 'INTERCOM_CALLS',
        name: 'Звонки с домофона',
        status: false,
        hint: 'Блокировать видеовызовы с панели подъезда и калиток',
        editable: true,
      },
      {
        type: 'MANAGEMENT_COMPANY_CALLS',
        name: 'Информирование от УК',
        status: false,
        hint: 'Звонки и голосовые оповещения от управляющей компании',
        editable: true,
      },
    ],
    [place2Id]: [
      {
        type: 'DO_NOT_DISTURB_ROOT',
        name: 'Не беспокоить (общий режим)',
        status: false,
        hint: 'Отключает входящие вызовы с домофона на смартфон',
        editable: true,
      },
      {
        type: 'INTERCOM_CALLS',
        name: 'Звонки с домофона',
        status: false,
        hint: '',
        editable: true,
      },
      {
        type: 'MANAGEMENT_COMPANY_CALLS',
        name: 'Информирование от УК',
        status: false,
        hint: '',
        editable: true,
      },
    ],
  };

  const demoAliases = loadLocalCameraAliases(session);
  const camerasWithAliases = cameras.map((cam) => {
    const alias = demoAliases[cam.id];
    return {
      ...cam,
      originalName: cam.name,
      name: alias && alias.trim() ? alias.trim() : cam.name,
    };
  });

  return {
    subscriber: session.subscriber,
    places,
    balances,
    locks,
    cameras: camerasWithAliases,
    cameraAliases: demoAliases,
    dnd,
  };
}

export async function apiSyncDashboard(session: EgSession): Promise<SyncPayload> {
  if (session.mode === 'demo') {
    await new Promise((r) => setTimeout(r, 180));
    return getDemoSyncPayload(session);
  }

  const res = await fetch('/api/eg/sync', {
    method: 'GET',
    headers: buildHeaders(session),
  });

  if (res.status === 401) {
    throw new Error('UNAUTHORIZED');
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка синхронизации с сервером Электронный Город');
  }

  if (data.userAgent) {
    saveUserAgent(data.userAgent);
  }

  if (data.cameraAliases && typeof data.cameraAliases === 'object') {
    saveLocalCameraAliases(session, data.cameraAliases);
  }

  return data;
}

export async function apiRenameCamera(
  session: EgSession,
  cameraId: string,
  newName: string
): Promise<{ cameraId: string; alias: string | null; aliases: Record<string, string> }> {
  const cleanName = newName.trim().slice(0, 80);

  if (session.mode === 'demo') {
    const current = loadLocalCameraAliases(session);
    if (!cleanName) {
      delete current[cameraId];
    } else {
      current[cameraId] = cleanName;
    }
    saveLocalCameraAliases(session, current);
    return { cameraId, alias: cleanName || null, aliases: current };
  }

  const res = await fetch('/api/eg/cameras/alias', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify({ cameraId, name: cleanName }),
  });

  const data = await res.json();
  if (!res.ok) {
    notifySubscriptionRestricted(res.status, data);
    throw new Error(data?.message || 'Не удалось сохранить название камеры');
  }

  const nextAliases: Record<string, string> =
    data?.aliases && typeof data.aliases === 'object' ? data.aliases : loadLocalCameraAliases(session);
  saveLocalCameraAliases(session, nextAliases);

  return {
    cameraId,
    alias: data?.alias ?? (cleanName || null),
    aliases: nextAliases,
  };
}

export async function apiOpenLock(
  session: EgSession,
  lock: {
    placeId: string;
    accessControlId: string;
    entranceId: string | null;
    lockName?: string;
    placeAddress?: string;
  }
): Promise<{ ok: boolean; timestamp: string }> {
  if (session.mode === 'demo') {
    await new Promise((r) => setTimeout(r, 320));
    return { ok: true, timestamp: new Date().toISOString() };
  }

  const res = await fetch('/api/eg/locks/open', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify({
      placeId: lock.placeId,
      accessControlId: lock.accessControlId,
      entranceId: lock.entranceId,
      lockName: lock.lockName,
      placeAddress: lock.placeAddress,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    notifySubscriptionRestricted(res.status, data);
    throw new Error(data?.message || 'Не удалось открыть замок');
  }
  return data;
}

export function buildSnapshotUrl(
  session: EgSession,
  cameraId: string,
  placeId: string,
  cacheBuster: number,
  width: number = 1280,
  height: number = 720,
  options?: {
    accessControlId?: string | null;
    entranceId?: string | null;
  }
): string {
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    placeId,
    operator: session.operatorId || '1',
    token: session.accessToken,
    _t: String(cacheBuster),
  });
  if (options?.accessControlId) {
    params.set('accessControlId', options.accessControlId);
  }
  if (options?.entranceId) {
    params.set('entranceId', options.entranceId);
  }
  return `/api/eg/cameras/${encodeURIComponent(cameraId)}/snapshot?${params.toString()}`;
}

export async function apiGetCameraStream(
  session: EgSession,
  cameraId: string,
  placeId: string,
  archiveTimestampSec?: number | null,
  tzSeconds: number = 25200,
  speed?: number
): Promise<{
  cameraId: string;
  mode: 'live' | 'archive';
  ts: number | null;
  upstreamUrl: string;
  proxyFlvUrl: string;
}> {
  if (session.mode === 'demo') {
    await new Promise((r) => setTimeout(r, 150));
    return {
      cameraId,
      mode: archiveTimestampSec ? 'archive' : 'live',
      ts: archiveTimestampSec || null,
      upstreamUrl: `https://forpost-15.novotelecom.ru:18081/rtsp/${cameraId}/demo_token/d=1`,
      proxyFlvUrl: `demo://${cameraId}`,
    };
  }

  const params = new URLSearchParams({
    placeId,
    tz: String(tzSeconds),
  });
  if (archiveTimestampSec != null) {
    params.set('ts', String(Math.floor(archiveTimestampSec)));
    // Keep server-side Forpost stream at native full-framerate (-1.0); client <video>.playbackRate handles 0.5x..4x cleanly without keyframe-only skipping
    params.set('speed', speed != null && speed < 0 ? String(speed) : '-1.0');
  } else if (speed != null && Number.isFinite(speed)) {
    params.set('speed', speed === 1 ? '-1.0' : String(speed));
  }

  const { ok, data } = await safeFetchJson(
    `/api/eg/cameras/${encodeURIComponent(cameraId)}/stream?${params.toString()}`,
    {
      method: 'GET',
      headers: buildHeaders(session),
    },
    2
  );
  if (!ok) {
    const err: any = new Error(data?.message || 'Не удалось получить видеопоток');
    if (typeof data?.minAvailableTs === 'number' && Number.isFinite(data.minAvailableTs)) {
      err.minAvailableTs = data.minAvailableTs;
    }
    if (typeof data?.minAvailableLabel === 'string') {
      err.minAvailableLabel = data.minAvailableLabel;
    }
    throw err;
  }
  return data;
}

export interface CameraEventsPage {
  events: CameraEventItem[];
  hasMore: boolean;
}

export async function apiGetCameraEvents(
  session: EgSession,
  cameraId: string,
  placeId: string,
  dayIsoDate: string, // YYYY-MM-DD
  options?: {
    upperTimestampSec?: number | null;
    count?: number;
  }
): Promise<CameraEventsPage> {
  const count = Math.max(10, Math.min(100, options?.count ?? 100));
  const dayStart = new Date(`${dayIsoDate}T00:00:00`);
  const dayStartSec = Math.floor(dayStart.getTime() / 1000);
  const dayEndSec = dayStartSec + 86399;
  const effectiveUpperSec =
    options?.upperTimestampSec != null
      ? Math.min(dayEndSec, Math.floor(options.upperTimestampSec))
      : dayEndSec;

  if (session.mode === 'demo') {
    await new Promise((r) => setTimeout(r, 160));
    const nowSec = Math.floor(Date.now() / 1000);
    const maxSec = Math.min(effectiveUpperSec, nowSec);
    const descs = [
      'Движение у входа · Выход жильца',
      'Движение в кадре · Курьерская доставка',
      'Открытие двери ключом / брелоком',
      'Движение у калитки · Проход посетителя',
      'Видеовызов домофона · Открытие из приложения',
      'Движение в зоне парковки · Автомобиль',
    ];

    const allEvents: CameraEventItem[] = [];
    // Generate events spanning 00:08 to 23:55 (~130+ events per full day) to support full pagination
    for (let m = 8; m < 1435; m += 11) {
      const ts = dayStartSec + m * 60 + ((m * 17) % 55);
      if (ts <= maxSec && ts >= dayStartSec) {
        allEvents.push({
          id: `ev_${cameraId}_${dayIsoDate.replace(/-/g, '')}_${m}`,
          cameraId,
          backendCameraId: cameraId,
          timestamp: ts,
          duration: 28 + ((m * 7) % 65),
          eventSubjectId: 126,
          available: true,
          gotoEnabled: true,
          message: descs[m % descs.length],
        });
      }
    }

    allEvents.sort((a, b) => b.timestamp - a.timestamp);
    const page = allEvents.slice(0, count);
    return {
      events: page,
      hasMore: allEvents.length > count,
    };
  }

  const lowerDate = new Date(dayStartSec * 1000).toISOString();
  const upperDate = new Date(effectiveUpperSec * 1000).toISOString();

  const params = new URLSearchParams({
    lowerDate,
    upperDate,
    placeId,
    count: String(count),
  });

  const { ok, data } = await safeFetchJson(
    `/api/eg/cameras/${encodeURIComponent(cameraId)}/events?${params.toString()}`,
    {
      method: 'GET',
      headers: buildHeaders(session),
    },
    2
  );
  if (!ok) {
    throw new Error(data?.message || 'Ошибка загрузки событий архива');
  }
  const events: CameraEventItem[] = Array.isArray(data.events) ? data.events : [];
  return {
    events,
    hasMore: Boolean(data.hasMore),
  };
}

export function buildEventClipUrl(
  session: EgSession,
  eventId: string,
  download: boolean = false,
  extra?: {
    cameraId?: string;
    placeId?: string;
    ts?: number | null;
    duration?: number | null;
    tz?: number | null;
  }
): string {
  const ua = session.userAgent || getOrCreateUserAgent();
  const params = new URLSearchParams({
    token: session.accessToken,
    operator: session.operatorId || '1',
    ua: encodeUaHeader(ua),
  });
  if (extra?.cameraId) {
    params.set('cameraId', extra.cameraId);
  }
  if (extra?.placeId) {
    params.set('placeId', extra.placeId);
  }
  if (extra?.ts != null && extra.ts > 0) {
    params.set('ts', String(Math.floor(extra.ts)));
  }
  if (extra?.duration != null && extra.duration > 0) {
    params.set('duration', String(Math.round(extra.duration)));
  }
  if (extra?.tz != null && Number.isFinite(extra.tz)) {
    params.set('tz', String(Math.round(extra.tz)));
  }
  if (download) {
    params.set('download', '1');
  }
  return `/api/eg/events/${encodeURIComponent(eventId)}/clip?${params.toString()}`;
}

export async function downloadArchiveVideoMp4(
  session: EgSession,
  options: {
    eventId?: string | null;
    cameraId: string;
    placeId: string;
    timestampSec?: number | null;
    durationSec?: number | null;
    tz?: number | null;
  }
): Promise<string> {
  const ts = options.timestampSec || Math.floor(Date.now() / 1000) - 300;
  const dur = Math.max(4, Math.min(300, Math.round(options.durationSec || 30)));
  const resolvedEventId = options.eventId || `ts_${Math.floor(ts)}`;
  const url = buildEventClipUrl(session, resolvedEventId, true, {
    cameraId: options.cameraId,
    placeId: options.placeId,
    ts,
    duration: dur,
    tz: options.tz,
  });

  const res = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(session),
  });

  if (!res.ok) {
    let errText = 'Не удалось скачать видео из архива';
    try {
      const errJson = await res.json();
      notifySubscriptionRestricted(res.status, errJson);
      if (errJson?.message) errText = errJson.message;
    } catch {
      notifySubscriptionRestricted(res.status, null);
    }
    throw new Error(errText);
  }

  const blob = await res.blob();
  if (!blob || blob.size < 256) {
    throw new Error('Сервер вернул пустой видеофайл');
  }

  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const timeTag = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const filename = options.eventId
    ? `archive-cam-${options.cameraId}-${resolvedEventId}.mp4`
    : `archive-cam-${options.cameraId}-${timeTag}_${dur}s.mp4`;
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
  return filename;
}

export interface PlaceHistoryPage {
  events: HistoryEventItem[];
  page: number;
  hasMore: boolean;
  totalElements: number;
}

export async function apiGetPlaceHistoryPage(
  session: EgSession,
  placeIds: string[],
  page: number = 0
): Promise<PlaceHistoryPage> {
  if (!placeIds || placeIds.length === 0) {
    return { events: [], page: 0, hasMore: false, totalElements: 0 };
  }

  if (session.mode === 'demo') {
    await new Promise((r) => setTimeout(r, 120));
    const nowSec = Math.floor(Date.now() / 1000);
    if (page === 0) {
      const demoEvents: HistoryEventItem[] = [
        {
          id: 'demo_hist_1',
          placeId: placeIds[0],
          eventType: 'DOOR_OPEN',
          timestamp: nowSec - 18 * 60,
          sourceType: 'ACCESS_CONTROL',
          sourceId: '9101',
          cameraId: 'forpost_cam_101',
          message: 'Открыта дверь «Подъезд 1 · Главный вход»',
        },
        {
          id: 'demo_hist_2',
          placeId: placeIds[0],
          eventType: 'CALL',
          timestamp: nowSec - 65 * 60,
          sourceType: 'INTERCOM',
          sourceId: '9101',
          cameraId: 'forpost_cam_102',
          message: 'Видеовызов: Калитка · Вход со двора',
        },
        {
          id: 'demo_hist_3',
          placeId: placeIds[0],
          eventType: 'GATE_OPEN',
          timestamp: nowSec - 140 * 60,
          sourceType: 'ACCESS_CONTROL',
          sourceId: '9102',
          cameraId: 'forpost_cam_103',
          message: 'Открыты ворота · Северный въезд',
        },
        {
          id: 'demo_hist_4',
          placeId: placeIds[0],
          eventType: 'MISSED_CALL',
          timestamp: nowSec - 6 * 3600,
          sourceType: 'INTERCOM',
          sourceId: '9101',
          cameraId: 'forpost_cam_101',
          message: 'Пропущенный вызов с домофона «Подъезд 1 · Главный вход»',
        },
        {
          id: 'demo_hist_5',
          placeId: placeIds[0],
          eventType: 'TEMP_PASS',
          timestamp: nowSec - 12 * 3600,
          sourceType: 'SYSTEM',
          sourceId: '0',
          message: 'Ссылка на временный доступ успешно создана',
        },
        {
          id: 'demo_hist_6',
          placeId: placeIds[0],
          eventType: 'CALL',
          timestamp: nowSec - 28 * 3600,
          sourceType: 'INTERCOM',
          sourceId: '9101',
          cameraId: 'forpost_cam_102',
          message: 'Вызов с домофона «Калитка · Вход со двора»',
        },
        {
          id: 'demo_hist_7',
          placeId: placeIds[0],
          eventType: 'PAYMENT',
          timestamp: nowSec - 52 * 3600,
          sourceType: 'BILLING',
          sourceId: '0',
          message: 'Платёж по лицевому счёту успешно зачислен',
        },
        {
          id: 'demo_hist_8',
          placeId: placeIds[0],
          eventType: 'MISSED_CALL',
          timestamp: nowSec - 76 * 3600,
          sourceType: 'INTERCOM',
          sourceId: '9101',
          cameraId: 'forpost_cam_101',
          message: 'Пропущенный вызов с домофона «Подъезд 1 · Главный вход»',
        },
      ];
      return { events: demoEvents, page: 0, hasMore: true, totalElements: 12 };
    }
    if (page === 1) {
      return {
        events: [
          {
            id: 'demo_hist_9',
            placeId: placeIds[0],
            eventType: 'CALL',
            timestamp: nowSec - 96 * 3600,
            sourceType: 'INTERCOM',
            sourceId: '9101',
            cameraId: 'forpost_cam_102',
            message: 'Вызов с домофона «Калитка · Вход со двора»',
          },
          {
            id: 'demo_hist_10',
            placeId: placeIds[0],
            eventType: 'DOOR_OPEN',
            timestamp: nowSec - 120 * 3600,
            sourceType: 'ACCESS_CONTROL',
            sourceId: '9101',
            cameraId: 'forpost_cam_101',
            message: 'Доступ предоставлен к «Подъезд 1 · Главный вход»',
          },
        ],
        page: 1,
        hasMore: false,
        totalElements: 10,
      };
    }
    return { events: [], page, hasMore: false, totalElements: 10 };
  }

  try {
    const res = await fetch('/api/eg/events/history', {
      method: 'POST',
      headers: buildHeaders(session),
      body: JSON.stringify({ placeIds, page }),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      notifySubscriptionRestricted(res.status, errJson);
      return { events: [], page, hasMore: false, totalElements: 0 };
    }
    const data = await res.json();
    const list: any[] = Array.isArray(data?.events) ? data.events : [];
    const events: HistoryEventItem[] = list
      .filter((ev) => ev && ev.timestamp)
      .map((ev) => ({
        id: String(ev.id),
        placeId: String(ev.placeId || placeIds[0]),
        eventType: String(ev.eventType || ''),
        timestamp: Number(ev.timestamp),
        sourceType: String(ev.sourceType || ''),
        sourceId: String(ev.sourceId || ''),
        message: String(ev.message || ev.eventType || 'Событие доступа'),
        cameraId: ev.cameraId != null ? String(ev.cameraId) : null,
        accessControlId: ev.accessControlId != null ? String(ev.accessControlId) : null,
        entranceId: ev.entranceId != null ? String(ev.entranceId) : null,
      }));
    return {
      events,
      page: Number(data?.number ?? page),
      hasMore: !Boolean(data?.last ?? true) && events.length > 0,
      totalElements: Number(data?.totalElements ?? events.length),
    };
  } catch {
    return { events: [], page, hasMore: false, totalElements: 0 };
  }
}

export async function apiGetPlaceHistory(
  session: EgSession,
  placeIds: string[],
  page: number = 0
): Promise<HistoryEventItem[]> {
  const res = await apiGetPlaceHistoryPage(session, placeIds, page);
  return res.events;
}

export async function apiUpdateDnd(
  session: EgSession,
  placeId: string,
  items: DndItem[]
): Promise<boolean> {
  if (session.mode === 'demo') {
    await new Promise((r) => setTimeout(r, 150));
    return true;
  }

  const res = await fetch('/api/eg/dnd', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify({ placeId, items }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    notifySubscriptionRestricted(res.status, data);
    throw new Error(data?.message || 'Ошибка сохранения настроек');
  }
  return Boolean(data?.ok);
}

export async function apiGetTempPasses(
  session: EgSession,
  placeId: string
): Promise<{
  passes: TempPassItem[];
  availableAccessControls: GuestPassControlOption[];
  availableTtls: string[];
}> {
  if (session.mode === 'demo') {
    const res = await fetch(`/api/eg/temp-passes?placeId=${encodeURIComponent(placeId)}`, {
      method: 'GET',
      headers: buildHeaders(session),
    }).catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      return {
        passes: data.passes || [],
        availableAccessControls:
          data.availableAccessControls?.length > 0
            ? data.availableAccessControls
            : [
                { id: 9101, name: 'Калитка 1 - 3-Й Мкр 6 б', entranceId: '101', cameraId: 'forpost_cam_101' },
                { id: 9101, name: 'Калитка 2 - 3-Й Мкр 6 б', entranceId: '102', cameraId: 'forpost_cam_102' },
                { id: 9102, name: '3-Й Мкр 6 б (п. 2)', entranceId: '103', cameraId: 'forpost_cam_103' },
              ],
        availableTtls: data.availableTtls || ['3600', '14400', '43200', '86400', '604800', '2592000'],
      };
    }
    return {
      passes: [],
      availableAccessControls: [
        { id: 9101, name: 'Калитка 1 - 3-Й Мкр 6 б', entranceId: '101', cameraId: 'forpost_cam_101' },
        { id: 9101, name: 'Калитка 2 - 3-Й Мкр 6 б', entranceId: '102', cameraId: 'forpost_cam_102' },
        { id: 9102, name: '3-Й Мкр 6 б (п. 2)', entranceId: '103', cameraId: 'forpost_cam_103' },
      ],
      availableTtls: ['3600', '14400', '43200', '86400', '604800', '2592000'],
    };
  }

  const res = await fetch(`/api/eg/temp-passes?placeId=${encodeURIComponent(placeId)}`, {
    method: 'GET',
    headers: buildHeaders(session),
  });
  const data = await res.json();
  if (!res.ok) {
    notifySubscriptionRestricted(res.status, data);
    throw new Error(data?.message || 'Не удалось загрузить личные гостевые ссылки');
  }
  return {
    passes: data.passes || [],
    availableAccessControls: data.availableAccessControls || [],
    availableTtls: data.availableTtls || ['3600', '14400', '43200', '86400', '604800', '2592000'],
  };
}

export async function apiCreateTempPass(
  session: EgSession,
  placeId: string,
  ttl: string | number,
  accessControlIds: number[],
  options?: {
    accessControls?: GuestPassControlOption[];
    label?: string;
  }
): Promise<TempPassItem> {
  const numericTtl =
    ttl === 'ONE_HOUR'
      ? 3600
      : ttl === 'FOUR_HOURS'
        ? 14400
        : ttl === 'TWELVE_HOURS'
          ? 43200
          : ttl === 'ONE_DAY'
            ? 86400
            : Number(ttl) || 43200;

  const res = await fetch('/api/eg/temp-passes', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify({
      placeId,
      ttl: numericTtl,
      accessControlIds,
      accessControls: options?.accessControls,
      label: options?.label,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    notifySubscriptionRestricted(res.status, data);
    throw new Error(data?.message || 'Ошибка создания личной гостевой ссылки');
  }
  return data.pass;
}

export async function apiDeleteTempPass(
  session: EgSession,
  placeId: string,
  passId: string | number
): Promise<void> {
  const res = await fetch(
    `/api/eg/temp-passes/${encodeURIComponent(String(passId))}?placeId=${encodeURIComponent(placeId)}`,
    {
      method: 'DELETE',
      headers: buildHeaders(session),
    }
  );
  if (!res.ok && session.mode !== 'demo') {
    const data = await res.json().catch(() => null);
    notifySubscriptionRestricted(res.status, data);
    throw new Error(data?.message || 'Не удалось отозвать гостевую ссылку');
  }
}

export interface PublicGuestPassInfo {
  id: number;
  placeId: string;
  label?: string;
  status: string;
  expiredAt: number;
  availableAccessControl: Array<{
    id: number;
    name: string;
    entranceId?: string | null;
    cameraId?: string | null;
  }>;
}

export async function apiGetGuestPassInfo(token: string): Promise<PublicGuestPassInfo> {
  const res = await fetch(`/api/eg/guest-pass/${encodeURIComponent(token)}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Гостевая ссылка недействительна или истекла');
  }
  return data;
}

export async function apiOpenDoorByGuestPass(
  token: string,
  accessControlId: number,
  entranceId?: string | null
): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`/api/eg/guest-pass/${encodeURIComponent(token)}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessControlId, entranceId: entranceId ?? null }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Не удалось открыть дверь по гостевой ссылке');
  }
  return data;
}

// --- DomRu Lab Automatic Access by Geolocation & Face Recognition API ---

export async function apiGetAutoAccessStatus(
  session: EgSession
): Promise<AutoAccessStatusPayload> {
  const res = await fetch('/api/eg/auto-access/status', {
    method: 'GET',
    headers: buildHeaders(session),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка получения статуса Авто-доступа');
  }
  return data;
}

export async function apiUpdateAutoAccessConfig(
  session: EgSession,
  partialConfig: Partial<AutoAccessConfig>
): Promise<{ ok: boolean; config: AutoAccessConfig; status: AutoAccessStatusPayload }> {
  const res = await fetch('/api/eg/auto-access/config', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify(partialConfig),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка сохранения настроек Авто-доступа');
  }
  return data;
}

export async function apiEmergencyStopAutoAccess(
  session: EgSession,
  reason?: string
): Promise<{ ok: boolean; status: AutoAccessStatusPayload }> {
  const res = await fetch('/api/eg/auto-access/emergency-stop', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify({ reason }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка экстренной остановки');
  }
  return data;
}

export async function apiEnrollFaceBiometrics(
  session: EgSession,
  label: string,
  photos: string[]
): Promise<{
  ok: boolean;
  message: string;
  perPhotoReports: Array<{
    index: number;
    passed: boolean;
    sharpness: number;
    brightness: number;
    contrast: number;
    faceAreaRatio: number;
    reason?: string;
  }>;
  status: AutoAccessStatusPayload;
}> {
  // Section 6.1: Enrollment & template creation happens strictly locally on the Android device (never sent to VPS)
  const localRes = enrollOnDeviceFacePhotos(label, photos);
  if (!localRes.ok) {
    throw new Error(localRes.message);
  }
  const status = await apiGetAutoAccessStatus(session);
  return {
    ok: true,
    message: localRes.message,
    perPhotoReports: localRes.perPhotoReports,
    status,
  };
}

export async function apiDeleteFaceBiometrics(
  session: EgSession
): Promise<{ ok: boolean; message: string; status: AutoAccessStatusPayload }> {
  deleteLocalBiometricTemplate();
  const status = await apiGetAutoAccessStatus(session);
  return {
    ok: true,
    message: 'Биометрический шаблон удалён из локального хранилища AndroidKeyStore (на VPS шаблоны не хранятся)',
    status,
  };
}

export async function apiTriggerGeofenceEvent(
  session: EgSession,
  payload: {
    event: {
      latitude: number;
      longitude: number;
      accuracy: number;
      timestampMs: number;
      nonce: string;
      deviceToken: string;
      deviceId?: string;
      deviceModel?: string;
      socModel?: string;
      androidVersion?: string;
      batteryPct?: number;
      eventType?: 'ENTER' | 'EXIT' | 'PING';
    };
    localFramesForOnDeviceCv?: string[];
    cameraOnlyStaticSingleFrame?: boolean;
    similarityThreshold?: number;
    minMatchedFrames?: number;
    simulatedAllowOpen?: boolean;
  }
): Promise<{
  ok: boolean;
  report: AutoAccessPipelineReport;
  status: AutoAccessStatusPayload;
}> {
  // 1. Run Face Detection, Embedding Extraction, Cosine Matching & Liveness Locally on the Client Device (Poco X6 Pro)
  const framesToAnalyze = payload.localFramesForOnDeviceCv ?? [
    'DEMO_SYNTHETIC_FACE:owner:frame1:brightness=126:sharpness=45:shift=0',
    'DEMO_SYNTHETIC_FACE:owner:frame2:brightness=128:sharpness=47:shift=2',
    'DEMO_SYNTHETIC_FACE:owner:frame3:brightness=125:sharpness=46:shift=4',
  ];

  const onDeviceCvResult =
    payload.event.eventType === 'EXIT'
      ? undefined
      : executeOnDeviceCvPipeline({
          frames: framesToAnalyze,
          similarityThreshold: payload.similarityThreshold ?? 0.82,
          minMatchedFrames: payload.minMatchedFrames ?? 3,
          cameraOnlyStaticSingleFrame: payload.cameraOnlyStaticSingleFrame,
        });

  // 2. Transmit ONLY sanitized status & CV metrics to the VPS (Zero photos, Zero biometric templates!)
  const sanitizedTelemetry = {
    deviceId: payload.event.deviceId || 'Poco_X6_Pro_2311DRK48G',
    deviceModel: payload.event.deviceModel || 'Xiaomi Poco X6 Pro',
    socModel: payload.event.socModel || 'MediaTek Dimensity 8300-Ultra',
    androidVersion: payload.event.androidVersion || 'Android 16 (HyperOS 2.0)',
    deviceToken: payload.event.deviceToken,
    nonce: payload.event.nonce,
    timestampMs: payload.event.timestampMs,
    latitude: payload.event.latitude,
    longitude: payload.event.longitude,
    accuracy: payload.event.accuracy,
    eventType: payload.event.eventType || 'ENTER',
    batteryPct: payload.event.batteryPct ?? 86,
    onDeviceCvResult,
  };

  const res = await fetch('/api/eg/auto-access/geofence-event', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify({
      telemetry: sanitizedTelemetry,
      simulatedAllowOpen: payload.simulatedAllowOpen,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка обработки телеметрии на VPS');
  }
  return data;
}

export async function apiRunAutoAccessBenchmark(
  session: EgSession
): Promise<{
  ok: boolean;
  comparison: PocoX6ProBenchmarkComparison;
  status: AutoAccessStatusPayload;
}> {
  const res = await fetch('/api/eg/auto-access/benchmark', {
    method: 'POST',
    headers: buildHeaders(session),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка получения бенчмарка Poco X6 Pro');
  }
  return data;
}

export async function apiClearAutoAccessLogs(
  session: EgSession
): Promise<{ ok: boolean; status: AutoAccessStatusPayload }> {
  const res = await fetch('/api/eg/auto-access/logs/clear', {
    method: 'POST',
    headers: buildHeaders(session),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка очистки журнала');
  }
  return data;
}

// --- Commercial Billing (50 RUB/month) & Admin Panel API ---

function buildBillingIdentity(session: EgSession, primaryAddress?: string) {
  return {
    phone: session.subscriber?.phone || session.phone || '',
    accountId: session.subscriber?.accountId
      ? String(session.subscriber.accountId)
      : session.userAgent?.account_id || '',
    subscriberId: session.subscriber?.id != null ? String(session.subscriber.id) : '',
    name: session.subscriber?.name || '',
    address: primaryAddress || '',
  };
}

export async function apiGetBillingMe(
  session: EgSession,
  primaryAddress?: string
): Promise<BillingMePayload> {
  const res = await fetch('/api/eg/billing/me', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify(buildBillingIdentity(session, primaryAddress)),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Не удалось загрузить данные подписки');
  }
  return data;
}

export async function apiCreateYookassaPayment(
  session: EgSession,
  amountRub: number,
  options?: { comment?: string; address?: string }
): Promise<
  BillingMePayload & {
    ok: boolean;
    mode: 'yookassa_redirect' | 'manual_fallback';
    confirmationUrl: string | null;
    transaction: BillingTransaction;
  }
> {
  const res = await fetch('/api/eg/billing/yookassa/create', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify({
      ...buildBillingIdentity(session, options?.address),
      amountRub,
      comment: options?.comment || '',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка создания платежа ЮKassa');
  }
  return data;
}

export async function apiCheckYookassaPayment(
  session: EgSession,
  txId?: string
): Promise<BillingMePayload & { ok: boolean; updatedCount: number }> {
  const res = await fetch('/api/eg/billing/yookassa/check', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify({ txId: txId || '' }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка проверки статуса оплаты');
  }
  return data;
}

export async function apiRequestTopup(
  session: EgSession,
  amountRub: number,
  options?: { comment?: string; paymentChannel?: 'sbp' | 'yookassa_npd'; address?: string }
): Promise<BillingMePayload & { ok: boolean }> {
  const res = await fetch('/api/eg/billing/topup-request', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify({
      ...buildBillingIdentity(session, options?.address),
      amountRub,
      comment: options?.comment || '',
      paymentChannel: options?.paymentChannel || 'yookassa_npd',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка отправки заявки на пополнение');
  }
  return data;
}

export async function apiRenewSubscription(
  session: EgSession,
  primaryAddress?: string
): Promise<BillingMePayload> {
  const res = await fetch('/api/eg/billing/activate-or-renew', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify(buildBillingIdentity(session, primaryAddress)),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка продления подписки');
  }
  return data;
}

export async function apiSetBillingAutoRenew(
  session: EgSession,
  autoRenew: boolean
): Promise<BillingMePayload> {
  const res = await fetch('/api/eg/billing/auto-renew', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify({
      ...buildBillingIdentity(session),
      autoRenew,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка настройки автопродления');
  }
  return data;
}

function buildAdminHeaders(session: EgSession, adminPin?: string): Record<string, string> {
  const headers = buildHeaders(session);
  if (adminPin && adminPin.trim()) {
    headers['x-admin-pin'] = adminPin.trim();
  }
  return headers;
}

export async function apiAdminUnlock(session: EgSession, pin: string): Promise<boolean> {
  const res = await fetch('/api/eg/admin/unlock', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.message || 'Неверный PIN-код');
  }
  return true;
}

export async function apiGetAdminOverview(
  session: EgSession,
  adminPin?: string
): Promise<AdminOverviewPayload> {
  const res = await fetch('/api/eg/admin/overview', {
    method: 'GET',
    headers: buildAdminHeaders(session, adminPin),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка загрузки админ-панели');
  }
  return data;
}

export async function apiAdminCreateUser(
  session: EgSession,
  payload: {
    name: string;
    phone: string;
    accountId?: string;
    address?: string;
    balanceRub?: number;
    status?: BillingSubscriptionStatus;
    role?: 'admin' | 'user';
    notes?: string;
  },
  adminPin?: string
): Promise<AdminOverviewPayload> {
  const res = await fetch('/api/eg/admin/users', {
    method: 'POST',
    headers: buildAdminHeaders(session, adminPin),
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Не удалось добавить пользователя');
  }
  return data;
}

export async function apiAdminAdjustBalance(
  session: EgSession,
  userId: string,
  payload: {
    deltaRub: number;
    description?: string;
    paymentChannel?: 'sbp' | 'yookassa_npd' | 'manual';
    npdReceiptNumber?: string;
    markAsTopup?: boolean;
  },
  adminPin?: string
): Promise<AdminOverviewPayload> {
  const res = await fetch(`/api/eg/admin/users/${encodeURIComponent(userId)}/balance`, {
    method: 'POST',
    headers: buildAdminHeaders(session, adminPin),
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка изменения баланса');
  }
  return data;
}

export async function apiAdminUpdateUserSubscription(
  session: EgSession,
  userId: string,
  payload: {
    status?: BillingSubscriptionStatus;
    action?: 'unblock';
    addDays?: number;
    role?: 'admin' | 'user';
    autoRenew?: boolean;
    notes?: string;
  },
  adminPin?: string
): Promise<AdminOverviewPayload> {
  const res = await fetch(`/api/eg/admin/users/${encodeURIComponent(userId)}/subscription`, {
    method: 'POST',
    headers: buildAdminHeaders(session, adminPin),
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка обновления пользователя');
  }
  return data;
}

export async function apiAdminFetchUserDomruData(
  session: EgSession,
  userId: string,
  adminPin?: string
): Promise<{
  ok: boolean;
  expired?: boolean;
  message?: string;
  domruProfile?: AdminDomruUserProfile;
}> {
  const res = await fetch(`/api/eg/admin/users/${encodeURIComponent(userId)}/fetch-domru`, {
    method: 'POST',
    headers: buildAdminHeaders(session, adminPin),
  });
  const data = await res.json();
  if (!res.ok && !data?.expired) {
    throw new Error(data?.message || 'Ошибка запроса данных через API Дом.ру');
  }
  return data;
}

export async function apiAdminProcessTransaction(
  session: EgSession,
  txId: string,
  action: 'approve' | 'reject',
  npdReceiptNumber?: string,
  adminPin?: string
): Promise<AdminOverviewPayload> {
  const res = await fetch(`/api/eg/admin/transactions/${encodeURIComponent(txId)}/approve`, {
    method: 'POST',
    headers: buildAdminHeaders(session, adminPin),
    body: JSON.stringify({ action, npdReceiptNumber }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка обработки платежа');
  }
  return data;
}

export async function apiAdminIssueNpdReceipt(
  session: EgSession,
  txId: string,
  npdReceiptNumber: string,
  adminPin?: string
): Promise<AdminOverviewPayload> {
  const res = await fetch(`/api/eg/admin/transactions/${encodeURIComponent(txId)}/npd-receipt`, {
    method: 'POST',
    headers: buildAdminHeaders(session, adminPin),
    body: JSON.stringify({ npdReceiptNumber }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка сохранения чека НПД');
  }
  return data;
}

export async function apiAdminUpdateConfig(
  session: EgSession,
  payload: Partial<BillingConfig> & { newAdminPin?: string; clearAdminPin?: boolean },
  adminPin?: string
): Promise<AdminOverviewPayload> {
  const res = await fetch('/api/eg/admin/config', {
    method: 'POST',
    headers: buildAdminHeaders(session, adminPin),
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка сохранения настроек тарифа');
  }
  return data;
}

export async function apiGetPublicServiceInfo(): Promise<{ config: BillingConfig }> {
  const res = await fetch('/api/eg/public/service-info', {
    method: 'GET',
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка загрузки сведений о сервисе');
  }
  return data;
}

export async function apiGetEsp32Status(session: EgSession): Promise<Esp32GateStatusPayload> {
  const res = await fetch('/api/eg/esp32/status', {
    method: 'GET',
    headers: buildHeaders(session),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка загрузки статуса ESP32');
  }
  return data;
}

export async function apiUpdateEsp32Config(
  session: EgSession,
  payload: Partial<Esp32GateConfig>
): Promise<Esp32GateStatusPayload> {
  const res = await fetch('/api/eg/esp32/config', {
    method: 'POST',
    headers: buildHeaders(session),
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    notifySubscriptionRestricted(res.status, data);
    throw new Error(data?.message || 'Ошибка сохранения конфигурации ESP32');
  }
  return data;
}

export async function apiGetAdminLogs(
  session: EgSession,
  params?: {
    action?: 'all' | 'login' | 'logout' | 'door_open';
    userId?: string;
    search?: string;
    limit?: number;
  },
  adminPin?: string
): Promise<AdminSubscriberLogsPayload> {
  const qs = new URLSearchParams();
  if (params?.action && params.action !== 'all') qs.set('action', params.action);
  if (params?.userId) qs.set('userId', params.userId);
  if (params?.search) qs.set('search', params.search);
  if (params?.limit) qs.set('limit', String(params.limit));
  const queryStr = qs.toString();
  const res = await fetch(`/api/eg/admin/logs${queryStr ? `?${queryStr}` : ''}`, {
    method: 'GET',
    headers: buildAdminHeaders(session, adminPin),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка загрузки логов абонентов');
  }
  return data;
}

export async function apiAdminClearLogs(
  session: EgSession,
  adminPin?: string
): Promise<AdminSubscriberLogsPayload> {
  const res = await fetch('/api/eg/admin/logs/clear', {
    method: 'POST',
    headers: buildAdminHeaders(session, adminPin),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || 'Ошибка очистки логов абонентов');
  }
  return data;
}

