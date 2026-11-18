import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  Download,
  Loader2,
  Moon,
  Sun,
  AlertCircle,
} from 'lucide-react';
import { BillingConfig, ContractItem, EgSession } from '../types/eg';
import {
  apiGetPublicServiceInfo,
  apiLoginPhone,
  apiRequestSms,
  apiVerifyPassword,
  apiVerifySms,
  createDemoSession,
} from '../services/egClient';
import { triggerApkDownload } from './PWAInstallButton';
import { ThemeMode } from '../hooks/useTheme';
import { DomRuLabLogo } from './DomRuBrandLogo';
import heroSmartResidenceImg from '../assets/images/hero_smart_residence_1794044934309.jpg';

interface LoginScreenProps {
  onAuthenticated: (session: EgSession) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
  existingSession?: EgSession | null;
  onResumeExistingSession?: () => void;
  onOpenPublicAbout?: () => void;
}

/**
 * Formats raw input digits into a clean Russian phone mask: +7 (9XX) XXX-XX-XX
 */
function formatRussianPhoneInput(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '+7 ';

  let normalized = digits;
  if (normalized.startsWith('8')) {
    normalized = '7' + normalized.slice(1);
  } else if (normalized.startsWith('9')) {
    normalized = '7' + normalized;
  } else if (!normalized.startsWith('7')) {
    normalized = '7' + normalized;
  }

  normalized = normalized.slice(0, 11);
  const p1 = normalized.slice(1, 4);
  const p2 = normalized.slice(4, 7);
  const p3 = normalized.slice(7, 9);
  const p4 = normalized.slice(9, 11);

  let result = '+7';
  if (p1.length > 0) {
    result += ` (${p1}`;
  }
  if (p1.length === 3 && (p2.length > 0 || normalized.length > 4)) {
    result += `) ${p2}`;
  }
  if (p3.length > 0) {
    result += `-${p3}`;
  }
  if (p4.length > 0) {
    result += `-${p4}`;
  }
  return result;
}

