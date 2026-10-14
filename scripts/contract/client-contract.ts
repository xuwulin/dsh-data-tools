/**
 * Compile-time contract probe: the browser half's LOCAL structural types must
 * stay assignable to the real client packages the CURRENT harness ships, and the
 * props this plugin's page component accepts must cover what the Plugins page
 * hands a `plugins.row.config` entry.
 *
 * This file is never emitted — it only has to typecheck. Run it after a harness
 * upgrade (`npm run typecheck:contract`): it fails at the exact seam the upgrade
 * moved, instead of leaving a page that silently never mounts.
 */
import type { ConfigForm, ConfigFormSnapshot, ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormsService, SettingsForm, SettingsFormSnapshot } from '../../src/client/host.ts'
import type { DataToolsSettingsState } from '../../src/client/data-tools-settings-controller.ts'
import type { DataToolsSettingsSectionProps } from '../../src/client/DataToolsSettingsSection.tsx'

interface Shape {
  defaultMaxRows?: number
}

/** The host's snapshot must be accepted where our mirror is expected. */
declare const realForm: ConfigForm<Shape>
const mirroredForm: SettingsForm<Shape> = realForm
/** …and our mirror must be accepted where the host's form is expected. */
declare const mirrored: SettingsForm<Shape>
const realAgain: ConfigForm<Shape> = mirrored
/** Snapshot shapes must agree in both directions. */
declare const realSnapshot: ConfigFormSnapshot<Shape>
const mirroredSnapshot: SettingsFormSnapshot<Shape> = realSnapshot
declare const mine: SettingsFormSnapshot<Shape>
const realSnapshotAgain: ConfigFormSnapshot<Shape> = mine
/** The service face must line up with `ctx.configForms`. */
declare const realService: ConfigForms
const mirroredService: ConfigFormsService = realService

/** What the Plugins page hands a `plugins.row.config` entry, plus the seats the framework adds. */
type RowConfigProps = SlotMap['plugins.row.config']['owner']
declare const composed: RowConfigProps & {
  t: (key: string) => string
  hooks: { dataToolsSettings: { getSnapshot(): DataToolsSettingsState; subscribe(listener: () => void): () => void; set(value: DataToolsSettingsState): void } }
  useDataToolsSettings: <S>(selector: (state: DataToolsSettingsState) => S) => S
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
  clearSaved: () => void
}
const acceptedByOurComponent: DataToolsSettingsSectionProps = composed

export { mirroredForm, realAgain, mirroredSnapshot, realSnapshotAgain, mirroredService, acceptedByOurComponent }
