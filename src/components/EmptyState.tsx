import React from 'react';
import { CalendarX2, AlertCircle, RefreshCw, Radio } from 'lucide-react';

interface EmptyStateProps {
  type?: 'no_fixtures' | 'not_configured' | 'unavailable' | 'empty';
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  type = 'no_fixtures',
  title,
  description,
  onRetry,
  retryLabel = 'Try again',
}) => {
  let defaultIcon = <CalendarX2 className="w-8 h-8 text-slate-500" />;
  let defaultTitle = 'No fixtures found for this date.';
  let defaultDesc = 'Check back for upcoming matchday schedules or choose another competition.';

  if (type === 'not_configured') {
    defaultIcon = <Radio className="w-8 h-8 text-slate-400" />;
    defaultTitle = 'Football data is not connected yet.';
    defaultDesc = 'The football data provider key has not been configured.';
  } else if (type === 'unavailable') {
    defaultIcon = <AlertCircle className="w-8 h-8 text-slate-400" />;
    defaultTitle = 'Football data is temporarily unavailable. Try again.';
    defaultDesc = 'We could not reach the provider. Please try again in a few moments.';
  }

  const displayTitle = title || defaultTitle;
  const displayDesc = description !== undefined ? description : defaultDesc;

  return (
    <div className="bg-[#0F172A] border border-slate-800/80 rounded-xl p-8 sm:p-12 text-center max-w-md mx-auto my-6">
      <div className="w-14 h-14 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center mx-auto mb-4">
        {defaultIcon}
      </div>
      <h3 className="text-base sm:text-lg font-semibold text-white mb-1.5">{displayTitle}</h3>
      {displayDesc && (
        <p className="text-xs sm:text-sm text-slate-400 mb-5 leading-relaxed max-w-sm mx-auto">
          {displayDesc}
        </p>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-200 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-slate-600 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>{retryLabel}</span>
        </button>
      )}
    </div>
  );
};
