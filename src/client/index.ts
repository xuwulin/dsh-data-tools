/**
 * Data-tools browser half: the plugin's own configuration page, contributed to
 * the Plugins page's `plugins.row.config` slot so no harness code needs to
 * change. The bundle is self-contained: it imports only React (a web-shell
 * baseline module) and reaches every service through the injected
 * `ctx.slots` / `ctx.locale` / `ctx.configForms`, so the published package
 * carries no dsh client-package dependency.
 *
 * A plugin bundle configures itself ON ITS OWN ROW: the slot is keyed
 * `<package name>#<row id>` — the id `cordis.patch.yml` inserts — and the host
 * gives that row a Configure control that opens this page. The registration
 * lives only while the host serves the entry, so a deployment that never loaded
 * the plugin shows no trace of the page.
 */

import { DataToolsSettingsSection } from './DataToolsSettingsSection.tsx'
import { DATA_TOOLS_NS, DataToolsSettingsController, type DataToolsSettings } from './data-tools-settings-controller.ts'
import type { ClientContext } from './host.ts'
import { en, zh } from './locales.ts'

/** Locale namespace owned by this browser half. */
const NS = 'data-tools'

/** This bundle's package name; the other half of the row key below. */
const PACKAGE_NAME = '@xwl12/dsh-data-tools'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Register the data-tools configuration page while the host serves its entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'data-tools: page dictionaries')
  const t = ctx.locale.bind(NS)
  const dataTools = new DataToolsSettingsController(ctx.configForms.get<DataToolsSettings>(DATA_TOOLS_NS))
  ctx.effect(() => () => { dataTools.dispose() }, 'data-tools: configuration form subscription')

  // whileServed keeps the page alive exactly as long as the host serves this
  // entry: the configure control appears with the plugin and disappears with it.
  ctx.effect(
    () => ctx.configForms.whileServed([DATA_TOOLS_NS], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
      name: 'plugins.row.config',
      key: `${PACKAGE_NAME}#${DATA_TOOLS_NS}`,
      locale: NS,
      inject: () => dataTools.inject(),
    }, DataToolsSettingsSection))),
    'data-tools: configuration page',
  )
}
