import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowUpRight,
  BellOff,
  Camera,
  Check,
  ChevronRight,
  KeyRound,
  Lock,
  Maximize2,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Unlock,
  X,
} from 'lucide-react';
import {
  BalanceInfo,
  BillingMePayload,
  CameraItem,
  DndItem,
  DoorActionLog,
  EgSession,
  HistoryEventItem,
  LockItem,
  PlaceItem,
} from '../types/eg';
import {
  CctvCameraIcon,
  DoorOutlineIcon,
  GateOutlineIcon,
} from './DomRuBrandLogo';
import { CameraFeedPlayer } from './CameraFeedPlayer';
import { CachedCameraImage } from './CachedCameraImage';

interface OverviewDashboardProps {
  session: EgSession;
  places: PlaceItem[];
  selectedPlaceId: string;
  onSelectPlace: (placeId: string) => void;
  balances: Record<string, BalanceInfo>;
  billingMe?: BillingMePayload | null;
  dndByPlace: Record<string, DndItem[]>;
  cameras: CameraItem[];
  locks: LockItem[];
  doorLogs: DoorActionLog[];
  placeHistory: HistoryEventItem[];
  placeHistoryHasMore?: boolean;
  placeHistoryLoadingMore?: boolean;
  onLoadMoreHistory?: () => void;
  unlockingMap: Record<string, boolean>;
  unlockedMap: Record<string, boolean>;
  onOpenLock: (lock: LockItem) => void;
  onNavigateCameras: () => void;
  onNavigateCameraArchive: (camera: CameraItem) => void;
  onOpenHistoryEvent: (ev: HistoryEventItem) => void;
  onOpenDoorLog: (log: DoorActionLog) => void;
  onNavigateArchive: () => void;
  onNavigateAccess: () => void;
  onNavigateSettings: () => void;
  onRenameCamera?: (camera: CameraItem, newName: string) => Promise<void> | void;
  onNotice: (msg: string) => void;
  isRestricted?: boolean;
  restrictionMode?: 'none' | 'no_funds' | 'full_blocked';
}

interface TimelineRow {
  id: string;
  tsMs: number;
  timeLabel: string;
  dateLabel: string;
  kind: 'door' | 'gate' | 'call' | 'info' | 'error';
  title: string;
  subtitle: string;
  historyEvent?: HistoryEventItem;
  doorLog?: DoorActionLog;
  playable: boolean;
}

