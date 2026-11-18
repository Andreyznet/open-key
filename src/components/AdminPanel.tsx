import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  CalendarPlus,
  Check,
  CheckCircle2,
  Clock,
  FileCheck2,
  Lock,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Unlock,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import {
  AdminOverviewPayload,
  BillingSubscriptionStatus,
  BillingUserRecord,
  EgSession,
} from '../types/eg';
import {
  apiAdminAdjustBalance,
  apiAdminCreateUser,
  apiAdminIssueNpdReceipt,
  apiAdminProcessTransaction,
  apiAdminUnlock,
  apiAdminUpdateConfig,
  apiAdminUpdateUserSubscription,
  apiGetAdminOverview,
} from '../services/egClient';

interface AdminPanelProps {
  session: EgSession;
  onNotice: (msg: string) => void;
  onBillingUpdated: () => void;
}

type AdminSubTab = 'users' | 'transactions' | 'config';

const ADMIN_PIN_STORAGE_KEY = 'domru_lab_admin_pin_v1';

function formatShortDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderStatusLabel(user: BillingUserRecord): {
  label: string;
  sub: string;
  colorClass: string;
  icon: React.ReactNode;
} {
  if (user.status === 'blocked') {
    return {
      label: 'Заблокирован',
      sub: 'Доступ ограничен',
      colorClass: 'text-rose-500',
      icon: <Ban className="w-3.5 h-3.5 shrink-0" />,
    };
  }
  if (user.status === 'active') {
    return {
      label: 'Активна',
      sub: `до ${formatShortDate(user.paidUntil)}`,
      colorClass: 'text-emerald-600 dark:text-emerald-400',
      icon: <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />,
    };
  }
  if (user.status === 'trial') {
    return {
      label: 'Пробный период',
      sub: `до ${formatShortDate(user.trialEndsAt)}`,
      colorClass: 'text-amber-600 dark:text-amber-400',
      icon: <Clock className="w-3.5 h-3.5 shrink-0" />,
    };
  }
  return {
    label: 'Истекла',
    sub: user.paidUntil ? `была до ${formatShortDate(user.paidUntil)}` : 'Требует оплаты',
    colorClass: 'text-rose-500',
    icon: <Clock className="w-3.5 h-3.5 shrink-0" />,
  };
}

