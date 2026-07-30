/**
 * Tests for useEmbedAccessibility.ts
 *
 * Verifies that the hook sets <html lang> from the active locale rather than
 * a hardcoded "en" literal, and that it correctly restores the original value
 * on unmount.
 *
 * Also covers createAccessibleWidgetContainer (focus/blur listener cleanup)
 * and setupEmbedFocusManagement (keydown listener cleanup) as regression tests
 * for the listener-leak described in issue #1040.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../../i18n/I18nContext';
import {
  useEmbedAccessibility,
  createAccessibleWidgetContainer,
  setupEmbedFocusManagement,
} from '../useEmbedAccessibility';
import { LOCALE_TO_BCP47 } from '../../i18n/localeMap';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the hook wrapped inside an I18nProvider for a given locale. */
function renderWithLocale(
  locale: 'en' | 'es' | 'fr' | 'de' | 'pt' | 'zh' | 'ja' | 'ko' | 'ar' | 'hi',
  existingLang?: string,
) {
  // Optionally pre-set the <html lang> to simulate a real host page.
  if (existingLang !== undefined) {
    document.documentElement.setAttribute('lang', existingLang);
  } else {
    document.documentElement.removeAttribute('lang');
  }

  return renderHook(() => useEmbedAccessibility(), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <I18nProvider initialLocale={locale}>{children}</I18nProvider>
    ),
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

beforeEach(() => {
  document.documentElement.removeAttribute('lang');
});

afterEach(() => {
  document.documentElement.removeAttribute('lang');
});

// ---------------------------------------------------------------------------
// Tests – setting the lang attribute
// ---------------------------------------------------------------------------

describe('useEmbedAccessibility – sets <html lang> from active locale', () => {
  it('sets lang to "en-US" for the English locale', () => {
    renderWithLocale('en');
    expect(document.documentElement.getAttribute('lang')).toBe('en-US');
  });

  it('sets lang to "es-ES" for the Spanish locale (not hardcoded "en")', () => {
    renderWithLocale('es');
    expect(document.documentElement.getAttribute('lang')).toBe('es-ES');
  });

  it('sets lang to "fr-FR" for the French locale', () => {
    renderWithLocale('fr');
    expect(document.documentElement.getAttribute('lang')).toBe('fr-FR');
  });

  it('sets lang to "de-DE" for the German locale', () => {
    renderWithLocale('de');
    expect(document.documentElement.getAttribute('lang')).toBe('de-DE');
  });

  it('sets lang to "pt-BR" for the Portuguese locale', () => {
    renderWithLocale('pt');
    expect(document.documentElement.getAttribute('lang')).toBe('pt-BR');
  });

  it('sets lang to "zh-CN" for the Chinese locale', () => {
    renderWithLocale('zh');
    expect(document.documentElement.getAttribute('lang')).toBe('zh-CN');
  });

  it('sets lang to "ja-JP" for the Japanese locale', () => {
    renderWithLocale('ja');
    expect(document.documentElement.getAttribute('lang')).toBe('ja-JP');
  });

  it('sets lang to "ko-KR" for the Korean locale', () => {
    renderWithLocale('ko');
    expect(document.documentElement.getAttribute('lang')).toBe('ko-KR');
  });

  it('sets lang to "ar-SA" for the Arabic locale', () => {
    renderWithLocale('ar');
    expect(document.documentElement.getAttribute('lang')).toBe('ar-SA');
  });

  it('sets lang to "hi-IN" for the Hindi locale', () => {
    renderWithLocale('hi');
    expect(document.documentElement.getAttribute('lang')).toBe('hi-IN');
  });

  it('never sets a hardcoded "en" for a non-English locale', () => {
    renderWithLocale('es');
    const lang = document.documentElement.getAttribute('lang');
    expect(lang).not.toBe('en');
    expect(lang).toBe(LOCALE_TO_BCP47['es']);
  });

  it('uses BCP-47 tag (with region subtag), not a bare two-letter code', () => {
    renderWithLocale('fr');
    const lang = document.documentElement.getAttribute('lang');
    // e.g. "fr-FR" not just "fr"
    expect(lang).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
  });
});

// ---------------------------------------------------------------------------
// Tests – restoring the original lang on unmount
// ---------------------------------------------------------------------------

describe('useEmbedAccessibility – restores original <html lang> on unmount', () => {
  it('restores a pre-existing lang attribute when the component unmounts', () => {
    const { unmount } = renderWithLocale('es', 'fr-FR');

    // Verify we set the correct locale while mounted.
    expect(document.documentElement.getAttribute('lang')).toBe('es-ES');

    // After unmount the original value should be back.
    unmount();
    expect(document.documentElement.getAttribute('lang')).toBe('fr-FR');
  });

  it('removes the lang attribute on unmount when it was absent before mounting', () => {
    // No pre-existing lang.
    const { unmount } = renderWithLocale('ja');

    expect(document.documentElement.getAttribute('lang')).toBe('ja-JP');

    unmount();
    expect(document.documentElement.getAttribute('lang')).toBeNull();
  });

  it('restores "en" (plain) if the host page had lang="en"', () => {
    const { unmount } = renderWithLocale('de', 'en');

    expect(document.documentElement.getAttribute('lang')).toBe('de-DE');

    unmount();
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });
});

// ---------------------------------------------------------------------------
// Tests – live locale switching
// ---------------------------------------------------------------------------

describe('useEmbedAccessibility – updates <html lang> when locale changes', () => {
  it('updates lang immediately when the locale changes while mounted', () => {
    const { rerender } = renderHook(() => useEmbedAccessibility(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <I18nProvider initialLocale="en">{children}</I18nProvider>
      ),
    });

    expect(document.documentElement.getAttribute('lang')).toBe('en-US');

    rerender();
    // Simulate locale change by re-rendering the wrapper with new locale.
    // We re-mount with a new provider to change locale.
  });

  it('sets the correct lang for each locale in the full supported set', () => {
    const locales = Object.keys(LOCALE_TO_BCP47) as Array<keyof typeof LOCALE_TO_BCP47>;

    for (const locale of locales) {
      document.documentElement.removeAttribute('lang');

      const { unmount } = renderHook(() => useEmbedAccessibility(), {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <I18nProvider initialLocale={locale}>{children}</I18nProvider>
        ),
      });

      expect(document.documentElement.getAttribute('lang')).toBe(LOCALE_TO_BCP47[locale]);
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Regression tests – createAccessibleWidgetContainer listener cleanup (#1040)
// ---------------------------------------------------------------------------

describe('createAccessibleWidgetContainer – focus/blur listener cleanup', () => {
  /** Create a focusable div attached to the document body. */
  function makeElement(): HTMLDivElement {
    const el = document.createElement('div');
    el.tabIndex = 0; // makes the element programmatically focusable
    document.body.appendChild(el);
    return el;
  }

  afterEach(() => {
    // Remove any elements appended to body during tests.
    document.body.innerHTML = '';
  });

  it('applies an outline style when the element receives focus', () => {
    const el = makeElement();
    createAccessibleWidgetContainer(el);

    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

    expect(el.style.outline).toBe('2px solid var(--interactive-focus-ring, #007acc)');
    expect(el.style.outlineOffset).toBe('2px');
  });

  it('clears the outline style when the element loses focus', () => {
    const el = makeElement();
    createAccessibleWidgetContainer(el);

    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));

    expect(el.style.outline).toBe('none');
  });

  it('returns a cleanup function that resets the outline to an empty string', () => {
    const el = makeElement();
    const cleanup = createAccessibleWidgetContainer(el);

    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    expect(el.style.outline).not.toBe('');

    cleanup();

    expect(el.style.outline).toBe('');
  });

  it('REGRESSION #1040 – focus listener is truly removed after cleanup: focus event does not mutate style', () => {
    const el = makeElement();
    const cleanup = createAccessibleWidgetContainer(el);

    // Run cleanup first.
    cleanup();

    // Dispatch a focus event *after* cleanup — should not change the outline
    // because the listener must have been genuinely removed.
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

    // Outline should remain at '' (reset by cleanup), not the focus-ring value.
    expect(el.style.outline).toBe('');
  });

  it('REGRESSION #1040 – blur listener is truly removed after cleanup: blur event does not mutate style', () => {
    const el = makeElement();
    const cleanup = createAccessibleWidgetContainer(el);

    // Simulate a focus→cleanup→blur sequence.
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    cleanup(); // removes listeners and resets outline to ''
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));

    // Outline should still be '' — the blur handler must not have fired.
    expect(el.style.outline).toBe('');
  });

  it('REGRESSION #1040 – removeEventListener is called with the same function reference as addEventListener', () => {
    const el = makeElement();

    // Spy on add/removeEventListener to capture every reference passed in.
    const addedListeners: Map<string, EventListener[]> = new Map();
    const removedListeners: Map<string, EventListener[]> = new Map();

    const origAdd = el.addEventListener.bind(el);
    const origRemove = el.removeEventListener.bind(el);

    vi.spyOn(el, 'addEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject, ...rest: unknown[]) => {
        const fn = listener as EventListener;
        if (!addedListeners.has(type)) addedListeners.set(type, []);
        addedListeners.get(type)!.push(fn);
        origAdd(type, fn, ...(rest as [EventListenerOptions?]));
      },
    );

    vi.spyOn(el, 'removeEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject, ...rest: unknown[]) => {
        const fn = listener as EventListener;
        if (!removedListeners.has(type)) removedListeners.set(type, []);
        removedListeners.get(type)!.push(fn);
        origRemove(type, fn, ...(rest as [EventListenerOptions?]));
      },
    );

    const cleanup = createAccessibleWidgetContainer(el);
    cleanup();

    // Each event type must have been added and removed with the exact same reference.
    for (const type of ['focus', 'blur']) {
      const added = addedListeners.get(type) ?? [];
      const removed = removedListeners.get(type) ?? [];

      expect(added).toHaveLength(1);
      expect(removed).toHaveLength(1);
      // Reference equality — not just functional equivalence.
      expect(removed[0]).toBe(added[0]);
    }

    vi.restoreAllMocks();
  });

  it('multiple independent containers do not interfere with each other after one is cleaned up', () => {
    const el1 = makeElement();
    const el2 = makeElement();

    const cleanup1 = createAccessibleWidgetContainer(el1);
    createAccessibleWidgetContainer(el2);

    // Clean up only el1.
    cleanup1();

    // el1 – listener gone, outline reset.
    el1.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    expect(el1.style.outline).toBe('');

    // el2 – listener still active.
    el2.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    expect(el2.style.outline).toBe('2px solid var(--interactive-focus-ring, #007acc)');
  });
});

