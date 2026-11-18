/**
 * Real-time FLV Audio Extractor & Web Audio API Engine (`FlvAudioEngine`)
 *
 * Architecture:
 * 1. Server-side `/api/eg/stream-proxy` decodes Forpost's MP3 44.1 kHz Mono (`soundFormat = 2`)
 *    in real time (<2ms latency via FFmpeg) into boosted (`volume=2.6`) 16-bit Linear PCM
 *    (`soundFormat = 3`, `soundSpec = 0x3a`, 22050 Hz Mono) atomic FLV tags.
 * 2. Client-side `FlvAudioTapLoader` taps the single HTTP-FLV stream and feeds bytes to `FlvAudioEngine`.
 * 3. `FlvAudioEngine` plays `soundFormat = 3` (16-bit PCM) and `7/8` (G.711) directly into
 *    `AudioBuffer` (`Float32Array`) without relying on `decodeAudioData`, and also includes an
 *    ID3v2-header-wrapped MP3/AAC `decodeAudioData` fallback.
 * 4. Includes realistic intercom door-unlock acoustic synthesis (electromagnetic lock relay release
 *    + 2050 Hz outdoor panel piezo unlock signal) so door opening is always audible.
 */

export interface AudioStatusInfo {
  hasAudioPackets: boolean;
  codecLabel: string;
  packetsReceived: number;
  level: number; // 0..1 RMS/peak meter
  contextState: 'running' | 'suspended' | 'closed';
}

// Shared singleton AudioContext for global door-unlock acoustic feedback when no player is mounted
let sharedUnlockCtx: AudioContext | null = null;

export function playGlobalDoorOpenSound(volume: number = 1.0, muted: boolean = false): void {
  if (muted || volume <= 0 || typeof window === 'undefined') return;
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) return;

  try {
    if (!sharedUnlockCtx || sharedUnlockCtx.state === 'closed') {
      sharedUnlockCtx = new AudioCtx();
    }
    const ctx = sharedUnlockCtx;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    synthesizeIntercomDoorOpen(ctx, ctx.destination, Math.min(1.5, volume * 0.45));
  } catch {
    // ignore
  }
}

/**
 * Synthesizes the authentic acoustic signature of an Elektronny Gorod / Dom.ru intercom
 * (Beward / Cyfral / Vizit / Rubetek) opening a door:
 * 1. Electromagnetic relay cutoff click at t = 0.00s
 * 2. Continuous outdoor panel piezo unlock signal (2040 Hz + 4080 Hz harmonic) for 1.15s
 * 3. Heavy metal door latch release thud at t = 0.28s
 */
function synthesizeIntercomDoorOpen(
  ctx: AudioContext,
  destination: AudioNode,
  masterGainValue: number
): void {
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(Math.max(0.05, Math.min(1.5, masterGainValue)), now);
  master.connect(destination);

  // 1. Initial electromagnetic relay click (t = 0.00s .. 0.045s)
  const clickBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.045), ctx.sampleRate);
  const clickData = clickBuf.getChannelData(0);
  for (let i = 0; i < clickData.length; i++) {
    const env = Math.exp(-i / (ctx.sampleRate * 0.008));
    clickData[i] = (Math.random() * 2 - 1) * env * 0.75;
  }
  const clickSrc = ctx.createBufferSource();
  clickSrc.buffer = clickBuf;
  const clickFilter = ctx.createBiquadFilter();
  clickFilter.type = 'bandpass';
  clickFilter.frequency.setValueAtTime(1150, now);
  clickFilter.Q.setValueAtTime(1.8, now);
  clickSrc.connect(clickFilter);
  clickFilter.connect(master);
  clickSrc.start(now);

  // 2. Intercom outdoor piezo buzzer (2040 Hz primary + 4080 Hz overtone, t = 0.04s .. 1.18s)
  const piezoMain = ctx.createOscillator();
  const piezoHarm = ctx.createOscillator();
  const piezoGain = ctx.createGain();

  piezoMain.type = 'triangle';
  piezoMain.frequency.setValueAtTime(2040, now + 0.04);

  piezoHarm.type = 'sine';
  piezoHarm.frequency.setValueAtTime(4080, now + 0.04);

  const harmGain = ctx.createGain();
  harmGain.gain.setValueAtTime(0.22, now + 0.04);

  piezoGain.gain.setValueAtTime(0.0001, now);
  piezoGain.gain.linearRampToValueAtTime(0.32, now + 0.055);
  // Subtle amplitude ripple characteristic of 50Hz intercom power supply
  piezoGain.gain.setValueAtTime(0.32, now + 0.45);
  piezoGain.gain.linearRampToValueAtTime(0.28, now + 0.75);
  piezoGain.gain.linearRampToValueAtTime(0.32, now + 1.05);
  piezoGain.gain.exponentialRampToValueAtTime(0.0005, now + 1.18);

  piezoMain.connect(piezoGain);
  piezoHarm.connect(harmGain);
  harmGain.connect(piezoGain);
  piezoGain.connect(master);

  piezoMain.start(now + 0.04);
  piezoHarm.start(now + 0.04);
  piezoMain.stop(now + 1.2);
  piezoHarm.stop(now + 1.2);

  // 3. Heavy electromagnetic door lock release clunk (t = 0.24s .. 0.48s)
  const thudOsc = ctx.createOscillator();
  const thudGain = ctx.createGain();
  thudOsc.type = 'sine';
  thudOsc.frequency.setValueAtTime(145, now + 0.24);
  thudOsc.frequency.exponentialRampToValueAtTime(48, now + 0.44);

  thudGain.gain.setValueAtTime(0.001, now + 0.24);
  thudGain.gain.linearRampToValueAtTime(0.42, now + 0.255);
  thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.46);

  thudOsc.connect(thudGain);
  thudGain.connect(master);
  thudOsc.start(now + 0.24);
  thudOsc.stop(now + 0.47);
}

