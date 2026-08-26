/**
 * Settings-nav icon adaptation, entirely plugin-side (no harness change): the
 * DSH settings shell projects only `id`/`order`/`label` from a
 * `settings.section` registration and picks the nav glyph from a closed list
 * of built-in ids — every external section draws the generic gear. This module
 * marks only this plugin's own localized nav row after the settings dialog
 * mounts, and the bundled CSS below paints a stacked-database glyph over the
 * shell gear as a `currentColor` mask, so it follows the native hover/active
 * colors without changing the shell's 16px icon rhythm. The marker owns no
 * shell structure and is removed on disposal, keeping the adaptation HMR-safe.
 *
 * The glyph is deliberately distinct from the Models section's filled
 * single-cylinder icon: a stroke-outline three-tier database stack.
 */

/** Marker attribute applied to this plugin's settings-nav row. */
export const SETTINGS_NAV_MARKER = 'data-dsh-data-tools-settings-nav'

/** The stacked-database glyph as a stroke mask (16×16, matches the shell's icon rhythm). */
const DATABASE_STACK_MASK = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cellipse cx='8' cy='3.5' rx='6' ry='2'/%3E%3Cpath d='M2 3.5V12.5A6 2 0 0 0 14 12.5V3.5'/%3E%3Cpath d='M2 8A6 2 0 0 0 14 8'/%3E%3C/svg%3E\") center / contain no-repeat"

/**
 * CSS replacing the shell's fallback gear with the stacked-database glyph.
 */
export const NAV_ICON_CSS = `/* dsh-data-tools: settings-nav glyph */
[${SETTINGS_NAV_MARKER}] > svg:first-child {
  display: none;
}

[${SETTINGS_NAV_MARKER}]::before {
  content: '';
  flex: none;
  width: 16px;
  height: 16px;
  background: currentColor;
  -webkit-mask: ${DATABASE_STACK_MASK};
  mask: ${DATABASE_STACK_MASK};
}
`

/**
 * Keep the marker on the settings-nav button whose visible text is this
 * plugin's current localized section label.
 * @param label - locale-aware label resolver used by the section registration.
 * @returns disposer that disconnects observation and removes owned markers.
 */
export function registerSettingsNavIcon(label: () => string): () => void {
  let disposed = false

  const sync = (): void => {
    if (disposed) return
    const currentLabel = label().trim()
    const buttons = document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')
    for (const button of buttons) {
      const matches = currentLabel.length > 0 && button.textContent?.trim() === currentLabel
      if (matches) button.setAttribute(SETTINGS_NAV_MARKER, '')
      else button.removeAttribute(SETTINGS_NAV_MARKER)
    }
  }

  sync()
  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  return () => {
    disposed = true
    observer.disconnect()
    document.querySelectorAll(`[${SETTINGS_NAV_MARKER}]`)
      .forEach(element => { element.removeAttribute(SETTINGS_NAV_MARKER) })
  }
}