export const AdminPanel: React.FC<AdminPanelProps> = ({
  session,
  onNotice,
  onBillingUpdated,
}) => {
  const [adminPin, setAdminPin] = useState<string>(() => {
    try {
      return sessionStorage.getItem(ADMIN_PIN_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [pinRequired, setPinRequired] = useState<boolean>(false);
  const [pinInput, setPinInput] = useState<string>('');
  const [pinError, setPinError] = useState<string | null>(null);

  const [overview, setOverview] = useState<AdminOverviewPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<AdminSubTab>('users');

  // Users search & filter
  const [userSearch, setUserSearch] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | BillingSubscriptionStatus>('all');

  // Inline balance adjustment editor
  const [adjustUserId, setAdjustUserId] = useState<string | null>(null);
  const [adjustAmount, setAdjustAmount] = useState<string>('50');
  const [adjustDesc, setAdjustDesc] = useState<string>('Пополнение баланса ЮKassa');
  const [adjustChannel, setAdjustChannel] = useState<'sbp' | 'yookassa_npd' | 'manual'>('yookassa_npd');
  const [adjustReceiptNum, setAdjustReceiptNum] = useState<string>('');

  // Create user inline form
  const [showAddUser, setShowAddUser] = useState<boolean>(false);
  const [newName, setNewName] = useState<string>('');
  const [newPhone, setNewPhone] = useState<string>('');
  const [newAccountId, setNewAccountId] = useState<string>('');
  const [newAddress, setNewAddress] = useState<string>('');
  const [newBalance, setNewBalance] = useState<string>('0');
  const [newStatus, setNewStatus] = useState<BillingSubscriptionStatus>('trial');

  // Receipt number input map
  const [receiptInputs, setReceiptInputs] = useState<Record<string, string>>({});

  // Config editor state
  const [cfgPrice, setCfgPrice] = useState<string>('50');
  const [cfgTrialDays, setCfgTrialDays] = useState<string>('7');
  const [cfgName, setCfgName] = useState<string>('');
  const [cfgInn, setCfgInn] = useState<string>('');
  const [cfgSbp, setCfgSbp] = useState<string>('');
  const [cfgTaxRate, setCfgTaxRate] = useState<number>(4);
  const [cfgSupportEmail, setCfgSupportEmail] = useState<string>('');
  const [cfgSupportTelegram, setCfgSupportTelegram] = useState<string>('');
  const [cfgSupportHours, setCfgSupportHours] = useState<string>('');
  const [cfgSellerCity, setCfgSellerCity] = useState<string>('');
  const [cfgNewPin, setCfgNewPin] = useState<string>('');

  const loadOverview = useCallback(
    async (pinOverride?: string) => {
      setLoading(true);
      try {
        const activePin = pinOverride !== undefined ? pinOverride : adminPin;
        const data = await apiGetAdminOverview(session, activePin);
        setOverview(data);
        setPinRequired(false);
        setPinError(null);
        setCfgPrice(String(data.config.monthlyPriceRub));
        setCfgTrialDays(String(data.config.trialDays));
        setCfgName(data.config.selfEmployedName);
        setCfgInn(data.config.selfEmployedInn || '');
        setCfgSbp(data.config.sbpPhoneOrLink);
        setCfgTaxRate(data.config.npdTaxRatePct);
        setCfgSupportEmail(data.config.supportEmail || '');
        setCfgSupportTelegram(data.config.supportTelegram || '');
        setCfgSupportHours(data.config.supportHours || '');
        setCfgSellerCity(data.config.sellerCity || '');
      } catch (err: any) {
        const msg = String(err?.message || '');
        if (msg.toLowerCase().includes('pin')) {
          setPinRequired(true);
        } else {
          onNotice(msg || 'Ошибка загрузки админ-панели');
        }
      } finally {
        setLoading(false);
      }
    },
    [session, adminPin, onNotice]
  );

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  const handleUnlockPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError(null);
    try {
      await apiAdminUnlock(session, pinInput);
      try {
        sessionStorage.setItem(ADMIN_PIN_STORAGE_KEY, pinInput);
      } catch {
        // ignore
      }
      setAdminPin(pinInput);
      await loadOverview(pinInput);
    } catch (err: any) {
      setPinError(err?.message || 'Неверный PIN-код');
    }
  };

  const applyOverviewUpdate = (next: AdminOverviewPayload) => {
    setOverview(next);
    onBillingUpdated();
  };

  const handleAdjustBalance = async (userId: string) => {
    const val = Number(adjustAmount.replace(',', '.'));
    if (!Number.isFinite(val) || val === 0) {
      onNotice('Укажите корректную сумму (например, 50 или -50)');
      return;
    }
    setBusyId(userId);
    try {
      const next = await apiAdminAdjustBalance(
        session,
        userId,
        {
          deltaRub: val,
          description: adjustDesc.trim() || undefined,
          paymentChannel: adjustChannel,
          npdReceiptNumber: adjustReceiptNum.trim() || undefined,
          markAsTopup: val > 0,
        },
        adminPin
      );
      applyOverviewUpdate(next);
      setAdjustUserId(null);
      setAdjustReceiptNum('');
      onNotice(val > 0 ? `Баланс пополнен на ${val} ₽` : `Списано ${Math.abs(val)} ₽`);
    } catch (err: any) {
      onNotice(err?.message || 'Ошибка изменения баланса');
    } finally {
      setBusyId(null);
    }
  };

  const handleQuickSubAction = async (
    userId: string,
    payload: { status?: BillingSubscriptionStatus; addDays?: number; role?: 'admin' | 'user' },
    successMsg: string
  ) => {
    setBusyId(userId);
    try {
      const next = await apiAdminUpdateUserSubscription(session, userId, payload, adminPin);
      applyOverviewUpdate(next);
      onNotice(successMsg);
    } catch (err: any) {
      onNotice(err?.message || 'Ошибка обновления пользователя');
    } finally {
      setBusyId(null);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyId('create_user');
    try {
      const next = await apiAdminCreateUser(
        session,
        {
          name: newName,
          phone: newPhone,
          accountId: newAccountId,
          address: newAddress,
          balanceRub: Number(newBalance) || 0,
          status: newStatus,
        },
        adminPin
      );
      applyOverviewUpdate(next);
      setShowAddUser(false);
      setNewName('');
      setNewPhone('');
      setNewAccountId('');
      setNewAddress('');
      setNewBalance('0');
      onNotice('Пользователь добавлен');
    } catch (err: any) {
      onNotice(err?.message || 'Ошибка добавления пользователя');
    } finally {
      setBusyId(null);
    }
  };

  const handleProcessTx = async (txId: string, action: 'approve' | 'reject') => {
    setBusyId(txId);
    try {
      const next = await apiAdminProcessTransaction(
        session,
        txId,
        action,
        receiptInputs[txId] || undefined,
        adminPin
      );
      applyOverviewUpdate(next);
      onNotice(action === 'approve' ? 'Платёж подтверждён и зачислен на баланс' : 'Заявка отклонена');
    } catch (err: any) {
      onNotice(err?.message || 'Ошибка обработки платежа');
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveReceipt = async (txId: string) => {
    const num = (receiptInputs[txId] || '').trim() || `NPD-${Date.now().toString().slice(-6)}`;
    setBusyId(txId);
    try {
      const next = await apiAdminIssueNpdReceipt(session, txId, num, adminPin);
      applyOverviewUpdate(next);
      onNotice(`Чек НПД № ${num} зафиксирован`);
    } catch (err: any) {
      onNotice(err?.message || 'Ошибка записи чека НПД');
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyId('save_cfg');
    try {
      const payload: Record<string, any> = {
        monthlyPriceRub: Math.max(1, Number(cfgPrice) || 50),
        trialDays: Math.max(0, Number(cfgTrialDays) || 7),
        selfEmployedName: cfgName,
        selfEmployedInn: cfgInn,
        sbpPhoneOrLink: cfgSbp,
        npdTaxRatePct: cfgTaxRate,
        supportEmail: cfgSupportEmail,
        supportTelegram: cfgSupportTelegram,
        supportPhone: '',
        supportHours: cfgSupportHours,
        sellerCity: cfgSellerCity,
      };
      if (cfgNewPin.trim()) {
        payload.newAdminPin = cfgNewPin.trim();
      }
      const next = await apiAdminUpdateConfig(session, payload, adminPin);
      if (cfgNewPin.trim()) {
        try {
          sessionStorage.setItem(ADMIN_PIN_STORAGE_KEY, cfgNewPin.trim());
        } catch {
          // ignore
        }
        setAdminPin(cfgNewPin.trim());
        setCfgNewPin('');
      }
      applyOverviewUpdate(next);
      onNotice('Настройки тарифа и самозанятости сохранены');
    } catch (err: any) {
      onNotice(err?.message || 'Ошибка сохранения настроек');
    } finally {
      setBusyId(null);
    }
  };

  const handleClearPin = async () => {
    setBusyId('clear_pin');
    try {
      const next = await apiAdminUpdateConfig(session, { clearAdminPin: true }, adminPin);
      try {
        sessionStorage.removeItem(ADMIN_PIN_STORAGE_KEY);
      } catch {
        // ignore
      }
      setAdminPin('');
      applyOverviewUpdate(next);
      onNotice('PIN-защита админ-панели отключена');
    } catch (err: any) {
      onNotice(err?.message || 'Ошибка отключения PIN-кода');
    } finally {
      setBusyId(null);
    }
  };

  const filteredUsers = useMemo(() => {
    if (!overview) return [];
    const q = userSearch.trim().toLowerCase();
    return overview.users.filter((u) => {
      if (statusFilter !== 'all' && u.status !== statusFilter) return false;
      if (!q) return true;
      return (
        u.name.toLowerCase().includes(q) ||
        u.phone.toLowerCase().includes(q) ||
        u.accountId.toLowerCase().includes(q) ||
        u.address.toLowerCase().includes(q)
      );
    });
  }, [overview, userSearch, statusFilter]);

  const pendingTransactions = useMemo(() => {
    if (!overview) return [];
    return overview.transactions.filter((t) => t.status === 'pending');
  }, [overview]);

  if (pinRequired) {
    return (
      <div className="max-w-md mx-auto py-12">
        <form
          onSubmit={handleUnlockPin}
          className="p-6 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-4"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#2563EB]/10 text-[#2563EB] dark:text-[#3B82F6] flex items-center justify-center shrink-0">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Доступ к админ-панели
              </h2>
              <p className="text-xs text-slate-400">
                Введите PIN-код владельца сервиса
              </p>
            </div>
          </div>

          {pinError && (
            <div className="text-xs text-rose-500 font-medium">{pinError}</div>
          )}

          <input
            type="password"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            placeholder="PIN-код администратора"
            autoFocus
            className="w-full px-3.5 py-2.5 text-sm rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white focus:outline-none"
          />

          <button
            type="submit"
            className="w-full py-2.5 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold transition-colors cursor-pointer"
          >
            Открыть панель управления
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-slate-900 dark:text-white font-display">
            Админ-панель и биллинг
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Управление пользователями, балансами, подпиской {overview?.config.monthlyPriceRub ?? 50} ₽/мес и чеками «Мой налог» (НПД {overview?.config.npdTaxRatePct ?? 4}%)
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => loadOverview()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/[0.08] text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-[#2563EB] dark:text-[#3B82F6] ${loading ? 'animate-spin' : ''}`} />
            <span>Обновить</span>
          </button>
        </div>
      </div>

      {/* KPI Strip — flat single-elevation card */}
      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 sm:p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-1">
            <div className="text-[11px] font-medium text-slate-400 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-[#2563EB] dark:text-[#3B82F6]" />
              <span>Пользователи</span>
            </div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
              {overview.stats.totalUsers}
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
              Активных: {overview.stats.activeUsers} · Триал: {overview.stats.trialUsers}
            </div>
          </div>

          <div className="p-4 sm:p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-1">
            <div className="text-[11px] font-medium text-slate-400 flex items-center gap-1.5">
              <Wallet className="w-3.5 h-3.5 text-emerald-500" />
              <span>Балансы пользователей</span>
            </div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white font-mono tabular-nums">
              {overview.stats.totalUserBalancesRub.toFixed(0)} ₽
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
              Тариф {overview.config.monthlyPriceRub} ₽ / 30 дн.
            </div>
          </div>

          <div className="p-4 sm:p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-1">
            <div className="text-[11px] font-medium text-slate-400 flex items-center gap-1.5">
              <Receipt className="w-3.5 h-3.5 text-sky-500" />
              <span>Выручка за 30 дней</span>
            </div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white font-mono tabular-nums">
              {overview.stats.revenueLast30DaysRub.toFixed(0)} ₽
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              Ожидает оплаты: {overview.stats.pendingTopupsCount} · Без чека: {overview.stats.unreceiptedPaymentsCount}
            </div>
          </div>

          <div className="p-4 sm:p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-1">
            <div className="text-[11px] font-medium text-slate-400 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
              <span>Налог НПД ({overview.config.npdTaxRatePct}%)</span>
            </div>
            <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 font-mono tabular-nums">
              {overview.stats.netIncomeRub.toFixed(2)} ₽
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              Чистыми · Налог: {overview.stats.npdTaxRub.toFixed(2)} ₽
            </div>
          </div>
        </div>
      )}

      {/* Pending Topup Approvals Alert Strip */}
      {pendingTransactions.length > 0 && (
        <section className="p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-amber-500/40 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Clock className="w-4 h-4 text-amber-500" />
              <span>Ожидающие платежи и заявки ({pendingTransactions.length})</span>
            </div>
            <span className="text-xs text-slate-400">
              Платежи ЮKassa подтверждаются автоматически; ручные заявки — здесь
            </span>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {pendingTransactions.map((tx) => (
              <div
                key={tx.id}
                className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-slate-900 dark:text-white">
                    {tx.userName || tx.userPhone}{' '}
                    <span className="font-mono tabular-nums text-[#2563EB] dark:text-[#3B82F6]">
                      +{tx.amountRub} ₽
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono tabular-nums mt-0.5">
                    {tx.userPhone || '—'} · {formatDateTime(tx.createdAt)} · {tx.description}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={receiptInputs[tx.id] || ''}
                    onChange={(e) =>
                      setReceiptInputs((prev) => ({ ...prev, [tx.id]: e.target.value }))
                    }
                    placeholder="№ чека Мой налог (необяз.)"
                    className="px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 text-xs w-44 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={busyId === tx.id}
                    onClick={() => handleProcessTx(tx.id, 'approve')}
                    className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-semibold inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Подтвердить</span>
                  </button>
                  <button
                    type="button"
                    disabled={busyId === tx.id}
                    onClick={() => handleProcessTx(tx.id, 'reject')}
                    className="px-2.5 py-1.5 rounded-lg bg-rose-500/10 text-rose-500 font-medium inline-flex items-center gap-1 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Отклонить</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Sub-navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] rounded-xl">
          {(
            [
              { id: 'users', label: 'Пользователи и балансы', icon: <Users className="w-3.5 h-3.5" /> },
              { id: 'transactions', label: 'Платежи и чеки НПД', icon: <Receipt className="w-3.5 h-3.5" /> },
              { id: 'config', label: 'Тариф и самозанятость', icon: <Settings2 className="w-3.5 h-3.5" /> },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSubTab(tab.id)}
              className={`px-3.5 py-1.5 text-xs rounded-lg inline-flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer ${
                subTab === tab.id
                  ? 'bg-[#2563EB] text-white font-semibold'
                  : 'font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {subTab === 'users' && (
          <button
            type="button"
            onClick={() => setShowAddUser((v) => !v)}
            className="px-3.5 py-2 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Добавить пользователя</span>
          </button>
        )}
      </div>

      {/* ================================================================= */}
      {/* TAB 1: USERS & BALANCES                                           */}
      {/* ================================================================= */}
      {subTab === 'users' && overview && (
        <div className="space-y-4">
          {showAddUser && (
            <form
              onSubmit={handleCreateUser}
              className="p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-4"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                  Новый пользователь сервиса
                </h2>
                <button
                  type="button"
                  onClick={() => setShowAddUser(false)}
                  className="text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Имя (например, Иван Петров)"
                  required
                  className="px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 focus:outline-none"
                />
                <input
                  type="text"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="Телефон (79XXXXXXXXX)"
                  required
                  className="px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 font-mono focus:outline-none"
                />
                <input
                  type="text"
                  value={newAccountId}
                  onChange={(e) => setNewAccountId(e.target.value)}
                  placeholder="Лицевой счёт (необяз.)"
                  className="px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 font-mono focus:outline-none"
                />
                <input
                  type="text"
                  value={newAddress}
                  onChange={(e) => setNewAddress(e.target.value)}
                  placeholder="Адрес объекта"
                  className="px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 focus:outline-none"
                />
                <input
                  type="number"
                  value={newBalance}
                  onChange={(e) => setNewBalance(e.target.value)}
                  placeholder="Начальный баланс (₽)"
                  className="px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 font-mono focus:outline-none"
                />
                <select
                  value={newStatus}
                  onChange={(e) => setNewStatus(e.target.value as BillingSubscriptionStatus)}
                  className="px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 focus:outline-none"
                >
                  <option value="trial">Пробный период (7 дн.)</option>
                  <option value="active">Активна (30 дн.)</option>
                  <option value="expired">Истекла</option>
                </select>
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={busyId === 'create_user'}
                  className="px-4 py-2 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white text-xs font-semibold cursor-pointer"
                >
                  Сохранить пользователя
                </button>
              </div>
            </form>
          )}

          <div className="p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="relative flex-1 min-w-[220px] max-w-sm">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="Поиск по имени, телефону, Л/С или адресу..."
                  className="w-full pl-8 pr-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/[0.06] focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center gap-1 text-xs">
                {(
                  [
                    { id: 'all', label: 'Все' },
                    { id: 'active', label: 'Активные' },
                    { id: 'trial', label: 'Триал' },
                    { id: 'expired', label: 'Истекшие' },
                    { id: 'blocked', label: 'Заблок.' },
                  ] as const
                ).map((st) => (
                  <button
                    key={st.id}
                    type="button"
                    onClick={() => setStatusFilter(st.id)}
                    className={`px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer ${
                      statusFilter === st.id
                        ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-semibold'
                        : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.05]'
                    }`}
                  >
                    {st.label}
                  </button>
                ))}
              </div>
            </div>

            {filteredUsers.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-400">
                Пользователи по выбранному фильтру не найдены
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                {filteredUsers.map((user) => {
                  const st = renderStatusLabel(user);
                  const isEditingBalance = adjustUserId === user.userId;
                  return (
                    <div key={user.userId} className="py-3.5 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-4 text-xs">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-bold text-slate-900 dark:text-white">
                              {user.name}
                            </span>
                            {user.role === 'admin' && (
                              <span className="text-[11px] font-semibold text-[#2563EB] dark:text-[#3B82F6]">
                                · Администратор
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono tabular-nums truncate">
                            {user.phone ? `+${user.phone}` : 'Без телефона'} · Л/С {user.accountId || '—'}
                            {!user.accountId && user.subscriberId ? ` · ID ${user.subscriberId}` : ''}
                            {user.address ? ` · ${user.address}` : ''}
                          </div>
                        </div>

                        {/* Subscription Status */}
                        <div className="w-40 shrink-0">
                          <div className={`font-semibold flex items-center gap-1.5 ${st.colorClass}`}>
                            {st.icon}
                            <span>{st.label}</span>
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono tabular-nums mt-0.5">
                            {st.sub}
                          </div>
                        </div>

                        {/* Balance */}
                        <div className="w-28 shrink-0 text-right">
                          <div className="text-sm font-bold text-slate-900 dark:text-white font-mono tabular-nums">
                            {user.balanceRub.toFixed(0)} ₽
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {user.autoRenew ? 'Автопродление' : 'Вручную'}
                          </div>
                        </div>

                        {/* Row Actions */}
                        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setAdjustUserId(isEditingBalance ? null : user.userId);
                              setAdjustAmount('50');
                            }}
                            className="px-2.5 py-1.5 rounded-lg bg-[#2563EB]/10 hover:bg-[#2563EB]/20 text-[#2563EB] dark:text-[#3B82F6] font-semibold inline-flex items-center gap-1 cursor-pointer"
                          >
                            <Wallet className="w-3.5 h-3.5" />
                            <span>Баланс</span>
                          </button>

                          <button
                            type="button"
                            disabled={busyId === user.userId}
                            onClick={() =>
                              handleQuickSubAction(
                                user.userId,
                                { addDays: 30, status: 'active' },
                                `Подписка «${user.name}» продлена на 30 дней`
                              )
                            }
                            className="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.06] dark:hover:bg-white/[0.1] text-slate-700 dark:text-slate-200 font-medium inline-flex items-center gap-1 cursor-pointer"
                          >
                            <CalendarPlus className="w-3.5 h-3.5" />
                            <span>+30 дн.</span>
                          </button>

                          <button
                            type="button"
                            disabled={busyId === user.userId}
                            onClick={() =>
                              handleQuickSubAction(
                                user.userId,
                                { status: user.status === 'blocked' ? 'active' : 'blocked' },
                                user.status === 'blocked'
                                  ? `Пользователь «${user.name}» разблокирован`
                                  : `Пользователь «${user.name}» заблокирован`
                              )
                            }
                            className={`px-2.5 py-1.5 rounded-lg font-medium inline-flex items-center gap-1 cursor-pointer ${
                              user.status === 'blocked'
                                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                : 'bg-rose-500/10 text-rose-500'
                            }`}
                          >
                            {user.status === 'blocked' ? (
                              <>
                                <Unlock className="w-3.5 h-3.5" />
                                <span>Разблок</span>
                              </>
                            ) : (
                              <>
                                <Ban className="w-3.5 h-3.5" />
                                <span>Блок</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>

                      {isEditingBalance && (
                        <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/[0.08] flex flex-wrap items-end gap-2.5 text-xs">
                          <div>
                            <label className="block text-[11px] text-slate-400 mb-1">
                              Сумма (+/- ₽)
                            </label>
                            <input
                              type="text"
                              value={adjustAmount}
                              onChange={(e) => setAdjustAmount(e.target.value)}
                              className="w-24 px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/10 font-mono focus:outline-none"
                            />
                          </div>
                          <div className="flex-1 min-w-[160px]">
                            <label className="block text-[11px] text-slate-400 mb-1">
                              Комментарий
                            </label>
                            <input
                              type="text"
                              value={adjustDesc}
                              onChange={(e) => setAdjustDesc(e.target.value)}
                              className="w-full px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/10 focus:outline-none"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-400 mb-1">
                              Способ
                            </label>
                            <select
                              value={adjustChannel}
                              onChange={(e) => setAdjustChannel(e.target.value as any)}
                              className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/10 focus:outline-none"
                            >
                              <option value="sbp">СБП</option>
                              <option value="yookassa_npd">ЮKassa / Эквайринг</option>
                              <option value="manual">Вручную</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-400 mb-1">
                              Чек «Мой налог»
                            </label>
                            <input
                              type="text"
                              value={adjustReceiptNum}
                              onChange={(e) => setAdjustReceiptNum(e.target.value)}
                              placeholder="№ чека (если выдан)"
                              className="w-36 px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/10 font-mono focus:outline-none"
                            />
                          </div>
                          <button
                            type="button"
                            disabled={busyId === user.userId}
                            onClick={() => handleAdjustBalance(user.userId)}
                            className="px-3.5 py-1.5 rounded-lg bg-[#2563EB] hover:bg-blue-700 text-white font-semibold cursor-pointer"
                          >
                            Применить
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 2: TRANSACTIONS & NPD 4% RECEIPTS                             */}
      {/* ================================================================= */}
      {subTab === 'transactions' && overview && (
        <div className="p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                Журнал операций и учёт чеков «Мой налог» (422-ФЗ)
              </h2>
              <p className="text-[11px] text-slate-400">
                По каждому поступлению денег от пользователя фиксируйте чек в «Мой налог» (4% для физлиц)
              </p>
            </div>
          </div>

          {overview.transactions.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">
              Операций пока нет
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {overview.transactions.map((tx) => (
                <div
                  key={tx.id}
                  className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900 dark:text-white">
                        {tx.description}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        · {tx.userName || tx.userPhone}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                      {formatDateTime(tx.createdAt)} · Статус:{' '}
                      {tx.status === 'completed'
                        ? 'Проведено'
                        : tx.status === 'pending'
                          ? 'Ожидает подтверждения'
                          : 'Отклонено'}
                      {tx.npdReceiptStatus === 'issued'
                        ? ` · Чек НПД: ${tx.npdReceiptNumber || 'Выдан'}`
                        : tx.npdReceiptStatus === 'pending' && tx.status === 'completed'
                          ? ' · Чек «Мой налог» не внесён'
                          : ''}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 shrink-0">
                    <span
                      className={`font-mono tabular-nums font-bold ${
                        tx.amountRub > 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      {tx.amountRub > 0 ? `+${tx.amountRub}` : tx.amountRub} ₽
                    </span>

                    {tx.status === 'completed' && tx.npdReceiptStatus === 'pending' && (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={receiptInputs[tx.id] || ''}
                          onChange={(e) =>
                            setReceiptInputs((prev) => ({ ...prev, [tx.id]: e.target.value }))
                          }
                          placeholder="№ чека"
                          className="w-28 px-2 py-1 rounded-lg bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 font-mono text-[11px] focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={busyId === tx.id}
                          onClick={() => handleSaveReceipt(tx.id)}
                          className="px-2.5 py-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-semibold inline-flex items-center gap-1 cursor-pointer"
                        >
                          <FileCheck2 className="w-3.5 h-3.5" />
                          <span>Отметить чек</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 3: TARIFF & SELF-EMPLOYED (NPD) SETTINGS                      */}
      {/* ================================================================= */}
      {subTab === 'config' && overview && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <form
            onSubmit={handleSaveConfig}
            className="lg:col-span-7 p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-4 text-xs"
          >
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              Параметры тарифа и реквизиты Самозанятого (НПД)
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  Стоимость подписки (₽ / 30 дн.)
                </label>
                <input
                  type="number"
                  min={1}
                  value={cfgPrice}
                  onChange={(e) => setCfgPrice(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 font-mono tabular-nums focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  Пробный период (дней для новых)
                </label>
                <input
                  type="number"
                  min={0}
                  max={90}
                  value={cfgTrialDays}
                  onChange={(e) => setCfgTrialDays(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 font-mono tabular-nums focus:outline-none"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  ФИО / Наименование исполнителя (Самозанятый)
                </label>
                <input
                  type="text"
                  value={cfgName}
                  onChange={(e) => setCfgName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  ИНН самозанятого (12 цифр)
                </label>
                <input
                  type="text"
                  value={cfgInn}
                  onChange={(e) => setCfgInn(e.target.value)}
                  placeholder="Отображается в оферте"
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 font-mono focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  Ставка НПД
                </label>
                <select
                  value={cfgTaxRate}
                  onChange={(e) => setCfgTaxRate(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 focus:outline-none"
                >
                  <option value={4}>4% (приём оплаты от физлиц)</option>
                  <option value={6}>6% (приём оплаты от ЮЛ / ИП)</option>
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  Отображаемый способ оплаты / резервный СБП
                </label>
                <input
                  type="text"
                  value={cfgSbp}
                  onChange={(e) => setCfgSbp(e.target.value)}
                  placeholder="ЮKassa (Карты РФ, СБП, SberPay)"
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  Email техподдержки
                </label>
                <input
                  type="email"
                  value={cfgSupportEmail}
                  onChange={(e) => setCfgSupportEmail(e.target.value)}
                  placeholder="support@example.ru"
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  Telegram техподдержки
                </label>
                <input
                  type="text"
                  value={cfgSupportTelegram}
                  onChange={(e) => setCfgSupportTelegram(e.target.value)}
                  placeholder="@username или ссылка t.me/..."
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 focus:outline-none"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  Город / регион (для реквизитов)
                </label>
                <input
                  type="text"
                  value={cfgSellerCity}
                  onChange={(e) => setCfgSellerCity(e.target.value)}
                  placeholder="г. Новосибирск"
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 focus:outline-none"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  График работы техподдержки
                </label>
                <input
                  type="text"
                  value={cfgSupportHours}
                  onChange={(e) => setCfgSupportHours(e.target.value)}
                  placeholder="Ежедневно, 09:00–21:00"
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 focus:outline-none"
                />
              </div>

              <div className="sm:col-span-2 pt-2 border-t border-slate-100 dark:border-white/[0.06]">
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  PIN-код защиты админ-панели {overview.config.hasAdminPin ? '(сейчас установлен)' : '(пока не задан)'}
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    value={cfgNewPin}
                    onChange={(e) => setCfgNewPin(e.target.value)}
                    placeholder="Введите новый PIN (оставьте пустым, чтобы не менять)"
                    className="flex-1 min-w-[200px] px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/10 focus:outline-none"
                  />
                  {overview.config.hasAdminPin && (
                    <button
                      type="button"
                      disabled={busyId === 'clear_pin'}
                      onClick={handleClearPin}
                      className="px-3 py-2 rounded-xl bg-rose-500/10 text-rose-500 font-semibold cursor-pointer"
                    >
                      Сбросить PIN
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={busyId === 'save_cfg'}
                className="px-4 py-2 rounded-xl bg-[#2563EB] hover:bg-blue-700 text-white font-semibold cursor-pointer"
              >
                Сохранить настройки
              </button>
            </div>
          </form>

          <div className="lg:col-span-5 space-y-4 text-xs">
            <div className="p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  Статус эквайринга ЮKassa
                </h3>
                <span
                  className={`font-semibold ${
                    overview.config.yookassaEnabled
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-amber-600 dark:text-amber-400'
                  }`}
                >
                  {overview.config.yookassaEnabled ? 'API подключена' : 'Нужны ключи в .env'}
                </span>
              </div>
              <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
                Учётные данные{' '}
                <code className="font-mono text-slate-700 dark:text-slate-200">YOOKASSA_SHOP_ID</code>{' '}
                и{' '}
                <code className="font-mono text-slate-700 dark:text-slate-200">YOOKASSA_SECRET_KEY</code>{' '}
                хранятся исключительно на сервере в файле{' '}
                <code className="font-mono text-slate-700 dark:text-slate-200">.env</code>.
              </p>
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200/70 dark:border-white/[0.06] space-y-1">
                <div className="text-[11px] text-slate-400">URL для HTTP-уведомлений (Webhook) в ЮKassa:</div>
                <div className="font-mono text-[11px] text-slate-800 dark:text-slate-200 break-all">
                  {typeof window !== 'undefined' ? window.location.origin : 'http://<IP_ВАШЕГО_VPS>:3000'}
                  /api/eg/billing/yookassa/webhook
                </div>
              </div>
            </div>

            <div className="p-5 rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200/80 dark:border-white/[0.06] space-y-3">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Официальная схема для Самозанятого (422-ФЗ)
              </h3>
              <ul className="space-y-2 text-slate-600 dark:text-slate-300 leading-relaxed">
                <li>
                  <span className="font-semibold text-slate-900 dark:text-white">1. Предмет услуги в чеке:</span>{' '}
                  «Предоставление доступа к веб-сервису управления доступом Open-Key (тариф 30 дней)» — вы продаёте свой софт/интерфейс, а не перепродаёте услуги интернет-провайдера.
                </li>
                <li>
                  <span className="font-semibold text-slate-900 dark:text-white">2. Интеграция ЮKassa + «Мой налог»:</span>{' '}
                  Подключите самозанятость в личном кабинете ЮKassa — при оплате картой или СБП чек в ФНС формируется автоматически, а баланс в Open-Key зачисляется мгновенно по Webhook.
                </li>
                <li>
                  <span className="font-semibold text-slate-900 dark:text-white">3. Налог НПД 4%:</span>{' '}
                  С 50 ₽ налог составляет 2 ₽. Комиссия СБП через ЮKassa — 0.4–0.7%.
                </li>
                <li>
                  <span className="font-semibold text-slate-900 dark:text-white">4. Доступ владельца:</span>{' '}
                  Админ-панель открывается только при авторизации с подтверждённым телефоном <span className="font-mono">79128387309</span> или лицевым счётом <span className="font-mono">450005579792</span>.
                </li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
