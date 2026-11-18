import 'dotenv/config';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { autoAccessSingleton } from './src/server/autoAccessEngine.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_API_URL = 'https://myhome.proptech.ru';
const APP_VERSION = {
  name: '9.11.0',
  code: '91100000',
};
const ANDROID_OS_VER = '16';
const ANDROID_DEVICES = [
  { manufacturer: 'Google', model: 'Pixel 8' },
  { manufacturer: 'Google', model: 'Pixel 8 Pro' },
  { manufacturer: 'Google', model: 'Pixel 9' },
  { manufacturer: 'Google', model: 'Pixel 9 Pro' },
  { manufacturer: 'Google', model: 'Pixel 9 Pro XL' },
  { manufacturer: 'Google', model: 'Pixel 10 Pro' },
];

const PREAUTH_PATH_PREFIXES = [
  '/auth/',
  '/public/',
  '/api/mh-customer-device/mobile/public/',
];

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

function createDefaultUserAgent(existing?: Partial<UserAgentState>): UserAgentState {
  const randomDevice = ANDROID_DEVICES[Math.floor(Math.random() * ANDROID_DEVICES.length)];
  return {
    phone_manufacturer: existing?.phone_manufacturer || randomDevice.manufacturer,
    phone_model: existing?.phone_model || randomDevice.model,
    android_ver: existing?.android_ver || ANDROID_OS_VER,
    app_version: APP_VERSION,
    account_id: existing?.account_id ?? '',
    operator_id: existing?.operator_id ?? 'null',
    uuid: existing?.uuid || crypto.randomUUID(),
    place_id: existing?.place_id ?? 'null',
  };
}

function formatUserAgent(ua: UserAgentState): string {
  return `${ua.phone_manufacturer} ${ua.phone_model} | Android ${ua.android_ver} | ntk | ${ua.app_version.name} (${ua.app_version.code}) | ${ua.account_id} | ${ua.operator_id} | ${ua.uuid} | ${ua.place_id}`;
}

function hashPassword(password: string): string {
  const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest();
  return sha1.toString('base64');
}

function hashPasswordTimestamp(login: string, password: string, simpleTime: string): string {
  const prefix = 'DigitalHomeNTKpassword';
  const secret = '789sdgHJs678wertv34712376';
  const raw = `${prefix}${login}${password}${simpleTime}${secret}`;
  return crypto.createHash('md5').update(raw, 'utf8').digest('hex');
}

function getAuthTimestamps(): { timestamp: string; simpleTime: string } {
  const now = new Date();
  const iso = now.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  const pad = (n: number) => String(n).padStart(2, '0');
  const simpleTime =
    String(now.getUTCFullYear()) +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds());
  return { timestamp: iso, simpleTime };
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) {
    return '7' + digits.slice(1);
  }
  if (digits.length === 10) {
    return '7' + digits;
  }
  return digits;
}

interface EgRequestContext {
  accessToken?: string;
  operatorId?: string;
  userAgent: UserAgentState;
}

function extractContext(req: Request): EgRequestContext {
  const authHeader =
    (req.headers['x-eg-token'] as string | undefined) ||
    (typeof req.query.token === 'string' ? req.query.token : undefined);
  const operatorId =
    (req.headers['x-eg-operator'] as string | undefined) ||
    (typeof req.query.operator === 'string' ? req.query.operator : undefined) ||
    '1';
  let uaRaw: Partial<UserAgentState> = {};
  const uaHeader =
    (req.headers['x-eg-ua'] as string | undefined) ||
    (typeof req.query.ua === 'string' ? req.query.ua : undefined);
  if (uaHeader) {
    try {
      uaRaw = JSON.parse(Buffer.from(uaHeader, 'base64').toString('utf8'));
    } catch {
      // ignore invalid base64
    }
  }
  const placeIdQuery = typeof req.query.placeId === 'string' ? req.query.placeId : undefined;
  const userAgent = createDefaultUserAgent({
    ...uaRaw,
    operator_id: uaRaw.operator_id && uaRaw.operator_id !== 'null' ? uaRaw.operator_id : operatorId,
    place_id: placeIdQuery && placeIdQuery !== 'null' ? placeIdQuery : uaRaw.place_id || 'null',
  });
  return {
    accessToken: authHeader || undefined,
    operatorId,
    userAgent,
  };
}

async function egFetch(
  endpoint: string,
  ctx: EgRequestContext,
  options: {
    method?: 'GET' | 'POST' | 'DELETE';
    body?: unknown;
    binary?: boolean;
    placeIdOverride?: string;
    timeoutMs?: number;
  } = {}
): Promise<{ status: number; ok: boolean; data: any; buffer?: Buffer }> {
  const method = options.method || 'GET';
  const url = `${BASE_API_URL}${endpoint}`;
  const ua: UserAgentState = {
    ...ctx.userAgent,
    place_id: options.placeIdOverride ?? ctx.userAgent.place_id,
  };

  const headers: Record<string, string> = {
    'accept-encoding': 'gzip',
    'user-agent': formatUserAgent(ua),
  };

  if (ctx.operatorId && ctx.operatorId !== 'null') {
    headers['operator'] = String(ctx.operatorId);
  }

  const isPreauth = PREAUTH_PATH_PREFIXES.some((prefix) => endpoint.startsWith(prefix));
  if (ctx.accessToken && !isPreauth) {
    headers['authorization'] = `Bearer ${ctx.accessToken}`;
  }

  let bodyStr: string | undefined;
  if ((method === 'POST' || method === 'DELETE') && options.body !== undefined) {
    headers['content-type'] = 'application/json; charset=UTF-8';
    bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || (options.binary ? 25000 : 15000));

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: bodyStr,
      signal: controller.signal,
    });

    if (options.binary) {
      const arrayBuf = await response.arrayBuffer();
      return {
        status: response.status,
        ok: response.ok,
        data: null,
        buffer: Buffer.from(arrayBuf),
      };
    }

    const text = await response.text();
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      data: parsed,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Check if MP4 buffer has top-level `moov` box (port of `clip_proxy.py:_mp4_complete`)
function isMp4Complete(buf: Buffer): boolean {
  const total = buf.length;
  let offset = 0;
  const BOX_HEADER = 8;
  const BOX_HEADER_LARGE = 16;

  while (offset + BOX_HEADER <= total) {
    let size = buf.readUInt32BE(offset);
    const kind = buf.subarray(offset + 4, offset + 8).toString('ascii');
    let header = BOX_HEADER;
    if (size === 1) {
      header = BOX_HEADER_LARGE;
      if (offset + header > total) return false;
      const bigSize = buf.readBigUInt64BE(offset + 8);
      size = Number(bigSize);
    } else if (size === 0) {
      return kind === 'moov';
    }
    if (size < header || offset + size > total) {
      return false;
    }
    if (kind === 'moov') {
      return true;
    }
    offset += size;
  }
  return false;
}

// In-memory MP4 clip & signed-URL cache for instant progressive streaming + HTTP 206 scrubbing
interface CachedClip {
  buffer: Buffer;
  createdAt: number;
}
interface CachedSignedUrl {
  url: string;
  createdAt: number;
}
const clipCache = new Map<string, CachedClip>();
const signedClipUrlCache = new Map<string, CachedSignedUrl>();
const CLIP_TTL_MS = 10 * 60 * 1000;

function cleanupClipCache() {
  const now = Date.now();
  for (const [k, v] of clipCache.entries()) {
    if (now - v.createdAt > CLIP_TTL_MS) {
      clipCache.delete(k);
    }
  }
  for (const [k, v] of signedClipUrlCache.entries()) {
    if (now - v.createdAt > CLIP_TTL_MS) {
      signedClipUrlCache.delete(k);
    }
  }
}

interface VerifiedSessionIdentity {
  phone: string;
  accountId: string;
  subscriberId: string;
  name: string;
  isOwner: boolean;
  verifiedAt: number;
}

const verifiedSessionMap = new Map<string, VerifiedSessionIdentity>();
const VERIFIED_SESSION_TTL_MS = 15 * 60 * 1000;

function getOwnerPhonesSet(): Set<string> {
  const raw = process.env.OWNER_PHONES || '79128387309';
  const set = new Set<string>();
  for (const part of raw.split(',')) {
    const norm = normalizePhone(part.trim());
    if (norm) set.add(norm);
  }
  return set;
}

function getOwnerAccountIdsSet(): Set<string> {
  const raw = process.env.OWNER_ACCOUNT_IDS || '450005579792';
  const set = new Set<string>();
  for (const part of raw.split(',')) {
    const clean = part.trim();
    if (clean) set.add(clean);
  }
  return set;
}

function isOwnerIdentity(phone?: string, accountId?: string): boolean {
  const normPhone = phone ? normalizePhone(String(phone)) : '';
  const cleanAcc = accountId ? String(accountId).trim() : '';
  return (
    (Boolean(normPhone) && getOwnerPhonesSet().has(normPhone)) ||
    (Boolean(cleanAcc) && getOwnerAccountIdsSet().has(cleanAcc))
  );
}

function extractSubscriberIdentity(
  profileData: any,
  placesList: any[] = [],
  fallback?: { phone?: string; accountId?: string; subscriberId?: string; name?: string } | null
): { phone: string; accountId: string; subscriberId: string; name: string } {
  const dataRoot = profileData?.data || profileData || {};
  const sub = dataRoot?.subscriber || {};
  const firstSp = Array.isArray(placesList) && placesList.length > 0 ? placesList[0] : null;
  const spSub = firstSp?.subscriber || {};
  const spPlace = firstSp?.place || {};

  const rawPhone =
    sub.phone ||
    sub.login ||
    sub.msisdn ||
    dataRoot.phone ||
    spSub.phone ||
    spSub.login ||
    fallback?.phone ||
    '';
  const phone = rawPhone ? normalizePhone(String(rawPhone)) : '';

  const rawAcc =
    sub.accountId ||
    dataRoot.accountId ||
    spSub.accountId ||
    spPlace.accountId ||
    fallback?.accountId ||
    '';
  const accountId = rawAcc ? String(rawAcc).trim() : '';

  const rawSubId =
    sub.id ??
    sub.subscriberId ??
    dataRoot.subscriberId ??
    spSub.id ??
    spSub.subscriberId ??
    firstSp?.id ??
    fallback?.subscriberId ??
    '';
  const subscriberId =
    rawSubId !== '' && rawSubId != null && String(rawSubId) !== 'undefined'
      ? String(rawSubId).trim()
      : '';

  const rawName = sub.name || dataRoot.name || spSub.name || fallback?.name || '';
  const name = String(rawName || '').trim();

  return { phone, accountId, subscriberId, name };
}

function cacheVerifiedSession(
  accessToken: string,
  identity: { phone?: string; accountId?: string; subscriberId?: string; name?: string }
): VerifiedSessionIdentity {
  const prev = accessToken ? verifiedSessionMap.get(accessToken) : undefined;
  const rawNormPhone = identity.phone ? normalizePhone(String(identity.phone)) : '';
  const cleanPhone = rawNormPhone || prev?.phone || '';
  const cleanAcc = (identity.accountId ? String(identity.accountId).trim() : '') || prev?.accountId || '';
  const cleanSubId =
    (identity.subscriberId ? String(identity.subscriberId).trim() : '') || prev?.subscriberId || '';
  const cleanName = String(identity.name || '').trim() || prev?.name || '';
  const record: VerifiedSessionIdentity = {
    phone: cleanPhone,
    accountId: cleanAcc,
    subscriberId: cleanSubId,
    name: cleanName,
    isOwner: isOwnerIdentity(cleanPhone, cleanAcc),
    verifiedAt: Date.now(),
  };
  if (accessToken && !accessToken.startsWith('demo_')) {
    verifiedSessionMap.set(accessToken, record);
  }
  return record;
}

