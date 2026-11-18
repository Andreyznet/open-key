import React from 'react';

export const DomRuLabLogo: React.FC<{ className?: string; size?: 'sm' | 'md' | 'lg' }> = ({
  className = '',
  size = 'md',
}) => {
  const iconSize = size === 'sm' ? 'w-7 h-7' : size === 'lg' ? 'w-9 h-9' : 'w-8 h-8';
  const textSize = size === 'sm' ? 'text-lg' : size === 'lg' ? 'text-2xl' : 'text-xl';

  return (
    <div className={`inline-flex items-center gap-2.5 select-none ${className}`}>
      <svg
        viewBox="0 0 36 36"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`${iconSize} shrink-0`}
      >
        <rect x="3" y="3" width="30" height="30" rx="9" fill="#2563EB" />
        <circle cx="14.5" cy="18" r="4.2" stroke="white" strokeWidth="2.3" />
        <path
          d="M18.7 18H26.5M23.5 18V21.2M26.2 18V21.8"
          stroke="white"
          strokeWidth="2.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className={`${textSize} font-bold tracking-tight font-display leading-none`}>
        <span className="text-slate-900 dark:text-white">Open-</span>
        <span className="text-[#2563EB] dark:text-[#3B82F6]">Key</span>
      </span>
    </div>
  );
};

export const CctvCameraIcon: React.FC<{ className?: string }> = ({ className = 'w-6 h-6' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <rect x="3" y="6" width="13" height="10" rx="2" />
    <path d="M16 9l5-2v8l-5-2" />
    <path d="M7 16v3h4" />
  </svg>
);

export const DoorOutlineIcon: React.FC<{ className?: string }> = ({ className = 'w-6 h-6' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16" />
    <path d="M3 21h18" />
    <circle cx="15" cy="12" r="1" fill="currentColor" />
  </svg>
);

export const GateOutlineIcon: React.FC<{ className?: string }> = ({ className = 'w-6 h-6' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <rect x="2" y="5" width="3" height="14" rx="0.5" />
    <rect x="19" y="5" width="3" height="14" rx="0.5" />
    <rect x="5" y="7" width="14" height="10" rx="0.5" />
    <line x1="8.5" y1="7" x2="8.5" y2="17" />
    <line x1="12" y1="7" x2="12" y2="17" />
    <line x1="15.5" y1="7" x2="15.5" y2="17" />
  </svg>
);

export const FaceScanOutlineIcon: React.FC<{ className?: string }> = ({
  className = 'w-6 h-6',
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M4 8V6a2 2 0 0 1 2-2h2" />
    <path d="M4 16v2a2 2 0 0 0 2 2h2" />
    <path d="M16 4h2a2 2 0 0 1 2 2v2" />
    <path d="M16 20h2a2 2 0 0 0 2-2v-2" />
    <circle cx="12" cy="10" r="2.5" />
    <path d="M8.5 16.5c1-1.8 2.2-2.5 3.5-2.5s2.5.7 3.5 2.5" />
  </svg>
);

export const MotionPersonIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <circle cx="13.5" cy="5.5" r="2" />
    <path d="M9 12l3-2.5 3 2 2.5 3" />
    <path d="M12 9.5l-1.5 5 3.5 2.5v4" />
    <path d="M10.5 14.5L7 19" />
    <path d="M4 9h2.5" />
    <path d="M3 13h3" />
  </svg>
);
