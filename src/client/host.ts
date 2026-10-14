/**
 * Local structural types for the services the web shell injects into a client
 * plugin. The data-tools browser half imports nothing from the dsh client
 * packages — everything arrives through `ctx.slots` / `ctx.locale` /
 * `ctx.configForms` and React, so the client bundle stays self-contained and
 * the published package has no client-package dependency to install.
 *
 * The shapes below mirror the current web client's public services
 * (`dsh-client-ui-settings`' entry form, `dsh-client-ui-slots`' registrations);
 * keep them in step when a harness release changes those services.
 */

/** A snapshot store: one current value, stable reference between changes. */
export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(value: T): void
}

/** Minimal snapshot store implementation (the bundle must not import the harness runtime). */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (value) => {
      snapshot = value
      for (const listener of listeners) listener()
    },
  }
}

/** One path-addressed edit an entry form writes; one save sends them atomically. */
export type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/** Snapshot of one profile entry's configuration form as the host serves it. */
export interface SettingsFormSnapshot<T> {
  /** `loading` until the first accepted section, `ready` while one stands, `unavailable` when the entry is not served. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Last accepted configuration; undefined before the first accepted read. */
  value: T | undefined
  /** Composition layer `value` resolves over: what a field reverts to once cleared. */
  base: unknown
  /** Raw user layer as stored; a field's PRESENCE here is what marks it overridden. */
  user: unknown
  /** Revision fencing the next write; undefined before the first host view. */
  revision: number | undefined
  /** Whether the host document accepts writes. */
  writable: boolean
  /** `host` syncs with the profile patch; `memory` keeps a remote browser process-local. */
  mode: 'host' | 'memory'
}

/**
 * One profile entry's configuration form, as `ctx.configForms.get(entryId)`
 * returns it: the accepted values plus the one atomic, revision-fenced write
 * every editor of that entry shares.
 */
export interface SettingsForm<T> {
  getSnapshot(): SettingsFormSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean>
}

/** The settings domain's base service, exposed as `ctx.configForms`. */
export interface ConfigFormsService {
  /** @param entryId - unique profile entry id whose config the form edits. */
  get<T>(entryId: string): SettingsForm<T>
  /**
   * Keep a registration alive while the host serves any of some entries.
   * @param namespaces - profile entry ids the registration follows.
   * @param register - registers the contribution; returns its disposer.
   * @returns the disposer ending the watch and any live registration.
   */
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
}

/** Localized text function. */
export type LocaleText = (key: string) => string

/** Locale service slice this bundle uses. */
export interface LocaleService {
  register(ns: string, dict: Record<string, Record<string, string>>): void
  bind(ns: string): LocaleText
}

/** One slot registration option set (the fields this bundle reads back). */
export interface SlotEntryOptions {
  name: string
  /** Entry id, for a list slot. */
  id?: string
  /** Entry key, for a keyed slot (`<package name>#<row id>` for a bundle row). */
  key?: string
  order?: number
  label?: () => string
  locale?: string
  inject?: () => unknown
}

/** Slot registry service slice this bundle uses. */
export interface SlotsService {
  /**
   * Register one contribution into a slot.
   * @param slot - the slot's key.
   * @param factory - builds the registration when the slot is available.
   * @returns the disposer that withdraws the contribution.
   */
  inject(slot: string, factory: () => void): () => void
  register(options: SlotEntryOptions, component: unknown): void
}

/** The client plugin context as this bundle consumes it. */
export interface ClientContext {
  slots: SlotsService
  locale: LocaleService
  configForms: ConfigFormsService
  effect(fn: () => (() => void) | void, label: string): void
}
