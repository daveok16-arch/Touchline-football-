import React from 'react';
import { AppHeader } from './AppHeader';
import { AppFooter } from './AppFooter';
import { MobileBottomNav } from './MobileBottomNav';
import { Container } from './Container';

export interface AppLayoutProps {
  currentView: string;
  onNavigate: (view: string, matchId?: string) => void;
  timezoneId: string;
  onTimezoneChange: (tzId: string) => void;
  /** View content rendered inside the main content column. */
  children: React.ReactNode;
}

/**
 * The main application layout shell.
 *
 * A flex column that fills the viewport: persistent header, a scrollable content column, the
 * persistent footer, and the mobile bottom navigation. Spacing comes from the design tokens
 * (`pt-section`, `pb-section-xl`, `max-w-shell`, responsive `px-gutter*`), so the vertical rhythm
 * and gutters stay consistent across every view.
 */
export const AppLayout: React.FC<AppLayoutProps> = ({
  currentView,
  onNavigate,
  timezoneId,
  onTimezoneChange,
  children,
}) => (
  <div className="min-h-screen flex flex-col bg-[#090D16] font-sans text-slate-100 selection:bg-emerald-500/20 selection:text-emerald-300">
    <AppHeader
      currentView={currentView}
      onNavigate={onNavigate}
      timezoneId={timezoneId}
      onTimezoneChange={onTimezoneChange}
    />

    <main className="flex-1 w-full">
      <Container className="pt-section pb-section-xl">{children}</Container>
    </main>

    <AppFooter timezoneId={timezoneId} onNavigate={onNavigate} />
    <MobileBottomNav currentView={currentView} onNavigate={onNavigate} />
  </div>
);
