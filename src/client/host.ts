/**
 * Local structural types for the services the web shell injects into a client
 * plugin. The data-tools browser half imports nothing from the dsh client
 * packages — everything arrives through `ctx.slots` / `ctx.locale` /
 * `ctx.settingsScope` and React, so the client bundle stays self-contained and
 * the published package has no client-package dependency to install.
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

/** Snapshot of one bound settings namespace as the host serves it. */
export interface SettingsScopeSnapshot<T> {
  status: 'ready' | 'loading' | 'unavailable'
  writable: boolean
  value?: T
  base?: T
  user?: T
  revision?: number
}

/** A bound settings namespace: reads, observation, and field-level writes. */
export interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** Settings-scope binder exposed as `ctx.settingsScope`. */
export interface SettingsScopeBinder {
  bind<T>(spec: { namespace: string }): SettingsScope<T>
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
  id: string
  order: number
  label: () => string
  locale: string
  inject: () => unknown
}

/** Slot registry service slice this bundle uses. */
export interface SlotsService {
  inject(slot: string, factory: () => void): void
  register(options: SlotEntryOptions, component: unknown): void
}

/** The client plugin context as this bundle consumes it. */
export interface ClientContext {
  slots: SlotsService
  locale: LocaleService
  settingsScope: SettingsScopeBinder
  effect(fn: () => (() => void) | void, label: string): void
}

/**
 * The renderer binds one `use<Name>` hook per `hooks` key of an inject face,
 * and spreads the face's action members onto the component props.
 */
export interface DataToolsSettingsInjected {
  hooks: { dataToolsSettings: SnapshotStore<unknown> }
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}
