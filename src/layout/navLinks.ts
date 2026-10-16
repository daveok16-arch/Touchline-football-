import { LayoutDashboard, Calendar, Trophy, BarChart2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type ViewId = 'home' | 'fixtures' | 'match' | 'competitions' | 'standings';

export interface NavItem {
  /** Canonical view id this link navigates to. */
  id: ViewId;
  /** Full label, used in the header, mobile drawer and footer. */
  label: string;
  /** Short label, used in the mobile bottom bar. */
  shortLabel: string;
  icon: LucideIcon;
}

/**
 * The single navigation model for the whole shell. Header links, the mobile drawer, the mobile
 * bottom bar and the footer all derive from this list so a nav change is made in one place.
 */
export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Overview', shortLabel: 'Overview', icon: LayoutDashboard },
  { id: 'fixtures', label: 'Fixtures', shortLabel: 'Fixtures', icon: Calendar },
  { id: 'competitions', label: 'Competitions', shortLabel: 'Leagues', icon: Trophy },
  { id: 'standings', label: 'Standings', shortLabel: 'Standings', icon: BarChart2 },
];

/** `true` when a nav item should read as active for the current view. */
export function isNavActive(itemId: ViewId, currentView: string): boolean {
  if (itemId === 'fixtures') return currentView === 'fixtures' || currentView === 'match';
  return currentView === itemId;
}
