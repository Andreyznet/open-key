import React, { useEffect, useRef } from 'react';

interface ProceduralCameraCanvasProps {
  cameraId: string;
  cameraName: string;
  scene?: 'entrance' | 'gate' | 'barrier' | 'elevator' | 'playground' | 'parking';
  animated?: boolean;
  archiveTimestampSec?: number | null;
  playbackSpeed?: number;
  doorUnlockedPulse?: boolean;
  refreshTick?: number;
  className?: string;
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
}

export const ProceduralCameraCanvas: React.FC<ProceduralCameraCanvasProps> = ({
  cameraId,
  cameraName,
  scene = 'entrance',
  animated = false,
  archiveTimestampSec = null,
  playbackSpeed = 1,
  doorUnlockedPulse = false,
  refreshTick = 0,
  className = '',
  onCanvasReady,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const startWallRef = useRef<number>(Date.now());

  useEffect(() => {
    startWallRef.current = Date.now();
  }, [archiveTimestampSec]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (onCanvasReady) {
      onCanvasReady(canvas);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animFrameId: number | null = null;

    const drawFrame = (nowMs: number) => {
      const w = canvas.width;
      const h = canvas.height;
      const elapsedSec = ((nowMs - startWallRef.current) / 1000) * playbackSpeed;
      const effectiveTimeSec = archiveTimestampSec
        ? archiveTimestampSec + elapsedSec
        : nowMs / 1000 + refreshTick * 17;

      const t = animated ? effectiveTimeSec : Math.floor(effectiveTimeSec);

      // Clear & Base sky / room gradient
      ctx.save();
      if (scene === 'elevator') {
        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#1e242c');
        grad.addColorStop(0.5, '#2b333e');
        grad.addColorStop(1, '#151920');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // Brushed steel cabin panels
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 2;
        ctx.strokeRect(w * 0.12, h * 0.08, w * 0.76, h * 0.84);

        // Mirror panel
        const mirrorGrad = ctx.createLinearGradient(w * 0.25, h * 0.14, w * 0.75, h * 0.65);
        mirrorGrad.addColorStop(0, '#334155');
        mirrorGrad.addColorStop(0.5, '#475569');
        mirrorGrad.addColorStop(1, '#1e293b');
        ctx.fillStyle = mirrorGrad;
        ctx.fillRect(w * 0.24, h * 0.14, w * 0.52, h * 0.52);

        // Handrail
        ctx.fillStyle = '#94a3b8';
        ctx.fillRect(w * 0.2, h * 0.68, w * 0.6, 8);

        // Floor tiles
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(w * 0.12, h * 0.85);
        ctx.lineTo(w * 0.88, h * 0.85);
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();

        // Digital floor indicator inside cabin
        const floorNum = (Math.floor(t / 4) % 9) + 1;
        ctx.fillStyle = '#090d16';
        ctx.fillRect(w * 0.8, h * 0.22, 64, 88);
        ctx.fillStyle = '#38bdf8';
        ctx.font = '600 28px "JetBrains Mono", monospace';
        ctx.fillText(`0${floorNum}`, w * 0.8 + 14, h * 0.22 + 54);
      } else if (scene === 'parking') {
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#0f141c');
        grad.addColorStop(0.4, '#1b2230');
        grad.addColorStop(1, '#131822');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // Concrete pillars
        ctx.fillStyle = '#263042';
        ctx.fillRect(w * 0.08, h * 0.12, 54, h * 0.65);
        ctx.fillRect(w * 0.84, h * 0.12, 54, h * 0.65);

        // Yellow safety stripes on pillars
        ctx.fillStyle = '#eab308';
        for (let y = h * 0.52; y < h * 0.72; y += 22) {
          ctx.fillRect(w * 0.08, y, 54, 10);
          ctx.fillRect(w * 0.84, y, 54, 10);
        }

        // Parking lane markings
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(w * 0.25, h * 0.95);
        ctx.lineTo(w * 0.38, h * 0.62);
        ctx.moveTo(w * 0.5, h * 0.95);
        ctx.lineTo(w * 0.5, h * 0.62);
        ctx.moveTo(w * 0.75, h * 0.95);
        ctx.lineTo(w * 0.62, h * 0.62);
        ctx.stroke();

        // Parked car silhouette
        ctx.fillStyle = '#334155';
        ctx.beginPath();
        ctx.roundRect(w * 0.29, h * 0.58, 130, 68, 12);
        ctx.fill();
        ctx.fillStyle = '#93c5fd';
        ctx.fillRect(w * 0.31, h * 0.6, 90, 22);
      } else {
        // Outdoor scenes: entrance, gate, barrier, playground
        const skyGrad = ctx.createLinearGradient(0, 0, 0, h * 0.55);
        skyGrad.addColorStop(0, '#1e293b');
        skyGrad.addColorStop(1, '#334155');
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, w, h * 0.55);

        // Ground / courtyard asphalt
        const groundGrad = ctx.createLinearGradient(0, h * 0.45, 0, h);
        groundGrad.addColorStop(0, '#1e2530');
        groundGrad.addColorStop(1, '#0f141c');
        ctx.fillStyle = groundGrad;
        ctx.fillRect(0, h * 0.45, w, h * 0.55);

        // Background residential buildings
        ctx.fillStyle = '#273244';
        ctx.fillRect(w * 0.05, h * 0.1, w * 0.28, h * 0.38);
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(w * 0.66, h * 0.08, w * 0.29, h * 0.4);

        // Lit apartment windows
        for (let wy = h * 0.14; wy < h * 0.42; wy += 28) {
          for (let wx = w * 0.08; wx < w * 0.3; wx += 34) {
            ctx.fillStyle = ((wx + wy) % 3 === 0) ? 'rgba(253, 224, 71, 0.35)' : 'rgba(148, 163, 184, 0.18)';
            ctx.fillRect(wx, wy, 18, 16);
          }
          for (let wx = w * 0.69; wx < w * 0.91; wx += 34) {
            ctx.fillStyle = ((wx * 2 + wy) % 4 === 0) ? 'rgba(253, 224, 71, 0.3)' : 'rgba(148, 163, 184, 0.18)';
            ctx.fillRect(wx, wy, 18, 16);
          }
        }

        // Scene-specific foreground architectural structure
        if (scene === 'barrier') {
          // Security booth & automatic barrier arm
          ctx.fillStyle = '#334155';
          ctx.fillRect(w * 0.16, h * 0.46, 42, 92);
          ctx.fillStyle = '#ef4444';
          ctx.fillRect(w * 0.16, h * 0.46, 42, 14);

          // Barrier arm (opens up if doorUnlockedPulse is true!)
          ctx.save();
          ctx.translate(w * 0.18, h * 0.5);
          const armAngle = doorUnlockedPulse ? -Math.PI / 2.6 : 0;
          ctx.rotate(armAngle);
          ctx.fillStyle = '#f8fafc';
          ctx.fillRect(0, -6, w * 0.52, 12);
          ctx.fillStyle = '#ef4444';
          for (let rx = 24; rx < w * 0.5; rx += 56) {
            ctx.fillRect(rx, -6, 28, 12);
          }
          ctx.restore();

          // Moving vehicle along driveway
          const carPos = ((t * 42) % (w + 220)) - 110;
          ctx.fillStyle = '#475569';
          ctx.beginPath();
          ctx.roundRect(carPos, h * 0.66, 136, 54, 10);
          ctx.fill();
          ctx.fillStyle = '#fef08a';
          ctx.fillRect(carPos + 128, h * 0.69, 8, 12);
          ctx.fillRect(carPos + 128, h * 0.75, 8, 12);
        } else if (scene === 'gate') {
          // Wrought iron courtyard perimeter fence & pedestrian gate
          ctx.strokeStyle = '#475569';
          ctx.lineWidth = 4;
          for (let fx = w * 0.08; fx < w * 0.92; fx += 26) {
            if (fx > w * 0.42 && fx < w * 0.58 && doorUnlockedPulse) continue;
            ctx.beginPath();
            ctx.moveTo(fx, h * 0.36);
            ctx.lineTo(fx, h * 0.78);
            ctx.stroke();
          }
          ctx.fillStyle = doorUnlockedPulse ? '#10b981' : '#38bdf8';
          ctx.fillRect(w * 0.58, h * 0.52, 14, 24);
        } else if (scene === 'playground') {
          // Courtyard walkway & trees
          ctx.fillStyle = '#14532d';
          ctx.beginPath();
          ctx.arc(w * 0.25, h * 0.44, 48, 0, Math.PI * 2);
          ctx.arc(w * 0.76, h * 0.42, 54, 0, Math.PI * 2);
          ctx.fill();

          // Sports ground court rectangle
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
          ctx.lineWidth = 3;
          ctx.strokeRect(w * 0.28, h * 0.58, w * 0.44, h * 0.26);
        } else {
          // Entrance porch view (Intercom main entrance)
          ctx.strokeStyle = '#475569';
          ctx.lineWidth = 6;
          ctx.strokeRect(w * 0.28, h * 0.16, w * 0.44, h * 0.68);

          // Pedestrian silhouette walking near porch
          const pedX = w * 0.35 + Math.sin(t * 0.7) * (w * 0.18);
          const pedY = h * 0.54 + Math.cos(t * 0.5) * 14;
          ctx.fillStyle = '#64748b';
          ctx.beginPath();
          ctx.arc(pedX, pedY - 26, 12, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.roundRect(pedX - 16, pedY - 12, 32, 48, 8);
          ctx.fill();

          // Motion detection bounding frame in archive mode
          if (archiveTimestampSec != null) {
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 2;
            ctx.strokeRect(pedX - 28, pedY - 46, 56, 94);
            ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
            ctx.fillRect(pedX - 28, pedY - 66, 96, 18);
            ctx.fillStyle = '#38bdf8';
            ctx.font = '500 11px "JetBrains Mono", monospace';
            ctx.fillText('MOTION #126', pedX - 24, pedY - 53);
          }
        }
      }

      // Unlock overlay banner if lock was just triggered
      if (doorUnlockedPulse) {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.88)';
        ctx.fillRect(w * 0.5 - 150, h * 0.12, 300, 38);
        ctx.fillStyle = '#ffffff';
        ctx.font = '600 14px "Manrope", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('ЗАМОК ОТКРЫТ · ПРОХОД РАЗРЕШЁН', w * 0.5, h * 0.12 + 24);
        ctx.textAlign = 'left';
      }

      // Top-left OSD: Camera ID + Name
      ctx.fillStyle = 'rgba(9, 13, 22, 0.72)';
      ctx.fillRect(14, 14, Math.min(w - 28, 380), 32);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '500 13px "JetBrains Mono", monospace';
      ctx.fillText(`CAM ${cameraId.slice(-6).toUpperCase()} · ${cameraName.slice(0, 26)}`, 24, 35);

      // Bottom-right OSD: Novosibirsk UTC+7 Timestamp (`tabular-nums`)
      const displayDate = new Date(effectiveTimeSec * 1000);
      const pad = (n: number) => String(n).padStart(2, '0');
      const dateStr = `${displayDate.getFullYear()}-${pad(displayDate.getMonth() + 1)}-${pad(displayDate.getDate())} ${pad(displayDate.getHours())}:${pad(displayDate.getMinutes())}:${pad(displayDate.getSeconds())}`;
      const modeTag = archiveTimestampSec != null ? 'ARCHIVE PLAYBACK' : 'H.264 1080P';

      const osdText = `${modeTag} · ${dateStr}`;
      ctx.fillStyle = 'rgba(9, 13, 22, 0.72)';
      ctx.fillRect(w - 310, h - 42, 296, 28);
      ctx.fillStyle = archiveTimestampSec != null ? '#fbbf24' : '#f8fafc';
      ctx.font = '500 12px "JetBrains Mono", monospace';
      ctx.fillText(osdText, w - 300, h - 24);

      ctx.restore();
    };

    if (animated) {
      const loop = () => {
        drawFrame(Date.now());
        animFrameId = requestAnimationFrame(loop);
      };
      loop();
    } else {
      drawFrame(Date.now());
    }

    return () => {
      if (animFrameId != null) {
        cancelAnimationFrame(animFrameId);
      }
    };
  }, [cameraId, cameraName, scene, animated, archiveTimestampSec, playbackSpeed, doorUnlockedPulse, refreshTick, onCanvasReady]);

  return (
    <canvas
      ref={canvasRef}
      width={800}
      height={450}
      className={`w-full h-full object-cover bg-slate-950 ${className}`}
    />
  );
};
