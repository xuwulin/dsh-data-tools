/**
 * Shared staged form model behind the data-tools configuration page.
 *
 * The page stages what the user types and writes it only when they save. Each
 * settings write is a durable, revision-fenced profile mutation, so a control
 * that committed as it settled turned one edit into a write the user never
 * asked for and could not preview; staged text makes what is on screen exactly
 * what a save would store.
 *
 * A field shows its effective value — the user layer over the composition
 * layer over the schema default — and whether the user layer carries it. That
 * presence, not a value comparison, is what marks a field overridden: an
 * override equal to the composition default is still an override.
 *
 * One save sends every staged edit as ONE atomic mutation fenced by the
 * revision the drafts were staged against, so a concurrent edit elsewhere is
 * refused instead of silently overwritten. This mirrors the harness's own
 * settings form model; the page carries its own copy so the published bundle
 * stays self-contained.
 */

import { createSnapshotStore, type SettingsForm, type SettingsFormSnapshot, type SettingsPathOp, type SnapshotStore } from './host.ts'

/** The write one field's staged text performs when the page is saved. */
export type FieldWrite =
  | { kind: 'set'; value: unknown }
  | { kind: 'clear' }

/** How one section field converts between its stored value and its draft text. */
export interface CardFieldSpec {
  /** Field name inside the entry's config. */
  field: string
  /** Render a stored value as draft text; the empty string when the config carries none. */
  format: (value: unknown) => string
  /**
   * The write this draft text stages, or undefined when the text is not a
   * value this field accepts — which blocks the save rather than discarding it.
   */
  parse: (text: string) => FieldWrite | undefined
}

/** One field as the page's control renders it. */
export interface CardFieldState {
  /** Draft text the control renders. */
  text: string
  /**
   * Whether saving would leave a user-layer entry for this field. A staged
   * edit answers for itself, so the badge previews the save rather than
   * reporting a state the pending edit already contradicts.
   */
  overridden: boolean
  /** Whether the draft is not a value this field accepts, which blocks saving. */
  invalid: boolean
}

/** Form state the configuration page shares. */
export interface CardShell {
  /** False while the entry is not served to this client; the page renders nothing. */
  available: boolean
  /** Whether the host document accepts writes. */
  writable: boolean
  /** Whether the form holds edits that a save would write. */
  dirty: boolean
  /** Whether any staged draft is invalid, which blocks the save. */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save landed; cleared by the next edit, reset, discard, or explicit clear. */
  saved: boolean
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  failed: boolean
}

/** The write actions the configuration page's slot entry injects. */
export interface CardActions {
  /** Stage draft text for one field. */
  edit: (field: string, text: string) => void
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField: (field: string) => void
  /** Write every staged edit, then re-seed from what the host accepted. */
  save: () => void
  /** Drop every staged edit. */
  discard: () => void
  /** Clear the success flag once the UI has shown it (e.g. after a timeout). */
  clearSaved: () => void
}

/** One field's staged edit. */
interface StagedEdit {
  /** Draft text the control renders. */
  text: string
  /** True when this edit clears the field whatever text it shows. */
  clear: boolean
}

/** One staged edit resolved into the mutation a save sends. */
interface PlannedEdit {
  /** Field this entry writes. */
  field: string
  /** The operation a save sends for this field; absent when the draft is not a value the field accepts. */
  op?: SettingsPathOp
}

/**
 * A whole-number field. An empty draft clears the field; any other draft that
 * is not a finite number blocks the save.
 * @param field - field name inside the entry's config.
 * @returns the field's conversion spec.
 */
export function numberField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/**
 * Stages one page's edits over one profile entry's config and writes them on save.
 *
 * The form publishes through a snapshot store because slot components read
 * through a snapshot selector, while both the entry form and the local drafts
 * change underneath; every projection is rebuilt from the two together.
 */
export class CardForm<T> {
  private readonly specs: Map<string, CardFieldSpec>
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  /**
   * The snapshot the drafts were staged against. Its revision fences the save,
   * so a write that would land on top of someone else's edit is refused rather
   * than silently replacing it.
   */
  private baseline: SettingsFormSnapshot<T> | undefined
  private saving = false
  private saved = false
  private failed = false

  /**
   * @param form - the shared configuration form for this page's entry.
   * @param specs - the section fields this page edits.
   */
  constructor(
    private readonly form: SettingsForm<T>,
    specs: CardFieldSpec[],
  ) {
    this.specs = new Map(specs.map(spec => [spec.field, spec]))
    this.unsubscribe = form.subscribe(() => { this.publish() })
  }

