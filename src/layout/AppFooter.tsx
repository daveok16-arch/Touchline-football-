import React from 'react';
import { getResolvedTimezone, getTimezoneAbbr } from '../utils/timezone';
import { Container } from './Container';
import { NAV_ITEMS } from './navLinks';

interface AppFooterProps {
  timezoneId: string;
  onNavigate: (view: string, matchId?: string) => void;
}

/**
 * Persistent application footer. Mirrors the header navigation, credits the data source and shows
 * the active timezone. Token spacing: `py-section` padding, `gap-4`/`gap-2` rhythm, `text-2xs`
 * disclaimer line. Hidden on mobile where the bottom bar carries navigation and the wordmark.
 */
export const AppFooter: React.FC<AppFooterProps> = ({ timezoneId, onNavigate }) => (
  <footer className="hidden md:block border-t border-slate-800/80 bg-[#070B13] py-section text-xs text-slate-500">
    <Container className="space-y-4">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="font-bold text-slate-300">Project Touchline</span>
          <span aria-hidden="true" className="text-slate-700">
            •
          </span>
          <span className="text-slate-400">Football Intelligence</span>
        </div>
        <nav aria-label="Footer" className="flex items-center gap-4 text-slate-400">
          {NAV_ITEMS.map((link) => (
            <button
              key={link.id}
              onClick={() => onNavigate(link.id)}
              className="hover:text-slate-200 transition-colors"
            >
              {link.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="pt-3 border-t border-slate-800/50 flex flex-col sm:flex-row items-center justify-between gap-2 text-2xs text-slate-500">
        <p>Data provided via Football-Data.org Free Tier proxy.</p>
        <p className="font-mono text-slate-400">
          Timezone: {getResolvedTimezone(timezoneId)} ({getTimezoneAbbr(timezoneId)})
        </p>
      </div>
    </Container>
  </footer>
);