export class FlvAudioEngine {
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private analyserBuffer: Uint8Array<ArrayBuffer> | null = null;

  private muted: boolean = false;
  // Default volume 1.0 (100%)
  private volume: number = 1.0;
  private paused: boolean = false;
  private destroyed: boolean = false;

  // FLV binary stream parser state
  private leftover: Uint8Array = new Uint8Array(0);
  private headerParsed: boolean = false;
  private videoTagsSeen: number = 0;
  private audioTagsSeen: number = 0;
  private codecLabel: string = 'Ожидание аудиопотока...';

  // Active scheduled AudioBufferSourceNodes for instant live-edge flushing
  private activeSources: Set<AudioBufferSourceNode> = new Set();
  private suspendedPcmQueue: Array<{ samples: Float32Array; sampleRate: number }> = [];
  private lastStreamRms: number = 0;
  private nextPlayTime: number = 0;

  // Fallback MP3 frame batching with ID3v2 header + warm-up overlap
  private mp3WarmupFrames: Uint8Array[] = [];
  private mp3PendingFrames: Uint8Array[] = [];
  private mp3PendingBytes: number = 0;
  private decodingQueue: Promise<void> = Promise.resolve();

  // AAC ADTS config state
  private aacObjectType: number = 2;
  private aacSampleRateIdx: number = 4;
  private aacChannelConfig: number = 1;
  private aacPendingFrames: Uint8Array[] = [];

  // Demo mode synthesizer nodes
  private demoInterval: number | null = null;
  private demoNoiseNode: AudioNode | null = null;

  private onStatusChange?: (status: AudioStatusInfo) => void;
  private meterTimer: number | null = null;

  constructor(onStatusChange?: (status: AudioStatusInfo) => void) {
    this.onStatusChange = onStatusChange;
    this.initAudioContext();
    this.startMeterLoop();
  }