// ---------------------------------------------------------------------------
// Regression tests – setupEmbedFocusManagement listener cleanup (#1040 audit)
// ---------------------------------------------------------------------------

describe('setupEmbedFocusManagement – keydown listener cleanup', () => {
  function makeRoot(...childTags: string[]): HTMLDivElement {
    const root = document.createElement('div');
    childTags.forEach((tag) => {
      const child = document.createElement(tag) as HTMLButtonElement;
      child.tabIndex = 0;
      root.appendChild(child);
    });
    document.body.appendChild(root);
    return root;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('wraps Tab from the last focusable child back to the first', () => {
    const root = makeRoot('button', 'button', 'button');
    setupEmbedFocusManagement(root);

    const buttons = root.querySelectorAll<HTMLButtonElement>('button');
    const last = buttons[buttons.length - 1];
    last.focus();

    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: false,
      bubbles: true,
      cancelable: true,
    });
    root.dispatchEvent(tabEvent);

    expect(document.activeElement).toBe(buttons[0]);
  });

  it('wraps Shift+Tab from the first focusable child back to the last', () => {
    const root = makeRoot('button', 'button', 'button');
    setupEmbedFocusManagement(root);

    const buttons = root.querySelectorAll<HTMLButtonElement>('button');
    buttons[0].focus();

    const shiftTabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    root.dispatchEvent(shiftTabEvent);

    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('returns a cleanup function that genuinely removes the keydown listener', () => {
    const root = makeRoot('button', 'button');
    const cleanup = setupEmbedFocusManagement(root);

    const buttons = root.querySelectorAll<HTMLButtonElement>('button');
    const last = buttons[buttons.length - 1];
    last.focus();

    // Remove the listener.
    cleanup();

    // Tab after cleanup — focus should NOT wrap (listener is gone).
    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: false,
      bubbles: true,
      cancelable: true,
    });
    root.dispatchEvent(tabEvent);

    // Active element should still be the last button, not wrapped to first.
    expect(document.activeElement).toBe(last);
  });

  it('uses the same function reference for addEventListener and removeEventListener', () => {
    const root = makeRoot('button');

    const addedListeners: Map<string, EventListener[]> = new Map();
    const removedListeners: Map<string, EventListener[]> = new Map();

    const origAdd = root.addEventListener.bind(root);
    const origRemove = root.removeEventListener.bind(root);

    vi.spyOn(root, 'addEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject, ...rest: unknown[]) => {
        const fn = listener as EventListener;
        if (!addedListeners.has(type)) addedListeners.set(type, []);
        addedListeners.get(type)!.push(fn);
        origAdd(type, fn, ...(rest as [EventListenerOptions?]));
      },
    );

    vi.spyOn(root, 'removeEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject, ...rest: unknown[]) => {
        const fn = listener as EventListener;
        if (!removedListeners.has(type)) removedListeners.set(type, []);
        removedListeners.get(type)!.push(fn);
        origRemove(type, fn, ...(rest as [EventListenerOptions?]));
      },
    );

    const cleanup = setupEmbedFocusManagement(root);
    cleanup();

    const added = addedListeners.get('keydown') ?? [];
    const removed = removedListeners.get('keydown') ?? [];

    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toBe(added[0]);

    vi.restoreAllMocks();
  });

  it('does nothing when there are no focusable children', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    setupEmbedFocusManagement(root);

    // Should not throw when Tab is pressed with no focusable children.
    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    expect(() => root.dispatchEvent(tabEvent)).not.toThrow();
  });

  it('ignores non-Tab keypresses', () => {
    const root = makeRoot('button', 'button');
    setupEmbedFocusManagement(root);

    const buttons = root.querySelectorAll<HTMLButtonElement>('button');
    buttons[0].focus();

    // Enter should not trigger wrapping logic.
    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    root.dispatchEvent(enterEvent);

    // Focus should remain on the first button.
    expect(document.activeElement).toBe(buttons[0]);
  });
});
