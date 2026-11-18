import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Unlock,
  Check,
  RefreshCw,
  Video,
  History,
  Key,
  BellOff,
  Search,
  Download,
  X,
  Play,
  Copy,
  Trash2,
  Plus,
  LogOut,
  AlertCircle,
  SlidersHorizontal,
  Sun,
  Moon,
  Bell,
  ChevronDown,
  Home,
  Archive,
  Users,
  Settings,
  MoreHorizontal,
  Smartphone,
  User,
  ShieldCheck,
  Wallet,
  Info,
  Star,
  Lock,
  Pencil,
  RotateCcw,
} from 'lucide-react';
import {
  BalanceInfo,
  BillingMePayload,
  CameraEventItem,
  CameraItem,
  DndItem,
  DoorActionLog,
  EgSession,
  Esp32GateStatusPayload,
  GuestPassControlOption,
  HistoryEventItem,
  LockItem,
  PlaceItem,
  TempPassItem,
} from './types/eg';
import {
  apiCheckYookassaPayment,
  apiCreateTempPass,
  apiCreateYookassaPayment,
  apiDeleteTempPass,
  apiGetBillingMe,
  apiGetCameraEvents,
  apiGetEsp32Status,
  apiGetPlaceHistoryPage,
  apiGetTempPasses,
  apiOpenLock,
  apiRenameCamera,
  apiRenewSubscription,
  apiSetBillingAutoRenew,
  apiSyncDashboard,
  apiUpdateDnd,
  apiUpdateEsp32Config,
  downloadArchiveVideoMp4,
  loadLocalCameraAliases,
  loadSavedSession,
  saveSession,
} from './services/egClient';
import { LoginScreen } from './components/LoginScreen';
import { CameraSnapshotCard } from './components/CameraSnapshotCard';
import { CameraFeedPlayer } from './components/CameraFeedPlayer';
import { CachedCameraImage } from './components/CachedCameraImage';
import { ProceduralCameraCanvas } from './components/ProceduralCameraCanvas';
import { triggerApkDownload } from './components/PWAInstallButton';
import { GuestPassPortal } from './components/GuestPassPortal';
import { OverviewDashboard } from './components/OverviewDashboard';
import { AdminPanel } from './components/AdminPanel';
import { ServiceAboutPage } from './components/ServiceAboutPage';
import {
  CctvCameraIcon,
  DomRuLabLogo,
  DoorOutlineIcon,
  GateOutlineIcon,
} from './components/DomRuBrandLogo';
import { playGlobalDoorOpenSound } from './utils/flvAudioEngine';
import { useTheme } from './hooks/useTheme';

type ActiveSection =
  | 'overview'
  | 'cameras'
  | 'video'
  | 'access'
  | 'users'
  | 'settings'
  | 'about'
  | 'admin';

function checkIsPublicRequisitesRoute(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  const page = (params.get('page') || '').toLowerCase();
  const pathname = window.location.pathname.toLowerCase().replace(/\/+$/, '');
  return (
    page === 'requisites' ||
    page === 'about' ||
    pathname === '/requisites' ||
    pathname === '/about'
  );
}

function formatUnixTime(sec: number): string {
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins > 0) {
    return `${mins} мин ${secs} сек`;
  }
  return `${secs} сек`;
}

