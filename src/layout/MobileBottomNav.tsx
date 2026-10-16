import React from 'react';
import { NAV_ITEMS, isNavActive } from './navLinks';

interface MobileBottomNavProps {
  currentView: string;
  onNavigate: (view: string, matchId?: string) => void;
}

/**
 * Mobile-only bottom navigation bar. Derived from the shared nav model; visible below `md`, where
 * the header's desktop links are hidden.
 */
export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({ currentView, onNavigate }) => (
  <div
    data-testid="mobile-bottom-nav"
    className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0D1526]/95 backdrop-blur-md border-t border-slate-800 py-1.5 px-4"
  >
    <div className="grid grid-cols-4 gap-1 text-center">
      {NAV_ITEMS.map(({ id, shortLabel, icon: Icon }) => {
        const isActive = isNavActive(id, currentView);
        return (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            aria-current={isActive ? 'page' : undefined}
            className={`flex flex-col items-center py-1 rounded transition-colors ${
              isActive ? 'text-emerald-400 font-semibold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Icon className="w-4 h-4 mb-0.5" />
            <span className="text-2xs">{shortLabel}</span>
          </button>
        );
      })}
    </div>
  </div>
);
