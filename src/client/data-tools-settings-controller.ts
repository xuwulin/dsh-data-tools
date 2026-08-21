/** The data-tools settings page's staged form over the `data-tools` settings namespace. */

import { CardForm, numberField, type CardActions, type CardFieldSpec, type CardFieldState, type CardShell } from './card-form.ts'
import type { SettingsScope, SnapshotStore } from './host.ts'

/**
 * Namespace of the data-tools plugin. Spelled here rather than imported: the
 * browser half must not pull the Node half (mysql2 and friends) into the
 * bundle, and the plugin that owns the namespace spells the same value.
 */
export const DATA_TOOLS_NS = 'data-tools'

/** The data-tools fields this page edits — a subset of the served schema by design. */
export interface DataToolsSettings {
  /** Result row cap applied when a connection sets none. */
  defaultMaxRows?: number
  /** Statement timeout in ms applied when a connection sets none. */
  defaultTimeoutMs?: number
  /** Named connections the db_* tools operate on. */
  connections?: unknown[]
}

/** What the data-tools settings page renders. */
export interface DataToolsSettingsState extends CardShell {
  /** Default result row cap. */
  defaultMaxRows: CardFieldState
  /** Default statement timeout in ms. */
  defaultTimeoutMs: CardFieldState
  /** Connections as a JSON draft. */
  connections: CardFieldState
}

/** The registration-side face the data-tools settings page's slot entry injects. */
export interface DataToolsSettingsFace extends CardActions {
  hooks: {
    /** Page snapshot bound by the renderer as useDataToolsSettings. */
    dataToolsSettings: SnapshotStore<DataToolsSettingsState>
  }
}

/** Whether a value is a plain data object (not an array, null, or class instance). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A JSON-array field: the connections array pretty-printed as draft text. An
 * empty draft clears the field; a draft that is not a JSON array of plain
 * objects blocks the save (semantic validation — required fields, the kind
 * discriminator — stays with the Host schema).
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function jsonArrayField(field: string): CardFieldSpec {
  return {
    field,
    format: (value) => (value === undefined ? '' : JSON.stringify(value, null, 2)),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return undefined
      }
      if (!Array.isArray(parsed) || !parsed.every(isRecord)) return undefined
      return { kind: 'set', value: parsed }
    },
  }
}

/** Bridges the `data-tools` scope onto the settings page's staged form. */
export class DataToolsSettingsController {
  private readonly form: CardForm<DataToolsSettings>
  private readonly store: SnapshotStore<DataToolsSettingsState>

  /** @param scope - the bound settings scope for the `data-tools` namespace. */
  constructor(scope: SettingsScope<DataToolsSettings>) {
    this.form = new CardForm(scope, [
      numberField('defaultMaxRows'),
      numberField('defaultTimeoutMs'),
      jsonArrayField('connections'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): DataToolsSettingsState {
    return {
      ...this.form.shell(),
      defaultMaxRows: this.form.field('defaultMaxRows'),
      defaultTimeoutMs: this.form.field('defaultTimeoutMs'),
      connections: this.form.field('connections'),
    }
  }

  /**
   * Build the face the settings page's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): DataToolsSettingsFace {
    return { hooks: { dataToolsSettings: this.store }, ...this.form.actions() }
  }
}
