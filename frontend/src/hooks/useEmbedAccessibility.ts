/**
 * src/hooks/useEmbedAccessibility.ts
 *
 * Sets accessibility attributes on the host page's <html> element while an
 * embed widget is mounted, then restores all original values on unmount.
 *
 * The `lang` attribute is derived from the app's active i18n locale so that
 * assistive technologies pronounce content in the correct language, rather
 * than always falling back to a hardcoded "en" literal.
 *
 * Usage
 * -----
 * Call this hook at the top level of the embed widget component.  The hook
 * reads the active locale from `useI18n()`, so the component must be
 * rendered inside an `<I18nProvider>`.
 *
 * @example
 * ```tsx
 * function EmbedWidget() {
 *   useEmbedAccessibility();
 *   return <div>…</div>;
 * }
 * ```
 */
import { useEffect } from 'react';
import { useI18n } from '../i18n/I18nContext';
import { getBcp47Tag } from '../i18n/localeMap';

/**
 * Applies and restores `<html lang>` (and `dir` when appropriate) based on
 * the active i18n locale while the calling component is mounted.
 *
 * - Sets `html[lang]` to the BCP-47 tag for the active locale (e.g. "es-ES").
 * - Restores the original `lang` value (or removes the attribute entirely if
 *   it was absent) when the component unmounts.
 * - Re-runs whenever the active locale changes so live locale switching is
 *   reflected immediately.
 */
export function useEmbedAccessibility(): void {
  const { locale } = useI18n();

  useEffect(() => {
    const html = document.documentElement;

    // Capture original value before we mutate anything.
    const originalLang = html.getAttribute('lang');

    // Derive the correct BCP-47 tag from the active locale.
    const activeBcp47 = getBcp47Tag(locale);
    html.setAttribute('lang', activeBcp47);

    return () => {
      // Restore the original state precisely:
      // • If the attribute existed before, put it back.
      // • If it was absent, remove it entirely (don't leave a stale value).
      if (originalLang !== null) {
        html.setAttribute('lang', originalLang);
      } else {
        html.removeAttribute('lang');
      }
    };
  }, [locale]);
}

// ---------------------------------------------------------------------------
// createAccessibleWidgetContainer
// ---------------------------------------------------------------------------

/**
 * Sets up focus-ring styling on a widget container element and returns a
 * cleanup function that genuinely removes those listeners.
 *
 * The focus/blur handlers are hoisted into named local variables so that the
 * exact same function references are passed to both `addEventListener` and
 * `removeEventListener`.  Passing brand-new inline arrow functions to
 * `removeEventListener` is a silent no-op because the browser compares
 * references, not function bodies.
 *
 * @param element - The DOM element to enhance with accessible focus styling.
 * @returns A cleanup function; call it to remove the listeners and reset the
 *          element's outline style.
 *
 * @example
 * ```ts
 * const cleanup = createAccessibleWidgetContainer(containerDiv);
 * // … widget teardown …
 * cleanup();
 * ```
 */
export function createAccessibleWidgetContainer(element: HTMLElement): () => void {
  // Hoist handlers into named variables so the same references can be passed
  // to both addEventListener and removeEventListener (fixes listener leak).
  const handleFocus = (): void => {
    element.style.outline = '2px solid var(--interactive-focus-ring, #007acc)';
    element.style.outlineOffset = '2px';
  };

  const handleBlur = (): void => {
    element.style.outline = 'none';
  };

  element.addEventListener('focus', handleFocus);
  element.addEventListener('blur', handleBlur);

  return () => {
    // Pass the exact same references used in addEventListener so the browser
    // actually deregisters the original listeners.
    element.removeEventListener('focus', handleFocus);
    element.removeEventListener('blur', handleBlur);
    element.style.outline = '';
  };
}

// ---------------------------------------------------------------------------
// setupEmbedFocusManagement
// ---------------------------------------------------------------------------

/**
 * Installs keyboard focus-management behaviour on a root embed container.
 *
 * Listens for `keydown` events so that keyboard users can navigate between
 * focusable children using Tab/Shift-Tab without the focus escaping the widget
 * boundary (focus trap pattern).
 *
 * The `handleKeyDown` listener is stored in a named variable and reused for
 * both `addEventListener` and `removeEventListener` — the correct pattern that
 * avoids the listener-leak described in issue #1040.
 *
 * @param root - The container element that acts as the focus-trap boundary.
 * @returns A cleanup function; call it to deregister the keydown listener.
 */
export function setupEmbedFocusManagement(root: HTMLElement): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );

    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey) {
      // Shift+Tab: wrap from first → last.
      if (active === first) {
        event.preventDefault();
        last.focus();
      }
    } else {
      // Tab: wrap from last → first.
      if (active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  root.addEventListener('keydown', handleKeyDown);

  return () => {
    // Same reference — listener is actually deregistered.
    root.removeEventListener('keydown', handleKeyDown);
  };
}
