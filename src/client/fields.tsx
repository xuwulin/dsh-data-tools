/**
 * Hand-written controls for the data-tools settings form. Each renders one
 * field's label, its staged text, whether saving would leave an override, and
 * — when one stands — the reset that stages a clear back to the composition
 * layer. Nothing here writes: a control reports what the user typed, and the
 * page's save is the single point where a draft becomes a document mutation.
 *
 * Styles are inline objects over the dsh theme tokens (--dsw-*) so the client
 * half needs no CSS pipeline of its own.
 */

import type { CSSProperties } from 'react'

/** What every field control needs regardless of its value type. */
export interface FieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** Draft text this control renders. */
  text: string
  /** True when saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** True when the draft is not a value this field accepts. */
  invalid: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string
  /** Disables every control (read-only document, or an unavailable namespace). */
  disabled: boolean
  /** Stage draft text. */
  onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
}

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '12px 0',
}

const headStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const labelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
}

const badgesStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
}

const badgeStyle: CSSProperties = {
  borderRadius: 999,
  padding: '1px 8px',
  fontSize: 11,
  lineHeight: '17px',
  whiteSpace: 'nowrap',
  fontWeight: 500,
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'var(--dsw-alias-label-secondary)',
}

const resetButtonStyle: CSSProperties = {
  border: 'none',
  background: 'none',
  padding: 0,
  font: 'inherit',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
}

const inputStyle: CSSProperties = {
  height: 34,
  padding: '0 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-3)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
}

const textareaStyle: CSSProperties = {
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-3)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  resize: 'vertical',
  minHeight: 120,
}

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}

const invalidHintStyle: CSSProperties = {
  ...hintStyle,
  color: 'var(--dsw-alias-label-error)',
}

/**
 * A staged value field. `numeric` only hints the keypad: which drafts a field
 * accepts is decided by its spec, so the control never silently rewrites what
 * the user typed.
 * @param props - the field's copy, its staged text, and the edit actions.
 * @returns the labelled control.
 */
export function ValueField(props: FieldProps & {
  /** Hints a numeric keypad without narrowing what the control accepts. */
  numeric?: boolean
}) {
  return (
    <div style={fieldStyle}>
      <div style={headStyle}>
        <label style={labelStyle} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span style={badgesStyle}>
              <span style={badgeStyle}>{props.overriddenLabel}</span>
              <button
                type="button"
                style={resetButtonStyle}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <input
        id={props.id}
        style={props.invalid ? { ...inputStyle, borderColor: 'var(--dsw-alias-label-error)' } : inputStyle}
        type="text"
        {...props.numeric === true ? { inputMode: 'numeric' as const } : {}}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p style={props.invalid ? invalidHintStyle : hintStyle}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/**
 * A multi-line staged value field for JSON-shaped drafts (the connections
 * array). An invalid draft replaces the hint with the invalid reason and
 * blocks the save, exactly like {@link ValueField}; which drafts a field
 * accepts is still decided by its spec.
 * @param props - the field's copy, its staged text, and the edit actions.
 * @returns the labelled multi-line control.
 */
export function JsonField(props: FieldProps) {
  return (
    <div style={fieldStyle}>
      <div style={headStyle}>
        <label style={labelStyle} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span style={badgesStyle}>
              <span style={badgeStyle}>{props.overriddenLabel}</span>
              <button
                type="button"
                style={resetButtonStyle}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <textarea
        id={props.id}
        style={props.invalid ? { ...textareaStyle, borderColor: 'var(--dsw-alias-label-error)' } : textareaStyle}
        rows={10}
        spellCheck={false}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p style={props.invalid ? invalidHintStyle : hintStyle}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}
