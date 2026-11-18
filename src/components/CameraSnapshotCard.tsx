import React, { useRef, useState } from 'react';
import {
  Camera,
  Check,
  Download,
  History,
  Maximize2,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Star,
  Unlock,
  X,
} from 'lucide-react';
import { CameraItem, EgSession, LockItem } from '../types/eg';
import { buildSnapshotUrl } from '../services/egClient';
import { CachedCameraImage } from './CachedCameraImage';

interface CameraSnapshotCardProps {
  session: EgSession;
  camera: CameraItem;
  linkedLock?: LockItem | null;
  refreshTick: number;
  onSelectForVideo: (camera: CameraItem, mode: 'live' | 'archive') => void;
  onInspectSnapshot: (camera: CameraItem, snapshotUrlOrCanvas: string | null) => void;
  onUnlockLinked: (lock: LockItem) => Promise<void>;
  onToggleFavorite?: (camera: CameraItem) => void;
  onRenameCamera?: (camera: CameraItem, newName: string) => Promise<void> | void;
  onNotice?: (msg: string) => void;
  isRestricted?: boolean;
  canViewArchive?: boolean;
  canOpenLinkedLock?: boolean;
  canRename?: boolean;
}

export const CameraSnapshotCard: React.FC<CameraSnapshotCardProps> = ({
  session,
  camera,
  linkedLock,
  refreshTick,
  onSelectForVideo,
  onInspectSnapshot,
  onUnlockLinked,
  onToggleFavorite,
  onRenameCamera,
  onNotice,
  isRestricted = false,
  canViewArchive,
  canOpenLinkedLock,
  canRename,
}) => {
  const effectiveCanViewArchive =
    canViewArchive !== undefined ? canViewArchive : !isRestricted;
  const effectiveCanOpenLock =
    canOpenLinkedLock !== undefined ? canOpenLinkedLock : !isRestricted;
  const effectiveCanRename = canRename !== undefined ? canRename : !isRestricted;
  const [localNonce, setLocalNonce] = useState<number>(0);
  const [manualRefreshNonce, setManualRefreshNonce] = useState<number>(0);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [imgLoading, setImgLoading] = useState<boolean>(false);
  const [unlocking, setUnlocking] = useState<boolean>(false);
  const [unlockedSuccess, setUnlockedSuccess] = useState<boolean>(false);
  const [isEditingName, setIsEditingName] = useState<boolean>(false);
  const [draftName, setDraftName] = useState<string>(camera.name);
  const [savingName, setSavingName] = useState<boolean>(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const isCustomRenamed = Boolean(
    camera.originalName && camera.originalName.trim() !== camera.name.trim()
  );

  const startEditName = () => {
    setDraftName(camera.name);
    setIsEditingName(true);
  };

  const handleSaveRename = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!onRenameCamera || savingName) return;
    const trimmed = draftName.trim();
    if (!trimmed) {
      await handleResetName();
      return;
    }
    if (trimmed === camera.name.trim()) {
      setIsEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      await onRenameCamera(camera, trimmed);
      setIsEditingName(false);
    } finally {
      setSavingName(false);
    }
  };

  const handleResetName = async () => {
    if (!onRenameCamera || savingName) return;
    setSavingName(true);
    try {
      await onRenameCamera(camera, '');
      setIsEditingName(false);
    } finally {
      setSavingName(false);
    }
  };

  const effectiveTick = refreshTick + localNonce;
  const snapshotUrl =
    session.mode === 'live'
      ? resolvedUrl ||
        buildSnapshotUrl(session, camera.id, camera.placeId, effectiveTick, 1280, 720, {
          accessControlId: camera.accessControlId,
          entranceId: camera.entranceId,
        })
      : null;

  const handleManualRefresh = () => {
    setImgLoading(true);
    setLocalNonce((n) => n + 1);
    setManualRefreshNonce((n) => n + 1);
    if (session.mode === 'demo') {
      setTimeout(() => setImgLoading(false), 180);
    }
  };

  const handleDownloadSnapshot = () => {
    if (session.mode === 'demo' && canvasRef.current) {
      canvasRef.current.toBlob(
        (blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `screenshot-${camera.id}-${Date.now()}.jpg`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
          onNotice?.(`Скриншот «${camera.name}» скачан в JPEG`);
        },
        'image/jpeg',
        0.92
      );
      return;
    }

    if (snapshotUrl) {
      const a = document.createElement('a');
      a.href = snapshotUrl;
      a.download = `screenshot-${camera.id}-${Date.now()}.jpg`;
      a.click();
      onNotice?.(`Скриншот «${camera.name}» сохранён`);
    }
  };

  const handleUnlock = async () => {
    if (!linkedLock || unlocking) return;
    setUnlocking(true);
    try {
      await onUnlockLinked(linkedLock);
      setUnlockedSuccess(true);
      setTimeout(() => setUnlockedSuccess(false), 2600);
    } finally {
      setUnlocking(false);
    }
  };

  const sourceLabel =
    linkedLock?.controllerType === 'esp32' || camera.entranceId?.startsWith('esp32_gate_')
      ? 'Ворота'
      : camera.source === 'intercom'
      ? 'Домофон'
      : camera.source === 'place'
      ? 'Личная камера'
      : 'Общедомовая';

  return (
    <div className="flex flex-col bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] rounded-2xl overflow-hidden shadow-[0_2px_10px_rgba(15,23,42,0.03)] hover:border-slate-300 dark:hover:border-white/15 transition-all">
      {/* Snapshot Viewport */}
      <div className="relative aspect-video w-full bg-[#0b0f17] overflow-hidden group">
        <CachedCameraImage
          session={session}
          camera={camera}
          refreshTick={effectiveTick}
          forceRefreshNonce={manualRefreshNonce}
          width={1280}
          height={720}
          spinnerSize="md"
          doorUnlockedPulse={unlockedSuccess}
          onCanvasReady={(c) => {
            canvasRef.current = c;
          }}
          onResolvedUrl={(url) => setResolvedUrl(url)}
          onLoadStateChange={(loading) => setImgLoading(loading)}
          onRefreshError={(msg) => onNotice?.(`Не удалось обновить кадр «${camera.name}»: ${msg}`)}
        />

        {/* Unified Hover Overlay Controls */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-end justify-between p-3.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSelectForVideo(camera, 'live')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-[#2563EB] hover:bg-blue-700 text-white rounded-xl shadow-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Прямой эфир</span>
            </button>
            {effectiveCanViewArchive && (
              <button
                type="button"
                onClick={() => onSelectForVideo(camera, 'archive')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-black/65 hover:bg-black/85 text-white border border-white/15 rounded-xl backdrop-blur-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <History className="w-3.5 h-3.5" />
                <span>Архив</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleDownloadSnapshot}
              className="p-2 rounded-xl bg-black/65 hover:bg-black/85 text-white border border-white/15 backdrop-blur-sm transition-colors cursor-pointer"
              title="Скачать снимок"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onInspectSnapshot(camera, snapshotUrl)}
              className="p-2 rounded-xl bg-black/65 hover:bg-black/85 text-white border border-white/15 backdrop-blur-sm transition-colors cursor-pointer"
              title="Развернуть на весь экран"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Card Body */}
      <div className="p-4 flex flex-col justify-between flex-1 gap-3.5">
        <div>
          {isEditingName && effectiveCanRename ? (
            <form onSubmit={handleSaveRename} className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setIsEditingName(false);
                    }
                  }}
                  maxLength={80}
                  autoFocus
                  disabled={savingName}
                  placeholder={camera.originalName || 'Название камеры'}
                  className="flex-1 min-w-0 px-2.5 py-1 text-xs font-semibold bg-slate-50 dark:bg-[#12161f] border border-[#2563EB]/60 rounded-lg text-slate-900 dark:text-white focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={savingName}
                  title="Сохранить название"
                  className="p-1.5 rounded-lg bg-[#2563EB] hover:bg-blue-700 text-white transition-colors shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                {isCustomRenamed && (
                  <button
                    type="button"
                    disabled={savingName}
                    onClick={handleResetName}
                    title={`Вернуть исходное: ${camera.originalName}`}
                    className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.12] text-slate-600 dark:text-slate-300 transition-colors shrink-0 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  disabled={savingName}
                  onClick={() => setIsEditingName(false)}
                  title="Отмена"
                  className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.12] text-slate-500 dark:text-slate-400 transition-colors shrink-0 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              {camera.originalName && (
                <div className="text-[11px] text-slate-400 truncate">
                  Исходное: {camera.originalName}
                </div>
              )}
            </form>
          ) : (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h3
                  className="text-sm font-bold text-slate-900 dark:text-white leading-snug line-clamp-1"
                  title={
                    isCustomRenamed
                      ? `${camera.name} (Исходное: ${camera.originalName})`
                      : camera.name
                  }
                >
                  {camera.name}
                </h3>
                {isCustomRenamed && (
                  <p className="text-[11px] text-slate-400 truncate">
                    Исходное: {camera.originalName}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                {onRenameCamera && effectiveCanRename && (
                  <button
                    type="button"
                    onClick={startEditName}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-[#2563EB] dark:hover:text-[#3B82F6] hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
                    title="Переименовать камеру"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
                {onToggleFavorite && (
                  <button
                    type="button"
                    onClick={() => onToggleFavorite(camera)}
                    className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                      camera.favorite
                        ? 'text-amber-400 hover:text-amber-500 hover:bg-amber-500/10'
                        : 'text-slate-400 hover:text-amber-400 hover:bg-slate-100 dark:hover:bg-white/[0.06]'
                    }`}
                    title={camera.favorite ? 'Убрать из избранного' : 'Добавить в избранное'}
                  >
                    <Star
                      className={`w-3.5 h-3.5 ${camera.favorite ? 'fill-amber-400 text-amber-400' : ''}`}
                    />
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleManualRefresh}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors shrink-0 cursor-pointer"
                  title="Обновить кадр"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${imgLoading ? 'animate-spin text-[#2563EB] dark:text-[#3B82F6]' : ''}`}
                  />
                </button>
              </div>
            </div>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            <span>{sourceLabel}</span>
            <span aria-hidden="true">·</span>
            <span>Архив {camera.retentionDays} дн.</span>
            <span aria-hidden="true">·</span>
            <span>ID {camera.id}</span>
          </div>
          <p className="mt-1 text-xs text-slate-400 truncate">{camera.placeAddress}</p>
        </div>

        {/* Bottom Actions */}
        <div className="pt-3 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onSelectForVideo(camera, 'live')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.06] dark:hover:bg-white/[0.1] rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5 text-[#2563EB] dark:text-[#3B82F6] fill-current" />
              <span>Видео</span>
            </button>
            {effectiveCanViewArchive && (
              <button
                type="button"
                onClick={() => onSelectForVideo(camera, 'archive')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.06] dark:hover:bg-white/[0.1] rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <History className="w-3.5 h-3.5" />
                <span>Архив</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleDownloadSnapshot}
              title="Скачать снимок"
              className="p-1.5 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.06] dark:hover:bg-white/[0.1] rounded-xl transition-colors shrink-0 cursor-pointer"
            >
              <Camera className="w-3.5 h-3.5" />
            </button>
          </div>

          {effectiveCanOpenLock && linkedLock && linkedLock.openable && (
            <button
              type="button"
              disabled={unlocking}
              onClick={handleUnlock}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                unlockedSuccess
                  ? 'bg-emerald-500 text-white'
                  : 'bg-[#2563EB] hover:bg-blue-700 text-white'
              }`}
            >
              {unlockedSuccess ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>Открыто</span>
                </>
              ) : (
                <>
                  <Unlock className="w-3.5 h-3.5" />
                  <span>{unlocking ? 'Открытие...' : 'Открыть'}</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