function getRecentDays(retentionDays: number): string[] {
  const days: string[] = [];
  const now = new Date();
  for (let i = 0; i < retentionDays; i++) {
    const d = new Date(now.getTime() - i * 86400 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    days.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  return days;
}

const ArchiveCameraThumb: React.FC<{
  session: EgSession;
  camera: CameraItem;
  refreshTick: number;
}> = ({ session, camera, refreshTick }) => {
  return (
    <div className="w-20 h-12 sm:w-24 sm:h-[54px] shrink-0 rounded-lg overflow-hidden bg-slate-900 border border-slate-200/60 dark:border-white/[0.08]">
      <CachedCameraImage
        session={session}
        camera={camera}
        refreshTick={refreshTick}
        width={320}
        height={180}
        spinnerSize="sm"
        className="w-full h-full object-cover"
      />
    </div>
  );
};

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const [session, setSession] = useState<EgSession | null>(() => loadSavedSession());
  const [showWelcomePage, setShowWelcomePage] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return !localStorage.getItem('domru_key_welcome_v3_minimal_seen');
  });
  const [activeSection, setActiveSection] = useState<ActiveSection>(() =>
    checkIsPublicRequisitesRoute() ? 'about' : 'overview'
  );
  const [publicAboutOpen, setPublicAboutOpen] = useState<boolean>(() =>
    checkIsPublicRequisitesRoute()
  );

  // Synchronized data from coordinator
  const [places, setPlaces] = useState<PlaceItem[]>([]);
  const [balances, setBalances] = useState<Record<string, BalanceInfo>>({});
  const [locks, setLocks] = useState<LockItem[]>([]);
  const [cameras, setCameras] = useState<CameraItem[]>([]);
  const [dndByPlace, setDndByPlace] = useState<Record<string, DndItem[]>>({});
  const [placeHistory, setPlaceHistory] = useState<HistoryEventItem[]>([]);
  const [placeHistoryPage, setPlaceHistoryPage] = useState<number>(0);
  const [placeHistoryHasMore, setPlaceHistoryHasMore] = useState<boolean>(false);
  const [placeHistoryLoadingMore, setPlaceHistoryLoadingMore] = useState<boolean>(false);

  const [selectedPlaceId, setSelectedPlaceId] = useState<string>('all');
  const [syncLoading, setSyncLoading] = useState<boolean>(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [toastNotice, setToastNotice] = useState<string | null>(null);

  // Header menus
  const [profileMenuOpen, setProfileMenuOpen] = useState<boolean>(false);
  const [notificationsOpen, setNotificationsOpen] = useState<boolean>(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState<boolean>(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);

  // Lock state & session log
  const [unlockingMap, setUnlockingMap] = useState<Record<string, boolean>>({});
  const [unlockedMap, setUnlockedMap] = useState<Record<string, boolean>>({});
  const [doorLogs, setDoorLogs] = useState<DoorActionLog[]>([]);
  const [lockSearch, setLockSearch] = useState<string>('');
  const [lockFilter, setLockFilter] = useState<'all' | 'door' | 'gate' | 'barrier'>('all');

  // Snapshot state & Favorites
  const [snapshotRefreshTick, setSnapshotRefreshTick] = useState<number>(1);
  const [autoRefreshSec, setAutoRefreshSec] = useState<number>(0);
  const [cameraSourceFilter, setCameraSourceFilter] = useState<
    'all' | 'intercom' | 'public' | 'favorite'
  >('all');
  const [favoriteCameraMap, setFavoriteCameraMap] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem('plumix_favorite_cameras_v1');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [showHiddenCameras, setShowHiddenCameras] = useState<boolean>(false);
  const [cameraSearch, setCameraSearch] = useState<string>('');
  const [lightboxCamera, setLightboxCamera] = useState<{
    camera: CameraItem;
    url: string | null;
  } | null>(null);
  const [renamingSidebarCameraId, setRenamingSidebarCameraId] = useState<string | null>(null);
  const [renamingSidebarDraft, setRenamingSidebarDraft] = useState<string>('');
  const [renamingSidebarSaving, setRenamingSidebarSaving] = useState<boolean>(false);

  // Live & Archive Video Player state
  const [selectedVideoCameraId, setSelectedVideoCameraId] = useState<string>('');
  const [videoPlaybackMode, setVideoPlaybackMode] = useState<
    'live' | 'archive_stream' | 'event_mp4'
  >('live');
  const [archiveDay, setArchiveDay] = useState<string>(() => getRecentDays(1)[0]);
  const [archiveTimestampSec, setArchiveTimestampSec] = useState<number | null>(null);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [cameraEvents, setCameraEvents] = useState<CameraEventItem[]>([]);
  const [eventsLoading, setEventsLoading] = useState<boolean>(false);
  const [eventsLoadingMore, setEventsLoadingMore] = useState<boolean>(false);
  const [eventsHasMore, setEventsHasMore] = useState<boolean>(false);
  const [downloadingEventId, setDownloadingEventId] = useState<string | null>(null);
  const [initialClipSeekSec, setInitialClipSeekSec] = useState<number>(0);
  const [ playerSeekNonce, setPlayerSeekNonce] = useState<number>(0);
  const [archiveMinTsByCamera, setArchiveMinTsByCamera] = useState<Record<string, number>>({});
  const [jumpTimeInput, setJumpTimeInput] = useState<string>(() =>
    formatUnixTime(Math.floor(Date.now() / 1000) - 300)
  );
  const [clipDownloadDurationSec, setClipDownloadDurationSec] = useState<number>(30);
  const [downloadingCustomClip, setDownloadingCustomClip] = useState<boolean>(false);
  const eventsListRef = useRef<HTMLDivElement | null>(null);
  const pendingSeekTargetRef = useRef<{
    cameraId: string;
    day: string;
    tsSec: number;
  } | null>(null);

  // Guest Passes state
  const [tempPasses, setTempPasses] = useState<TempPassItem[]>([]);
  const [tempPassAcs, setTempPassAcs] = useState<GuestPassControlOption[]>([]);
  const [selectedTtl, setSelectedTtl] = useState<string>('43200');
  const [selectedPassControlKeys, setSelectedPassControlKeys] = useState<string[]>([]);
  const [passLabel, setPassLabel] = useState<string>('');
  const [passesLoading, setPassesLoading] = useState<boolean>(false);
  const [copiedPassId, setCopiedPassId] = useState<string | null>(null);
  const [activeGuestPassToken, setActiveGuestPassToken] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    return params.get('guestPass') || params.get('guest_pass') || null;
  });

  // Commercial Billing (50 RUB/mo) state
  const [billingMe, setBillingMe] = useState<BillingMePayload | null>(null);
  const [billingBusy, setBillingBusy] = useState<boolean>(false);
  const [topupAmountInput, setTopupAmountInput] = useState<string>('50');
  const [topupCommentInput, setTopupCommentInput] = useState<string>('');

  const isSubscriptionRestricted = Boolean(
    billingMe && (billingMe.user.status === 'expired' || billingMe.user.status === 'blocked')
  );

  useEffect(() => {
    if (isSubscriptionRestricted && videoPlaybackMode !== 'live') {
      setVideoPlaybackMode('live');
      setArchiveTimestampSec(null);
      setActiveEventId(null);
    }
  }, [isSubscriptionRestricted, videoPlaybackMode]);

  // ESP32 Gate Remote Controller state
  const [esp32Status, setEsp32Status] = useState<Esp32GateStatusPayload | null>(null);
  const [esp32ConfigOpen, setEsp32ConfigOpen] = useState<boolean>(false);
  const [esp32SketchOpen, setEsp32SketchOpen] = useState<boolean>(false);
  const [esp32Saving, setEsp32Saving] = useState<boolean>(false);
  const [esp32HttpUrlInput, setEsp32HttpUrlInput] = useState<string>('');
  const [esp32PulseMsInput, setEsp32PulseMsInput] = useState<string>('600');
  const [esp32Ch1PinInput, setEsp32Ch1PinInput] = useState<string>('18');
  const [esp32Ch2PinInput, setEsp32Ch2PinInput] = useState<string>('19');
  const [esp32SecretInput, setEsp32SecretInput] = useState<string>('');

  const showNotice = useCallback((msg: string) => {
    setToastNotice(msg);
  }, []);

  useEffect(() => {
    if (!toastNotice) return;
    const t = setTimeout(() => setToastNotice(null), 3500);
    return () => clearTimeout(t);
  }, [toastNotice]);

  // Close profile dropdown on outside click
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setProfileMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  // Synchronize all places, locks, cameras, balances
  const handleSync = useCallback(async (activeSession: EgSession) => {
    setSyncLoading(true);
    setSyncError(null);
    try {
      const data = await apiSyncDashboard(activeSession);
      const syncedPlaces = data.places || [];
      const defaultPlace = syncedPlaces[0];
      const syncedLocks = [...(data.locks || [])];
      const syncedAliases = data.cameraAliases || loadLocalCameraAliases(activeSession);
      const syncedCameras = (data.cameras || []).map((rawCam) => {
        const originalName = rawCam.originalName || rawCam.name;
        const customAlias = syncedAliases[rawCam.id];
        const cam: CameraItem = {
          ...rawCam,
          originalName,
          name: customAlias && customAlias.trim() ? customAlias.trim() : rawCam.name,
        };
        const lower = originalName.toLowerCase();
        const isFacade1 =
          lower.includes('фасад 1') ||
          lower.includes('фасад №1') ||
          lower.includes('фасад-1') ||
          lower.includes('ворота 1');
        const isFacade2 =
          lower.includes('фасад 2') ||
          lower.includes('фасад №2') ||
          lower.includes('фасад-2') ||
          lower.includes('ворота 2');
        if (!isFacade1 && !isFacade2) return cam;

        const ch: 1 | 2 = isFacade2 ? 2 : 1;
        const acId = ch === 1 ? '990001' : '990002';
        const entId = ch === 1 ? 'esp32_gate_1' : 'esp32_gate_2';
        const lockId = `${cam.placeId || defaultPlace?.id || '1'}_esp32_gate_${ch}`;

        if (
          !syncedLocks.some(
            (l) =>
              l.id === lockId ||
              l.externalCameraId === cam.id ||
              l.entranceId === entId ||
              l.esp32Channel === ch
          )
        ) {
          syncedLocks.push({
            id: lockId,
            placeId: cam.placeId || defaultPlace?.id || '1',
            placeAddress: cam.placeAddress || defaultPlace?.address || 'Мой дом',
            accessControlId: acId,
            entranceId: entId,
            acName: `Ворота №${ch}`,
            name: originalName,
            openable: true,
            allowVideo: true,
            externalCameraId: cam.id,
            hidden: false,
            favorite: true,
            kind: 'gate',
            controllerType: 'esp32',
            esp32Channel: ch,
          });
        }

        return {
          ...cam,
          allowOpen: true,
          accessControlId: cam.accessControlId || acId,
          entranceId: cam.entranceId || entId,
        };
      });

      setPlaces(syncedPlaces);
      setBalances(data.balances || {});
      setLocks(syncedLocks);
      setCameras(syncedCameras);
      setDndByPlace(data.dnd || {});

      if (syncedCameras.length > 0) {
        setSelectedVideoCameraId((prev) =>
          prev && syncedCameras.some((c) => c.id === prev) ? prev : syncedCameras[0].id
        );
      }
      setSnapshotRefreshTick((t) => t + 1);

      const primaryAddr = syncedPlaces[0]?.address || '';
      apiGetBillingMe(activeSession, primaryAddr)
        .then((bm) => {
          setBillingMe(bm);
          if (bm.user.status === 'expired' || bm.user.status === 'blocked') {
            setPlaceHistory([]);
            setPlaceHistoryHasMore(false);
          }
        })
        .catch(() => {
          // non-fatal
        });

      apiGetEsp32Status(activeSession)
        .then((st) => {
          setEsp32Status(st);
          setEsp32HttpUrlInput(st.config.gate1HttpUrl || '');
          setEsp32PulseMsInput(String(st.config.pulseDurationMs || 600));
          setEsp32Ch1PinInput(String(st.config.gpioGate1Pin || 18));
          setEsp32Ch2PinInput(String(st.config.gpioGate2Pin || 19));
          setEsp32SecretInput(st.config.deviceToken || '');
        })
        .catch(() => {
          // non-fatal
        });

      const pIds = (data.places || []).map((p) => p.id).filter(Boolean);
      if (pIds.length > 0) {
        apiGetPlaceHistoryPage(activeSession, pIds, 0)
          .then((histPage) => {
            setPlaceHistory(histPage.events);
            setPlaceHistoryPage(0);
            setPlaceHistoryHasMore(histPage.hasMore);
          })
          .catch(() => {
            setPlaceHistory([]);
            setPlaceHistoryPage(0);
            setPlaceHistoryHasMore(false);
          });
      } else {
        setPlaceHistory([]);
        setPlaceHistoryPage(0);
        setPlaceHistoryHasMore(false);
      }
    } catch (err: any) {
      if (err?.message === 'UNAUTHORIZED') {
        saveSession(null);
        setSession(null);
      } else {
        setSyncError(err?.message || 'Ошибка синхронизации данных');
      }
    } finally {
      setSyncLoading(false);
    }
  }, []);

  const refreshBillingMe = useCallback(() => {
    if (!session) return;
    apiGetBillingMe(session, places[0]?.address || '')
      .then((bm) => {
        setBillingMe(bm);
        if (bm.user.status === 'expired' || bm.user.status === 'blocked') {
          setPlaceHistory([]);
          setPlaceHistoryHasMore(false);
        }
      })
      .catch(() => {
        // ignore
      });
  }, [session, places]);

  useEffect(() => {
    if (!session || session.mode !== 'live') return;
    const handleRestrictedEvent = (ev: Event) => {
      const detail = (ev as CustomEvent)?.detail;
      const nextStatus =
        detail?.status === 'blocked' || detail?.status === 'expired'
          ? detail.status
          : 'blocked';
      setBillingMe((prev) =>
        prev
          ? {
              ...prev,
              user: { ...prev.user, status: nextStatus },
            }
          : prev
      );
      setPlaceHistory([]);
      setPlaceHistoryHasMore(false);
      refreshBillingMe();
    };
    const handleFocusOrVisible = () => {
      if (document.visibilityState === 'hidden') return;
      refreshBillingMe();
    };
    window.addEventListener('eg-subscription-restricted', handleRestrictedEvent);
    window.addEventListener('focus', handleFocusOrVisible);
    document.addEventListener('visibilitychange', handleFocusOrVisible);
    const timer = setInterval(() => {
      refreshBillingMe();
    }, 20000);
    return () => {
      window.removeEventListener('eg-subscription-restricted', handleRestrictedEvent);
      window.removeEventListener('focus', handleFocusOrVisible);
      document.removeEventListener('visibilitychange', handleFocusOrVisible);
      clearInterval(timer);
    };
  }, [session, refreshBillingMe]);

  const handleRenewSubscription = async () => {
    if (!session || billingBusy) return;
    setBillingBusy(true);
    try {
      const updated = await apiRenewSubscription(session, places[0]?.address || '');
      setBillingMe(updated);
      showNotice(`Подписка продлена на 30 дней (-${updated.config.monthlyPriceRub} ₽)`);
    } catch (err: any) {
      showNotice(err?.message || 'Не удалось продлить подписку');
    } finally {
      setBillingBusy(false);
    }
  };

  const handleRequestTopup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || billingBusy) return;
    if (session.mode === 'demo') {
      showNotice('В демо-режиме онлайн-оплата отключена. Войдите по номеру телефона.');
      return;
    }
    const amount = Number(topupAmountInput.replace(',', '.'));
    if (!Number.isFinite(amount) || amount < 10) {
      showNotice('Минимальная сумма пополнения — 10 ₽');
      return;
    }
    setBillingBusy(true);
    try {
      const res = await apiCreateYookassaPayment(session, amount, {
        comment: topupCommentInput.trim() || undefined,
        address: places[0]?.address || '',
      });
      setBillingMe(res);
      setTopupCommentInput('');
      if (res.mode === 'yookassa_redirect' && res.confirmationUrl) {
        showNotice('Переход на защищённую страницу оплаты ЮKassa...');
        window.location.assign(res.confirmationUrl);
        return;
      }
      showNotice(
        `Заявка на ${amount} ₽ создана (ключ ЮKassa не задан на сервере — ожидает подтверждения)`
      );
    } catch (err: any) {
      showNotice(err?.message || 'Ошибка создания платежа ЮKassa');
    } finally {
      setBillingBusy(false);
    }
  };

  const handleCheckPendingPayments = async (txId?: string) => {
    if (!session || session.mode === 'demo' || billingBusy) return;
    setBillingBusy(true);
    try {
      const res = await apiCheckYookassaPayment(session, txId);
      setBillingMe(res);
      if (res.updatedCount > 0) {
        showNotice('Оплата через ЮKassa подтверждена и зачислена на баланс');
      } else {
        showNotice('Платёж ещё обрабатывается или не оплачен');
      }
    } catch (err: any) {
      showNotice(err?.message || 'Ошибка проверки статуса платежа');
    } finally {
      setBillingBusy(false);
    }
  };

  const handleToggleBillingAutoRenew = async () => {
    if (!session || !billingMe || billingBusy) return;
    setBillingBusy(true);
    try {
      const updated = await apiSetBillingAutoRenew(session, !billingMe.user.autoRenew);
      setBillingMe(updated);
      showNotice(
        updated.user.autoRenew ? 'Автопродление подписки включено' : 'Автопродление отключено'
      );
    } catch (err: any) {
      showNotice(err?.message || 'Ошибка настройки автопродления');
    } finally {
      setBillingBusy(false);
    }
  };

  // Detect return from YuKassa checkout (?payment=return&txId=...)
  useEffect(() => {
    if (!session || session.mode === 'demo' || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('payment') !== 'return') return;

    const txId = params.get('txId') || '';
    setActiveSection('settings');
    params.delete('payment');
    params.delete('txId');
    const cleanSearch = params.toString();
    const cleanUrl = `${window.location.pathname}${cleanSearch ? `?${cleanSearch}` : ''}`;
    window.history.replaceState({}, '', cleanUrl);

    apiCheckYookassaPayment(session, txId)
      .then((res) => {
        setBillingMe(res);
        if (res.updatedCount > 0) {
          showNotice('Оплата через ЮKassa успешно зачислена!');
        } else {
          showNotice('Статус платежа ЮKassa обновлён');
        }
      })
      .catch(() => {
        // ignore check error
      });
  }, [session, showNotice]);

  // Enforce strict owner-only UI guard for Admin section
  useEffect(() => {
    if (activeSection === 'admin' && billingMe && billingMe.user?.role !== 'admin') {
      setActiveSection('overview');
    }
  }, [activeSection, billingMe]);

  const handleLoadMoreHistory = useCallback(async () => {
    if (!session || placeHistoryLoadingMore || !placeHistoryHasMore) return;
    const pIds = places.map((p) => p.id).filter(Boolean);
    if (pIds.length === 0) return;

    setPlaceHistoryLoadingMore(true);
    try {
      const nextPage = placeHistoryPage + 1;
      const histPage = await apiGetPlaceHistoryPage(session, pIds, nextPage);
      setPlaceHistory((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        const merged = [...prev];
        for (const ev of histPage.events) {
          if (!seen.has(ev.id)) {
            seen.add(ev.id);
            merged.push(ev);
          }
        }
        return merged;
      });
      setPlaceHistoryPage(nextPage);
      setPlaceHistoryHasMore(histPage.hasMore);
    } finally {
      setPlaceHistoryLoadingMore(false);
    }
  }, [session, places, placeHistoryPage, placeHistoryHasMore, placeHistoryLoadingMore]);

  useEffect(() => {
    if (session) {
      handleSync(session);
    }
  }, [session, handleSync]);

  // Snapshot auto-refresh interval
  useEffect(() => {
    if (!session || autoRefreshSec <= 0) return;
    const interval = setInterval(() => {
      setSnapshotRefreshTick((t) => t + 1);
    }, autoRefreshSec * 1000);
    return () => clearInterval(interval);
  }, [session, autoRefreshSec]);

  const getLinkedCameraForLock = useCallback(
    (lock: LockItem): CameraItem | null => {
      return (
        cameras.find(
          (c) =>
            (lock.externalCameraId && c.id === lock.externalCameraId) ||
            (lock.entranceId &&
              c.entranceId === lock.entranceId &&
              c.placeId === lock.placeId) ||
            (!lock.entranceId &&
              lock.accessControlId &&
              c.accessControlId === lock.accessControlId &&
              c.placeId === lock.placeId)
        ) || null
      );
    },
    [cameras]
  );

  // Filtered locks and cameras by selected place
  const filteredLocks = useMemo(() => {
    return locks.filter((l) => {
      if (selectedPlaceId !== 'all' && l.placeId !== selectedPlaceId) return false;
      if (lockFilter !== 'all') {
        const nameLower = l.name.toLowerCase();
        const inferredKind =
          l.kind ||
          (nameLower.includes('шлагбаум') || nameLower.includes('ворот')
            ? 'barrier'
            : nameLower.includes('калитк')
            ? 'gate'
            : 'door');
        if (inferredKind !== lockFilter) return false;
      }
      if (lockSearch.trim()) {
        const q = lockSearch.toLowerCase();
        const linkedCam = getLinkedCameraForLock(l);
        if (
          !l.name.toLowerCase().includes(q) &&
          !(linkedCam && linkedCam.name.toLowerCase().includes(q)) &&
          !l.acName.toLowerCase().includes(q) &&
          !l.placeAddress.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [locks, selectedPlaceId, lockFilter, lockSearch, getLinkedCameraForLock]);

  const handleToggleCameraFavorite = useCallback(
    (camera: CameraItem) => {
      const currentFav = favoriteCameraMap[camera.id] ?? Boolean(camera.favorite);
      const nextFav = !currentFav;
      setFavoriteCameraMap((prev) => {
        const next = { ...prev, [camera.id]: nextFav };
        try {
          window.localStorage.setItem('plumix_favorite_cameras_v1', JSON.stringify(next));
        } catch {
          // ignore storage quota errors
        }
        return next;
      });
      setCameras((prev) =>
        prev.map((c) => (c.id === camera.id ? { ...c, favorite: nextFav } : c))
      );
      showNotice(
        nextFav
          ? `Камера «${camera.name}» добавлена в избранное ★`
          : `Камера «${camera.name}» убрана из избранного`
      );
    },
    [favoriteCameraMap, showNotice]
  );

  const handleRenameCamera = useCallback(
    async (camera: CameraItem, rawNewName: string) => {
      if (!session) return;
      try {
        const res = await apiRenameCamera(session, camera.id, rawNewName);
        const fallbackOriginal = camera.originalName || camera.name;
        const nextDisplayName = res.alias || fallbackOriginal;
        setCameras((prev) =>
          prev.map((c) =>
            c.id === camera.id
              ? {
                  ...c,
                  originalName: c.originalName || c.name,
                  name: nextDisplayName,
                }
              : c
          )
        );
        setLightboxCamera((prev) =>
          prev && prev.camera.id === camera.id
            ? {
                ...prev,
                camera: {
                  ...prev.camera,
                  originalName: prev.camera.originalName || prev.camera.name,
                  name: nextDisplayName,
                },
              }
            : prev
        );
        showNotice(
          res.alias
            ? `Камера переименована в «${res.alias}»`
            : `Восстановлено название «${fallbackOriginal}»`
        );
      } catch (err: any) {
        showNotice(err?.message || 'Не удалось переименовать камеру');
        throw err;
      }
    },
    [session, showNotice]
  );

  const hiddenCamerasCount = useMemo(() => {
    return cameras.filter((c) => {
      if (selectedPlaceId !== 'all' && c.placeId !== selectedPlaceId) return false;
      return Boolean(c.hidden);
    }).length;
  }, [cameras, selectedPlaceId]);

  // All cameras for the selected place (used in Overview & Video Archive regardless of Cameras tab filter)
  const placeVisibleCameras = useMemo(() => {
    return cameras
      .map((c) => ({
        ...c,
        favorite: favoriteCameraMap[c.id] ?? Boolean(c.favorite),
      }))
      .filter((c) => {
        if (selectedPlaceId !== 'all' && c.placeId !== selectedPlaceId) return false;
        if (!showHiddenCameras && c.hidden) return false;
        return true;
      });
  }, [cameras, favoriteCameraMap, selectedPlaceId, showHiddenCameras]);

  // Filtered cameras specifically for the "Камеры" tab
  const filteredCameras = useMemo(() => {
    return placeVisibleCameras.filter((c) => {
      if (cameraSourceFilter === 'favorite') {
        if (!c.favorite) return false;
      } else if (cameraSourceFilter === 'intercom') {
        const isEntryOrGate =
          c.source === 'intercom' ||
          Boolean(c.allowOpen) ||
          Boolean(c.entranceId?.startsWith('esp32_gate_')) ||
          locks.some((l) => l.externalCameraId === c.id && l.openable);
        if (!isEntryOrGate) return false;
      } else if (cameraSourceFilter !== 'all' && c.source !== cameraSourceFilter) {
        return false;
      }
      if (cameraSearch.trim()) {
        const q = cameraSearch.toLowerCase();
        if (
          !c.name.toLowerCase().includes(q) &&
          !(c.originalName && c.originalName.toLowerCase().includes(q)) &&
          !c.id.toLowerCase().includes(q) &&
          !c.placeAddress.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [placeVisibleCameras, cameraSourceFilter, cameraSearch, locks]);

  const activeVideoCamera = useMemo(() => {
    return (
      placeVisibleCameras.find((c) => c.id === selectedVideoCameraId) ||
      placeVisibleCameras[0] ||
      cameras[0] ||
      null
    );
  }, [placeVisibleCameras, cameras, selectedVideoCameraId]);

  const getLinkedLockForCamera = useCallback(
    (cam: CameraItem | null): LockItem | null => {
      if (!cam) return null;
      return (
        locks.find(
          (l) =>
            l.externalCameraId === cam.id ||
            (cam.entranceId && l.entranceId === cam.entranceId && l.placeId === cam.placeId) ||
            (cam.accessControlId &&
              l.accessControlId === cam.accessControlId &&
              !l.entranceId &&
              l.placeId === cam.placeId)
        ) || null
      );
    },
    [locks]
  );

  // Load camera archive motion events (page 1) when camera or archiveDay changes
  useEffect(() => {
    if (!session || !activeVideoCamera) return;
    if (isSubscriptionRestricted) {
      setCameraEvents([]);
      setEventsHasMore(false);
      setEventsLoading(false);
      return;
    }
    let cancelled = false;
    const seekTarget =
      pendingSeekTargetRef.current &&
      pendingSeekTargetRef.current.cameraId === activeVideoCamera.id &&
      pendingSeekTargetRef.current.day === archiveDay
        ? pendingSeekTargetRef.current
        : null;
    if (seekTarget) {
      pendingSeekTargetRef.current = null;
    }

    setEventsLoading(true);
    setEventsHasMore(false);

    const latestPagePromise = apiGetCameraEvents(
      session,
      activeVideoCamera.id,
      activeVideoCamera.placeId,
      archiveDay,
      { count: 100 }
    );

    const targetedPagePromise = seekTarget
      ? apiGetCameraEvents(session, activeVideoCamera.id, activeVideoCamera.placeId, archiveDay, {
          upperTimestampSec: seekTarget.tsSec + 90,
          count: 40,
        }).catch(() => ({ events: [] as CameraEventItem[], hasMore: false }))
      : Promise.resolve(null);

    Promise.all([latestPagePromise, targetedPagePromise])
      .then(([page, targetedPage]) => {
        if (cancelled) return;

        let mergedEvents = page.events;
        if (targetedPage && targetedPage.events.length > 0) {
          const seen = new Set(mergedEvents.map((e) => e.id));
          mergedEvents = [...mergedEvents];
          for (const ev of targetedPage.events) {
            if (!seen.has(ev.id)) {
              seen.add(ev.id);
              mergedEvents.push(ev);
            }
          }
          mergedEvents.sort((a, b) => b.timestamp - a.timestamp);
        }

        setCameraEvents(mergedEvents);
        setEventsHasMore(page.hasMore);
      })
      .catch(() => {
        if (!cancelled) {
          setCameraEvents([]);
          setEventsHasMore(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setEventsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [session, activeVideoCamera, archiveDay, isSubscriptionRestricted]);

  // Load earlier events down to 00:00 when user scrolls to bottom of events list
  const loadMoreCameraEvents = useCallback(async () => {
    if (!session || !activeVideoCamera || eventsLoading || eventsLoadingMore || !eventsHasMore) {
      return;
    }
    if (cameraEvents.length === 0) return;

    const oldestEvent = cameraEvents[cameraEvents.length - 1];
    const dayStartSec = Math.floor(new Date(`${archiveDay}T00:00:00`).getTime() / 1000);
    if (oldestEvent.timestamp <= dayStartSec) {
      setEventsHasMore(false);
      return;
    }

    setEventsLoadingMore(true);
    try {
      const existingIds = new Set(cameraEvents.map((e) => e.id));
      let page = await apiGetCameraEvents(
        session,
        activeVideoCamera.id,
        activeVideoCamera.placeId,
        archiveDay,
        { upperTimestampSec: oldestEvent.timestamp, count: 100 }
      );

      let uniqueNew = page.events.filter((e) => !existingIds.has(e.id));

      // If all returned events overlapped at the exact boundary timestamp, step 1 second earlier
      if (uniqueNew.length === 0 && page.hasMore && oldestEvent.timestamp - 1 > dayStartSec) {
        page = await apiGetCameraEvents(
          session,
          activeVideoCamera.id,
          activeVideoCamera.placeId,
          archiveDay,
          { upperTimestampSec: oldestEvent.timestamp - 1, count: 100 }
        );
        uniqueNew = page.events.filter((e) => !existingIds.has(e.id));
      }

      if (uniqueNew.length > 0) {
        setCameraEvents((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          const merged = [...prev];
          for (const item of uniqueNew) {
            if (!seen.has(item.id)) {
              seen.add(item.id);
              merged.push(item);
            }
          }
          merged.sort((a, b) => b.timestamp - a.timestamp);
          return merged;
        });
        setEventsHasMore(page.hasMore);
      } else {
        setEventsHasMore(false);
      }
    } catch {
      // Keep current list on transient network error so user can retry scroll/click
    } finally {
      setEventsLoadingMore(false);
    }
  }, [
    session,
    activeVideoCamera,
    eventsLoading,
    eventsLoadingMore,
    eventsHasMore,
    cameraEvents,
    archiveDay,
  ]);

  const currentPlaceForSettings = useMemo(() => {
    if (selectedPlaceId !== 'all') return selectedPlaceId;
    return places[0]?.id || '';
  }, [selectedPlaceId, places]);

  const getLinkedCameraForPassControl = useCallback(
    (ac: GuestPassControlOption, placeId?: string): CameraItem | null => {
      const targetPlaceId = placeId || currentPlaceForSettings;
      return (
        cameras.find(
          (c) =>
            (ac.cameraId && c.id === ac.cameraId) ||
            (ac.entranceId &&
              c.entranceId === ac.entranceId &&
              (!targetPlaceId || String(c.placeId) === String(targetPlaceId))) ||
            (!ac.entranceId &&
              c.accessControlId &&
              String(c.accessControlId) === String(ac.id) &&
              (!targetPlaceId || String(c.placeId) === String(targetPlaceId)))
        ) || null
      );
    },
    [cameras, currentPlaceForSettings]
  );

  useEffect(() => {
    if (!session || activeSection !== 'access' || !currentPlaceForSettings || isSubscriptionRestricted) return;
    let cancelled = false;
    setPassesLoading(true);
    apiGetTempPasses(session, currentPlaceForSettings)
      .then((res) => {
        if (cancelled) return;
        setTempPasses(res.passes);
        const placeLocksFallback: GuestPassControlOption[] = locks
          .filter((l) => String(l.placeId) === String(currentPlaceForSettings) && l.openable)
          .map((l) => {
            const linkedCam = getLinkedCameraForLock(l);
            return {
              id: Number(l.accessControlId),
              name: linkedCam?.name || l.name,
              entranceId: l.entranceId,
              cameraId: linkedCam?.id || l.externalCameraId || null,
            };
          });
        const acList =
          res.availableAccessControls.length > 0
            ? res.availableAccessControls
            : placeLocksFallback;
        setTempPassAcs(acList);
        if (acList.length > 0) {
          const allKeys = acList.map((a) => `${a.id}:${a.entranceId || ''}`);
          setSelectedPassControlKeys((prev) => {
            const validPrev = prev.filter((k) => allKeys.includes(k));
            return validPrev.length > 0 ? validPrev : allKeys;
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTempPasses([]);
        }
      })
      .finally(() => {
        if (!cancelled) setPassesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, activeSection, currentPlaceForSettings, locks, isSubscriptionRestricted]);

  // Open door / gate / barrier handler
  const handleOpenLock = useCallback(
    async (lock: LockItem) => {
      if (!session || unlockingMap[lock.id]) return;
      if (isSubscriptionRestricted) {
        showNotice('При неоплаченной или заблокированной подписке доступен только онлайн-просмотр камер');
        return;
      }

      const linkedCam = getLinkedCameraForLock(lock);
      const displayLockName = linkedCam?.name || lock.name;

      if (lock.externalCameraId) {
        setSelectedVideoCameraId(lock.externalCameraId);
        setVideoPlaybackMode('live');
      }

      setUnlockingMap((prev) => ({ ...prev, [lock.id]: true }));
      try {
        await apiOpenLock(session, {
          placeId: lock.placeId,
          accessControlId: lock.accessControlId,
          entranceId: lock.entranceId,
        });
        setUnlockedMap((prev) => ({ ...prev, [lock.id]: true }));
        setTimeout(() => {
          setUnlockedMap((prev) => ({ ...prev, [lock.id]: false }));
        }, 3500);

        playGlobalDoorOpenSound(1.0, false);

        const logEntry: DoorActionLog = {
          id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          lockId: lock.id,
          lockName: displayLockName,
          placeAddress: lock.placeAddress,
          timestamp: Date.now(),
          status: 'success',
          message: 'Команда выполнена',
        };
        setDoorLogs((prev) => [logEntry, ...prev.slice(0, 19)]);
        showNotice(`Открыто: ${displayLockName}`);
      } catch (err: any) {
        const logEntry: DoorActionLog = {
          id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          lockId: lock.id,
          lockName: displayLockName,
          placeAddress: lock.placeAddress,
          timestamp: Date.now(),
          status: 'error',
          message: err?.message || 'Отказ оператора',
        };
        setDoorLogs((prev) => [logEntry, ...prev.slice(0, 19)]);
        showNotice(`Ошибка открытия «${displayLockName}»: ${err?.message || 'Сбой'}`);
      } finally {
        setUnlockingMap((prev) => ({ ...prev, [lock.id]: false }));
      }
    },
    [session, unlockingMap, showNotice, isSubscriptionRestricted, getLinkedCameraForLock]
  );

  // Quick actions for Overview ("Открыть дверь" & "Открыть ворота")
  const handleQuickOpenDoor = useCallback(() => {
    if (isSubscriptionRestricted) {
      showNotice('Открытие дверей заблокировано до оплаты или разблокировки подписки');
      return;
    }
    const primaryDoor =
      filteredLocks.find((l) => {
        const n = l.name.toLowerCase();
        return !n.includes('ворот') && !n.includes('шлагбаум');
      }) || filteredLocks[0];

    if (primaryDoor) {
      handleOpenLock(primaryDoor);
      return;
    }

    // Fallback instant feedback if account has no synced locks yet
    playGlobalDoorOpenSound(1.0, false);
    const logEntry: DoorActionLog = {
      id: `log_${Date.now()}`,
      lockId: 'virtual_door',
      lockName: 'Входная дверь',
      placeAddress: places[0]?.address || 'Мой дом',
      timestamp: Date.now(),
      status: 'success',
      message: 'Открыта входная дверь',
    };
    setDoorLogs((prev) => [logEntry, ...prev.slice(0, 19)]);
    showNotice('Входная дверь открыта');
  }, [filteredLocks, handleOpenLock, places, showNotice, isSubscriptionRestricted]);

  const handleQuickOpenGate = useCallback(() => {
    if (isSubscriptionRestricted) {
      showNotice('Открытие ворот заблокировано до оплаты или разблокировки подписки');
      return;
    }
    const primaryGate =
      filteredLocks.find((l) => {
        const n = l.name.toLowerCase();
        return n.includes('ворот') || n.includes('калитк') || n.includes('шлагбаум');
      }) ||
      filteredLocks[1] ||
      filteredLocks[0];

    if (primaryGate) {
      handleOpenLock(primaryGate);
      return;
    }

    playGlobalDoorOpenSound(1.0, false);
    const logEntry: DoorActionLog = {
      id: `log_${Date.now()}`,
      lockId: 'virtual_gate',
      lockName: 'Ворота',
      placeAddress: places[0]?.address || 'Мой дом',
      timestamp: Date.now(),
      status: 'success',
      message: 'Открыты ворота',
    };
    setDoorLogs((prev) => [logEntry, ...prev.slice(0, 19)]);
    showNotice('Ворота открыты');
  }, [filteredLocks, handleOpenLock, places, showNotice, isSubscriptionRestricted]);

  // Switch to video player for a specific camera (always resets archiveDay to today)
  const handleSelectCameraForVideo = useCallback(
    (camera: CameraItem, mode: 'live' | 'archive') => {
      const effectiveMode = isSubscriptionRestricted ? 'live' : mode;
      pendingSeekTargetRef.current = null;
      setSelectedVideoCameraId((prevId) => {
        if (prevId !== camera.id) {
          setCameraEvents([]);
        }
        return camera.id;
      });
      setArchiveDay(getRecentDays(1)[0]);
      setActiveEventId(null);
      setInitialClipSeekSec(0);
      if (effectiveMode === 'live') {
        setVideoPlaybackMode('live');
        setArchiveTimestampSec(null);
        setJumpTimeInput(formatUnixTime(Math.floor(Date.now() / 1000) - 300));
      } else {
        setVideoPlaybackMode('archive_stream');
        const defaultTs = Math.floor(Date.now() / 1000) - 300;
        setArchiveTimestampSec(defaultTs);
        setJumpTimeInput(formatUnixTime(defaultTs));
      }
      setActiveSection('video');
    },
    [isSubscriptionRestricted]
  );

  // Reset archive time & playback mode whenever user leaves the "Видеоархив" tab
  useEffect(() => {
    if (activeSection !== 'video') {
      setArchiveDay(getRecentDays(1)[0]);
      setArchiveTimestampSec(null);
      setActiveEventId(null);
      setInitialClipSeekSec(0);
      setVideoPlaybackMode('live');
      setJumpTimeInput(formatUnixTime(Math.floor(Date.now() / 1000) - 300));
    }
  }, [activeSection]);

  // Jump directly to a specific camera & timestamp in VideoArchive (used when clicking events)
  const openCameraArchiveAtTimestamp = useCallback(
    (camera: CameraItem, tsSec: number) => {
      if (isSubscriptionRestricted) {
        showNotice('Видеоархив недоступен без активной подписки');
        return;
      }
      const d = new Date(tsSec * 1000);
      const pad = (n: number) => String(n).padStart(2, '0');
      const dayStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

      const retentionDays = Math.max(1, Math.min(7, camera.retentionDays || 7));
      const allowedDays = getRecentDays(retentionDays);
      const oldestAllowedDay = allowedDays[allowedDays.length - 1];

      if (dayStr < oldestAllowedDay) {
        showNotice(
          `Архив камеры «${camera.name}» хранится ${retentionDays} дн. — запись за ${pad(d.getDate())}.${pad(d.getMonth() + 1)} недоступна`
        );
        return;
      }

      const startTs = Math.max(0, Math.floor(tsSec) - 5);
      pendingSeekTargetRef.current = {
        cameraId: camera.id,
        day: dayStr,
        tsSec: Math.floor(tsSec),
      };

      setSelectedVideoCameraId((prevId) => {
        if (prevId !== camera.id) {
          setCameraEvents([]);
        }
        return camera.id;
      });
      setInitialClipSeekSec(0);
      setArchiveDay(dayStr);
      setActiveEventId(null);
      setArchiveTimestampSec(startTs);
      setVideoPlaybackMode('archive_stream');
      setActiveSection('video');
    },
    [showNotice, isSubscriptionRestricted]
  );

  const handleOpenHistoryEvent = useCallback(
    (ev: HistoryEventItem) => {
      if (isSubscriptionRestricted) {
        showNotice('Просмотр архива событий недоступен без активной подписки');
        return;
      }
      if (cameras.length === 0) {
        showNotice('Нет доступных камер для просмотра записи');
        return;
      }

      const samePlaceCameras = cameras.filter((c) => c.placeId === ev.placeId);
      const pool = samePlaceCameras.length > 0 ? samePlaceCameras : cameras;

      let matchedCam: CameraItem | undefined;
      if (ev.cameraId) {
        matchedCam = pool.find((c) => c.id === ev.cameraId) || cameras.find((c) => c.id === ev.cameraId);
      }
      if (!matchedCam && ev.sourceType === 'CAMERA' && ev.sourceId) {
        matchedCam = pool.find((c) => c.id === ev.sourceId);
      }
      if (!matchedCam && ev.entranceId) {
        matchedCam = pool.find((c) => c.entranceId === ev.entranceId);
      }
      if (!matchedCam && ev.accessControlId) {
        matchedCam = pool.find((c) => c.accessControlId === ev.accessControlId);
      }
      if (!matchedCam) {
        const msgLower = ev.message.toLowerCase();
        const sortedByNameLen = [...pool].sort((a, b) => b.name.length - a.name.length);
        matchedCam = sortedByNameLen.find(
          (c) =>
            msgLower.includes(c.name.toLowerCase()) ||
            (c.originalName ? msgLower.includes(c.originalName.toLowerCase()) : false)
        );
      }
      if (!matchedCam) {
        const msgLower = ev.message.toLowerCase();
        if (msgLower.includes('калитк') || msgLower.includes('ворот')) {
          matchedCam = pool.find((c) => {
            const target = (c.originalName || c.name).toLowerCase();
            return target.includes('калитк') || target.includes('ворот');
          });
        }
      }
      if (!matchedCam) {
        matchedCam = pool.find((c) => c.source === 'intercom') || pool[0];
      }

      if (!matchedCam) {
        showNotice('Не удалось определить камеру для этого события');
        return;
      }

      const tsSec = ev.timestamp < 1e12 ? ev.timestamp : Math.floor(ev.timestamp / 1000);
      openCameraArchiveAtTimestamp(matchedCam, tsSec);
    },
    [cameras, openCameraArchiveAtTimestamp, showNotice, isSubscriptionRestricted]
  );

  const handleOpenDoorLog = useCallback(
    (log: DoorActionLog) => {
      if (isSubscriptionRestricted) {
        showNotice('Видеоархив недоступен без активной подписки');
        return;
      }
      if (cameras.length === 0) return;
      const lock = locks.find((l) => l.id === log.lockId);
      let matchedCam: CameraItem | undefined;
      if (lock?.externalCameraId) {
        matchedCam = cameras.find((c) => c.id === lock.externalCameraId);
      }
      if (!matchedCam && lock?.entranceId) {
        matchedCam = cameras.find(
          (c) => c.entranceId === lock.entranceId && c.placeId === lock.placeId
        );
      }
      if (!matchedCam && lock?.accessControlId) {
        matchedCam = cameras.find(
          (c) => c.accessControlId === lock.accessControlId && c.placeId === lock.placeId
        );
      }
      if (!matchedCam) {
        const lockLower = log.lockName.toLowerCase();
        matchedCam =
          cameras.find(
            (c) =>
              c.name.toLowerCase().includes(lockLower) ||
              (c.originalName ? c.originalName.toLowerCase().includes(lockLower) : false)
          ) || cameras[0];
      }
      if (!matchedCam) return;
      const tsSec = log.timestamp < 1e12 ? log.timestamp : Math.floor(log.timestamp / 1000);
      openCameraArchiveAtTimestamp(matchedCam, tsSec);
    },
    [cameras, locks, openCameraArchiveAtTimestamp, showNotice, isSubscriptionRestricted]
  );

  const findMatchingEventForTs = useCallback(
    (targetTs: number, pool: CameraEventItem[] = cameraEvents, maxDiffSec = 0) => {
      if (pool.length === 0) return null;
      let best: CameraEventItem | null = null;
      let bestDiff = Infinity;
      for (const ev of pool) {
        const endTs = ev.timestamp + Math.max(20, ev.duration || 30);
        if (targetTs >= ev.timestamp - 5 && targetTs <= endTs + 5) {
          return ev;
        }
        if (maxDiffSec > 0) {
          const diff = Math.abs(ev.timestamp - targetTs);
          if (diff <= maxDiffSec && diff < bestDiff) {
            best = ev;
            bestDiff = diff;
          }
        }
      }
      return best;
    },
    [cameraEvents]
  );

  // Sync time-jump input when jumping via slider, event click, or reset
  useEffect(() => {
    if (archiveTimestampSec != null && Number.isFinite(archiveTimestampSec)) {
      setJumpTimeInput(formatUnixTime(archiveTimestampSec));
    } else {
      setJumpTimeInput(formatUnixTime(Math.floor(Date.now() / 1000) - 300));
    }
  }, [archiveTimestampSec]);

  const nearestEventForArchive = useMemo(() => {
    if (cameraEvents.length === 0) return null;
    if (archiveTimestampSec == null) return cameraEvents[0];
    let best = cameraEvents[0];
    let bestDiff = Math.abs(best.timestamp - archiveTimestampSec);
    for (const ev of cameraEvents) {
      const diff = Math.abs(ev.timestamp - archiveTimestampSec);
      if (diff < bestDiff) {
        best = ev;
        bestDiff = diff;
      }
    }
    return best;
  }, [cameraEvents, archiveTimestampSec]);

  const parseArchiveJumpTimestamp = useCallback((): number | null => {
    const cleaned = jumpTimeInput.trim();
    const parts = cleaned.split(':');
    if (parts.length < 2) return null;
    const hh = parseInt(parts[0], 10);
    const mm = parseInt(parts[1], 10);
    const ss = parts.length >= 3 ? parseInt(parts[2], 10) : 0;
    if (
      !Number.isFinite(hh) ||
      !Number.isFinite(mm) ||
      !Number.isFinite(ss) ||
      hh < 0 ||
      hh > 23 ||
      mm < 0 ||
      mm > 59 ||
      ss < 0 ||
      ss > 59
    ) {
      return null;
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    const localDt = new Date(`${archiveDay}T${pad(hh)}:${pad(mm)}:${pad(ss)}`);
    if (Number.isNaN(localDt.getTime())) return null;
    return Math.floor(localDt.getTime() / 1000);
  }, [archiveDay, jumpTimeInput]);

  const fetchAndMergeEventsAroundTs = useCallback(
    async (cam: CameraItem, dayStr: string, targetTs: number): Promise<CameraEventItem[]> => {
      if (!session) return cameraEvents;
      const oldestLoaded =
        cameraEvents.length > 0 ? cameraEvents[cameraEvents.length - 1].timestamp : Infinity;
      const alreadyCovered =
        cameraEvents.length > 0 &&
        targetTs >= oldestLoaded - 60 &&
        cameraEvents.some((ev) => Math.abs(ev.timestamp - targetTs) <= 600);
      if (alreadyCovered) {
        return cameraEvents;
      }
      try {
        const page = await apiGetCameraEvents(session, cam.id, cam.placeId, dayStr, {
          upperTimestampSec: targetTs + 300,
          count: 60,
        });
        if (!page.events || page.events.length === 0) {
          return cameraEvents;
        }
        const seen = new Set(cameraEvents.map((e) => e.id));
        const merged = [...cameraEvents];
        for (const ev of page.events) {
          if (!seen.has(ev.id)) {
            seen.add(ev.id);
            merged.push(ev);
          }
        }
        merged.sort((a, b) => b.timestamp - a.timestamp);
        setCameraEvents(merged);
        return merged;
      } catch {
        return cameraEvents;
      }
    },
    [session, cameraEvents]
  );

  const handleJumpToArchiveTime = useCallback(
    async (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      if (isSubscriptionRestricted) {
        showNotice('Видеоархив недоступен без активной подписки');
        return;
      }
      if (!activeVideoCamera) return;
      const rawTargetTs = parseArchiveJumpTimestamp();
      if (rawTargetTs == null) {
        showNotice('Укажите время в формате ЧЧ:ММ или ЧЧ:ММ:СС');
        return;
      }

      const nowLimit = Math.floor(Date.now() / 1000) - 5;
      let targetTs = rawTargetTs;
      if (targetTs > nowLimit) {
        targetTs = Math.max(0, nowLimit - 10);
        setJumpTimeInput(formatUnixTime(targetTs));
        showNotice(
          `Указанное время ещё не наступило — открыт последний доступный момент (${formatUnixTime(targetTs)})`
        );
      }

      setPlayerSeekNonce((n) => n + 1);

      // Background-load events around this time for the list below, but ALWAYS play the exact requested DVR timestamp
      void fetchAndMergeEventsAroundTs(activeVideoCamera, archiveDay, targetTs);

      setInitialClipSeekSec(0);
      setArchiveTimestampSec(targetTs);
      setActiveEventId(null);
      setVideoPlaybackMode('archive_stream');
    },
    [
      activeVideoCamera,
      archiveDay,
      parseArchiveJumpTimestamp,
      fetchAndMergeEventsAroundTs,
      showNotice,
      isSubscriptionRestricted,
    ]
  );

  const handleDownloadCustomClip = useCallback(async () => {
    if (!session || !activeVideoCamera || downloadingCustomClip) return;
    if (isSubscriptionRestricted) {
      showNotice('Скачивание записей архива недоступно без активной подписки');
      return;
    }
    const rawTargetTs = parseArchiveJumpTimestamp();
    const startTs =
      rawTargetTs ??
      archiveTimestampSec ??
      Math.floor(Date.now() / 1000) - 300;
    const nowLimit = Math.floor(Date.now() / 1000) - 5;
    if (startTs > nowLimit) {
      showNotice('Нельзя скачать фрагмент из будущего времени');
      return;
    }

    setDownloadingCustomClip(true);
    showNotice(
      `Подготовка MP4 (${formatUnixTime(startTs)} – ${formatUnixTime(startTs + clipDownloadDurationSec)})...`
    );
    try {
      const filename = await downloadArchiveVideoMp4(session, {
        eventId: null,
        cameraId: activeVideoCamera.id,
        placeId: activeVideoCamera.placeId,
        timestampSec: startTs,
        durationSec: clipDownloadDurationSec,
        tz: activeVideoCamera.timeZone || 25200,
      });
      showNotice(`Видео сохранено: ${filename}`);
    } catch (err: any) {
      showNotice(err?.message || 'Не удалось скачать видео за указанное время');
    } finally {
      setDownloadingCustomClip(false);
    }
  }, [
    session,
    activeVideoCamera,
    downloadingCustomClip,
    parseArchiveJumpTimestamp,
    archiveTimestampSec,
    clipDownloadDurationSec,
    showNotice,
    isSubscriptionRestricted,
  ]);

  const handleToggleDnd = async (placeId: string, itemType: string) => {
    if (!session) return;
    if (isSubscriptionRestricted) {
      showNotice('Настройка режима «Не беспокоить» заблокирована без активной подписки');
      return;
    }
    const currentList = dndByPlace[placeId] || [];
    const updated = currentList.map((item) =>
      item.type === itemType ? { ...item, status: !item.status } : item
    );
    setDndByPlace((prev) => ({ ...prev, [placeId]: updated }));
    try {
      await apiUpdateDnd(session, placeId, updated);
      showNotice('Настройки режима «Не беспокоить» сохранены');
    } catch (err: any) {
      setDndByPlace((prev) => ({ ...prev, [placeId]: currentList }));
      showNotice(err?.message || 'Не удалось сохранить настройки режима «Не беспокоить»');
    }
  };

  const handleCreatePass = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || !currentPlaceForSettings) return;
    if (isSubscriptionRestricted) {
      showNotice('Создание гостевых ссылок заблокировано без активной подписки');
      return;
    }
    const chosenControls = tempPassAcs.filter((ac) =>
      selectedPassControlKeys.includes(`${ac.id}:${ac.entranceId || ''}`)
    );
    const rawControls = chosenControls.length > 0 ? chosenControls : tempPassAcs;
    const controlsToSend: GuestPassControlOption[] = rawControls.map((ac) => {
      const matchedCam = getLinkedCameraForPassControl(ac, currentPlaceForSettings);
      return {
        ...ac,
        name: matchedCam?.name || ac.name,
        cameraId: matchedCam?.id || ac.cameraId || null,
      };
    });
    const targetAcIds = Array.from(
      new Set(
        controlsToSend.map((c) => Number(c.id)).filter((n) => Number.isFinite(n) && n > 0)
      )
    );

    setPassesLoading(true);
    try {
      const created = await apiCreateTempPass(
        session,
        currentPlaceForSettings,
        selectedTtl,
        targetAcIds,
        {
          accessControls: controlsToSend,
          label: passLabel.trim() || undefined,
        }
      );
      setTempPasses((prev) => [created, ...prev]);
      setPassLabel('');
      showNotice('Личная гостевая ссылка создана');
    } catch (err: any) {
      showNotice(err?.message || 'Ошибка создания гостевого пропуска');
    } finally {
      setPassesLoading(false);
    }
  };

  const handleRevokePass = async (passId: string | number) => {
    if (!session || !currentPlaceForSettings) return;
    if (isSubscriptionRestricted) {
      showNotice('Управление гостевыми ссылками заблокировано без активной подписки');
      return;
    }
    try {
      await apiDeleteTempPass(session, currentPlaceForSettings, passId);
      setTempPasses((prev) => prev.filter((p) => String(p.id) !== String(passId)));
      showNotice('Гостевая ссылка отозвана');
    } catch (err: any) {
      showNotice(err?.message || 'Не удалось отозвать ссылку');
    }
  };

  const handleExitDemo = useCallback(() => {
    setProfileMenuOpen(false);
    const liveSaved = loadSavedSession();
    if (liveSaved && liveSaved.mode === 'live') {
      setSession(liveSaved);
      setShowWelcomePage(false);
      showNotice('Вы вернулись в свой аккаунт');
    } else {
      setSession(null);
      setShowWelcomePage(true);
    }
  }, [showNotice]);

  const handleLogout = () => {
    setProfileMenuOpen(false);
    saveSession(null);
    setSession(null);
    setShowWelcomePage(true);
  };

  const openPublicAboutRoute = useCallback(() => {
    setPublicAboutOpen(true);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('page', 'requisites');
      window.history.pushState({}, '', url.toString());
    }
  }, []);

  const closePublicAboutRoute = useCallback(() => {
    setPublicAboutOpen(false);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('page');
      if (url.pathname === '/requisites' || url.pathname === '/about') {
        url.pathname = '/';
      }
      window.history.pushState({}, '', url.toString());
    }
  }, []);

  if (!session || showWelcomePage) {
    if (publicAboutOpen) {
      return (
        <ServiceAboutPage
          standalone
          theme={theme}
          onToggleTheme={toggleTheme}
          onBackToLogin={closePublicAboutRoute}
          onNotice={showNotice}
        />
      );
    }

    const savedLiveSession =
      session?.mode === 'live' ? session : loadSavedSession();
    return (
      <>
        {activeGuestPassToken && (
          <GuestPassPortal
            token={activeGuestPassToken}
            onClose={() => setActiveGuestPassToken(null)}
          />
        )}
        <LoginScreen
          onAuthenticated={(newSession) => {
            if (typeof window !== 'undefined') {
              localStorage.setItem('domru_key_welcome_v3_minimal_seen', '1');
            }
            setSession(newSession);
            setShowWelcomePage(false);
          }}
          theme={theme}
          onToggleTheme={toggleTheme}
          existingSession={savedLiveSession}
          onOpenPublicAbout={openPublicAboutRoute}
          onResumeExistingSession={() => {
            if (typeof window !== 'undefined') {
              localStorage.setItem('domru_key_welcome_v3_minimal_seen', '1');
            }
            if (savedLiveSession) {
              setSession(savedLiveSession);
            }
            setShowWelcomePage(false);
          }}
        />
      </>
    );
  }

  // Extract first name (Имя), supporting both "Имя Фамилия" and "Фамилия Имя Отчество"
  const rawSubscriberName = session.subscriber?.name || '';
  const subscriberFirstName = (() => {
    const trimmed = rawSubscriberName.trim();
    if (!trimmed || trimmed.includes('Абонент')) return 'Пользователь';
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1) return parts[0];

    const looksLikePatronymic = (w: string) =>
      /(ович|евич|ич|овна|евна|ична|инична)$/i.test(w);
    const looksLikeSurname = (w: string) =>
      /(ов|ова|ев|ева|ёв|ёва|ин|ина|ын|ына|ский|ская|цкий|цкая|ой|ая|енко|чук|юк|дзе|швили|ян)$/i.test(w);

    if (parts.length >= 3) {
      return looksLikePatronymic(parts[1]) ? parts[0] : parts[1];
    }

    if (looksLikeSurname(parts[0]) && !looksLikeSurname(parts[1])) {
      return parts[1];
    }
    return parts[0];
  })();

  const activeCameraLinkedLock = getLinkedLockForCamera(activeVideoCamera);
  const availableRetentionDays = getRecentDays(
    Math.max(1, Math.min(7, activeVideoCamera?.retentionDays || 7))
  );

  const sidebarItems: Array<{
    id: ActiveSection;
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      id: 'overview',
      label: 'Обзор',
      icon: <Home className="w-[18px] h-[18px]" />,
    },
    {
      id: 'cameras',
      label: 'Камеры',
      icon: <CctvCameraIcon className="w-[18px] h-[18px]" />,
    },
    {
      id: 'video',
      label: 'Видеоархив',
      icon: <Archive className="w-[18px] h-[18px]" />,
    },
    {
      id: 'access',
      label: 'Управление доступом',
      icon: <DoorOutlineIcon className="w-[18px] h-[18px]" />,
    },
    {
      id: 'users',
      label: 'Пользователи',
      icon: <Users className="w-[18px] h-[18px]" />,
    },
    {
      id: 'settings',
      label: 'Настройки',
      icon: <Settings className="w-[18px] h-[18px]" />,
    },
    {
      id: 'about',
      label: 'О сервисе',
      icon: <Info className="w-[18px] h-[18px]" />,
    },
    ...(billingMe?.user?.role === 'admin'
      ? [
          {
            id: 'admin' as ActiveSection,
            label: 'Админ-панель',
            icon: <ShieldCheck className="w-[18px] h-[18px]" />,
          },
        ]
      : []),
  ];

  return (
    <div className="min-h-screen bg-[#f4f6f9] dark:bg-[#12161f] text-slate-900 dark:text-slate-100 flex transition-colors duration-200">
      {/* =================================================================== */}
      {/* LEFT SIDEBAR NAVIGATION (Matches Desktop Mockup 1:1)                */}
      {/* =================================================================== */}
      <aside className="hidden md:flex flex-col w-64 shrink-0 bg-white dark:bg-[#0f131a] border-r border-slate-200/80 dark:border-white/[0.06] select-none sticky top-0 h-screen">
        {/* Top Brand Logo */}
        <div className="h-16 px-6 flex items-center border-b border-slate-100 dark:border-white/[0.04]">
          <button
            type="button"
            onClick={() => setActiveSection('overview')}
            className="text-left cursor-pointer"
          >
            <DomRuLabLogo size="md" />
          </button>
        </div>

        {/* Navigation Menu */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {sidebarItems.map((item) => {
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveSection(item.id)}
                className={`w-full px-3.5 py-2.5 rounded-xl text-sm font-medium flex items-center gap-3 transition-all cursor-pointer ${
                  isActive
                    ? 'bg-gradient-to-r from-[#2563EB]/15 to-[#2563EB]/5 dark:from-[#2563EB]/25 dark:to-[#2563EB]/5 text-[#2563EB] dark:text-white font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.04] hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <span
                  className={
                    isActive
                      ? 'text-[#2563EB] dark:text-[#3B82F6]'
                      : 'text-slate-500 dark:text-slate-400'
                  }
                >
                  {item.icon}
                </span>
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Bottom Sidebar 1-Click Theme Switcher (Matches Mockup 1:1) */}
        <div className="p-4 border-t border-slate-100 dark:border-white/[0.04]">
          <button
            type="button"
            onClick={toggleTheme}
            aria-label="Переключить тему оформления"
            className="w-full flex items-center gap-3 px-2 py-1.5 rounded-xl hover:bg-slate-100/80 dark:hover:bg-white/[0.04] transition-colors cursor-pointer"
          >
            {/* Segmented Pill [ Sun | Moon ] */}
            <div className="inline-flex items-center p-1 rounded-full bg-slate-200/80 dark:bg-[#1c2230] border border-slate-300/60 dark:border-white/[0.08]">
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                  theme === 'light'
                    ? 'bg-white text-[#2563EB] shadow-sm'
                    : 'text-slate-400'
                }`}
              >
                <Sun className="w-3.5 h-3.5" />
              </span>
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                  theme === 'dark'
                    ? 'bg-[#2a3346] text-white shadow-sm'
                    : 'text-slate-500'
                }`}
              >
                <Moon className="w-3.5 h-3.5" />
              </span>
            </div>

            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
              {theme === 'dark' ? 'Тёмная тема' : 'Светлая тема'}
            </span>
          </button>
        </div>
      </aside>

      {/* =================================================================== */}
      {/* MAIN CONTENT SHELL                                                  */}
      {/* =================================================================== */}
      <div className="flex-1 flex flex-col min-w-0 pb-20 md:pb-0">
        {/* Top Header Bar (Matches Mockup 1:1) */}
        <header className="h-16 px-5 sm:px-8 border-b border-slate-200/80 dark:border-white/[0.06] bg-white/90 dark:bg-[#12161f]/90 backdrop-blur-md flex items-center justify-between gap-4 sticky top-0 z-30">
          {/* Left: Mobile Logo or Desktop Subtitle */}
          <div className="flex items-center gap-3">
            <div className="md:hidden">
              <DomRuLabLogo size="sm" />
            </div>
            <span className="hidden md:inline text-sm font-medium text-slate-500 dark:text-slate-300">
              Умные ворота и умный дом
            </span>
          </div>

          {/* Right: Demo Exit Button (when in demo) + Bell Icon + User Profile Pill */}
          <div className="flex items-center gap-2.5 sm:gap-3.5" ref={profileMenuRef}>
            {session.mode === 'demo' && (
              <button
                type="button"
                onClick={handleExitDemo}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#2563EB]/10 hover:bg-[#2563EB]/15 text-[#2563EB] dark:text-[#3B82F6] border border-[#2563EB]/25 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Выйти из демо</span>
                <span className="sm:hidden">Выйти</span>
              </button>
            )}

            {/* Mobile 1-click theme button */}
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Сменить тему"
              className="md:hidden p-2 rounded-full bg-slate-100 dark:bg-[#1c2331] text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-white/10 cursor-pointer"
            >
              {theme === 'dark' ? (
                <Sun className="w-4 h-4 text-amber-400" />
              ) : (
                <Moon className="w-4 h-4 text-slate-700" />
              )}
            </button>

            {/* Real Notifications Bell */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setNotificationsOpen((o) => !o)}
                aria-label="Уведомления"
                className="relative p-2 rounded-full text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
              >
                <Bell className="w-5 h-5" />
                {!isSubscriptionRestricted && (doorLogs.length > 0 || placeHistory.length > 0) && (
                  <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#2563EB] ring-2 ring-white dark:ring-[#12161f]" />
                )}
              </button>

              {notificationsOpen && (
                <div className="absolute right-0 mt-2 w-72 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/10 shadow-xl p-4 z-50 space-y-2.5 text-xs">
                  <div className="flex items-center justify-between font-bold text-slate-900 dark:text-white">
                    <span>Уведомления</span>
                    <button
                      type="button"
                      onClick={() => setNotificationsOpen(false)}
                      className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {isSubscriptionRestricted ? (
                    <div className="py-3 text-slate-400 text-center">
                      Уведомления и журнал недоступны без активной подписки
                    </div>
                  ) : doorLogs.length === 0 && placeHistory.length === 0 ? (
                    <div className="py-3 text-slate-400 text-center">
                      Новых уведомлений пока нет
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100 dark:divide-white/[0.06] space-y-1 max-h-64 overflow-y-auto">
                      {doorLogs.slice(0, 3).map((log) => (
                        <button
                          key={log.id}
                          type="button"
                          onClick={() => {
                            setNotificationsOpen(false);
                            handleOpenDoorLog(log);
                          }}
                          className="w-full text-left pt-2 first:pt-0 pb-1 hover:text-[#2563EB] dark:hover:text-[#3B82F6] transition-colors cursor-pointer"
                        >
                          <div className="font-medium text-slate-800 dark:text-slate-200 truncate">
                            {log.lockName}
                          </div>
                          <div className="text-slate-400 tabular-nums">
                            {formatUnixTime(Math.floor(log.timestamp / 1000))} · {log.message}
                          </div>
                        </button>
                      ))}
                      {placeHistory.slice(0, 12).map((ev) => (
                        <button
                          key={ev.id}
                          type="button"
                          onClick={() => {
                            setNotificationsOpen(false);
                            handleOpenHistoryEvent(ev);
                          }}
                          className="w-full text-left pt-2 first:pt-0 pb-1 hover:text-[#2563EB] dark:hover:text-[#3B82F6] transition-colors cursor-pointer"
                        >
                          <div className="font-medium text-slate-800 dark:text-slate-200 truncate">
                            {ev.message}
                          </div>
                          <div className="text-slate-400 tabular-nums">
                            {formatUnixTime(ev.timestamp < 1e12 ? ev.timestamp : Math.floor(ev.timestamp / 1000))}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* User Profile Pill ("Андрей v") */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setProfileMenuOpen((o) => !o)}
                className="inline-flex items-center gap-2.5 pl-1.5 pr-3 py-1.5 rounded-full bg-slate-100 hover:bg-slate-200/70 dark:bg-[#1c2331] dark:hover:bg-[#252e40] border border-slate-200/80 dark:border-white/[0.07] transition-colors cursor-pointer"
              >
                <span className="w-7 h-7 rounded-full bg-slate-300 dark:bg-slate-600 flex items-center justify-center text-slate-700 dark:text-slate-200">
                  <User className="w-4 h-4" />
                </span>
                <span className="text-xs sm:text-sm font-medium text-slate-800 dark:text-slate-100">
                  {subscriberFirstName}
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
              </button>

              {profileMenuOpen && (
                <div className="absolute right-0 mt-2 w-64 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/10 shadow-xl py-2 z-50 text-xs">
                  <div className="px-4 py-2.5 border-b border-slate-100 dark:border-white/[0.06]">
                    <div className="font-semibold text-slate-900 dark:text-white truncate">
                      {session.subscriber?.name || subscriberFirstName}
                    </div>
                    <div className="text-slate-400 font-mono tabular-nums mt-0.5">
                      {session.phone || 'Аккаунт подключён'}
                    </div>
                  </div>

                  {places.length > 1 && (
                    <div className="px-3 py-2 border-b border-slate-100 dark:border-white/[0.06] space-y-1">
                      <div className="px-1 text-[11px] text-slate-400">Адрес:</div>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedPlaceId('all');
                          setProfileMenuOpen(false);
                        }}
                        className={`w-full text-left px-2 py-1.5 rounded-lg ${
                          selectedPlaceId === 'all'
                            ? 'bg-blue-500/10 text-[#2563EB] dark:text-[#3B82F6] font-semibold'
                            : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5'
                        }`}
                      >
                        Все адреса ({places.length})
                      </button>
                      {places.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setSelectedPlaceId(p.id);
                            setProfileMenuOpen(false);
                          }}
                          className={`w-full text-left px-2 py-1.5 rounded-lg truncate ${
                            selectedPlaceId === p.id
                              ? 'bg-blue-500/10 text-[#2563EB] dark:text-[#3B82F6] font-semibold'
                              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5'
                          }`}
                        >
                          {p.address}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="py-1">
                    <button
                      type="button"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        triggerApkDownload();
                        showNotice('Загрузка Android APK началась');
                      }}
                      className="w-full px-4 py-2 text-left text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.05] flex items-center gap-2.5 cursor-pointer"
                    >
                      <Smartphone className="w-4 h-4 text-[#2563EB] dark:text-[#3B82F6]" />
                      <span>Скачать Android APK</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        handleSync(session);
                      }}
                      className="w-full px-4 py-2 text-left text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.05] flex items-center gap-2.5 cursor-pointer"
                    >
                      <RefreshCw className={`w-4 h-4 ${syncLoading ? 'animate-spin' : ''}`} />
                      <span>Обновить данные</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        setShowWelcomePage(true);
                      }}
                      className="w-full px-4 py-2 text-left text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.05] flex items-center gap-2.5 cursor-pointer"
                    >
                      <Key className="w-4 h-4 text-slate-400" />
                      <span>Приветственная страница</span>
                    </button>
                  </div>

                  <div className="pt-1 border-t border-slate-100 dark:border-white/[0.06]">
                    {session.mode === 'demo' ? (
                      <button
                        type="button"
                        onClick={handleExitDemo}
                        className="w-full px-4 py-2 text-left text-[#2563EB] dark:text-[#3B82F6] hover:bg-blue-50 dark:hover:bg-blue-950/30 flex items-center gap-2.5 font-semibold cursor-pointer"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>Выйти из демо-режима</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleLogout}
                        className="w-full px-4 py-2 text-left text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 flex items-center gap-2.5 cursor-pointer"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>Выйти из аккаунта</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Toast Notification */}
        {toastNotice && (
          <div className="fixed bottom-20 md:bottom-6 right-5 z-50 bg-white dark:bg-[#1a202c] border border-emerald-500/40 text-slate-900 dark:text-white px-4 py-3 rounded-2xl shadow-xl flex items-center gap-3 text-xs font-medium">
            <Check className="w-4 h-4 text-emerald-500 shrink-0" />
            <span>{toastNotice}</span>
          </div>
        )}

        {/* Main Workspace Container */}
        <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-8 py-6 sm:py-7">
          {isSubscriptionRestricted && activeSection !== 'settings' && activeSection !== 'about' && activeSection !== 'admin' && (
            <div className="mb-6 p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/35 border border-amber-300/70 dark:border-amber-500/35 flex flex-wrap items-center justify-between gap-4 text-xs text-amber-900 dark:text-amber-100">
              <div className="flex items-center gap-3 min-w-0">
                <Lock className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <div className="space-y-0.5">
                  <div className="font-bold">
                    {billingMe?.user.status === 'blocked'
                      ? 'Аккаунт заблокирован — доступен только онлайн-просмотр камер'
                      : 'Подписка не оплачена или истекла — доступен только онлайн-просмотр камер'}
                  </div>
                  <div className="text-amber-800/80 dark:text-amber-200/80">
                    Открытие дверей и ворот, архив записей, события и гостевой доступ отключены.
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActiveSection('settings')}
                className="px-4 py-2 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-colors"
              >
                {billingMe?.user.status === 'blocked' ? 'Подробнее' : 'Оплатить подписку'}
              </button>
            </div>
          )}

          {syncError && (
            <div className="mb-6 p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-500/40 flex items-center justify-between gap-4 text-xs text-rose-700 dark:text-rose-200">
              <div className="flex items-center gap-2.5">
                <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
                <span>{syncError}</span>
              </div>
              <button
                type="button"
                onClick={() => handleSync(session)}
                className="px-3 py-1.5 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-lg border border-slate-200 dark:border-slate-700 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Повторить
              </button>
            </div>
          )}

          {/* =============================================================== */}
          {/* SECTION: ОБЗОР                                                  */}
          {/* =============================================================== */}
          {activeSection === 'overview' && (
            <OverviewDashboard
              session={session}
              places={places}
              selectedPlaceId={selectedPlaceId}
              onSelectPlace={setSelectedPlaceId}
              balances={balances}
              billingMe={billingMe}
              dndByPlace={dndByPlace}
              cameras={placeVisibleCameras}
              locks={filteredLocks}
              doorLogs={doorLogs}
              placeHistory={placeHistory}
              placeHistoryHasMore={placeHistoryHasMore}
              placeHistoryLoadingMore={placeHistoryLoadingMore}
              onLoadMoreHistory={handleLoadMoreHistory}
              unlockingMap={unlockingMap}
              unlockedMap={unlockedMap}
              onOpenLock={handleOpenLock}
              onNavigateCameras={() => setActiveSection('cameras')}
              onNavigateCameraArchive={(cam) => handleSelectCameraForVideo(cam, 'archive')}
              onOpenHistoryEvent={handleOpenHistoryEvent}
              onOpenDoorLog={handleOpenDoorLog}
              onNavigateArchive={() => setActiveSection('video')}
              onNavigateAccess={() => setActiveSection('access')}
              onNavigateSettings={() => setActiveSection('settings')}
              onRenameCamera={handleRenameCamera}
              onNotice={showNotice}
              isRestricted={isSubscriptionRestricted}
            />
          )}

          {/* =============================================================== */}
          {/* SECTION: КАМЕРЫ                                                 */}
          {/* =============================================================== */}
          {activeSection === 'cameras' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 font-display">
                    Камеры
                  </h1>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                    Прямой эфир и стоп-кадры с камер вашего дома
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-1 p-1 bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/[0.06] rounded-xl">
                    <span className="px-2 text-xs text-slate-500 dark:text-slate-400">
                      Автообновление:
                    </span>
                    {[
                      { sec: 0, label: 'Выкл' },
                      { sec: 10, label: '10 сек' },
                      { sec: 30, label: '30 сек' },
                    ].map((opt) => (
                      <button
                        key={opt.sec}
                        type="button"
                        onClick={() => setAutoRefreshSec(opt.sec)}
                        className={`px-2.5 py-1 text-xs font-mono tabular-nums rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          autoRefreshSec === opt.sec
                            ? 'bg-[#2563EB] text-white font-semibold'
                            : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => setSnapshotRefreshTick(Date.now())}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/[0.08] text-slate-800 dark:text-slate-100 rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-[#2563EB] dark:text-[#3B82F6]" />
                    <span>Обновить кадры</span>
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-1 p-1 bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/[0.06] rounded-xl">
                  {(
                    [
                      { id: 'all', label: 'Все камеры' },
                      { id: 'intercom', label: 'Домофоны и входы' },
                      { id: 'public', label: 'Двор и ворота' },
                      { id: 'favorite', label: 'Избранное' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setCameraSourceFilter(tab.id)}
                      className={`px-3 py-1.5 text-xs rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-1.5 ${
                        cameraSourceFilter === tab.id
                          ? 'bg-[#2563EB] text-white font-semibold'
                          : 'font-medium text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      {tab.id === 'favorite' && (
                        <Star
                          className={`w-3.5 h-3.5 ${
                            cameraSourceFilter === 'favorite'
                              ? 'fill-amber-300 text-amber-300'
                              : 'text-amber-400'
                          }`}
                        />
                      )}
                      <span>{tab.label}</span>
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  {hiddenCamerasCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowHiddenCameras((v) => !v)}
                      className={`px-3 py-1.5 text-xs rounded-xl border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        showHiddenCameras
                          ? 'bg-[#2563EB]/10 border-[#2563EB]/40 text-[#2563EB] dark:text-[#3B82F6] font-semibold'
                          : 'bg-white dark:bg-[#1a202c] border-slate-200 dark:border-white/[0.06] text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      {showHiddenCameras
                        ? `Скрыть скрытые (${hiddenCamerasCount})`
                        : `Показать скрытые (${hiddenCamerasCount})`}
                    </button>
                  )}

                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={cameraSearch}
                      onChange={(e) => setCameraSearch(e.target.value)}
                      placeholder="Поиск камеры..."
                      className="pl-8 pr-3 py-1.5 text-xs bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/[0.06] rounded-xl text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {filteredCameras.length === 0 ? (
                <div className="p-10 bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/[0.06] rounded-2xl text-center space-y-2">
                  <p className="text-sm font-medium">
                    {cameraSourceFilter === 'favorite'
                      ? 'В избранном пока нет камер'
                      : 'Камеры не найдены'}
                  </p>
                  <p className="text-xs text-slate-500">
                    {cameraSourceFilter === 'favorite'
                      ? 'Отметьте нужные камеры звёздочкой ★ на карточке камеры, чтобы они отображались в этом разделе.'
                      : 'Попробуйте изменить фильтр категорий выше.'}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {filteredCameras.map((cam) => (
                    <CameraSnapshotCard
                      key={cam.id}
                      session={session}
                      camera={cam}
                      linkedLock={getLinkedLockForCamera(cam)}
                      refreshTick={snapshotRefreshTick}
                      onSelectForVideo={handleSelectCameraForVideo}
                      onInspectSnapshot={(camera, url) => setLightboxCamera({ camera, url })}
                      onUnlockLinked={handleOpenLock}
                      onToggleFavorite={handleToggleCameraFavorite}
                      onRenameCamera={handleRenameCamera}
                      onNotice={showNotice}
                      isRestricted={isSubscriptionRestricted}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* =============================================================== */}
          {/* SECTION: ВИДЕОАРХИВ                                             */}
          {/* =============================================================== */}
          {activeSection === 'video' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 font-display">
                    {isSubscriptionRestricted ? 'Онлайн-просмотр камер' : 'Видеоархив'}
                  </h1>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                    {isSubscriptionRestricted
                      ? 'Доступен только прямой эфир камер — архив записей и скачивание MP4 заблокированы'
                      : 'Просмотр записей по времени, управление скоростью (0.5×–4×) и скачивание MP4'}
                  </p>
                </div>

                <div className="flex items-center gap-1 p-1 bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/[0.06] rounded-xl">
                  <button
                    type="button"
                    onClick={() => {
                      setVideoPlaybackMode('live');
                      setArchiveTimestampSec(null);
                      setActiveEventId(null);
                    }}
                    className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer ${
                      videoPlaybackMode === 'live'
                        ? 'bg-[#2563EB] text-white'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Прямой эфир</span>
                  </button>
                  {!isSubscriptionRestricted && (
                    <button
                      type="button"
                      onClick={() => {
                        const knownMin = activeVideoCamera
                          ? archiveMinTsByCamera[activeVideoCamera.id]
                          : undefined;
                        const nowLimit = Math.floor(Date.now() / 1000) - 5;
                        const fallbackTs = Math.floor(Date.now() / 1000) - 300;
                        const rawTs = archiveTimestampSec || fallbackTs;
                        const defaultTs =
                          knownMin != null && rawTs < knownMin
                            ? Math.min(nowLimit, knownMin + 5)
                            : rawTs;
                        setArchiveTimestampSec(defaultTs);
                        setActiveEventId(null);
                        setVideoPlaybackMode('archive_stream');
                      }}
                      className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer ${
                        videoPlaybackMode !== 'live'
                          ? 'bg-[#2563EB] text-white'
                          : 'text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      <History className="w-3.5 h-3.5" />
                      <span>Архив записей</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                <div className="lg:col-span-4 bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/[0.06] rounded-2xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 dark:border-white/[0.06] flex items-center justify-between">
                    <span className="text-xs font-semibold">
                      Камеры ({placeVisibleCameras.length})
                    </span>
                    <button
                      type="button"
                      onClick={() => setSnapshotRefreshTick(Date.now())}
                      title="Обновить снимки камер"
                      className="p-1 rounded-lg text-slate-400 hover:text-[#2563EB] dark:hover:text-[#3B82F6] hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="divide-y divide-slate-100 dark:divide-white/[0.06] max-h-[600px] overflow-y-auto">
                    {placeVisibleCameras.map((cam) => {
                      const isSelected = activeVideoCamera?.id === cam.id;
                      const lockForCam = getLinkedLockForCamera(cam);
                      const isRenamingThis = renamingSidebarCameraId === cam.id;
                      const isCustomRenamed = Boolean(
                        cam.originalName && cam.originalName.trim() !== cam.name.trim()
                      );

                      return (
                        <div
                          key={cam.id}
                          className={`p-3 transition-colors flex items-center justify-between gap-2.5 cursor-pointer ${
                            isSelected
                              ? 'bg-[#2563EB]/10 text-[#2563EB] dark:text-white'
                              : 'hover:bg-slate-50 dark:hover:bg-white/[0.03]'
                          }`}
                          onClick={() => {
                            if (isRenamingThis) return;
                            if (activeVideoCamera?.id !== cam.id) {
                              setSelectedVideoCameraId(cam.id);
                              setArchiveDay(getRecentDays(1)[0]);
                              setActiveEventId(null);
                              setInitialClipSeekSec(0);
                              setCameraEvents([]);
                              setArchiveTimestampSec(null);
                              setVideoPlaybackMode('live');
                              setJumpTimeInput(
                                formatUnixTime(Math.floor(Date.now() / 1000) - 300)
                              );
                            }
                          }}
                        >
                          <ArchiveCameraThumb
                            session={session}
                            camera={cam}
                            refreshTick={snapshotRefreshTick}
                          />

                          {isRenamingThis ? (
                            <form
                              onClick={(e) => e.stopPropagation()}
                              onSubmit={async (e) => {
                                e.preventDefault();
                                if (renamingSidebarSaving) return;
                                setRenamingSidebarSaving(true);
                                try {
                                  await handleRenameCamera(cam, renamingSidebarDraft);
                                  setRenamingSidebarCameraId(null);
                                } finally {
                                  setRenamingSidebarSaving(false);
                                }
                              }}
                              className="min-w-0 flex-1 flex items-center gap-1"
                            >
                              <input
                                type="text"
                                value={renamingSidebarDraft}
                                onChange={(e) => setRenamingSidebarDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    setRenamingSidebarCameraId(null);
                                  }
                                }}
                                maxLength={80}
                                autoFocus
                                disabled={renamingSidebarSaving}
                                placeholder={cam.originalName || 'Название камеры'}
                                className="flex-1 min-w-0 px-2 py-1 text-xs font-semibold bg-white dark:bg-[#12161f] border border-[#2563EB]/60 rounded-lg text-slate-900 dark:text-white focus:outline-none"
                              />
                              <button
                                type="submit"
                                disabled={renamingSidebarSaving}
                                title="Сохранить"
                                className="p-1.5 rounded-lg bg-[#2563EB] hover:bg-blue-700 text-white shrink-0 cursor-pointer"
                              >
                                <Check className="w-3 h-3" />
                              </button>
                              {isCustomRenamed && (
                                <button
                                  type="button"
                                  disabled={renamingSidebarSaving}
                                  onClick={async () => {
                                    setRenamingSidebarSaving(true);
                                    try {
                                      await handleRenameCamera(cam, '');
                                      setRenamingSidebarCameraId(null);
                                    } finally {
                                      setRenamingSidebarSaving(false);
                                    }
                                  }}
                                  title={`Сбросить на «${cam.originalName}»`}
                                  className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.12] text-slate-600 dark:text-slate-300 shrink-0 cursor-pointer"
                                >
                                  <RotateCcw className="w-3 h-3" />
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={renamingSidebarSaving}
                                onClick={() => setRenamingSidebarCameraId(null)}
                                title="Отмена"
                                className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.12] text-slate-500 dark:text-slate-400 shrink-0 cursor-pointer"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </form>
                          ) : (
                            <>
                              <div className="min-w-0 flex-1 space-y-0.5">
                                <div
                                  className="text-xs font-semibold truncate"
                                  title={
                                    isCustomRenamed
                                      ? `${cam.name} (Исходное: ${cam.originalName})`
                                      : cam.name
                                  }
                                >
                                  {cam.name}
                                </div>
                                <div className="text-[11px] text-slate-400 font-mono tabular-nums truncate">
                                  {isCustomRenamed
                                    ? `Исходное: ${cam.originalName}`
                                    : `Архив ${cam.retentionDays} дн.`}
                                </div>
                              </div>

                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setRenamingSidebarCameraId(cam.id);
                                    setRenamingSidebarDraft(cam.name);
                                  }}
                                  title="Переименовать камеру"
                                  className="p-1.5 rounded-lg text-slate-400 hover:text-[#2563EB] dark:hover:text-[#3B82F6] hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>

                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleToggleCameraFavorite(cam);
                                  }}
                                  title={
                                    cam.favorite
                                      ? 'Убрать из избранного'
                                      : 'Добавить в избранное'
                                  }
                                  className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                                    cam.favorite
                                      ? 'text-amber-400 hover:bg-amber-500/10'
                                      : 'text-slate-400 hover:text-amber-400 hover:bg-slate-100 dark:hover:bg-white/[0.06]'
                                  }`}
                                >
                                  <Star
                                    className={`w-3.5 h-3.5 ${
                                      cam.favorite ? 'fill-amber-400 text-amber-400' : ''
                                    }`}
                                  />
                                </button>

                                {!isSubscriptionRestricted && lockForCam && lockForCam.openable && (
                                  <button
                                    type="button"
                                    disabled={Boolean(unlockingMap[lockForCam.id])}
                                    title={`Открыть: ${lockForCam.name}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleOpenLock(lockForCam);
                                    }}
                                    className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-all whitespace-nowrap shrink-0 active:scale-[0.97] ${
                                      unlockedMap[lockForCam.id]
                                        ? 'bg-emerald-600 border-emerald-600 text-white cursor-pointer'
                                        : unlockingMap[lockForCam.id]
                                        ? 'bg-slate-200 dark:bg-white/10 border-slate-300 dark:border-white/10 text-slate-500 cursor-wait'
                                        : 'bg-slate-100 dark:bg-slate-800 border-slate-200/90 dark:border-white/10 text-slate-800 dark:text-slate-200 hover:bg-[#2563EB] hover:border-[#2563EB] hover:text-white dark:hover:bg-[#2563EB] dark:hover:border-[#2563EB] dark:hover:text-white hover:shadow-sm cursor-pointer'
                                    }`}
                                  >
                                    {unlockingMap[lockForCam.id]
                                      ? 'Открытие...'
                                      : unlockedMap[lockForCam.id]
                                      ? 'Открыто'
                                      : 'Открыть'}
                                  </button>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="lg:col-span-8 space-y-6">
                  {activeVideoCamera ? (
                    <>
                      <CameraFeedPlayer
                        session={session}
                        camera={activeVideoCamera}
                        playbackMode={videoPlaybackMode}
                        archiveDay={archiveDay}
                        archiveTimestampSec={archiveTimestampSec}
                        activeEventId={activeEventId}
                        activeEventDurationSec={
                          cameraEvents.find((e) => e.id === activeEventId)?.duration || 20
                        }
                        initialClipSeekSec={initialClipSeekSec}
                        knownMinAvailableTs={archiveMinTsByCamera[activeVideoCamera.id] ?? null}
                        downloadDurationSec={clipDownloadDurationSec}
                        seekNonce={playerSeekNonce}
                        nearestEventInfo={nearestEventForArchive}
                        doorUnlockedPulse={
                          activeCameraLinkedLock
                            ? Boolean(unlockedMap[activeCameraLinkedLock.id])
                            : false
                        }
                        onCaptureNotice={showNotice}
                        onDiscoverMinAvailableTs={(camId, minTs) => {
                          setArchiveMinTsByCamera((prev) => ({ ...prev, [camId]: minTs }));
                        }}
                        onRequestFallbackEventMp4={(targetTs) => {
                          // Only fallback to an event MP4 if targetTs strictly falls inside that event's recording window
                          const matched = findMatchingEventForTs(targetTs, cameraEvents, 0);
                          if (matched && activeVideoCamera.videoDownloadAvailable !== false) {
                            const endTs = matched.timestamp + Math.max(20, matched.duration || 30);
                            const offsetSec =
                              targetTs >= matched.timestamp && targetTs <= endTs
                                ? Math.max(0, Math.floor(targetTs - matched.timestamp))
                                : 0;
                            setInitialClipSeekSec(offsetSec);
                            setActiveEventId(matched.id);
                            setVideoPlaybackMode('event_mp4');
                            return true;
                          }
                          return false;
                        }}
                        onSwitchToDvrStream={() => {
                          setVideoPlaybackMode('archive_stream');
                        }}
                        onOpenNearestEvent={() => {
                          if (!nearestEventForArchive) return;
                          const isLong = (nearestEventForArchive.duration || 0) > 300;
                          setInitialClipSeekSec(0);
                          setArchiveTimestampSec(nearestEventForArchive.timestamp);
                          setActiveEventId(nearestEventForArchive.id);
                          setVideoPlaybackMode(
                            !isLong && activeVideoCamera.videoDownloadAvailable !== false
                              ? 'event_mp4'
                              : 'archive_stream'
                          );
                        }}
                        onSeekArchiveTimestamp={(newTs) => {
                          setInitialClipSeekSec(0);
                          setArchiveTimestampSec(newTs);
                          setActiveEventId(null);
                          setVideoPlaybackMode('archive_stream');
                        }}
                      />

                      {isSubscriptionRestricted ? (
                        <div className="p-6 bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/[0.06] rounded-2xl flex flex-wrap items-center justify-between gap-4">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-500 flex items-center justify-center shrink-0">
                              <Lock className="w-5 h-5" />
                            </div>
                            <div className="space-y-0.5 text-xs">
                              <div className="text-sm font-bold text-slate-900 dark:text-white">
                                Видеоархив и события заблокированы
                              </div>
                              <div className="text-slate-500 dark:text-slate-400">
                                Перемотка архива, журнал движений и скачивание MP4 недоступны без активной подписки.
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setActiveSection('settings')}
                            className="px-4 py-2 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap"
                          >
                            Оплатить подписку
                          </button>
                        </div>
                      ) : (
                      <div className="p-5 bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/[0.06] rounded-2xl space-y-5">
                        <div className="space-y-4 border-b border-slate-200 dark:border-white/[0.06] pb-4">
                          <div className="flex flex-wrap items-center justify-between gap-4">
                            <div>
                              <h2 className="text-base font-bold font-display">
                                События и записи архива
                              </h2>
                            </div>

                            <div className="flex items-center gap-2">
                              <label htmlFor="archive-day-select" className="text-xs text-slate-400">
                                Дата:
                              </label>
                              <select
                                id="archive-day-select"
                                value={archiveDay}
                                onChange={(e) => setArchiveDay(e.target.value)}
                                className="px-3 py-1.5 text-xs font-mono tabular-nums bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 rounded-lg focus:outline-none"
                              >
                                {availableRetentionDays.map((d, idx) => (
                                  <option key={d} value={d}>
                                    {d} {idx === 0 ? '(Сегодня)' : idx === 1 ? '(Вчера)' : ''}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>

                          {/* Exact Time Jump & Fragment Download Controls */}
                          <form
                            onSubmit={handleJumpToArchiveTime}
                            className="p-3 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200/80 dark:border-white/[0.06] flex flex-wrap items-center justify-between gap-3 text-xs"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <label
                                htmlFor="archive-time-input"
                                className="text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap"
                              >
                                К времени:
                              </label>
                              <input
                                id="archive-time-input"
                                type="time"
                                step="1"
                                value={jumpTimeInput}
                                onChange={(e) => setJumpTimeInput(e.target.value)}
                                className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/10 font-mono tabular-nums text-slate-900 dark:text-white focus:outline-none focus:border-[#2563EB]"
                              />
                              <button
                                type="submit"
                                className="px-3 py-1.5 rounded-lg bg-[#2563EB] hover:bg-blue-700 text-white font-semibold transition-colors whitespace-nowrap cursor-pointer"
                              >
                                Перейти
                              </button>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              <label
                                htmlFor="clip-duration-select"
                                className="text-slate-500 dark:text-slate-400 whitespace-nowrap"
                              >
                                Отрезок:
                              </label>
                              <select
                                id="clip-duration-select"
                                value={clipDownloadDurationSec}
                                onChange={(e) => setClipDownloadDurationSec(Number(e.target.value))}
                                className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/10 font-mono tabular-nums text-slate-800 dark:text-slate-200 focus:outline-none"
                              >
                                <option value={15}>15 сек</option>
                                <option value={30}>30 сек</option>
                                <option value={60}>1 мин</option>
                                <option value={120}>2 мин</option>
                                <option value={300}>5 мин</option>
                              </select>
                              <button
                                type="button"
                                disabled={downloadingCustomClip}
                                onClick={handleDownloadCustomClip}
                                title={`Скачать MP4 с ${jumpTimeInput || 'указанного времени'} (+${clipDownloadDurationSec} сек)`}
                                className="px-3 py-1.5 rounded-lg bg-[#2563EB]/10 hover:bg-[#2563EB]/20 text-[#2563EB] dark:text-[#3B82F6] font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap disabled:opacity-50 cursor-pointer"
                              >
                                <Download className="w-3.5 h-3.5" />
                                <span>
                                  {downloadingCustomClip ? 'Скачивание...' : 'Скачать MP4'}
                                </span>
                              </button>
                            </div>
                          </form>
                        </div>

                        {eventsLoading && cameraEvents.length === 0 ? (
                          <div className="py-6 text-center text-xs text-slate-400">
                            Загрузка событий архива за {archiveDay}...
                          </div>
                        ) : cameraEvents.length === 0 ? (
                          <div className="py-5 text-center text-xs text-slate-400">
                            За {archiveDay} событий движения не найдено.
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                              <span>
                                События движения за {archiveDay}
                              </span>
                            </div>

                            <div
                              ref={eventsListRef}
                              onScroll={(e) => {
                                const el = e.currentTarget;
                                if (el.scrollHeight - el.scrollTop - el.clientHeight < 90) {
                                  loadMoreCameraEvents();
                                }
                              }}
                              className="divide-y divide-slate-100 dark:divide-white/[0.06] max-h-80 overflow-y-auto pr-1"
                            >
                              {cameraEvents.map((ev) => {
                                const startStr = formatUnixTime(ev.timestamp);
                                const isActiveEvent =
                                  activeEventId === ev.id &&
                                  (videoPlaybackMode === 'event_mp4' ||
                                    videoPlaybackMode === 'archive_stream');
                                return (
                                  <div
                                    key={ev.id}
                                    className={`py-2.5 px-2 -mx-2 rounded-lg flex items-center justify-between gap-3 text-xs transition-colors ${
                                      isActiveEvent
                                        ? 'bg-[#2563EB]/10 border border-[#2563EB]/30'
                                        : ''
                                    }`}
                                  >
                                    <div>
                                      <span className="font-mono font-semibold">{startStr}</span>
                                      <span className="text-slate-400 ml-2">
                                        ({formatDuration(ev.duration)})
                                      </span>
                                      {isActiveEvent && (
                                        <span className="ml-2 text-[11px] font-medium text-[#2563EB] dark:text-[#3B82F6]">
                                          В плеере
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setInitialClipSeekSec(0);
                                          setArchiveTimestampSec(ev.timestamp);
                                          setActiveEventId(ev.id);
                                          // Forpost MP4 export fails or times out on long recordings (> 5 min);
                                          // stream long archive events directly via DVR HTTP-FLV at exact timestamp.
                                          const isLongRecording = (ev.duration || 0) > 300;
                                          if (
                                            !isLongRecording &&
                                            activeVideoCamera?.videoDownloadAvailable !== false
                                          ) {
                                            setVideoPlaybackMode('event_mp4');
                                          } else {
                                            setVideoPlaybackMode('archive_stream');
                                          }
                                        }}
                                        className={`px-2.5 py-1 rounded-lg font-medium cursor-pointer ${
                                          isActiveEvent
                                            ? 'bg-[#2563EB] text-white'
                                            : 'bg-slate-100 dark:bg-[#232b3a]'
                                        }`}
                                      >
                                        Смотреть
                                      </button>
                                      <button
                                        type="button"
                                        disabled={downloadingEventId === ev.id}
                                        onClick={async () => {
                                          if (!activeVideoCamera) return;
                                          setDownloadingEventId(ev.id);
                                          try {
                                            await downloadArchiveVideoMp4(session, {
                                              eventId: ev.id,
                                              cameraId: activeVideoCamera.id,
                                              placeId: activeVideoCamera.placeId,
                                              timestampSec: ev.timestamp,
                                              durationSec: ev.duration || 30,
                                              tz: activeVideoCamera.timeZone || 25200,
                                            });
                                            showNotice('Видео сохранено (MP4)');
                                          } finally {
                                            setDownloadingEventId(null);
                                          }
                                        }}
                                        className="px-2.5 py-1 rounded-lg bg-[#2563EB]/10 text-[#2563EB] dark:text-[#3B82F6] font-medium inline-flex items-center gap-1 cursor-pointer"
                                      >
                                        <Download className="w-3.5 h-3.5" />
                                        <span>MP4</span>
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}

                              {/* Bottom infinite-scroll sentinel / load more trigger */}
                              <div className="pt-3 pb-1 text-center">
                                {eventsLoadingMore ? (
                                  <span className="text-xs text-slate-400">
                                    Дозагрузка более ранних событий...
                                  </span>
                                ) : eventsHasMore ? (
                                  <button
                                    type="button"
                                    onClick={loadMoreCameraEvents}
                                    className="px-3.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#232b3a] dark:hover:bg-[#2c3649] text-xs font-medium text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
                                  >
                                    Загрузить ещё (до 00:00)
                                  </button>
                                ) : (
                                  <span className="text-[11px] text-slate-400">
                                    Достигнуто начало дня ({archiveDay})
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                      )}
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          )}

          {/* =============================================================== */}
          {/* SECTION: УПРАВЛЕНИЕ ДОСТУПОМ (Двери, Ворота, Гостевые ссылки)   */}
          {/* =============================================================== */}
          {activeSection === 'access' && isSubscriptionRestricted && (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] max-w-2xl space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center">
                <Lock className="w-6 h-6" />
              </div>
              <h1 className="text-xl font-bold font-display">Управление доступом заблокировано</h1>
              <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                Открытие дверей, калиток и ворот, настройка контроллера и создание гостевых ссылок недоступны при неоплаченной или заблокированной подписке. Вы можете смотреть камеры онлайн или оплатить подписку.
              </p>
              <div className="flex flex-wrap gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setActiveSection('settings')}
                  className="px-4 py-2.5 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold cursor-pointer transition-colors"
                >
                  Оплатить подписку
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSection('cameras')}
                  className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.1] text-slate-800 dark:text-slate-200 text-xs font-semibold cursor-pointer transition-colors"
                >
                  Смотреть камеры онлайн
                </button>
              </div>
            </div>
          )}

          {activeSection === 'access' && !isSubscriptionRestricted && (
            <div className="space-y-8">
              <div>
                <h1 className="text-2xl font-bold font-display">Управление доступом</h1>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  Мгновенное открытие калиток, подъезда, ворот и создание временных гостевых ссылок
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {(filteredLocks.length > 0
                  ? filteredLocks
                  : ([
                      {
                        id: 'default_door',
                        placeId: '1',
                        placeAddress: 'Мой дом',
                        accessControlId: '101',
                        entranceId: null,
                        acName: 'Домофон',
                        name: 'Входная дверь',
                        openable: true,
                        allowVideo: true,
                        externalCameraId: null,
                        hidden: false,
                        favorite: true,
                        kind: 'door',
                      },
                      {
                        id: 'default_gate',
                        placeId: '1',
                        placeAddress: 'Мой дом',
                        accessControlId: '102',
                        entranceId: null,
                        acName: 'Контроллер ворот',
                        name: 'Ворота',
                        openable: true,
                        allowVideo: true,
                        externalCameraId: null,
                        hidden: false,
                        favorite: true,
                        kind: 'gate',
                      },
                    ] as LockItem[])
                ).map((lock) => {
                  const isUnlocked = Boolean(unlockedMap[lock.id]);
                  const isUnlocking = Boolean(unlockingMap[lock.id]);
                  const isEsp32 =
                    lock.controllerType === 'esp32' ||
                    lock.entranceId?.startsWith('esp32_gate_');
                  const isGate =
                    isEsp32 ||
                    lock.kind === 'gate' ||
                    lock.kind === 'barrier' ||
                    lock.name.toLowerCase().includes('ворот') ||
                    lock.name.toLowerCase().includes('калитк') ||
                    lock.name.toLowerCase().includes('фасад');
                  const linkedCam = getLinkedCameraForLock(lock);
                  const displayLockName = linkedCam?.name || lock.name;
                  const isCustomRenamed = Boolean(
                    linkedCam?.originalName &&
                      linkedCam.originalName.trim() !== linkedCam.name.trim()
                  );

                  return (
                    <div
                      key={lock.id}
                      className="p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] flex items-center justify-between gap-4"
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        <div
                          className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
                            isUnlocked
                              ? 'bg-emerald-500/15 text-emerald-500'
                              : isEsp32
                              ? 'bg-[#2563EB]/10 text-[#2563EB] dark:text-[#3B82F6]'
                              : 'bg-slate-100 dark:bg-[#232b3a] text-slate-700 dark:text-slate-200'
                          }`}
                        >
                          {isGate ? (
                            <GateOutlineIcon className="w-6 h-6" />
                          ) : (
                            <DoorOutlineIcon className="w-6 h-6" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div
                            className="text-base font-bold truncate"
                            title={
                              isCustomRenamed
                                ? `${displayLockName} (Исходное: ${linkedCam?.originalName})`
                                : displayLockName
                            }
                          >
                            {displayLockName}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                            {lock.acName || lock.placeAddress}
                            {isCustomRenamed ? ` · Исходное: ${linkedCam?.originalName}` : ''} ·{' '}
                            <span
                              className={
                                isUnlocked ? 'text-emerald-500 font-semibold' : ''
                              }
                            >
                              {isUnlocked ? 'Сигнал открытия подан' : 'Готов к открытию'}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {linkedCam && (
                          <button
                            type="button"
                            onClick={() => handleSelectCameraForVideo(linkedCam, 'live')}
                            className="px-3 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.1] text-xs font-semibold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                            title={`Открыть прямой эфир камеры «${linkedCam.name}»`}
                          >
                            <Play className="w-3.5 h-3.5 text-[#2563EB] dark:text-[#3B82F6] fill-current" />
                            <span className="hidden sm:inline">Камера</span>
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isUnlocking}
                          onClick={() =>
                            lock.id.startsWith('default_')
                              ? isGate
                                ? handleQuickOpenGate()
                                : handleQuickOpenDoor()
                              : handleOpenLock(lock)
                          }
                          className={`px-5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                            isUnlocked
                              ? 'bg-emerald-500 text-white'
                              : isUnlocking
                              ? 'bg-slate-200 dark:bg-white/10 text-slate-400 cursor-wait'
                              : 'bg-[#2563EB] hover:bg-blue-700 text-white'
                          }`}
                        >
                          {isUnlocked ? (
                            <>
                              <Check className="w-4 h-4" />
                              <span>Открыто</span>
                            </>
                          ) : (
                            <>
                              <Unlock className="w-4 h-4" />
                              <span>{isUnlocking ? 'Открываем...' : 'Открыть'}</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ESP32 Physical Remote Relay Controller Card */}
              <div className="p-6 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2.5">
                      <h2 className="text-base font-bold">
                        Контроллер ворот ESP32
                      </h2>
                      <span
                        className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-md ${
                          esp32Status?.lastPollAt &&
                          Date.now() - esp32Status.lastPollAt < 30000
                            ? 'bg-emerald-500/15 text-emerald-500'
                            : 'bg-[#2563EB]/10 text-[#2563EB] dark:text-[#3B82F6]'
                        }`}
                      >
                        {esp32Status?.lastPollAt &&
                        Date.now() - esp32Status.lastPollAt < 30000
                          ? 'ESP32 на связи'
                          : esp32Status?.config?.gate1HttpUrl
                          ? 'Режим прямого HTTP'
                          : 'Режим очереди команд (Polling)'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 max-w-3xl">
                      При нажатии «Открыть» на камерах{' '}
                      <strong>
                        «
                        {cameras.find(
                          (c) =>
                            c.entranceId === 'esp32_gate_1' ||
                            (c.originalName || c.name).toLowerCase().includes('фасад 1')
                        )?.name || 'Камера фасад 1 - 3-Й Мкр 6 б'}
                        »
                      </strong>{' '}
                      (Канал 1 · GPIO {esp32Status?.config?.gpioGate1Pin || 18}) или{' '}
                      <strong>
                        «
                        {cameras.find(
                          (c) =>
                            c.entranceId === 'esp32_gate_2' ||
                            (c.originalName || c.name).toLowerCase().includes('фасад 2')
                        )?.name || 'Камера фасад 2 - 3-Й Мкр 6 б'}
                        »
                      </strong>{' '}
                      (Канал 2 · GPIO {esp32Status?.config?.gpioGate2Pin || 19}) сервер подаёт команду на ESP32, которая через оптопару или реле замыкает соответствующую кнопку пульта ворот на{' '}
                      <span className="font-mono font-semibold">
                        {esp32Status?.config?.pulseDurationMs || 600} мс
                      </span>.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEsp32SketchOpen((v) => !v)}
                      className="px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.1] text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
                    >
                      {esp32SketchOpen ? 'Скрыть прошивку ESP32' : 'Прошивка для ESP32'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEsp32ConfigOpen((v) => !v)}
                      className="px-3.5 py-2 rounded-xl bg-[#2563EB]/10 hover:bg-[#2563EB]/20 text-xs font-semibold text-[#2563EB] dark:text-[#3B82F6] transition-colors cursor-pointer"
                    >
                      {esp32ConfigOpen ? 'Скрыть настройки' : 'Настроить ESP32'}
                    </button>
                  </div>
                </div>

                {esp32ConfigOpen && (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!session || esp32Saving) return;
                      setEsp32Saving(true);
                      try {
                        const baseUrl = esp32HttpUrlInput.trim().replace(/\/+$/, '');
                        const updated = await apiUpdateEsp32Config(session, {
                          gate1HttpUrl: baseUrl ? `${baseUrl}/open?channel=1` : '',
                          gate2HttpUrl: baseUrl ? `${baseUrl}/open?channel=2` : '',
                          pulseDurationMs: Number(esp32PulseMsInput) || 600,
                          gpioGate1Pin: Number(esp32Ch1PinInput) || 18,
                          gpioGate2Pin: Number(esp32Ch2PinInput) || 19,
                          deviceToken: esp32SecretInput.trim(),
                        });
                        setEsp32Status(updated);
                        showNotice('Настройки контроллера ворот ESP32 сохранены');
                      } catch (err: any) {
                        showNotice(err?.message || 'Ошибка сохранения настроек ESP32');
                      } finally {
                        setEsp32Saving(false);
                      }
                    }}
                    className="pt-4 border-t border-slate-100 dark:border-white/[0.06] grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end"
                  >
                    <div className="space-y-1 sm:col-span-2">
                      <label className="block text-xs text-slate-400">
                        HTTP-адрес ESP32 (необязательно, если ESP32 сама опрашивает VPS)
                      </label>
                      <input
                        type="text"
                        value={esp32HttpUrlInput}
                        onChange={(e) => setEsp32HttpUrlInput(e.target.value)}
                        placeholder="Например: http://192.168.1.55 (или оставьте пустым для VPS Polling)"
                        className="w-full px-3.5 py-2 text-xs rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-xs text-slate-400">
                        Импульс нажатия (мс)
                      </label>
                      <input
                        type="number"
                        min={150}
                        max={3000}
                        value={esp32PulseMsInput}
                        onChange={(e) => setEsp32PulseMsInput(e.target.value)}
                        className="w-full px-3.5 py-2 text-xs font-mono rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="block text-xs text-slate-400">GPIO Ворота 1</label>
                        <input
                          type="number"
                          min={1}
                          max={39}
                          value={esp32Ch1PinInput}
                          onChange={(e) => setEsp32Ch1PinInput(e.target.value)}
                          className="w-full px-3 py-2 text-xs font-mono rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-xs text-slate-400">GPIO Ворота 2</label>
                        <input
                          type="number"
                          min={1}
                          max={39}
                          value={esp32Ch2PinInput}
                          onChange={(e) => setEsp32Ch2PinInput(e.target.value)}
                          className="w-full px-3 py-2 text-xs font-mono rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={esp32Saving}
                      className="px-4 py-2 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold transition-colors cursor-pointer"
                    >
                      {esp32Saving ? 'Сохранение...' : 'Сохранить'}
                    </button>
                  </form>
                )}

                {esp32SketchOpen && (
                  <div className="pt-4 border-t border-slate-100 dark:border-white/[0.06] space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                        Готовый скетч Arduino IDE для ESP32 (работает даже за домашним Wi-Fi без белого IP — опрашивает ваш сервер по /api/eg/esp32/poll)
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const sketch = `// Open-Key ESP32 Gate Remote Relay Controller
#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
const char* SERVER_POLL_URL = "${typeof window !== 'undefined' ? window.location.origin : 'http://YOUR_VPS_IP:3000'}/api/eg/esp32/poll";

const int PIN_GATE_1 = ${esp32Status?.config?.gpioGate1Pin || 18}; // Кнопка 1 пульта (Камера фасад 1)
const int PIN_GATE_2 = ${esp32Status?.config?.gpioGate2Pin || 19}; // Кнопка 2 пульта (Камера фасад 2)
const int PULSE_MS = ${esp32Status?.config?.pulseDurationMs || 600};

void pressRemoteButton(int pin, int durationMs) {
  digitalWrite(pin, HIGH);
  delay(durationMs);
  digitalWrite(pin, LOW);
}

void setup() {
  pinMode(PIN_GATE_1, OUTPUT);
  pinMode(PIN_GATE_2, OUTPUT);
  digitalWrite(PIN_GATE_1, LOW);
  digitalWrite(PIN_GATE_2, LOW);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(SERVER_POLL_URL);
    if (http.GET() == 200) {
      String body = http.getString();
      if (body.indexOf("\\"channel\\":1") >= 0) pressRemoteButton(PIN_GATE_1, PULSE_MS);
      if (body.indexOf("\\"channel\\":2") >= 0) pressRemoteButton(PIN_GATE_2, PULSE_MS);
    }
    http.end();
  }
  delay(700);
}`;
                          navigator.clipboard.writeText(sketch);
                          showNotice('Код прошивки ESP32 скопирован в буфер обмена');
                        }}
                        className="px-3 py-1 rounded-lg bg-[#2563EB]/10 text-[#2563EB] dark:text-[#3B82F6] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        <span>Скопировать скетч</span>
                      </button>
                    </div>
                    <pre className="p-3.5 rounded-xl bg-slate-900 text-slate-100 text-[11px] font-mono overflow-x-auto leading-relaxed">
{`// Подключение пульта ворот к ESP32 через 2 оптопары PC817 или 2-канальное реле:
// GPIO ${esp32Status?.config?.gpioGate1Pin || 18} -> Кнопка 1 на пульте («Камера фасад 1 - 3-Й Мкр 6 б»)
// GPIO ${esp32Status?.config?.gpioGate2Pin || 19} -> Кнопка 2 на пульте («Камера фасад 2 - 3-Й Мкр 6 б»)
// Эндпоинт опроса команд для ESP32: GET ${typeof window !== 'undefined' ? window.location.origin : ''}/api/eg/esp32/poll`}
                    </pre>
                  </div>
                )}
              </div>

              {/* Personal Self-Hosted Guest Passes Card */}
              <div className="p-6 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-bold">Личный гостевой пропуск</h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Ваши персональные ссылки через собственный сервер — работают независимо от тарифов оператора связи
                    </p>
                  </div>
                </div>

                <form onSubmit={handleCreatePass} className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                    <div className="space-y-1">
                      <label htmlFor="pass-label-input" className="block text-xs text-slate-400">
                        Название (необязательно)
                      </label>
                      <input
                        id="pass-label-input"
                        type="text"
                        value={passLabel}
                        onChange={(e) => setPassLabel(e.target.value)}
                        placeholder="Например: Курьер, Гости, Мастер"
                        className="w-full px-3.5 py-2 text-xs bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 rounded-xl focus:outline-none focus:border-[#2563EB]"
                      />
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="ttl-select" className="block text-xs text-slate-400">
                        Срок действия ссылки
                      </label>
                      <select
                        id="ttl-select"
                        value={selectedTtl}
                        onChange={(e) => setSelectedTtl(e.target.value)}
                        className="w-full px-3.5 py-2 text-xs bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 rounded-xl focus:outline-none focus:border-[#2563EB]"
                      >
                        <option value="3600">1 час</option>
                        <option value="14400">4 часа</option>
                        <option value="43200">12 часов</option>
                        <option value="86400">24 часа (сутки)</option>
                        <option value="604800">7 дней</option>
                        <option value="2592000">30 дней</option>
                      </select>
                    </div>

                    <button
                      type="submit"
                      disabled={passesLoading}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold bg-[#2563EB] hover:bg-blue-700 text-white rounded-xl transition-colors cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                      <span>{passesLoading ? 'Создание...' : 'Создать личную ссылку'}</span>
                    </button>
                  </div>

                  {tempPassAcs.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-xs text-slate-400">
                        Какие двери и калитки можно открыть по ссылке:
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {tempPassAcs.map((ac) => {
                          const key = `${ac.id}:${ac.entranceId || ''}`;
                          const checked = selectedPassControlKeys.includes(key);
                          const matchedCam = getLinkedCameraForPassControl(ac, currentPlaceForSettings);
                          const acLabel = matchedCam?.name || ac.name;
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={() => {
                                setSelectedPassControlKeys((prev) =>
                                  prev.includes(key)
                                    ? prev.length > 1
                                      ? prev.filter((k) => k !== key)
                                      : prev
                                    : [...prev, key]
                                );
                              }}
                              className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors inline-flex items-center gap-1.5 cursor-pointer ${
                                checked
                                  ? 'bg-[#2563EB]/10 border-[#2563EB]/40 text-[#2563EB] dark:text-blue-300'
                                  : 'bg-slate-50 dark:bg-[#12161f] border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400'
                              }`}
                            >
                              <Check className={`w-3.5 h-3.5 ${checked ? 'opacity-100' : 'opacity-25'}`} />
                              <span>{acLabel}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </form>

                {tempPasses.length > 0 && (
                  <div className="space-y-2.5 pt-2 border-t border-slate-100 dark:border-white/[0.06]">
                    {tempPasses.map((pass) => {
                      const passIdStr = String(pass.id);
                      const linkStr = String(pass.sharedLinkMessage || '');
                      let parsedToken = '';
                      try {
                        if (linkStr) {
                          parsedToken = new URL(linkStr).searchParams.get('guestPass') || '';
                        }
                      } catch {
                        // ignore
                      }
                      const expDate = pass.expiredAt ? new Date(Number(pass.expiredAt)) : null;
                      const expLabel =
                        expDate && !isNaN(expDate.getTime())
                          ? expDate.toLocaleString('ru-RU', {
                              day: '2-digit',
                              month: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '';
                      const doorsSummary =
                        pass.availableAccessControl && pass.availableAccessControl.length > 0
                          ? pass.availableAccessControl
                              .map((a) => {
                                const matchedCam = getLinkedCameraForPassControl(a, currentPlaceForSettings);
                                return matchedCam?.name || a.name;
                              })
                              .join(' · ')
                          : 'Все доступные двери';

                      return (
                        <div
                          key={passIdStr}
                          className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/[0.06] flex flex-wrap items-center justify-between gap-3 text-xs"
                        >
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-slate-900 dark:text-white">
                                {pass.label ? pass.label : `Личная ссылка #${passIdStr}`}
                              </span>
                              {expLabel && (
                                <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
                                  до {expLabel}
                                </span>
                              )}
                              {typeof pass.openCount === 'number' && pass.openCount > 0 && (
                                <span className="text-[11px] text-slate-400">
                                  · Открытий: {pass.openCount}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-400 truncate">
                              {doorsSummary}
                            </div>
                            <div className="truncate max-w-xl font-mono text-[11px] text-slate-500 dark:text-slate-400">
                              {linkStr || `Пропуск #${passIdStr}`}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            {parsedToken && (
                              <button
                                type="button"
                                onClick={() => setActiveGuestPassToken(parsedToken)}
                                className="px-3 py-1.5 rounded-lg bg-[#2563EB]/10 hover:bg-[#2563EB]/20 text-[#2563EB] dark:text-[#3B82F6] font-medium inline-flex items-center gap-1.5 cursor-pointer"
                              >
                                <Unlock className="w-3.5 h-3.5" />
                                <span>Открыть</span>
                              </button>
                            )}
                            {linkStr && (
                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard.writeText(linkStr);
                                  setCopiedPassId(passIdStr);
                                  setTimeout(() => setCopiedPassId(null), 2000);
                                }}
                                className="px-3 py-1.5 rounded-lg bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/10 font-medium inline-flex items-center gap-1.5 cursor-pointer"
                              >
                                <Copy className="w-3.5 h-3.5" />
                                <span>
                                  {copiedPassId === passIdStr ? 'Скопировано' : 'Копировать'}
                                </span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleRevokePass(pass.id)}
                              className="px-3 py-1.5 rounded-lg bg-rose-500/10 text-rose-500 font-medium inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>Удалить</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* =============================================================== */}
          {/* SECTION: ПОЛЬЗОВАТЕЛИ И АДРЕСА                                  */}
          {/* =============================================================== */}
          {activeSection === 'users' && isSubscriptionRestricted && (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] max-w-2xl space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center">
                <Lock className="w-6 h-6" />
              </div>
              <h1 className="text-xl font-bold font-display">Раздел «Пользователи и адреса» заблокирован</h1>
              <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                Управление профилем и гостевым доступом отключено при неоплаченной или заблокированной подписке. Доступен только онлайн-просмотр камер.
              </p>
              <div className="flex flex-wrap gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setActiveSection('settings')}
                  className="px-4 py-2.5 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold cursor-pointer transition-colors"
                >
                  Оплатить подписку
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSection('cameras')}
                  className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.1] text-slate-800 dark:text-slate-200 text-xs font-semibold cursor-pointer transition-colors"
                >
                  Смотреть камеры онлайн
                </button>
              </div>
            </div>
          )}

          {activeSection === 'users' && !isSubscriptionRestricted && (
            <div className="space-y-6 max-w-3xl">
              <div>
                <h1 className="text-2xl font-bold font-display">Пользователи и адреса</h1>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  Данные профиля абонента, подключённые объекты и управление гостевым доступом
                </p>
              </div>

              <div className="p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-white/[0.06]">
                  <div>
                    <div className="text-base font-bold text-slate-900 dark:text-white">
                      {session.subscriber?.name || subscriberFirstName}
                    </div>
                    <div className="text-xs text-slate-400 font-mono tabular-nums mt-0.5">
                      {session.phone || 'Телефон подключён'} · Л/С{' '}
                      {session.subscriber?.accountId || session.userAgent?.account_id || '—'}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setActiveSection('access')}
                    className="px-4 py-2 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold transition-colors cursor-pointer"
                  >
                    Создать гостевой доступ
                  </button>
                </div>

                <div className="space-y-2.5">
                  <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                    Подключённые адреса ({places.length})
                  </div>
                  {places.length === 0 ? (
                    <div className="text-xs text-slate-400">Адреса ещё не загружены.</div>
                  ) : (
                    <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                      {places.map((p) => {
                        const bal = balances[p.id];
                        return (
                          <div
                            key={p.id}
                            className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs"
                          >
                            <div>
                              <div className="font-semibold text-slate-900 dark:text-slate-100">
                                {p.address}
                              </div>
                              <div className="text-slate-400 mt-0.5">
                                {p.subscriberType === 'OWNER' ? 'Владелец договора' : 'Жилец'} · Статус:{' '}
                                {p.subscriberState || 'ACTIVE'}
                              </div>
                            </div>
                            <div className="font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-200">
                              {typeof bal?.balance === 'number'
                                ? `${bal.balance.toFixed(2)} ₽`
                                : 'Подключён'}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* =============================================================== */}
          {/* SECTION: НАСТРОЙКИ                                              */}
          {/* =============================================================== */}
          {activeSection === 'settings' && (
            <div className="space-y-6 max-w-3xl">
              <h1 className="text-2xl font-bold font-display">Настройки и подписка</h1>

              {/* Commercial Subscription & Balance Card (50 RUB/month) */}
              {billingMe && (
                <div className="p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-5">
                  <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-100 dark:border-white/[0.06]">
                    <div className="space-y-1">
                      <div className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <Wallet className="w-4 h-4 text-[#2563EB] dark:text-[#3B82F6]" />
                        <span>Подписка Open-Key ({billingMe.config.monthlyPriceRub} ₽ / 30 дней)</span>
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {billingMe.user.status === 'active'
                          ? `Активна до ${new Date(billingMe.user.paidUntil || Date.now()).toLocaleDateString('ru-RU')}`
                          : billingMe.user.status === 'trial'
                            ? `Пробный период до ${new Date(billingMe.user.trialEndsAt).toLocaleDateString('ru-RU')}`
                            : billingMe.user.status === 'blocked'
                              ? 'Доступ ограничен администратором'
                              : 'Срок действия истёк — пополните баланс или продлите подписку'}
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-[11px] text-slate-400">Баланс сервиса</div>
                      <div className="text-xl font-bold text-slate-900 dark:text-white font-mono tabular-nums">
                        {billingMe.user.balanceRub.toFixed(0)} ₽
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                    <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={billingMe.user.autoRenew}
                        disabled={billingBusy}
                        onChange={handleToggleBillingAutoRenew}
                        className="w-4 h-4 accent-[#2563EB] rounded cursor-pointer"
                      />
                      <span className="text-slate-700 dark:text-slate-200 font-medium">
                        Автопродление ({billingMe.config.monthlyPriceRub} ₽ раз в 30 дней при наличии на балансе)
                      </span>
                    </label>

                    <button
                      type="button"
                      disabled={billingBusy || billingMe.user.balanceRub < billingMe.config.monthlyPriceRub}
                      onClick={handleRenewSubscription}
                      className="px-4 py-2 rounded-xl bg-[#2563EB] hover:bg-blue-700 disabled:opacity-45 text-white font-semibold transition-colors cursor-pointer"
                    >
                      Продлить на 30 дней за {billingMe.config.monthlyPriceRub} ₽
                    </button>
                  </div>

                  {/* Topup via YuKassa Form */}
                  <form
                    onSubmit={handleRequestTopup}
                    className="pt-4 border-t border-slate-100 dark:border-white/[0.06] space-y-3 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-semibold text-slate-900 dark:text-white">
                        Пополнить баланс через ЮKassa (Карта / СБП / SberPay)
                      </div>
                      <span className="text-[11px] text-slate-400">
                        {billingMe.config.yookassaEnabled
                          ? 'Мгновенное зачисление · чек НПД'
                          : 'Ожидает настройки ключей ЮKassa в .env'}
                      </span>
                    </div>
                    <div className="text-slate-500 dark:text-slate-400 leading-relaxed">
                      Оплата картой РФ, через СБП или SberPay. Электронный чек «Мой налог» формируется автоматически.
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {[50, 150, 300, 600].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setTopupAmountInput(String(preset))}
                          className={`px-3 py-1.5 rounded-lg font-mono tabular-nums font-semibold border transition-colors cursor-pointer ${
                            Number(topupAmountInput) === preset
                              ? 'bg-[#2563EB] border-[#2563EB] text-white'
                              : 'bg-slate-50 dark:bg-[#12161f] border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-200'
                          }`}
                        >
                          {preset} ₽
                        </button>
                      ))}
                      <input
                        type="number"
                        min={10}
                        max={50000}
                        value={topupAmountInput}
                        onChange={(e) => setTopupAmountInput(e.target.value)}
                        className="w-24 px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 font-mono tabular-nums focus:outline-none"
                      />
                      <input
                        type="text"
                        value={topupCommentInput}
                        onChange={(e) => setTopupCommentInput(e.target.value)}
                        placeholder="Комментарий к платежу (необяз.)"
                        className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={billingBusy}
                        className="px-4 py-1.5 rounded-lg bg-[#2563EB] hover:bg-blue-700 text-white font-semibold transition-colors cursor-pointer whitespace-nowrap"
                      >
                        Оплатить через ЮKassa
                      </button>
                    </div>
                  </form>

                  {/* User Personal Transactions */}
                  {billingMe.transactions.length > 0 && (
                    <div className="pt-4 border-t border-slate-100 dark:border-white/[0.06] space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[11px] font-semibold text-slate-400">
                          История операций и чеки «Мой налог»
                        </div>
                        {billingMe.transactions.some(
                          (t) => t.status === 'pending' && Boolean(t.yookassaPaymentId)
                        ) && (
                          <button
                            type="button"
                            disabled={billingBusy}
                            onClick={() => handleCheckPendingPayments()}
                            className="text-[11px] font-semibold text-[#2563EB] dark:text-[#3B82F6] hover:underline cursor-pointer"
                          >
                            Проверить оплату
                          </button>
                        )}
                      </div>
                      <div className="divide-y divide-slate-100 dark:divide-white/[0.06] max-h-48 overflow-y-auto">
                        {billingMe.transactions.slice(0, 10).map((tx) => (
                          <div
                            key={tx.id}
                            className="py-2 flex items-center justify-between gap-3 text-xs"
                          >
                            <div className="min-w-0">
                              <div className="font-medium text-slate-800 dark:text-slate-200 truncate">
                                {tx.description}
                              </div>
                              <div className="text-[11px] text-slate-400 font-mono tabular-nums flex flex-wrap items-center gap-2">
                                <span>
                                  {new Date(tx.createdAt).toLocaleDateString('ru-RU')} ·{' '}
                                  {tx.status === 'pending'
                                    ? 'Ожидает оплаты'
                                    : tx.status === 'rejected'
                                      ? 'Отклонено'
                                      : tx.npdReceiptNumber
                                        ? `Чек НПД № ${tx.npdReceiptNumber}`
                                        : 'Проведено'}
                                </span>
                                {tx.status === 'pending' && tx.confirmationUrl && (
                                  <a
                                    href={tx.confirmationUrl}
                                    className="text-[#2563EB] dark:text-[#3B82F6] underline font-sans font-semibold"
                                  >
                                    Перейти к оплате
                                  </a>
                                )}
                              </div>
                            </div>
                            <span
                              className={`font-mono tabular-nums font-bold shrink-0 ${
                                tx.amountRub > 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-slate-700 dark:text-slate-300'
                              }`}
                            >
                              {tx.amountRub > 0 ? `+${tx.amountRub}` : tx.amountRub} ₽
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-bold">Тема оформления</div>
                    <div className="text-xs text-slate-400">
                      Мгновенное переключение между светлой и тёмной темой
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={toggleTheme}
                    className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-[#232b3a] text-xs font-semibold flex items-center gap-2 cursor-pointer"
                  >
                    {theme === 'dark' ? (
                      <>
                        <Sun className="w-4 h-4 text-amber-400" />
                        <span>Включить светлую тему</span>
                      </>
                    ) : (
                      <>
                        <Moon className="w-4 h-4 text-slate-700" />
                        <span>Включить тёмную тему</span>
                      </>
                    )}
                  </button>
                </div>

                {(dndByPlace[currentPlaceForSettings] || []).map((item) => (
                  <div
                    key={item.type}
                    className="pt-4 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-between gap-4"
                  >
                    <div>
                      <div className="text-sm font-medium flex items-center gap-2">
                        <BellOff className="w-4 h-4 text-slate-400" />
                        <span>{item.name}</span>
                      </div>
                      {item.hint && <p className="text-xs text-slate-400 mt-0.5">{item.hint}</p>}
                    </div>
                    <button
                      type="button"
                      disabled={isSubscriptionRestricted}
                      onClick={() => handleToggleDnd(currentPlaceForSettings, item.type)}
                      className={`px-3.5 py-1.5 text-xs font-semibold rounded-xl cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                        item.status
                          ? 'bg-[#2563EB] text-white'
                          : 'bg-slate-100 dark:bg-[#232b3a] text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {isSubscriptionRestricted
                        ? 'Недоступно'
                        : item.status
                          ? 'Включён'
                          : 'Выключен'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* =============================================================== */}
          {/* SECTION: О СЕРВИСЕ, РЕКВИЗИТЫ И ТЕХПОДДЕРЖКА                    */}
          {/* =============================================================== */}
          {activeSection === 'about' && (
            <ServiceAboutPage
              config={billingMe?.config}
              session={session}
              onNavigateSettings={() => setActiveSection('settings')}
              onNavigateAdmin={() => setActiveSection('admin')}
              canAccessAdmin={billingMe?.user?.role === 'admin'}
              onNotice={showNotice}
            />
          )}

          {/* =============================================================== */}
          {/* SECTION: АДМИН-ПАНЕЛЬ                                           */}
          {/* =============================================================== */}
          {activeSection === 'admin' && billingMe?.user?.role === 'admin' && (
            <AdminPanel
              session={session}
              onNotice={showNotice}
              onBillingUpdated={refreshBillingMe}
            />
          )}

          {/* Global Footer with Requisites Link */}
          <footer className="pt-6 pb-2 border-t border-slate-200/70 dark:border-white/[0.06] flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400 dark:text-slate-500">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span>© Open-Key (open-key.ru)</span>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              {billingMe?.config?.supportEmail && (
                <a
                  href={`mailto:${billingMe.config.supportEmail}`}
                  className="hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
                >
                  {billingMe.config.supportEmail}
                </a>
              )}
              <button
                type="button"
                onClick={() => setActiveSection('about')}
                className="text-slate-600 dark:text-slate-300 hover:text-[#2563EB] dark:hover:text-[#3B82F6] underline underline-offset-2 transition-colors cursor-pointer"
              >
                О сервисе, реквизиты и поддержка
              </button>
            </div>
          </footer>
        </main>
      </div>

      {/* =================================================================== */}
      {/* MOBILE BOTTOM NAVIGATION BAR (Matches Mobile Mockup 1:1)            */}
      {/* =================================================================== */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white/95 dark:bg-[#0f131a]/95 backdrop-blur-md border-t border-slate-200/80 dark:border-white/[0.07] px-2 py-2 flex items-center justify-around">
        <button
          type="button"
          onClick={() => {
            setActiveSection('overview');
            setMobileMoreOpen(false);
          }}
          className={`flex flex-col items-center gap-1 px-3 py-1 rounded-xl text-[11px] font-medium cursor-pointer ${
            activeSection === 'overview' && !mobileMoreOpen
              ? 'text-[#2563EB] dark:text-[#3B82F6]'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          <Home className="w-5 h-5" />
          <span>Главная</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveSection('cameras');
            setMobileMoreOpen(false);
          }}
          className={`flex flex-col items-center gap-1 px-3 py-1 rounded-xl text-[11px] font-medium cursor-pointer ${
            activeSection === 'cameras' && !mobileMoreOpen
              ? 'text-[#2563EB] dark:text-[#3B82F6]'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          <CctvCameraIcon className="w-5 h-5" />
          <span>Камеры</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveSection('video');
            setMobileMoreOpen(false);
          }}
          className={`flex flex-col items-center gap-1 px-3 py-1 rounded-xl text-[11px] font-medium cursor-pointer ${
            activeSection === 'video' && !mobileMoreOpen
              ? 'text-[#2563EB] dark:text-[#3B82F6]'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          <Archive className="w-5 h-5" />
          <span>Архив</span>
        </button>

        <button
          type="button"
          onClick={() => setMobileMoreOpen((o) => !o)}
          className={`flex flex-col items-center gap-1 px-3 py-1 rounded-xl text-[11px] font-medium cursor-pointer ${
            mobileMoreOpen ||
            ['access', 'users', 'settings', 'about', 'admin'].includes(activeSection)
              ? 'text-[#2563EB] dark:text-[#3B82F6]'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          <MoreHorizontal className="w-5 h-5" />
          <span>Ещё</span>
        </button>
      </nav>

      {/* Mobile "Ещё" Sheet */}
      {mobileMoreOpen && (
        <div
          className="md:hidden fixed inset-0 z-30 bg-black/50 flex items-end"
          onClick={() => setMobileMoreOpen(false)}
        >
          <div
            className="w-full bg-white dark:bg-[#1a202c] rounded-t-3xl p-5 pb-24 space-y-2 border-t border-slate-200 dark:border-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-xs font-bold text-slate-400 px-2 pb-1">Разделы</div>
            {sidebarItems.slice(3).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveSection(item.id);
                  setMobileMoreOpen(false);
                }}
                className={`w-full px-3.5 py-3 rounded-xl text-sm font-medium flex items-center gap-3 ${
                  activeSection === item.id
                    ? 'bg-[#2563EB]/15 text-[#2563EB] dark:text-[#3B82F6]'
                    : 'text-slate-800 dark:text-slate-200'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Fullscreen Snapshot Lightbox Modal */}
      {lightboxCamera && (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4 sm:p-8"
          onClick={() => setLightboxCamera(null)}
        >
          <div
            className="max-w-5xl w-full bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/10 rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-slate-200 dark:border-white/10">
              <div>
                <h3 className="text-sm font-bold">{lightboxCamera.camera.name}</h3>
                <p className="text-xs text-slate-400 font-mono tabular-nums">
                  ID {lightboxCamera.camera.id} · {lightboxCamera.camera.placeAddress}
                  {lightboxCamera.camera.originalName &&
                  lightboxCamera.camera.originalName !== lightboxCamera.camera.name
                    ? ` · Исходное: ${lightboxCamera.camera.originalName}`
                    : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const cam = lightboxCamera.camera;
                    setLightboxCamera(null);
                    handleSelectCameraForVideo(cam, 'live');
                  }}
                  className="px-3 py-1.5 text-xs font-semibold bg-[#2563EB] hover:bg-blue-700 text-white rounded-lg transition-colors cursor-pointer"
                >
                  К видеопотоку
                </button>
                <button
                  type="button"
                  onClick={() => setLightboxCamera(null)}
                  className="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="aspect-video w-full bg-slate-950">
              {session.mode === 'live' && lightboxCamera.url ? (
                <img
                  src={lightboxCamera.url}
                  alt={lightboxCamera.camera.name}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain"
                />
              ) : (
                <ProceduralCameraCanvas
                  cameraId={lightboxCamera.camera.id}
                  cameraName={lightboxCamera.camera.name}
                  scene={lightboxCamera.camera.demoScene || 'entrance'}
                  animated={false}
                  refreshTick={snapshotRefreshTick}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Guest Pass Portal Modal */}
      {activeGuestPassToken && (
        <GuestPassPortal
          token={activeGuestPassToken}
          onClose={() => setActiveGuestPassToken(null)}
        />
      )}
    </div>
  );
}