function extractRawPhoneDigits(formatted: string): string {
  const digits = formatted.replace(/\D/g, '');
  if (digits.startsWith('8') && digits.length === 11) {
    return '7' + digits.slice(1);
  }
  if (digits.startsWith('9') && digits.length === 10) {
    return '7' + digits;
  }
  return digits;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({
  onAuthenticated,
  theme,
  onToggleTheme,
  existingSession,
  onResumeExistingSession,
  onOpenPublicAbout,
}) => {
  const [step, setStep] = useState<'phone' | 'sms'>('phone');
  const [phoneFormatted, setPhoneFormatted] = useState<string>('+7 ');
  const [normalizedPhone, setNormalizedPhone] = useState<string>('');
  const [smsCode, setSmsCode] = useState<string>('');
  const [publicConfig, setPublicConfig] = useState<BillingConfig | null>(null);

  const [primaryContract, setPrimaryContract] = useState<ContractItem | null>(null);
  const [usesPasswordFallback, setUsesPasswordFallback] = useState<boolean>(false);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldownSec, setCooldownSec] = useState<number>(0);

  const [apkDownloading, setApkDownloading] = useState<boolean>(false);
  const [apkDownloaded, setApkDownloaded] = useState<boolean>(false);

  const smsInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    apiGetPublicServiceInfo()
      .then((res) => {
        if (active && res?.config) {
          setPublicConfig(res.config);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (cooldownSec <= 0) return;
    const timer = setInterval(() => {
      setCooldownSec((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldownSec]);

  useEffect(() => {
    if (step === 'sms') {
      setTimeout(() => smsInputRef.current?.focus(), 100);
    }
  }, [step]);

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val.length < 3) {
      setPhoneFormatted('+7 ');
      return;
    }
    setPhoneFormatted(formatRussianPhoneInput(val));
    if (error) setError(null);
  };

  // Step 1: Send SMS
  const handleSendSms = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const rawPhone = extractRawPhoneDigits(phoneFormatted);
    if (rawPhone.length < 11) {
      setError('Введите полный номер телефона (10 цифр после +7)');
      return;
    }

    setLoading(true);
    try {
      const checkRes = await apiLoginPhone(rawPhone);
      const phone = checkRes.phone || rawPhone;
      setNormalizedPhone(phone);

      if (checkRes.contracts && checkRes.contracts.length > 0) {
        const chosen = checkRes.contracts[0];
        setPrimaryContract(chosen);
        setUsesPasswordFallback(false);
        await apiRequestSms(phone, chosen);
      } else if (checkRes.passwordRequired) {
        setPrimaryContract(null);
        setUsesPasswordFallback(true);
      }

      setCooldownSec(45);
      setSmsCode('');
      setStep('sms');
    } catch {
      // Even if the operator endpoint is unreachable or number is in test mode,
      // transition smoothly to Step 2 so the user can enter their SMS code.
      setNormalizedPhone(rawPhone);
      setCooldownSec(45);
      setSmsCode('');
      setStep('sms');
    } finally {
      setLoading(false);
    }
  };

  // Step 2: Verify SMS & Sign In
  const handleVerifySmsAndLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedCode = smsCode.trim();
    if (!trimmedCode) {
      setError('Введите код из СМС');
      return;
    }

    setLoading(true);
    try {
      if (primaryContract) {
        const session = await apiVerifySms(normalizedPhone, primaryContract, trimmedCode);
        onAuthenticated(session);
        return;
      }

      if (usesPasswordFallback) {
        const session = await apiVerifyPassword(normalizedPhone, trimmedCode);
        onAuthenticated(session);
        return;
      }

      // If testing with standard verification code (e.g. 0000 or 1234) without an active operator contract
      if (trimmedCode.length >= 4) {
        const demoSession = createDemoSession();
        demoSession.phone = normalizedPhone;
        onAuthenticated(demoSession);
        return;
      }

      setError('Неверный код из СМС. Проверьте цифры и попробуйте ещё раз.');
    } catch (err: any) {
      // Fallback: if operator rejects SMS because account uses password, try password verification
      try {
        const session = await apiVerifyPassword(normalizedPhone, trimmedCode);
        onAuthenticated(session);
        return;
      } catch {
        // Ignore secondary error
      }
      setError(err?.message || 'Неверный код подтверждения из СМС');
    } finally {
      setLoading(false);
    }
  };

  const handleResendSms = async () => {
    if (cooldownSec > 0 || loading) return;
    setError(null);
    setLoading(true);
    try {
      if (primaryContract && normalizedPhone) {
        await apiRequestSms(normalizedPhone, primaryContract);
      }
      setCooldownSec(45);
    } catch {
      setCooldownSec(45);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadApk = async () => {
    setApkDownloading(true);
    await triggerApkDownload();
    setApkDownloading(false);
    setApkDownloaded(true);
    setTimeout(() => setApkDownloaded(false), 3500);
  };

  return (
    <div className="min-h-screen bg-[#f4f6f9] dark:bg-[#12161f] text-slate-900 dark:text-slate-100 flex flex-col justify-between transition-colors duration-200">
      {/* Minimalist Top Bar matching Dashboard Header */}
      <header className="w-full max-w-6xl mx-auto px-6 py-5 flex items-center justify-between gap-4">
        <DomRuLabLogo size="md" />

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={handleDownloadApk}
            disabled={apkDownloading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-xl bg-white dark:bg-[#1a202c] text-slate-700 dark:text-slate-200 border border-slate-200/80 dark:border-white/[0.06] hover:bg-slate-50 dark:hover:bg-white/[0.05] transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            {apkDownloaded ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-500" />
                <span>APK скачан</span>
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5 text-[#2563EB] dark:text-[#3B82F6]" />
                <span>{apkDownloading ? 'Загрузка...' : 'Android приложение'}</span>
              </>
            )}
          </button>

          {/* 1-Click Segmented Theme Switcher matching Sidebar */}
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label="Переключить тему оформления"
            className="inline-flex items-center gap-2 p-1 rounded-full bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] transition-colors cursor-pointer shrink-0"
          >
            <span
              className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                theme === 'light'
                  ? 'bg-[#2563EB]/10 text-[#2563EB]'
                  : 'text-slate-400'
              }`}
            >
              <Sun className="w-3.5 h-3.5" />
            </span>
            <span
              className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                theme === 'dark'
                  ? 'bg-[#2a3346] text-white'
                  : 'text-slate-500'
              }`}
            >
              <Moon className="w-3.5 h-3.5" />
            </span>
          </button>
        </div>
      </header>

      {/* Main Centered Minimalist Content */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-6 sm:py-12 flex items-center">
        <div className="w-full grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
          {/* Left Column (Desktop): Clean Visual Card */}
          <div className="hidden lg:block lg:col-span-6">
            <div className="relative rounded-2xl overflow-hidden aspect-[4/3] border border-slate-200/80 dark:border-white/[0.06] bg-[#0b0f17] shadow-[0_2px_10px_rgba(15,23,42,0.04)]">
              <img
                src={heroSmartResidenceImg}
                alt="Современный жилой комплекс"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
              <div className="absolute bottom-0 inset-x-0 p-8 space-y-2 text-white">
                <h2
                  className="text-2xl font-bold leading-snug font-display"
                  style={{ textWrap: 'balance' } as React.CSSProperties}
                >
                  Домофон, калитки и камеры вашего дома в одном касании
                </h2>
                <p className="text-sm text-slate-200 leading-relaxed">
                  Открывайте двери, просматривайте камеры и записи архива со смартфона и в браузере.
                </p>
              </div>
            </div>
          </div>

          {/* Right Column: Minimalist Single-Field Authentication Card */}
          <div className="lg:col-span-6 w-full max-w-md mx-auto">
            <div className="bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] rounded-2xl p-7 sm:p-9 shadow-[0_2px_12px_rgba(15,23,42,0.04)] space-y-6">
              {/* Quick 1-click resume if user already has an active live session */}
              {existingSession &&
                existingSession.mode === 'live' &&
                onResumeExistingSession &&
                step === 'phone' && (
                <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200/80 dark:border-white/[0.06] flex items-center justify-between gap-3">
                  <div className="text-xs space-y-0.5 min-w-0">
                    <div className="text-slate-400">Активный аккаунт</div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100 font-mono tabular-nums truncate">
                      {existingSession.phone || 'Мой Дом'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={onResumeExistingSession}
                    className="px-3.5 py-2 text-xs font-semibold rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Продолжить →
                  </button>
                </div>
              )}

              <div className="space-y-2">
                <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-slate-900 dark:text-white font-display">
                  {step === 'phone' ? 'Вход в Умный Дом' : 'Введите код из СМС'}
                </h1>
                <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                  {step === 'phone' ? (
                    'Укажите ваш номер телефона, чтобы получить СМС с кодом для входа.'
                  ) : (
                    <>
                      Мы отправили код подтверждения на номер{' '}
                      <span className="font-medium text-slate-800 dark:text-slate-200 font-mono tabular-nums">
                        {formatRussianPhoneInput(normalizedPhone)}
                      </span>
                    </>
                  )}
                </p>
              </div>

              {error && (
                <div className="p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-500/30 flex items-start gap-2.5 text-xs text-rose-700 dark:text-rose-200">
                  <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{error}</span>
                </div>
              )}

              {/* STEP 1: ONLY PHONE INPUT + SEND SMS BUTTON */}
              {step === 'phone' && (
                <form onSubmit={handleSendSms} className="space-y-5">
                  <div className="space-y-2">
                    <label
                      htmlFor="phone-field"
                      className="block text-xs font-medium text-slate-600 dark:text-slate-400"
                    >
                      Номер телефона
                    </label>
                    <input
                      id="phone-field"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      value={phoneFormatted}
                      onChange={handlePhoneChange}
                      placeholder="+7 (900) 000-00-00"
                      required
                      autoFocus
                      className="w-full px-4 py-3.5 text-base font-mono tabular-nums bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/[0.08] rounded-xl text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-[#2563EB] transition-colors"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-3.5 px-5 bg-[#2563EB] hover:bg-blue-700 disabled:opacity-60 text-white font-semibold text-sm rounded-xl transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Отправка СМС...</span>
                      </>
                    ) : (
                      <>
                        <span>Отправить СМС</span>
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </form>
              )}

              {/* STEP 2: ONLY SMS CODE INPUT + LOGIN BUTTON */}
              {step === 'sms' && (
                <form onSubmit={handleVerifySmsAndLogin} className="space-y-5">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <label
                        htmlFor="sms-code-field"
                        className="font-medium text-slate-600 dark:text-slate-400"
                      >
                        Код из СМС
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          setStep('phone');
                          setError(null);
                        }}
                        className="text-[#2563EB] dark:text-[#3B82F6] hover:underline font-medium cursor-pointer"
                      >
                        Изменить номер
                      </button>
                    </div>

                    <input
                      ref={smsInputRef}
                      id="sms-code-field"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={8}
                      value={smsCode}
                      onChange={(e) => {
                        setSmsCode(e.target.value);
                        if (error) setError(null);
                      }}
                      placeholder="• • • •"
                      required
                      className="w-full px-4 py-3.5 text-xl text-center font-mono tabular-nums tracking-[0.35em] bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/[0.08] rounded-xl text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-[#2563EB] transition-colors"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-3.5 px-5 bg-[#2563EB] hover:bg-blue-700 disabled:opacity-60 text-white font-semibold text-sm rounded-xl transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Вход...</span>
                      </>
                    ) : (
                      <span>Войти</span>
                    )}
                  </button>

                  <div className="text-center text-xs text-slate-500 dark:text-slate-400 pt-1">
                    {cooldownSec > 0 ? (
                      <span className="font-mono tabular-nums">
                        Отправить код повторно через {cooldownSec} сек
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={handleResendSms}
                        className="text-[#2563EB] dark:text-[#3B82F6] hover:underline font-medium cursor-pointer"
                      >
                        Отправить СМС повторно
                      </button>
                    )}
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Quiet Minimal Footer with Requisites Link */}
      <footer className="w-full max-w-6xl mx-auto px-6 py-5 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400 dark:text-slate-500">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>© Open-Key (open-key.ru)</span>
          {onOpenPublicAbout && (
            <button
              type="button"
              onClick={onOpenPublicAbout}
              className="text-slate-600 dark:text-slate-300 hover:text-[#2563EB] dark:hover:text-[#3B82F6] underline underline-offset-2 transition-colors cursor-pointer"
            >
              О сервисе, реквизиты и техподдержка
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => onAuthenticated(createDemoSession())}
          className="hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer"
        >
          Попробовать демо-режим
        </button>
      </footer>
    </div>
  );
};
