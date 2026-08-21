/**
 * Data-tools browser half: one Settings navigation page binding the plugin's
 * settings namespace, contributed as an ordinary `settings.section` so no
 * harness code needs to change. The bundle is self-contained: it imports only
 * React (a web-shell baseline module) and reaches every service through the
 * injected `ctx.slots` / `ctx.locale` / `ctx.settingsScope`, so the published
 * package carries no dsh client-package dependency.
 *
 * The settings.section id and order intentionally place the entry directly
 * below the third-party "sidebar cards" section (slot order 100).
 */

import { DataToolsSettingsSection } from './DataToolsSettingsSection.tsx'
import { DATA_TOOLS_NS, DataToolsSettingsController } from './data-tools-settings-controller.ts'
import type { ClientContext } from './host.ts'
import { en, zh } from './locales.ts'

/** Locale namespace owned by this browser half. */
const NS = 'data-tools'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Register the data-tools settings page once the `settings.section`
 * declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'data-tools: page dictionaries')
  const t = ctx.locale.bind(NS)
  const dataTools = new DataToolsSettingsController(ctx.settingsScope.bind({ namespace: DATA_TOOLS_NS }))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'data-tools',
    order: 101,
    label: () => t('dataToolsTitle'),
    locale: NS,
    inject: () => dataTools.inject(),
  }, DataToolsSettingsSection))
}