  /**
   * Publish a projection of this form, rebuilt whenever the form or a draft changes.
   * @param project - build the page's state from the form's current reads.
   * @returns the store the page's component reads through its bound selector.
   */
  bind<S>(project: () => S): SnapshotStore<S> {
    const store = createSnapshotStore(project())
    this.listeners.add(() => { store.set(project()) })
    return store
  }

  /**
   * Read the page-level state: what the host serves, and what a save would do.
   * @returns the form state the page shares.
   */
  shell(): CardShell {
    const snapshot = this.form.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.op === undefined),
      saving: this.saving,
      saved: this.saved,
      failed: this.failed,
    }
  }

  /**
   * Read one control's state.
   * @param field - field name of a section field.
   * @returns the draft text, whether a save would leave an override, and whether it is invalid.
   */
  field(field: string): CardFieldState {
    const staged = this.staged.get(field)
    const spec = this.spec(field)
    if (staged === undefined) {
      return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false }
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return {
      text: staged.text,
      overridden: write?.kind === 'set',
      invalid: write === undefined,
    }
  }

  /**
   * Build the edit, reset, save, and discard actions bound to this form.
   * @returns the actions the page's slot entry injects.
   */
  actions(): CardActions {
    return {
      edit: (field, text) => { this.stage(field, { text, clear: false }) },
      resetField: (field) => {
        this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true })
      },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.baseline = undefined
        this.failed = false
        this.saved = false
        this.publish()
      },
      clearSaved: () => {
        if (!this.saved) return
        this.saved = false
        this.publish()
      },
    }
  }

  /**
   * Write every staged edit as one atomic mutation, then re-seed from what the
   * host accepted.
   *
   * The host is the only authority on whether a value was accepted — its
   * validators own the constraints no schema can express — so the outcome is
   * its answer to the mutation, not a prediction made here. A save that did not
   * land keeps its drafts, so the user can correct them instead of retyping.
   * @returns settlement after the write.
   */
  async save(): Promise<void> {
    const plan = this.plan()
    if (plan.length === 0
      || this.saving
      || !this.form.getSnapshot().writable
      || plan.some(item => item.op === undefined)) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const ops = plan.flatMap(item => item.op === undefined ? [] : [item.op])
      const landed = ops.length === 0 || await this.form.mutate(ops, this.baseline?.revision)
      if (landed) {
        this.staged.clear()
        this.baseline = undefined
      }
      this.failed = !landed
      this.saved = landed
    } catch {
      // A transport failure is not an accepted write: keep the drafts for a retry.
      this.failed = true
      this.saved = false
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /** Release the form's subscription; the page owner calls this from its effect. */
  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  /**
   * Every staged edit a save would write. An entry whose draft is not a value
   * its field accepts carries no operation: the form is still dirty, and the
   * save refuses rather than dropping the edit.
   * @returns the planned edits, in the order the fields were staged.
   */
  private plan(): PlannedEdit[] {
    const plan: PlannedEdit[] = []
    for (const [field, staged] of this.staged) {
      const spec = this.spec(field)
      if (staged.clear) {
        // A clear only writes when the user layer actually carries the field.
        if (this.stored(field)) plan.push({ field, op: { op: 'unset', path: [field] } })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ field })
      else if (write.kind === 'clear') plan.push({ field, op: { op: 'unset', path: [field] } })
      else plan.push({ field, op: { op: 'set', path: [field], value: write.value } })
    }
    return plan
  }

  private stage(field: string, edit: StagedEdit): void {
    // The first stage pins the revision every later draft is sent against.
    this.baseline ??= this.form.getSnapshot()
    this.staged.set(field, edit)
    this.failed = false
    this.saved = false
    this.publish()
  }

  private spec(field: string): CardFieldSpec {
    const spec = this.specs.get(field)
    // Every call site names a field this page declared; a missing one is a
    // wiring mistake that must not degrade into a silently inert control.
    if (spec === undefined) throw new Error(`data-tools configuration page has no field ${field}`)
    return spec
  }

  private snapshotOf(): SettingsFormSnapshot<T> {
    return this.form.getSnapshot()
  }

  private sectionValue(field: string): unknown {
    return (this.snapshotOf().value as Record<string, unknown> | undefined)?.[field]
  }

  private baseValue(field: string): unknown {
    return (this.snapshotOf().base as Record<string, unknown> | undefined)?.[field]
  }

  private stored(field: string): boolean {
    const user = this.snapshotOf().user as Record<string, unknown> | undefined
    return user !== undefined && Object.hasOwn(user, field)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
