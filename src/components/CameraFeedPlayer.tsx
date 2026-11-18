import React, { useEffect, useMemo, useRef, useState } from 'react';
import mpegts from 'mpegts.js';
import {
  Camera as CameraIcon,
  Copy,
  Check,
  Download,
  Maximize2,
  Minimize2,
  RefreshCw,
  Volume2,
  VolumeX,
  AlertCircle,
  Play,
  Pause,
  Info,
  Gauge,
} from 'lucide-react';
import { CameraItem, EgSession } from '../types/eg';
import {
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
  onCaptureNotice?: (msg: string) => void;
  onSeekArchiveTimestamp?: (newTimestampSec: number) => void;
  onDiscoverMinAvailableTs?: (cameraId: string, minTs: number, label?: string) => void;
  onRequestFallbackEventMp4?: (targetTimestampSec: number) => boolean;
  onSwitchToDvrStream?: () => void;
  onOpenNearestEvent?: () => void;
}

const SPEED_OPTIONS = [0.5, 1, 1.25, 1.5, 2, 4] as const;

function formatClockHMS(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatClipTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatLocalIsoDateFromUnix(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
  const speedMenuRef = useRef<HTMLDivElement | null>(null);
  const infoMenuRef = useRef<HTMLDivElement | null>(null);
  const suppressNextVideoClickRef = useRef<boolean>(false);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [errorMinTs, setErrorMinTs] = useState<number | null>(null);
  const [discoveredMinTs, setDiscoveredMinTs] = useState<number | null>(knownMinAvailableTs);
  const [upstreamUrl, setUpstreamUrl] = useState<string | null>(null);

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
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [clipCurrentTime, setClipCurrentTime] = useState<number>(0);
  const [clipDuration, setClipDuration] = useState<number>(0);

  // Archive DVR elapsed clock & scrub target
  const [streamElapsedSec, setStreamElapsedSec] = useState<number>(0);
  const [scrubPreviewTs, setScrubPreviewTs] = useState<number | null>(null);

  // YouTube-style overlay visibility & popovers ('speed' | 'info' | null)
  const [hudActive, setHudActive] = useState<boolean>(true);
  const [activePopover, setActivePopover] = useState<'speed' | 'info' | null>(null);
  const [popoverAlign, setPopoverAlign] = useState<'left' | 'right'>('right');

  const [downloadingMp4, setDownloadingMp4] = useState<boolean>(false);
  const [copiedUrl, setCopiedUrl] = useState<boolean>(false);
  const [reloadNonce, setReloadNonce] = useState<number>(0);

  const effectiveMinAvailableTs = discoveredMinTs ?? knownMinAvailableTs ?? null;

  useEffect(() => {
    setDiscoveredMinTs(knownMinAvailableTs ?? null);
    setErrorMinTs(null);
  }, [camera.id]);

  useEffect(() => {
    if (knownMinAvailableTs != null) {
      setDiscoveredMinTs(knownMinAvailableTs);
    }
  }, [knownMinAvailableTs]);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Auto-hide HUD after 2.8s of cursor inactivity while playing
  const triggerHudActivity = () => {
    setHudActive(true);
    if (hideHudTimerRef.current != null) {
      window.clearTimeout(hideHudTimerRef.current);
    }
    hideHudTimerRef.current = window.setTimeout(() => {
      if (!hudBarHoverRef.current) {
        setHudActive(false);
      }
    }, 2800);
  };

  useEffect(() => {
    return () => {
      if (hideHudTimerRef.current != null) {
        window.clearTimeout(hideHudTimerRef.current);
      }
    };
  }, []);

  // Close speed/info popover when clicking anywhere outside or pressing Escape
  useEffect(() => {
    if (!activePopover) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      const activeWrapper =
        activePopover === 'speed' ? speedMenuRef.current : infoMenuRef.current;
      if (activeWrapper && target && activeWrapper.contains(target)) {
        return;
      }
      // If user clicked directly on the video element to dismiss the menu, don't toggle play/pause
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
        setActivePopover(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activePopover]);

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
            if (
              playbackMode === 'archive_stream' &&
              archiveTimestampSec != null &&
              archiveTimestampSec < minTs &&
              onRequestFallbackEventMp4?.(archiveTimestampSec)
            ) {
              setLoading(false);
              return;
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

  // Compute real-time clock bounds for archive_stream timeline scrubber
  const nowLimitSec = Math.floor(Date.now() / 1000) - 5;
  const currentArchiveUnixSec =
    (archiveTimestampSec || nowLimitSec - 600) + Math.floor(streamElapsedSec);

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
      ? Math.max(sliderBounds.minSec, Math.min(sliderBounds.maxSec, scrubPreviewTs))
      : Math.max(sliderBounds.minSec, Math.min(sliderBounds.maxSec, currentArchiveUnixSec));

  const commitArchiveScrub = (rawTargetTs: number | null) => {
    if (rawTargetTs === null) return;
    const clamped = Math.max(
      sliderBounds.minSec,
      Math.min(sliderBounds.maxSec, Math.floor(rawTargetTs))
    );
    setScrubPreviewTs(null);
    onSeekArchiveTimestamp?.(clamped);
  };

  const handleTogglePopover = (
    kind: 'speed' | 'info',
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

  const handleStepArchiveOrClip = (deltaSec: number) => {
    triggerHudActivity();
    if (playbackMode === 'event_mp4' && videoRef.current) {
      const dur = Number.isFinite(videoRef.current.duration)
        ? videoRef.current.duration
        : activeEventDurationSec || 20;
      const nextTime = Math.max(0, Math.min(dur, videoRef.current.currentTime + deltaSec));
      videoRef.current.currentTime = nextTime;
      setClipCurrentTime(nextTime);
      return;
    }

    if (
      playbackMode === 'archive_stream' &&
      videoRef.current &&
      videoRef.current.buffered.length > 0
    ) {
      const targetElTime = videoRef.current.currentTime + deltaSec;
      const bufStart = videoRef.current.buffered.start(0);
      const bufEnd = videoRef.current.buffered.end(videoRef.current.buffered.length - 1);
      if (targetElTime >= bufStart && targetElTime <= bufEnd - 0.5) {
        videoRef.current.currentTime = targetElTime;
        setStreamElapsedSec(Math.floor(targetElTime));
        return;
      }
    }

    const baseTs =
      (archiveTimestampSec || Math.floor(Date.now() / 1000) - 600) +
      Math.floor(streamElapsedSec);
    let nextTs = Math.min(Math.floor(Date.now() / 1000) - 5, baseTs + deltaSec);

    if (effectiveMinAvailableTs != null && nextTs < effectiveMinAvailableTs) {
      if (onRequestFallbackEventMp4?.(nextTs)) {
        return;
      }
      nextTs = effectiveMinAvailableTs;
      onCaptureNotice?.(
        `Начало DVR-буфера камеры: ${formatClockHMS(effectiveMinAvailableTs)}. Более ранние моменты доступны через «Смотреть» в списке событий.`
      );
    }

    onSeekArchiveTimestamp?.(nextTs);
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
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      containerRef.current.requestFullscreen().catch(() => {});
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

  const seekSteps =
    playbackMode === 'event_mp4'
      ? [
          { delta: -15, label: '-15с' },
          { delta: -5, label: '-5с' },
          { delta: 5, label: '+5с' },
          { delta: 15, label: '+15с' },
        ]
      : [
          { delta: -300, label: '-5м' },
          { delta: -60, label: '-1м' },
          { delta: -15, label: '-15с' },
          { delta: 15, label: '+15с' },
          { delta: 60, label: '+1м' },
        ];

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
      className="relative aspect-video w-full h-full bg-black overflow-hidden select-none"
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

      {/* Top Subtle Overlay Header (Shown on Hover / Pause) */}
      <div
        className={`absolute inset-x-0 top-0 px-4 pt-3 pb-8 bg-gradient-to-b from-black/75 via-black/35 to-transparent flex items-start justify-between gap-3 transition-opacity duration-200 pointer-events-none ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-white truncate drop-shadow-sm">
            {camera.name}
          </span>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-black/55 backdrop-blur-sm text-[11px] font-mono text-white/90 shrink-0">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                playbackMode === 'live' ? 'bg-emerald-400' : 'bg-[#3B82F6]'
              }`}
            />
            {playbackMode === 'live'
              ? 'Прямой эфир'
              : playbackMode === 'event_mp4' && archiveTimestampSec
              ? `Событие ${formatClockHMS(archiveTimestampSec)}`
              : `Архив ${formatClockHMS(sliderDisplayTs)}`}
          </span>
          {playbackMode !== 'live' && playbackRate !== 1 && (
            <span className="px-1.5 py-0.5 rounded bg-[#2563EB] text-white text-[10px] font-mono font-bold">
              {playbackRate}x
            </span>
          )}
        </div>

        {/* Audio Autoplay Suspended Prompt */}
        {!muted && audioStatus.contextState === 'suspended' && playbackMode !== 'event_mp4' && (
          <button
            type="button"
            onClick={() => audioEngineRef.current?.resumeContext()}
            className="pointer-events-auto px-3 py-1.5 rounded-lg bg-[#2563EB] hover:bg-blue-700 text-white font-semibold text-xs shadow-lg flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Volume2 className="w-3.5 h-3.5" />
            <span>Включить звук</span>
          </button>
        )}
      </div>

      {/* Loading Overlay */}
      {loading && (
        <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2.5 text-white pointer-events-none">
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
        <div className="absolute inset-x-4 top-14 bg-black/90 backdrop-blur-md border border-rose-500/50 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 z-20">
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
                  className="px-3 py-1.5 text-xs font-semibold bg-[#2563EB] hover:bg-blue-700 text-white rounded-lg whitespace-nowrap transition-colors cursor-pointer"
                >
                  Поток DVR
                </button>
              )}
            {errorMinTs != null && onSeekArchiveTimestamp && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  onSeekArchiveTimestamp(errorMinTs);
                }}
                className="px-3 py-1.5 text-xs font-semibold bg-[#2563EB] hover:bg-blue-700 text-white rounded-lg whitespace-nowrap transition-colors cursor-pointer"
              >
                Перейти к {formatClockHMS(errorMinTs)}
              </button>
            )}
            {playbackMode === 'archive_stream' &&
              nearestEventInfo &&
              onOpenNearestEvent && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    onOpenNearestEvent();
                  }}
                  className="px-3 py-1.5 text-xs font-semibold bg-[#2563EB] hover:bg-blue-700 text-white rounded-lg whitespace-nowrap transition-colors cursor-pointer"
                >
                  Ближайшее событие ({formatClockHMS(nearestEventInfo.timestamp)})
                </button>
              )}
            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
              className="px-3 py-1.5 text-xs font-medium bg-white/15 hover:bg-white/25 text-white rounded-lg whitespace-nowrap transition-colors cursor-pointer"
            >
              Переподключить
            </button>
          </div>
        </div>
      )}

      {/* YouTube-Style Floating Bottom HUD Overlay */}
      <div
        onMouseEnter={() => {
          hudBarHoverRef.current = true;
          setHudActive(true);
        }}
        onMouseLeave={() => {
          hudBarHoverRef.current = false;
        }}
        onClick={(e) => e.stopPropagation()}
        className={`absolute inset-x-0 bottom-0 pt-12 pb-2.5 px-3.5 bg-gradient-to-t from-black/95 via-black/70 to-transparent transition-all duration-200 z-10 ${
          showControls
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 translate-y-1 pointer-events-none'
        }`}
      >
        {/* Row 1: Timeline Scrubber Progress Bar */}
        {playbackMode === 'event_mp4' ? (
          <div className="flex items-center gap-2.5 mb-2">
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
              aria-label="Перемотка MP4 видеоролика"
              className="w-full accent-[#3B82F6] cursor-pointer h-1.5 bg-white/25 rounded-full"
            />
          </div>
        ) : playbackMode === 'archive_stream' ? (
          <div className="mb-2 space-y-1">
            <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums text-white/80">
              <span>{formatClockHMS(sliderBounds.minSec)}</span>
              <input
                type="range"
                min={sliderBounds.minSec}
                max={sliderBounds.maxSec}
                step={1}
                value={sliderDisplayTs}
                onChange={(e) => {
                  setScrubPreviewTs(parseInt(e.target.value, 10));
                }}
                onMouseUp={() => commitArchiveScrub(scrubPreviewTs)}
                onTouchEnd={() => commitArchiveScrub(scrubPreviewTs)}
                onKeyUp={() => commitArchiveScrub(scrubPreviewTs)}
                aria-label="Ползунок перемотки архива"
                className="flex-1 accent-[#3B82F6] cursor-pointer h-1.5 bg-white/25 rounded-full"
              />
              <span>{formatClockHMS(sliderBounds.maxSec)}</span>
            </div>
          </div>
        ) : null}

        {/* Row 2: Unified Single-Line YouTube Control Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-white">
          {/* Left Controls: Play/Pause, Rewind Steps, Volume 0-100%, Time */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={handleTogglePlayPause}
              className="p-1.5 rounded-lg hover:bg-white/15 text-white transition-colors cursor-pointer"
              title={isPaused ? 'Воспроизвести' : 'Пауза'}
            >
              {isPaused ? (
                <Play className="w-4 h-4 fill-current" />
              ) : (
                <Pause className="w-4 h-4 fill-current" />
              )}
            </button>

            {playbackMode !== 'live' && (
              <div className="flex items-center gap-0.5">
                {seekSteps.map((step) => (
                  <button
                    key={step.label}
                    type="button"
                    onClick={() => handleStepArchiveOrClip(step.delta)}
                    className="px-1.5 py-1 text-[11px] font-mono tabular-nums rounded-md hover:bg-white/15 text-white/90 transition-colors cursor-pointer"
                    title={`Перемотка ${step.label}`}
                  >
                    {step.label}
                  </button>
                ))}
              </div>
            )}

            {/* Volume 0%..100% */}
            <div className="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-lg hover:bg-white/10 transition-colors">
              <button
                type="button"
                onClick={() => {
                  const nextMuted = !muted;
                  setMuted(nextMuted);
                  audioEngineRef.current?.setMuted(nextMuted);
                }}
                className="text-white hover:text-white/80 transition-colors cursor-pointer"
                title={muted ? 'Включить звук' : 'Выключить звук'}
              >
                {muted || volume === 0 ? (
                  <VolumeX className="w-4 h-4 text-blue-400" />
                ) : (
                  <Volume2 className="w-4 h-4 text-white" />
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
                aria-label="Громкость звука (0–100%)"
                className="w-16 accent-[#3B82F6] cursor-pointer h-1 bg-white/30 rounded-full"
              />

              <span className="font-mono tabular-nums text-[11px] text-white/85 w-8 text-right">
                {muted ? '0%' : `${Math.round(Math.min(1, volume) * 100)}%`}
              </span>
            </div>

            {/* Time Display */}
            <span className="text-[11px] font-mono tabular-nums text-white/90 px-1">
              {playbackMode === 'live'
                ? 'Прямой эфир'
                : playbackMode === 'event_mp4'
                ? `${formatClipTime(clipCurrentTime)} / ${formatClipTime(
                    clipDuration || activeEventDurationSec || 20
                  )}`
                : formatClockHMS(sliderDisplayTs)}
            </span>
          </div>

          {/* Right Controls: Speed, Screenshot, Download MP4, Stream Info, Fullscreen */}
          <div className="flex items-center gap-1">
            {playbackMode !== 'live' && (
              <div ref={speedMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => handleTogglePopover('speed', speedMenuRef.current)}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-mono font-semibold transition-colors cursor-pointer ${
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
                  <div
                    className={`absolute bottom-full mb-2 ${
                      popoverAlign === 'left' ? 'left-0' : 'right-0'
                    } w-44 rounded-xl bg-black/92 backdrop-blur-md border border-white/15 p-1.5 shadow-xl z-30`}
                  >
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
                          className={`w-full px-2.5 py-1.5 rounded-lg text-xs font-mono flex items-center justify-between transition-colors cursor-pointer ${
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
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-white/15 text-[11px] font-medium text-white/90 transition-colors cursor-pointer"
              title="Сделать скриншот кадра"
            >
              <CameraIcon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Скриншот</span>
            </button>

            {playbackMode !== 'live' && (
              <button
                type="button"
                onClick={handleDownloadVideo}
                disabled={downloadingMp4}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#2563EB] hover:bg-blue-700 disabled:opacity-60 text-white text-[11px] font-semibold transition-colors cursor-pointer"
                title={
                  playbackMode === 'event_mp4'
                    ? 'Скачать полное видео события (MP4)'
                    : `Скачать фрагмент с ${formatClockHMS(sliderDisplayTs)} до ${formatClockHMS(
                        sliderDisplayTs + downloadDurationSec
                      )} (${downloadDurationSec} сек, MP4)`
                }
              >
                {downloadingMp4 ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                <span className="hidden sm:inline">
                  {downloadingMp4 ? 'Скачивание...' : 'Скачать'}
                </span>
              </button>
            )}

            <div ref={infoMenuRef} className="relative">
              <button
                type="button"
                onClick={() => handleTogglePopover('info', infoMenuRef.current)}
                className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                  activePopover === 'info'
                    ? 'bg-white/25 text-white'
                    : 'hover:bg-white/15 text-white/90'
                }`}
                title="Сведения и ссылка на поток"
              >
                <Info className="w-4 h-4" />
              </button>

              {activePopover === 'info' && (
                <div
                  className={`absolute bottom-full mb-2 ${
                    popoverAlign === 'left' ? 'left-0' : 'right-0'
                  } w-72 max-w-[85vw] rounded-xl bg-black/92 backdrop-blur-md border border-white/15 p-3.5 shadow-xl text-xs text-white/90 space-y-2 z-30`}
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
                        className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] font-medium transition-colors cursor-pointer"
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
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] font-medium transition-colors cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Переподключить</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={handleFullscreen}
              className="p-1.5 rounded-lg hover:bg-white/15 text-white/90 transition-colors cursor-pointer"
              title={isFullscreen ? 'Выйти из полноэкранного режима' : 'Во весь экран'}
            >
              {isFullscreen ? (
                <Minimize2 className="w-4 h-4" />
              ) : (
                <Maximize2 className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
