import React, { useEffect, useMemo, useRef, useState } from 'react';
import mpegts from 'mpegts.js';
import {
  Camera as CameraIcon,
  Calendar,
  Copy,
  Check,
  Download,
  KeyRound,
  Lock,
  Maximize2,
  Minimize2,
  RefreshCw,
  SkipBack,
  SkipForward,
  Unlock,
  Volume2,
  VolumeX,
  AlertCircle,
  Play,
  Pause,
  Info,
  Gauge,
} from 'lucide-react';
import { CameraEventItem, CameraItem, EgSession, LockItem } from '../types/eg';
import {
  apiGetCameraEvents,
  apiGetCameraStream,
  buildEventClipUrl,
  buildSnapshotUrl,
  downloadArchiveVideoMp4,
} from '../services/egClient';
import { ProceduralCameraCanvas } from './ProceduralCameraCanvas';
import {
  AudioStatusInfo,
  createFlvAudioTapLoader,
  FlvAudioEngine,
} from '../utils/flvAudioEngine';

interface CameraFeedPlayerProps {
  session: EgSession;
  camera: CameraItem;
  playbackMode: 'live' | 'archive_stream' | 'event_mp4';
  archiveDay?: string;
  archiveTimestampSec?: number | null;
  activeEventId?: string | null;
  activeEventDurationSec?: number | null;
  initialClipSeekSec?: number;
  knownMinAvailableTs?: number | null;
  downloadDurationSec?: number;
  seekNonce?: number;
  nearestEventInfo?: { id: string; timestamp: number } | null;
  doorUnlockedPulse?: boolean;
  linkedLock?: LockItem | null;
  canOpenLock?: boolean;
  isUnlocking?: boolean;
  canViewArchive?: boolean;
  events?: CameraEventItem[];
  availableDays?: string[];
  onOpenLock?: (lock: LockItem) => Promise<void> | void;
  onSwitchToLive?: () => void;
  onChangeArchiveDay?: (dayStr: string) => void;
  onOpenEvent?: (ev: CameraEventItem) => void;
  onCaptureNotice?: (msg: string) => void;
  onSeekArchiveTimestamp?: (newTimestampSec: number) => void;
  onDiscoverMinAvailableTs?: (cameraId: string, minTs: number, label?: string) => void;
  onRequestFallbackEventMp4?: (targetTimestampSec: number) => boolean;
  onSwitchToDvrStream?: () => void;
  onOpenNearestEvent?: () => void;
}

const SPEED_OPTIONS = [0.5, 1, 1.25, 1.5, 2, 4] as const;
const TIMELINE_SPAN_SEC = 5400; // 90 minutes visible window (±45m around playhead)
const WEEKDAYS_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const;
const MONTHS_SHORT_RU = [
  'янв.',
  'фев.',
  'мар.',
  'апр.',
  'мая',
  'июн.',
  'июл.',
  'авг.',
  'сен.',
  'окт.',
  'нояб.',
  'дек.',
] as const;

