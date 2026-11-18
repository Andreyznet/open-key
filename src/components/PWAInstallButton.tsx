import React, { useState } from 'react';
import { Download, Smartphone, ShieldCheck, X, Check, FileCode, ExternalLink } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export async function triggerApkDownload() {
  try {
    const res = await fetch('/api/eg/android/download-apk');
    if (!res.ok) {
      throw new Error('Ошибка скачивания APK');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'DomRuLab-PocoX6Pro-v3.0.0.apk';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    // Fallback direct link
    const a = document.createElement('a');
    a.href = '/domru-lab-poco-x6-pro.apk';
    a.download = 'DomRuLab-PocoX6Pro-v3.0.0.apk';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

export async function triggerAndroidSourceDownload() {
  try {
    const res = await fetch('/api/eg/android/download-source');
    if (!res.ok) throw new Error('Failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'DomRuLab-PocoX6Pro-Android-Source.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    const a = document.createElement('a');
    a.href = '/domru-lab-android-source.zip';
    a.download = 'DomRuLab-PocoX6Pro-Android-Source.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, isNativeApk, install } = usePWAInstall();
  const [showModal, setShowModal] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  if (isNativeApk) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-lg bg-emerald-950/60 text-emerald-300 border border-emerald-500/30">
        <Smartphone className="w-3.5 h-3.5 text-emerald-400" />
        <span>Poco X6 Pro APK</span>
      </span>
    );
  }

  const handleDownloadApk = async () => {
    setDownloading(true);
    await triggerApkDownload();
    setDownloading(false);
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 3500);
  };

  return (
    <>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition-colors cursor-pointer whitespace-nowrap shrink-0 shadow-sm"
          title="Скачать автономный Android APK v3.0.0 для Xiaomi Poco X6 Pro"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Скачать APK v3.0</span>
        </button>

        {!isInstalled && isInstallable && (
          <button
            type="button"
            onClick={install}
            className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-300 border border-sky-500/30 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>Установить PWA</span>
          </button>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-5 text-slate-100">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-100 font-display">
                    Автономное Android-приложение DomRu Key v3.0
                  </h3>
                  <p className="text-xs text-slate-400">
                    Пакет <span className="font-mono text-slate-300">ru.domrulab.pocox6pro</span> · v3.0.0-PocoX6Pro · Коммерческая сборка
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Архитектура приложения:</span>
                <span className="font-semibold text-emerald-400">100% Нативное (без WebView и внешнего сайта)</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Первый запуск:</span>
                <span className="font-mono text-slate-200">Приветственная витрина (3 слайда) + Авторизация</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Подпись APK:</span>
                <span className="font-mono text-emerald-400 flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  APK Signature Scheme v2 + v3 (RSA-2048)
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Модули внутри APK:</span>
                <span className="text-sky-300">Приветствие + 5 вкладок + Перемотка/Скорость/MP4 + CV</span>
              </div>
            </div>

            <div className="space-y-2 text-xs text-slate-300 bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5">
              <div className="font-semibold text-slate-200">
                Что включено в коммерческую сборку APK v3.0.0:
              </div>
              <ol className="list-decimal list-inside space-y-1 text-slate-400">
                <li><strong>Приветственный экран и Авторизация</strong> — интерактивная витрина возможностей при первом открытии, вход по номеру и паролю, выбор договора для СМС или вход по токену.</li>
                <li><strong>Двери и Калитки</strong> — синхронизация всех подъездов, калиток и шлагбаумов вашего договора + баланс.</li>
                <li><strong>Камеры и Видеоархив</strong> — перемотка архива ползунком и шагами, выбор скорости (<span className="font-mono">0.5x–2x</span>) и скачивание MP4 в папку <span className="font-mono">Downloads</span>.</li>
                <li><strong>Авто-Калитка (CV)</strong> — селфи-регистрация с телефона + детекция лица на кадре домофона, <span className="font-mono">AndroidKeyStore AES-256-GCM</span>.</li>
              </ol>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <button
                type="button"
                onClick={handleDownloadApk}
                disabled={downloading}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition-colors cursor-pointer"
              >
                {downloaded ? (
                  <>
                    <Check className="w-4 h-4" />
                    <span>APK v3.0 скачан!</span>
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    <span>Скачать DomRuLab-PocoX6Pro-v3.0.0.apk</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={triggerAndroidSourceDownload}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs font-medium rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors cursor-pointer"
                title="Скачать исходный код Android-проекта (Java + AndroidManifest + скрипт сборки)"
              >
                <FileCode className="w-4 h-4 text-sky-400" />
                <span>Исходники (.zip)</span>
              </button>
            </div>

            {!isInstalled && (isInstallable || isIOS) && (
              <div className="pt-2 border-t border-slate-800 flex items-center justify-between gap-3">
                <span className="text-[11px] text-slate-400">
                  Также можно установить как автономное PWA-приложение прямо из браузера:
                </span>
                {isInstallable ? (
                  <button
                    type="button"
                    onClick={install}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/30 cursor-pointer shrink-0"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Установить PWA</span>
                  </button>
                ) : (
                  <span className="text-[11px] text-sky-400 shrink-0">
                    Поделиться → На экран «Домой»
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
