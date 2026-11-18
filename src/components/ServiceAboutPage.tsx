import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Clock,
  Copy,
  CreditCard,
  FileText,
  Headphones,
  Mail,
  MapPin,
  MessageCircle,
  Moon,
  Receipt,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { BillingConfig, EgSession } from '../types/eg';
import { apiGetPublicServiceInfo } from '../services/egClient';
import { DomRuLabLogo } from './DomRuBrandLogo';
import { ThemeMode } from '../hooks/useTheme';

interface ServiceAboutPageProps {
  config?: BillingConfig | null;
  session?: EgSession | null;
  standalone?: boolean;
  theme?: ThemeMode;
  onToggleTheme?: () => void;
  onBackToLogin?: () => void;
  onNavigateSettings?: () => void;
  onNavigateAdmin?: () => void;
  canAccessAdmin?: boolean;
  onNotice?: (msg: string) => void;
}

const DEFAULT_PUBLIC_CONFIG: BillingConfig = {
  monthlyPriceRub: 50,
  trialDays: 7,
  selfEmployedName: 'Семёнов Андрей (Самозанятый / НПД)',
  selfEmployedInn: '',
  sbpPhoneOrLink: 'ЮKassa (Карты РФ, СБП, SberPay)',
  paymentMethodLabel: 'ЮKassa (Карты РФ, СБП) · чек «Мой налог»',
  npdTaxRatePct: 4,
  supportEmail: 'support@open-key.ru',
  supportTelegram: '@openkey_support',
  supportPhone: '',
  supportHours: 'Ежедневно, 09:00–21:00 (МСК+4)',
  sellerCity: 'г. Новосибирск',
};

