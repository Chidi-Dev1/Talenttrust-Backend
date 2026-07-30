/**
 * src/pages/EmbedStreamWidget.tsx
 *
 * Embed entry-point that reads theme overrides from the URL query string and
 * applies them to `document.documentElement` while the widget is mounted.
 *
 * Theme application is delegated entirely to {@link applyThemeConfigSafely}
 * from `src/lib/embedThemeParser.ts`.  That helper captures the original
 * attribute/property values *before* applying overrides, then restores those
 * exact originals when cleanup runs — whether the component unmounts or
 * `themeConfig` changes across re-renders.  This is the correct
 * "restore-not-wipe" semantics required for embedded contexts where a host
 * page or wrapping ThemeProvider may have already set these values.
 *
 * @module EmbedStreamWidget
 */
import React, { useEffect, useMemo } from 'react';
import {
  applyThemeConfigSafely,
  type EmbedThemeConfig,
} from '../lib/embedThemeParser';

// ---------------------------------------------------------------------------
// Query-string parser
// ---------------------------------------------------------------------------

/**
 * Parses an embed widget query string and extracts theme-related parameters.
 *
 * Recognised parameters:
 * - `theme` — maps to `EmbedThemeConfig.theme`
 * - `accentColor` — maps to `EmbedThemeConfig.accentColor`
 *
 * Unknown parameters are silently ignored.
 *
 * @param search - The raw `window.location.search` string (e.g. `"?theme=dark&accentColor=%23ff0000"`).
 */
export function parseEmbedThemeConfig(search: string): EmbedThemeConfig {
  const params = new URLSearchParams(search);
  const config: EmbedThemeConfig = {};

  const theme = params.get('theme');
  if (theme) config.theme = theme;

  const accentColor = params.get('accentColor');
  if (accentColor) config.accentColor = accentColor;

  return config;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Props for {@link EmbedStreamWidget}.
 */
export interface EmbedStreamWidgetProps {
  /**
   * The raw URL query string to parse for theme configuration.
   * Defaults to `window.location.search` when not provided — this default is
   * primarily used in production; tests inject their own value for isolation.
   */
  queryString?: string;
  /** The main content of the embedded widget. */
  children?: React.ReactNode;
}

/**
 * Top-level embed stream widget component.
 *
 * Reads `theme` and `accentColor` from the query string and applies them to
 * `document.documentElement` using {@link applyThemeConfigSafely}.  On
 * unmount — or whenever `queryString` changes triggering a re-render — the
 * helper's cleanup function restores the original attribute/property values
 * rather than unconditionally clearing them.
 *
 * @example
 * ```tsx
 * // Production entry point
 * ReactDOM.createRoot(document.getElementById('root')!).render(
 *   <EmbedStreamWidget>
 *     <StreamPlayer />
 *   </EmbedStreamWidget>,
 * );
 * ```
 */
export function EmbedStreamWidget({
  queryString = typeof window !== 'undefined' ? window.location.search : '',
  children,
}: EmbedStreamWidgetProps) {
  // Parse the query string into a stable config object.  Memoising on the raw
  // string means we only re-parse (and re-run the theme effect) when the
  // query string actually changes.
  const themeConfig = useMemo(
    () => parseEmbedThemeConfig(queryString),
    [queryString],
  );

  useEffect(() => {
    // applyThemeConfigSafely captures the current html attribute/property
    // values, applies the overrides, then returns a cleanup that restores the
    // captured originals.  This is the single source of theme-application
    // logic; no inline apply/cleanup code lives here.
    const cleanup = applyThemeConfigSafely(themeConfig);
    return cleanup;
  }, [themeConfig]);

  return <>{children}</>;
}

export default EmbedStreamWidget;
