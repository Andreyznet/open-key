import React, { useEffect, useState } from 'react';
import { Key, Unlock, Check, AlertCircle, Clock, ShieldCheck, X } from 'lucide-react';
import {
  apiGetGuestPassInfo,
  apiOpenDoorByGuestPass,
  PublicGuestPassInfo,
} from '../services/egClient';
import { playGlobalDoorOpenSound } from '../utils/flvAudioEngine';

interface GuestPassPortalProps {
  token: string;
  onClose?: () => void;
}

export const GuestPassPortal: React.FC<GuestPassPortalProps> = ({ token, onClose }) => {
  const [info, setInfo] = useState<PublicGuestPassInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiGetGuestPassInfo(token)
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Гостевая ссылка недействительна или истекла');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleOpen = async (acId: number, entranceId?: string | null) => {
    const key = `${acId}:${entranceId || ''}`;
    if (openingKey != null) return;
    setOpeningKey(key);
    setStatusMessage(null);
    try {
      const res = await apiOpenDoorByGuestPass(token, acId, entranceId);
      playGlobalDoorOpenSound();
      setOpenedKey(key);
      setStatusMessage(res.message);
      setTimeout(() => setOpenedKey(null), 3500);
    } catch (err: any) {
      setError(err?.message || 'Ошибка при открытии двери');
    } finally {
      setOpeningKey(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-[#1a202c] border border-slate-200 dark:border-white/10 p-6 shadow-2xl space-y-5 text-slate-900 dark:text-slate-100">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-[#2563EB]/10 border border-[#2563EB]/25 flex items-center justify-center text-[#2563EB] dark:text-[#3B82F6] shrink-0">
              <Key className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-900 dark:text-white font-display truncate">
                {info?.label ? `Гостевой доступ · ${info.label}` : 'Личный гостевой пропуск'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Временный доступ к дверям и калиткам
              </p>
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {loading && (
          <div className="p-6 text-center text-xs text-slate-400">
            Проверка гостевой ссылки...
          </div>
        )}

        {!loading && error && (
          <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-500/40 flex items-start gap-2.5 text-xs text-rose-700 dark:text-rose-200">
            <AlertCircle className="w-4 h-4 text-rose-500 dark:text-rose-400 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {!loading && info && (
          <div className="space-y-4">
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/[0.06] flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                <Clock className="w-3.5 h-3.5 text-[#2563EB] dark:text-[#3B82F6]" />
                <span>Действует до:</span>
              </span>
              <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                {new Date(Number(info.expiredAt)).toLocaleString('ru-RU')}
              </span>
            </div>

            <div className="space-y-2.5">
              <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                Доступные точки прохода ({info.availableAccessControl.length}):
              </div>
              {info.availableAccessControl.map((ac) => {
                const key = `${ac.id}:${ac.entranceId || ''}`;
                const isOpening = openingKey === key;
                const isOpened = openedKey === key;
                return (
                  <div
                    key={key}
                    className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#12161f] border border-slate-200 dark:border-white/[0.06] flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {ac.name}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Нажмите «Открыть» для разблокировки замка
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleOpen(ac.id, ac.entranceId)}
                      disabled={isOpening}
                      className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl transition-colors cursor-pointer shrink-0 ${
                        isOpened
                          ? 'bg-emerald-500 text-white'
                          : 'bg-[#2563EB] hover:bg-blue-700 text-white'
                      }`}
                    >
                      {isOpened ? (
                        <>
                          <Check className="w-4 h-4" />
                          <span>Открыто</span>
                        </>
                      ) : (
                        <>
                          <Unlock className="w-4 h-4" />
                          <span>{isOpening ? 'Открытие...' : 'Открыть'}</span>
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>

            {statusMessage && (
              <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-500/40 flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-200">
                <ShieldCheck className="w-4 h-4 text-emerald-500 dark:text-emerald-400 shrink-0" />
                <span>{statusMessage}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
