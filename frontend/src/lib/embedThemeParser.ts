/**
 * src/lib/embedThemeParser.ts
 *
 * Parses and applies embed query-string theme configuration to
 * `document.documentElement`, and provides a cleanup function that restores
 * the exact values that were present before the override.
 *
 * The key invariant here is **restore-not-wipe**: cleanup must put back
 * whatever was on the element before the effect ran, not unconditionally
 * clear the properties.  This matters because a host page's ThemeProvider (or
 * a previous run of the same effect during re-renders) may have already set
 * `data-theme` / `--color-accent-primary` / `--interactive-focus-ring`, and
 * removing those values would break the host's own theming.
 *
 * @module embedThemeParser
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Theme configuration derived from the embed widget's URL query string.
 *
 * All fields are optional; the component applies only the properties that are
 * actually present.
 */
export interface EmbedThemeConfig {
  /** The name of the design-system theme, used as `data-theme` attribute value. */
  theme?: string;
  /** A CSS colour value (hex, rgb, named…) applied as the accent custom property. */
  accentColor?: string;
}

/**
 * A zero-argument cleanup function returned by {@link applyThemeConfigSafely}.
 * Calling it restores the original CSS state that existed before the helper ran.
 */
export type ThemeCleanup = () => void;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Applies `themeConfig` to `document.documentElement` and returns a cleanup
 * function that restores the prior values when called.
 *
 * ### What it does
 * - If `themeConfig.theme` is provided, sets `html[data-theme]`.
 * - If `themeConfig.accentColor` is provided, sets `--color-accent-primary`
 *   and `--interactive-focus-ring` as inline custom properties.
 *
 * ### What cleanup does
 * Before touching the element the helper captures:
 * - The original `data-theme` attribute value (or `null` if absent).
 * - The original `--color-accent-primary` / `--interactive-focus-ring`
 *   inline custom-property values (empty string if not set inline).
 *
 * On cleanup it restores those exact values:
 * - Puts the original `data-theme` back if it was set, or removes it if it
 *   was absent.
 * - Restores the original inline custom-property values; if a property was
 *   not set inline before, it removes the inline override entirely.
 *
 * @example
 * ```tsx
 * useEffect(() => {
 *   const cleanup = applyThemeConfigSafely(themeConfig);
 *   return cleanup;
 * }, [themeConfig]);
 * ```
 */
export function applyThemeConfigSafely(
  themeConfig: EmbedThemeConfig,
): ThemeCleanup {
  const html = document.documentElement;

  // --- Capture originals before mutating -----------------------------------

  // `getAttribute` returns null when the attribute is absent (we need to
  // distinguish "absent" from "set to empty string").
  const originalTheme: string | null = html.getAttribute('data-theme');

  // `getPropertyValue` returns an empty string when the property is not set
  // inline (and also when it is set to empty string, but that's fine —
  // restoring an empty string is equivalent to removing it for custom props).
  const originalAccentColor: string = html.style.getPropertyValue(
    '--color-accent-primary',
  );
  const originalFocusRing: string = html.style.getPropertyValue(
    '--interactive-focus-ring',
  );

  // --- Apply overrides ------------------------------------------------------

  if (themeConfig.theme) {
    html.setAttribute('data-theme', themeConfig.theme);
  }

  if (themeConfig.accentColor) {
    html.style.setProperty('--color-accent-primary', themeConfig.accentColor);
    html.style.setProperty('--interactive-focus-ring', themeConfig.accentColor);
  }

  // --- Return cleanup -------------------------------------------------------

  return () => {
    // Restore data-theme: re-set if it existed, remove if it was absent.
    if (originalTheme !== null) {
      html.setAttribute('data-theme', originalTheme);
    } else {
      html.removeAttribute('data-theme');
    }

    // Restore custom properties: re-set if they had an inline value, remove
    // the inline declaration if they were not set inline before.
    if (originalAccentColor !== '') {
      html.style.setProperty('--color-accent-primary', originalAccentColor);
    } else {
      html.style.removeProperty('--color-accent-primary');
    }

    if (originalFocusRing !== '') {
      html.style.setProperty('--interactive-focus-ring', originalFocusRing);
    } else {
      html.style.removeProperty('--interactive-focus-ring');
    }
  };
}
