package ru.domrulab.pocox6pro;

import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;

/**
 * Аппаратный синтезатор звука домофона (зуммер открытия двери и щелчок электромагнитного реле)
 * через нативный Android AudioTrack. Работает полностью автономно без внешних аудиофайлов.
 */
public class SoundGenerator {

    public static void playDoorUnlockSound() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    int sampleRate = 22050;
                    double durationSec = 0.75;
                    int numSamples = (int) (sampleRate * durationSec);
                    short[] pcm = new short[numSamples];

                    for (int i = 0; i < numSamples; i++) {
                        double t = (double) i / sampleRate;
                        double sample = 0.0;
                        // Щелчок реле в начале (0..0.04с)
                        if (t < 0.04) {
                            sample = Math.sin(2.0 * Math.PI * 180.0 * t) * Math.exp(-t * 60.0) * 0.8;
                        }
                        // Двухтональный сигнал открытия домофона (950 Гц -> 1420 Гц)
                        else if (t >= 0.05 && t < 0.35) {
                            sample = Math.sin(2.0 * Math.PI * 950.0 * t) * 0.45
                                   + Math.sin(2.0 * Math.PI * 1900.0 * t) * 0.15;
                        } else if (t >= 0.37 && t < 0.72) {
                            sample = Math.sin(2.0 * Math.PI * 1420.0 * t) * 0.50
                                   + Math.sin(2.0 * Math.PI * 2840.0 * t) * 0.15;
                        }
                        pcm[i] = (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, sample * 32000));
                    }

                    AudioTrack track = new AudioTrack(
                        AudioManager.STREAM_MUSIC,
                        sampleRate,
                        AudioFormat.CHANNEL_OUT_MONO,
                        AudioFormat.ENCODING_PCM_16BIT,
                        pcm.length * 2,
                        AudioTrack.MODE_STATIC
                    );
                    track.write(pcm, 0, pcm.length);
                    track.play();
                    Thread.sleep(850);
                    track.release();
                } catch (Throwable ignored) {}
            }
        }).start();
    }
}