export const ServiceAboutPage: React.FC<ServiceAboutPageProps> = ({
  config: propConfig,
  session,
  standalone = false,
  theme,
  onToggleTheme,
  onBackToLogin,
  onNavigateSettings,
  onNavigateAdmin,
  canAccessAdmin = false,
  onNotice,
}) => {
  const [fetchedConfig, setFetchedConfig] = useState<BillingConfig | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [activeDoc, setActiveDoc] = useState<'offer' | 'privacy' | null>(null);

  useEffect(() => {
    if (propConfig) return;
    let active = true;
    apiGetPublicServiceInfo()
      .then((res) => {
        if (active && res?.config) {
          setFetchedConfig(res.config);
        }
      })
      .catch(() => {
        // Fallback to default structure if network unavailable
      });
    return () => {
      active = false;
    };
  }, [propConfig]);

  const cfg: BillingConfig = {
    ...DEFAULT_PUBLIC_CONFIG,
    ...(fetchedConfig || {}),
    ...(propConfig || {}),
  };

  const requisitesUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/?page=requisites` : '';

  const copyText = (key: string, text: string, noticeLabel: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      onNotice?.(noticeLabel);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2200);
    });
  };

  const telegramUsername = (cfg.supportTelegram || '').replace(/^@/, '').trim();
  const telegramHref = telegramUsername.startsWith('http')
    ? telegramUsername
    : telegramUsername
      ? `https://t.me/${telegramUsername}`
      : '';
  const diagnosticPayload = [
    `Сервис: Open-Key (open-key.ru · Веб / PWA)`,
    `Пользователь: ${session?.subscriber?.name || 'Гость'}`,
    `Телефон: ${session?.phone || 'не указан'}`,
    `Лицевой счёт: ${session?.subscriber?.accountId || session?.userAgent?.account_id || '—'}`,
    `Режим: ${session?.mode === 'demo' ? 'Демо' : session?.mode === 'live' ? 'Рабочий' : 'Публичный просмотр'}`,
    `Платформа: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'web'}`,
  ].join('\n');

  const content = (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-slate-900 dark:text-white font-display">
            О сервисе и реквизиты
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
            Условия обслуживания, тарифы, реквизиты самозанятого и контакты технической поддержки
          </p>
        </div>

        {!standalone && onNavigateSettings && (
          <button
            type="button"
            onClick={onNavigateSettings}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <CreditCard className="w-3.5 h-3.5" />
            <span>Оплата и подписка ({cfg.monthlyPriceRub} ₽/мес)</span>
          </button>
        )}
      </div>

      {/* Primary Grid: Description + Tariff & Refund Terms */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* About Service */}
        <section className="lg:col-span-7 p-5 sm:p-6 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] flex flex-col justify-between gap-5">
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="w-5 h-5 text-[#2563EB] dark:text-[#3B82F6] shrink-0" />
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Программный сервис Open-Key (open-key.ru)
              </h2>
            </div>

            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              Open-Key — это независимый веб-сервис и клиентское приложение для удобного
              управления домофонами, воротами, шлагбаумами и камерами видеонаблюдения с
              поддержкой архива, событий вызовов и персональных гостевых ссылок доступа.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 text-xs">
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200/70 dark:border-white/[0.06] space-y-1">
                <div className="font-semibold text-slate-900 dark:text-white">
                  Что входит в подписку
                </div>
                <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
                  Доступ к веб-кабинету, просмотр живых потоков и DVR-архива со звуком,
                  быстрое открытие замков, личные гостевые ссылки и уведомления.
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200/70 dark:border-white/[0.06] space-y-1">
                <div className="font-semibold text-slate-900 dark:text-white">
                  Предмет оплаты
                </div>
                <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
                  Оплачивается доступ к программному обеспечению Open-Key. Сервис не является
                  оператором связи, не аффилирован с телеком-брендами и не перепродаёт их услуги.
                </p>
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-white/[0.06] flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>Срок подключения: мгновенно после оплаты</span>
            <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200 font-semibold">
              Пробный период: {cfg.trialDays} дн. бесплатно
            </span>
          </div>
        </section>

        {/* Tariff, Payment & Refund Rules (Required for Payment Moderation) */}
        <section className="lg:col-span-5 p-5 sm:p-6 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Тариф, оплата и возврат
              </h2>
              <span className="font-mono tabular-nums text-sm font-bold text-[#2563EB] dark:text-[#3B82F6]">
                {cfg.monthlyPriceRub} ₽ / 30 дн.
              </span>
            </div>

            <ul className="space-y-2.5 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              <li className="flex items-start gap-2">
                <CreditCard className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <span>
                  <strong className="text-slate-900 dark:text-white">Способы оплаты:</strong>{' '}
                  онлайн-оплата через ЮKassa (банковские карты Мир, Visa, Mastercard, СБП и
                  SberPay). Зачисление на баланс и продление подписки происходят мгновенно.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Receipt className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <span>
                  <strong className="text-slate-900 dark:text-white">Фискальные чеки:</strong>{' '}
                  на каждый платёж формируется официальный чек самозанятого (НПД, 422-ФЗ) в
                  приложении ФНС «Мой налог».
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Clock className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <span>
                  <strong className="text-slate-900 dark:text-white">Отмена и возврат:</strong>{' '}
                  автопродление можно отключить в разделе «Настройки» в любой момент. Возврат
                  ошибочного платежа или неиспользованного остатка выполняется в течение 3
                  рабочих дней по обращению в техподдержку.
                </span>
              </li>
            </ul>
          </div>
        </section>
      </div>

      {/* Second Row: Self-Employed Requisites + Technical Support */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* Requisites Card (INN, Name, Status, Public Link for YuKassa) */}
        <section className="lg:col-span-6 p-5 sm:p-6 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-4">
          <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Реквизиты исполнителя
              </h2>
              <p className="text-xs text-slate-400">
                Сведения о плательщике налога на профессиональный доход (НПД)
              </p>
            </div>
            <FileText className="w-4 h-4 text-[#2563EB] dark:text-[#3B82F6] shrink-0" />
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 py-1">
              <span className="text-slate-500 dark:text-slate-400">Исполнитель</span>
              <span className="font-semibold text-slate-900 dark:text-white text-right">
                {cfg.selfEmployedName || 'Самозанятый (НПД)'}
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 py-1 border-t border-slate-100 dark:border-white/[0.05]">
              <span className="text-slate-500 dark:text-slate-400">Налоговый статус</span>
              <span className="font-medium text-slate-800 dark:text-slate-200 text-right">
                Самозанятый (ФЗ № 422-ФЗ от 27.11.2018)
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 py-1.5 border-t border-slate-100 dark:border-white/[0.05]">
              <span className="text-slate-500 dark:text-slate-400">ИНН самозанятого</span>
              {cfg.selfEmployedInn ? (
                <div className="flex items-center gap-2">
                  <span className="font-mono tabular-nums text-sm font-bold text-slate-900 dark:text-white">
                    {cfg.selfEmployedInn}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      copyText('inn', cfg.selfEmployedInn, 'ИНН самозанятого скопирован')
                    }
                    title="Скопировать ИНН"
                    className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.12] text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
                  >
                    {copiedKey === 'inn' ? (
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              ) : (
                <span className="text-amber-600 dark:text-amber-400 font-medium">
                  Не заполнен (укажите в Админ-панели)
                </span>
              )}
            </div>

            {cfg.sellerCity && (
              <div className="flex flex-wrap items-center justify-between gap-2 py-1 border-t border-slate-100 dark:border-white/[0.05]">
                <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5" />
                  <span>Город / регион</span>
                </span>
                <span className="text-slate-800 dark:text-slate-200">{cfg.sellerCity}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 py-1 border-t border-slate-100 dark:border-white/[0.05]">
              <span className="text-slate-500 dark:text-slate-400">Платёжный сервис</span>
              <span className="font-mono tabular-nums text-slate-800 dark:text-slate-200">
                {cfg.paymentMethodLabel || cfg.sbpPhoneOrLink}
              </span>
            </div>
          </div>

          {!cfg.selfEmployedInn && canAccessAdmin && onNavigateAdmin && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-start gap-2 text-amber-800 dark:text-amber-200">
                <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <span>
                  Для модерации ЮKassa обязательно укажите ваш 12-значный ИНН самозанятого.
                </span>
              </div>
              <button
                type="button"
                onClick={onNavigateAdmin}
                className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white font-semibold whitespace-nowrap cursor-pointer"
              >
                Указать ИНН
              </button>
            </div>
          )}

          {/* Direct Public Link for YuKassa Form */}
          {requisitesUrl && (
            <div className="pt-2 border-t border-slate-100 dark:border-white/[0.06] space-y-1.5">
              <div className="text-[11px] font-medium text-slate-400">
                Публичная ссылка на эту страницу (доступна без входа, подходит для ЮKassa):
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 text-[11px] font-mono text-slate-700 dark:text-slate-300 truncate">
                  {requisitesUrl}
                </code>
                <button
                  type="button"
                  onClick={() =>
                    copyText(
                      'url',
                      requisitesUrl,
                      'Ссылка на страницу реквизитов скопирована'
                    )
                  }
                  className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.07] dark:hover:bg-white/[0.12] text-xs font-semibold text-slate-800 dark:text-slate-100 inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
                >
                  {copiedKey === 'url' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                      <span>Скопировано</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Копировать</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Technical Support Card */}
        <section className="lg:col-span-6 p-5 sm:p-6 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] flex flex-col justify-between gap-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-white/[0.06]">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white">
                  Техническая поддержка
                </h2>
                <p className="text-xs text-slate-400">
                  Помощь с доступом, оплатой, чеками НПД и подключением камер
                </p>
              </div>
              <Headphones className="w-4 h-4 text-[#2563EB] dark:text-[#3B82F6] shrink-0" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              {cfg.supportEmail && (
                <a
                  href={`mailto:${cfg.supportEmail}`}
                  className="p-3.5 rounded-xl bg-slate-50 hover:bg-slate-100 dark:bg-[#12161f] dark:hover:bg-white/[0.04] border border-slate-200/70 dark:border-white/[0.06] flex items-start gap-2.5 transition-colors"
                >
                  <Mail className="w-4 h-4 text-[#2563EB] dark:text-[#3B82F6] shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div className="text-[11px] text-slate-400">Электронная почта</div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-white truncate">
                      {cfg.supportEmail}
                    </div>
                  </div>
                </a>
              )}

              {cfg.supportTelegram && (
                <a
                  href={telegramHref || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-3.5 rounded-xl bg-slate-50 hover:bg-slate-100 dark:bg-[#12161f] dark:hover:bg-white/[0.04] border border-slate-200/70 dark:border-white/[0.06] flex items-start gap-2.5 transition-colors"
                >
                  <MessageCircle className="w-4 h-4 text-[#2563EB] dark:text-[#3B82F6] shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div className="text-[11px] text-slate-400">Telegram-поддержка</div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-white truncate">
                      {cfg.supportTelegram}
                    </div>
                  </div>
                </a>
              )}

              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200/70 dark:border-white/[0.06] flex items-start gap-2.5 sm:col-span-2">
                <Clock className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-[11px] text-slate-400">Режим работы</div>
                  <div className="font-medium text-slate-800 dark:text-slate-200">
                    {cfg.supportHours || 'Ежедневно, 09:00–21:00'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-white/[0.06] flex flex-wrap items-center justify-between gap-3">
            <span className="text-[11px] text-slate-400">
              Среднее время ответа: до 2 часов в рабочее время
            </span>
            <button
              type="button"
              onClick={() =>
                copyText(
                  'diag',
                  diagnosticPayload,
                  'Данные аккаунта для обращения скопированы'
                )
              }
              className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.12] text-xs font-semibold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 cursor-pointer"
            >
              {copiedKey === 'diag' ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span>Скопировано</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Данные для обращения</span>
                </>
              )}
            </button>
          </div>
        </section>
      </div>

      {/* Legal Documents (Offer & Privacy Policy) */}
      <section className="p-5 sm:p-6 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Правовая информация и документы
            </h2>
            <p className="text-xs text-slate-400">
              Публичная оферта на предоставление доступа к сервису и политика обработки ПДн
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveDoc((d) => (d === 'offer' ? null : 'offer'))}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors cursor-pointer ${
                activeDoc === 'offer'
                  ? 'bg-[#2563EB] text-white border-[#2563EB]'
                  : 'bg-slate-50 dark:bg-[#12161f] text-slate-700 dark:text-slate-200 border-slate-200 dark:border-white/10 hover:border-slate-300'
              }`}
            >
              Публичная оферта
            </button>
            <button
              type="button"
              onClick={() => setActiveDoc((d) => (d === 'privacy' ? null : 'privacy'))}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors cursor-pointer ${
                activeDoc === 'privacy'
                  ? 'bg-[#2563EB] text-white border-[#2563EB]'
                  : 'bg-slate-50 dark:bg-[#12161f] text-slate-700 dark:text-slate-200 border-slate-200 dark:border-white/10 hover:border-slate-300'
              }`}
            >
              Политика ПДн (152-ФЗ)
            </button>
          </div>
        </div>

        {activeDoc === 'offer' && (
          <div className="p-4 sm:p-5 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200/80 dark:border-white/[0.06] text-xs text-slate-600 dark:text-slate-300 space-y-2.5 leading-relaxed">
            <div className="font-bold text-sm text-slate-900 dark:text-white">
              Публичная оферта на оказание услуг доступа к веб-сервису Open-Key
            </div>
            <p>
              1. <strong>Исполнитель:</strong> физическое лицо, применяющее специальный налоговый
              режим «Налог на профессиональный доход» (Самозанятый, ФЗ № 422-ФЗ) —{' '}
              <strong>{cfg.selfEmployedName}</strong>
              {cfg.selfEmployedInn ? `, ИНН ${cfg.selfEmployedInn}` : ''}.
            </p>
            <p>
              2. <strong>Предмет договора:</strong> Исполнитель предоставляет Пользователю
              неисключительный доступ к программному веб-сервису Open-Key (open-key.ru) для
              дистанционного управления совместимыми домофонами, замками и видеоархивом сроком
              на 30 календарных дней с момента активации подписки.
            </p>
            <p>
              3. <strong>Стоимость и расчёты:</strong> стоимость подписки составляет{' '}
              {cfg.monthlyPriceRub} ₽ за 30 дней. При первом подключении предоставляется
              ознакомительный период {cfg.trialDays} дней. Оплата осуществляется онлайн через
              сервис ЮKassa (банковская карта / СБП) с автоматическим формированием электронного
              чека НПД в системе «Мой налог».
            </p>
            <p>
              4. <strong>Отказ от услуги и возврат:</strong> Пользователь вправе отказаться от
              автопродления в любой момент в настройках. При технических сбоях по вине
              сервиса либо ошибочной оплате возврат денежных средств осуществляется по
              обращению на {cfg.supportEmail || cfg.supportTelegram} в течение 3 рабочих дней.
            </p>
          </div>
        )}

        {activeDoc === 'privacy' && (
          <div className="p-4 sm:p-5 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200/80 dark:border-white/[0.06] text-xs text-slate-600 dark:text-slate-300 space-y-2.5 leading-relaxed">
            <div className="font-bold text-sm text-slate-900 dark:text-white">
              Политика обработки персональных данных (152-ФЗ)
            </div>
            <p>
              1. Оператор обработки персональных данных — {cfg.selfEmployedName}
              {cfg.selfEmployedInn ? ` (ИНН ${cfg.selfEmployedInn})` : ''}.
            </p>
            <p>
              2. Обрабатываются исключительно данные, необходимые для авторизации в аккаунте,
              учёта подписки и формирования фискальных чеков: номер телефона, имя профиля,
              идентификатор лицевого счёта и история платежей в сервисе.
            </p>
            <p>
              3. Пароли и реквизиты банковских карт не хранятся на сервере сервиса; проведение
              платежей обеспечивается защищёнными платёжными провайдерами по стандарту PCI DSS.
            </p>
            <p>
              4. По вопросам удаления учётных данных или отзыва согласия на обработку можно
              обратиться по адресу {cfg.supportEmail || cfg.supportTelegram}.
            </p>
          </div>
        )}
      </section>
    </div>
  );

  if (!standalone) {
    return content;
  }

  return (
    <div className="min-h-screen bg-[#f4f6f9] dark:bg-[#12161f] text-slate-900 dark:text-slate-100 flex flex-col transition-colors duration-200">
      <header className="w-full border-b border-slate-200/80 dark:border-white/[0.06] bg-white/90 dark:bg-[#0f131a]/90 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 h-16 flex items-center justify-between gap-4">
          <DomRuLabLogo size="md" />
          <div className="flex items-center gap-2.5">
            {onToggleTheme && (
              <button
                type="button"
                onClick={onToggleTheme}
                aria-label="Сменить тему"
                className="p-2 rounded-xl bg-slate-100 dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/10 text-slate-600 dark:text-slate-300 cursor-pointer"
              >
                {theme === 'dark' ? (
                  <Sun className="w-4 h-4 text-amber-400" />
                ) : (
                  <Moon className="w-4 h-4" />
                )}
              </button>
            )}
            {onBackToLogin && (
              <button
                type="button"
                onClick={onBackToLogin}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>К входу в кабинет</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-5 sm:px-8 py-6 sm:py-8">
        {content}
      </main>

      <footer className="w-full border-t border-slate-200/80 dark:border-white/[0.06] bg-white/60 dark:bg-[#0f131a]/60">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>
            © Open-Key (open-key.ru) · {cfg.selfEmployedName}
            {cfg.selfEmployedInn ? ` · ИНН ${cfg.selfEmployedInn}` : ''}
          </span>
          <span>
            {cfg.supportEmail || cfg.supportTelegram}
          </span>
        </div>
      </footer>
    </div>
  );
};