function formatClockHMS(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatClockHM(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function findBestEventNearTs(
  targetTs: number,
  pool: CameraEventItem[],
  maxDiffSec = 120
): CameraEventItem | null {
  if (!pool || pool.length === 0) return null;
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
}

function formatLocalIsoDateFromUnix(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildRecentDaysList(days: number): string[] {
  const list: string[] = [];
  const base = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(base.getTime() - i * 86400 * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    list.push(`${y}-${m}-${day}`);
  }
  return list;
}

function formatWeekdayDayBadge(isoDay: string): string {
  const dt = new Date(`${isoDay}T12:00:00`);
  if (Number.isNaN(dt.getTime())) return isoDay;
  return `${WEEKDAYS_RU[dt.getDay()]}, ${dt.getDate()}`;
}

function formatDayOptionLabel(isoDay: string, index: number): string {
  const dt = new Date(`${isoDay}T12:00:00`);
  if (Number.isNaN(dt.getTime())) return isoDay;
  const base = `${WEEKDAYS_RU[dt.getDay()]}, ${dt.getDate()} ${MONTHS_SHORT_RU[dt.getMonth()]}`;
  if (index === 0) return `Сегодня · ${base}`;
  if (index === 1) return `Вчера · ${base}`;
  return base;
}

export const CameraFeedPlayer: React.FC<CameraFeedPlayerProps> = ({
  session,
  camera,
  playbackMode,
  archiveDay,
  archiveTimestampSec = null,
  activeEventId = null,
  activeEventDurationSec = null,
  initialClipSeekSec = 0,
  knownMinAvailableTs = null,
  downloadDurationSec = 30,
  seekNonce = 0,
  nearestEventInfo = null,
  doorUnlockedPulse = false,
  linkedLock = null,
  canOpenLock = false,
  isUnlocking = false,
  canViewArchive = true,
  events: eventsProp,
  availableDays,
  onOpenLock,
  onSwitchToLive,
  onChangeArchiveDay,
  onOpenEvent,
  onCaptureNotice,
  onSeekArchiveTimestamp,
  onDiscoverMinAvailableTs,
  onRequestFallbackEventMp4,
  onSwitchToDvrStream,
  onOpenNearestEvent,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const demoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioEngineRef = useRef<FlvAudioEngine | null>(null);
  const hideHudTimerRef = useRef<number | null>(null);
  const hudBarHoverRef = useRef<boolean>(false);
  const autoDvrFallbackKeyRef = useRef<string | null>(null);
  const autoMinSeekKeyRef = useRef<string | null>(null);
  const dvrUnavailableRef = useRef<boolean>(false);
  const speedMenuRef = useRef<HTMLDivElement | null>(null);
  const infoMenuRef = useRef<HTMLDivElement | null>(null);
  const dateMenuRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startCenterTs: number;
    rulerWidth: number;
    hasDragged: boolean;
  } | null>(null);
  const suppressNextVideoClickRef = useRef<boolean>(false);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [errorMinTs, setErrorMinTs] = useState<number | null>(null);
  const [discoveredMinTs, setDiscoveredMinTs] = useState<number | null>(knownMinAvailableTs);
  const [upstreamUrl, setUpstreamUrl] = useState<string | null>(null);
  const [internalEvents, setInternalEvents] = useState<CameraEventItem[]>([]);

  // Audio enabled by default at 100% (0..100% range)
  const [muted, setMuted] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(1.0);
  const [audioStatus, setAudioStatus] = useState<AudioStatusInfo>({
    hasAudioPackets: false,
    codecLabel: 'MP4 · Запись события',
    packetsReceived: 0,
    level: 0,
    contextState: 'running',
  });

  // Playback speed, pause, clip progress & fullscreen
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [isNativeFullscreen, setIsNativeFullscreen] = useState<boolean>(false);
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState<boolean>(false);
  const isFullscreen = isNativeFullscreen || isPseudoFullscreen;
  const [clipCurrentTime, setClipCurrentTime] = useState<number>(0);
  const [clipDuration, setClipDuration] = useState<number>(0);

  // Live clock + Archive DVR elapsed clock & scrub target
  const [liveNowSec, setLiveNowSec] = useState<number>(() => Math.floor(Date.now() / 1000));
  const [streamElapsedSec, setStreamElapsedSec] = useState<number>(0);
  const [scrubPreviewTs, setScrubPreviewTs] = useState<number | null>(null);

  // Floating HUD visibility & popovers ('speed' | 'info' | 'date' | null)
  const [hudActive, setHudActive] = useState<boolean>(true);
  const [activePopover, setActivePopover] = useState<'speed' | 'info' | 'date' | null>(null);
  const [popoverAlign, setPopoverAlign] = useState<'left' | 'right'>('right');

  const [downloadingMp4, setDownloadingMp4] = useState<boolean>(false);
  const [copiedUrl, setCopiedUrl] = useState<boolean>(false);
  const [reloadNonce, setReloadNonce] = useState<number>(0);
  const [rulerWidthPx, setRulerWidthPx] = useState<number>(380);
  const [rulerHoverInfo, setRulerHoverInfo] = useState<{
    ts: number;
    pct: number;
    hasEvent: boolean;
  } | null>(null);

  const effectiveMinAvailableTs = discoveredMinTs ?? knownMinAvailableTs ?? null;

  // Keep ruler tick density consistent (~8px per 2-min tick) in both compact cards and wide fullscreen
  useEffect(() => {
    const el = rulerRef.current;
    if (!el) return;
    const updateWidth = () => {
      const w = el.clientWidth;
      if (w > 40) setRulerWidthPx(w);
    };
    updateWidth();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(updateWidth);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, [isFullscreen, playbackMode]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setLiveNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setDiscoveredMinTs(knownMinAvailableTs ?? null);
    setErrorMinTs(null);
    autoMinSeekKeyRef.current = null;
    dvrUnavailableRef.current = false;
    setInternalEvents([]);
  }, [camera.id]);

  useEffect(() => {
    if (knownMinAvailableTs != null) {
      setDiscoveredMinTs(knownMinAvailableTs);
    }
  }, [knownMinAvailableTs]);

  useEffect(() => {
    const onFsChange = () => {
      setIsNativeFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Auto-hide HUD after 3.2s of cursor inactivity while playing
  const triggerHudActivity = () => {
    setHudActive(true);
    if (hideHudTimerRef.current != null) {
      window.clearTimeout(hideHudTimerRef.current);
    }
    hideHudTimerRef.current = window.setTimeout(() => {
      if (!hudBarHoverRef.current) {
        setHudActive(false);
      }
    }, 3200);
  };

  useEffect(() => {
    return () => {
      if (hideHudTimerRef.current != null) {
        window.clearTimeout(hideHudTimerRef.current);
      }
    };
  }, []);

  // Close speed/info/date popover when clicking anywhere outside or pressing Escape
  useEffect(() => {
    if (!activePopover && !isPseudoFullscreen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!activePopover) return;
      const target = e.target as Node | null;
      const activeWrapper =
        activePopover === 'speed'
          ? speedMenuRef.current
          : activePopover === 'date'
            ? dateMenuRef.current
            : infoMenuRef.current;
      if (activeWrapper && target && activeWrapper.contains(target)) {
        return;
      }
      if (videoRef.current && target && videoRef.current.contains(target)) {
        suppressNextVideoClickRef.current = true;
        window.setTimeout(() => {
          suppressNextVideoClickRef.current = false;
        }, 250);
      }
      setActivePopover(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (activePopover) {
          setActivePopover(null);
        } else if (isPseudoFullscreen) {
          setIsPseudoFullscreen(false);
        }
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activePopover, isPseudoFullscreen]);

  const showControls =
    hudActive ||
    isPaused ||
    loading ||
    Boolean(error) ||
    activePopover !== null ||
    scrubPreviewTs !== null;

  // Sync pause state directly to Web Audio engine
  useEffect(() => {
    if (audioEngineRef.current) {
      audioEngineRef.current.setPaused(isPaused);
    }
  }, [isPaused]);

  // Sync mute & volume (capped 0..1 / 100%) to Web Audio engine and HTML5 <video>
  useEffect(() => {
    const clampedVol = Math.max(0, Math.min(1, volume));
    if (audioEngineRef.current) {
      audioEngineRef.current.setMuted(muted);
      audioEngineRef.current.setVolume(clampedVol);
    }
    if (videoRef.current) {
      if (playbackMode === 'event_mp4') {
        videoRef.current.muted = muted;
        videoRef.current.volume = clampedVol;
      } else {
        videoRef.current.muted = true;
      }
    }
  }, [muted, volume, playbackMode]);

  // Apply playbackRate cleanly on client <video> element
  useEffect(() => {
    if (videoRef.current) {
      try {
        videoRef.current.playbackRate = playbackRate;
      } catch {
        // ignore if browser clamps rate
      }
    }
  }, [playbackRate, playbackMode, clipDuration, reloadNonce]);

  // Reset elapsed counter when archiveTimestampSec / mode / event / seekNonce changes
  useEffect(() => {
    setStreamElapsedSec(0);
    setScrubPreviewTs(null);
    setClipCurrentTime(0);
    setClipDuration(0);
    setIsPaused(false);
    setActivePopover(null);
    triggerHudActivity();
  }, [archiveTimestampSec, playbackMode, activeEventId, seekNonce]);

  // Align MSE <video> currentTime to buffered range and recover gracefully from minor GOP/PTS gaps
  const alignMseVideoPosition = (v: HTMLVideoElement | null) => {
    if (!v || playbackMode === 'event_mp4') return;
    try {
      if (v.buffered.length === 0) return;
      const firstStart = v.buffered.start(0);
      if (v.currentTime < firstStart - 0.08) {
        v.currentTime = firstStart + 0.03;
        return;
      }
      if (v.buffered.length > 1) {
        for (let i = 0; i < v.buffered.length - 1; i++) {
          const rangeEnd = v.buffered.end(i);
          const nextStart = v.buffered.start(i + 1);
          if (
            v.currentTime >= rangeEnd - 0.15 &&
            v.currentTime < nextStart &&
            nextStart - rangeEnd < 2.5
          ) {
            v.currentTime = nextStart + 0.02;
            return;
          }
        }
      }
    } catch {
      // ignore
    }
  };

  // Advance archive stream clock while playing in archive_stream mode
  useEffect(() => {
    if (playbackMode !== 'archive_stream' || isPaused || loading) return;
    const timer = setInterval(() => {
      if (videoRef.current && !videoRef.current.paused && session.mode === 'live') {
        alignMseVideoPosition(videoRef.current);
        setStreamElapsedSec(Math.floor(videoRef.current.currentTime));
      } else if (session.mode === 'demo') {
        setStreamElapsedSec((prev) => prev + playbackRate);
      }
    }, 350);
    return () => clearInterval(timer);
  }, [playbackMode, isPaused, loading, playbackRate, session.mode]);

  // Play unlock chime & flush live audio/video buffer to live edge when doorUnlockedPulse transitions to true
  useEffect(() => {
    if (doorUnlockedPulse) {
      if (audioEngineRef.current) {
        audioEngineRef.current.playUnlockChime(true);
      }
      if (videoRef.current && playbackMode === 'live' && videoRef.current.buffered.length > 0) {
        const end = videoRef.current.buffered.end(videoRef.current.buffered.length - 1);
        if (end - videoRef.current.currentTime > 1.5) {
          videoRef.current.currentTime = Math.max(0, end - 0.35);
        }
      }
    }
  }, [doorUnlockedPulse, playbackMode]);

  // Automatically unlock Web Audio context on first user click anywhere
  useEffect(() => {
    const unlockAudio = () => {
      if (audioEngineRef.current) {
        audioEngineRef.current.resumeContext();
      }
    };
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, []);

  // Manage HTTP-FLV playback + Web Audio extraction
  useEffect(() => {
    if (audioEngineRef.current) {
      audioEngineRef.current.destroy();
      audioEngineRef.current = null;
    }

    if (playbackMode === 'event_mp4') {
      setError(null);
      setErrorMinTs(null);
      setLoading(true);
      setAudioStatus({
        hasAudioPackets: true,
        codecLabel: 'MP4 · Запись события (H.264)',
        packetsReceived: 1,
        level: 0.35,
        contextState: 'running',
      });
      if (videoRef.current) {
        videoRef.current.muted = muted;
        videoRef.current.volume = Math.max(0, Math.min(1, volume));
        videoRef.current.playbackRate = playbackRate;
      }
      return;
    }

    const engine = new FlvAudioEngine((status) => {
      setAudioStatus(status);
    });
    engine.setMuted(muted);
    engine.setVolume(Math.max(0, Math.min(1, volume)));
    audioEngineRef.current = engine;

    if (session.mode === 'demo') {
      setError(null);
      setErrorMinTs(null);
      setLoading(false);
      setUpstreamUrl(
        `https://forpost-15.novotelecom.ru:18081/rtsp/${camera.id}/token_live/d=1`
      );
      engine.startDemoAmbience(camera.demoScene || 'entrance');
      return () => {
        engine.destroy();
      };
    }

    let cancelled = false;
    let player: mpegts.Player | null = null;

    async function initFlvStream() {
      setLoading(true);
      setError(null);
      setErrorMinTs(null);
      try {
        const tsParam = playbackMode === 'archive_stream' ? archiveTimestampSec : null;
        const streamInfo = await apiGetCameraStream(
          session,
          camera.id,
          camera.placeId,
          tsParam,
          camera.timeZone || 25200,
          playbackMode === 'archive_stream' ? -1.0 : undefined
        );
        if (cancelled) return;

        setUpstreamUrl(streamInfo.upstreamUrl);

        if (mpegts.isSupported() && videoRef.current) {
          player = mpegts.createPlayer(
            {
              type: 'flv',
              isLive: true,
              url: streamInfo.proxyFlvUrl,
              hasAudio: false,
              hasVideo: true,
            },
            {
              enableWorker: false,
              enableStashBuffer: false,
              stashInitialSize: 128,
              fixAudioTimestampGap: false,
              autoCleanupSourceBuffer: true,
              autoCleanupMaxBackwardDuration: 45,
              autoCleanupMinBackwardDuration: 20,
              liveBufferLatencyChasing: playbackMode === 'live',
              liveBufferLatencyMaxLatency: 1.4,
              liveBufferLatencyMinRemain: 0.3,
              customLoader: createFlvAudioTapLoader(engine),
            }
          );

          videoRef.current.muted = true;
          player.attachMediaElement(videoRef.current);
          player.load();
          videoRef.current.playbackRate = playbackRate;
          const playPromise = player.play();
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(() => {});
          }

          player.on(mpegts.Events.ERROR, (errType, errDetail) => {
            if (!cancelled) {
              setError(
                playbackMode === 'archive_stream'
                  ? `На выбранное время в архиве нет записи или поток прерван (${errType}: ${errDetail})`
                  : `Поток FLV завершился или прерван (${errType}: ${errDetail})`
              );
              setLoading(false);
            }
          });

          player.on(mpegts.Events.METADATA_ARRIVED, () => {
            if (!cancelled) {
              setLoading(false);
              alignMseVideoPosition(videoRef.current);
            }
          });

          setTimeout(() => {
            if (!cancelled) setLoading(false);
          }, 1500);
        } else {
          setError('Ваш браузер не поддерживает Media Source Extensions для FLV-потока');
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          const minTs =
            typeof err?.minAvailableTs === 'number' && Number.isFinite(err.minAvailableTs)
              ? err.minAvailableTs
              : null;
          if (minTs != null) {
            setDiscoveredMinTs(minTs);
            setErrorMinTs(minTs);
            onDiscoverMinAvailableTs?.(camera.id, minTs, err?.minAvailableLabel);
          } else if (playbackMode === 'archive_stream') {
            dvrUnavailableRef.current = true;
          }

          if (
            playbackMode === 'archive_stream' &&
            archiveTimestampSec != null &&
            (minTs == null || archiveTimestampSec < minTs)
          ) {
            if (onRequestFallbackEventMp4?.(archiveTimestampSec)) {
              setLoading(false);
              return;
            }
            const nearbyEvent = findBestEventNearTs(archiveTimestampSec, effectiveEvents, 180);
            if (nearbyEvent && onOpenEvent) {
              onCaptureNotice?.(
                `Открыта запись события (${formatClockHMS(nearbyEvent.timestamp)})`
              );
              onOpenEvent(nearbyEvent);
              setLoading(false);
              return;
            }
            if (minTs != null) {
              const nowGuard = Math.floor(Date.now() / 1000) - 4;
              const autoSafeTs = Math.min(nowGuard, minTs + 6);
              const autoKey = `${camera.id}:${archiveTimestampSec}`;
              if (
                onSeekArchiveTimestamp &&
                archiveTimestampSec >= minTs - 600 &&
                autoSafeTs > archiveTimestampSec + 3 &&
                autoMinSeekKeyRef.current !== autoKey
              ) {
                autoMinSeekKeyRef.current = autoKey;
                onCaptureNotice?.(
                  `DVR-буфер камеры начинается с ${formatClockHMS(autoSafeTs)}`
                );
                onSeekArchiveTimestamp(autoSafeTs);
                setLoading(false);
                return;
              }
            }
          }

          setError(
            err?.message ||
              (playbackMode === 'archive_stream'
                ? 'За выбранное время запись в архиве не найдена'
                : 'Ошибка подключения к видеопотоку Forpost')
          );
          setLoading(false);
        }
      }
    }

    initFlvStream();

    return () => {
      cancelled = true;
      engine.destroy();
      if (player) {
        try {
          player.pause();
          player.unload();
          player.detachMediaElement();
          player.destroy();
        } catch {
          // ignore
        }
      }
    };
  }, [
    session,
    camera.id,
    camera.placeId,
    camera.demoScene,
    camera.timeZone,
    playbackMode,
    archiveTimestampSec,
    reloadNonce,
    seekNonce,
  ]);

  // Compute real-time clock bounds for interactive timeline scrubber
  const nowLimitSec = Math.max(liveNowSec - 3, Math.floor(Date.now() / 1000) - 3);
  const retentionDays = Math.max(1, Math.min(7, camera.retentionDays || 7));
  const retentionMinSec = liveNowSec - retentionDays * 86400;
  const currentArchiveUnixSec =
    playbackMode === 'live'
      ? liveNowSec
      : playbackMode === 'event_mp4'
        ? (archiveTimestampSec || liveNowSec - 300) + Math.floor(clipCurrentTime)
        : (archiveTimestampSec || liveNowSec - 600) + Math.floor(streamElapsedSec);

  const sliderBounds = useMemo(() => {
    const dayStr =
      archiveDay || formatLocalIsoDateFromUnix(archiveTimestampSec || nowLimitSec);
    const dayStartSec = Math.floor(new Date(`${dayStr}T00:00:00`).getTime() / 1000);
    const dayEndSec = Math.min(nowLimitSec, dayStartSec + 86399);
    const maxSec = Math.max(dayStartSec + 10, dayEndSec);

    const hasDvrFloor =
      effectiveMinAvailableTs != null &&
      effectiveMinAvailableTs >= dayStartSec &&
      effectiveMinAvailableTs < maxSec - 5;

    const minSec = hasDvrFloor ? effectiveMinAvailableTs! : dayStartSec;
    return {
      minSec,
      maxSec,
      hasDvrFloor,
    };
  }, [archiveDay, archiveTimestampSec, effectiveMinAvailableTs, nowLimitSec]);

  const sliderDisplayTs =
    scrubPreviewTs !== null
      ? Math.max(retentionMinSec, Math.min(nowLimitSec, scrubPreviewTs))
      : playbackMode === 'live'
        ? liveNowSec
        : Math.max(retentionMinSec, Math.min(nowLimitSec, currentArchiveUnixSec));

  const displayDayIso = useMemo(() => {
    if (playbackMode === 'live' && scrubPreviewTs === null) {
      return formatLocalIsoDateFromUnix(liveNowSec);
    }
    return archiveDay || formatLocalIsoDateFromUnix(sliderDisplayTs);
  }, [playbackMode, scrubPreviewTs, liveNowSec, archiveDay, sliderDisplayTs]);

  // Load camera motion events automatically if caller (e.g. OverviewDashboard) didn't pass events
  useEffect(() => {
    if (eventsProp !== undefined || !canViewArchive) return;
    let cancelled = false;
    apiGetCameraEvents(session, camera.id, camera.placeId, displayDayIso, { count: 100 })
      .then((page) => {
        if (!cancelled) {
          setInternalEvents(page.events || []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInternalEvents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [eventsProp, canViewArchive, session, camera.id, camera.placeId, displayDayIso]);

  const effectiveEvents = eventsProp ?? internalEvents;

  const effectiveNearestEvent = useMemo(() => {
    if (nearestEventInfo) return nearestEventInfo;
    if (effectiveEvents.length === 0) return null;
    const refTs = archiveTimestampSec ?? liveNowSec;
    let best = effectiveEvents[0];
    let bestDiff = Math.abs(best.timestamp - refTs);
    for (const ev of effectiveEvents) {
      const diff = Math.abs(ev.timestamp - refTs);
      if (diff < bestDiff) {
        best = ev;
        bestDiff = diff;
      }
    }
    return best;
  }, [nearestEventInfo, effectiveEvents, archiveTimestampSec, liveNowSec]);

  const retentionDaysList = useMemo(() => {
    if (availableDays && availableDays.length > 0) return availableDays;
    return buildRecentDaysList(retentionDays);
  }, [availableDays, retentionDays]);

  const commitArchiveScrub = (rawTargetTs: number | null) => {
    if (rawTargetTs === null) return;
    const clamped = Math.max(
      retentionMinSec,
      Math.min(nowLimitSec, Math.floor(rawTargetTs))
    );
    setScrubPreviewTs(null);
    if (clamped >= nowLimitSec - 8 && onSwitchToLive) {
      onSwitchToLive();
      return;
    }
    if (!canViewArchive) {
      onCaptureNotice?.('Архив недоступен для этой камеры на текущем тарифе');
      return;
    }
    if (
      dvrUnavailableRef.current ||
      (effectiveMinAvailableTs != null && clamped < effectiveMinAvailableTs)
    ) {
      const nearby = findBestEventNearTs(clamped, effectiveEvents, 240);
      if (nearby && onOpenEvent) {
        onOpenEvent(nearby);
        return;
      }
      if (
        effectiveMinAvailableTs != null &&
        clamped >= effectiveMinAvailableTs - 120
      ) {
        const safeTarget = Math.min(nowLimitSec - 4, effectiveMinAvailableTs + 6);
        onSeekArchiveTimestamp?.(safeTarget);
        return;
      }
    }
    onSeekArchiveTimestamp?.(clamped);
  };

  const handleStepPrev = () => {
    triggerHudActivity();
    if (!canViewArchive) {
      onCaptureNotice?.('Архив недоступен на текущем тарифе');
      return;
    }
    const curTs =
      playbackMode === 'live'
        ? liveNowSec
        : playbackMode === 'event_mp4'
          ? archiveTimestampSec || liveNowSec - 300
          : currentArchiveUnixSec;

    if (effectiveEvents.length > 0) {
      const sortedDesc = [...effectiveEvents].sort((a, b) => b.timestamp - a.timestamp);
      const prevEv = sortedDesc.find((ev) => ev.timestamp < curTs - 5);
      if (prevEv) {
        if (onOpenEvent) {
          onOpenEvent(prevEv);
        } else {
          onSeekArchiveTimestamp?.(prevEv.timestamp);
        }
        return;
      }
    }

    const stepTarget = Math.max(retentionMinSec, curTs - 60);
    commitArchiveScrub(stepTarget);
  };

  const handleStepNext = () => {
    triggerHudActivity();
    if (playbackMode === 'live' || !canViewArchive) return;
    const curTs =
      playbackMode === 'event_mp4'
        ? archiveTimestampSec || liveNowSec - 300
        : currentArchiveUnixSec;

    if (effectiveEvents.length > 0) {
      const sortedAsc = [...effectiveEvents].sort((a, b) => a.timestamp - b.timestamp);
      const nextEv = sortedAsc.find((ev) => ev.timestamp > curTs + 5);
      if (nextEv) {
        if (onOpenEvent) {
          onOpenEvent(nextEv);
        } else {
          onSeekArchiveTimestamp?.(nextEv.timestamp);
        }
        return;
      }
    }

    const stepTarget = curTs + 60;
    if (stepTarget >= nowLimitSec - 8 && onSwitchToLive) {
      onSwitchToLive();
      return;
    }
    commitArchiveScrub(stepTarget);
  };

  // Adapt visible timeline window to measured ruler width so tick spacing stays uniform (~8px per 2-min tick)
  const visibleSpanSec = useMemo(() => {
    if (rulerWidthPx <= 40) return TIMELINE_SPAN_SEC;
    const computed = Math.round((rulerWidthPx / 8) * 120);
    return Math.max(3600, Math.min(21600, computed));
  }, [rulerWidthPx]);

  // Interactive tick marks & continuous motion event spans around current center timestamp
  const { rulerTicks, rulerEventSpans } = useMemo(() => {
    const halfSpan = visibleSpanSec / 2;
    const minVisible = sliderDisplayTs - halfSpan;
    const maxVisible = sliderDisplayTs + halfSpan;
    const firstTick = Math.ceil(minVisible / 120) * 120; // every 2 minutes
    const ticks: Array<{
      ts: number;
      pct: number;
      kind: 'major' | 'medium' | 'minor';
      label?: string;
      isFuture: boolean;
      hasEvent: boolean;
    }> = [];

    for (let ts = firstTick; ts <= maxVisible; ts += 120) {
      const d = new Date(ts * 1000);
      const mins = d.getMinutes();
      const kind: 'major' | 'medium' | 'minor' =
        mins === 0 || mins === 30 ? 'major' : mins % 10 === 0 ? 'medium' : 'minor';
      const pct = ((ts - minVisible) / visibleSpanSec) * 100;
      const hasEvent = effectiveEvents.some((ev) => {
        const endTs = ev.timestamp + Math.max(20, ev.duration || 30);
        return ts >= ev.timestamp - 60 && ts <= endTs + 60;
      });
      ticks.push({
        ts,
        pct,
        kind,
        label: kind === 'major' ? formatClockHM(ts) : undefined,
        isFuture: ts > liveNowSec,
        hasEvent,
      });
    }

    const spans: Array<{ id: string; leftPct: number; widthPct: number }> = [];
    for (const ev of effectiveEvents) {
      const startTs = ev.timestamp;
      const endTs = ev.timestamp + Math.max(25, ev.duration || 30);
      if (endTs < minVisible || startTs > maxVisible) continue;
      const clampedStart = Math.max(minVisible, startTs);
      const clampedEnd = Math.min(maxVisible, Math.min(liveNowSec, endTs));
      if (clampedEnd <= clampedStart) continue;
      const leftPct = ((clampedStart - minVisible) / visibleSpanSec) * 100;
      const rawWidthPct = ((clampedEnd - clampedStart) / visibleSpanSec) * 100;
      spans.push({
        id: ev.id,
        leftPct,
        widthPct: Math.max(rawWidthPct, 0.5),
      });
    }

    return { rulerTicks: ticks, rulerEventSpans: spans };
  }, [sliderDisplayTs, liveNowSec, effectiveEvents, visibleSpanSec]);

  const canArchiveInteractive =
    canViewArchive && Boolean(onSeekArchiveTimestamp || onOpenEvent);

  const handleTogglePopover = (
    kind: 'speed' | 'info' | 'date',
    wrapperEl: HTMLDivElement | null
  ) => {
    triggerHudActivity();
    if (activePopover === kind) {
      setActivePopover(null);
      return;
    }
    if (wrapperEl && containerRef.current) {
      const btnRect = wrapperEl.getBoundingClientRect();
      const boxRect = containerRef.current.getBoundingClientRect();
      const btnCenter = btnRect.left + btnRect.width / 2;
      const boxCenter = boxRect.left + boxRect.width / 2;
      setPopoverAlign(btnCenter < boxCenter ? 'left' : 'right');
    } else {
      setPopoverAlign('right');
    }
    setActivePopover(kind);
  };

  const handleTogglePlayPause = () => {
    if (suppressNextVideoClickRef.current) {
      suppressNextVideoClickRef.current = false;
      triggerHudActivity();
      return;
    }
    if (activePopover !== null) {
      setActivePopover(null);
      triggerHudActivity();
      return;
    }
    triggerHudActivity();
    if (!videoRef.current) {
      setIsPaused((prev) => {
        const next = !prev;
        audioEngineRef.current?.setPaused(next);
        return next;
      });
      return;
    }
    if (videoRef.current.paused) {
      if (playbackMode === 'live' && videoRef.current.buffered.length > 0) {
        try {
          const end = videoRef.current.buffered.end(videoRef.current.buffered.length - 1);
          if (end - videoRef.current.currentTime > 1.2) {
            videoRef.current.currentTime = Math.max(0, end - 0.3);
          }
        } catch {
          // ignore
        }
      }
      audioEngineRef.current?.setPaused(false);
      videoRef.current.play().catch(() => {});
      setIsPaused(false);
    } else {
      audioEngineRef.current?.setPaused(true);
      videoRef.current.pause();
      setIsPaused(true);
    }
  };

  const handleDownloadVideo = async () => {
    if (downloadingMp4) return;
    triggerHudActivity();
    setDownloadingMp4(true);
    const baseTs = archiveTimestampSec || Math.floor(Date.now() / 1000) - 300;
    const isEventClip = playbackMode === 'event_mp4' && Boolean(activeEventId);
    const startTs = isEventClip ? baseTs : baseTs + Math.floor(streamElapsedSec);
    const durSec = isEventClip
      ? activeEventDurationSec || 20
      : Math.max(10, Math.min(300, downloadDurationSec || 30));

    onCaptureNotice?.(
      isEventClip
        ? 'Скачивание полного MP4-ролика события...'
        : `Подготовка MP4 (${formatClockHMS(startTs)} – ${formatClockHMS(startTs + durSec)})...`
    );
    try {
      const filename = await downloadArchiveVideoMp4(session, {
        eventId: isEventClip ? activeEventId : null,
        cameraId: camera.id,
        placeId: camera.placeId,
        timestampSec: startTs,
        durationSec: durSec,
        tz: camera.timeZone || 25200,
      });
      onCaptureNotice?.(`Видео сохранено: ${filename}`);
    } catch (err: any) {
      onCaptureNotice?.(err?.message || 'Ошибка скачивания MP4');
    } finally {
      setDownloadingMp4(false);
    }
  };

  const handleCaptureFrame = () => {
    triggerHudActivity();
    const outCanvas = document.createElement('canvas');
    outCanvas.width = 1280;
    outCanvas.height = 720;
    const ctx = outCanvas.getContext('2d');
    if (!ctx) return;

    if (session.mode === 'demo' && playbackMode !== 'event_mp4' && demoCanvasRef.current) {
      ctx.drawImage(demoCanvasRef.current, 0, 0, outCanvas.width, outCanvas.height);
    } else if (videoRef.current && videoRef.current.readyState >= 2) {
      ctx.drawImage(videoRef.current, 0, 0, outCanvas.width, outCanvas.height);
    } else {
      const snapUrl = buildSnapshotUrl(session, camera.id, camera.placeId, Date.now());
      const a = document.createElement('a');
      a.href = snapUrl;
      a.download = `snapshot-${camera.id}-${Date.now()}.jpg`;
      a.click();
      onCaptureNotice?.(`Скриншот камеры «${camera.name}» сохранён`);
      return;
    }

    outCanvas.toBlob(
      (blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `capture-${camera.id}-${Date.now()}.jpg`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        onCaptureNotice?.(`Кадр с камеры «${camera.name}» сохранён в JPEG`);
      },
      'image/jpeg',
      0.92
    );
  };

  const handleFullscreen = () => {
    triggerHudActivity();
    if (isPseudoFullscreen) {
      setIsPseudoFullscreen(false);
      return;
    }
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {
        setIsPseudoFullscreen(false);
      });
    } else if (typeof containerRef.current.requestFullscreen === 'function') {
      containerRef.current.requestFullscreen().catch(() => {
        setIsPseudoFullscreen(true);
      });
    } else {
      setIsPseudoFullscreen(true);
    }
  };

  const handleCopyStreamUrl = () => {
    if (!upstreamUrl) return;
    navigator.clipboard.writeText(upstreamUrl).then(() => {
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    });
  };

  const clipMp4Url =
    playbackMode === 'event_mp4' && activeEventId
      ? buildEventClipUrl(session, activeEventId, false, {
          cameraId: camera.id,
          placeId: camera.placeId,
          ts: archiveTimestampSec,
          duration: activeEventDurationSec || 20,
        })
      : null;

  return (
    <div
      ref={containerRef}
      onMouseEnter={triggerHudActivity}
      onMouseMove={triggerHudActivity}
      onMouseLeave={() => {
        hudBarHoverRef.current = false;
        if (!isPaused && activePopover === null && scrubPreviewTs === null) {
          setHudActive(false);
        }
      }}
      onTouchStart={triggerHudActivity}
      className={
        isPseudoFullscreen
          ? 'fixed inset-0 z-[100] w-screen h-screen bg-black overflow-hidden select-none'
          : 'relative aspect-video w-full h-full bg-black overflow-hidden select-none rounded-2xl'
      }
    >
      {/* Video Layer */}
      {session.mode === 'demo' && playbackMode !== 'event_mp4' ? (
        <div onClick={handleTogglePlayPause} className="w-full h-full cursor-pointer">
          <ProceduralCameraCanvas
            cameraId={camera.id}
            cameraName={camera.name}
            scene={camera.demoScene || 'entrance'}
            animated={!isPaused}
            archiveTimestampSec={playbackMode === 'live' ? null : currentArchiveUnixSec}
            doorUnlockedPulse={doorUnlockedPulse}
            onCanvasReady={(c) => {
              demoCanvasRef.current = c;
            }}
          />
        </div>
      ) : playbackMode === 'event_mp4' && clipMp4Url ? (
        <video
          ref={videoRef}
          key={clipMp4Url}
          src={clipMp4Url}
          preload="auto"
          autoPlay
          playsInline
          muted={muted}
          onClick={handleTogglePlayPause}
          onLoadStart={() => setLoading(true)}
          onCanPlay={() => setLoading(false)}
          onLoadedData={() => setLoading(false)}
          onPlaying={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            const fallbackKey = `${camera.id}:${activeEventId || archiveTimestampSec || ''}`;
            const canAutoSwitchDvr =
              Boolean(onSwitchToDvrStream) &&
              archiveTimestampSec != null &&
              (knownMinAvailableTs == null || archiveTimestampSec >= knownMinAvailableTs) &&
              autoDvrFallbackKeyRef.current !== fallbackKey;

            if (canAutoSwitchDvr && onSwitchToDvrStream) {
              autoDvrFallbackKeyRef.current = fallbackKey;
              setError(null);
              onCaptureNotice?.(
                'MP4-клип недоступен — запись открыта в потоке DVR'
              );
              onSwitchToDvrStream();
              return;
            }
            setError(
              'Не удалось загрузить MP4-клип события. Попробуйте переподключить или выбрать поток DVR.'
            );
          }}
          onTimeUpdate={(e) => setClipCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            const dur = e.currentTarget.duration || 0;
            setClipDuration(dur);
            if (initialClipSeekSec > 0 && dur > 2) {
              const target = Math.min(Math.max(0, dur - 1), initialClipSeekSec);
              try {
                e.currentTarget.currentTime = target;
                setClipCurrentTime(target);
              } catch {
                // ignore seek error before range ready
              }
            }
            e.currentTarget.playbackRate = playbackRate;
          }}
          onPlay={() => setIsPaused(false)}
          onPause={() => setIsPaused(true)}
          className="w-full h-full object-contain bg-black cursor-pointer"
        />
      ) : (
        <video
          ref={videoRef}
          key={`flv-${camera.id}-${playbackMode}-${archiveTimestampSec ?? 'live'}-${reloadNonce}-${seekNonce}`}
          autoPlay
          playsInline
          muted={true}
          poster={
            playbackMode === 'live'
              ? buildSnapshotUrl(session, camera.id, camera.placeId, reloadNonce)
              : undefined
          }
          onClick={handleTogglePlayPause}
          onLoadedMetadata={() => alignMseVideoPosition(videoRef.current)}
          onCanPlay={() => {
            setLoading(false);
            alignMseVideoPosition(videoRef.current);
          }}
          onPlaying={() => setLoading(false)}
          onWaiting={() => alignMseVideoPosition(videoRef.current)}
          onPlay={() => {
            audioEngineRef.current?.setPaused(false);
            setIsPaused(false);
          }}
          onPause={() => {
            audioEngineRef.current?.setPaused(true);
            setIsPaused(true);
          }}
          className="w-full h-full object-contain bg-black cursor-pointer"
        />
      )}

      {/* Top Overlay Header: Left Audio/Tools, Center Open-Key Pill, Right Fullscreen */}
      <div
        onMouseEnter={() => {
          hudBarHoverRef.current = true;
          setHudActive(true);
        }}
        onMouseLeave={() => {
          hudBarHoverRef.current = false;
        }}
        onClick={(e) => e.stopPropagation()}
        className={`absolute inset-x-0 top-0 px-2.5 sm:px-4 pt-2.5 sm:pt-3 pb-10 bg-gradient-to-b from-black/75 via-black/30 to-transparent flex items-center justify-between gap-2 transition-opacity duration-200 z-20 pointer-events-none ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* Top-Left Compact Utility Pill (Volume, Speed, Download, Screenshot, Info) */}
        <div className="pointer-events-auto flex items-center gap-0.5 sm:gap-1 px-1.5 sm:px-2 py-1 rounded-full bg-slate-950/80 border border-white/15 backdrop-blur-md text-white shadow-lg">
          <button
            type="button"
            onClick={() => {
              const nextMuted = !muted;
              setMuted(nextMuted);
              audioEngineRef.current?.setMuted(nextMuted);
            }}
            className="p-1.5 rounded-full hover:bg-white/10 transition-colors cursor-pointer"
            title={muted ? 'Включить звук' : 'Выключить звук'}
          >
            {muted || volume === 0 ? (
              <VolumeX className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#3B82F6]" />
            ) : (
              <Volume2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-white" />
            )}
          </button>

          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : Math.min(1, volume)}
            onChange={(e) => {
              const v = Math.max(0, Math.min(1, parseFloat(e.target.value)));
              setVolume(v);
              if (v > 0 && muted) {
                setMuted(false);
              }
            }}
            aria-label="Громкость звука"
            className="hidden sm:block w-14 accent-[#3B82F6] cursor-pointer h-1 bg-white/30 rounded-full"
          />

          {!muted && audioStatus.contextState === 'suspended' && playbackMode !== 'event_mp4' && (
            <button
              type="button"
              onClick={() => audioEngineRef.current?.resumeContext()}
              className="px-2 py-0.5 rounded-full bg-[#2563EB] hover:bg-blue-700 text-[10px] font-semibold text-white cursor-pointer whitespace-nowrap"
            >
              Звук
            </button>
          )}

          {playbackMode !== 'live' && (
            <div ref={speedMenuRef} className="relative">
              <button
                type="button"
                onClick={() => handleTogglePopover('speed', speedMenuRef.current)}
                className={`inline-flex items-center gap-1 px-1.5 sm:px-2 py-1 rounded-full text-[11px] font-mono font-semibold transition-colors cursor-pointer ${
                  activePopover === 'speed' || playbackRate !== 1
                    ? 'bg-[#2563EB] text-white'
                    : 'hover:bg-white/15 text-white/90'
                }`}
                title="Скорость воспроизведения"
              >
                <Gauge className="w-3.5 h-3.5" />
                <span>{playbackRate}x</span>
              </button>

              {activePopover === 'speed' && (
                <div className="absolute top-full left-0 mt-2 w-44 rounded-2xl bg-slate-950/95 backdrop-blur-md border border-white/15 p-1.5 shadow-2xl z-30">
                  <div className="px-2.5 py-1 text-[11px] font-semibold text-white/60 border-b border-white/10 mb-1">
                    Скорость воспроизведения
                  </div>
                  {SPEED_OPTIONS.map((spd) => {
                    const selected = playbackRate === spd;
                    return (
                      <button
                        key={spd}
                        type="button"
                        onClick={() => {
                          setPlaybackRate(spd);
                          if (videoRef.current) {
                            try {
                              videoRef.current.playbackRate = spd;
                            } catch {
                              // ignore
                            }
                          }
                          setActivePopover(null);
                        }}
                        className={`w-full px-2.5 py-1.5 rounded-xl text-xs font-mono flex items-center justify-between transition-colors cursor-pointer ${
                          selected
                            ? 'bg-[#2563EB] text-white font-semibold'
                            : 'text-white/90 hover:bg-white/10'
                        }`}
                      >
                        <span>{spd === 1 ? 'Обычная (1x)' : `${spd}x`}</span>
                        {selected && <Check className="w-3.5 h-3.5" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={handleCaptureFrame}
            className="p-1.5 rounded-full hover:bg-white/15 text-white/90 transition-colors cursor-pointer"
            title="Сделать скриншот кадра"
          >
            <CameraIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </button>

          {playbackMode !== 'live' && canViewArchive && (
            <button
              type="button"
              onClick={handleDownloadVideo}
              disabled={downloadingMp4}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-[#2563EB] hover:bg-blue-700 disabled:opacity-60 text-white text-[11px] font-semibold transition-colors cursor-pointer"
              title="Скачать фрагмент MP4"
            >
              {downloadingMp4 ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span className="hidden md:inline">MP4</span>
            </button>
          )}

          <div ref={infoMenuRef} className="relative">
            <button
              type="button"
              onClick={() => handleTogglePopover('info', infoMenuRef.current)}
              className={`p-1.5 rounded-full transition-colors cursor-pointer ${
                activePopover === 'info'
                  ? 'bg-white/25 text-white'
                  : 'hover:bg-white/15 text-white/90'
              }`}
              title="Сведения о потоке и переподключение"
            >
              <Info className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </button>

            {activePopover === 'info' && (
              <div
                className={`absolute top-full mt-2 ${
                  popoverAlign === 'left' ? 'left-0' : 'right-0'
                } w-72 max-w-[85vw] rounded-2xl bg-slate-950/95 backdrop-blur-md border border-white/15 p-3.5 shadow-2xl text-xs text-white/90 space-y-2 z-30`}
              >
                <div className="flex items-center justify-between border-b border-white/10 pb-2">
                  <span className="font-semibold text-white">Сведения о видео</span>
                  <span className="font-mono text-[11px] text-white/60">ID {camera.id}</span>
                </div>
                <div className="space-y-1 text-[11px]">
                  <div className="flex justify-between gap-2">
                    <span className="text-white/60">Камера:</span>
                    <span className="text-right font-medium truncate">{camera.name}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-white/60">Режим:</span>
                    <span className="text-right">
                      {playbackMode === 'live'
                        ? 'Прямой эфир (FLV)'
                        : playbackMode === 'event_mp4'
                        ? 'Событие архива (MP4)'
                        : 'Непрерывный DVR-поток'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-white/60">Поток / звук:</span>
                    <span className="text-right font-mono">{audioStatus.codecLabel}</span>
                  </div>
                  {playbackMode === 'archive_stream' && sliderBounds.hasDvrFloor && (
                    <div className="flex justify-between gap-2">
                      <span className="text-white/60">DVR-буфер с:</span>
                      <span className="text-right font-mono text-amber-300">
                        {formatClockHMS(sliderBounds.minSec)}
                      </span>
                    </div>
                  )}
                </div>
                <div className="pt-1.5 border-t border-white/10 flex items-center gap-2">
                  {upstreamUrl && playbackMode !== 'event_mp4' && (
                    <button
                      type="button"
                      onClick={handleCopyStreamUrl}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-[11px] font-medium transition-colors cursor-pointer"
                    >
                      {copiedUrl ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Скопировано</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>URL потока</span>
                        </>
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setActivePopover(null);
                      setReloadNonce((n) => n + 1);
                    }}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-[11px] font-medium transition-colors cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Переподключить</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Top-Center Brand & Camera Pill (Open-Key style) */}
        <div className="hidden sm:inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-950/80 border border-white/15 backdrop-blur-md shadow-lg max-w-[45%]">
          <span className="w-5 h-5 rounded-full bg-[#2563EB] flex items-center justify-center text-white shrink-0">
            <KeyRound className="w-3 h-3" />
          </span>
          <span className="text-xs font-semibold text-white truncate">{camera.name}</span>
          {playbackMode !== 'live' && playbackRate !== 1 && (
            <span className="px-1.5 py-0.5 rounded-full bg-[#2563EB] text-white text-[10px] font-mono font-bold shrink-0">
              {playbackRate}x
            </span>
          )}
        </div>

        {/* Top-Right Fullscreen / Collapse Button */}
        <button
          type="button"
          onClick={handleFullscreen}
          className="pointer-events-auto w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-slate-950/80 hover:bg-slate-900 border border-white/15 backdrop-blur-md text-white flex items-center justify-center shadow-lg transition-colors cursor-pointer shrink-0"
          title={isFullscreen ? 'Свернуть' : 'На весь экран'}
        >
          {isFullscreen ? (
            <Minimize2 className="w-4 h-4" />
          ) : (
            <Maximize2 className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Loading Overlay */}
      {loading && (
        <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2.5 text-white pointer-events-none z-10">
          <RefreshCw className="w-6 h-6 animate-spin text-[#3B82F6]" />
          <span className="text-xs font-mono text-white/90">
            {playbackMode === 'event_mp4'
              ? 'Загрузка MP4-записи события...'
              : 'Подключение к видеопотоку...'}
          </span>
        </div>
      )}

      {/* Error Overlay */}
      {error && session.mode === 'live' && (
        <div className="absolute inset-x-3 sm:inset-x-4 top-14 bg-slate-950/92 backdrop-blur-md border border-rose-500/50 rounded-2xl p-3 flex flex-wrap items-center justify-between gap-3 z-30">
          <div className="flex items-center gap-2.5 text-xs text-white/90">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{error}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {playbackMode === 'event_mp4' &&
              archiveTimestampSec != null &&
              onSwitchToDvrStream && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    onSwitchToDvrStream();
                  }}
                  className="px-3 py-1.5 text-xs font-semibold bg-[#2563EB] hover:bg-blue-700 text-white rounded-xl whitespace-nowrap transition-colors cursor-pointer"
                >
                  Поток DVR
                </button>
              )}
            {errorMinTs != null && onSeekArchiveTimestamp && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  const safeTarget = Math.min(Math.floor(Date.now() / 1000) - 4, errorMinTs + 6);
                  onSeekArchiveTimestamp(safeTarget);
                }}
                className="px-3 py-1.5 text-xs font-semibold bg-[#2563EB] hover:bg-blue-700 text-white rounded-xl whitespace-nowrap transition-colors cursor-pointer"
              >
                Перейти к {formatClockHMS(errorMinTs)}
              </button>
            )}
            {playbackMode === 'archive_stream' &&
              effectiveNearestEvent &&
              (onOpenNearestEvent || onOpenEvent) && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    if (onOpenNearestEvent) {
                      onOpenNearestEvent();
                    } else if (onOpenEvent && 'id' in effectiveNearestEvent) {
                      onOpenEvent(effectiveNearestEvent as CameraEventItem);
                    }
                  }}
                  className="px-3 py-1.5 text-xs font-semibold bg-[#2563EB] hover:bg-blue-700 text-white rounded-xl whitespace-nowrap transition-colors cursor-pointer"
                >
                  Ближайшее событие ({formatClockHMS(effectiveNearestEvent.timestamp)})
                </button>
              )}
            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
              className="px-3 py-1.5 text-xs font-medium bg-white/15 hover:bg-white/25 text-white rounded-xl whitespace-nowrap transition-colors cursor-pointer"
            >
              Переподключить
            </button>
          </div>
        </div>
      )}

      {/* Floating Door / Gate Open Button (Right side above bottom dock) */}
      {linkedLock && canOpenLock && onOpenLock && (
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-[58px] sm:bottom-[70px] z-20 px-2.5 sm:px-4 ${
            isFullscreen ? 'sm:px-6' : ''
          }`}
        >
          <div
            className={`flex justify-end ${
              isFullscreen ? 'max-w-6xl mx-auto' : ''
            }`}
          >
            <button
              type="button"
              disabled={isUnlocking}
              onClick={(e) => {
                e.stopPropagation();
                triggerHudActivity();
                onOpenLock(linkedLock);
              }}
              title={`Открыть: ${linkedLock.name}`}
              className={`pointer-events-auto px-3.5 py-2 sm:px-5 sm:py-2.5 rounded-full text-xs sm:text-sm font-semibold text-white shadow-xl inline-flex items-center gap-1.5 sm:gap-2 transition-all active:scale-95 cursor-pointer ${
                doorUnlockedPulse
                  ? 'bg-emerald-500 hover:bg-emerald-600 shadow-emerald-950/40'
                  : isUnlocking
                    ? 'bg-[#2563EB]/80 cursor-wait'
                    : 'bg-[#2563EB] hover:bg-blue-700 shadow-blue-950/50'
              }`}
            >
              {isUnlocking ? (
                <RefreshCw className="w-3.5 h-3.5 sm:w-4 sm:h-4 animate-spin" />
              ) : doorUnlockedPulse ? (
                <Unlock className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              ) : (
                <Lock className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              )}
              <span>
                {isUnlocking ? 'Открытие...' : doorUnlockedPulse ? 'Открыто' : 'Открыть'}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Bottom Floating Control Dock (Prev/Play/Next + Scrubbing Timeline + Live + Date) */}
      <div
        onMouseEnter={() => {
          hudBarHoverRef.current = true;
          setHudActive(true);
        }}
        onMouseLeave={() => {
          hudBarHoverRef.current = false;
        }}
        onClick={(e) => e.stopPropagation()}
        className={`absolute inset-x-0 bottom-0 pt-10 pb-2 sm:pb-3.5 px-2 sm:px-4 ${
          isFullscreen ? 'sm:px-6 sm:pb-5' : ''
        } bg-gradient-to-t from-black/90 via-black/45 to-transparent transition-all duration-200 z-20 ${
          showControls
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 translate-y-1 pointer-events-none'
        }`}
      >
        <div
          className={`flex items-center gap-1.5 sm:gap-2.5 ${
            isFullscreen ? 'max-w-6xl mx-auto' : ''
          }`}
        >
          {/* Left Transport Buttons: Prev Event | Play/Pause | Next Event */}
          <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
            <button
              type="button"
              disabled={!canArchiveInteractive}
              onClick={handleStepPrev}
              className="w-9 h-9 sm:w-11 sm:h-11 rounded-full bg-slate-950/85 hover:bg-slate-900 disabled:opacity-35 disabled:cursor-not-allowed border border-white/15 backdrop-blur-md text-white flex items-center justify-center shadow-lg transition-colors cursor-pointer"
              title="Предыдущее событие / назад"
            >
              <SkipBack className="w-3.5 h-3.5 sm:w-4 sm:h-4 fill-current" />
            </button>

            <button
              type="button"
              onClick={handleTogglePlayPause}
              className="w-9 h-9 sm:w-11 sm:h-11 rounded-full bg-white hover:bg-slate-100 text-slate-900 flex items-center justify-center shadow-lg transition-colors cursor-pointer"
              title={isPaused ? 'Воспроизвести' : 'Пауза'}
            >
              {isPaused ? (
                <Play className="w-3.5 h-3.5 sm:w-4 sm:h-4 fill-current ml-0.5" />
              ) : (
                <Pause className="w-3.5 h-3.5 sm:w-4 sm:h-4 fill-current" />
              )}
            </button>

            <button
              type="button"
              disabled={playbackMode === 'live' || !canArchiveInteractive}
              onClick={handleStepNext}
              className="hidden sm:flex w-11 h-11 rounded-full bg-slate-950/85 hover:bg-slate-900 disabled:opacity-35 disabled:cursor-not-allowed border border-white/15 backdrop-blur-md text-white items-center justify-center shadow-lg transition-colors cursor-pointer"
              title="Следующее событие / вперёд"
            >
              <SkipForward className="w-4 h-4 fill-current" />
            </button>
          </div>

          {/* Center Interactive Tick Timeline Capsule */}
          <div className="relative flex-1 min-w-0 h-9 sm:h-11 rounded-full bg-slate-950/85 border border-white/15 backdrop-blur-md px-1.5 sm:px-2 flex items-center gap-1.5 sm:gap-2.5 shadow-lg">
            {/* Live / Archive Clock Readout */}
            <span className="px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-full bg-white/[0.09] text-[10px] sm:text-xs font-mono tabular-nums text-white shrink-0">
              {formatClockHMS(sliderDisplayTs)}
            </span>

            {/* Draggable Tick-Mark Ruler */}
            {playbackMode === 'event_mp4' && clipDuration > 0 ? (
              <div className="flex-1 flex items-center gap-2 min-w-0 px-1">
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, clipDuration || activeEventDurationSec || 20)}
                  step={0.1}
                  value={Math.min(
                    clipCurrentTime,
                    Math.max(1, clipDuration || activeEventDurationSec || 20)
                  )}
                  onChange={(e) => {
                    const next = parseFloat(e.target.value);
                    setClipCurrentTime(next);
                    if (videoRef.current) {
                      videoRef.current.currentTime = next;
                    }
                  }}
                  aria-label="Перемотка видеоролика"
                  className="w-full accent-[#3B82F6] cursor-pointer h-1.5 bg-white/25 rounded-full"
                />
              </div>
            ) : (
              <div
                ref={rulerRef}
                onPointerDown={(e) => {
                  if (!canArchiveInteractive) return;
                  triggerHudActivity();
                  setRulerHoverInfo(null);
                  const rect = e.currentTarget.getBoundingClientRect();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  dragStateRef.current = {
                    startX: e.clientX,
                    startCenterTs: sliderDisplayTs,
                    rulerWidth: rect.width,
                    hasDragged: false,
                  };
                  setScrubPreviewTs(sliderDisplayTs);
                }}
                onPointerMove={(e) => {
                  const st = dragStateRef.current;
                  if (st) {
                    const dx = e.clientX - st.startX;
                    if (Math.abs(dx) > 4) {
                      st.hasDragged = true;
                    }
                    if (st.hasDragged) {
                      const deltaSec = Math.round(
                        (dx / Math.max(100, st.rulerWidth)) * visibleSpanSec
                      );
                      const nextTs = Math.max(
                        retentionMinSec,
                        Math.min(nowLimitSec, st.startCenterTs - deltaSec)
                      );
                      setScrubPreviewTs(nextTs);
                    }
                    return;
                  }
                  if (!canArchiveInteractive || e.pointerType === 'touch') return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(
                    0,
                    Math.min(100, ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100)
                  );
                  const hoverTs = Math.floor(
                    sliderDisplayTs + (pct / 100 - 0.5) * visibleSpanSec
                  );
                  if (hoverTs > liveNowSec || hoverTs < retentionMinSec) {
                    setRulerHoverInfo(null);
                    return;
                  }
                  const hasEv = Boolean(findBestEventNearTs(hoverTs, effectiveEvents, 90));
                  setRulerHoverInfo({ ts: hoverTs, pct, hasEvent: hasEv });
                }}
                onPointerLeave={() => {
                  if (!dragStateRef.current) {
                    setRulerHoverInfo(null);
                  }
                }}
                onPointerUp={(e) => {
                  const st = dragStateRef.current;
                  if (!st) return;
                  dragStateRef.current = null;
                  try {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                      e.currentTarget.releasePointerCapture(e.pointerId);
                    }
                  } catch {
                    // ignore
                  }
                  if (st.hasDragged) {
                    commitArchiveScrub(scrubPreviewTs ?? st.startCenterTs);
                  } else {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const frac = (e.clientX - rect.left) / Math.max(1, rect.width) - 0.5;
                    const clickedTs = st.startCenterTs + Math.round(frac * visibleSpanSec);
                    commitArchiveScrub(clickedTs);
                  }
                }}
                onPointerCancel={() => {
                  dragStateRef.current = null;
                  setScrubPreviewTs(null);
                }}
                onWheel={(e) => {
                  if (!canArchiveInteractive) return;
                  e.preventDefault();
                  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
                  const step = delta > 0 ? 180 : -180;
                  commitArchiveScrub(sliderDisplayTs + step);
                }}
                title={
                  canArchiveInteractive
                    ? 'Синие метки — движение. Потяните или нажмите на шкалу для перехода.'
                    : 'Архив недоступен'
                }
                className={`relative flex-1 h-full select-none touch-none ${
                  canArchiveInteractive
                    ? 'cursor-grab active:cursor-grabbing'
                    : 'opacity-45 cursor-not-allowed'
                }`}
              >
                {/* Hover Time & Motion Tooltip */}
                {rulerHoverInfo && scrubPreviewTs === null && (
                  <div
                    style={{ left: `${rulerHoverInfo.pct}%` }}
                    className="hidden sm:flex items-center gap-1.5 -translate-x-1/2 -top-7 absolute px-2 py-0.5 rounded-full bg-slate-950/95 border border-white/15 text-[10px] font-mono tabular-nums text-white shadow-lg pointer-events-none whitespace-nowrap z-30"
                  >
                    {rulerHoverInfo.hasEvent && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[#3B82F6] shrink-0" />
                    )}
                    <span>{formatClockHMS(rulerHoverInfo.ts)}</span>
                  </div>
                )}

                <div className="relative w-full h-full overflow-hidden">
                  {/* Top Tick Strip (Strictly above time labels so playhead never crosses labels) */}
                  <div className="absolute inset-x-0 top-1.5 bottom-[14px]">
                    {/* Motion Event Highlight Bars along base of tick strip */}
                    {rulerEventSpans.map((span) => (
                      <div
                        key={span.id}
                        style={{
                          left: `${span.leftPct}%`,
                          width: `${span.widthPct}%`,
                          minWidth: '4px',
                        }}
                        className="absolute bottom-0 h-[3px] rounded-full bg-[#3B82F6] shadow-[0_0_6px_rgba(59,130,246,0.85)] pointer-events-none"
                      />
                    ))}

                    {rulerTicks.map((tick) => (
                      <div
                        key={`t-${tick.ts}`}
                        style={{ left: `${tick.pct}%` }}
                        className="absolute inset-y-0 -translate-x-1/2 flex items-center pointer-events-none"
                      >
                        <div
                          className={`rounded-full ${
                            tick.hasEvent && !tick.isFuture ? 'w-[2px]' : 'w-[1.5px]'
                          } ${
                            tick.kind === 'major'
                              ? 'h-full'
                              : tick.kind === 'medium'
                                ? 'h-[72%]'
                                : 'h-[45%]'
                          } ${
                            tick.isFuture
                              ? 'bg-white/20'
                              : tick.hasEvent
                                ? 'bg-[#60A5FA]'
                                : 'bg-white/80'
                          }`}
                        />
                      </div>
                    ))}

                    {/* Center Vertical Playhead + Top Dot */}
                    <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[2px] rounded-full bg-[#3B82F6] shadow-[0_0_8px_rgba(59,130,246,0.95)] pointer-events-none">
                      <span className="absolute -top-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-[#60A5FA]" />
                    </div>
                  </div>

                  {/* Bottom Time Labels Band */}
                  <div className="absolute inset-x-0 bottom-[2px] h-[11px] pointer-events-none">
                    {rulerTicks.map((tick) =>
                      tick.label && tick.pct >= 7 && tick.pct <= 93 ? (
                        <span
                          key={`l-${tick.ts}`}
                          style={{ left: `${tick.pct}%` }}
                          className={`absolute top-0 -translate-x-1/2 text-[9px] font-mono tabular-nums leading-none whitespace-nowrap ${
                            tick.isFuture ? 'text-white/30' : 'text-white/75'
                          }`}
                        >
                          {tick.label}
                        </span>
                      ) : null
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Live Jump Button */}
            <button
              type="button"
              onClick={() => {
                triggerHudActivity();
                if (playbackMode === 'live') {
                  setReloadNonce((n) => n + 1);
                } else {
                  onSwitchToLive?.();
                }
              }}
              className={`px-2.5 sm:px-3 py-1 rounded-full text-[11px] sm:text-xs font-semibold inline-flex items-center gap-1.5 shrink-0 transition-all cursor-pointer ${
                playbackMode === 'live'
                  ? 'bg-[#2563EB] text-white shadow-sm'
                  : 'bg-white/12 hover:bg-white/22 text-white/90'
              }`}
              title={playbackMode === 'live' ? 'Прямой эфир активен' : 'Вернуться в прямой эфир'}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  playbackMode === 'live'
                    ? 'bg-white animate-pulse'
                    : 'bg-rose-500'
                }`}
              />
              <span>Live</span>
            </button>
          </div>

          {/* Right Date Picker Pill (📅 Ср, 18) */}
          <div ref={dateMenuRef} className="relative shrink-0">
            <button
              type="button"
              disabled={!canArchiveInteractive}
              onClick={() => handleTogglePopover('date', dateMenuRef.current)}
              className="h-8 sm:h-10 px-2.5 sm:px-3.5 rounded-full bg-slate-950/85 hover:bg-slate-900 disabled:opacity-45 disabled:cursor-not-allowed border border-white/15 backdrop-blur-md text-white text-[11px] sm:text-xs font-medium inline-flex items-center gap-1.5 shadow-lg transition-colors cursor-pointer"
              title="Выбрать день архива"
            >
              <Calendar className="w-3.5 h-3.5 text-white/80 shrink-0" />
              <span className="whitespace-nowrap">{formatWeekdayDayBadge(displayDayIso)}</span>
            </button>

            {activePopover === 'date' && (
              <div className="absolute bottom-full right-0 mb-2 w-56 rounded-2xl bg-slate-950/95 backdrop-blur-md border border-white/15 p-1.5 shadow-2xl z-30">
                <div className="px-2.5 py-1.5 text-[11px] font-semibold text-white/60 border-b border-white/10 mb-1">
                  Дата записи ({retentionDays} дн.)
                </div>
                <div className="max-h-60 overflow-y-auto space-y-0.5">
                  {retentionDaysList.map((dayStr, idx) => {
                    const selected = dayStr === displayDayIso;
                    return (
                      <button
                        key={dayStr}
                        type="button"
                        onClick={() => {
                          setActivePopover(null);
                          onChangeArchiveDay?.(dayStr);
                          if (idx === 0 && playbackMode === 'live') {
                            const targetTs = Math.max(retentionMinSec, liveNowSec - 300);
                            commitArchiveScrub(targetTs);
                          } else {
                            // Jump to matching clock hour on selected day, or 12:00 if earlier than now
                            const curD = new Date(sliderDisplayTs * 1000);
                            const pad = (n: number) => String(n).padStart(2, '0');
                            const hhmmss = `${pad(curD.getHours())}:${pad(curD.getMinutes())}:00`;
                            const candSec = Math.floor(new Date(`${dayStr}T${hhmmss}`).getTime() / 1000);
                            const targetTs = Math.max(
                              retentionMinSec,
                              Math.min(nowLimitSec - 10, Number.isFinite(candSec) ? candSec : nowLimitSec - 3600)
                            );
                            onSeekArchiveTimestamp?.(targetTs);
                          }
                        }}
                        className={`w-full px-2.5 py-1.5 rounded-xl text-xs flex items-center justify-between transition-colors cursor-pointer ${
                          selected
                            ? 'bg-[#2563EB] text-white font-semibold'
                            : 'text-white/90 hover:bg-white/10'
                        }`}
                      >
                        <span>{formatDayOptionLabel(dayStr, idx)}</span>
                        {selected && <Check className="w-3.5 h-3.5 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