function normalizeTsMs(rawTs: number): number {
  if (!Number.isFinite(rawTs) || rawTs <= 0) return Date.now();
  return rawTs < 1e12 ? rawTs * 1000 : rawTs;
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDayShort(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) return 'Сегодня';
  const yesterday = new Date(now.getTime() - 86400000);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return 'Вчера';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

function formatRub(amount: number): string {
  const n = Number(amount || 0);
  if (!Number.isFinite(n)) return '0';
  return Math.abs(n - Math.round(n)) < 0.005 ? String(Math.round(n)) : n.toFixed(2);
}

function isGateLike(name: string, kind?: string): boolean {
  if (kind === 'gate' || kind === 'barrier') return true;
  const n = name.toLowerCase();
  return n.includes('ворот') || n.includes('калитк') || n.includes('шлагбаум');
}

function isGateOnlyLock(lock: LockItem, linkedCam?: CameraItem | null): boolean {
  if (
    lock.controllerType === 'esp32' ||
    lock.entranceId?.startsWith('esp32_gate_') ||
    lock.accessControlId === '990001' ||
    lock.accessControlId === '990002' ||
    lock.kind === 'barrier'
  ) {
    return true;
  }
  const origName = String(linkedCam?.originalName || lock.name || '').toLowerCase();
  if (lock.kind === 'gate' && !origName.includes('калитк')) return true;
  return /ворот|шлагбаум|фасад/.test(origName);
}

function isEntranceOrWicketCamera(cam: CameraItem): boolean {
  const orig = String(cam.originalName || cam.name || '').toLowerCase();
  if (/фасад|ворот|шлагбаум/.test(orig)) return false;
  if (cam.source === 'intercom') return true;
  return /калитк|подъезд|домофон|входная|\(\s*п\.?\s*\d+\s*\)|\bп\.\s*\d+\b/.test(orig);
}

function getPrimaryCameraRank(cam: CameraItem, linkedLock: LockItem | null): number {
  const n = (cam.originalName || cam.name).toLowerCase();
  if (n.includes('калитк') && n.includes('1')) return 1;
  if (n.includes('калитк') && n.includes('2')) return 2;
  if (n.includes('калитк')) return 3;
  if (n.includes('п. 2') || n.includes('п.2') || n.includes('подъезд')) return 4;
  if (n.includes('фасад 1') || n.includes('фасад №1') || linkedLock?.esp32Channel === 1) return 5;
  if (n.includes('фасад 2') || n.includes('фасад №2') || linkedLock?.esp32Channel === 2) return 6;
  if (cam.source === 'intercom') return 7;
  if (cam.allowOpen || linkedLock?.openable) return 8;
  return 99;
}

function getCameraShortBadge(cam: CameraItem, linkedLock: LockItem | null): string {
  const n = (cam.originalName || cam.name).toLowerCase();
  if (
    linkedLock?.controllerType === 'esp32' ||
    cam.entranceId?.startsWith('esp32_gate_') ||
    n.includes('фасад 1') ||
    n.includes('фасад 2')
  ) {
    const ch =
      linkedLock?.esp32Channel ||
      (n.includes('фасад 2') || cam.entranceId === 'esp32_gate_2' ? 2 : 1);
    return `Ворота ${ch}`;
  }
  if (n.includes('калитк')) return 'Калитка · Домофон';
  if (n.includes('п. 2') || n.includes('п.2') || n.includes('подъезд') || cam.source === 'intercom') {
    return 'Подъезд · Домофон';
  }
  return 'Камера';
}

export const OverviewDashboard: React.FC<OverviewDashboardProps> = ({
  session,
  places,
  selectedPlaceId,
  onSelectPlace,
  balances,
  billingMe,
  dndByPlace,
  cameras,
  locks,
  doorLogs,
  placeHistory,
  placeHistoryHasMore = false,
  placeHistoryLoadingMore = false,
  onLoadMoreHistory,
  unlockingMap,
  unlockedMap,
  onOpenLock,
  onNavigateCameras,
  onNavigateCameraArchive,
  onOpenHistoryEvent,
  onOpenDoorLog,
  onNavigateArchive,
  onNavigateAccess,
  onNavigateSettings,
  onRenameCamera,
  onNotice,
  isRestricted = false,
  restrictionMode,
}) => {
  const effectiveMode: 'none' | 'no_funds' | 'full_blocked' =
    restrictionMode ?? (isRestricted ? 'full_blocked' : 'none');
  const isFullBlocked = effectiveMode === 'full_blocked';
  const isNoFundsLimited = effectiveMode === 'no_funds';
  const effectiveRestricted = isFullBlocked || isNoFundsLimited;

  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [liveStreamActive, setLiveStreamActive] = useState<boolean>(false);
  const [fullscreenOpen, setFullscreenOpen] = useState<boolean>(false);
  const [snapTick, setSnapTick] = useState<number>(1);
  const [resolvedSnapshotUrl, setResolvedSnapshotUrl] = useState<string | null>(null);
  const [isEditingActiveName, setIsEditingActiveName] = useState<boolean>(false);
  const [draftActiveName, setDraftActiveName] = useState<string>('');
  const [savingActiveName, setSavingActiveName] = useState<boolean>(false);

  const findLinkedLock = useMemo(() => {
    return (cam: CameraItem | null): LockItem | null => {
      if (!cam) return null;
      return (
        locks.find(
          (l) =>
            l.externalCameraId === cam.id ||
            (cam.entranceId &&
              l.entranceId === cam.entranceId &&
              l.placeId === cam.placeId) ||
            (cam.accessControlId &&
              l.accessControlId === cam.accessControlId &&
              !l.entranceId &&
              l.placeId === cam.placeId)
        ) || null
      );
    };
  }, [locks]);

  const findLinkedCameraForLock = useMemo(() => {
    return (lock: LockItem | null): CameraItem | null => {
      if (!lock) return null;
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
    };
  }, [cameras]);

  const canOpenLockItem = (lock: LockItem | null): boolean => {
    if (!lock || !lock.openable) return false;
    if (isFullBlocked) return false;
    if (isNoFundsLimited) {
      return !isGateOnlyLock(lock, findLinkedCameraForLock(lock));
    }
    return true;
  };

  const canViewArchiveCam = (cam: CameraItem | null): boolean => {
    if (!cam) return false;
    if (isFullBlocked) return false;
    if (isNoFundsLimited) {
      return !isEntranceOrWicketCamera(cam);
    }
    return true;
  };

  // The 5 main cameras: 2 калитки, сам подъезд, and 2 ворота ("Камера фасад 1" & "Камера фасад 2")
  const primaryCameras: CameraItem[] = useMemo(() => {
    const scored = cameras
      .map((cam) => {
        const lock = findLinkedLock(cam);
        const rank = getPrimaryCameraRank(cam, lock);
        return { cam, rank };
      })
      .filter((item) => item.rank < 99)
      .sort((a, b) => a.rank - b.rank)
      .map((item) => item.cam);

    if (scored.length > 0) return scored;
    return cameras.slice(0, 5);
  }, [cameras, findLinkedLock]);

  // Pick active camera cleanly when cameras list updates
  const activeCamera: CameraItem | null = useMemo(() => {
    if (cameras.length === 0) return null;
    return cameras.find((c) => c.id === selectedCameraId) || primaryCameras[0] || cameras[0];
  }, [cameras, primaryCameras, selectedCameraId]);

  useEffect(() => {
    if (cameras.length > 0 && (!selectedCameraId || !cameras.some((c) => c.id === selectedCameraId))) {
      setSelectedCameraId((primaryCameras[0] || cameras[0]).id);
    }
  }, [cameras, primaryCameras, selectedCameraId]);

  useEffect(() => {
    setResolvedSnapshotUrl(null);
    setLiveStreamActive(false);
    setIsEditingActiveName(false);
  }, [activeCamera?.id]);

  const isActiveCameraRenamed = Boolean(
    activeCamera?.originalName &&
      activeCamera.originalName.trim() !== activeCamera.name.trim()
  );

  const handleSaveActiveRename = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!activeCamera || !onRenameCamera || savingActiveName) return;
    const trimmed = draftActiveName.trim();
    if (!trimmed) {
      setSavingActiveName(true);
      try {
        await onRenameCamera(activeCamera, '');
        setIsEditingActiveName(false);
      } finally {
        setSavingActiveName(false);
      }
      return;
    }
    if (trimmed === activeCamera.name.trim()) {
      setIsEditingActiveName(false);
      return;
    }
    setSavingActiveName(true);
    try {
      await onRenameCamera(activeCamera, trimmed);
      setIsEditingActiveName(false);
    } finally {
      setSavingActiveName(false);
    }
  };

  const handleResetActiveRename = async () => {
    if (!activeCamera || !onRenameCamera || savingActiveName) return;
    setSavingActiveName(true);
    try {
      await onRenameCamera(activeCamera, '');
      setIsEditingActiveName(false);
    } finally {
      setSavingActiveName(false);
    }
  };

  const linkedLockForActiveCamera = useMemo(() => {
    return findLinkedLock(activeCamera);
  }, [activeCamera, findLinkedLock]);

  const openableLocks = useMemo(() => {
    return locks.filter((l) => l.openable);
  }, [locks]);

  const activePlace = useMemo(() => {
    if (selectedPlaceId !== 'all') {
      return places.find((p) => p.id === selectedPlaceId) || places[0] || null;
    }
    return places[0] || null;
  }, [places, selectedPlaceId]);

  const activeBalanceInfo: BalanceInfo | null = useMemo(() => {
    if (selectedPlaceId !== 'all') {
      return balances[selectedPlaceId] || null;
    }
    if (places.length === 1) {
      return balances[places[0].id] || null;
    }
    // Aggregate numeric balances if multiple places selected
    const entries = Object.values(balances).filter((b) => typeof b.balance === 'number');
    if (entries.length === 0) return null;
    const total = entries.reduce((sum, b) => sum + Number(b.balance || 0), 0);
    return {
      placeId: 'all',
      balance: total,
      blocked: entries.some((b) => b.blocked),
      paymentDate: entries[0]?.paymentDate || null,
      paymentSum: entries[0]?.paymentSum || null,
      company: entries[0]?.company || null,
    };
  }, [balances, places, selectedPlaceId]);

  const dndSummary = useMemo(() => {
    const pid = activePlace?.id || '';
    const items = dndByPlace[pid] || [];
    const enabledCount = items.filter((i) => i.status).length;
    return {
      total: items.length,
      enabledCount,
      isMuted: items.some((i) => i.type === 'DO_NOT_DISTURB_ROOT' && i.status),
    };
  }, [activePlace, dndByPlace]);

  // Unified real event feed: real session doorLogs + real server placeHistory
  const timelineRows: TimelineRow[] = useMemo(() => {
    const rows: TimelineRow[] = [];

    const matchCameraForHistory = (ev: HistoryEventItem): CameraItem | null => {
      if (cameras.length === 0) return null;
      if (ev.cameraId) {
        const direct = cameras.find((c) => c.id === ev.cameraId);
        if (direct) return direct;
      }
      if (ev.sourceType === 'CAMERA') {
        const bySrc = cameras.find((c) => c.id === ev.sourceId);
        if (bySrc) return bySrc;
      }
      if (ev.entranceId) {
        const byEnt = cameras.find(
          (c) => c.entranceId === ev.entranceId && c.placeId === ev.placeId
        );
        if (byEnt) return byEnt;
      }
      if (ev.accessControlId) {
        const byAc = cameras.find(
          (c) => c.accessControlId === ev.accessControlId && c.placeId === ev.placeId
        );
        if (byAc) return byAc;
      }
      const msgLower = ev.message.toLowerCase();
      const byName = cameras.find(
        (c) =>
          msgLower.includes(c.name.toLowerCase()) ||
          (c.originalName ? msgLower.includes(c.originalName.toLowerCase()) : false)
      );
      if (byName) return byName;
      return null;
    };

    const hasMatchedCameraForHistory = (ev: HistoryEventItem): boolean => {
      if (cameras.length === 0) return false;
      const matched = matchCameraForHistory(ev);
      if (matched) {
        return !isFullBlocked && (!isNoFundsLimited || !isEntranceOrWicketCamera(matched));
      }
      if (isNoFundsLimited) return false;
      // Fallback: calls / door openings at an address with cameras
      const msgLower = ev.message.toLowerCase();
      const etLower = ev.eventType.toLowerCase();
      return (
        msgLower.includes('вызов') ||
        msgLower.includes('звонок') ||
        msgLower.includes('открыт') ||
        etLower.includes('call') ||
        etLower.includes('open')
      );
    };

    for (const log of doorLogs) {
      const tsMs = normalizeTsMs(log.timestamp);
      const gate = isGateLike(log.lockName);
      const logLock = locks.find((l) => l.id === log.lockId) || null;
      const linkedCam = findLinkedCameraForLock(logLock);
      const canPlayLog =
        log.status === 'success' &&
        cameras.length > 0 &&
        !isFullBlocked &&
        (!isNoFundsLimited || (linkedCam ? !isEntranceOrWicketCamera(linkedCam) : false));
      rows.push({
        id: `door_${log.id}`,
        tsMs,
        timeLabel: formatClock(tsMs),
        dateLabel: formatDayShort(tsMs),
        kind: log.status === 'error' ? 'error' : gate ? 'gate' : 'door',
        title:
          log.status === 'error'
            ? `Ошибка открытия: ${log.lockName}`
            : `${gate ? 'Открыты ворота/калитка' : 'Открыта дверь'}: ${log.lockName}`,
        subtitle: log.placeAddress || log.message,
        doorLog: log,
        playable: canPlayLog,
      });
    }

    for (const ev of placeHistory) {
      if (selectedPlaceId !== 'all' && ev.placeId !== selectedPlaceId) continue;
      const tsMs = normalizeTsMs(ev.timestamp);
      const msgLower = ev.message.toLowerCase();
      const gate = isGateLike(ev.message);
      const isCall =
        msgLower.includes('звонок') ||
        msgLower.includes('вызов') ||
        ev.eventType.toUpperCase().includes('CALL');
      rows.push({
        id: `hist_${ev.id}`,
        tsMs,
        timeLabel: formatClock(tsMs),
        dateLabel: formatDayShort(tsMs),
        kind: isCall ? 'call' : gate ? 'gate' : 'door',
        title: ev.message,
        subtitle:
          places.find((p) => p.id === ev.placeId)?.address || 'Журнал объекта',
        historyEvent: ev,
        playable: hasMatchedCameraForHistory(ev),
      });
    }

    rows.sort((a, b) => b.tsMs - a.tsMs);
    return rows;
  }, [cameras, doorLogs, placeHistory, places, selectedPlaceId, locks, findLinkedCameraForLock, isFullBlocked, isNoFundsLimited]);

  const handleCaptureSnapshot = () => {
    if (!resolvedSnapshotUrl) {
      onNotice('Дождитесь загрузки снимка или включите прямой эфир');
      return;
    }
    const link = document.createElement('a');
    link.href = resolvedSnapshotUrl;
    link.download = `cam-${activeCamera?.id || 'frame'}-${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    onNotice('Стоп-кадр сохранён');
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* =================================================================== */}
      {/* TOP BAR: Title, Address Context & Compact Real KPI Strip            */}
      {/* =================================================================== */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3 sm:gap-4">
        <div className="space-y-0.5 sm:space-y-1 min-w-0">
          <h1 className="text-xl sm:text-[28px] font-bold tracking-tight text-slate-900 dark:text-white font-display">
            Обзор
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-slate-500 dark:text-slate-400">
            {places.length > 1 ? (
              <select
                aria-label="Выбрать объект"
                value={selectedPlaceId}
                onChange={(e) => onSelectPlace(e.target.value)}
                className="bg-transparent font-medium text-slate-700 dark:text-slate-300 border-b border-slate-300 dark:border-white/15 pb-0.5 focus:outline-none cursor-pointer max-w-full truncate"
              >
                <option value="all" className="bg-white dark:bg-[#1a202c]">
                  Все адреса ({places.length})
                </option>
                {places.map((p) => (
                  <option key={p.id} value={p.id} className="bg-white dark:bg-[#1a202c]">
                    {p.address}
                  </option>
                ))}
              </select>
            ) : (
              <span className="truncate">
                {activePlace?.address || 'Подключённый объект'}
              </span>
            )}
          </div>
        </div>

        {/* Clean compact stats bar — zero nested cards inside cards */}
        <div className="flex flex-wrap items-center gap-4 sm:gap-7 px-3.5 py-2 sm:px-5 sm:py-3 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06]">
          <div className="space-y-0.5">
            <div className="text-[10px] sm:text-[11px] font-medium text-slate-400">Камеры</div>
            <button
              type="button"
              onClick={onNavigateCameras}
              className="text-sm sm:text-base font-bold text-slate-900 dark:text-white tabular-nums hover:text-[#2563EB] dark:hover:text-[#3B82F6] transition-colors cursor-pointer"
            >
              {cameras.length}
            </button>
          </div>

          <div className="h-6 sm:h-7 w-px bg-slate-200 dark:bg-white/[0.08]" />

          <div className="space-y-0.5">
            <div className="text-[10px] sm:text-[11px] font-medium text-slate-400">Точки доступа</div>
            <button
              type="button"
              onClick={onNavigateAccess}
              className="text-sm sm:text-base font-bold text-slate-900 dark:text-white tabular-nums hover:text-[#2563EB] dark:hover:text-[#3B82F6] transition-colors cursor-pointer"
            >
              {openableLocks.length}
            </button>
          </div>

          <div className="h-6 sm:h-7 w-px bg-slate-200 dark:bg-white/[0.08]" />

          <div className="space-y-0.5">
            <div className="text-[10px] sm:text-[11px] font-medium text-slate-400">Баланс</div>
            <div
              className={`text-sm sm:text-base font-bold tabular-nums ${
                activeBalanceInfo?.blocked
                  ? 'text-rose-500'
                  : 'text-slate-900 dark:text-white'
              }`}
            >
              {typeof activeBalanceInfo?.balance === 'number'
                ? `${activeBalanceInfo.balance.toFixed(2)} ₽`
                : 'Активен'}
            </div>
          </div>
        </div>
      </div>

      {/* =================================================================== */}
      {/* 5 MAIN CAMERAS SECTION: 2 Калитки, Подъезд и 2 Ворота (ESP32)       */}
      {/* =================================================================== */}
      {primaryCameras.length > 0 && (
        <section className="rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] p-3 sm:p-5 space-y-3 sm:space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2.5 sm:gap-3">
            <div>
              <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                Основные камеры и управление входами ({primaryCameras.length})
              </h2>
              <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">
                Калитки 1–2, подъезд и въездные ворота (Фасад 1–2)
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSnapTick(Date.now())}
                className="px-2.5 sm:px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.06] dark:hover:bg-white/[0.1] text-[11px] sm:text-xs font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                title="Обновить стоп-кадры основных камер"
              >
                <RefreshCw className="w-3.5 h-3.5 text-[#2563EB] dark:text-[#3B82F6]" />
                <span>Обновить кадры</span>
              </button>
              <button
                type="button"
                onClick={onNavigateCameras}
                className="px-2.5 sm:px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.06] dark:hover:bg-white/[0.1] text-[11px] sm:text-xs font-semibold text-[#2563EB] dark:text-[#3B82F6] inline-flex items-center gap-1 transition-colors cursor-pointer"
              >
                <span>Все камеры ({cameras.length})</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5 sm:gap-3.5">
            {primaryCameras.map((cam) => {
              const linkedLock = findLinkedLock(cam);
              const isSelectedInStage = activeCamera?.id === cam.id;
              const isUnlocked = linkedLock ? Boolean(unlockedMap[linkedLock.id]) : false;
              const isUnlocking = linkedLock ? Boolean(unlockingMap[linkedLock.id]) : false;
              const badgeLabel = getCameraShortBadge(cam, linkedLock);
              const isEsp32Gate =
                linkedLock?.controllerType === 'esp32' ||
                cam.entranceId?.startsWith('esp32_gate_');

              return (
                <div
                  key={cam.id}
                  className={`flex flex-col rounded-xl overflow-hidden border transition-all min-w-0 ${
                    isSelectedInStage
                      ? 'border-[#2563EB] ring-1 ring-[#2563EB]/30 bg-slate-50/60 dark:bg-[#1e2636]'
                      : 'border-slate-200/80 dark:border-white/[0.07] bg-white dark:bg-[#141923] hover:border-slate-300 dark:hover:border-white/15'
                  }`}
                >
                  {/* Camera Thumbnail */}
                  <div
                    onClick={() => {
                      setSelectedCameraId(cam.id);
                      setLiveStreamActive(true);
                    }}
                    className="relative aspect-video w-full bg-[#0b0f17] overflow-hidden cursor-pointer group"
                    title="Нажмите, чтобы включить прямой эфир на главном экране"
                  >
                    <CachedCameraImage
                      session={session}
                      camera={cam}
                      refreshTick={snapTick}
                      width={640}
                      height={360}
                      spinnerSize="sm"
                      doorUnlockedPulse={isUnlocked}
                      className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/25 flex flex-col justify-between p-1.5 sm:p-2.5">
                      <div className="flex items-center justify-between gap-1">
                        <span
                          className={`text-[9px] sm:text-[10px] font-semibold px-1.5 sm:px-2 py-0.5 rounded-md backdrop-blur-sm truncate ${
                            isEsp32Gate
                              ? 'bg-[#2563EB]/85 text-white'
                              : 'bg-black/60 text-white/90'
                          }`}
                        >
                          {badgeLabel}
                        </span>
                        {isSelectedInStage && liveStreamActive && (
                          <span className="text-[9px] sm:text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500 text-white shrink-0">
                            ЭФИР
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-1 opacity-95 group-hover:opacity-100">
                        <span className="inline-flex items-center gap-1 text-[10px] sm:text-[11px] font-semibold text-white bg-black/55 px-1.5 sm:px-2 py-0.5 rounded-md backdrop-blur-sm">
                          <Play className="w-2.5 h-2.5 sm:w-3 sm:h-3 fill-current text-[#3B82F6]" />
                          <span>Эфир</span>
                        </span>
                        {canViewArchiveCam(cam) && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onNavigateCameraArchive(cam);
                            }}
                            className="text-[10px] sm:text-[11px] font-medium text-white/90 hover:text-white bg-black/55 hover:bg-black/80 px-1.5 sm:px-2 py-0.5 rounded-md backdrop-blur-sm transition-colors cursor-pointer"
                          >
                            Архив
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Card Body + Open Button */}
                  <div className="p-2 sm:p-3 flex flex-col justify-between flex-1 gap-2 sm:gap-2.5">
                    <div
                      onClick={() => setSelectedCameraId(cam.id)}
                      className="cursor-pointer min-w-0"
                    >
                      <div
                        className="text-[11px] sm:text-xs font-bold text-slate-900 dark:text-white truncate"
                        title={
                          cam.originalName && cam.originalName !== cam.name
                            ? `${cam.name} (Исходное: ${cam.originalName})`
                            : cam.name
                        }
                      >
                        {cam.name}
                      </div>
                      <div className="text-[10px] sm:text-[11px] text-slate-400 truncate mt-0.5">
                        {linkedLock?.acName || cam.placeAddress}
                      </div>
                    </div>

                    {linkedLock && canOpenLockItem(linkedLock) ? (
                      <button
                        type="button"
                        disabled={isUnlocking}
                        onClick={() => onOpenLock(linkedLock)}
                        className={`w-full py-1.5 sm:py-2 px-2 sm:px-3 rounded-lg text-[11px] sm:text-xs font-semibold inline-flex items-center justify-center gap-1 sm:gap-1.5 transition-colors cursor-pointer ${
                          isUnlocked
                            ? 'bg-emerald-500 text-white'
                            : isUnlocking
                            ? 'bg-slate-200 dark:bg-white/10 text-slate-400 cursor-wait'
                            : 'bg-[#2563EB] hover:bg-blue-700 text-white'
                        }`}
                      >
                        {isUnlocked ? (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            <span>Открыто</span>
                          </>
                        ) : (
                          <>
                            <Unlock className="w-3.5 h-3.5" />
                            <span>{isUnlocking ? 'Открываем...' : 'Открыть'}</span>
                          </>
                        )}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedCameraId(cam.id);
                          setLiveStreamActive(true);
                        }}
                        className="w-full py-1.5 sm:py-2 px-2 sm:px-3 rounded-lg text-[11px] sm:text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.1] text-slate-700 dark:text-slate-200 inline-flex items-center justify-center gap-1 sm:gap-1.5 transition-colors cursor-pointer"
                      >
                        <Play className="w-3 h-3 sm:w-3.5 sm:h-3.5 fill-current text-[#2563EB] dark:text-[#3B82F6]" />
                        <span>Смотреть</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* =================================================================== */}
      {/* PRIMARY WORKSPACE: Live Camera Stage (7 cols) + Quick Locks (5 cols)*/}
      {/* =================================================================== */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* Camera Preview / Stream Stage */}
        <section className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] overflow-hidden flex flex-col">
          {/* Camera Toolbar Header */}
          <div className="px-4 sm:px-5 py-3.5 border-b border-slate-100 dark:border-white/[0.06] flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <CctvCameraIcon className="w-4 h-4 text-[#2563EB] dark:text-[#3B82F6] shrink-0" />
              {isEditingActiveName && !effectiveRestricted && activeCamera ? (
                <form
                  onSubmit={handleSaveActiveRename}
                  className="flex items-center gap-1.5 flex-1 min-w-0 max-w-md"
                >
                  <input
                    type="text"
                    value={draftActiveName}
                    onChange={(e) => setDraftActiveName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setIsEditingActiveName(false);
                      }
                    }}
                    maxLength={80}
                    autoFocus
                    disabled={savingActiveName}
                    placeholder={activeCamera.originalName || 'Название камеры'}
                    className="flex-1 min-w-0 px-2.5 py-1 text-xs font-semibold bg-slate-50 dark:bg-[#12161f] border border-[#2563EB]/60 rounded-lg text-slate-900 dark:text-white focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={savingActiveName}
                    title="Сохранить название"
                    className="p-1.5 rounded-lg bg-[#2563EB] hover:bg-blue-700 text-white transition-colors shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  {isActiveCameraRenamed && (
                    <button
                      type="button"
                      disabled={savingActiveName}
                      onClick={handleResetActiveRename}
                      title={`Вернуть исходное: ${activeCamera.originalName}`}
                      className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.12] text-slate-600 dark:text-slate-300 transition-colors shrink-0 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={savingActiveName}
                    onClick={() => setIsEditingActiveName(false)}
                    title="Отмена"
                    className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.12] text-slate-500 dark:text-slate-400 transition-colors shrink-0 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </form>
              ) : (
                <>
                  {cameras.length > 1 ? (
                    <select
                      aria-label="Выбрать камеру для обзора"
                      value={activeCamera?.id || ''}
                      onChange={(e) => setSelectedCameraId(e.target.value)}
                      className="text-sm font-bold text-slate-900 dark:text-white bg-transparent border border-slate-200 dark:border-white/10 rounded-lg px-2.5 py-1 focus:outline-none cursor-pointer truncate max-w-full"
                    >
                      {cameras.map((cam) => (
                        <option
                          key={cam.id}
                          value={cam.id}
                          className="bg-white dark:bg-[#1a202c] text-slate-900 dark:text-white"
                        >
                          {cam.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-sm font-bold text-slate-900 dark:text-white truncate">
                      {activeCamera?.name || 'Нет подключённых камер'}
                    </span>
                  )}
                  {onRenameCamera && !effectiveRestricted && activeCamera && (
                    <button
                      type="button"
                      onClick={() => {
                        setDraftActiveName(activeCamera.name);
                        setIsEditingActiveName(true);
                      }}
                      title="Переименовать выбранную камеру"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-[#2563EB] dark:hover:text-[#3B82F6] hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors shrink-0 cursor-pointer"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {linkedLockForActiveCamera && canOpenLockItem(linkedLockForActiveCamera) && (
                <button
                  type="button"
                  disabled={Boolean(unlockingMap[linkedLockForActiveCamera.id])}
                  onClick={() => onOpenLock(linkedLockForActiveCamera)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    unlockedMap[linkedLockForActiveCamera.id]
                      ? 'bg-emerald-500 text-white'
                      : 'bg-[#2563EB] hover:bg-blue-700 text-white'
                  }`}
                >
                  {unlockedMap[linkedLockForActiveCamera.id] ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Открыто</span>
                    </>
                  ) : (
                    <>
                      <Unlock className="w-3.5 h-3.5" />
                      <span>Открыть</span>
                    </>
                  )}
                </button>
              )}

              {activeCamera && canViewArchiveCam(activeCamera) && (
                <button
                  type="button"
                  onClick={() => onNavigateCameraArchive(activeCamera)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.1] text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Archive className="w-3.5 h-3.5" />
                  <span>Архив</span>
                </button>
              )}
            </div>
          </div>

          {/* Unified Video Stage */}
          <div className="relative aspect-video w-full bg-[#0b0f17] overflow-hidden flex-1 group">
            {!activeCamera ? (
              <div className="w-full h-full flex flex-col items-center justify-center text-slate-400 text-xs gap-2 p-6 text-center">
                <CctvCameraIcon className="w-8 h-8 text-slate-600" />
                <span>Камеры ещё не синхронизированы</span>
              </div>
            ) : liveStreamActive ? (
              <div className="w-full h-full [&>div]:w-full [&>div]:h-full [&>div]:rounded-none">
                <CameraFeedPlayer
                  session={session}
                  camera={activeCamera}
                  playbackMode="live"
                  doorUnlockedPulse={
                    linkedLockForActiveCamera
                      ? Boolean(unlockedMap[linkedLockForActiveCamera.id])
                      : false
                  }
                  onCaptureNotice={onNotice}
                />
              </div>
            ) : (
              <>
                <CachedCameraImage
                  session={session}
                  camera={activeCamera}
                  refreshTick={snapTick}
                  width={1280}
                  height={720}
                  spinnerSize="md"
                  doorUnlockedPulse={
                    linkedLockForActiveCamera
                      ? Boolean(unlockedMap[linkedLockForActiveCamera.id])
                      : false
                  }
                  onResolvedUrl={setResolvedSnapshotUrl}
                  className="w-full h-full object-cover"
                />

                {/* Subtle bottom gradient & hover controls matching YouTube-style player */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/15 opacity-90 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity duration-200 flex flex-col justify-between p-4 pointer-events-none">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono text-white/80 bg-black/50 px-2.5 py-1 rounded-md backdrop-blur-sm">
                      Стоп-кадр · ID {activeCamera.id}
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-3 pointer-events-auto">
                    <button
                      type="button"
                      onClick={() => setLiveStreamActive(true)}
                      className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold shadow-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Включить прямой эфир</span>
                    </button>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setSnapTick(Date.now());
                        }}
                        title="Обновить кадр"
                        className="p-2 rounded-lg bg-black/55 hover:bg-black/80 text-white transition-colors cursor-pointer"
                      >
                        <RefreshCw className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={handleCaptureSnapshot}
                        title="Скачать снимок"
                        className="p-2 rounded-lg bg-black/55 hover:bg-black/80 text-white transition-colors cursor-pointer"
                      >
                        <Camera className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setFullscreenOpen(true)}
                        title="На весь экран"
                        className="p-2 rounded-lg bg-black/55 hover:bg-black/80 text-white transition-colors cursor-pointer"
                      >
                        <Maximize2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Right Panel (5 cols): ALL Real Quick-Open Locks (Калитки, Подъезд, Ворота) */}
        <section className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] flex flex-col justify-between overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                Быстрое открытие
              </h2>
              <p className="text-[11px] text-slate-400">
                Калитки, подъезд и ворота
              </p>
            </div>
            {!effectiveRestricted && (
              <button
                type="button"
                onClick={onNavigateAccess}
                className="text-xs font-medium text-[#2563EB] hover:text-blue-700 dark:text-[#3B82F6] dark:hover:text-blue-300 inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>Управление доступом</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {isFullBlocked ? (
            <div className="flex-1 p-6 flex flex-col items-center justify-center text-center gap-3">
              <div className="w-11 h-11 rounded-2xl bg-rose-500/10 text-rose-500 flex items-center justify-center">
                <Lock className="w-5 h-5" />
              </div>
              <div className="space-y-1 max-w-xs">
                <div className="text-sm font-bold text-slate-900 dark:text-white">
                  Аккаунт полностью заблокирован
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  Открытие подъездов, калиток и ворот отключено администратором. Доступен только онлайн-просмотр камер.
                </p>
              </div>
              <button
                type="button"
                onClick={onNavigateSettings}
                className="px-4 py-2 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                Подробнее
              </button>
            </div>
          ) : (
            <div className="flex-1 divide-y divide-slate-100 dark:divide-white/[0.06] max-h-[380px] overflow-y-auto">
              {openableLocks.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">
                  Нет доступных замков для выбранного адреса.
                </div>
              ) : (
                openableLocks.map((lock) => {
                  const isUnlocked = Boolean(unlockedMap[lock.id]);
                  const isUnlocking = Boolean(unlockingMap[lock.id]);
                  const gate = isGateLike(lock.name, lock.kind);
                  const isEsp32 =
                    lock.controllerType === 'esp32' ||
                    lock.entranceId?.startsWith('esp32_gate_');
                  const linkedCam = findLinkedCameraForLock(lock);
                  const displayLockName = linkedCam?.name || lock.name;
                  const isCustomRenamed = Boolean(
                    linkedCam?.originalName &&
                      linkedCam.originalName.trim() !== linkedCam.name.trim()
                  );
                  const lockAllowed = canOpenLockItem(lock);

                  return (
                    <div
                      key={lock.id}
                      className="px-5 py-3.5 flex items-center justify-between gap-3 hover:bg-slate-50/70 dark:hover:bg-white/[0.02] transition-colors"
                    >
                      <div
                        onClick={() => {
                          if (linkedCam) {
                            setSelectedCameraId(linkedCam.id);
                          }
                        }}
                        className={`flex items-center gap-3 min-w-0 ${
                          linkedCam ? 'cursor-pointer' : ''
                        }`}
                        title={
                          linkedCam
                            ? isCustomRenamed
                              ? `Показать камеру «${linkedCam.name}» (Исходное: ${linkedCam.originalName})`
                              : `Показать камеру «${linkedCam.name}»`
                            : undefined
                        }
                      >
                        <div
                          className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                            !lockAllowed
                              ? 'bg-amber-500/10 text-amber-500'
                              : isUnlocked
                              ? 'bg-emerald-500/15 text-emerald-500'
                              : isEsp32
                              ? 'bg-[#2563EB]/10 text-[#2563EB] dark:text-[#3B82F6]'
                              : 'bg-slate-100 dark:bg-white/[0.06] text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {gate ? (
                            <GateOutlineIcon className="w-4 h-4" />
                          ) : (
                            <DoorOutlineIcon className="w-4 h-4" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                            {displayLockName}
                          </div>
                          <div className="text-[11px] text-slate-400 truncate">
                            {!lockAllowed
                              ? 'Ворота доступны после пополнения баланса'
                              : lock.acName || lock.placeAddress}
                          </div>
                        </div>
                      </div>

                      {lockAllowed ? (
                        <button
                          type="button"
                          disabled={isUnlocking}
                          onClick={() => onOpenLock(lock)}
                          className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            isUnlocked
                              ? 'bg-emerald-500 text-white'
                              : isUnlocking
                              ? 'bg-slate-200 dark:bg-white/10 text-slate-400 cursor-wait'
                              : 'bg-[#2563EB] hover:bg-blue-700 text-white'
                          }`}
                        >
                          {isUnlocking ? 'Открываем...' : isUnlocked ? 'Открыто' : 'Открыть'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={onNavigateSettings}
                          title="Для открытия ворот пополните баланс"
                          className="px-3 py-2 rounded-xl text-xs font-semibold bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                        >
                          <Lock className="w-3.5 h-3.5" />
                          <span>Оплатить</span>
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}

          <div className="px-5 py-3 bg-slate-50/70 dark:bg-white/[0.02] border-t border-slate-100 dark:border-white/[0.06] grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={onNavigateCameras}
              className="px-3 py-2 rounded-xl bg-white dark:bg-[#12161f] border border-slate-200 dark:border-white/[0.08] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-300 dark:hover:border-white/20 inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer"
            >
              <CctvCameraIcon className="w-3.5 h-3.5 text-[#2563EB] dark:text-[#3B82F6]" />
              <span>Все камеры</span>
            </button>
            <button
              type="button"
              onClick={effectiveRestricted ? onNavigateSettings : onNavigateAccess}
              className="px-3 py-2 rounded-xl bg-white dark:bg-[#12161f] border border-slate-200 dark:border-white/[0.08] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-300 dark:hover:border-white/20 inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer"
            >
              <KeyRound className="w-3.5 h-3.5 text-[#2563EB] dark:text-[#3B82F6]" />
              <span>
                {effectiveRestricted
                  ? isNoFundsLimited
                    ? 'Пополнить баланс'
                    : 'О подписке'
                  : 'Гостевой доступ'}
              </span>
            </button>
          </div>
        </section>
      </div>

      {/* =================================================================== */}
      {/* BOTTOM ROW: Real Activity Timeline (7 cols) + Account Card (5 cols) */}
      {/* =================================================================== */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* Real Event History Feed */}
        <section className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] p-5 flex flex-col">
          <div className="flex items-center justify-between gap-3 pb-3.5 border-b border-slate-100 dark:border-white/[0.06]">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                Последние события
              </h2>
              <p className="text-[11px] text-slate-400">
                Открытия дверей, калиток и звонки с домофона
              </p>
            </div>
            {!isFullBlocked && (
              <button
                type="button"
                onClick={onNavigateArchive}
                className="text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>Видеоархив</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {isFullBlocked ? (
            <div className="flex-1 py-8 flex flex-col items-center justify-center text-center gap-2.5 text-xs text-slate-400">
              <Lock className="w-5 h-5 text-rose-500" />
              <span className="font-medium text-slate-700 dark:text-slate-200">
                История событий и просмотр архива заблокированы
              </span>
              <span className="text-[11px] max-w-xs">
                Ваш аккаунт полностью заблокирован администратором. Доступен только онлайн-просмотр камер.
              </span>
            </div>
          ) : timelineRows.length === 0 ? (
            <div className="flex-1 py-8 flex flex-col items-center justify-center text-center text-xs text-slate-400 gap-1.5">
              <span>Событий доступа пока нет</span>
              <span className="text-[11px] text-slate-400/80">
                Все открытия дверей и вызовы домофона будут отображаться здесь
              </span>
            </div>
          ) : (
            <div className="flex-1 flex flex-col">
              <div className="divide-y divide-slate-100 dark:divide-white/[0.06] mt-1 max-h-[420px] overflow-y-auto pr-1">
                {timelineRows.map((row) => {
                  const content = (
                    <>
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-11 shrink-0 font-mono tabular-nums font-semibold text-slate-500 dark:text-slate-400">
                          {row.timeLabel}
                        </span>

                        <span
                          className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                            row.kind === 'error'
                              ? 'bg-rose-500/10 text-rose-500'
                              : row.kind === 'call'
                              ? 'bg-amber-500/10 text-amber-500'
                              : 'bg-emerald-500/10 text-emerald-500'
                          }`}
                        >
                          {row.kind === 'gate' ? (
                            <GateOutlineIcon className="w-3.5 h-3.5" />
                          ) : row.kind === 'call' ? (
                            <CctvCameraIcon className="w-3.5 h-3.5" />
                          ) : (
                            <DoorOutlineIcon className="w-3.5 h-3.5" />
                          )}
                        </span>

                        <div className="min-w-0">
                          <div className="font-medium text-slate-800 dark:text-slate-100 truncate">
                            {row.title}
                          </div>
                          <div className="text-[11px] text-slate-400 truncate">
                            {row.subtitle}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2.5 shrink-0">
                        {row.playable && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#2563EB] dark:text-[#3B82F6] opacity-80 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                            <Play className="w-3 h-3 fill-current" />
                            <span className="hidden sm:inline">Видео</span>
                          </span>
                        )}
                        <span className="text-[11px] text-slate-400 whitespace-nowrap">
                          {row.dateLabel}
                        </span>
                      </div>
                    </>
                  );

                  if (row.playable) {
                    return (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => {
                          if (row.historyEvent) {
                            onOpenHistoryEvent(row.historyEvent);
                          } else if (row.doorLog) {
                            onOpenDoorLog(row.doorLog);
                          }
                        }}
                        title="Открыть запись этого события в архиве"
                        className="w-full text-left py-3 px-2 rounded-xl flex items-center justify-between gap-3 text-xs hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-colors group cursor-pointer"
                      >
                        {content}
                      </button>
                    );
                  }

                  return (
                    <div
                      key={row.id}
                      className="py-3 px-2 flex items-center justify-between gap-3 text-xs"
                    >
                      {content}
                    </div>
                  );
                })}
              </div>

              {placeHistoryHasMore && onLoadMoreHistory && (
                <div className="pt-3 mt-2 border-t border-slate-100 dark:border-white/[0.06]">
                  <button
                    type="button"
                    disabled={placeHistoryLoadingMore}
                    onClick={onLoadMoreHistory}
                    className="w-full py-2 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.05] dark:hover:bg-white/[0.09] transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {placeHistoryLoadingMore ? 'Загрузка событий...' : 'Показать более ранние события'}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Account & Service Status Panel */}
        <section className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] p-5 flex flex-col justify-between gap-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between pb-3.5 border-b border-slate-100 dark:border-white/[0.06]">
              <div>
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                  Состояние сервиса
                </h2>
                <p className="text-[11px] text-slate-400">
                  {activeBalanceInfo?.company || 'Лицевой счёт и параметры приёма вызовов'}
                </p>
              </div>
              <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
            </div>

            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500 dark:text-slate-400">Лицевой счёт</span>
                <span className="font-mono tabular-nums font-semibold text-slate-900 dark:text-white">
                  {session.subscriber?.accountId || session.userAgent?.account_id || 'Подключён'}
                </span>
              </div>

              {activeBalanceInfo?.paymentDate && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-slate-500 dark:text-slate-400">Следующее списание</span>
                  <span className="font-mono tabular-nums text-slate-800 dark:text-slate-200">
                    {activeBalanceInfo.paymentDate}
                    {typeof activeBalanceInfo.paymentSum === 'number'
                      ? ` · ${activeBalanceInfo.paymentSum.toFixed(0)} ₽`
                      : ''}
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                  <BellOff className="w-3.5 h-3.5 text-slate-400" />
                  <span>Звонки домофона</span>
                </span>
                <span
                  className={`font-medium ${
                    dndSummary.isMuted ? 'text-amber-500' : 'text-emerald-500'
                  }`}
                >
                  {dndSummary.isMuted ? 'Режим «Не беспокоить»' : 'Включены'}
                </span>
              </div>

              {billingMe && (
                <div className="pt-2.5 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-between gap-3">
                  <span className="text-slate-500 dark:text-slate-400">
                    Подписка ({billingMe.config.monthlyPriceRub} ₽/мес)
                  </span>
                  <span className="font-mono tabular-nums font-semibold text-slate-900 dark:text-white">
                    {billingMe.user.status === 'active'
                      ? `Активна · ${formatRub(billingMe.user.balanceRub)} ₽`
                      : billingMe.user.status === 'trial'
                        ? `Триал (подарок) · ${formatRub(billingMe.user.balanceRub)} ₽`
                        : billingMe.user.status === 'blocked'
                          ? 'Полная блокировка'
                          : `Нет средств (лимит) · ${formatRub(billingMe.user.balanceRub)} ₽`}
                  </span>
                </div>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onNavigateSettings}
            className="w-full px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.05] dark:hover:bg-white/[0.09] text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center justify-between transition-colors cursor-pointer"
          >
            <span className="inline-flex items-center gap-2">
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Подписка (50 ₽/мес) и настройки</span>
            </span>
            <ChevronRight className="w-4 h-4 text-slate-400" />
          </button>
        </section>
      </div>

      {/* Fullscreen Live Modal */}
      {fullscreenOpen && activeCamera && (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4 sm:p-8"
          onClick={() => setFullscreenOpen(false)}
        >
          <div
            className="max-w-5xl w-full bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/10 rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-white/10 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-bold text-slate-900 dark:text-white truncate">
                  {activeCamera.name}
                </div>
                <div className="text-[11px] text-slate-400 font-mono tabular-nums truncate">
                  ID {activeCamera.id} · {activeCamera.placeAddress}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setFullscreenOpen(false)}
                className="p-1.5 rounded-lg bg-slate-100 dark:bg-white/10 text-slate-600 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-white/20 cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="aspect-video w-full bg-slate-950">
              <CameraFeedPlayer
                session={session}
                camera={activeCamera}
                playbackMode="live"
                doorUnlockedPulse={
                  linkedLockForActiveCamera
                    ? Boolean(unlockedMap[linkedLockForActiveCamera.id])
                    : false
                }
                onCaptureNotice={onNotice}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
