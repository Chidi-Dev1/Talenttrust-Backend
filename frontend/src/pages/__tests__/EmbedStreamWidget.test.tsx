/**
 * Tests for EmbedStreamWidget.tsx
 *
 * Regression coverage for #1045: EmbedStreamWidget must use
 * applyThemeConfigSafely (restore-not-wipe semantics) instead of its own
 * inline theme apply/cleanup logic.
 *
 * Key scenario: if `data-theme` or `--color-accent-primary` is already set on
 * `document.documentElement` when the widget mounts, those original values
 * must be restored on unmount — not unconditionally cleared.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { EmbedStreamWidget, parseEmbedThemeConfig } from '../EmbedStreamWidget';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHtmlTheme(): string | null {
  return document.documentElement.getAttribute('data-theme');
}

function getInlineProp(prop: string): string {
  return document.documentElement.style.getPropertyValue(prop);
}

// ---------------------------------------------------------------------------
// Cleanup between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('--color-accent-primary');
  document.documentElement.style.removeProperty('--interactive-focus-ring');
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('--color-accent-primary');
  document.documentElement.style.removeProperty('--interactive-focus-ring');
});

// ---------------------------------------------------------------------------
// parseEmbedThemeConfig unit tests
// ---------------------------------------------------------------------------

describe('parseEmbedThemeConfig', () => {
  it('parses a theme value', () => {
    expect(parseEmbedThemeConfig('?theme=dark')).toEqual({ theme: 'dark' });
  });

  it('parses an accentColor value', () => {
    expect(parseEmbedThemeConfig('?accentColor=%23ff0000')).toEqual({
      accentColor: '#ff0000',
    });
  });

  it('parses both theme and accentColor together', () => {
    expect(
      parseEmbedThemeConfig('?theme=dark&accentColor=%230070f3'),
    ).toEqual({ theme: 'dark', accentColor: '#0070f3' });
  });

  it('returns an empty config when no known params are present', () => {
    expect(parseEmbedThemeConfig('')).toEqual({});
    expect(parseEmbedThemeConfig('?foo=bar')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Mount behaviour: widget applies theme config from query string
// ---------------------------------------------------------------------------

describe('EmbedStreamWidget – applies theme on mount', () => {
  it('sets data-theme on <html> when theme is provided', () => {
    render(<EmbedStreamWidget queryString="?theme=dark" />);
    expect(getHtmlTheme()).toBe('dark');
  });

  it('sets --color-accent-primary when accentColor is provided', () => {
    render(<EmbedStreamWidget queryString="?accentColor=%230070f3" />);
    expect(getInlineProp('--color-accent-primary')).toBe('#0070f3');
  });

  it('sets --interactive-focus-ring to the same accentColor', () => {
    render(<EmbedStreamWidget queryString="?accentColor=%230070f3" />);
    expect(getInlineProp('--interactive-focus-ring')).toBe('#0070f3');
  });

  it('sets both data-theme and accent props together', () => {
    render(
      <EmbedStreamWidget queryString="?theme=high-contrast&accentColor=%23ff0000" />,
    );
    expect(getHtmlTheme()).toBe('high-contrast');
    expect(getInlineProp('--color-accent-primary')).toBe('#ff0000');
    expect(getInlineProp('--interactive-focus-ring')).toBe('#ff0000');
  });

  it('does not set data-theme when theme is absent from query', () => {
    render(<EmbedStreamWidget queryString="" />);
    expect(getHtmlTheme()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regression #1045: restore-not-wipe semantics on unmount
// ---------------------------------------------------------------------------

describe('EmbedStreamWidget – restore-not-wipe on unmount (#1045)', () => {
  it('restores a pre-existing data-theme attribute on unmount', () => {
    // Simulate a host ThemeProvider that has already set a data-theme.
    document.documentElement.setAttribute('data-theme', 'light');

    const { unmount } = render(
      <EmbedStreamWidget queryString="?theme=dark" />,
    );

    // Widget overrides the theme while mounted.
    expect(getHtmlTheme()).toBe('dark');

    // After unmount, the original host value must be restored — not removed.
    unmount();
    expect(getHtmlTheme()).toBe('light');
  });

  it('removes data-theme on unmount when it was absent before mounting', () => {
    // No pre-existing theme.
    const { unmount } = render(
      <EmbedStreamWidget queryString="?theme=dark" />,
    );

    expect(getHtmlTheme()).toBe('dark');

    unmount();
    // Must be gone — not left as 'dark' or set to an empty string.
    expect(getHtmlTheme()).toBeNull();
  });

  it('restores pre-existing --color-accent-primary on unmount', () => {
    // Host page already had an accent color set.
    document.documentElement.style.setProperty(
      '--color-accent-primary',
      '#aabbcc',
    );

    const { unmount } = render(
      <EmbedStreamWidget queryString="?accentColor=%23ff0000" />,
    );

    expect(getInlineProp('--color-accent-primary')).toBe('#ff0000');

    unmount();
    expect(getInlineProp('--color-accent-primary')).toBe('#aabbcc');
  });

  it('removes --color-accent-primary on unmount when it was absent before mounting', () => {
    // No pre-existing accent.
    const { unmount } = render(
      <EmbedStreamWidget queryString="?accentColor=%23ff0000" />,
    );

    expect(getInlineProp('--color-accent-primary')).toBe('#ff0000');

    unmount();
    expect(getInlineProp('--color-accent-primary')).toBe('');
  });

  it('restores pre-existing --interactive-focus-ring on unmount', () => {
    document.documentElement.style.setProperty(
      '--interactive-focus-ring',
      '#112233',
    );

    const { unmount } = render(
      <EmbedStreamWidget queryString="?accentColor=%23ff0000" />,
    );

    expect(getInlineProp('--interactive-focus-ring')).toBe('#ff0000');

    unmount();
    expect(getInlineProp('--interactive-focus-ring')).toBe('#112233');
  });

  it('removes --interactive-focus-ring on unmount when it was absent before mounting', () => {
    const { unmount } = render(
      <EmbedStreamWidget queryString="?accentColor=%23ff0000" />,
    );

    unmount();
    expect(getInlineProp('--interactive-focus-ring')).toBe('');
  });

  it('restores all three values simultaneously when all were pre-existing', () => {
    document.documentElement.setAttribute('data-theme', 'system');
    document.documentElement.style.setProperty(
      '--color-accent-primary',
      '#aaaaaa',
    );
    document.documentElement.style.setProperty(
      '--interactive-focus-ring',
      '#bbbbbb',
    );

    const { unmount } = render(
      <EmbedStreamWidget queryString="?theme=dark&accentColor=%23ff0000" />,
    );

    // Widget overrides while mounted.
    expect(getHtmlTheme()).toBe('dark');
    expect(getInlineProp('--color-accent-primary')).toBe('#ff0000');
    expect(getInlineProp('--interactive-focus-ring')).toBe('#ff0000');

    // Unmount: all originals must be restored.
    unmount();
    expect(getHtmlTheme()).toBe('system');
    expect(getInlineProp('--color-accent-primary')).toBe('#aaaaaa');
    expect(getInlineProp('--interactive-focus-ring')).toBe('#bbbbbb');
  });

  it('does not wipe data-theme when the widget did not set it (no theme in query)', () => {
    document.documentElement.setAttribute('data-theme', 'light');

    // Only an accentColor in the query — no theme.
    const { unmount } = render(
      <EmbedStreamWidget queryString="?accentColor=%23ff0000" />,
    );

    // data-theme should still be "light" (widget didn't touch it).
    expect(getHtmlTheme()).toBe('light');

    unmount();
    // Must still be 'light' — the widget should not wipe a value it didn't set.
    expect(getHtmlTheme()).toBe('light');
  });
});

// ---------------------------------------------------------------------------
// Re-render: themeConfig change restores-then-reapplies
// ---------------------------------------------------------------------------

describe('EmbedStreamWidget – effect re-runs correctly on queryString change', () => {
  it('updates data-theme when queryString changes', () => {
    const { rerender } = render(
      <EmbedStreamWidget queryString="?theme=dark" />,
    );
    expect(getHtmlTheme()).toBe('dark');

    rerender(<EmbedStreamWidget queryString="?theme=high-contrast" />);
    expect(getHtmlTheme()).toBe('high-contrast');
  });

  it('clears data-theme when theme is removed from the new queryString', () => {
    const { rerender } = render(
      <EmbedStreamWidget queryString="?theme=dark" />,
    );
    expect(getHtmlTheme()).toBe('dark');

    // Re-render with no theme param.
    rerender(<EmbedStreamWidget queryString="" />);
    expect(getHtmlTheme()).toBeNull();
  });

  it('renders children without interference', () => {
    const { getByText } = render(
      <EmbedStreamWidget queryString="?theme=dark">
        <span>stream content</span>
      </EmbedStreamWidget>,
    );
    expect(getByText('stream content')).toBeInTheDocument();
  });
});
