import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { CameraItem, EgSession } from '../types/eg';
import { buildSnapshotUrl } from '../services/egClient';
import {
  fetchAndCacheSnapshot,
  getMemoryCachedSnapshotUrl,
  isSnapshotFreshForTick,
  loadCachedSnapshotUrl,
  subscribeSnapshotCache,
} from '../utils/snapshotCache';
import { ProceduralCameraCanvas } from './ProceduralCameraCanvas';

interface CachedCameraImageProps {
  session: EgSession;
  camera: CameraItem;
  refreshTick: number;
  forceRefreshNonce?: number;
  width?: number;
  height?: number;
  spinnerSize?: 'sm' | 'md';
  doorUnlockedPulse?: boolean;
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
  onResolvedUrl?: (url: string | null) => void;
  onLoadStateChange?: (loading: boolean) => void;
  onRefreshError?: (message: string) => void;
  className?: string;
}

export const CachedCameraImage: React.FC<CachedCameraImageProps> = ({
  session,
  camera,
  refreshTick,
  forceRefreshNonce = 0,
  width = 1280,
  height = 720,
  spinnerSize = 'md',
  doorUnlockedPulse = false,
  onCanvasReady,
  onResolvedUrl,
  onLoadStateChange,
  onRefreshError,
  className = 'w-full h-full object-cover',
}) => {
  const [cachedSrc, setCachedSrc] = useState<string | null>(() =>
    getMemoryCachedSnapshotUrl(camera.id)
  );
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [fetchFailedWithoutCache, setFetchFailedWithoutCache] = useState<boolean>(false);
  const lastHandledForceNonceRef = useRef<number>(forceRefreshNonce);

  // Sync from memory/IndexedDB cache whenever camera.id changes
  useEffect(() => {
    let active = true;
    const mem = getMemoryCachedSnapshotUrl(camera.id);
    setCachedSrc(mem);
    setFetchFailedWithoutCache(false);

    if (!mem && session.mode === 'live') {
      loadCachedSnapshotUrl(camera.id).then((url) => {
        if (active && url) {
          setCachedSrc(url);
        }
      });
    }

    const unsubscribe = subscribeSnapshotCache(camera.id, (nextUrl) => {
      if (active) {
        setCachedSrc(nextUrl);
        setFetchFailedWithoutCache(false);
        onResolvedUrl?.(nextUrl);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [camera.id, session.mode]);

  // Background fetch of the fresh snapshot on mount & on refreshTick / forceRefreshNonce change
  useEffect(() => {
    const isManualForce = forceRefreshNonce !== lastHandledForceNonceRef.current;
    lastHandledForceNonceRef.current = forceRefreshNonce;

    if (session.mode !== 'live') {
      setIsRefreshing(false);
      onLoadStateChange?.(false);
      return;
    }

    const existingMem = getMemoryCachedSnapshotUrl(camera.id);
    if (!isManualForce && existingMem && isSnapshotFreshForTick(camera.id, refreshTick)) {
      setCachedSrc(existingMem);
      setIsRefreshing(false);
      onLoadStateChange?.(false);
      onResolvedUrl?.(existingMem);
      return;
    }

    const controller = new AbortController();
    let active = true;

    setIsRefreshing(true);
    onLoadStateChange?.(true);

    const cacheBuster = isManualForce ? Date.now() : refreshTick;
    const requestUrl = buildSnapshotUrl(
      session,
      camera.id,
      camera.placeId,
      cacheBuster,
      width,
      height,
      {
        accessControlId: camera.accessControlId,
        entranceId: camera.entranceId,
      }
    );

    fetchAndCacheSnapshot(camera.id, requestUrl, controller.signal, refreshTick, isManualForce)
      .then((newUrl) => {
        if (!active) return;
        if (newUrl) {
          setCachedSrc(newUrl);
          setFetchFailedWithoutCache(false);
          onResolvedUrl?.(newUrl);
        }
      })
      .catch((err: any) => {
        if (!active || controller.signal.aborted) return;
        if (!getMemoryCachedSnapshotUrl(camera.id) && !cachedSrc) {
          setFetchFailedWithoutCache(true);
        }
        if (isManualForce) {
          onRefreshError?.(err?.message || 'Не удалось обновить кадр');
        }
      })
      .finally(() => {
        if (!active) return;
        setIsRefreshing(false);
        onLoadStateChange?.(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [
    session,
    camera.id,
    camera.placeId,
    camera.accessControlId,
    camera.entranceId,
    refreshTick,
    forceRefreshNonce,
    width,
    height,
  ]);

  const showImg = session.mode === 'live' && Boolean(cachedSrc) && !fetchFailedWithoutCache;

  return (
    <div className="relative w-full h-full bg-[#0b0f17]">
      {showImg && cachedSrc ? (
        <img
          src={cachedSrc}
          alt={`Камера ${camera.name}`}
          className={className}
        />
      ) : (
        <ProceduralCameraCanvas
          cameraId={camera.id}
          cameraName={camera.name}
          scene={camera.demoScene || (camera.source === 'intercom' ? 'entrance' : 'playground')}
          animated={false}
          doorUnlockedPulse={doorUnlockedPulse}
          refreshTick={refreshTick}
          onCanvasReady={onCanvasReady}
          className={className}
        />
      )}

      {session.mode === 'live' && isRefreshing && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div
            className={`rounded-full bg-black/55 backdrop-blur-[1px] flex items-center justify-center text-white shadow-md ${
              spinnerSize === 'sm' ? 'w-6 h-6' : 'w-9 h-9'
            }`}
          >
            <Loader2
              className={`animate-spin text-white ${
                spinnerSize === 'sm' ? 'w-3.5 h-3.5' : 'w-5 h-5'
              }`}
            />
          </div>
        </div>
      )}
    </div>
  );
};
