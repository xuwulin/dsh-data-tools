/** The data-tools settings page: read-only database connections the agent may query. */

import type { CSSProperties } from 'react'
import { JsonField, ValueField } from './fields.tsx'
import type { DataToolsSettingsFace, DataToolsSettingsState } from './data-tools-settings-controller.ts'
import type { LocaleText } from './host.ts'

/** Props the renderer binds for the data-tools settings page. */
export interface DataToolsSettingsSectionProps extends DataToolsSettingsFace {
  /** Localized text for the data-tools copy. */
  t: LocaleText
  /** Bound snapshot selector, provided by the renderer from the inject face hooks. */
  useDataToolsSettings: <S>(selector: (state: DataToolsSettingsState) => S) => S
}

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  maxWidth: 760,
  color: 'var(--dsw-alias-label-primary)',
}

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 600,
}

const introStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: 'var(--dsw-alias-label-tertiary)',
}

const unavailableStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}

const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '12px 0 4px',
  borderTop: '1px solid var(--dsw-alias-border-l2)',
}

const failedStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-error)',
}

const buttonBase: CSSProperties = {
  appearance: 'none',
  border: '1px solid transparent',
  borderRadius: 8,
  padding: '5px 14px',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
  cursor: 'pointer',
}

const discardButtonStyle: CSSProperties = {
  ...buttonBase,
  borderColor: 'var(--dsw-alias-border-l2)',
  background: 'none',
  color: 'var(--dsw-alias-label-secondary)',
}

const saveButtonStyle: CSSProperties = {
  ...buttonBase,
  background: 'var(--dsw-alias-label-primary)',
  color: 'var(--dsw-alias-bg-layer-3)',
}

/**
 * Render the data-tools settings page.
 * @param props - locale copy, the form snapshot, and its actions.
 * @returns the page.
 */
export function DataToolsSettingsSection(props: DataToolsSettingsSectionProps) {
  const { t } = props
  const state = props.useDataToolsSettings(snapshot => snapshot)
  const disabled = !state.writable
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <div style={sectionStyle}>
      <h2 style={headingStyle}>{t('dataToolsTitle')}</h2>
      <p style={introStyle}>{t('dataToolsIntro')}</p>
      {!state.available
        ? <p style={unavailableStyle} role="status">{t('dataToolsUnavailable')}</p>
        : (
          <>
            <ValueField
              id="plugin-config-datatools-section-maxrows"
              label={t('dataToolsMaxRows')}
              hint={t('dataToolsMaxRowsHint')}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidNumber')}
              numeric
              disabled={disabled}
              {...state.defaultMaxRows}
              onEdit={(text) => { props.edit('defaultMaxRows', text) }}
              onReset={() => { props.resetField('defaultMaxRows') }}
            />
            <ValueField
              id="plugin-config-datatools-section-timeout"
              label={t('dataToolsTimeoutMs')}
              hint={t('dataToolsTimeoutMsHint')}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidNumber')}
              numeric
              disabled={disabled}
              {...state.defaultTimeoutMs}
              onEdit={(text) => { props.edit('defaultTimeoutMs', text) }}
              onReset={() => { props.resetField('defaultTimeoutMs') }}
            />
            <JsonField
              id="plugin-config-datatools-section-connections"
              label={t('dataToolsConnections')}
              hint={t('dataToolsConnectionsHint')}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidJson')}
              disabled={disabled}
              {...state.connections}
              onEdit={(text) => { props.edit('connections', text) }}
              onReset={() => { props.resetField('connections') }}
            />
            <div style={footerStyle}>
              {state.failed ? <p style={failedStyle} role="status">{t('saveFailed')}</p> : null}
              <button
                type="button"
                style={discardButtonStyle}
                disabled={!state.dirty || state.saving}
                onClick={props.discard}
              >
                {t('discard')}
              </button>
              <button
                type="button"
                style={saveButtonStyle}
                disabled={blocked}
                onClick={props.save}
              >
                {t(state.saving ? 'saving' : 'save')}
              </button>
            </div>
          </>
        )}
    </div>
  )
}
