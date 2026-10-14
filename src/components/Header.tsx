import React, { useState, useEffect } from 'react';
import {
  Globe,
  ChevronDown,
  Menu,
  X,
  Radio,
} from 'lucide-react';
import { SUPPORTED_TIMEZONES } from '../utils/timezone';
import { FixtureService } from '../services/fixtureService';

interface HeaderProps {
  currentView: string;
  onNavigate: (view: string, matchId?: string) => void;
  timezoneId: string;
  onTimezoneChange: (tzId: string) => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentView,
  onNavigate,
  timezoneId,
  onTimezoneChange,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [tzDropdownOpen, setTzDropdownOpen] = useState(false);
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let isMounted = true;
    FixtureService.getProviderStatus()
      .then((status) => {
        if (isMounted) setIsConfigured(Boolean(status?.configured));
      })
      .catch(() => {
        if (isMounted) setIsConfigured(false);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const navLinks = [
    { id: 'home', label: 'Overview' },
    { id: 'fixtures', label: 'Fixtures' },
    { id: 'competitions', label: 'Competitions' },
    { id: 'standings', label: 'Standings' },
  ];

  const currentTzObj =
    SUPPORTED_TIMEZONES.find((t) => t.id === timezoneId) || SUPPORTED_TIMEZONES[0];

  return (
    <header className="sticky top-0 z-40 w-full bg-[#0D1526]/95 backdrop-blur-md border-b border-slate-800/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-4">
          {/* Brand Wordmark */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => onNavigate('home')}
              className="flex items-center gap-2.5 text-left group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-md"
            >
              <div className="w-8 h-8 rounded bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 group-hover:bg-emerald-500/25 transition-colors">
                <span className="font-bold text-sm tracking-wider">TL</span>
              </div>
              <div className="flex flex-col">
                <span className="text-base font-bold tracking-tight text-white group-hover:text-emerald-400 transition-colors whitespace-nowrap">
                  Project Touchline
                </span>
                <span className="text-[10px] text-slate-400 tracking-wide font-normal">
                  Football Intelligence
                </span>
              </div>
            </button>
          </div>

          {/* Desktop Navigation Links */}
          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-300">
            {navLinks.map((link) => {
              const isActive = currentView === link.id;
              return (
                <button
                  key={link.id}
                  onClick={() => onNavigate(link.id)}
                  className={`relative py-1 transition-colors whitespace-nowrap shrink-0 hover:text-white ${
                    isActive ? 'text-emerald-400 font-semibold' : 'text-slate-300'
                  }`}
                >
                  {link.label}
                  {isActive && (
                    <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-400 rounded-full" />
                  )}
                </button>
              );
            })}
          </nav>

          {/* Controls: Timezone and Subtle Provider Status */}
          <div className="flex items-center gap-3">
            {/* Subtle Provider Connection Pill */}
            <div
              className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded bg-slate-900 border border-slate-800 text-[11px] text-slate-400"
              title={
                isConfigured
                  ? 'Connected to Football-Data API (Delayed free tier)'
                  : 'Football-Data API key not configured'
              }
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isConfigured ? 'bg-emerald-400' : 'bg-slate-500'
                }`}
              />
              <span className="font-mono text-[10px]">
                {isConfigured === null
                  ? 'Checking...'
                  : isConfigured
                  ? 'Data Connected'
                  : 'Unconnected'}
              </span>
            </div>

            {/* Timezone Switcher */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setTzDropdownOpen(!tzDropdownOpen)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-900/90 border border-slate-700/80 rounded hover:border-slate-600 transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500"
                title={`Active Timezone: ${currentTzObj.label}`}
                aria-expanded={tzDropdownOpen}
              >
                <Globe className="w-3.5 h-3.5 text-emerald-400" />
                <span className="font-mono text-emerald-300">{currentTzObj.abbr}</span>
                <span className="hidden lg:inline text-slate-400"> • {currentTzObj.city}</span>
                <ChevronDown className="w-3 h-3 text-slate-400" />
              </button>

              {tzDropdownOpen && (
                <div className="absolute right-0 mt-2 w-72 bg-[#0F182A] border border-slate-700 rounded shadow-2xl py-1 z-50">
                  <div className="px-3 py-2 border-b border-slate-800">
                    <p className="text-xs font-semibold text-slate-200">Display Timezone</p>
                    <p className="text-[11px] text-slate-400">
                      Default: Africa/Lagos (West Africa Time, UTC+1)
                    </p>
                  </div>
                  <div className="py-1 max-h-60 overflow-y-auto">
                    {SUPPORTED_TIMEZONES.map((tz) => (
                      <button
                        key={tz.id}
                        onClick={() => {
                          onTimezoneChange(tz.id);
                          setTzDropdownOpen(false);
                        }}
                        className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between hover:bg-slate-800/70 transition-colors ${
                          timezoneId === tz.id
                            ? 'bg-emerald-950/40 text-emerald-300 font-semibold'
                            : 'text-slate-300'
                        }`}
                      >
                        <div className="flex flex-col">
                          <span>{tz.label}</span>
                          <span className="text-[10px] text-slate-500">{tz.city}</span>
                        </div>
                        <span className="font-mono text-[11px] text-slate-400">{tz.abbr}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Mobile Menu Toggle */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-1.5 text-slate-400 hover:text-white rounded"
              aria-label="Toggle Navigation Menu"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu Drawer */}
      {mobileMenuOpen && (
        <div className="md:hidden bg-[#0D1526] border-b border-slate-800 px-4 py-3 space-y-1">
          {navLinks.map((link) => {
            const isActive = currentView === link.id;
            return (
              <button
                key={link.id}
                onClick={() => {
                  onNavigate(link.id);
                  setMobileMenuOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-sm rounded transition-colors ${
                  isActive
                    ? 'bg-emerald-950/40 text-emerald-300 font-semibold'
                    : 'text-slate-300 hover:bg-slate-800/60'
                }`}
              >
                {link.label}
              </button>
            );
          })}
        </div>
      )}
    </header>
  );
};
