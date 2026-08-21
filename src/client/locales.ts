/** Locale bundles for the data-tools settings page. */

/** Locale keys the settings page renders. */
export type DataToolsSettingsLocaleKey =
  | 'dataToolsTitle' | 'dataToolsIntro' | 'dataToolsUnavailable'
  | 'dataToolsMaxRows' | 'dataToolsMaxRowsHint'
  | 'dataToolsTimeoutMs' | 'dataToolsTimeoutMsHint'
  | 'dataToolsConnections' | 'dataToolsConnectionsHint' | 'invalidJson'
  | 'overridden' | 'reset' | 'save' | 'saving' | 'discard' | 'saveFailed' | 'invalidNumber'

/** English copy. */
export const en: Record<DataToolsSettingsLocaleKey, string> = {
  dataToolsTitle: 'Data sources',
  dataToolsIntro: 'Read-only MySQL connections the agent can query, and the default limits applied to every call.',
  dataToolsUnavailable: 'The data-tools plugin is not loaded in this deployment; no connections are configured.',
  dataToolsMaxRows: 'Default row cap',
  dataToolsMaxRowsHint: 'Result rows per call when a connection sets none.',
  dataToolsTimeoutMs: 'Default timeout (ms)',
  dataToolsTimeoutMsHint: 'Statement timeout when a connection sets none.',
  dataToolsConnections: 'Connections (JSON)',
  dataToolsConnectionsHint: 'An array of connection objects: name, host, port, user, and passwordRef (preferred) or password. Passwords are write-only and never shown again — prefer passwordRef, because saving replaces the whole array.',
  invalidJson: 'Enter a JSON array of connection objects, or leave blank to use the default.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
}

/** Simplified Chinese copy. */
export const zh: Record<DataToolsSettingsLocaleKey, string> = {
  dataToolsTitle: '数据源',
  dataToolsIntro: 'Agent 可以查询的只读 MySQL 连接，以及每次调用适用的默认限制。',
  dataToolsUnavailable: '本部署未加载 data-tools 插件，未配置任何连接。',
  dataToolsMaxRows: '默认结果行数上限',
  dataToolsMaxRowsHint: '连接未单独设置时，每次调用返回的行数上限。',
  dataToolsTimeoutMs: '默认超时（毫秒）',
  dataToolsTimeoutMsHint: '连接未单独设置时的语句超时。',
  dataToolsConnections: '连接（JSON）',
  dataToolsConnectionsHint: '连接对象数组：name、host、port、user，以及 passwordRef（推荐）或 password。密码只写不回显——建议用 passwordRef，因为保存会整体替换该数组。',
  invalidJson: '请输入连接对象组成的 JSON 数组；留空表示使用默认值。',
  overridden: '已覆盖',
  reset: '恢复默认',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
}