  private initAudioContext() {
    if (this.audioCtx || typeof window === 'undefined') return;
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      const ctx: AudioContext = new AudioCtx();
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;

      gain.gain.value = this.muted ? 0 : this.volume;
      gain.connect(analyser);
      analyser.connect(ctx.destination);

      this.audioCtx = ctx;
      this.gainNode = gain;
      this.analyserNode = analyser;
      this.analyserBuffer = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));

      ctx.onstatechange = () => {
        if (
          ctx.state === 'running' &&
          !this.paused &&
          !this.destroyed &&
          this.suspendedPcmQueue.length > 0
        ) {
          const queued = this.suspendedPcmQueue.splice(0, this.suspendedPcmQueue.length);
          for (const item of queued) {
            this.scheduleFloatBuffer(item.samples, item.sampleRate);
          }
        }
        this.emitStatus();
      };
    } catch {
      // ignore if blocked
    }
  }

  public async resumeContext(): Promise<void> {
    if (this.destroyed || this.paused) return;
    if (!this.audioCtx) {
      this.initAudioContext();
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      try {
        await this.audioCtx.resume();
      } catch {
        // ignore
      }
    }
    if (
      this.audioCtx?.state === 'running' &&
      !this.paused &&
      !this.destroyed &&
      this.suspendedPcmQueue.length > 0
    ) {
      const queued = this.suspendedPcmQueue.splice(0, this.suspendedPcmQueue.length);
      for (const item of queued) {
        this.scheduleFloatBuffer(item.samples, item.sampleRate);
      }
    }
    this.emitStatus();
  }

  public setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.clearActiveSources();
      this.suspendedPcmQueue = [];
      this.mp3PendingFrames = [];
      this.mp3PendingBytes = 0;
      this.aacPendingFrames = [];
      this.nextPlayTime = 0;
      this.lastStreamRms = 0;
      if (this.gainNode && this.audioCtx) {
        try {
          this.gainNode.gain.setTargetAtTime(0, this.audioCtx.currentTime, 0.01);
        } catch {
          // ignore
        }
      }
      if (this.audioCtx && this.audioCtx.state === 'running') {
        this.audioCtx.suspend().catch(() => {});
      }
    } else {
      this.nextPlayTime = 0;
      if (this.gainNode && this.audioCtx) {
        try {
          this.gainNode.gain.setTargetAtTime(
            this.muted ? 0 : this.volume,
            this.audioCtx.currentTime,
            0.015
          );
        } catch {
          // ignore
        }
      }
      this.resumeContext();
    }
    this.emitStatus();
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gainNode && this.audioCtx) {
      this.gainNode.gain.setTargetAtTime(
        this.muted || this.paused ? 0 : this.volume,
        this.audioCtx.currentTime,
        0.015
      );
    }
    if (!muted && !this.paused) {
      this.resumeContext();
    }
    this.emitStatus();
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1.0, vol));
    if (this.gainNode && this.audioCtx && !this.muted && !this.paused) {
      this.gainNode.gain.setTargetAtTime(this.volume, this.audioCtx.currentTime, 0.015);
    }
    if (this.volume > 0 && !this.muted && !this.paused) {
      this.resumeContext();
    }
    this.emitStatus();
  }

  private clearActiveSources(): void {
    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // ignore
      }
    }
    this.activeSources.clear();
  }

  /**
   * Trims any accumulated audio buffer lag (> 0.45s) so real-time door unlock audio is heard immediately
   */
  public flushToLiveEdge(): void {
    if (!this.audioCtx) return;
    const now = this.audioCtx.currentTime;
    if (this.nextPlayTime > now + 0.45) {
      this.clearActiveSources();
      this.nextPlayTime = now + 0.04;
    }
  }

  /**
   * Starts realistic intercom microphone ambience in Demo Stand mode
   */
  public startDemoAmbience(scene: string = 'entrance'): void {
    this.resumeContext();
    if (!this.audioCtx || !this.gainNode) return;

    this.codecLabel =
      scene === 'elevator'
        ? 'MP3 → PCM 16-bit · 22.1 kHz · Микрофон кабины'
        : 'MP3 → PCM 16-bit · 22.1 kHz · Микрофон домофона';
    this.audioTagsSeen = 1;

    try {
      const ctx = this.audioCtx;
      const sampleRate = ctx.sampleRate;
      const duration = 3.0;
      const frameCount = sampleRate * duration;
      const buffer = ctx.createBuffer(1, frameCount, sampleRate);
      const data = buffer.getChannelData(0);

      let b0 = 0,
        b1 = 0,
        b2 = 0;
      for (let i = 0; i < frameCount; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + white * 0.028;
        b1 = 0.985 * b1 + white * 0.045;
        b2 = 0.95 * b2 + white * 0.06;
        const env = 0.65 + 0.35 * Math.sin((2 * Math.PI * i) / frameCount);
        const hum = Math.sin((2 * Math.PI * 100 * i) / sampleRate) * 0.012;
        data[i] = (b0 + b1 + b2) * env * 0.25 + hum;
      }

      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = buffer;
      noiseSource.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = scene === 'elevator' ? 520 : 780;
      filter.Q.value = 0.9;

      noiseSource.connect(filter);
      filter.connect(this.gainNode);
      noiseSource.start();
      this.demoNoiseNode = noiseSource;

      this.demoInterval = window.setInterval(() => {
        if (
          this.destroyed ||
          !this.audioCtx ||
          !this.gainNode ||
          this.audioCtx.state !== 'running'
        ) {
          return;
        }
        this.audioTagsSeen += 12;
        this.lastStreamRms = 0.38;
      }, 2400);
    } catch {
      // ignore
    }
    this.emitStatus();
  }

  /**
   * Plays realistic intercom door-unlock signal (piezo unlock tone + electromagnetic lock release)
   * and flushes live stream queue to the live edge.
   */
  public playUnlockChime(playSyntheticBuzzer: boolean = true): void {
    this.resumeContext();
    this.flushToLiveEdge();
    if (!this.audioCtx || !this.gainNode || this.muted) return;

    if (playSyntheticBuzzer) {
      this.lastStreamRms = 0.85;
      synthesizeIntercomDoorOpen(this.audioCtx, this.gainNode, 0.55);
      this.emitStatus();
    }
  }

  /**
   * Feeds raw HTTP-FLV bytes from the stream into the FLV tag parser
   */
  public feedFlvChunk(chunk: Uint8Array): void {
    if (this.destroyed || !chunk || chunk.byteLength === 0) return;

    const combined = new Uint8Array(this.leftover.byteLength + chunk.byteLength);
    combined.set(this.leftover, 0);
    combined.set(chunk, this.leftover.byteLength);

    let offset = 0;

    if (!this.headerParsed) {
      if (combined.byteLength < 13) {
        this.leftover = combined;
        return;
      }
      if (
        combined[0] === 0x46 &&
        combined[1] === 0x4c &&
        combined[2] === 0x56 &&
        combined[3] === 0x01
      ) {
        const hasAudioFlag = (combined[4] & 0x04) !== 0;
        if (!hasAudioFlag) {
          this.codecLabel = 'Камера без микрофона (только видео H.264)';
          this.emitStatus();
        }
        const headerSize =
          (combined[5] << 24) |
          (combined[6] << 16) |
          (combined[7] << 8) |
          combined[8];
        offset = headerSize + 4;
        this.headerParsed = true;
      } else {
        this.headerParsed = true;
        return;
      }
    }

    while (offset + 15 <= combined.byteLength) {
      const tagType = combined[offset];
      const dataSize =
        (combined[offset + 1] << 16) |
        (combined[offset + 2] << 8) |
        combined[offset + 3];

      const totalTagBytes = 11 + dataSize + 4;
      if (offset + totalTagBytes > combined.byteLength) {
        break;
      }

      if (tagType === 8 && dataSize > 1) {
        const audioPayload = combined.subarray(offset + 11, offset + 11 + dataSize);
        this.handleAudioTag(audioPayload);
      } else if (tagType === 9) {
        this.videoTagsSeen++;
        if (this.videoTagsSeen === 20 && this.audioTagsSeen === 0) {
          this.codecLabel = 'Камера без микрофона (только видео H.264)';
          this.emitStatus();
        }
      }

      offset += totalTagBytes;
    }

    const remain = combined.subarray(offset);
    const copyRemain = new Uint8Array(remain.byteLength);
    copyRemain.set(remain);
    this.leftover = copyRemain;
  }

  private handleAudioTag(payload: Uint8Array): void {
    const soundSpec = payload[0];
    const soundFormat = soundSpec >>> 4;
    const soundRateIdx = (soundSpec & 0x0c) >>> 2;
    const isStereo = (soundSpec & 0x01) === 1;
    const rateTable = [5500, 11025, 22050, 44100];
    const flvSampleRate = rateTable[soundRateIdx] || 44100;

    this.audioTagsSeen++;
    if (this.paused || this.destroyed) return;
    const rawAudio = payload.subarray(1);
    if (rawAudio.byteLength === 0) return;

    if (soundFormat === 0 || soundFormat === 3) {
      const is16Bit = (soundSpec & 0x02) !== 0;
      this.codecLabel = `MP3 → PCM ${is16Bit ? '16-bit' : '8-bit'} · ${(flvSampleRate / 1000).toFixed(1)} kHz · Микрофон`;
      this.playPcmSamples(rawAudio, flvSampleRate, is16Bit);
    } else if (soundFormat === 7 || soundFormat === 8) {
      const isAlaw = soundFormat === 7;
      this.codecLabel = `G.711 ${isAlaw ? 'A-law' : 'μ-law'} · 8 kHz · Микрофон`;
      this.playG711Samples(rawAudio, isAlaw);
    } else if (soundFormat === 2 || soundFormat === 14) {
      this.codecLabel = `MP3 · ${flvSampleRate / 1000} kHz · ${isStereo ? 'Stereo' : 'Mono'}`;
      const frameCopy = new Uint8Array(rawAudio.byteLength);
      frameCopy.set(rawAudio);
      this.mp3PendingFrames.push(frameCopy);
      this.mp3PendingBytes += frameCopy.byteLength;

      // Batch at least 12 frames (~310ms) with ID3v2 header so Chromium mp3_read_probe always succeeds
      if (this.mp3PendingFrames.length >= 12 || this.mp3PendingBytes >= 4800) {
        this.flushMp3Batch();
      }
    } else if (soundFormat === 10) {
      if (rawAudio.byteLength < 2) return;
      const aacPacketType = rawAudio[0];
      const aacBody = rawAudio.subarray(1);
      if (aacPacketType === 0 && aacBody.byteLength >= 2) {
        this.aacObjectType = (aacBody[0] >>> 3) & 0x1f;
        this.aacSampleRateIdx = ((aacBody[0] & 0x07) << 1) | (aacBody[1] >>> 7);
        this.aacChannelConfig = (aacBody[1] >>> 3) & 0x0f;
        this.codecLabel = 'AAC-LC · Микрофон';
      } else if (aacPacketType === 1 && aacBody.byteLength > 0) {
        this.codecLabel = 'AAC-LC · Микрофон';
        const adtsFrame = this.wrapAdtsFrame(aacBody);
        this.aacPendingFrames.push(adtsFrame);
        if (this.aacPendingFrames.length >= 10) {
          this.flushAacBatch();
        }
      }
    }
  }

  private flushMp3Batch(): void {
    if (this.mp3PendingFrames.length === 0 || !this.audioCtx) return;

    const newFrames = this.mp3PendingFrames;
    const warmupFrames = this.mp3WarmupFrames;
    this.mp3PendingFrames = [];
    this.mp3PendingBytes = 0;

    this.mp3WarmupFrames = newFrames.slice(-3);

    const allFrames = [...warmupFrames, ...newFrames];
    const framesBytes = allFrames.reduce((acc, f) => acc + f.byteLength, 0);

    // Prepend 10-byte empty ID3v2.3 header so FFmpeg mp3_read_probe inside Chrome decodeAudioData
    // immediately recognizes the buffer as valid MP3 stream regardless of frame count
    const id3Header = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const merged = new Uint8Array(new ArrayBuffer(id3Header.byteLength + framesBytes));
    merged.set(id3Header, 0);
    let offset = id3Header.byteLength;
    for (const f of allFrames) {
      merged.set(f, offset);
      offset += f.byteLength;
    }

    const warmupCount = warmupFrames.length;
    const totalCount = allFrames.length;

    this.decodingQueue = this.decodingQueue
      .then(async () => {
        if (this.destroyed || !this.audioCtx || !this.gainNode) return;
        try {
          const decoded = await this.audioCtx.decodeAudioData(merged.buffer);
          if (this.destroyed || !this.audioCtx || !this.gainNode) return;

          const trimRatio = warmupCount / totalCount;
          const trimOffsetSec = decoded.duration * trimRatio;
          const playDurationSec = decoded.duration - trimOffsetSec;
          if (playDurationSec <= 0.005) return;

          const chData = decoded.getChannelData(0);
          const startSample = Math.floor(trimOffsetSec * decoded.sampleRate);
          const subSamples = chData.subarray(startSample);
          let sumSq = 0;
          for (let i = 0; i < subSamples.length; i += 4) {
            sumSq += subSamples[i] * subSamples[i];
          }
          const rms = Math.sqrt(sumSq / Math.max(1, subSamples.length / 4));
          this.lastStreamRms = Math.max(this.lastStreamRms * 0.5, Math.min(1, rms * 4.5));

          this.scheduleFloatBuffer(subSamples, decoded.sampleRate);
        } catch {
          // ignore
        }
      })
      .catch(() => {});
  }

  private wrapAdtsFrame(rawAac: Uint8Array): Uint8Array {
    const frameLength = rawAac.byteLength + 7;
    const adts = new Uint8Array(frameLength);
    const profile = Math.max(0, (this.aacObjectType || 2) - 1);
    const freqIdx = this.aacSampleRateIdx & 0x0f;
    const chanCfg = this.aacChannelConfig & 0x07;

    adts[0] = 0xff;
    adts[1] = 0xf1;
    adts[2] = ((profile & 0x03) << 6) | (freqIdx << 2) | (chanCfg >> 2);
    adts[3] = ((chanCfg & 0x03) << 6) | ((frameLength >> 11) & 0x03);
    adts[4] = (frameLength >> 3) & 0xff;
    adts[5] = ((frameLength & 0x07) << 5) | 0x1f;
    adts[6] = 0xfc;
    adts.set(rawAac, 7);
    return adts;
  }

  private flushAacBatch(): void {
    if (this.aacPendingFrames.length === 0 || !this.audioCtx) return;
    const frames = this.aacPendingFrames;
    this.aacPendingFrames = [];

    const totalBytes = frames.reduce((acc, f) => acc + f.byteLength, 0);
    const merged = new Uint8Array(new ArrayBuffer(totalBytes));
    let offset = 0;
    for (const f of frames) {
      merged.set(f, offset);
      offset += f.byteLength;
    }

    this.decodingQueue = this.decodingQueue
      .then(async () => {
        if (this.destroyed || !this.audioCtx || !this.gainNode) return;
        try {
          const decoded = await this.audioCtx.decodeAudioData(merged.buffer);
          if (this.destroyed || !this.audioCtx || !this.gainNode) return;
          const samples = decoded.getChannelData(0);
          this.scheduleFloatBuffer(samples, decoded.sampleRate);
        } catch {
          // ignore
        }
      })
      .catch(() => {});
  }

  private playG711Samples(bytes: Uint8Array, isAlaw: boolean): void {
    const sampleRate = 8000;
    const floatSamples = new Float32Array(bytes.length);
    let sumSq = 0;
    for (let i = 0; i < bytes.length; i++) {
      const pcm16 = isAlaw ? this.decodeAlaw(bytes[i]) : this.decodeUlaw(bytes[i]);
      const s = pcm16 / 32768.0;
      floatSamples[i] = s;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, bytes.length));
    this.lastStreamRms = Math.max(this.lastStreamRms * 0.5, Math.min(1, rms * 4.5));
    this.scheduleFloatBuffer(floatSamples, sampleRate);
  }

  private playPcmSamples(bytes: Uint8Array, sampleRate: number, is16Bit: boolean): void {
    if (is16Bit) {
      const count = Math.floor(bytes.byteLength / 2);
      if (count === 0) return;
      const floatSamples = new Float32Array(count);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let sumSq = 0;
      for (let i = 0; i < count; i++) {
        const s = view.getInt16(i * 2, true) / 32768.0;
        floatSamples[i] = s;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / count);
      this.lastStreamRms = Math.max(this.lastStreamRms * 0.55, Math.min(1, rms * 4.5));
      this.scheduleFloatBuffer(floatSamples, sampleRate);
    } else {
      const floatSamples = new Float32Array(bytes.byteLength);
      let sumSq = 0;
      for (let i = 0; i < bytes.byteLength; i++) {
        const s = (bytes[i] - 128) / 128.0;
        floatSamples[i] = s;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / Math.max(1, bytes.byteLength));
      this.lastStreamRms = Math.max(this.lastStreamRms * 0.55, Math.min(1, rms * 4.5));
      this.scheduleFloatBuffer(floatSamples, sampleRate);
    }
  }

  private scheduleFloatBuffer(samples: Float32Array, sampleRate: number): void {
    if (this.paused || this.destroyed) return;
    if (!this.audioCtx || !this.gainNode) {
      this.initAudioContext();
    }
    if (!this.audioCtx || !this.gainNode || samples.length === 0) return;

    if (this.audioCtx.state !== 'running') {
      this.audioCtx.resume().catch(() => {});
      // Keep only the latest ~6 chunks (~0.5s) while suspended so it doesn't pile up
      this.suspendedPcmQueue.push({ samples, sampleRate });
      if (this.suspendedPcmQueue.length > 6) {
        this.suspendedPcmQueue.shift();
      }
      return;
    }

    try {
      const audioBuffer = this.audioCtx.createBuffer(1, samples.length, sampleRate);
      audioBuffer.getChannelData(0).set(samples);
      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.gainNode);

      const now = this.audioCtx.currentTime;
      if (this.nextPlayTime < now + 0.015) {
        this.nextPlayTime = now + 0.05;
      } else if (this.nextPlayTime > now + 1.8) {
        // Trim initial GOP burst backlog so audio stays close to real-time live edge
        this.clearActiveSources();
        this.nextPlayTime = now + 0.07;
      }

      this.activeSources.add(source);
      source.onended = () => {
        this.activeSources.delete(source);
      };

      source.start(this.nextPlayTime);
      this.nextPlayTime += audioBuffer.duration;
    } catch {
      // ignore
    }
  }

  private decodeAlaw(aVal: number): number {
    let a = aVal ^ 0x55;
    let t = (a & 0x0f) << 4;
    const seg = (a & 0x70) >> 4;
    switch (seg) {
      case 0:
        t += 8;
        break;
      case 1:
        t += 0x108;
        break;
      default:
        t += 0x108;
        t <<= seg - 1;
        break;
    }
    return (a & 0x80) !== 0 ? t : -t;
  }

  private decodeUlaw(uVal: number): number {
    const u = ~uVal & 0xff;
    let t = ((u & 0x0f) << 3) + 0x84;
    t <<= (u & 0x70) >> 4;
    return (u & 0x80) !== 0 ? 0x84 - t : t - 0x84;
  }

  private startMeterLoop(): void {
    this.meterTimer = window.setInterval(() => {
      if (this.destroyed) return;
      this.emitStatus();
      this.lastStreamRms *= 0.72;
    }, 150);
  }

  private emitStatus(): void {
    if (!this.onStatusChange) return;
    let analyserLevel = 0;
    if (
      this.analyserNode &&
      this.analyserBuffer &&
      !this.muted &&
      this.audioCtx?.state === 'running'
    ) {
      this.analyserNode.getByteTimeDomainData(this.analyserBuffer);
      let sumSq = 0;
      for (let i = 0; i < this.analyserBuffer.length; i++) {
        const norm = (this.analyserBuffer[i] - 128) / 128;
        sumSq += norm * norm;
      }
      const rms = Math.sqrt(sumSq / this.analyserBuffer.length);
      analyserLevel = Math.min(1, rms * 4.5);
    }

    const effectiveLevel = this.muted
      ? 0
      : Math.max(analyserLevel, this.lastStreamRms * Math.min(1.5, this.volume));

    this.onStatusChange({
      hasAudioPackets: this.audioTagsSeen > 0,
      codecLabel: this.codecLabel,
      packetsReceived: this.audioTagsSeen,
      level: Math.min(1, effectiveLevel),
      contextState: (this.audioCtx?.state as any) || 'suspended',
    });
  }

  public destroy(): void {
    this.destroyed = true;
    this.onStatusChange = undefined;
    this.clearActiveSources();
    this.suspendedPcmQueue = [];
    if (this.meterTimer != null) {
      clearInterval(this.meterTimer);
      this.meterTimer = null;
    }
    if (this.demoInterval != null) {
      clearInterval(this.demoInterval);
      this.demoInterval = null;
    }
    if (this.demoNoiseNode) {
      try {
        (this.demoNoiseNode as AudioBufferSourceNode).stop();
        this.demoNoiseNode.disconnect();
      } catch {
        // ignore
      }
      this.demoNoiseNode = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }
}

