/**
 * Acceptance tests for the main application layout shell: a persistent header with navigation
 * links and a footer, driven by the typography and spacing design tokens.
 *
 * All data here is TEST DATA. The provider-status call is mocked so no network is used.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { AppLayout } from '../src/layout/AppLayout';
import { Container } from '../src/layout/Container';
import { NAV_ITEMS, isNavActive } from '../src/layout/navLinks';
import { designTokens, layoutSpacing, containerWidths, fontSizes, fontFamilies } from '../src/design/tokens';
import { DEFAULT_TIMEZONE } from '../src/utils/timezone';

vi.mock('../src/services/fixtureService', () => ({
  FixtureService: {
    getProviderStatus: vi.fn().mockResolvedValue({ configured: true }),
  },
}));

function renderShell(overrides: Partial<React.ComponentProps<typeof AppLayout>> = {}) {
  const onNavigate = vi.fn();
  const onTimezoneChange = vi.fn();
  const utils = render(
    <AppLayout
      currentView="home"
      onNavigate={onNavigate}
      timezoneId={DEFAULT_TIMEZONE}
      onTimezoneChange={onTimezoneChange}
      {...overrides}
    >
      <p>view content</p>
    </AppLayout>
  );
  return { ...utils, onNavigate, onTimezoneChange };
}

describe('AppLayout – persistent header', () => {
  it('always renders the header landmark, regardless of the active view', () => {
    for (const view of ['home', 'fixtures', 'match', 'competitions', 'standings']) {
      const { unmount } = renderShell({ currentView: view });
      const header = screen.getByRole('banner');
      expect(header).toBeTruthy();
      unmount();
    }
  });

  it('renders a navigation link for every shell nav item', () => {
    renderShell();
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    for (const item of NAV_ITEMS) {
      expect(within(primary).getByRole('button', { name: item.label })).toBeTruthy();
    }
    expect(within(primary).getAllByRole('button')).toHaveLength(NAV_ITEMS.length);
  });

  it('marks the active view with aria-current="page"', () => {
    renderShell({ currentView: 'standings' });
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(primary).getByRole('button', { name: 'Standings' }).getAttribute('aria-current')).toBe('page');
    expect(within(primary).getByRole('button', { name: 'Overview' }).getAttribute('aria-current')).toBeNull();
  });

  it('navigates when a header link is clicked', () => {
    const { onNavigate } = renderShell();
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    within(primary).getByRole('button', { name: 'Fixtures' }).click();
    expect(onNavigate).toHaveBeenCalledWith('fixtures');
  });

  it('uses the header-height spacing token and no stale raw pixel sizes', () => {
    renderShell();
    const header = screen.getByRole('banner');
    expect(header.className).toContain('h-header');
    expect(header.className).not.toContain('text-[10px]');
    expect(header.className).not.toContain('text-[11px]');
  });
});

describe('AppLayout – footer', () => {
  it('renders a contentinfo landmark with mirrored navigation', () => {
    renderShell();
    const footer = screen.getByRole('contentinfo');
    const footerNav = within(footer).getByRole('navigation', { name: 'Footer' });
    for (const item of NAV_ITEMS) {
      expect(within(footerNav).getByRole('button', { name: item.label })).toBeTruthy();
    }
  });

  it('shows the resolved timezone from the active zone', () => {
    renderShell({ timezoneId: 'UTC' });
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByText(/Timezone:/)).toBeTruthy();
    expect(within(footer).getByText(/\(UTC\)/)).toBeTruthy();
  });

  it('uses the section spacing token and does not hardcode the old py-8', () => {
    renderShell();
    const footer = screen.getByRole('contentinfo');
    expect(footer.className).toContain('py-section');
    expect(footer.className).not.toContain('py-8');
    expect(footer.className).not.toContain('text-[11px]');
  });

  it('navigates from a footer link', () => {
    const { onNavigate } = renderShell();
    const footer = screen.getByRole('contentinfo');
    within(footer).getByRole('button', { name: 'Competitions' }).click();
    expect(onNavigate).toHaveBeenCalledWith('competitions');
  });
});

describe('AppLayout – structure and main region', () => {
  it('renders header, then main, then footer in document order', () => {
    const { container } = renderShell();
    const order = Array.from(container.querySelectorAll('header, main, footer')).map((el) => el.tagName);
    expect(order).toEqual(['HEADER', 'MAIN', 'FOOTER']);
  });

  it('keeps the mobile bottom navigation mounted for small screens', () => {
    renderShell();
    const bar = screen.getByTestId('mobile-bottom-nav');
    expect(bar.className).toContain('md:hidden');
    expect(bar.className).toContain('fixed');
    expect(bar.querySelector('.grid-cols-4')).toBeTruthy();
  });

  it('renders children inside the main content column using the shell width token', () => {
    renderShell();
    expect(screen.getByText('view content')).toBeTruthy();
    const main = screen.getByRole('main');
    expect(within(main).getByText('view content')).toBeTruthy();
    expect(main.querySelector('.max-w-shell')).toBeTruthy();
  });
});

describe('Container – token-driven gutters', () => {
  it('applies the shell max width and responsive gutter tokens', () => {
    const { container } = render(
      <Container>
        <span>inside</span>
      </Container>
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('max-w-shell');
    expect(el.className).toContain('px-gutter');
    expect(el.className).toContain('sm:px-gutter-sm');
    expect(el.className).toContain('lg:px-gutter-lg');
    expect(el.className).not.toContain('px-4');
  });
});

describe('design tokens', () => {
  it('exposes typography families and a monotonic type scale', () => {
    expect(fontFamilies.sans).toContain('Plus Jakarta Sans');
    expect(fontFamilies.mono).toContain('JetBrains Mono');
    const sizes = ['2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl'] as const;
    const nums = sizes.map((s) => parseFloat(fontSizes[s]));
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBeGreaterThan(nums[i - 1]);
  });

  it('exposes the semantic layout spacing used by the shell', () => {
    expect(layoutSpacing.header).toBe('4rem');
    expect(layoutSpacing.gutter).toBe('1rem');
    expect(layoutSpacing['gutter-sm']).toBe('1.5rem');
    expect(layoutSpacing['gutter-lg']).toBe('2rem');
    expect(layoutSpacing['section-xl']).toBe('5rem');
    expect(containerWidths.shell).toBe('80rem');
  });

  it('keeps the token groups in the exported designTokens object', () => {
    expect(designTokens.typography.fontSizes.base).toBe('1rem');
    expect(designTokens.spacing.containerWidths.shell).toBe('80rem');
  });

  it('encodes the active-view rule for nav items', () => {
    expect(isNavActive('fixtures', 'match')).toBe(true);
    expect(isNavActive('fixtures', 'fixtures')).toBe(true);
    expect(isNavActive('home', 'fixtures')).toBe(false);
    expect(isNavActive('standings', 'standings')).toBe(true);
  });
});