async function resolveVerifiedSession(req: Request): Promise<{
  authenticated: boolean;
  isDemo: boolean;
  isOwner: boolean;
  phone: string;
  accountId: string;
  subscriberId: string;
  name: string;
}> {
  const ctx = extractContext(req);
  const token = ctx.accessToken || '';
  if (!token) {
    return {
      authenticated: false,
      isDemo: false,
      isOwner: false,
      phone: '',
      accountId: '',
      subscriberId: '',
      name: '',
    };
  }
  if (token.startsWith('demo_')) {
    return {
      authenticated: false,
      isDemo: true,
      isOwner: false,
      phone: '',
      accountId: '',
      subscriberId: '',
      name: '',
    };
  }

  const cached = verifiedSessionMap.get(token);
  if (cached && Date.now() - cached.verifiedAt < VERIFIED_SESSION_TTL_MS) {
    return {
      authenticated: true,
      isDemo: false,
      isOwner: isOwnerIdentity(cached.phone, cached.accountId),
      phone: cached.phone,
      accountId: cached.accountId,
      subscriberId: cached.subscriberId || '',
      name: cached.name,
    };
  }

  try {
    const profileRes = await egFetch('/rest/v1/subscribers/profiles', ctx);
    if (profileRes.ok && profileRes.data?.data?.subscriber) {
      let placesList: any[] = [];
      const preliminary = extractSubscriberIdentity(profileRes.data, [], cached);

      if (!preliminary.accountId || !preliminary.phone || !preliminary.subscriberId) {
        try {
          const placesRes = await egFetch('/rest/v3/subscriber-places', ctx);
          if (Array.isArray(placesRes.data?.data)) {
            placesList = placesRes.data.data;
          }
        } catch {
          // non-fatal
        }
      }

      const extracted = extractSubscriberIdentity(profileRes.data, placesList, cached);
      const cachedEntry = cacheVerifiedSession(token, extracted);

      return {
        authenticated: true,
        isDemo: false,
        isOwner: cachedEntry.isOwner,
        phone: cachedEntry.phone,
        accountId: cachedEntry.accountId,
        subscriberId: cachedEntry.subscriberId,
        name: cachedEntry.name,
      };
    }
  } catch {
    // ignore upstream failure
  }

  return {
    authenticated: false,
    isDemo: false,
    isOwner: false,
    phone: '',
    accountId: '',
    subscriberId: '',
    name: '',
  };
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '15mb' }));

  // =========================================================================
  // ESP32 Physical Remote Relay Controller for Gates (Камера фасад 1 & 2)
  // =========================================================================
  interface ServerEsp32GateConfig {
    enabled: boolean;
    mode: 'poll' | 'http_direct' | 'hybrid';
    gate1HttpUrl: string;
    gate2HttpUrl: string;
    pulseDurationMs: number;
    deviceToken: string;
    gpioGate1Pin: number;
    gpioGate2Pin: number;
  }

  interface Esp32TriggerEvent {
    id: string;
    channel: 1 | 2;
    gateName: string;
    pulseMs: number;
    timestamp: number;
    deliveryMode: 'http_direct' | 'queued_poll';
    deliveredAt: number | null;
  }

  const ESP32_DATA_DIR = path.join(__dirname, '.data');
  const ESP32_CONFIG_FILE = path.join(ESP32_DATA_DIR, 'esp32-gates.json');

  let esp32Config: ServerEsp32GateConfig = {
    enabled: true,
    mode: 'hybrid',
    gate1HttpUrl: String(process.env.ESP32_GATE1_URL || '').trim(),
    gate2HttpUrl: String(process.env.ESP32_GATE2_URL || '').trim(),
    pulseDurationMs: Math.max(150, Math.min(5000, Number(process.env.ESP32_PULSE_MS) || 600)),
    deviceToken: String(process.env.ESP32_DEVICE_TOKEN || 'openkey_esp32_gate_relay').trim(),
    gpioGate1Pin: 18,
    gpioGate2Pin: 19,
  };

  let esp32LastPollAt: number | null = null;
  const esp32PendingCommands: Esp32TriggerEvent[] = [];
  const esp32RecentTriggers: Esp32TriggerEvent[] = [];

  function loadEsp32ConfigFromDisk() {
    try {
      if (!fs.existsSync(ESP32_CONFIG_FILE)) return;
      const raw = fs.readFileSync(ESP32_CONFIG_FILE, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        esp32Config = {
          ...esp32Config,
          ...parsed,
          pulseDurationMs: Math.max(
            150,
            Math.min(5000, Number(parsed.pulseDurationMs ?? esp32Config.pulseDurationMs) || 600)
          ),
        };
      }
    } catch {
      // ignore invalid config file
    }
  }

  function saveEsp32ConfigToDisk() {
    try {
      if (!fs.existsSync(ESP32_DATA_DIR)) {
        fs.mkdirSync(ESP32_DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(ESP32_CONFIG_FILE, JSON.stringify(esp32Config, null, 2), 'utf8');
    } catch {
      // ignore disk error
    }
  }

  loadEsp32ConfigFromDisk();

  // =========================================================================
  // Per-User Custom Camera Names (Aliases) persisted in .data/camera-aliases.json
  // =========================================================================
  const CAMERA_ALIASES_FILE = path.join(ESP32_DATA_DIR, 'camera-aliases.json');
  let cameraAliasesByUser: Record<string, Record<string, string>> = {};

  function loadCameraAliasesFromDisk() {
    try {
      if (!fs.existsSync(CAMERA_ALIASES_FILE)) return;
      const raw = fs.readFileSync(CAMERA_ALIASES_FILE, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.aliasesByUser === 'object' && parsed.aliasesByUser !== null) {
        cameraAliasesByUser = parsed.aliasesByUser;
      }
    } catch {
      // ignore corrupted alias store
    }
  }

  function saveCameraAliasesToDisk() {
    try {
      if (!fs.existsSync(ESP32_DATA_DIR)) {
        fs.mkdirSync(ESP32_DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(
        CAMERA_ALIASES_FILE,
        JSON.stringify({ aliasesByUser: cameraAliasesByUser }, null, 2),
        'utf8'
      );
    } catch {
      // ignore disk write error
    }
  }

  function getCameraAliasesForUser(userKey: string): Record<string, string> {
    if (!userKey) return {};
    const entry = cameraAliasesByUser[userKey];
    return entry && typeof entry === 'object' ? { ...entry } : {};
  }

  function setCameraAliasForUser(
    userKey: string,
    cameraId: string,
    newName: string
  ): { alias: string | null; aliases: Record<string, string> } {
    const cleanId = String(cameraId || '').trim();
    const cleanName = String(newName || '').trim().slice(0, 80);
    if (!cameraAliasesByUser[userKey]) {
      cameraAliasesByUser[userKey] = {};
    }
    if (!cleanName) {
      delete cameraAliasesByUser[userKey][cleanId];
      if (Object.keys(cameraAliasesByUser[userKey]).length === 0) {
        delete cameraAliasesByUser[userKey];
      }
      saveCameraAliasesToDisk();
      return { alias: null, aliases: getCameraAliasesForUser(userKey) };
    }
    cameraAliasesByUser[userKey][cleanId] = cleanName;
    saveCameraAliasesToDisk();
    return { alias: cleanName, aliases: getCameraAliasesForUser(userKey) };
  }

  loadCameraAliasesFromDisk();

  const placeControlCameraIdMap = new Map<string, string>();
  function rememberPlaceControlCamera(
    placeId: string | undefined,
    accessControlId: string | number | null | undefined,
    entranceId: string | null | undefined,
    cameraId: string | null | undefined
  ) {
    if (!placeId || !cameraId) return;
    const pid = String(placeId);
    const cid = String(cameraId);
    if (entranceId) {
      placeControlCameraIdMap.set(`${pid}:ent:${String(entranceId)}`, cid);
    }
    if (accessControlId != null && String(accessControlId) !== '') {
      const acStr = String(accessControlId);
      placeControlCameraIdMap.set(
        `${pid}:ac:${acStr}:${entranceId ? String(entranceId) : ''}`,
        cid
      );
      if (!entranceId) {
        placeControlCameraIdMap.set(`${pid}:ac:${acStr}`, cid);
      }
    }
  }

  function lookupCachedPlaceControlCamera(
    placeId: string | undefined,
    accessControlId: string | number | null | undefined,
    entranceId: string | null | undefined
  ): string | null {
    if (!placeId) return null;
    const pid = String(placeId);
    if (entranceId) {
      const byEnt = placeControlCameraIdMap.get(`${pid}:ent:${String(entranceId)}`);
      if (byEnt) return byEnt;
    }
    if (accessControlId != null && String(accessControlId) !== '') {
      const acStr = String(accessControlId);
      const exact = placeControlCameraIdMap.get(
        `${pid}:ac:${acStr}:${entranceId ? String(entranceId) : ''}`
      );
      if (exact) return exact;
      const byAc = placeControlCameraIdMap.get(`${pid}:ac:${acStr}`);
      if (byAc) return byAc;
    }
    return null;
  }

  function detectFacadeGateCamera(camName: string): {
    channel: 1 | 2;
    accessControlId: string;
    entranceId: string;
    acLabel: string;
  } | null {
    const lower = String(camName || '').toLowerCase();
    if (lower.includes('фасад 1') || lower.includes('фасад №1') || lower.includes('ворота 1')) {
      return {
        channel: 1,
        accessControlId: '990001',
        entranceId: 'esp32_gate_1',
        acLabel: 'Ворота №1',
      };
    }
    if (lower.includes('фасад 2') || lower.includes('фасад №2') || lower.includes('ворота 2')) {
      return {
        channel: 2,
        accessControlId: '990002',
        entranceId: 'esp32_gate_2',
        acLabel: 'Ворота №2',
      };
    }
    return null;
  }

  function resolveEsp32ChannelFromLockParams(
    accessControlId: unknown,
    entranceId: unknown
  ): 1 | 2 | null {
    const acStr = String(accessControlId || '').trim().toLowerCase();
    const entStr = String(entranceId || '').trim().toLowerCase();
    if (acStr === '990001' || acStr === 'esp32_gate_1' || entStr === 'esp32_gate_1' || entStr === 'gate_1') {
      return 1;
    }
    if (acStr === '990002' || acStr === 'esp32_gate_2' || entStr === 'esp32_gate_2' || entStr === 'gate_2') {
      return 2;
    }
    return null;
  }

  async function triggerEsp32Gate(channel: 1 | 2, customLabel?: string): Promise<Esp32TriggerEvent> {
    const pulseMs = Math.max(150, Math.min(5000, esp32Config.pulseDurationMs || 600));
    const gateName =
      customLabel ||
      (channel === 1
        ? 'Камера фасад 1 - 3-Й Мкр 6 б (Ворота 1)'
        : 'Камера фасад 2 - 3-Й Мкр 6 б (Ворота 2)');

    const targetUrl =
      channel === 1 ? esp32Config.gate1HttpUrl.trim() : esp32Config.gate2HttpUrl.trim();

    let directDelivered = false;
    if (
      targetUrl &&
      (esp32Config.mode === 'http_direct' || esp32Config.mode === 'hybrid') &&
      /^https?:\/\//i.test(targetUrl)
    ) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3500);
      try {
        const sep = targetUrl.includes('?') ? '&' : '?';
        const fullUrl = `${targetUrl}${sep}channel=${channel}&pulseMs=${pulseMs}&token=${encodeURIComponent(esp32Config.deviceToken)}`;
        const resp = await fetch(fullUrl, {
          method: 'GET',
          headers: {
            'x-esp32-token': esp32Config.deviceToken,
          },
          signal: controller.signal,
        });
        if (resp.ok) {
          directDelivered = true;
        }
      } catch {
        // Fallback to polling queue if ESP32 direct HTTP is behind NAT
      } finally {
        clearTimeout(t);
      }
    }

    const now = Date.now();
    const event: Esp32TriggerEvent = {
      id: `esp32_${now}_${crypto.randomBytes(3).toString('hex')}`,
      channel,
      gateName,
      pulseMs,
      timestamp: now,
      deliveryMode: directDelivered ? 'http_direct' : 'queued_poll',
      deliveredAt: directDelivered ? now : null,
    };

    if (!directDelivered && (esp32Config.mode === 'poll' || esp32Config.mode === 'hybrid')) {
      // Keep only fresh commands from the last 45 seconds in queue
      const cutoff = now - 45000;
      while (esp32PendingCommands.length > 0 && esp32PendingCommands[0].timestamp < cutoff) {
        esp32PendingCommands.shift();
      }
      esp32PendingCommands.push(event);
    }

    esp32RecentTriggers.unshift(event);
    if (esp32RecentTriggers.length > 30) {
      esp32RecentTriggers.length = 30;
    }

    return event;
  }

  // ESP32 Microcontroller Polling Endpoint (GET /api/eg/esp32/poll?token=...)
  app.get('/api/eg/esp32/poll', (req: Request, res: Response) => {
    const suppliedToken = String(
      req.query.token || req.headers['x-esp32-token'] || ''
    ).trim();
    if (esp32Config.deviceToken && suppliedToken && suppliedToken !== esp32Config.deviceToken) {
      res.status(403).json({ ok: false, error: 'invalid_esp32_token' });
      return;
    }

    const now = Date.now();
    esp32LastPollAt = now;
    const cutoff = now - 45000;

    const ready: Array<{
      id: string;
      channel: 1 | 2;
      pin: number;
      pulseMs: number;
      gateName: string;
    }> = [];

    while (esp32PendingCommands.length > 0) {
      const cmd = esp32PendingCommands.shift()!;
      if (cmd.timestamp >= cutoff) {
        cmd.deliveredAt = now;
        ready.push({
          id: cmd.id,
          channel: cmd.channel,
          pin: cmd.channel === 1 ? esp32Config.gpioGate1Pin : esp32Config.gpioGate2Pin,
          pulseMs: cmd.pulseMs,
          gateName: cmd.gateName,
        });
      }
    }

    res.json({
      ok: true,
      timestamp: now,
      commands: ready,
    });
  });

  app.get('/api/eg/esp32/status', (_req: Request, res: Response) => {
    const now = Date.now();
    const activePending = esp32PendingCommands.filter((c) => c.timestamp >= now - 45000);
    res.json({
      config: esp32Config,
      lastPollAt: esp32LastPollAt,
      pendingCommandsCount: activePending.length,
      recentTriggers: esp32RecentTriggers.slice(0, 15),
    });
  });

  app.post('/api/eg/esp32/config', async (req: Request, res: Response) => {
    if (!(await assertActiveSubscription(req, res))) return;
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') esp32Config.enabled = b.enabled;
    if (b.mode === 'poll' || b.mode === 'http_direct' || b.mode === 'hybrid') {
      esp32Config.mode = b.mode;
    }
    if (typeof b.gate1HttpUrl === 'string') {
      esp32Config.gate1HttpUrl = b.gate1HttpUrl.trim().slice(0, 240);
    }
    if (typeof b.gate2HttpUrl === 'string') {
      esp32Config.gate2HttpUrl = b.gate2HttpUrl.trim().slice(0, 240);
    }
    if (typeof b.pulseDurationMs === 'number' && Number.isFinite(b.pulseDurationMs)) {
      esp32Config.pulseDurationMs = Math.max(150, Math.min(5000, Math.round(b.pulseDurationMs)));
    }
    if (typeof b.deviceToken === 'string' && b.deviceToken.trim()) {
      esp32Config.deviceToken = b.deviceToken.trim().slice(0, 80);
    }
    if (typeof b.gpioGate1Pin === 'number' && Number.isFinite(b.gpioGate1Pin)) {
      esp32Config.gpioGate1Pin = Math.max(0, Math.min(48, Math.round(b.gpioGate1Pin)));
    }
    if (typeof b.gpioGate2Pin === 'number' && Number.isFinite(b.gpioGate2Pin)) {
      esp32Config.gpioGate2Pin = Math.max(0, Math.min(48, Math.round(b.gpioGate2Pin)));
    }
    saveEsp32ConfigToDisk();
    res.json({
      config: esp32Config,
      lastPollAt: esp32LastPollAt,
      pendingCommandsCount: esp32PendingCommands.length,
      recentTriggers: esp32RecentTriggers.slice(0, 15),
    });
  });

  // 1. Auth Step 1: Query contracts or password requirement by phone
  app.post('/api/eg/auth/login-phone', async (req: Request, res: Response) => {
    try {
      const rawPhone = String(req.body?.phone || '').trim();
      const phone = normalizePhone(rawPhone);
      if (!phone || phone.length < 10) {
        res.status(400).json({ error: 'invalid_phone', message: 'Введите корректный номер телефона (например, 79130000000)' });
        return;
      }

      const ctx = extractContext(req);
      const result = await egFetch(`/auth/v2/login/${encodeURIComponent(phone)}`, ctx);

      if (result.status === 300) {
        res.json({
          phone,
          passwordRequired: false,
          contracts: Array.isArray(result.data) ? result.data : [],
          userAgent: ctx.userAgent,
        });
        return;
      }

      if (result.status === 200) {
        res.json({
          phone,
          passwordRequired: true,
          contracts: [],
          userAgent: ctx.userAgent,
        });
        return;
      }

      if (result.status === 204) {
        res.status(404).json({
          error: 'unregistered',
          message: 'Номер телефона не зарегистрирован в системе Мой Дом / Электронный Город',
        });
        return;
      }

      res.status(result.status || 400).json({
        error: 'login_failed',
        message: `Оператор вернул статус ${result.status}. Проверьте номер телефона.`,
      });
    } catch (err: any) {
      res.status(502).json({
        error: 'network_error',
        message: `Ошибка соединения с myhome.proptech.ru: ${err?.message || 'Timeout'}`,
      });
    }
  });

  // 2. Auth Step 2A: Verify Password
  app.post('/api/eg/auth/verify-password', async (req: Request, res: Response) => {
    try {
      const phone = normalizePhone(String(req.body?.phone || ''));
      const password = String(req.body?.password || '');
      if (!phone || !password) {
        res.status(400).json({ error: 'missing_credentials', message: 'Укажите телефон и пароль' });
        return;
      }

      const ctx = extractContext(req);
      const { timestamp, simpleTime } = getAuthTimestamps();
      const hash1 = hashPassword(password);
      const hash2 = hashPasswordTimestamp(phone, password, simpleTime);

      const authRes = await egFetch(`/auth/v2/auth/${encodeURIComponent(phone)}/password`, ctx, {
        method: 'POST',
        body: {
          login: phone,
          timestamp,
          hash1,
          hash2,
        },
      });

      if (!authRes.ok || !authRes.data?.accessToken) {
        res.status(401).json({
          error: 'invalid_password',
          message: 'Неверный пароль или отказ оператора авторизации',
        });
        return;
      }

      const accessToken = String(authRes.data.accessToken);
      const refreshToken = authRes.data.refreshToken ? String(authRes.data.refreshToken) : null;
      const operatorId = authRes.data.operatorId != null ? String(authRes.data.operatorId) : '1';

      ctx.accessToken = accessToken;
      ctx.operatorId = operatorId;
      ctx.userAgent.operator_id = operatorId;

      const profileRes = await egFetch('/rest/v1/subscribers/profiles', ctx);
      const subscriber = profileRes.data?.data?.subscriber || {};
      const extracted = extractSubscriberIdentity(profileRes.data, [], {
        phone,
        accountId: ctx.userAgent.account_id || '',
      });
      if (extracted.accountId) {
        ctx.userAgent.account_id = extracted.accountId;
      }

      cacheVerifiedSession(accessToken, extracted);

      upsertBillingUserFromIdentity(extracted);

      res.json({
        accessToken,
        refreshToken,
        operatorId,
        subscriber,
        userAgent: ctx.userAgent,
      });
    } catch (err: any) {
      res.status(502).json({
        error: 'network_error',
        message: `Ошибка при проверке пароля: ${err?.message || 'Unknown error'}`,
      });
    }
  });

  // 3. Auth Step 2B: Request SMS code for a selected contract
  app.post('/api/eg/auth/request-sms', async (req: Request, res: Response) => {
    try {
      const phone = normalizePhone(String(req.body?.phone || ''));
      const contract = req.body?.contract;
      if (!phone || !contract) {
        res.status(400).json({ error: 'missing_contract', message: 'Выберите договор для отправки СМС' });
        return;
      }

      const ctx = extractContext(req);
      const payload = {
        accountId: contract.accountId,
        address: contract.address,
        operatorId: contract.operatorId,
        subscriberId: String(contract.subscriberId),
        placeId: contract.placeId,
      };

      const smsRes = await egFetch(`/auth/v2/confirmation/${encodeURIComponent(phone)}`, ctx, {
        method: 'POST',
        body: payload,
      });

      if (smsRes.status === 429) {
        res.status(429).json({
          error: 'limit_exceeded',
          message: 'Превышен лимит отправки СМС-кодов. Подождите несколько минут.',
        });
        return;
      }

      if (!smsRes.ok) {
        res.status(smsRes.status || 400).json({
          error: 'sms_request_failed',
          message: `Не удалось запросить СМС-код (статус ${smsRes.status})`,
        });
        return;
      }

      res.json({ ok: true });
    } catch (err: any) {
      res.status(502).json({
        error: 'network_error',
        message: `Ошибка отправки запроса СМС: ${err?.message || 'Unknown'}`,
      });
    }
  });

  // 4. Auth Step 2C: Verify SMS code
  app.post('/api/eg/auth/verify-sms', async (req: Request, res: Response) => {
    try {
      const phone = normalizePhone(String(req.body?.phone || ''));
      const contract = req.body?.contract;
      const code = String(req.body?.code || '').trim();
      if (!phone || !contract || !code) {
        res.status(400).json({ error: 'missing_code', message: 'Введите код из СМС' });
        return;
      }

      const ctx = extractContext(req);
      const payload = {
        accountId: contract.accountId,
        confirm1: code,
        confirm2: code,
        login: phone,
        operatorId: contract.operatorId,
        subscriberId: String(contract.subscriberId),
      };

      const verifyRes = await egFetch(`/auth/v3/auth/${encodeURIComponent(phone)}/confirmation`, ctx, {
        method: 'POST',
        body: payload,
      });

      if (!verifyRes.ok || !verifyRes.data?.accessToken) {
        res.status(401).json({
          error: 'invalid_code',
          message: 'Неверный код подтверждения СМС',
        });
        return;
      }

      const accessToken = String(verifyRes.data.accessToken);
      const refreshToken = verifyRes.data.refreshToken ? String(verifyRes.data.refreshToken) : null;
      const operatorId = verifyRes.data.operatorId != null ? String(verifyRes.data.operatorId) : String(contract.operatorId || '1');

      ctx.accessToken = accessToken;
      ctx.operatorId = operatorId;
      ctx.userAgent.operator_id = operatorId;

      const profileRes = await egFetch('/rest/v1/subscribers/profiles', ctx);
      const subscriber = profileRes.data?.data?.subscriber || {};
      const extracted = extractSubscriberIdentity(profileRes.data, [], {
        phone,
        accountId: contract?.accountId ? String(contract.accountId) : '',
        subscriberId: contract?.subscriberId ? String(contract.subscriberId) : '',
      });
      if (extracted.accountId) {
        ctx.userAgent.account_id = extracted.accountId;
      }

      cacheVerifiedSession(accessToken, extracted);

      upsertBillingUserFromIdentity({
        ...extracted,
        address: contract?.address || '',
      });

      res.json({
        accessToken,
        refreshToken,
        operatorId,
        subscriber,
        userAgent: ctx.userAgent,
      });
    } catch (err: any) {
      res.status(502).json({
        error: 'network_error',
        message: `Ошибка проверки СМС-кода: ${err?.message || 'Unknown'}`,
      });
    }
  });

  // 5. Auth Option B: Direct Access Token login (mirrors `CONF_ACCESS_TOKEN` in `config_flow.py`)
  app.post('/api/eg/auth/verify-token', async (req: Request, res: Response) => {
    try {
      const accessToken = String(req.body?.accessToken || '').trim();
      const operatorId = String(req.body?.operatorId || '1').trim();
      if (!accessToken) {
        res.status(400).json({ error: 'missing_token', message: 'Укажите Access Token' });
        return;
      }

      const ctx = extractContext(req);
      ctx.accessToken = accessToken;
      ctx.operatorId = operatorId;
      ctx.userAgent.operator_id = operatorId;

      const profileRes = await egFetch('/rest/v1/subscribers/profiles', ctx);
      if (profileRes.status === 401 || !profileRes.ok) {
        res.status(401).json({
          error: 'unauthorized',
          message: 'Токен недействителен или отвергнут оператором (401 Unauthorized)',
        });
        return;
      }

      const subscriber = profileRes.data?.data?.subscriber || {};
      const extracted = extractSubscriberIdentity(profileRes.data, [], {
        accountId: ctx.userAgent.account_id || '',
      });
      if (extracted.accountId) {
        ctx.userAgent.account_id = extracted.accountId;
      }

      cacheVerifiedSession(accessToken, extracted);

      upsertBillingUserFromIdentity(extracted);

      res.json({
        accessToken,
        refreshToken: null,
        operatorId,
        subscriber,
        userAgent: ctx.userAgent,
      });
    } catch (err: any) {
      res.status(502).json({
        error: 'network_error',
        message: `Ошибка проверки токена: ${err?.message || 'Unknown'}`,
      });
    }
  });

  // 6. Full Coordinator Sync (mirrors `coordinator.py:_async_update_data`)
  app.get('/api/eg/sync', async (req: Request, res: Response) => {
    try {
      const ctx = extractContext(req);
      if (!ctx.accessToken) {
        res.status(401).json({ error: 'unauthorized', message: 'Отсутствует токен авторизации' });
        return;
      }

      const profileRes = await egFetch('/rest/v1/subscribers/profiles', ctx);
      if (profileRes.status === 401) {
        res.status(401).json({ error: 'unauthorized', message: 'Сессия истекла (401)' });
        return;
      }
      const subscriber = profileRes.data?.data?.subscriber || {};
      const prevCachedSync = ctx.accessToken ? verifiedSessionMap.get(ctx.accessToken) : undefined;
      if (subscriber.accountId) {
        ctx.userAgent.account_id = String(subscriber.accountId);
      }

      const placesRes = await egFetch('/rest/v3/subscriber-places', ctx);
      if (placesRes.status === 401) {
        res.status(401).json({ error: 'unauthorized', message: 'Сессия истекла (401)' });
        return;
      }

      const rawPlaces: any[] = Array.isArray(placesRes.data?.data) ? placesRes.data.data : [];
      const syncIdentity = extractSubscriberIdentity(profileRes.data, rawPlaces, {
        phone: prevCachedSync?.phone || '',
        accountId: prevCachedSync?.accountId || ctx.userAgent.account_id || '',
        subscriberId: prevCachedSync?.subscriberId || '',
        name: prevCachedSync?.name || '',
      });
      if (syncIdentity.accountId && !ctx.userAgent.account_id) {
        ctx.userAgent.account_id = syncIdentity.accountId;
      }
      if (ctx.accessToken && !ctx.accessToken.startsWith('demo_')) {
        cacheVerifiedSession(ctx.accessToken, syncIdentity);
      }
      const places: any[] = [];
      const balances: Record<string, any> = {};
      const cameras: any[] = [];
      const locks: any[] = [];
      const dndByPlace: Record<string, any[]> = {};

      // Sequential per place to preserve UA place_id fingerprint (ADR-0006)
      for (const sp of rawPlaces) {
        const placeObj = sp?.place || {};
        const placeId = placeObj?.id != null ? String(placeObj.id) : null;
        if (!placeId) continue;

        const addressStr =
          placeObj?.address?.visibleAddress ||
          placeObj?.address?.groupName ||
          `Объект #${placeId}`;

        places.push({
          id: placeId,
          subscriberId: sp?.id,
          subscriberType: sp?.subscriberType,
          subscriberState: sp?.subscriberState,
          address: addressStr,
          rawAddress: placeObj?.address || {},
          location: placeObj?.location || null,
        });

        // 1. Balance
        try {
          const finRes = await egFetch(
            `/api/mh-payment/mobile/v1/finance?placeId=${encodeURIComponent(placeId)}`,
            ctx,
            { placeIdOverride: placeId }
          );
          if (finRes.ok && finRes.data?.data) {
            const f = finRes.data.data;
            balances[placeId] = {
              placeId,
              balance: f.balance,
              blockType: f.blockType,
              blocked: f.blocked,
              paymentDate: f.targetDate,
              paymentSum: f.amountSum,
              paymentLink: f.paymentLink,
              daysToBlock: f.daysToBlock,
              company: f.company,
            };
          }
        } catch {
          // Non-fatal
        }

        // 2. Screen visibility settings
        const hiddenCamIds = new Set<string>();
        const hiddenEntranceIds = new Set<string>();
        const favoriteCamIds = new Set<string>();
        const favoriteEntranceIds = new Set<string>();
        try {
          const screensRes = await egFetch(
            `/api/mh-customer/mobile/v1/customers/places/${encodeURIComponent(placeId)}/settings/screens`,
            ctx,
            { placeIdOverride: placeId }
          );
          const screens = screensRes.data?.screens;
          if (Array.isArray(screens)) {
            for (const sec of screens) {
              if (sec?.type === 'PUBLIC_CAMERAS') {
                for (const h of sec.hidden || []) {
                  if (h?.id != null) hiddenCamIds.add(String(h.id));
                }
              } else if (sec?.type === 'ACCESS_CONTROLS') {
                for (const h of sec.hidden || []) {
                  if (h?.id != null) hiddenEntranceIds.add(String(h.id));
                }
              } else if (sec?.type === 'FAVORITES') {
                for (const ent of sec.entities || []) {
                  if (ent?.type === 'PUBLIC_CAMERA' && ent?.id != null) {
                    favoriteCamIds.add(String(ent.id));
                  } else if (ent?.type === 'ACCESS_CONTROL_ENTRANCE' && ent?.id != null) {
                    favoriteEntranceIds.add(String(ent.id));
                  }
                }
              }
            }
          }
        } catch {
          // Non-fatal
        }

        // 3. Access Controls (Intercoms, Gates, Entrances)
        let accessControls: any[] = [];
        try {
          const acRes = await egFetch(
            `/rest/v1/places/${encodeURIComponent(placeId)}/accesscontrols`,
            ctx,
            { placeIdOverride: placeId }
          );
          if (acRes.ok && Array.isArray(acRes.data?.data)) {
            accessControls = acRes.data.data;
          }
        } catch {
          accessControls = [];
        }

        // Collect Locks and Intercom Cameras from accessControls
        for (const ac of accessControls) {
          const acId = ac?.id != null ? String(ac.id) : '';
          const acName = ac?.name || 'Домофон';
          const entrances: any[] = Array.isArray(ac?.entrances) ? ac.entrances : [];

          if (entrances.length > 0) {
            for (const ent of entrances) {
              const entId = ent?.id != null ? String(ent.id) : null;
              const extCamId = ent?.externalCameraId ? String(ent.externalCameraId) : null;
              const entName = ent?.name || acName;
              const isHidden = entId ? hiddenEntranceIds.has(entId) : false;
              const isFavorite = entId ? favoriteEntranceIds.has(entId) : false;

              locks.push({
                id: `lock_${placeId}_${acId}_${entId || 'main'}`,
                placeId,
                placeAddress: addressStr,
                accessControlId: acId,
                entranceId: entId,
                name: entName,
                acName,
                openable: Boolean(ent?.allowOpen ?? ac?.allowOpen ?? true),
                allowVideo: Boolean(ent?.allowVideo ?? ac?.allowVideo ?? true),
                externalCameraId: extCamId,
                hidden: isHidden,
                favorite: isFavorite,
              });

              if (extCamId) {
                cameras.push({
                  id: extCamId,
                  name: entName,
                  placeId,
                  placeAddress: addressStr,
                  accessControlId: acId,
                  entranceId: entId,
                  source: 'intercom',
                  hidden: isHidden,
                  favorite: isFavorite || favoriteCamIds.has(extCamId),
                  timeZone: ent?.timeZone ?? ac?.timeZone ?? 25200,
                  retentionDays: Math.max(1, Math.min(7, Number(ent?.retentionDays || ent?.archiveDays || ac?.retentionDays || 7) || 7)),
                  allowOpen: Boolean(ent?.allowOpen ?? ac?.allowOpen ?? true),
                  videoDownloadAvailable: Boolean(ent?.videoDownloadAvailable ?? ac?.videoDownloadAvailable ?? true),
                });
              }
            }
          } else {
            const extCamId = ac?.externalCameraId ? String(ac.externalCameraId) : null;
            locks.push({
              id: `lock_${placeId}_${acId}_main`,
              placeId,
              placeAddress: addressStr,
              accessControlId: acId,
              entranceId: null,
              name: acName,
              acName,
              openable: Boolean(ac?.allowOpen ?? true),
              allowVideo: Boolean(ac?.allowVideo ?? true),
              externalCameraId: extCamId,
              hidden: false,
              favorite: false,
            });

            if (extCamId) {
              cameras.push({
                id: extCamId,
                name: acName,
                placeId,
                placeAddress: addressStr,
                accessControlId: acId,
                entranceId: null,
                source: 'intercom',
                hidden: false,
                favorite: favoriteCamIds.has(extCamId),
                timeZone: ac?.timeZone ?? 25200,
                retentionDays: Math.max(1, Math.min(7, Number(ac?.retentionDays || ac?.archiveDays || 7) || 7)),
                allowOpen: Boolean(ac?.allowOpen ?? true),
                videoDownloadAvailable: Boolean(ac?.videoDownloadAvailable ?? true),
              });
            }
          }
        }

        // 4. Place Cameras (Personal Subscription Cameras)
        try {
          const placeCamRes = await egFetch(
            `/rest/v1/places/${encodeURIComponent(placeId)}/cameras`,
            ctx,
            { placeIdOverride: placeId }
          );
          if (placeCamRes.ok && Array.isArray(placeCamRes.data?.data)) {
            for (const cam of placeCamRes.data.data) {
              const cid = String(cam?.externalCameraId || cam?.id || '');
              if (!cid) continue;
              cameras.push({
                id: cid,
                name: cam?.name || `Камера ${cid}`,
                placeId,
                placeAddress: addressStr,
                accessControlId: null,
                entranceId: null,
                source: 'place',
                hidden: false,
                favorite: favoriteCamIds.has(cid),
                timeZone: cam?.timeZone ?? 25200,
                retentionDays: Math.max(1, Math.min(7, Number(cam?.retentionDays || cam?.archiveDays || 7) || 7)),
                allowOpen: false,
                videoDownloadAvailable: true,
              });
            }
          }
        } catch {
          // Non-fatal
        }

        // 5. Public Cameras (Courtyard, Elevator, Street, PRO adjacent entrances)
        const extractCameraArray = (payload: any): any[] => {
          if (Array.isArray(payload)) return payload;
          if (Array.isArray(payload?.data)) return payload.data;
          if (Array.isArray(payload?.items)) return payload.items;
          if (Array.isArray(payload?.cameras)) return payload.cameras;
          if (Array.isArray(payload?.data?.items)) return payload.data.items;
          if (Array.isArray(payload?.data?.cameras)) return payload.data.cameras;
          return [];
        };

        try {
          let pubCamRes = await egFetch(
            `/rest/v2/places/${encodeURIComponent(placeId)}/public/cameras`,
            ctx,
            { placeIdOverride: placeId }
          );
          let pubList = pubCamRes.ok ? extractCameraArray(pubCamRes.data) : [];
          if (pubList.length === 0) {
            const v1PubRes = await egFetch(
              `/rest/v1/places/${encodeURIComponent(placeId)}/public/cameras`,
              ctx,
              { placeIdOverride: placeId }
            );
            if (v1PubRes.ok) {
              const v1List = extractCameraArray(v1PubRes.data);
              if (v1List.length > 0) pubList = v1List;
            }
          }

          for (const cam of pubList) {
            const cid = String(cam?.externalCameraId || cam?.cameraId || cam?.id || cam?.ID || '');
            if (!cid) continue;
            cameras.push({
              id: cid,
              name: cam?.name || cam?.Name || cam?.title || `Камера двора ${cid}`,
              placeId,
              placeAddress: addressStr,
              accessControlId: null,
              entranceId: null,
              source: 'public',
              hidden: hiddenCamIds.has(cid),
              favorite: favoriteCamIds.has(cid),
              timeZone: cam?.timeZone ?? cam?.TimeZone ?? 25200,
              retentionDays: Math.max(1, Math.min(7, Number(cam?.retentionDays || cam?.RetentionDays || cam?.archiveDays || 7) || 7)),
              allowOpen: false,
              videoDownloadAvailable: true,
            });
          }
        } catch {
          // Non-fatal
        }

        // 6. Do Not Disturb settings
        try {
          const dndRes = await egFetch(
            `/api/mh-customer/mobile/v1/customers/places/${encodeURIComponent(placeId)}/settings/do_not_disturb`,
            ctx,
            { placeIdOverride: placeId }
          );
          if (dndRes.ok && Array.isArray(dndRes.data?.do_not_disturb)) {
            dndByPlace[placeId] = dndRes.data.do_not_disturb;
          }
        } catch {
          // Non-fatal
        }
      }

      // 6B. Global Forpost cameras endpoint (`/rest/v1/forpost/cameras` — exposes PRO & neighbor-entrance cameras with capitalized ID/Name)
      try {
        const fpRes = await egFetch('/rest/v1/forpost/cameras', ctx);
        if (fpRes.ok) {
          const fpList = Array.isArray(fpRes.data)
            ? fpRes.data
            : Array.isArray(fpRes.data?.data)
              ? fpRes.data.data
              : Array.isArray(fpRes.data?.items)
                ? fpRes.data.items
                : Array.isArray(fpRes.data?.cameras)
                  ? fpRes.data.cameras
                  : [];
          const defaultPlaceId = places[0]?.id || '1';
          const defaultPlaceAddress = places[0]?.address || 'Мой дом';
          for (const cam of fpList) {
            if (!cam || typeof cam !== 'object') continue;
            const cid = String(cam.ID ?? cam.id ?? cam.externalCameraId ?? cam.cameraId ?? '').trim();
            if (!cid) continue;
            const rawPlaceId = cam.placeId ?? cam.PlaceID ?? cam.place_id;
            const matchedPlace =
              rawPlaceId != null
                ? places.find((p) => String(p.id) === String(rawPlaceId))
                : null;
            cameras.push({
              id: cid,
              name: String(cam.Name || cam.name || cam.title || `Камера ${cid}`),
              placeId: matchedPlace?.id || (rawPlaceId != null ? String(rawPlaceId) : defaultPlaceId),
              placeAddress: matchedPlace?.address || defaultPlaceAddress,
              accessControlId: null,
              entranceId: null,
              source: 'public',
              hidden: false,
              favorite: false,
              timeZone: Number(cam.TimeZone ?? cam.timeZone ?? 25200) || 25200,
              retentionDays: Math.max(1, Math.min(7, Number(cam.RetentionDays || cam.retentionDays || cam.archiveDays || 7) || 7)),
              allowOpen: false,
              videoDownloadAvailable: true,
            });
          }
        }
      } catch {
        // Non-fatal
      }

      // Deduplicate cameras by ID preserving priority: intercom > place > public
      const dedupedCameras: any[] = [];
      const seenCamIds = new Set<string>();
      for (const cam of cameras) {
        if (!seenCamIds.has(cam.id)) {
          seenCamIds.add(cam.id);
          dedupedCameras.push(cam);
        }
      }

      // Attach ESP32 Gate Controller locks to "Камера фасад 1 - 3-Й Мкр 6 б" and "Камера фасад 2 - 3-Й Мкр 6 б"
      for (const cam of dedupedCameras) {
        const gateMeta = detectFacadeGateCamera(cam.name);
        if (!gateMeta) continue;
        cam.allowOpen = true;
        if (!cam.accessControlId) cam.accessControlId = gateMeta.accessControlId;
        if (!cam.entranceId) cam.entranceId = gateMeta.entranceId;

        const alreadyHasGateLock = locks.some(
          (l) =>
            l.externalCameraId === cam.id ||
            (String(l.placeId) === String(cam.placeId) &&
              String(l.accessControlId) === gateMeta.accessControlId)
        );
        if (!alreadyHasGateLock) {
          locks.push({
            id: `lock_esp32_${cam.placeId}_gate_${gateMeta.channel}`,
            placeId: cam.placeId,
            placeAddress: cam.placeAddress,
            accessControlId: gateMeta.accessControlId,
            entranceId: gateMeta.entranceId,
            name: cam.name,
            acName: gateMeta.acLabel,
            openable: true,
            allowVideo: true,
            externalCameraId: cam.id,
            hidden: false,
            favorite: true,
            kind: 'gate',
            controllerType: 'esp32',
            esp32Channel: gateMeta.channel,
          });
        }
      }

      const syncedUser = upsertBillingUserFromIdentity({
        phone: syncIdentity.phone,
        accountId: syncIdentity.accountId,
        subscriberId: syncIdentity.subscriberId,
        name: syncIdentity.name,
        address: places[0]?.address || '',
      });

      for (const lock of locks) {
        rememberPlaceControlCamera(
          lock.placeId,
          lock.accessControlId,
          lock.entranceId,
          lock.externalCameraId
        );
      }

      const syncedPlaceIds = new Set(places.map((p) => String(p.id)));
      let passesBackfilled = false;
      for (const rec of localGuestPasses.values()) {
        if (!syncedPlaceIds.has(String(rec.placeId))) continue;
        if (!rec.ownerUserId && rec.ownerCtx?.accessToken === ctx.accessToken) {
          rec.ownerUserId = syncedUser.userId;
          passesBackfilled = true;
        }
        if (Array.isArray(rec.availableAccessControl)) {
          for (const ac of rec.availableAccessControl) {
            if (!ac.cameraId) {
              const matchedCamId = lookupCachedPlaceControlCamera(
                rec.placeId,
                ac.id,
                ac.entranceId
              );
              if (matchedCamId) {
                ac.cameraId = matchedCamId;
                passesBackfilled = true;
              }
            }
          }
        }
      }
      if (passesBackfilled) {
        saveLocalGuestPassesToDisk();
      }

      const userCameraAliases = getCameraAliasesForUser(syncedUser.userId);
      for (const cam of dedupedCameras) {
        const rawName = String(cam.name || '');
        cam.originalName = rawName;
        const alias = userCameraAliases[cam.id];
        if (alias && alias.trim()) {
          cam.name = alias.trim();
        }
      }

      res.json({
        subscriber,
        places,
        balances,
        locks,
        cameras: dedupedCameras,
        cameraAliases: userCameraAliases,
        dnd: dndByPlace,
        userAgent: ctx.userAgent,
      });
    } catch (err: any) {
      res.status(502).json({
        error: 'sync_error',
        message: `Ошибка синхронизации данных: ${err?.message || 'Unknown'}`,
      });
    }
  });

  // 7. Open Door / Gate / Barrier (`api.py:open_lock` + ESP32 Remote Relay for Gates)
  app.post('/api/eg/locks/open', async (req: Request, res: Response) => {
    try {
      if (!(await assertActiveSubscription(req, res))) return;
      const ctx = extractContext(req);
      const { placeId, accessControlId, entranceId } = req.body || {};
      if (!placeId || !accessControlId) {
        res.status(400).json({ error: 'missing_params', message: 'Не указан placeId или accessControlId' });
        return;
      }

      // Check if this lock is an ESP32-controlled gate ("Камера фасад 1" / "Камера фасад 2")
      const esp32Channel = resolveEsp32ChannelFromLockParams(accessControlId, entranceId);
      if (esp32Channel !== null) {
        const triggerEvent = await triggerEsp32Gate(esp32Channel);
        res.json({
          ok: true,
          controller: 'esp32',
          channel: esp32Channel,
          pulseMs: triggerEvent.pulseMs,
          deliveryMode: triggerEvent.deliveryMode,
          timestamp: new Date(triggerEvent.timestamp).toISOString(),
        });
        return;
      }

      const apiUrl =
        entranceId == null || entranceId === ''
          ? `/rest/v1/places/${encodeURIComponent(String(placeId))}/accesscontrols/${encodeURIComponent(String(accessControlId))}/actions`
          : `/rest/v1/places/${encodeURIComponent(String(placeId))}/accesscontrols/${encodeURIComponent(String(accessControlId))}/entrances/${encodeURIComponent(String(entranceId))}/actions`;

      const openRes = await egFetch(apiUrl, ctx, {
        method: 'POST',
        body: { name: 'accessControlOpen' },
        placeIdOverride: String(placeId),
      });

      if (!openRes.ok) {
        res.status(openRes.status || 400).json({
          error: 'open_failed',
          message: `Оператор отклонил команду открытия (${openRes.status})`,
          details: openRes.data,
        });
        return;
      }

      res.json({
        ok: true,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(502).json({
        error: 'network_error',
        message: `Ошибка при отправке команды открытия двери: ${err?.message || 'Unknown'}`,
      });
    }
  });

  // 8. Camera & Intercom Snapshot Binary Proxy (Section 5: Forpost + AccessControl Snapshot fallback)
  app.get('/api/eg/cameras/:cameraId/snapshot', async (req: Request, res: Response) => {
    try {
      const cameraId = String(req.params.cameraId || '');
      const width = Number(req.query.width) || 640;
      const height = Number(req.query.height) || Math.round((width / 16) * 9);
      const token = (req.query.token as string) || (req.headers['x-eg-token'] as string);
      const operatorId = (req.query.operator as string) || (req.headers['x-eg-operator'] as string) || '1';
      const placeId = (req.query.placeId as string) || 'null';
      const accessControlId = (req.query.accessControlId as string) || '';
      const entranceId = (req.query.entranceId as string) || '';

      const ctx = extractContext(req);
      if (token) ctx.accessToken = token;
      if (operatorId) ctx.operatorId = operatorId;

      // Primary method: GET /rest/v1/forpost/cameras/{camera_id}/snapshots?width=640&height=360
      const primaryUrl = `/rest/v1/forpost/cameras/${encodeURIComponent(cameraId)}/snapshots?width=${width}&height=${height}`;
      let snapRes = await egFetch(primaryUrl, ctx, {
        binary: true,
        placeIdOverride: placeId,
      });

      // Fallback method (Section 5): GET /rest/v1/places/{place_id}/accesscontrols/{ac_id}/snapshots?entranceId={entrance_id}&width=640&height=360
      if ((!snapRes.ok || !snapRes.buffer || snapRes.buffer.length === 0) && placeId !== 'null' && accessControlId) {
        const entranceQuery = entranceId ? `entranceId=${encodeURIComponent(entranceId)}&` : '';
        const fallbackUrl = `/rest/v1/places/${encodeURIComponent(placeId)}/accesscontrols/${encodeURIComponent(accessControlId)}/snapshots?${entranceQuery}width=${width}&height=${height}`;
        snapRes = await egFetch(fallbackUrl, ctx, {
          binary: true,
          placeIdOverride: placeId,
        });
      }

      if (!snapRes.ok || !snapRes.buffer || snapRes.buffer.length === 0) {
        res.status(snapRes.status || 502).json({
          error: 'snapshot_unavailable',
          message: `Снимок камеры ${cameraId} временно недоступен (${snapRes.status})`,
        });
        return;
      }

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('X-Snapshot-Timestamp', new Date().toISOString());
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.send(snapRes.buffer);
    } catch (err: any) {
      res.status(502).json({
        error: 'snapshot_error',
        message: `Ошибка получения снимка: ${err?.message || 'Unknown'}`,
      });
    }
  });

  // 8b. Direct Intercom AccessControl Snapshot Proxy (Section 5: GET /rest/v1/places/{place_id}/accesscontrols/{ac_id}/snapshots)
  app.get('/api/eg/accesscontrols/:accessControlId/snapshot', async (req: Request, res: Response) => {
    try {
      const accessControlId = String(req.params.accessControlId || '');
      const placeId = String(req.query.placeId || '');
      const entranceId = String(req.query.entranceId || '');
      const width = Number(req.query.width) || 640;
      const height = Number(req.query.height) || 360;

      if (!placeId || !accessControlId) {
        res.status(400).json({ error: 'missing_params', message: 'Не указаны placeId или accessControlId' });
        return;
      }

      const ctx = extractContext(req);
      const entranceParam = entranceId ? `entranceId=${encodeURIComponent(entranceId)}&` : '';
      const apiUrl = `/rest/v1/places/${encodeURIComponent(placeId)}/accesscontrols/${encodeURIComponent(accessControlId)}/snapshots?${entranceParam}width=${width}&height=${height}`;

      const snapRes = await egFetch(apiUrl, ctx, {
        binary: true,
        placeIdOverride: placeId,
      });

      if (!snapRes.ok || !snapRes.buffer || snapRes.buffer.length === 0) {
        res.status(snapRes.status || 502).json({
          error: 'intercom_snapshot_unavailable',
          message: `Снимок домофона #${accessControlId} временно недоступен`,
        });
        return;
      }

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('X-Snapshot-Timestamp', new Date().toISOString());
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.send(snapRes.buffer);
    } catch (err: any) {
      res.status(502).json({
        error: 'intercom_snapshot_error',
        message: err?.message || 'Unknown',
      });
    }
  });

  // 9. Query Live or Archive Stream URL (`api.py:query_camera_stream` & `api-reference.md`)
  app.get('/api/eg/cameras/:cameraId/stream', async (req: Request, res: Response) => {
    try {
      const cameraId = String(req.params.cameraId || '');
      const ts = req.query.ts ? String(req.query.ts) : null;
      const tz = req.query.tz ? String(req.query.tz) : '25200';
      const placeId = req.query.placeId ? String(req.query.placeId) : 'null';
      const speedParam = req.query.speed ? String(req.query.speed) : '-1.0';

      if (ts && !(await assertActiveSubscription(req, res))) return;

      const ctx = extractContext(req);

      let apiUrl = `/rest/v1/forpost/cameras/${encodeURIComponent(cameraId)}/video?LightStream=0&Format=H264`;
      if (ts) {
        // Archive playback stream from unix timestamp TS (HAR 9.11.0 spec)
        apiUrl = `/rest/v1/forpost/cameras/${encodeURIComponent(cameraId)}/video?TS=${encodeURIComponent(ts)}&TZ=${encodeURIComponent(tz)}&LightStream=0&Format=H264&Speed=${encodeURIComponent(speedParam)}`;
      }

      const streamRes = await egFetch(apiUrl, ctx, { placeIdOverride: placeId });
      const streamUrl =
        streamRes.data?.data?.URL ||
        streamRes.data?.data?.url ||
        streamRes.data?.URL ||
        streamRes.data?.url;
      const bizError = streamRes.data?.data?.Error || streamRes.data?.errorMessage;

      if (!streamRes.ok || !streamUrl) {
        let minAvailableTs: number | null = null;
        let minAvailableLabel: string | null = null;
        if (typeof bizError === 'string') {
          const dtMatch = /(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/.exec(bizError);
          if (dtMatch) {
            const dd = parseInt(dtMatch[1], 10);
            const mm = parseInt(dtMatch[2], 10);
            const yyyy = parseInt(dtMatch[3], 10);
            const hh = parseInt(dtMatch[4], 10);
            const mi = parseInt(dtMatch[5], 10);
            const ss = parseInt(dtMatch[6], 10);
            const tzOffsetSec = Number(tz) || 25200;
            const computed = Math.floor(Date.UTC(yyyy, mm - 1, dd, hh, mi, ss) / 1000) - tzOffsetSec;
            if (Number.isFinite(computed) && computed > 0) {
              minAvailableTs = computed;
              minAvailableLabel = dtMatch[0];
            }
          }
        }
        res.status(streamRes.status === 200 ? 404 : streamRes.status || 502).json({
          error: 'stream_unavailable',
          message: bizError || 'Не удалось получить ссылку на видеопоток от оператора',
          minAvailableTs,
          minAvailableLabel,
        });
        return;
      }

      res.json({
        cameraId,
        mode: ts ? 'archive' : 'live',
        ts: ts ? Number(ts) : null,
        upstreamUrl: streamUrl,
        proxyFlvUrl: `/api/eg/stream-proxy?url=${encodeURIComponent(streamUrl)}`,
      });
    } catch (err: any) {
      res.status(502).json({
        error: 'stream_error',
        message: `Ошибка запроса потока: ${err?.message || 'Unknown'}`,
      });
    }
  });

  // Helper: Wrap raw s16le 22050Hz Mono PCM buffer into an atomic FLV Audio Tag (tagType = 8, soundSpec = 0x3a)
  function buildFlvPcmAudioTag(pcmChunk: Buffer, timestampMs: number): Buffer {
    const dataSize = 1 + pcmChunk.length;
    const totalTagSize = 11 + dataSize + 4;
    const tag = Buffer.allocUnsafe(totalTagSize);

    tag[0] = 8; // Audio tag
    tag[1] = (dataSize >>> 16) & 0xff;
    tag[2] = (dataSize >>> 8) & 0xff;
    tag[3] = dataSize & 0xff;

    const ts = timestampMs >>> 0;
    tag[4] = (ts >>> 16) & 0xff;
    tag[5] = (ts >>> 8) & 0xff;
    tag[6] = ts & 0xff;
    tag[7] = (ts >>> 24) & 0xff;

    tag[8] = 0;
    tag[9] = 0;
    tag[10] = 0;

    // 0x3a => soundFormat=3 (Linear PCM little-endian), soundRate=2 (22050 Hz), soundSize=1 (16-bit), soundType=0 (Mono)
    tag[11] = 0x3a;
    pcmChunk.copy(tag, 12);
    tag.writeUInt32BE(11 + dataSize, 11 + dataSize);

    return tag;
  }

  // 10. HTTP-FLV Live & Archive Stream Proxy with Real-Time MP3 -> 16-bit PCM Audio Transcoder
  app.get('/api/eg/stream-proxy', async (req: Request, res: Response) => {
    const targetUrl = String(req.query.url || '');
    if (!targetUrl || (!targetUrl.startsWith('https://') && !targetUrl.startsWith('http://'))) {
      res.status(400).json({ error: 'invalid_stream_url', message: 'Некорректный URL потока' });
      return;
    }

    const abortController = new AbortController();
    let ffmpegProc: ChildProcessWithoutNullStreams | null = null;
    let ffmpegFailed = false;
    let headerWritten = false;
    let lastAudioTimestamp = 0;
    let pcmLeftover: Buffer = Buffer.alloc(0);

    const cleanupFfmpeg = () => {
      if (ffmpegProc) {
        try {
          ffmpegProc.stdin.destroy();
          ffmpegProc.kill('SIGKILL');
        } catch {
          // ignore
        }
        ffmpegProc = null;
      }
    };

    req.on('close', () => {
      abortController.abort();
      cleanupFfmpeg();
    });

    const ensureFfmpegDecoder = (): ChildProcessWithoutNullStreams | null => {
      if (ffmpegFailed) return null;
      if (ffmpegProc) return ffmpegProc;
      try {
        const proc = spawn('ffmpeg', [
          '-loglevel',
          'error',
          '-probesize',
          '1024',
          '-analyzeduration',
          '100000',
          '-fflags',
          'nobuffer',
          '-flags',
          'low_delay',
          '-f',
          'mp3',
          '-i',
          'pipe:0',
          '-af',
          'highpass=f=80,volume=2.6,alimiter=limit=0.96',
          '-f',
          's16le',
          '-ar',
          '22050',
          '-ac',
          '1',
          'pipe:1',
        ]);

        proc.on('error', () => {
          ffmpegFailed = true;
          ffmpegProc = null;
        });

        proc.stdin.on('error', () => {
          // ignore EPIPE on stream close
        });

        proc.stdout.on('data', (chunk: Buffer) => {
          if (res.writableEnded || !headerWritten) return;
          const combinedPcm =
            pcmLeftover.length > 0 ? Buffer.concat([pcmLeftover, chunk]) : chunk;
          const evenLen = combinedPcm.length & ~1;
          if (evenLen === 0) {
            pcmLeftover = Buffer.from(combinedPcm);
            return;
          }
          pcmLeftover = Buffer.from(combinedPcm.subarray(evenLen));

          const maxSlice = 4096;
          for (let pos = 0; pos < evenLen; pos += maxSlice) {
            const slice = combinedPcm.subarray(pos, Math.min(pos + maxSlice, evenLen));
            const flvAudioTag = buildFlvPcmAudioTag(slice, lastAudioTimestamp);
            res.write(flvAudioTag);
          }
        });

        ffmpegProc = proc;
        return proc;
      } catch {
        ffmpegFailed = true;
        return null;
      }
    };

    try {
      // Exact headers used by ExoPlayer in HAR 9.11.0 (`docs/architecture/api-reference.md`)
      const upstream = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 16; Pixel 9 Pro Build/BP2A.250605.031.A2)',
          'Icy-MetaData': '1',
          'Accept-Encoding': 'identity',
        },
        signal: abortController.signal,
      });

      if (!upstream.ok || !upstream.body) {
        cleanupFfmpeg();
        res.status(upstream.status || 502).json({
          error: 'upstream_stream_error',
          message: `Сервер видеопотока вернул статус ${upstream.status}`,
        });
        return;
      }

      res.setHeader('Content-Type', 'video/x-flv');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      let leftover: Buffer = Buffer.alloc(0);
      const reader = upstream.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        const incoming = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        const combined = leftover.length > 0 ? Buffer.concat([leftover, incoming]) : incoming;
        let offset = 0;

        if (!headerWritten) {
          if (combined.length < 13) {
            leftover = Buffer.from(combined);
            continue;
          }
          if (
            combined[0] === 0x46 &&
            combined[1] === 0x4c &&
            combined[2] === 0x56 &&
            combined[3] === 0x01
          ) {
            const headerSize = combined.readUInt32BE(5);
            const totalHeaderBytes = headerSize + 4;
            if (combined.length < totalHeaderBytes) {
              leftover = Buffer.from(combined);
              continue;
            }
            res.write(combined.subarray(0, totalHeaderBytes));
            offset = totalHeaderBytes;
            headerWritten = true;
          } else {
            headerWritten = true;
            res.write(combined);
            leftover = Buffer.alloc(0);
            continue;
          }
        }

        while (offset + 15 <= combined.length) {
          const tagType = combined[offset];
          const dataSize =
            (combined[offset + 1] << 16) |
            (combined[offset + 2] << 8) |
            combined[offset + 3];
          const totalTagBytes = 11 + dataSize + 4;

          if (offset + totalTagBytes > combined.length) {
            break;
          }

          const fullTag = combined.subarray(offset, offset + totalTagBytes);

          if (tagType === 8 && dataSize > 1) {
            const ts =
              (combined[offset + 4] << 16) |
              (combined[offset + 5] << 8) |
              combined[offset + 6] |
              (combined[offset + 7] << 24);
            lastAudioTimestamp = ts >>> 0;

            const soundSpec = combined[offset + 11];
            const soundFormat = soundSpec >>> 4;

            if (soundFormat === 2 || soundFormat === 14) {
              const decoder = ensureFfmpegDecoder();
              if (decoder && decoder.stdin.writable) {
                const mp3Payload = combined.subarray(offset + 12, offset + 11 + dataSize);
                decoder.stdin.write(mp3Payload);
              } else {
                res.write(fullTag);
              }
            } else {
              res.write(fullTag);
            }
          } else {
            const canContinue = res.write(fullTag);
            if (!canContinue) {
              await new Promise<void>((resolve) => {
                const onAbort = () => resolve();
                if (abortController.signal.aborted) {
                  resolve();
                  return;
                }
                abortController.signal.addEventListener('abort', onAbort, { once: true });
                res.once('drain', () => {
                  abortController.signal.removeEventListener('abort', onAbort);
                  resolve();
                });
              });
            }
          }

          offset += totalTagBytes;
        }

        leftover = Buffer.from(combined.subarray(offset));
      }

      cleanupFfmpeg();
      res.end();
    } catch (err: any) {
      cleanupFfmpeg();
      if (!res.headersSent) {
        res.status(502).json({
          error: 'stream_proxy_failed',
          message: `Обрыв видеопотока: ${err?.message || 'Closed'}`,
        });
      } else {
        res.end();
      }
    }
  });

  // 11. Camera Archive Motion Events (`api.py:query_camera_events`)
  app.get('/api/eg/cameras/:cameraId/events', async (req: Request, res: Response) => {
    try {
      if (!(await assertActiveSubscription(req, res))) return;
      const cameraId = String(req.params.cameraId || '');
      const lowerDate = String(req.query.lowerDate || '');
      const upperDate = String(req.query.upperDate || '');
      const placeId = String(req.query.placeId || 'null');
      const requestedCount = Math.max(
        10,
        Math.min(100, parseInt(String(req.query.count || '100'), 10) || 100)
      );

      if (!lowerDate || !upperDate) {
        res.status(400).json({ error: 'missing_dates', message: 'Укажите lowerDate и upperDate' });
        return;
      }

      const ctx = extractContext(req);
      const query = new URLSearchParams({
        UpperDate: upperDate,
        LowerDate: lowerDate,
        Count: String(requestedCount),
        orderByTime: 'DESC',
      }).toString();

      const evRes = await egFetch(
        `/rest/v2/forpost/cameras/${encodeURIComponent(cameraId)}/events?${query}`,
        ctx,
        { placeIdOverride: placeId }
      );

      const rawList: any[] = Array.isArray(evRes.data?.data) ? evRes.data.data : [];
      const events = rawList
        .map((item) => ({
          id: String(item.ID),
          cameraId,
          backendCameraId: String(item.CameraID || cameraId),
          timestamp: Number(item.Time),
          duration: Number(item.Duration || 0),
          eventSubjectId: Number(item.EventSubjectID || 126),
          available: Boolean(item.isAvailable ?? true),
          gotoEnabled: Number(item.IsGotoEnabled ?? 1) === 1,
          message: item.Message || null,
        }))
        .sort((a, b) => b.timestamp - a.timestamp);

      const hasMore = rawList.length >= requestedCount;
      res.json({ events, rawCount: rawList.length, hasMore });
    } catch (err: any) {
      res.status(502).json({
        error: 'events_error',
        message: `Ошибка загрузки архива событий камеры: ${err?.message || 'Unknown'}`,
      });
    }
  });

  // Helper: Remux a Forpost archive stream (`video?TS=...`) or generate a Demo MP4 clip via ffmpeg
  async function remuxStreamOrDemoToMp4Buffer(options: {
    streamUrl?: string | null;
    durationSec: number;
    isDemo?: boolean;
  }): Promise<Buffer | null> {
    const dur = Math.max(4, Math.min(300, Math.round(options.durationSec || 30)));
    const tmpFile = path.join('/tmp', `domru_clip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`);
    try {
      const args = options.isDemo
        ? [
            '-y',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            `testsrc2=size=640x360:rate=25:duration=${dur}`,
            '-f',
            'lavfi',
            '-i',
            `sine=frequency=520:sample_rate=22050:duration=${dur}`,
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            '64k',
            '-movflags',
            '+faststart',
            tmpFile,
          ]
        : [
            '-y',
            '-loglevel',
            'error',
            '-user_agent',
            'Dalvik/2.1.0 (Linux; U; Android 16; Pixel 9 Pro Build/BP2A.250605.031.A2)',
            '-headers',
            'Icy-MetaData: 1\r\nAccept-Encoding: identity\r\n',
            '-rw_timeout',
            '15000000',
            '-i',
            String(options.streamUrl),
            '-t',
            String(dur),
            '-c:v',
            'copy',
            '-c:a',
            'aac',
            '-b:a',
            '64k',
            '-movflags',
            '+faststart',
            tmpFile,
          ];

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', args);
        const timer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {}
          reject(new Error('ffmpeg timeout'));
        }, Math.max(45, dur + 45) * 1000);
        proc.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exited with code ${code}`));
        });
      });

      const fs = await import('fs/promises');
      const buf = await fs.readFile(tmpFile);
      await fs.unlink(tmpFile).catch(() => {});
      return buf.length > 256 ? buf : null;
    } catch {
      try {
        const fs = await import('fs/promises');
        await fs.unlink(tmpFile).catch(() => {});
      } catch {}
      return null;
    }
  }

  // 12. MP4 Archive Event Clip Proxy with HTTP 206 Byte-Range Support & Stream Remux Fallback (`clip_proxy.py`)
  app.get('/api/eg/events/:eventId/clip', async (req: Request, res: Response) => {
    try {
      if (!(await assertActiveSubscription(req, res))) return;
      cleanupClipCache();
      const eventId = String(req.params.eventId || '');
      const downloadMode = req.query.download === '1';
      const cameraId = typeof req.query.cameraId === 'string' ? req.query.cameraId : '';
      const placeId = typeof req.query.placeId === 'string' ? req.query.placeId : 'null';
      const tsQuery = req.query.ts ? Number(req.query.ts) : 0;
      const durationQuery = req.query.duration ? Number(req.query.duration) : 30;
      const tzQuery = typeof req.query.tz === 'string' && req.query.tz ? req.query.tz : '25200';

      const ctx = extractContext(req);

      // Ensure account_id is populated if missing in query UA so Forpost doesn't reject with 403/404
      if (!ctx.userAgent.account_id && ctx.accessToken && !ctx.accessToken.startsWith('demo_')) {
        try {
          const profRes = await egFetch('/rest/v1/subscribers/profiles', ctx);
          const sub = profRes.data?.data?.subscriber || profRes.data?.subscriber;
          const accId = sub?.accountId || profRes.data?.data?.accountId;
          if (accId) {
            ctx.userAgent.account_id = String(accId);
          }
        } catch {
          // ignore
        }
      }

      const isDemo =
        !ctx.accessToken ||
        ctx.accessToken.startsWith('demo_') ||
        eventId.startsWith('ev_');

      const cacheKey = `${ctx.accessToken?.slice(0, 12) || 'demo'}_${eventId}_${tsQuery}`;
      let cached = clipCache.get(cacheKey);

      const reqRange = typeof req.headers.range === 'string' ? req.headers.range.trim() : '';
      const isZeroStartRange = !reqRange || /^bytes=0-\s*$/i.test(reqRange);
      const clientAbort = new AbortController();
      req.on('close', () => clientAbort.abort());

      if (!cached && !isDemo && !eventId.startsWith('ts_')) {
        const resolveSignedUrl = async (forceRefresh: boolean): Promise<string | null> => {
          if (!forceRefresh) {
            const cachedUrl = signedClipUrlCache.get(cacheKey);
            if (cachedUrl && Date.now() - cachedUrl.createdAt < CLIP_TTL_MS) {
              return cachedUrl.url;
            }
          }
          const backoff = [400, 750, 1100, 1500, 2000];
          const deadline = Date.now() + 35000;
          let attempt = 0;

          while (Date.now() < deadline && !clientAbort.signal.aborted) {
            const dlRes = await egFetch(
              `/rest/v1/forpost/events/${encodeURIComponent(eventId)}/downloads?container=mp4`,
              ctx,
              { placeIdOverride: placeId }
            );
            const errCode = String(dlRes.data?.errorCode ?? dlRes.data?.ErrorCode ?? '');
            if (dlRes.status === 423 || errCode === '102') {
              const delay = backoff[Math.min(attempt, backoff.length - 1)];
              attempt++;
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }

            const rawData = dlRes.data?.data;
            const url =
              typeof rawData === 'string'
                ? rawData
                : rawData?.URL || rawData?.url || dlRes.data?.URL || dlRes.data?.url || null;

            if (!dlRes.ok || typeof url !== 'string' || !url) {
              return null;
            }
            signedClipUrlCache.set(cacheKey, { url, createdAt: Date.now() });
            return url;
          }
          return null;
        };

        const openUpstreamClip = async (): Promise<globalThis.Response | null> => {
          const backoff = [450, 800, 1200, 1800];
          const deadline = Date.now() + 35000;
          let attempt = 0;
          let forceRefreshUrl = false;

          while (Date.now() < deadline && !clientAbort.signal.aborted) {
            const signedUrl = await resolveSignedUrl(forceRefreshUrl);
            forceRefreshUrl = false;
            if (!signedUrl) return null;

            const headers: Record<string, string> = {
              'User-Agent':
                'Dalvik/2.1.0 (Linux; U; Android 16; Pixel 9 Pro Build/BP2A.250605.031.A2)',
              'Accept-Encoding': 'identity',
            };
            if (reqRange && !downloadMode) {
              headers.Range = reqRange;
            }

            const upstreamClip = await fetch(signedUrl, {
              headers,
              signal: clientAbort.signal,
            });

            if (upstreamClip.status === 423) {
              const delay = backoff[Math.min(attempt, backoff.length - 1)];
              attempt++;
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }
            if ((upstreamClip.status === 401 || upstreamClip.status === 403 || upstreamClip.status === 404 || upstreamClip.status === 410) && attempt === 0) {
              signedClipUrlCache.delete(cacheKey);
              forceRefreshUrl = true;
              attempt++;
              continue;
            }
            if (!upstreamClip.ok) {
              return null;
            }
            return upstreamClip;
          }
          return null;
        };

        const upstreamClip = await openUpstreamClip();
        if (upstreamClip && upstreamClip.body) {
          const canStreamDirectly =
            downloadMode || upstreamClip.status === 206 || isZeroStartRange;

          if (canStreamDirectly) {
            const upstreamLen = upstreamClip.headers.get('content-length');
            const upstreamRange = upstreamClip.headers.get('content-range');
            const upstreamType = upstreamClip.headers.get('content-type') || 'video/mp4';

            res.status(downloadMode ? 200 : upstreamClip.status === 206 ? 206 : 200);
            res.setHeader('Content-Type', upstreamType.includes('video') ? upstreamType : 'video/mp4');
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Cache-Control', 'private, no-store');
            if (upstreamRange && upstreamClip.status === 206 && !downloadMode) {
              res.setHeader('Content-Range', upstreamRange);
            }
            if (upstreamLen) {
              res.setHeader('Content-Length', upstreamLen);
            }
            if (downloadMode) {
              const fileLabel = cameraId
                ? `archive-cam-${cameraId}-${eventId}.mp4`
                : `camera-event-${eventId}.mp4`;
              res.setHeader('Content-Disposition', `attachment; filename="${fileLabel}"`);
            }

            const collectForCache =
              upstreamClip.status === 200 && isZeroStartRange && !downloadMode;
            const ramChunks: Buffer[] = [];
            let ramBytes = 0;
            const MAX_CACHE_BYTES = 48 * 1024 * 1024;
            const reader = upstreamClip.body.getReader();

            try {
              while (!clientAbort.signal.aborted) {
                const { done, value } = await reader.read();
                if (done) {
                  if (collectForCache && ramBytes > 256 && ramBytes <= MAX_CACHE_BYTES) {
                    const fullBuf = Buffer.concat(ramChunks, ramBytes);
                    if (isMp4Complete(fullBuf)) {
                      clipCache.set(cacheKey, { buffer: fullBuf, createdAt: Date.now() });
                    }
                  }
                  break;
                }
                if (value && value.byteLength > 0) {
                  const chunkBuf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
                  if (collectForCache && ramBytes + chunkBuf.length <= MAX_CACHE_BYTES) {
                    ramChunks.push(chunkBuf);
                    ramBytes += chunkBuf.length;
                  }
                  if (!res.writableEnded) {
                    const ok = res.write(chunkBuf);
                    if (!ok && !clientAbort.signal.aborted) {
                      await new Promise<void>((resolve) => {
                        const onAbort = () => resolve();
                        clientAbort.signal.addEventListener('abort', onAbort, { once: true });
                        res.once('drain', () => {
                          clientAbort.signal.removeEventListener('abort', onAbort);
                          resolve();
                        });
                      });
                    }
                  }
                }
              }
            } catch {
              // Client aborted or connection reset cleanly
            }
            if (!res.writableEnded) res.end();
            return;
          } else {
            // Upstream ignored non-zero/bounded Range and returned full 200.
            const probeMatch = /^bytes=0-(\d+)$/i.exec(reqRange);
            const upstreamTotalRaw = Number(upstreamClip.headers.get('content-length') || 0);
            if (probeMatch) {
              const requestedEnd = parseInt(probeMatch[1], 10);
              const maxRead = Math.min(requestedEnd + 1, 2 * 1024 * 1024);
              const reader = upstreamClip.body.getReader();
              const chunks: Buffer[] = [];
              let readBytes = 0;
              try {
                while (readBytes < maxRead && !clientAbort.signal.aborted) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value && value.byteLength > 0) {
                    const need = maxRead - readBytes;
                    const slice = value.byteLength > need ? value.subarray(0, need) : value;
                    chunks.push(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
                    readBytes += slice.byteLength;
                  }
                }
              } finally {
                reader.cancel().catch(() => {});
              }
              const headBuf = Buffer.concat(chunks, readBytes);
              if (headBuf.length > 0) {
                const totalLabel =
                  Number.isFinite(upstreamTotalRaw) && upstreamTotalRaw > 0
                    ? String(upstreamTotalRaw)
                    : '*';
                res.status(206);
                res.setHeader('Content-Type', 'video/mp4');
                res.setHeader('Accept-Ranges', 'bytes');
                res.setHeader('Content-Range', `bytes 0-${headBuf.length - 1}/${totalLabel}`);
                res.setHeader('Content-Length', String(headBuf.length));
                res.setHeader('Cache-Control', 'private, no-store');
                res.send(headBuf);
                return;
              }
            } else if (!upstreamTotalRaw || upstreamTotalRaw <= 48 * 1024 * 1024) {
              const arrBuf = await upstreamClip.arrayBuffer();
              const fullBuf = Buffer.from(arrBuf);
              if (fullBuf.length > 0 && isMp4Complete(fullBuf)) {
                cached = { buffer: fullBuf, createdAt: Date.now() };
                if (fullBuf.length <= 48 * 1024 * 1024) {
                  clipCache.set(cacheKey, cached);
                }
              }
            }
          }
        }
      }

      if (!cached) {
        let clipBuffer: Buffer | null = null;
        let streamBizError: string | null = null;

        if (isDemo) {
          clipBuffer = await remuxStreamOrDemoToMp4Buffer({
            isDemo: true,
            durationSec: Math.min(10, durationQuery || 8),
          });
        } else {
          // Fallback: If event MP4 download was unavailable or user is downloading an archive stream at `tsQuery`
          if (cameraId && tsQuery > 0) {
            const apiUrl = `/rest/v1/forpost/cameras/${encodeURIComponent(cameraId)}/video?TS=${encodeURIComponent(String(Math.floor(tsQuery)))}&TZ=${encodeURIComponent(tzQuery)}&LightStream=0&Format=H264&Speed=-1.0`;
            const streamRes = await egFetch(apiUrl, ctx, { placeIdOverride: placeId });
            const streamUrl =
              streamRes.data?.data?.URL ||
              streamRes.data?.data?.url ||
              streamRes.data?.URL ||
              streamRes.data?.url;
            streamBizError = streamRes.data?.data?.Error || streamRes.data?.errorMessage || null;
            if (streamRes.ok && streamUrl) {
              clipBuffer = await remuxStreamOrDemoToMp4Buffer({
                streamUrl,
                durationSec: durationQuery || 30,
              });
            }
          }
        }

        if (!clipBuffer) {
          res.status(503).json({
            error: 'clip_preparing',
            message:
              streamBizError ||
              'Не удалось сформировать MP4-файл архива (проверьте доступность архива камеры у оператора)',
          });
          return;
        }

        cached = { buffer: clipBuffer, createdAt: Date.now() };
        if (clipBuffer.length <= 48 * 1024 * 1024) {
          clipCache.set(cacheKey, cached);
        }
      }

      const total = cached.buffer.length;
      if (downloadMode) {
        const fileLabel = cameraId
          ? `archive-cam-${cameraId}-${eventId}.mp4`
          : `camera-event-${eventId}.mp4`;
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${fileLabel}"`);
        res.setHeader('Content-Length', String(total));
        res.send(cached.buffer);
        return;
      }

      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (match) {
          const startStr = match[1];
          const endStr = match[2];
          let start = startStr ? parseInt(startStr, 10) : 0;
          let end = endStr ? parseInt(endStr, 10) : total - 1;
          if (!startStr && endStr) {
            const suffix = parseInt(endStr, 10);
            start = Math.max(0, total - suffix);
            end = total - 1;
          }
          if (start >= total || start > end) {
            res.status(416);
            res.setHeader('Content-Range', `bytes */${total}`);
            res.setHeader('Accept-Ranges', 'bytes');
            res.end();
            return;
          }
          end = Math.min(end, total - 1);
          const chunk = cached.buffer.subarray(start, end + 1);
          res.status(206);
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
          res.setHeader('Content-Length', String(chunk.length));
          res.setHeader('Cache-Control', 'private, no-store');
          res.send(chunk);
          return;
        }
      }

      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', String(total));
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(cached.buffer);
    } catch (err: any) {
      res.status(502).json({
        error: 'clip_proxy_error',
        message: `Ошибка загрузки MP4 клипа: ${err?.message || 'Unknown'}`,
      });
    }
  });

  // 13. Place Events History (`api.py:query_events`)
  app.post('/api/eg/events/history', async (req: Request, res: Response) => {
    try {
      if (!(await assertActiveSubscription(req, res))) return;
      const ctx = extractContext(req);
      const placeIds = Array.isArray(req.body?.placeIds)
        ? req.body.placeIds.map((id: any) => Number(id)).filter((n: number) => !isNaN(n))
        : [];
      const page = Number(req.body?.page || 0);

      if (placeIds.length === 0) {
        res.json({ events: [], number: 0, last: true });
        return;
      }

      const evRes = await egFetch(
        `/rest/v1/events/search?page=${page}&sort=occurredAt%2CDESC`,
        ctx,
        {
          method: 'POST',
          body: { placeIds },
        }
      );

      const content: any[] = Array.isArray(evRes.data?.content) ? evRes.data.content : [];
      const events = content.map((item) => {
        const srcType = String(item.source?.type || '');
        const srcId = String(item.source?.id || '');
        const cameraId =
          item.cameraId ??
          item.externalCameraId ??
          item.data?.cameraId ??
          (srcType === 'CAMERA' ? srcId : null);
        const accessControlId =
          item.accessControlId ??
          item.data?.accessControlId ??
          (srcType === 'ACCESS_CONTROL' ? srcId : null);
        const entranceId =
          item.entranceId ??
          item.data?.entranceId ??
          (srcType === 'ENTRANCE' ? srcId : null);

        return {
          id: String(item.id),
          placeId: String(item.placeId),
          eventType: String(item.eventTypeName || ''),
          timestamp: Number(item.timestamp),
          sourceType: srcType,
          sourceId: srcId,
          message: item.message || item.title || item.eventTypeName || 'Событие домофона',
          cameraId: cameraId != null ? String(cameraId) : null,
          accessControlId: accessControlId != null ? String(accessControlId) : null,
          entranceId: entranceId != null ? String(entranceId) : null,
        };
      });

      res.json({
        events,
        number: Number(evRes.data?.number || 0),
        last: Boolean(evRes.data?.last ?? true),
        totalElements: Number(evRes.data?.totalElements ?? events.length),
      });
    } catch (err: any) {
      res.status(502).json({
        error: 'history_error',
        message: `Ошибка получения журнала событий: ${err?.message || 'Unknown'}`,
      });
    }
  });

  // 14. Do Not Disturb Toggle (`api.py:post_dnd_settings`)
  app.post('/api/eg/dnd', async (req: Request, res: Response) => {
    try {
      if (!(await assertActiveSubscription(req, res))) return;
      const ctx = extractContext(req);
      const placeId = String(req.body?.placeId || '');
      const items = req.body?.items;
      if (!placeId || !Array.isArray(items)) {
        res.status(400).json({ error: 'invalid_dnd', message: 'Некорректные параметры режима Не беспокоить' });
        return;
      }

      const dndRes = await egFetch(
        `/api/mh-customer/mobile/v1/customers/places/${encodeURIComponent(placeId)}/settings/do_not_disturb`,
        ctx,
        {
          method: 'POST',
          body: items,
          placeIdOverride: placeId,
        }
      );

      res.json({ ok: dndRes.ok });
    } catch (err: any) {
      res.status(502).json({ error: 'dnd_error', message: err?.message || 'Ошибка сохранения настроек' });
    }
  });

  // 15. Personal Self-Hosted Guest Passes (Independent of Dom.ru tariffs & mh-temp-pass add-on)
  interface GuestPassAccessControl {
    id: number;
    name: string;
    originalName?: string;
    entranceId?: string | null;
    cameraId?: string | null;
  }

  interface LocalGuestPassRecord {
    id: number;
    token: string;
    placeId: string;
    label?: string;
    status: string;
    createdAt: number;
    expiredAt: number;
    sharedLinkMessage: string;
    availableAccessControl: GuestPassAccessControl[];
    ownerCtx: EgRequestContext;
    ownerUserId?: string;
    openCount?: number;
    lastOpenedAt?: number | null;
  }

  const GUEST_PASSES_DATA_DIR = path.join(__dirname, '.data');
  const GUEST_PASSES_FILE = path.join(GUEST_PASSES_DATA_DIR, 'guest-passes.json');
  const localGuestPasses = new Map<string, LocalGuestPassRecord>();
  let localGuestPassSeq = 84100;

  function loadLocalGuestPassesFromDisk() {
    try {
      if (!fs.existsSync(GUEST_PASSES_FILE)) return;
      const raw = fs.readFileSync(GUEST_PASSES_FILE, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      const list: LocalGuestPassRecord[] = Array.isArray(parsed?.passes) ? parsed.passes : [];
      const now = Date.now();
      for (const rec of list) {
        if (rec && rec.token && rec.expiredAt > now) {
          localGuestPasses.set(rec.token, rec);
          if (typeof rec.id === 'number' && rec.id > localGuestPassSeq) {
            localGuestPassSeq = rec.id;
          }
        }
      }
    } catch {
      // ignore corrupted store
    }
  }

  function saveLocalGuestPassesToDisk() {
    try {
      if (!fs.existsSync(GUEST_PASSES_DATA_DIR)) {
        fs.mkdirSync(GUEST_PASSES_DATA_DIR, { recursive: true });
      }
      const payload = {
        passes: Array.from(localGuestPasses.values()),
      };
      fs.writeFileSync(GUEST_PASSES_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch {
      // ignore disk write failure
    }
  }

  loadLocalGuestPassesFromDisk();

  function normalizeTempPassTtlSeconds(rawTtl: unknown): number {
    if (typeof rawTtl === 'number' && Number.isFinite(rawTtl) && rawTtl > 0) {
      return Math.round(rawTtl);
    }
    const str = String(rawTtl || '').trim().toUpperCase();
    if (str === 'ONE_HOUR' || str === '3600') return 3600;
    if (str === 'FOUR_HOURS' || str === '14400') return 14400;
    if (str === 'TWELVE_HOURS' || str === '43200') return 43200;
    if (str === 'ONE_DAY' || str === '86400') return 86400;
    if (str === 'SEVEN_DAYS' || str === '604800') return 604800;
    if (str === 'THIRTY_DAYS' || str === '2592000') return 2592000;
    const parsed = Number(str);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
    return 43200;
  }

  function cleanupExpiredLocalGuestPasses() {
    const now = Date.now();
    let changed = false;
    for (const [token, rec] of localGuestPasses.entries()) {
      if (rec.expiredAt <= now) {
        localGuestPasses.delete(token);
        changed = true;
      }
    }
    if (changed) {
      saveLocalGuestPassesToDisk();
    }
  }

  async function resolveOwnerUserIdForReq(req: Request): Promise<string | null> {
    const verified = await resolveVerifiedSession(req);
    if (verified.isDemo) return 'demo_subscriber';
    if (!verified.authenticated) return null;
    const user = upsertBillingUserFromIdentity({
      phone: verified.phone,
      accountId: verified.accountId,
      subscriberId: verified.subscriberId,
      name: verified.name,
    });
    return user.userId;
  }

  function resolveOwnerUserIdForGuestPass(record: LocalGuestPassRecord): string | null {
    if (record.ownerUserId) return record.ownerUserId;
    const token = record.ownerCtx?.accessToken || '';
    if (token.startsWith('demo_')) return 'demo_subscriber';
    if (token) {
      const cached = verifiedSessionMap.get(token);
      if (cached) {
        const matched = billingStore.users.find(
          (u) =>
            (cached.phone && u.phone && normalizePhone(u.phone) === normalizePhone(cached.phone)) ||
            (cached.accountId && u.accountId && u.accountId === cached.accountId)
        );
        if (matched) return matched.userId;
      }
    }
    const accId = record.ownerCtx?.userAgent?.account_id
      ? String(record.ownerCtx.userAgent.account_id).trim()
      : '';
    if (accId) {
      const matched = billingStore.users.find((u) => u.accountId && u.accountId === accId);
      if (matched) return matched.userId;
    }
    return null;
  }

  function applyOwnerCameraAliasesToControls(
    controls: GuestPassAccessControl[],
    ownerUserId: string | null | undefined,
    placeId?: string
  ): GuestPassAccessControl[] {
    const aliases = ownerUserId ? getCameraAliasesForUser(ownerUserId) : {};
    return controls.map((ac) => {
      const resolvedCamId =
        ac.cameraId || lookupCachedPlaceControlCamera(placeId, ac.id, ac.entranceId) || null;
      const aliasName =
        resolvedCamId && aliases[resolvedCamId] ? String(aliases[resolvedCamId]).trim() : '';
      if (aliasName) {
        return {
          ...ac,
          cameraId: resolvedCamId,
          originalName: ac.originalName || ac.name,
          name: aliasName,
        };
      }
      if (ownerUserId && ownerUserId !== 'demo_subscriber' && resolvedCamId && ac.originalName) {
        return {
          ...ac,
          cameraId: resolvedCamId,
          name: ac.originalName,
        };
      }
      return resolvedCamId && ac.cameraId !== resolvedCamId
        ? { ...ac, cameraId: resolvedCamId }
        : ac;
    });
  }

  async function resolvePlaceAccessControls(
    placeId: string,
    ctx: EgRequestContext,
    ownerUserId?: string | null
  ): Promise<GuestPassAccessControl[]> {
    const applyAliases = (list: GuestPassAccessControl[]) =>
      applyOwnerCameraAliasesToControls(list, ownerUserId, placeId);

    let gate1CamId = lookupCachedPlaceControlCamera(placeId, 990001, 'esp32_gate_1');
    let gate2CamId = lookupCachedPlaceControlCamera(placeId, 990002, 'esp32_gate_2');
    let gate1DefaultName = 'Камера фасад 1 - 3-Й Мкр 6 б (Ворота №1)';
    let gate2DefaultName = 'Камера фасад 2 - 3-Й Мкр 6 б (Ворота №2)';

    const ensureGateCameraIds = async () => {
      if (gate1CamId && gate2CamId) return;
      try {
        const fpRes = await egFetch('/rest/v1/forpost/cameras', ctx);
        const fpList = fpRes.ok
          ? Array.isArray(fpRes.data)
            ? fpRes.data
            : Array.isArray(fpRes.data?.data)
              ? fpRes.data.data
              : Array.isArray(fpRes.data?.items)
                ? fpRes.data.items
                : Array.isArray(fpRes.data?.cameras)
                  ? fpRes.data.cameras
                  : []
          : [];
        for (const cam of fpList) {
          if (!cam || typeof cam !== 'object') continue;
          const cid = String(cam.ID ?? cam.id ?? cam.externalCameraId ?? cam.cameraId ?? '').trim();
          const cname = String(cam.Name || cam.name || cam.title || '');
          if (!cid || !cname) continue;
          const gateMeta = detectFacadeGateCamera(cname);
          if (gateMeta?.channel === 1 && !gate1CamId) {
            gate1CamId = cid;
            gate1DefaultName = `${cname} (Ворота №1)`;
            rememberPlaceControlCamera(placeId, 990001, 'esp32_gate_1', cid);
          } else if (gateMeta?.channel === 2 && !gate2CamId) {
            gate2CamId = cid;
            gate2DefaultName = `${cname} (Ворота №2)`;
            rememberPlaceControlCamera(placeId, 990002, 'esp32_gate_2', cid);
          }
        }
      } catch {
        // Non-fatal
      }
    };

    try {
      const acRes = await egFetch(
        `/rest/v1/places/${encodeURIComponent(placeId)}/accesscontrols`,
        ctx,
        { placeIdOverride: placeId }
      );
      const list = Array.isArray(acRes.data?.data)
        ? acRes.data.data
        : Array.isArray(acRes.data)
          ? acRes.data
          : [];
      const expanded: GuestPassAccessControl[] = [];
      for (const ac of list) {
        if (!ac || ac.id == null) continue;
        const acIdNum = Number(ac.id);
        const acName = String(ac.name || ac.externalDeviceId || `Домофон #${ac.id}`);
        const entrances = Array.isArray(ac.entrances) ? ac.entrances : [];
        if (entrances.length > 0) {
          for (const ent of entrances) {
            const allowOpen = ent?.allowOpen ?? ac?.allowOpen ?? true;
            if (!allowOpen) continue;
            const entId = ent?.id != null ? String(ent.id) : null;
            const extCamId = ent?.externalCameraId
              ? String(ent.externalCameraId)
              : lookupCachedPlaceControlCamera(placeId, acIdNum, entId);
            if (extCamId) {
              rememberPlaceControlCamera(placeId, acIdNum, entId, extCamId);
            }
            const rawName = String(ent?.name || acName);
            expanded.push({
              id: acIdNum,
              name: rawName,
              originalName: rawName,
              entranceId: entId,
              cameraId: extCamId,
            });
          }
        } else {
          const allowOpen = ac?.allowOpen ?? true;
          if (!allowOpen) continue;
          const extCamId = ac?.externalCameraId
            ? String(ac.externalCameraId)
            : lookupCachedPlaceControlCamera(placeId, acIdNum, null);
          if (extCamId) {
            rememberPlaceControlCamera(placeId, acIdNum, null, extCamId);
          }
          expanded.push({
            id: acIdNum,
            name: acName,
            originalName: acName,
            entranceId: null,
            cameraId: extCamId,
          });
        }
      }
      await ensureGateCameraIds();
      // Also include the 2 ESP32 Gate channels so guests can open gates if granted by owner
      expanded.push(
        {
          id: 990001,
          name: gate1DefaultName,
          originalName: gate1DefaultName,
          entranceId: 'esp32_gate_1',
          cameraId: gate1CamId,
        },
        {
          id: 990002,
          name: gate2DefaultName,
          originalName: gate2DefaultName,
          entranceId: 'esp32_gate_2',
          cameraId: gate2CamId,
        }
      );
      return applyAliases(expanded);
    } catch {
      return applyAliases([
        {
          id: 990001,
          name: gate1DefaultName,
          originalName: gate1DefaultName,
          entranceId: 'esp32_gate_1',
          cameraId: gate1CamId,
        },
        {
          id: 990002,
          name: gate2DefaultName,
          originalName: gate2DefaultName,
          entranceId: 'esp32_gate_2',
          cameraId: gate2CamId,
        },
      ]);
    }
  }

  function buildBaseOriginForReq(req: Request): string {
    const originHeader = req.headers.origin as string | undefined;
    const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)
      ?.split(',')[0]
      ?.trim();
    const host = req.get('host') || 'localhost:3000';
    return (
      originHeader ||
      (process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL'
        ? process.env.APP_URL.replace(/\/$/, '')
        : '') ||
      `${forwardedProto || req.protocol || 'https'}://${host}`
    );
  }

  app.get('/api/eg/temp-passes', async (req: Request, res: Response) => {
    try {
      if (!(await assertActiveSubscription(req, res))) return;
      cleanupExpiredLocalGuestPasses();
      const ctx = extractContext(req);
      const placeId = String(req.query.placeId || '');
      if (!placeId) {
        res.status(400).json({ error: 'missing_place', message: 'Не указан placeId' });
        return;
      }

      const ownerUserId = await resolveOwnerUserIdForReq(req);
      const availableAccessControls = await resolvePlaceAccessControls(placeId, ctx, ownerUserId);
      const baseOrigin = buildBaseOriginForReq(req);

      let didBackfill = false;
      const personalPassesForPlace = Array.from(localGuestPasses.values())
        .filter((p) => String(p.placeId) === String(placeId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((p) => {
          const effectiveOwnerId = p.ownerUserId || ownerUserId;
          if (!p.ownerUserId && ownerUserId && p.ownerCtx?.accessToken === ctx.accessToken) {
            p.ownerUserId = ownerUserId;
            didBackfill = true;
          }
          const updatedControls = (p.availableAccessControl || []).map((ac) => {
            if (ac.cameraId) return ac;
            const matchedPlaceAc = availableAccessControls.find(
              (pa) =>
                pa.id === ac.id &&
                (ac.entranceId == null || String(pa.entranceId || '') === String(ac.entranceId || ''))
            );
            const fallbackCamId =
              matchedPlaceAc?.cameraId ||
              lookupCachedPlaceControlCamera(placeId, ac.id, ac.entranceId);
            if (fallbackCamId) {
              didBackfill = true;
              return {
                ...ac,
                cameraId: fallbackCamId,
                originalName: ac.originalName || matchedPlaceAc?.originalName || ac.name,
              };
            }
            return ac;
          });
          if (didBackfill) {
            p.availableAccessControl = updatedControls;
          }
          return {
            id: p.id,
            sharedLinkMessage: `${baseOrigin}/?guestPass=${p.token}`,
            label: p.label || '',
            source: 'personal' as const,
            status: p.status,
            createdAt: p.createdAt,
            expiredAt: p.expiredAt,
            openCount: p.openCount || 0,
            lastOpenedAt: p.lastOpenedAt || null,
            availableAccessControl: applyOwnerCameraAliasesToControls(
              p.availableAccessControl,
              effectiveOwnerId,
              placeId
            ),
          };
        });

      if (didBackfill) {
        saveLocalGuestPassesToDisk();
      }

      res.json({
        passes: personalPassesForPlace,
        availableAccessControls,
        availableTtls: ['3600', '14400', '43200', '86400', '604800', '2592000'],
      });
    } catch (err: any) {
      res.status(502).json({
        error: 'temp_pass_error',
        message: err?.message || 'Ошибка загрузки личных гостевых ссылок',
      });
    }
  });

  app.post('/api/eg/temp-passes', async (req: Request, res: Response) => {
    try {
      if (!(await assertActiveSubscription(req, res))) return;
      cleanupExpiredLocalGuestPasses();
      const ctx = extractContext(req);
      const { placeId, ttl, accessControlIds, accessControls, label } = req.body || {};
      if (!placeId) {
        res.status(400).json({ error: 'missing_place', message: 'Не указан адрес (placeId)' });
        return;
      }

      const ownerUserId = await resolveOwnerUserIdForReq(req);
      const ttlSeconds = normalizeTempPassTtlSeconds(ttl);
      const cleanLabel =
        typeof label === 'string' ? label.trim().slice(0, 60) : '';

      const placeAcs = await resolvePlaceAccessControls(String(placeId), ctx, ownerUserId);
      const requestedControls: GuestPassAccessControl[] = Array.isArray(accessControls)
        ? accessControls
            .filter((c: any) => c && Number.isFinite(Number(c.id)) && Number(c.id) > 0)
            .map((c: any) => ({
              id: Number(c.id),
              name: String(c.name || `Точка доступа #${c.id}`),
              entranceId: c.entranceId != null && c.entranceId !== '' ? String(c.entranceId) : null,
              cameraId: c.cameraId != null && c.cameraId !== '' ? String(c.cameraId) : null,
            }))
        : [];

      const numericAcIds: number[] = Array.isArray(accessControlIds)
        ? accessControlIds.map((id: any) => Number(id)).filter((n: number) => Number.isFinite(n) && n > 0)
        : [];

      let selectedControls: GuestPassAccessControl[] = [];
      if (requestedControls.length > 0) {
        selectedControls = requestedControls.map((rc) => {
          const matched = placeAcs.find(
            (pa) =>
              pa.id === rc.id &&
              (rc.entranceId == null || String(pa.entranceId || '') === String(rc.entranceId || ''))
          );
          const resolvedCamId =
            rc.cameraId ||
            matched?.cameraId ||
            lookupCachedPlaceControlCamera(String(placeId), rc.id, rc.entranceId) ||
            null;
          const rawClientName =
            rc.name && rc.name.trim() && !rc.name.startsWith('Точка доступа #')
              ? rc.name.trim()
              : '';
          return {
            id: rc.id,
            name: rawClientName || matched?.name || rc.name,
            originalName: matched?.originalName || matched?.name || rc.name,
            entranceId: rc.entranceId ?? matched?.entranceId ?? null,
            cameraId: resolvedCamId,
          };
        });
      } else if (numericAcIds.length > 0) {
        selectedControls =
          placeAcs.length > 0
            ? placeAcs.filter((ac) => numericAcIds.includes(ac.id))
            : numericAcIds.map((id) => ({
                id,
                name: `Домофон / калитка #${id}`,
                entranceId: null,
                cameraId: lookupCachedPlaceControlCamera(String(placeId), id, null),
              }));
      } else if (placeAcs.length > 0) {
        selectedControls = placeAcs;
      }

      const resolvedControls = applyOwnerCameraAliasesToControls(
        selectedControls.length > 0
          ? selectedControls
          : [{ id: numericAcIds[0] || 1, name: 'Входная дверь / Калитка', entranceId: null }],
        ownerUserId,
        String(placeId)
      );

      const token = crypto.randomBytes(12).toString('hex');
      const passId = ++localGuestPassSeq;
      const now = Date.now();
      const expiredAt = now + ttlSeconds * 1000;
      const baseOrigin = buildBaseOriginForReq(req);
      const sharedLinkMessage = `${baseOrigin}/?guestPass=${token}`;

      const record: LocalGuestPassRecord = {
        id: passId,
        token,
        placeId: String(placeId),
        label: cleanLabel || undefined,
        status: 'ACTIVE',
        createdAt: now,
        expiredAt,
        sharedLinkMessage,
        availableAccessControl: resolvedControls,
        ownerCtx: ctx,
        ownerUserId: ownerUserId || undefined,
        openCount: 0,
        lastOpenedAt: null,
      };

      localGuestPasses.set(token, record);
      saveLocalGuestPassesToDisk();

      res.json({
        pass: {
          id: record.id,
          sharedLinkMessage: record.sharedLinkMessage,
          label: record.label || '',
          source: 'personal',
          status: record.status,
          createdAt: record.createdAt,
          expiredAt: record.expiredAt,
          openCount: 0,
          lastOpenedAt: null,
          availableAccessControl: record.availableAccessControl,
        },
        source: 'domru_lab_personal',
      });
    } catch (err: any) {
      res.status(502).json({
        error: 'create_pass_error',
        message: err?.message || 'Ошибка создания личной гостевой ссылки',
      });
    }
  });

  app.delete('/api/eg/temp-passes/:passId', async (req: Request, res: Response) => {
    try {
      if (!(await assertActiveSubscription(req, res))) return;
      const passId = String(req.params.passId || '');
      let deletedLocal = false;
      for (const [token, rec] of localGuestPasses.entries()) {
        if (String(rec.id) === passId || token === passId) {
          localGuestPasses.delete(token);
          deletedLocal = true;
        }
      }
      if (deletedLocal) {
        saveLocalGuestPassesToDisk();
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(502).json({ error: 'delete_pass_error', message: err?.message || 'Unknown' });
    }
  });

  // Public Guest Pass Verification & One-Tap Door Open Relay (`/api/eg/guest-pass/:token`)
  app.get('/api/eg/guest-pass/:token', (req: Request, res: Response) => {
    cleanupExpiredLocalGuestPasses();
    const token = String(req.params.token || '').trim();
    const record = localGuestPasses.get(token);
    if (!record || record.expiredAt <= Date.now()) {
      res.status(404).json({
        error: 'guest_pass_invalid',
        message: 'Срок действия гостевой ссылки истёк или ссылка была отозвана владельцем.',
      });
      return;
    }
    const ownerUserId = resolveOwnerUserIdForGuestPass(record);
    const resolvedControls = applyOwnerCameraAliasesToControls(
      record.availableAccessControl,
      ownerUserId,
      record.placeId
    );
    res.json({
      id: record.id,
      placeId: record.placeId,
      label: record.label || '',
      status: record.status,
      expiredAt: record.expiredAt,
      availableAccessControl: resolvedControls,
    });
  });

  app.post('/api/eg/guest-pass/:token/open', async (req: Request, res: Response) => {
    try {
      cleanupExpiredLocalGuestPasses();
      const token = String(req.params.token || '').trim();
      const record = localGuestPasses.get(token);
      if (!record || record.expiredAt <= Date.now()) {
        res.status(404).json({
          error: 'guest_pass_expired',
          message: 'Гостевая ссылка недействительна или её срок истёк.',
        });
        return;
      }

      const requestedAcId = Number(req.body?.accessControlId || record.availableAccessControl[0]?.id);
      const requestedEntranceId =
        req.body?.entranceId != null && req.body?.entranceId !== ''
          ? String(req.body.entranceId)
          : null;

      const allowedControl =
        (requestedEntranceId != null
          ? record.availableAccessControl.find(
              (ac) =>
                Number(ac.id) === requestedAcId &&
                String(ac.entranceId || '') === requestedEntranceId
            )
          : undefined) ||
        record.availableAccessControl.find((ac) => Number(ac.id) === requestedAcId) ||
        record.availableAccessControl[0];

      if (!allowedControl) {
        res.status(403).json({
          error: 'ac_not_permitted',
          message: 'Эта точка прохода не включена в гостевой доступ.',
        });
        return;
      }

      const ownerUserId = resolveOwnerUserIdForGuestPass(record);
      const ownerRecord = ownerUserId
        ? billingStore.users.find((u) => u.userId === ownerUserId)
        : undefined;
      if (ownerRecord && ownerRecord.status === 'blocked') {
        res.status(403).json({
          error: 'owner_blocked',
          message: 'Доступ владельца гостевой ссылки заблокирован администратором.',
        });
        return;
      }

      const resolvedControl =
        applyOwnerCameraAliasesToControls(
          [allowedControl],
          ownerUserId,
          record.placeId
        )[0] || allowedControl;

      // Check if this guest pass control is an ESP32 gate
      const esp32Channel = resolveEsp32ChannelFromLockParams(
        resolvedControl.id,
        resolvedControl.entranceId
      );
      if (esp32Channel !== null) {
        await triggerEsp32Gate(esp32Channel, `${resolvedControl.name} (Гостевой пропуск)`);
        record.openCount = (record.openCount || 0) + 1;
        record.lastOpenedAt = Date.now();
        saveLocalGuestPassesToDisk();
        res.json({
          ok: true,
          message: `Сигнал открытия отправлен на ворота: ${resolvedControl.name}`,
        });
        return;
      }

      const isDemoToken =
        !record.ownerCtx.accessToken || record.ownerCtx.accessToken.startsWith('demo_');

      if (isDemoToken) {
        record.openCount = (record.openCount || 0) + 1;
        record.lastOpenedAt = Date.now();
        saveLocalGuestPassesToDisk();
        res.json({
          ok: true,
          message: `Дверь «${resolvedControl.name}» открыта по личной гостевой ссылке`,
        });
        return;
      }

      const entranceId = resolvedControl.entranceId;
      const apiUrl =
        entranceId == null || entranceId === ''
          ? `/rest/v1/places/${encodeURIComponent(record.placeId)}/accesscontrols/${encodeURIComponent(String(resolvedControl.id))}/actions`
          : `/rest/v1/places/${encodeURIComponent(record.placeId)}/accesscontrols/${encodeURIComponent(String(resolvedControl.id))}/entrances/${encodeURIComponent(String(entranceId))}/actions`;

      const openRes = await egFetch(apiUrl, record.ownerCtx, {
        method: 'POST',
        body: { name: 'accessControlOpen' },
        placeIdOverride: record.placeId,
      });

      if (!openRes.ok) {
        res.status(openRes.status || 400).json({
          error: 'open_failed',
          message: `Оператор отклонил открытие (${openRes.status}). Возможно, сессия владельца устарела — обновите вход в приложении.`,
        });
        return;
      }

      record.openCount = (record.openCount || 0) + 1;
      record.lastOpenedAt = Date.now();
      saveLocalGuestPassesToDisk();

      res.json({
        ok: true,
        message: `Открыто: ${resolvedControl.name}`,
      });
    } catch (err: any) {
      res.status(502).json({
        error: 'guest_open_error',
        message: err?.message || 'Ошибка при открытии двери по гостевой ссылке',
      });
    }
  });

  // 15B. Download Signed Native Standalone Android APK (`DomRuLab-PocoX6Pro-v3.0.0.apk`) & Source Archive
  app.get('/api/eg/android/download-apk', (_req: Request, res: Response) => {
    const apkPath = path.join(__dirname, 'public', 'domru-lab-poco-x6-pro.apk');
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="DomRuLab-PocoX6Pro-v3.0.0.apk"');
    res.sendFile(apkPath);
  });

  app.get('/api/eg/android/download-source', (_req: Request, res: Response) => {
    const zipPath = path.join(__dirname, 'public', 'domru-lab-android-source.zip');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="DomRuLab-PocoX6Pro-Android-Source.zip"');
    res.sendFile(zipPath);
  });

  // 16. DomRu Lab — On-Device Android CV (Poco X6 Pro) + VPS Control Plane & Audit Logger
  app.get('/api/eg/auto-access/status', (_req: Request, res: Response) => {
    try {
      res.json(autoAccessSingleton.getStatus());
    } catch (err: any) {
      res.status(500).json({ error: 'auto_access_status_error', message: err?.message || 'Unknown' });
    }
  });

  app.post('/api/eg/auto-access/config', async (req: Request, res: Response) => {
    try {
      if (!(await assertActiveSubscription(req, res))) return;
      const updated = autoAccessSingleton.updateConfig(req.body || {});
      res.json({ ok: true, config: updated, status: autoAccessSingleton.getStatus() });
    } catch (err: any) {
      res.status(400).json({ error: 'auto_access_config_error', message: err?.message || 'Unknown' });
    }
  });

  app.post('/api/eg/auto-access/emergency-stop', (req: Request, res: Response) => {
    try {
      const reason = String(req.body?.reason || 'Ручная экстренная остановка пользователем');
      const status = autoAccessSingleton.emergencyStop(reason);
      res.json({ ok: true, status });
    } catch (err: any) {
      res.status(500).json({ error: 'emergency_stop_error', message: err?.message || 'Unknown' });
    }
  });

  // Strict Zero-Biometrics Guard on VPS: any attempt to upload photos or templates to VPS is rejected!
  app.post('/api/eg/auto-access/biometrics/enroll', (_req: Request, res: Response) => {
    autoAccessSingleton.appendLog(
      'SECURITY_GUARD',
      'Попытка загрузки биометрии на VPS отклонена',
      'DENIED',
      'Согласно разделу 3.2 и 6.1 ТЗ, биометрические шаблоны и фотографии лица создаются и хранятся исключительно локально на Android-телефоне (Poco X6 Pro AndroidKeyStore).'
    );
    res.status(400).json({
      error: 'biometrics_prohibited_on_vps',
      message:
        'Передача фотографий и биометрических шаблонов на VPS запрещена архитектурой. Регистрация лица выполняется локально на Android-устройстве.',
    });
  });

  // Receive sanitized Android telemetry & perform server-side access validation (Section 10)
  app.post('/api/eg/auto-access/geofence-event', async (req: Request, res: Response) => {
    try {
      if (!(await assertActiveSubscription(req, res))) return;
      const ctx = extractContext(req);
      const isDemoToken = !ctx.accessToken || ctx.accessToken.startsWith('demo_');
      const simulatedAllowOpen: boolean | undefined =
        typeof req.body?.simulatedAllowOpen === 'boolean' ? req.body.simulatedAllowOpen : undefined;

      const report = await autoAccessSingleton.processAndroidTelemetryAndValidateAccess(
        req.body || {},
        {
          simulatedAllowOpen,
          verifyLockAccess: async (placeId: string, accessControlId: string) => {
            if (typeof simulatedAllowOpen === 'boolean') {
              return {
                allowOpen: simulatedAllowOpen,
                lockName: autoAccessSingleton.getStatus().config.targetLockName || 'Калитка',
              };
            }
            if (isDemoToken) {
              return {
                allowOpen: true,
                lockName:
                  autoAccessSingleton.getStatus().config.targetLockName || 'Калитка · Вход со двора',
              };
            }
            const acRes = await egFetch(
              `/rest/v1/places/${encodeURIComponent(String(placeId))}/accesscontrols`,
              ctx,
              { placeIdOverride: String(placeId) }
            );
            if (!acRes.ok || !Array.isArray(acRes.data?.data)) {
              return { allowOpen: false, lockName: 'Неизвестная точка доступа' };
            }
            const matched = acRes.data.data.find(
              (ac: any) => String(ac?.id) === String(accessControlId)
            );
            if (!matched) {
              return { allowOpen: false, lockName: `Устройство #${accessControlId} не найдено` };
            }
            return {
              allowOpen: Boolean(matched.allowOpen),
              lockName: matched.name || matched.externalDeviceId || `Калитка #${accessControlId}`,
            };
          },
          executeOpenDoorCommand: async (
            placeId: string,
            accessControlId: string,
            entranceId: string | null
          ) => {
            if (isDemoToken) {
              return {
                commandSent: true,
                apiAccepted: true,
                httpStatus: 200,
                message: 'Команда принята, состояние калитки неизвестно',
              };
            }
            const apiUrl =
              entranceId == null || entranceId === ''
                ? `/rest/v1/places/${encodeURIComponent(String(placeId))}/accesscontrols/${encodeURIComponent(String(accessControlId))}/actions`
                : `/rest/v1/places/${encodeURIComponent(String(placeId))}/accesscontrols/${encodeURIComponent(String(accessControlId))}/entrances/${encodeURIComponent(String(entranceId))}/actions`;

            const openRes = await egFetch(apiUrl, ctx, {
              method: 'POST',
              body: { name: 'accessControlOpen' },
              placeIdOverride: String(placeId),
            });

            return {
              commandSent: true,
              apiAccepted: openRes.ok,
              httpStatus: openRes.status,
              message: openRes.ok
                ? 'Команда принята, состояние калитки неизвестно'
                : `API отклонил команду открытия (${openRes.status})`,
            };
          },
        }
      );

      res.json({
        ok: true,
        report,
        status: autoAccessSingleton.getStatus(),
      });
    } catch (err: any) {
      res.status(400).json({
        error: 'telemetry_validation_error',
        message: err?.message || 'Ошибка проверки статуса Android-клиента',
      });
    }
  });

  app.post('/api/eg/auto-access/benchmark', (_req: Request, res: Response) => {
    try {
      const comparison = autoAccessSingleton.getPocoX6ProBenchmarkComparison();
      res.json({
        ok: true,
        comparison,
        status: autoAccessSingleton.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        error: 'benchmark_error',
        message: err?.message || 'Ошибка получения профиля производительности Poco X6 Pro',
      });
    }
  });

  app.post('/api/eg/auto-access/logs/clear', (_req: Request, res: Response) => {
    try {
      autoAccessSingleton.clearAuditLogs();
      res.json({
        ok: true,
        status: autoAccessSingleton.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({ error: 'clear_logs_error', message: err?.message || 'Unknown' });
    }
  });

  // 17. Commercial Billing (50 RUB/month, Self-Employed NPD 4%) & Admin Panel Store
  type BillingStatus = 'trial' | 'active' | 'expired' | 'blocked';
  interface ServerBillingUser {
    userId: string;
    phone: string;
    accountId: string;
    subscriberId?: string;
    name: string;
    address: string;
    role: 'admin' | 'user';
    balanceRub: number;
    status: BillingStatus;
    autoRenew: boolean;
    trialEndsAt: number;
    paidUntil: number | null;
    createdAt: number;
    lastSeenAt: number;
    notes: string;
  }

  interface ServerBillingTx {
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

  interface ServerBillingStore {
    config: {
      monthlyPriceRub: number;
      trialDays: number;
      selfEmployedName: string;
      selfEmployedInn: string;
      sbpPhoneOrLink: string;
      paymentMethodLabel: string;
      npdTaxRatePct: number;
      supportEmail: string;
      supportTelegram: string;
      supportPhone: string;
      supportHours: string;
      sellerCity: string;
      adminPin: string;
    };
    users: ServerBillingUser[];
    transactions: ServerBillingTx[];
  }

  const BILLING_FILE = path.join(GUEST_PASSES_DATA_DIR, 'billing-users.json');
  const DAY_MS = 86400 * 1000;

  function createDefaultBillingStore(): ServerBillingStore {
    const now = Date.now();
    return {
      config: {
        monthlyPriceRub: 50,
        trialDays: 7,
        selfEmployedName: 'Семёнов Андрей (Самозанятый / НПД)',
        selfEmployedInn: '',
        sbpPhoneOrLink: 'ЮKassa (Карты РФ, СБП, SberPay)',
        paymentMethodLabel: 'ЮKassa (Карты РФ, СБП) · чек «Мой налог»',
        npdTaxRatePct: 4,
        supportEmail: 'support@open-key.ru',
        supportTelegram: '@openkey_support',
        supportPhone: '',
        supportHours: 'Ежедневно, 09:00–21:00 (МСК+4)',
        sellerCity: 'г. Новосибирск',
        adminPin: '',
      },
      users: [
        {
          userId: 'usr_owner_450005579792',
          phone: '79128387309',
          accountId: '450005579792',
          name: 'Владелец Open-Key',
          address: 'Владелец сервиса Open-Key',
          role: 'admin',
          balanceRub: 150,
          status: 'active',
          autoRenew: true,
          trialEndsAt: now + 7 * DAY_MS,
          paidUntil: now + 30 * DAY_MS,
          createdAt: now - 3 * DAY_MS,
          lastSeenAt: now,
          notes: 'Владелец и администратор сервиса',
        },
      ],
      transactions: [
        {
          id: 'tx_seed_topup_1',
          userId: 'usr_owner_450005579792',
          userName: 'Владелец Open-Key',
          userPhone: '79128387309',
          type: 'topup',
          status: 'completed',
          amountRub: 200,
          description: 'Стартовое пополнение баланса (ЮKassa)',
          paymentChannel: 'yookassa_npd',
          npdReceiptStatus: 'issued',
          npdReceiptNumber: 'NPD-SEED-1001',
          createdAt: now - 3 * DAY_MS,
        },
        {
          id: 'tx_seed_sub_1',
          userId: 'usr_owner_450005579792',
          userName: 'Владелец Open-Key',
          userPhone: '79128387309',
          type: 'subscription_charge',
          status: 'completed',
          amountRub: -50,
          description: 'Оплата подписки Open-Key на 30 дней',
          paymentChannel: 'system',
          npdReceiptStatus: 'not_required',
          npdReceiptNumber: null,
          createdAt: now - 3 * DAY_MS + 1000,
        },
      ],
    };
  }

  let billingStore: ServerBillingStore = createDefaultBillingStore();

  function loadBillingStoreFromDisk() {
    try {
      if (!fs.existsSync(BILLING_FILE)) return;
      const raw = fs.readFileSync(BILLING_FILE, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.users) && parsed.config) {
        const mergedCfg = {
          ...createDefaultBillingStore().config,
          ...parsed.config,
        };
        if (
          mergedCfg.supportEmail === 'support@domrulab.ru' ||
          mergedCfg.supportEmail === 'support@gatekey.app' ||
          mergedCfg.supportEmail === 'support@plumix.ru'
        ) {
          mergedCfg.supportEmail = 'support@open-key.ru';
        }
        if (
          mergedCfg.supportTelegram === '@domrulab_support' ||
          mergedCfg.supportTelegram === '@gatekey_support' ||
          mergedCfg.supportTelegram === '@plumix_support'
        ) {
          mergedCfg.supportTelegram = '@openkey_support';
        }
        mergedCfg.supportPhone = '';
        if (
          !mergedCfg.paymentMethodLabel ||
          mergedCfg.paymentMethodLabel.includes('СБП самозанятому')
        ) {
          mergedCfg.paymentMethodLabel = 'ЮKassa (Карты РФ, СБП) · чек «Мой налог»';
        }

        // Sanitize roles on load: strictly only configured owner(s) keep 'admin' role
        const sanitizedUsers: ServerBillingUser[] = parsed.users
          .filter((u: ServerBillingUser) => u && u.userId !== 'usr_owner_2094815')
          .map((u: ServerBillingUser) => ({
            ...u,
            phone: u.phone ? normalizePhone(String(u.phone)) : '',
            accountId: u.accountId ? String(u.accountId).trim() : '',
            subscriberId: u.subscriberId ? String(u.subscriberId).trim() : '',
            name: String(u.name || '').trim(),
            role: isOwnerIdentity(u.phone, u.accountId) ? 'admin' : 'user',
          }));

        billingStore = {
          config: mergedCfg,
          users: sanitizedUsers,
          transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
        };
        if (deduplicateBillingUsers()) {
          saveBillingStoreToDisk();
        }
      }
    } catch {
      // ignore corrupted billing file
    }
  }

  function deduplicateBillingUsers(): boolean {
    if (!Array.isArray(billingStore.users) || billingStore.users.length <= 1) {
      return false;
    }

    const canMergeUsers = (a: ServerBillingUser, b: ServerBillingUser): boolean => {
      const aPhone = a.phone ? normalizePhone(a.phone) : '';
      const bPhone = b.phone ? normalizePhone(b.phone) : '';
      if (aPhone && bPhone && aPhone === bPhone) return true;

      const aAcc = a.accountId ? String(a.accountId).trim() : '';
      const bAcc = b.accountId ? String(b.accountId).trim() : '';
      if (aAcc && bAcc && aAcc === bAcc) return true;

      const aSub = a.subscriberId ? String(a.subscriberId).trim() : '';
      const bSub = b.subscriberId ? String(b.subscriberId).trim() : '';
      if (aSub && bSub && aSub === bSub) return true;

      const aName = String(a.name || '').trim().toLowerCase();
      const bName = String(b.name || '').trim().toLowerCase();
      if (
        aName &&
        bName &&
        aName === bName &&
        aName !== 'новый пользователь' &&
        !aName.startsWith('абонент') &&
        (!aPhone || !bPhone || aPhone === bPhone) &&
        (!aAcc || !bAcc || aAcc === bAcc) &&
        (!aSub || !bSub || aSub === bSub)
      ) {
        return true;
      }
      return false;
    };

    const statusPriority = (s: BillingStatus): number => {
      if (s === 'blocked') return 4;
      if (s === 'active') return 3;
      if (s === 'expired') return 2;
      return 1; // trial
    };

    const groups: ServerBillingUser[][] = [];
    for (const u of billingStore.users) {
      const targetGroup = groups.find((g) => g.some((member) => canMergeUsers(member, u)));
      if (targetGroup) {
        targetGroup.push(u);
      } else {
        groups.push([u]);
      }
    }

    if (groups.length === billingStore.users.length) {
      return false;
    }

    const remapIds = new Map<string, string>();
    const mergedUsers: ServerBillingUser[] = [];

    for (const group of groups) {
      if (group.length === 1) {
        mergedUsers.push(group[0]);
        continue;
      }

      // Prefer deterministic/admin/blocked/oldest record as canonical ID
      const sorted = [...group].sort((a, b) => {
        const aAdmin = isOwnerIdentity(a.phone, a.accountId) ? 1 : 0;
        const bAdmin = isOwnerIdentity(b.phone, b.accountId) ? 1 : 0;
        if (aAdmin !== bAdmin) return bAdmin - aAdmin;
        const pDiff = statusPriority(b.status) - statusPriority(a.status);
        if (pDiff !== 0) return pDiff;
        const aRich = (a.phone ? 4 : 0) + (a.accountId ? 2 : 0) + (a.address ? 1 : 0);
        const bRich = (b.phone ? 4 : 0) + (b.accountId ? 2 : 0) + (b.address ? 1 : 0);
        if (aRich !== bRich) return bRich - aRich;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });

      const primary = { ...sorted[0] };
      let totalBalance = Number(primary.balanceRub || 0);
      let bestStatus = primary.status;

      for (let i = 1; i < sorted.length; i++) {
        const dup = sorted[i];
        remapIds.set(dup.userId, primary.userId);
        if (!primary.phone && dup.phone) primary.phone = dup.phone;
        if (!primary.accountId && dup.accountId) primary.accountId = dup.accountId;
        if (!primary.subscriberId && dup.subscriberId) primary.subscriberId = dup.subscriberId;
        if (!primary.address && dup.address) primary.address = dup.address;
        if (!primary.notes && dup.notes) primary.notes = dup.notes;
        if (
          (!primary.name || primary.name.startsWith('Абонент') || primary.name.startsWith('Новый')) &&
          dup.name
        ) {
          primary.name = dup.name;
        }
        primary.createdAt = Math.min(primary.createdAt || Date.now(), dup.createdAt || Date.now());
        primary.lastSeenAt = Math.max(primary.lastSeenAt || 0, dup.lastSeenAt || 0);
        if (dup.paidUntil && (!primary.paidUntil || dup.paidUntil > primary.paidUntil)) {
          primary.paidUntil = dup.paidUntil;
        }
        if (dup.trialEndsAt && (!primary.trialEndsAt || dup.trialEndsAt < primary.trialEndsAt)) {
          primary.trialEndsAt = dup.trialEndsAt;
        }
        totalBalance += Number(dup.balanceRub || 0);
        if (statusPriority(dup.status) > statusPriority(bestStatus)) {
          bestStatus = dup.status;
        }
      }

      primary.status = bestStatus;
      primary.balanceRub = Number(totalBalance.toFixed(2));
      primary.role = isOwnerIdentity(primary.phone, primary.accountId) ? 'admin' : 'user';
      mergedUsers.push(primary);
    }

    for (const tx of billingStore.transactions) {
      const mapped = remapIds.get(tx.userId);
      if (mapped) {
        tx.userId = mapped;
      }
    }

    billingStore.users = mergedUsers;
    return true;
  }

  function saveBillingStoreToDisk() {
    try {
      if (!fs.existsSync(GUEST_PASSES_DATA_DIR)) {
        fs.mkdirSync(GUEST_PASSES_DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(BILLING_FILE, JSON.stringify(billingStore, null, 2), 'utf8');
    } catch {
      // ignore disk write failure
    }
  }

  loadBillingStoreFromDisk();

  function getYookassaCredentials(): { shopId: string; secretKey: string } {
    return {
      shopId: String(process.env.YOOKASSA_SHOP_ID || '').trim(),
      secretKey: String(process.env.YOOKASSA_SECRET_KEY || '').trim(),
    };
  }

  function isYookassaConfigured(): boolean {
    const { shopId, secretKey } = getYookassaCredentials();
    return Boolean(shopId && secretKey);
  }

  function resolveAppOrigin(req: Request): string {
    const envUrl = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
    if (envUrl && envUrl.startsWith('http')) {
      return envUrl;
    }
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || 'localhost:3000';
    return `${proto.split(',')[0].trim()}://${host.split(',')[0].trim()}`;
  }

  async function createYookassaPayment(params: {
    amountRub: number;
    description: string;
    returnUrl: string;
    metadata: Record<string, string>;
  }): Promise<any> {
    const { shopId, secretKey } = getYookassaCredentials();
    if (!shopId || !secretKey) {
      throw new Error('ЮKassa не настроена в переменных окружения (.env)');
    }
    const auth = Buffer.from(`${shopId}:${secretKey}`).toString('base64');
    const resp = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Idempotence-Key': crypto.randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: {
          value: params.amountRub.toFixed(2),
          currency: 'RUB',
        },
        capture: true,
        confirmation: {
          type: 'redirect',
          return_url: params.returnUrl,
        },
        description: params.description.slice(0, 128),
        metadata: params.metadata,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data?.description || `ЮKassa API вернула ошибку ${resp.status}`);
    }
    return data;
  }

  async function fetchYookassaPayment(paymentId: string): Promise<any> {
    const { shopId, secretKey } = getYookassaCredentials();
    if (!shopId || !secretKey) {
      throw new Error('ЮKassa не настроена');
    }
    const auth = Buffer.from(`${shopId}:${secretKey}`).toString('base64');
    const resp = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data?.description || `Ошибка проверки платежа ЮKassa (${resp.status})`);
    }
    return data;
  }

  function applyYookassaStatusToTx(tx: ServerBillingTx, ykPayment: any): boolean {
    if (!tx || !ykPayment || tx.status !== 'pending') return false;
    const paidAmount = Number(ykPayment?.amount?.value || 0);
    if (ykPayment.status === 'succeeded' && ykPayment.paid !== false) {
      if (paidAmount > 0 && paidAmount + 0.01 < tx.amountRub) {
        return false;
      }
      tx.status = 'completed';
      tx.npdReceiptStatus = 'issued';
      tx.npdReceiptNumber =
        tx.npdReceiptNumber || `YK-${String(ykPayment.id || tx.id).slice(-8).toUpperCase()}`;
      const user = billingStore.users.find((u) => u.userId === tx.userId);
      if (user) {
        user.balanceRub = Number((user.balanceRub + tx.amountRub).toFixed(2));
        reconcileUserSubscription(user);
      }
      saveBillingStoreToDisk();
      return true;
    }
    if (ykPayment.status === 'canceled') {
      tx.status = 'rejected';
      tx.npdReceiptStatus = 'not_required';
      saveBillingStoreToDisk();
      return true;
    }
    return false;
  }

  function getPublicBillingConfig() {
    const { adminPin, ...rest } = billingStore.config;
    const envPin = String(process.env.ADMIN_PIN || '').trim();
    return {
      ...rest,
      hasAdminPin: Boolean((adminPin && adminPin.trim().length > 0) || envPin.length > 0),
      yookassaEnabled: isYookassaConfigured(),
    };
  }

  function reconcileUserSubscription(user: ServerBillingUser): boolean {
    if (user.status === 'blocked') return false;
    const now = Date.now();
    const price = Math.max(1, Number(billingStore.config.monthlyPriceRub) || 50);
    let changed = false;

    if (user.status === 'trial' && user.trialEndsAt <= now) {
      if (user.autoRenew && user.balanceRub >= price) {
        user.balanceRub = Number((user.balanceRub - price).toFixed(2));
        user.status = 'active';
        user.paidUntil = now + 30 * DAY_MS;
        billingStore.transactions.unshift({
          id: `tx_${crypto.randomBytes(6).toString('hex')}`,
          userId: user.userId,
          userName: user.name,
          userPhone: user.phone,
          type: 'subscription_charge',
          status: 'completed',
          amountRub: -price,
          description: `Автопродление подписки после пробного периода (30 дн.)`,
          paymentChannel: 'auto_renew',
          npdReceiptStatus: 'not_required',
          npdReceiptNumber: null,
          createdAt: now,
        });
      } else {
        user.status = 'expired';
      }
      changed = true;
    } else if (user.status === 'active' && user.paidUntil != null && user.paidUntil <= now) {
      if (user.autoRenew && user.balanceRub >= price) {
        user.balanceRub = Number((user.balanceRub - price).toFixed(2));
        user.paidUntil = now + 30 * DAY_MS;
        billingStore.transactions.unshift({
          id: `tx_${crypto.randomBytes(6).toString('hex')}`,
          userId: user.userId,
          userName: user.name,
          userPhone: user.phone,
          type: 'subscription_charge',
          status: 'completed',
          amountRub: -price,
          description: `Автопродление подписки Open-Key (30 дн.)`,
          paymentChannel: 'auto_renew',
          npdReceiptStatus: 'not_required',
          npdReceiptNumber: null,
          createdAt: now,
        });
      } else {
        user.status = 'expired';
      }
      changed = true;
    } else if (user.status === 'expired' && user.autoRenew && user.balanceRub >= price) {
      user.balanceRub = Number((user.balanceRub - price).toFixed(2));
      user.status = 'active';
      user.paidUntil = now + 30 * DAY_MS;
      billingStore.transactions.unshift({
        id: `tx_${crypto.randomBytes(6).toString('hex')}`,
        userId: user.userId,
        userName: user.name,
        userPhone: user.phone,
        type: 'subscription_charge',
        status: 'completed',
        amountRub: -price,
        description: `Активация подписки с баланса (30 дн.)`,
        paymentChannel: 'auto_renew',
        npdReceiptStatus: 'not_required',
        npdReceiptNumber: null,
        createdAt: now,
      });
      changed = true;
    }

    return changed;
  }

  function upsertBillingUserFromIdentity(identity: {
    userId?: string;
    phone?: string;
    accountId?: string;
    subscriberId?: string;
    name?: string;
    address?: string;
  }): ServerBillingUser {
    const now = Date.now();
    const cleanPhone = identity.phone ? normalizePhone(String(identity.phone)) : '';
    const cleanAccountId = identity.accountId ? String(identity.accountId).trim() : '';
    const cleanSubscriberId = identity.subscriberId ? String(identity.subscriberId).trim() : '';
    const cleanName = identity.name ? String(identity.name).trim() : '';
    const cleanNameLower = cleanName.toLowerCase();
    const cleanAddress = identity.address ? String(identity.address).trim() : '';

    let user = billingStore.users.find(
      (u) =>
        (identity.userId && u.userId === identity.userId) ||
        (cleanPhone && u.phone && normalizePhone(u.phone) === cleanPhone) ||
        (cleanAccountId && u.accountId && u.accountId === cleanAccountId) ||
        (cleanSubscriberId && u.subscriberId && String(u.subscriberId) === cleanSubscriberId) ||
        (cleanNameLower &&
          cleanNameLower !== 'новый пользователь' &&
          !cleanNameLower.startsWith('абонент') &&
          u.name &&
          u.name.trim().toLowerCase() === cleanNameLower &&
          (!cleanPhone || !u.phone || normalizePhone(u.phone) === cleanPhone) &&
          (!cleanAccountId || !u.accountId || u.accountId === cleanAccountId) &&
          (!cleanSubscriberId || !u.subscriberId || String(u.subscriberId) === cleanSubscriberId))
    );

    const ownerMatch = isOwnerIdentity(cleanPhone, cleanAccountId);

    if (!user) {
      const trialDays = Math.max(0, Number(billingStore.config.trialDays) || 7);
      const nameHash = cleanNameLower
        ? crypto.createHash('sha1').update(cleanNameLower).digest('hex').slice(0, 10)
        : '';
      const resolvedId =
        identity.userId ||
        (cleanPhone
          ? `usr_${cleanPhone}`
          : cleanAccountId
            ? `usr_acc_${cleanAccountId}`
            : cleanSubscriberId
              ? `usr_sub_${cleanSubscriberId}`
              : nameHash
                ? `usr_name_${nameHash}`
                : `usr_${crypto.randomBytes(5).toString('hex')}`);

      user = {
        userId: resolvedId,
        phone: cleanPhone,
        accountId: cleanAccountId,
        subscriberId: cleanSubscriberId,
        name: cleanName || (cleanPhone ? `Абонент +${cleanPhone}` : 'Новый пользователь'),
        address: cleanAddress,
        role: ownerMatch ? 'admin' : 'user',
        balanceRub: 0,
        status: trialDays > 0 ? 'trial' : 'expired',
        autoRenew: true,
        trialEndsAt: now + trialDays * DAY_MS,
        paidUntil: null,
        createdAt: now,
        lastSeenAt: now,
        notes: '',
      };
      billingStore.users.unshift(user);
    } else {
      if (cleanPhone && !user.phone) user.phone = cleanPhone;
      if (cleanAccountId && !user.accountId) user.accountId = cleanAccountId;
      if (cleanSubscriberId && !user.subscriberId) user.subscriberId = cleanSubscriberId;
      if (cleanName && (!user.name || user.name.startsWith('Абонент') || user.name.startsWith('Новый'))) {
        user.name = cleanName;
      }
      if (cleanAddress) user.address = cleanAddress;
      user.role = isOwnerIdentity(user.phone, user.accountId) || ownerMatch ? 'admin' : 'user';
      user.lastSeenAt = now;
    }

    reconcileUserSubscription(user);
    saveBillingStoreToDisk();
    return user;
  }

  async function assertActiveSubscription(req: Request, res: Response): Promise<boolean> {
    const verified = await resolveVerifiedSession(req);
    if (verified.isDemo) {
      return true;
    }
    if (!verified.authenticated) {
      const ctx = extractContext(req);
      if (!ctx.accessToken) {
        return true;
      }
      res.status(401).json({
        error: 'unauthorized',
        message: 'Сессия недействительна или истекла. Выполните повторный вход.',
      });
      return false;
    }
    const user = upsertBillingUserFromIdentity({
      phone: verified.phone,
      accountId: verified.accountId,
      subscriberId: verified.subscriberId,
      name: verified.name,
    });
    if (user.status === 'expired' || user.status === 'blocked') {
      res.status(402).json({
        error: 'subscription_required',
        status: user.status,
        message:
          user.status === 'blocked'
            ? 'Ваш аккаунт заблокирован. Доступен только онлайн-просмотр камер.'
            : 'Подписка не оплачена или истекла. Доступен только онлайн-просмотр камер — продлите подписку в «Настройках».',
      });
      return false;
    }
    return true;
  }

  function buildDemoBillingPayload(): {
    user: ServerBillingUser;
    transactions: ServerBillingTx[];
    config: ReturnType<typeof getPublicBillingConfig>;
  } {
    const now = Date.now();
    return {
      user: {
        userId: 'demo_subscriber',
        phone: '79000000000',
        accountId: 'DEMO',
        name: 'Демо-режим',
        address: 'Демонстрационный объект',
        role: 'user',
        balanceRub: 150,
        status: 'trial',
        autoRenew: true,
        trialEndsAt: now + 7 * DAY_MS,
        paidUntil: null,
        createdAt: now,
        lastSeenAt: now,
        notes: 'Демонстрационная сессия',
      },
      transactions: [],
      config: getPublicBillingConfig(),
    };
  }

  function buildAdminOverviewPayload() {
    let anyChanged = deduplicateBillingUsers();
    for (const u of billingStore.users) {
      if (reconcileUserSubscription(u)) anyChanged = true;
    }
    if (anyChanged) saveBillingStoreToDisk();

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * DAY_MS;
    const taxRate = Math.max(0, Number(billingStore.config.npdTaxRatePct) || 4) / 100;

    let activeUsers = 0;
    let trialUsers = 0;
    let expiredOrBlockedUsers = 0;
    let totalUserBalancesRub = 0;

    for (const u of billingStore.users) {
      totalUserBalancesRub += Number(u.balanceRub || 0);
      if (u.status === 'active') activeUsers++;
      else if (u.status === 'trial') trialUsers++;
      else expiredOrBlockedUsers++;
    }

    let revenueLast30DaysRub = 0;
    let pendingTopupsCount = 0;
    let unreceiptedPaymentsCount = 0;

    for (const tx of billingStore.transactions) {
      if (tx.type === 'topup' && tx.status === 'pending') {
        pendingTopupsCount++;
      }
      if (tx.type === 'topup' && tx.status === 'completed' && tx.amountRub > 0) {
        if (tx.createdAt >= thirtyDaysAgo) {
          revenueLast30DaysRub += tx.amountRub;
        }
        if (tx.npdReceiptStatus === 'pending') {
          unreceiptedPaymentsCount++;
        }
      }
    }

    const npdTaxRub = Number((revenueLast30DaysRub * taxRate).toFixed(2));
    const netIncomeRub = Number((revenueLast30DaysRub - npdTaxRub).toFixed(2));

    const sortedUsers = [...billingStore.users].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const sortedTxs = [...billingStore.transactions].sort((a, b) => b.createdAt - a.createdAt);

    return {
      users: sortedUsers,
      transactions: sortedTxs.slice(0, 200),
      config: getPublicBillingConfig(),
      stats: {
        totalUsers: billingStore.users.length,
        activeUsers,
        trialUsers,
        expiredOrBlockedUsers,
        totalUserBalancesRub: Number(totalUserBalancesRub.toFixed(2)),
        revenueLast30DaysRub: Number(revenueLast30DaysRub.toFixed(2)),
        npdTaxRub,
        netIncomeRub,
        pendingTopupsCount,
        unreceiptedPaymentsCount,
      },
    };
  }

  async function verifyAdminRequest(req: Request, res: Response): Promise<boolean> {
    const verified = await resolveVerifiedSession(req);
    if (!verified.authenticated || !verified.isOwner) {
      res.status(403).json({
        error: 'forbidden_owner_only',
        message: 'Доступ к админ-панели разрешён только владельцу сервиса (Л/С 450005579792)',
      });
      return false;
    }

    const requiredPin =
      billingStore.config.adminPin?.trim() || String(process.env.ADMIN_PIN || '').trim();
    if (!requiredPin) return true;
    const suppliedPin = String(req.headers['x-admin-pin'] || req.body?.adminPin || '').trim();
    if (suppliedPin === requiredPin) return true;
    res.status(403).json({
      error: 'admin_pin_required',
      message: 'Требуется PIN-код администратора',
    });
    return false;
  }

  // Public service info & self-employed requisites (accessible without login for YuKassa moderation & footer)
  app.get('/api/eg/public/service-info', (_req: Request, res: Response) => {
    res.json({
      config: getPublicBillingConfig(),
    });
  });

  app.post('/api/eg/billing/me', async (req: Request, res: Response) => {
    try {
      const verified = await resolveVerifiedSession(req);
      const ctx = extractContext(req);
      if (verified.isDemo || !ctx.accessToken) {
        res.json(buildDemoBillingPayload());
        return;
      }
      if (!verified.authenticated) {
        res.status(401).json({ error: 'unauthorized', message: 'Сессия недействительна' });
        return;
      }

      const { address, phone: bodyPhone } = req.body || {};
      const user = upsertBillingUserFromIdentity({
        phone: verified.phone,
        accountId: verified.accountId,
        subscriberId: verified.subscriberId,
        name: verified.name,
        address,
      });

      if (!user.phone && bodyPhone) {
        const cleanBodyPhone = normalizePhone(String(bodyPhone));
        if (cleanBodyPhone && !getOwnerPhonesSet().has(cleanBodyPhone)) {
          user.phone = cleanBodyPhone;
          cacheVerifiedSession(ctx.accessToken, { phone: cleanBodyPhone });
          saveBillingStoreToDisk();
        }
      }

      const userTxs = billingStore.transactions
        .filter((t) => t.userId === user.userId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50);

      res.json({
        user,
        transactions: userTxs,
        config: getPublicBillingConfig(),
      });
    } catch (err: any) {
      res.status(500).json({ error: 'billing_me_error', message: err?.message || 'Ошибка биллинга' });
    }
  });

  // Create YuKassa online payment (or fallback pending request if YuKassa env keys are not set yet)
  app.post('/api/eg/billing/yookassa/create', async (req: Request, res: Response) => {
    try {
      const verified = await resolveVerifiedSession(req);
      if (!verified.authenticated) {
        res.status(403).json({
          error: 'auth_required_for_payment',
          message: 'Онлайн-оплата доступна только после входа по номеру телефона или договору',
        });
        return;
      }

      const { amountRub, comment, address } = req.body || {};
      const user = upsertBillingUserFromIdentity({
        phone: verified.phone,
        accountId: verified.accountId,
        subscriberId: verified.subscriberId,
        name: verified.name,
        address,
      });

      const amount = Math.round(Number(amountRub) * 100) / 100;
      if (!Number.isFinite(amount) || amount < 10 || amount > 50000) {
        res.status(400).json({ error: 'invalid_amount', message: 'Сумма пополнения от 10 до 50 000 ₽' });
        return;
      }

      const txId = `tx_${crypto.randomBytes(6).toString('hex')}`;
      const cleanComment = typeof comment === 'string' ? comment.trim().slice(0, 120) : '';
      const configured = isYookassaConfigured();

      const tx: ServerBillingTx = {
        id: txId,
        userId: user.userId,
        userName: user.name,
        userPhone: user.phone,
        type: 'topup',
        status: 'pending',
        amountRub: amount,
        description:
          cleanComment ||
          (configured
            ? `Пополнение баланса Open-Key через ЮKassa (${amount} ₽)`
            : `Заявка на пополнение баланса (${amount} ₽)`),
        paymentChannel: 'yookassa_npd',
        npdReceiptStatus: 'pending',
        npdReceiptNumber: null,
        yookassaPaymentId: null,
        confirmationUrl: null,
        createdAt: Date.now(),
      };

      if (configured) {
        const origin = resolveAppOrigin(req);
        const returnBase = String(process.env.YOOKASSA_RETURN_URL || '').trim() || `${origin}/`;
        const sep = returnBase.includes('?') ? '&' : '?';
        const returnUrl = `${returnBase}${sep}payment=return&txId=${encodeURIComponent(txId)}`;

        const ykPayment = await createYookassaPayment({
          amountRub: amount,
          description: `Пополнение баланса Open-Key (Л/С ${user.accountId || user.phone || user.userId})`,
          returnUrl,
          metadata: {
            txId,
            userId: user.userId,
            accountId: user.accountId || '',
            phone: user.phone || '',
          },
        });

        tx.yookassaPaymentId = ykPayment?.id ? String(ykPayment.id) : null;
        tx.confirmationUrl = ykPayment?.confirmation?.confirmation_url
          ? String(ykPayment.confirmation.confirmation_url)
          : null;
      }

      billingStore.transactions.unshift(tx);
      saveBillingStoreToDisk();

      const userTxs = billingStore.transactions
        .filter((t) => t.userId === user.userId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50);

      res.json({
        ok: true,
        mode: tx.confirmationUrl ? 'yookassa_redirect' : 'manual_fallback',
        confirmationUrl: tx.confirmationUrl,
        transaction: tx,
        user,
        transactions: userTxs,
        config: getPublicBillingConfig(),
      });
    } catch (err: any) {
      res.status(502).json({
        error: 'yookassa_create_error',
        message: err?.message || 'Ошибка создания платежа ЮKassa',
      });
    }
  });

  // YuKassa server-to-server HTTP webhook notification handler
  app.post('/api/eg/billing/yookassa/webhook', async (req: Request, res: Response) => {
    try {
      const paymentObj = req.body?.object;
      const paymentId = paymentObj?.id ? String(paymentObj.id) : '';
      if (!paymentId) {
        res.status(400).json({ ok: false, error: 'missing_payment_id' });
        return;
      }

      if (!isYookassaConfigured()) {
        res.status(200).json({ ok: true, ignored: 'yookassa_not_configured' });
        return;
      }

      // Always verify actual payment state directly with api.yookassa.ru
      const verifiedPayment = await fetchYookassaPayment(paymentId);
      const txIdFromMeta = verifiedPayment?.metadata?.txId
        ? String(verifiedPayment.metadata.txId)
        : '';

      const tx = billingStore.transactions.find(
        (t) => t.yookassaPaymentId === paymentId || (txIdFromMeta && t.id === txIdFromMeta)
      );

      if (tx) {
        if (!tx.yookassaPaymentId) {
          tx.yookassaPaymentId = paymentId;
        }
        applyYookassaStatusToTx(tx, verifiedPayment);
      }

      res.status(200).json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'webhook_error' });
    }
  });

  // Check YuKassa payment status after user returns from checkout (?payment=return)
  app.post('/api/eg/billing/yookassa/check', async (req: Request, res: Response) => {
    try {
      const verified = await resolveVerifiedSession(req);
      if (!verified.authenticated) {
        res.status(403).json({ error: 'auth_required', message: 'Требуется авторизация' });
        return;
      }

      const user = upsertBillingUserFromIdentity({
        phone: verified.phone,
        accountId: verified.accountId,
        subscriberId: verified.subscriberId,
        name: verified.name,
      });

      const targetTxId = typeof req.body?.txId === 'string' ? req.body.txId.trim() : '';
      let updatedCount = 0;

      if (isYookassaConfigured()) {
        const candidates = billingStore.transactions.filter(
          (t) =>
            t.userId === user.userId &&
            t.status === 'pending' &&
            Boolean(t.yookassaPaymentId) &&
            (!targetTxId || t.id === targetTxId)
        );

        for (const tx of candidates) {
          if (!tx.yookassaPaymentId) continue;
          try {
            const ykPayment = await fetchYookassaPayment(tx.yookassaPaymentId);
            if (applyYookassaStatusToTx(tx, ykPayment)) {
              updatedCount++;
            }
          } catch {
            // ignore transient check failure
          }
        }
      }

      const userTxs = billingStore.transactions
        .filter((t) => t.userId === user.userId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50);

      res.json({
        ok: true,
        updatedCount,
        user,
        transactions: userTxs,
        config: getPublicBillingConfig(),
      });
    } catch (err: any) {
      res.status(500).json({
        error: 'yookassa_check_error',
        message: err?.message || 'Ошибка проверки статуса платежа',
      });
    }
  });

  app.post('/api/eg/billing/topup-request', async (req: Request, res: Response) => {
    try {
      const verified = await resolveVerifiedSession(req);
      if (!verified.authenticated) {
        res.status(403).json({
          error: 'auth_required_for_payment',
          message: 'Пополнение баланса доступно после входа в аккаунт',
        });
        return;
      }

      const { address, amountRub, comment, paymentChannel } = req.body || {};
      const user = upsertBillingUserFromIdentity({
        phone: verified.phone,
        accountId: verified.accountId,
        subscriberId: verified.subscriberId,
        name: verified.name,
        address,
      });
      const amount = Math.round(Number(amountRub) * 100) / 100;
      if (!Number.isFinite(amount) || amount < 10 || amount > 50000) {
        res.status(400).json({ error: 'invalid_amount', message: 'Сумма пополнения от 10 до 50 000 ₽' });
        return;
      }

      const cleanComment = typeof comment === 'string' ? comment.trim().slice(0, 120) : '';
      const tx: ServerBillingTx = {
        id: `tx_${crypto.randomBytes(6).toString('hex')}`,
        userId: user.userId,
        userName: user.name,
        userPhone: user.phone,
        type: 'topup',
        status: 'pending',
        amountRub: amount,
        description: cleanComment || `Заявка на пополнение баланса (${amount} ₽)`,
        paymentChannel: paymentChannel === 'sbp' ? 'sbp' : 'yookassa_npd',
        npdReceiptStatus: 'pending',
        npdReceiptNumber: null,
        createdAt: Date.now(),
      };
      billingStore.transactions.unshift(tx);
      saveBillingStoreToDisk();

      const userTxs = billingStore.transactions
        .filter((t) => t.userId === user.userId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50);

      res.json({
        ok: true,
        transaction: tx,
        user,
        transactions: userTxs,
        config: getPublicBillingConfig(),
      });
    } catch (err: any) {
      res.status(500).json({ error: 'topup_request_error', message: err?.message || 'Ошибка создания заявки' });
    }
  });

  app.post('/api/eg/billing/activate-or-renew', async (req: Request, res: Response) => {
    try {
      const verified = await resolveVerifiedSession(req);
      if (!verified.authenticated) {
        res.status(403).json({
          error: 'auth_required',
          message: 'Продление подписки доступно после входа по номеру телефона',
        });
        return;
      }

      const { address } = req.body || {};
      const user = upsertBillingUserFromIdentity({
        phone: verified.phone,
        accountId: verified.accountId,
        subscriberId: verified.subscriberId,
        name: verified.name,
        address,
      });
      if (user.status === 'blocked') {
        res.status(403).json({ error: 'user_blocked', message: 'Доступ заблокирован администратором' });
        return;
      }
      const price = Math.max(1, Number(billingStore.config.monthlyPriceRub) || 50);
      if (user.balanceRub < price) {
        res.status(400).json({
          error: 'insufficient_funds',
          message: `Недостаточно средств на балансе. Необходимо ${price} ₽ (сейчас ${user.balanceRub.toFixed(0)} ₽).`,
        });
        return;
      }

      const now = Date.now();
      const baseTime = user.paidUntil && user.paidUntil > now ? user.paidUntil : now;
      user.balanceRub = Number((user.balanceRub - price).toFixed(2));
      user.status = 'active';
      user.paidUntil = baseTime + 30 * DAY_MS;

      billingStore.transactions.unshift({
        id: `tx_${crypto.randomBytes(6).toString('hex')}`,
        userId: user.userId,
        userName: user.name,
        userPhone: user.phone,
        type: 'subscription_charge',
        status: 'completed',
        amountRub: -price,
        description: `Продление доступа Open-Key на 30 дней`,
        paymentChannel: 'system',
        npdReceiptStatus: 'not_required',
        npdReceiptNumber: null,
        createdAt: now,
      });
      saveBillingStoreToDisk();

      const userTxs = billingStore.transactions
        .filter((t) => t.userId === user.userId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50);

      res.json({
        user,
        transactions: userTxs,
        config: getPublicBillingConfig(),
      });
    } catch (err: any) {
      res.status(500).json({ error: 'renew_error', message: err?.message || 'Ошибка продления подписки' });
    }
  });

  app.post('/api/eg/billing/auto-renew', async (req: Request, res: Response) => {
    try {
      const verified = await resolveVerifiedSession(req);
      if (!verified.authenticated) {
        res.status(403).json({
          error: 'auth_required',
          message: 'Настройка автопродления доступна после входа по номеру телефона',
        });
        return;
      }

      const { autoRenew } = req.body || {};
      const user = upsertBillingUserFromIdentity({
        phone: verified.phone,
        accountId: verified.accountId,
        subscriberId: verified.subscriberId,
        name: verified.name,
      });
      user.autoRenew = Boolean(autoRenew);
      reconcileUserSubscription(user);
      saveBillingStoreToDisk();

      const userTxs = billingStore.transactions
        .filter((t) => t.userId === user.userId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50);

      res.json({
        user,
        transactions: userTxs,
        config: getPublicBillingConfig(),
      });
    } catch (err: any) {
      res.status(500).json({ error: 'auto_renew_error', message: err?.message || 'Ошибка настройки автопродления' });
    }
  });

  app.post('/api/eg/admin/unlock', async (req: Request, res: Response) => {
    const verified = await resolveVerifiedSession(req);
    if (!verified.authenticated || !verified.isOwner) {
      res.status(403).json({
        error: 'forbidden_owner_only',
        message: 'Доступ к админ-панели разрешён только владельцу сервиса',
      });
      return;
    }
    const requiredPin =
      billingStore.config.adminPin?.trim() || String(process.env.ADMIN_PIN || '').trim();
    const suppliedPin = String(req.body?.pin || '').trim();
    if (!requiredPin || suppliedPin === requiredPin) {
      res.json({ ok: true });
      return;
    }
    res.status(403).json({ error: 'invalid_pin', message: 'Неверный PIN-код администратора' });
  });

  app.get('/api/eg/admin/overview', async (req: Request, res: Response) => {
    if (!(await verifyAdminRequest(req, res))) return;
    res.json(buildAdminOverviewPayload());
  });

  app.post('/api/eg/admin/users', async (req: Request, res: Response) => {
    if (!(await verifyAdminRequest(req, res))) return;
    try {
      const { name, phone, accountId, address, balanceRub, status, role, notes } = req.body || {};
      const cleanName = String(name || '').trim();
      const cleanPhone = phone ? normalizePhone(String(phone)) : '';
      const cleanAccountId = String(accountId || '').trim();
      if (!cleanName && !cleanPhone) {
        res.status(400).json({ error: 'missing_user_info', message: 'Укажите имя или телефон пользователя' });
        return;
      }

      const existing = billingStore.users.find(
        (u) =>
          (cleanPhone && u.phone === cleanPhone) ||
          (cleanAccountId && u.accountId === cleanAccountId)
      );
      if (existing) {
        res.status(409).json({ error: 'user_exists', message: 'Пользователь с таким телефоном или Л/С уже есть в базе' });
        return;
      }

      const now = Date.now();
      const initBalance = Number.isFinite(Number(balanceRub)) ? Math.round(Number(balanceRub) * 100) / 100 : 0;
      const userId = cleanPhone ? `usr_${cleanPhone}` : `usr_${crypto.randomBytes(5).toString('hex')}`;
      const newUser: ServerBillingUser = {
        userId,
        phone: cleanPhone,
        accountId: cleanAccountId,
        name: cleanName || `Абонент +${cleanPhone}`,
        address: String(address || '').trim(),
        role: isOwnerIdentity(cleanPhone, cleanAccountId) || role === 'admin' ? 'admin' : 'user',
        balanceRub: initBalance,
        status: status === 'active' || status === 'expired' || status === 'blocked' ? status : 'trial',
        autoRenew: true,
        trialEndsAt: now + Math.max(0, Number(billingStore.config.trialDays) || 7) * DAY_MS,
        paidUntil: status === 'active' ? now + 30 * DAY_MS : null,
        createdAt: now,
        lastSeenAt: now,
        notes: String(notes || '').trim(),
      };
      billingStore.users.unshift(newUser);
      if (initBalance > 0) {
        billingStore.transactions.unshift({
          id: `tx_${crypto.randomBytes(6).toString('hex')}`,
          userId: newUser.userId,
          userName: newUser.name,
          userPhone: newUser.phone,
          type: 'topup',
          status: 'completed',
          amountRub: initBalance,
          description: 'Начальное пополнение баланса администратором',
          paymentChannel: 'manual',
          npdReceiptStatus: 'pending',
          npdReceiptNumber: null,
          createdAt: now,
        });
      }
      reconcileUserSubscription(newUser);
      saveBillingStoreToDisk();
      res.json(buildAdminOverviewPayload());
    } catch (err: any) {
      res.status(500).json({ error: 'create_user_error', message: err?.message || 'Ошибка добавления пользователя' });
    }
  });

  app.post('/api/eg/admin/users/:userId/balance', async (req: Request, res: Response) => {
    if (!(await verifyAdminRequest(req, res))) return;
    try {
      const userId = String(req.params.userId || '');
      const user = billingStore.users.find((u) => u.userId === userId);
      if (!user) {
        res.status(404).json({ error: 'user_not_found', message: 'Пользователь не найден' });
        return;
      }

      const delta = Math.round(Number(req.body?.deltaRub || 0) * 100) / 100;
      if (!Number.isFinite(delta) || delta === 0) {
        res.status(400).json({ error: 'invalid_delta', message: 'Укажите сумму изменения баланса (не 0)' });
        return;
      }

      const description = String(req.body?.description || '').trim();
      const paymentChannel =
        req.body?.paymentChannel === 'sbp' || req.body?.paymentChannel === 'yookassa_npd'
          ? req.body.paymentChannel
          : 'manual';
      const npdReceiptNumber = String(req.body?.npdReceiptNumber || '').trim() || null;
      const isTopup = delta > 0 && req.body?.markAsTopup !== false;

      user.balanceRub = Number((user.balanceRub + delta).toFixed(2));

      billingStore.transactions.unshift({
        id: `tx_${crypto.randomBytes(6).toString('hex')}`,
        userId: user.userId,
        userName: user.name,
        userPhone: user.phone,
        type: isTopup ? 'topup' : 'manual_adjust',
        status: 'completed',
        amountRub: delta,
        description:
          description ||
          (isTopup
            ? `Пополнение баланса (${paymentChannel === 'yookassa_npd' ? 'ЮKassa' : paymentChannel === 'sbp' ? 'СБП' : 'администратор'})`
            : `Корректировка баланса администратором`),
        paymentChannel,
        npdReceiptStatus: isTopup
          ? npdReceiptNumber
            ? 'issued'
            : 'pending'
          : 'not_required',
        npdReceiptNumber,
        createdAt: Date.now(),
      });

      reconcileUserSubscription(user);
      saveBillingStoreToDisk();
      res.json(buildAdminOverviewPayload());
    } catch (err: any) {
      res.status(500).json({ error: 'balance_adjust_error', message: err?.message || 'Ошибка изменения баланса' });
    }
  });

  app.post('/api/eg/admin/users/:userId/subscription', async (req: Request, res: Response) => {
    if (!(await verifyAdminRequest(req, res))) return;
    try {
      const userId = String(req.params.userId || '');
      const user = billingStore.users.find((u) => u.userId === userId);
      if (!user) {
        res.status(404).json({ error: 'user_not_found', message: 'Пользователь не найден' });
        return;
      }

      const { status, addDays, role, autoRenew, notes } = req.body || {};
      const now = Date.now();
      if (status === 'trial' || status === 'active' || status === 'expired' || status === 'blocked') {
        user.status = status;
        if (status === 'active' && (!user.paidUntil || user.paidUntil < now)) {
          user.paidUntil = now + 30 * DAY_MS;
        }
      }
      if (typeof addDays === 'number' && Number.isFinite(addDays) && addDays !== 0) {
        const base = user.paidUntil && user.paidUntil > now ? user.paidUntil : now;
        user.paidUntil = base + addDays * DAY_MS;
        if (addDays > 0 && user.status !== 'blocked') {
          user.status = 'active';
        }
      }
      if (role === 'admin' || role === 'user') {
        user.role = isOwnerIdentity(user.phone, user.accountId) ? 'admin' : role;
      }
      if (typeof autoRenew === 'boolean') {
        user.autoRenew = autoRenew;
      }
      if (typeof notes === 'string') {
        user.notes = notes.trim().slice(0, 200);
      }

      saveBillingStoreToDisk();
      res.json(buildAdminOverviewPayload());
    } catch (err: any) {
      res.status(500).json({ error: 'sub_update_error', message: err?.message || 'Ошибка обновления пользователя' });
    }
  });

  app.post('/api/eg/admin/transactions/:txId/approve', async (req: Request, res: Response) => {
    if (!(await verifyAdminRequest(req, res))) return;
    try {
      const txId = String(req.params.txId || '');
      const tx = billingStore.transactions.find((t) => t.id === txId);
      if (!tx) {
        res.status(404).json({ error: 'tx_not_found', message: 'Транзакция не найдена' });
        return;
      }
      if (tx.status !== 'pending') {
        res.status(400).json({ error: 'tx_already_processed', message: 'Заявка уже обработана' });
        return;
      }

      const action = req.body?.action === 'reject' ? 'reject' : 'approve';
      const npdReceiptNumber = String(req.body?.npdReceiptNumber || '').trim() || null;

      if (action === 'reject') {
        tx.status = 'rejected';
        tx.npdReceiptStatus = 'not_required';
      } else {
        tx.status = 'completed';
        if (npdReceiptNumber) {
          tx.npdReceiptStatus = 'issued';
          tx.npdReceiptNumber = npdReceiptNumber;
        }
        const user = billingStore.users.find((u) => u.userId === tx.userId);
        if (user) {
          user.balanceRub = Number((user.balanceRub + tx.amountRub).toFixed(2));
          reconcileUserSubscription(user);
        }
      }

      saveBillingStoreToDisk();
      res.json(buildAdminOverviewPayload());
    } catch (err: any) {
      res.status(500).json({ error: 'tx_approve_error', message: err?.message || 'Ошибка обработки платежа' });
    }
  });

  app.post('/api/eg/admin/transactions/:txId/npd-receipt', async (req: Request, res: Response) => {
    if (!(await verifyAdminRequest(req, res))) return;
    try {
      const txId = String(req.params.txId || '');
      const tx = billingStore.transactions.find((t) => t.id === txId);
      if (!tx) {
        res.status(404).json({ error: 'tx_not_found', message: 'Транзакция не найдена' });
        return;
      }

      const num = String(req.body?.npdReceiptNumber || '').trim() || `NPD-${Date.now().toString().slice(-6)}`;
      tx.npdReceiptStatus = 'issued';
      tx.npdReceiptNumber = num;
      saveBillingStoreToDisk();
      res.json(buildAdminOverviewPayload());
    } catch (err: any) {
      res.status(500).json({ error: 'npd_receipt_error', message: err?.message || 'Ошибка сохранения чека НПД' });
    }
  });

  app.post('/api/eg/admin/config', async (req: Request, res: Response) => {
    if (!(await verifyAdminRequest(req, res))) return;
    try {
      const b = req.body || {};
      if (typeof b.monthlyPriceRub === 'number' && b.monthlyPriceRub >= 1) {
        billingStore.config.monthlyPriceRub = Math.round(b.monthlyPriceRub);
      }
      if (typeof b.trialDays === 'number' && b.trialDays >= 0 && b.trialDays <= 90) {
        billingStore.config.trialDays = Math.round(b.trialDays);
      }
      if (typeof b.selfEmployedName === 'string') {
        billingStore.config.selfEmployedName = b.selfEmployedName.trim().slice(0, 120);
      }
      if (typeof b.selfEmployedInn === 'string') {
        billingStore.config.selfEmployedInn = b.selfEmployedInn.replace(/\D/g, '').slice(0, 12);
      }
      if (typeof b.sbpPhoneOrLink === 'string') {
        billingStore.config.sbpPhoneOrLink = b.sbpPhoneOrLink.trim().slice(0, 140);
      }
      if (typeof b.paymentMethodLabel === 'string') {
        billingStore.config.paymentMethodLabel = b.paymentMethodLabel.trim().slice(0, 100);
      }
      if (typeof b.npdTaxRatePct === 'number' && (b.npdTaxRatePct === 4 || b.npdTaxRatePct === 6)) {
        billingStore.config.npdTaxRatePct = b.npdTaxRatePct;
      }
      if (typeof b.supportEmail === 'string') {
        billingStore.config.supportEmail = b.supportEmail.trim().slice(0, 120);
      }
      if (typeof b.supportTelegram === 'string') {
        billingStore.config.supportTelegram = b.supportTelegram.trim().slice(0, 120);
      }
      if (typeof b.supportPhone === 'string') {
        billingStore.config.supportPhone = b.supportPhone.trim().slice(0, 60);
      }
      if (typeof b.supportHours === 'string') {
        billingStore.config.supportHours = b.supportHours.trim().slice(0, 100);
      }
      if (typeof b.sellerCity === 'string') {
        billingStore.config.sellerCity = b.sellerCity.trim().slice(0, 100);
      }
      if (typeof b.newAdminPin === 'string') {
        billingStore.config.adminPin = b.newAdminPin.trim().slice(0, 32);
      } else if (b.clearAdminPin === true) {
        billingStore.config.adminPin = '';
      }

      saveBillingStoreToDisk();
      res.json(buildAdminOverviewPayload());
    } catch (err: any) {
      res.status(500).json({ error: 'config_update_error', message: err?.message || 'Ошибка сохранения настроек' });
    }
  });

  // Per-User Camera Aliases (Rename cameras individually per user)
  app.get('/api/eg/cameras/aliases', async (req: Request, res: Response) => {
    try {
      const verified = await resolveVerifiedSession(req);
      if (verified.isDemo) {
        res.json({ aliases: {} });
        return;
      }
      if (!verified.authenticated) {
        res.status(401).json({ error: 'unauthorized', message: 'Требуется авторизация' });
        return;
      }
      const user = upsertBillingUserFromIdentity({
        phone: verified.phone,
        accountId: verified.accountId,
        subscriberId: verified.subscriberId,
        name: verified.name,
      });
      res.json({ aliases: getCameraAliasesForUser(user.userId) });
    } catch (err: any) {
      res.status(500).json({ error: 'aliases_error', message: err?.message || 'Ошибка загрузки названий камер' });
    }
  });

  app.post('/api/eg/cameras/alias', async (req: Request, res: Response) => {
    try {
      const verified = await resolveVerifiedSession(req);
      const { cameraId, name } = req.body || {};
      const cleanId = String(cameraId || '').trim();
      if (!cleanId) {
        res.status(400).json({ error: 'missing_camera_id', message: 'Не указан ID камеры' });
        return;
      }
      if (verified.isDemo) {
        const result = setCameraAliasForUser('demo_subscriber', cleanId, String(name || ''));
        res.json({
          ok: true,
          demo: true,
          cameraId: cleanId,
          alias: result.alias,
          aliases: result.aliases,
        });
        return;
      }
      if (!verified.authenticated) {
        res.status(401).json({ error: 'unauthorized', message: 'Требуется авторизация' });
        return;
      }
      if (!(await assertActiveSubscription(req, res))) return;
      const user = upsertBillingUserFromIdentity({
        phone: verified.phone,
        accountId: verified.accountId,
        subscriberId: verified.subscriberId,
        name: verified.name,
      });
      const result = setCameraAliasForUser(user.userId, cleanId, String(name || ''));

      let passesUpdated = false;
      for (const rec of localGuestPasses.values()) {
        const recOwner = resolveOwnerUserIdForGuestPass(rec);
        if (recOwner === user.userId) {
          if (!rec.ownerUserId) {
            rec.ownerUserId = user.userId;
            passesUpdated = true;
          }
          for (const ac of rec.availableAccessControl || []) {
            if (!ac.cameraId) {
              const cachedCam = lookupCachedPlaceControlCamera(rec.placeId, ac.id, ac.entranceId);
              if (cachedCam) {
                ac.cameraId = cachedCam;
                passesUpdated = true;
              }
            }
          }
        }
      }
      if (passesUpdated) {
        saveLocalGuestPassesToDisk();
      }

      res.json({
        ok: true,
        cameraId: cleanId,
        alias: result.alias,
        aliases: result.aliases,
      });
    } catch (err: any) {
      res.status(500).json({ error: 'alias_save_error', message: err?.message || 'Не удалось сохранить название камеры' });
    }
  });

  // Ensure unmatched /api/* routes always return JSON (never fall through to SPA HTML)
  app.use('/api', (req: Request, res: Response) => {
    res.status(404).json({
      error: 'api_not_found',
      message: `API-маршрут не найден: ${req.method} ${req.originalUrl}`,
    });
  });

  // Vite middleware for development or static build in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });

    // Since HMR & ws are disabled in this runtime, strip the client's WS auto-connect call
    // so browsers do not log createWebSocketModuleRunnerTransport errors.
    app.use('/@vite/client', (req, res, next) => {
      delete req.headers['accept-encoding'];
      const chunks: Buffer[] = [];
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);

      (res as any).write = (chunk: any) => {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return true;
      };

      (res as any).end = (chunk?: any, ...args: any[]) => {
        if (chunk && typeof chunk !== 'function') {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const encoding = res.getHeader('content-encoding');
        const rawBuf = Buffer.concat(chunks);
        if (!encoding && rawBuf.length > 0) {
          let body = rawBuf.toString('utf8');
          body = body.replace(
            'transport.connect(createHMRHandler(handleMessage))',
            'void 0'
          );
          res.removeHeader('content-length');
          origWrite(body, 'utf8');
          return origEnd(typeof chunk === 'function' ? chunk : undefined);
        }
        if (rawBuf.length > 0) {
          origWrite(rawBuf);
        }
        return origEnd(...args);
      };

      next();
    });

    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