/**
 * Creates a custom `mpegts.js` loader class that taps incoming HTTP-FLV chunks
 * and feeds them into `FlvAudioEngine` while passing the exact ArrayBuffers to `mpegts.js`.
 */
export function createFlvAudioTapLoader(audioEngine: FlvAudioEngine): any {
  return class FlvAudioTapLoader {
    private _seekHandler: any;
    private _config: any;
    private _needStash: boolean = false;
    private _status: number = 0;
    private _requestAbort: boolean = false;
    private _abortController: AbortController | null = null;
    private _receivedLength: number = 0;

    private _onContentLengthKnown: ((len: number) => void) | null = null;
    private _onURLRedirect: ((url: string) => void) | null = null;
    private _onDataArrival:
      | ((chunk: ArrayBuffer, byteStart: number, receivedLength: number) => void)
      | null = null;
    private _onError: ((type: any, info: any) => void) | null = null;
    private _onComplete: ((from: number, to: number) => void) | null = null;

    static isSupported(): boolean {
      return (
        typeof window !== 'undefined' &&
        typeof window.fetch === 'function' &&
        typeof window.ReadableStream === 'function'
      );
    }

    constructor(seekHandler: any, config: any) {
      this._seekHandler = seekHandler;
      this._config = config;
    }

    destroy(): void {
      this.abort();
      this._onContentLengthKnown = null;
      this._onURLRedirect = null;
      this._onDataArrival = null;
      this._onError = null;
      this._onComplete = null;
    }

    isWorking(): boolean {
      return this._status === 1 || this._status === 2;
    }

    get type(): string {
      return 'flv-audio-tap-loader';
    }

    get status(): number {
      return this._status;
    }

    get needStashBuffer(): boolean {
      return this._needStash;
    }

    get onContentLengthKnown() {
      return this._onContentLengthKnown;
    }
    set onContentLengthKnown(cb) {
      this._onContentLengthKnown = cb;
    }

    get onURLRedirect() {
      return this._onURLRedirect;
    }
    set onURLRedirect(cb) {
      this._onURLRedirect = cb;
    }

    get onDataArrival() {
      return this._onDataArrival;
    }
    set onDataArrival(cb) {
      this._onDataArrival = cb;
    }

    get onError() {
      return this._onError;
    }
    set onError(cb) {
      this._onError = cb;
    }

    get onComplete() {
      return this._onComplete;
    }
    set onComplete(cb) {
      this._onComplete = cb;
    }

    open(dataSource: any, range: { from: number; to: number }): void {
      this._requestAbort = false;
      this._abortController = new AbortController();
      this._status = 1; // kConnecting

      const seekConfig = this._seekHandler.getConfig(dataSource.url, range);

      fetch(seekConfig.url, {
        method: 'GET',
        signal: this._abortController.signal,
      })
        .then((res) => {
          if (this._requestAbort) {
            this._status = 0;
            res.body?.cancel();
            return;
          }
          if (!res.ok || !res.body) {
            this._status = 3;
            this._onError?.('HttpStatusCodeInvalid', {
              code: res.status,
              msg: res.statusText,
            });
            return;
          }
          const reader = res.body.getReader();
          this._pump(reader, range);
        })
        .catch((err) => {
          if (this._abortController?.signal.aborted || this._requestAbort) return;
          this._status = 3;
          this._onError?.('Exception', { code: -1, msg: err?.message || 'Fetch error' });
        });
    }

    private _pump(
      reader: ReadableStreamDefaultReader<Uint8Array>,
      range: { from: number; to: number }
    ): void {
      reader
        .read()
        .then((result) => {
          if (result.done) {
            this._status = 4;
            this._onComplete?.(range.from, range.from + this._receivedLength - 1);
            return;
          }
          if (this._requestAbort || this._abortController?.signal.aborted) {
            this._status = 4;
            reader.cancel().catch(() => {});
            return;
          }

          this._status = 2; // kBuffering
          const value = result.value;
          // Feed raw bytes into our Web Audio API FLV audio extractor
          audioEngine.feedFlvChunk(value);

          // Slice exact ArrayBuffer for mpegts.js video demuxer
          const chunkBuffer = value.buffer.slice(
            value.byteOffset,
            value.byteOffset + value.byteLength
          ) as ArrayBuffer;
          const byteStart = range.from + this._receivedLength;
          this._receivedLength += chunkBuffer.byteLength;

          this._onDataArrival?.(chunkBuffer, byteStart, this._receivedLength);
          this._pump(reader, range);
        })
        .catch((err) => {
          if (this._abortController?.signal.aborted || this._requestAbort) return;
          this._status = 3;
          this._onError?.('EarlyEof', { code: -1, msg: err?.message || 'Stream EOF' });
        });
    }

    abort(): void {
      this._requestAbort = true;
      if (this._abortController) {
        try {
          this._abortController.abort();
        } catch {
          // ignore
        }
      }
      this._status = 0;
    }
  };
}
