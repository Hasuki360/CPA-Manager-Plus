import type { TFunction } from 'i18next';
import {
  type CodexInspectionAction,
  type CodexInspectionAutoActionMode,
  type CodexInspectionConfigurableSettings,
  type CodexInspectionProgressSnapshot,
  type CodexInspectionResultItem,
  type CodexInspectionRunResult,
  type CodexInspectionStoredActionFilter,
  type CodexInspectionStoredLogEntry,
} from '@/features/monitoring/codexInspection';
import type { CodexInspectionResult } from '@/services/api/usageService';

export type RunStatus = 'idle' | 'running' | 'paused' | 'success' | 'error';

export type ActionFilter = CodexInspectionStoredActionFilter;

export type StatusTone = 'idle' | 'info' | 'good' | 'warn' | 'bad';

export type InspectionLogEntry = CodexInspectionStoredLogEntry;

export type ExecutionTriggerSource = 'manual' | 'auto';

export type CodexInspectionProblemActionMode = 'none' | 'disable' | 'delete';
export type ServerCodexInspectionAction = 'delete' | 'disable' | 'enable';
export type ServerCodexInspectionActionStatus =
  | 'none'
  | 'pending'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'needs_review';

export const CODEX_INSPECTION_PROBLEM_ACTION_MODES: readonly CodexInspectionProblemActionMode[] =
  ['none', 'disable', 'delete'];

export type CodexInspectionSummaryIcon =
  | 'probe'
  | 'sampled'
  | 'delete'
  | 'disable'
  | 'enable'
  | 'reauth';

export type CodexInspectionSummaryAccent =
  | 'blue'
  | 'cyan'
  | 'red'
  | 'amber'
  | 'green'
  | 'violet';

export type SummaryCard = {
  key: string;
  label: string;
  value: string;
  meta: string;
  tone?: StatusTone;
  icon?: CodexInspectionSummaryIcon;
  accent?: CodexInspectionSummaryAccent;
};

export type InspectionSettingsDraft = {
  targetType: string;
  workers: string;
  deleteWorkers: string;
  timeout: string;
  retries: string;
  userAgent: string;
  usedPercentThreshold: string;
  sampleSize: string;
  autoActionMode: CodexInspectionAutoActionMode;
};

export type InspectionSettingsDraftField = Exclude<
  keyof InspectionSettingsDraft,
  'autoActionMode'
>;

export const ACTION_FILTERS: ActionFilter[] = [
  'all',
  'delete',
  'disable',
  'enable',
  'reauth',
  'http_401',
];

export const formatTimestamp = (value: number, locale: string) =>
  new Date(value).toLocaleString(locale);

export const formatTime = (value: number, locale: string) =>
  new Date(value).toLocaleTimeString(locale);

export const formatPercent = (value: number | null) =>
  value === null ? '--' : `${value.toFixed(1)}%`;

export const toSettingsDraft = (
  settings: CodexInspectionConfigurableSettings
): InspectionSettingsDraft => ({
  targetType: settings.targetType,
  workers: String(settings.workers),
  deleteWorkers: String(settings.deleteWorkers),
  timeout: String(settings.timeout),
  retries: String(settings.retries),
  userAgent: settings.userAgent,
  usedPercentThreshold: String(settings.usedPercentThreshold),
  sampleSize: String(settings.sampleSize),
  autoActionMode: settings.autoActionMode,
});

export const formatActionLabel = (action: CodexInspectionAction, t: TFunction) => {
  switch (action) {
    case 'delete':
      return t('monitoring.codex_inspection_action_delete');
    case 'disable':
      return t('monitoring.codex_inspection_action_disable');
    case 'enable':
      return t('monitoring.codex_inspection_action_enable');
    case 'reauth':
      return t('monitoring.codex_inspection_action_reauth');
    case 'keep':
    default:
      return t('monitoring.codex_inspection_action_keep');
  }
};

export const isServerCodexInspectionAction = (
  action: string
): action is ServerCodexInspectionAction =>
  action === 'delete' || action === 'disable' || action === 'enable';

export const normalizeServerCodexInspectionActionStatus = (
  item: Pick<CodexInspectionResult, 'action' | 'actionStatus'>
): ServerCodexInspectionActionStatus => {
  if (
    item.actionStatus === 'none' ||
    item.actionStatus === 'pending' ||
    item.actionStatus === 'success' ||
    item.actionStatus === 'failed' ||
    item.actionStatus === 'skipped' ||
    item.actionStatus === 'needs_review'
  ) {
    return item.actionStatus;
  }
  return isServerCodexInspectionAction(item.action) ? 'pending' : 'none';
};

export const isActionableServerCodexInspectionResult = (
  item: Pick<CodexInspectionResult, 'id' | 'action' | 'actionStatus'>
) => {
  const status = normalizeServerCodexInspectionActionStatus(item);
  return (
    item.id > 0 &&
    isServerCodexInspectionAction(item.action) &&
    (status === 'pending' || status === 'failed')
  );
};

export const getCanonicalServerCodexInspectionActionIds = (
  results: Array<Pick<CodexInspectionResult, 'id' | 'fileName' | 'action' | 'actionStatus'>>
) => {
  const canonicalIds = new Set<number>();
  const fileOrder: string[] = [];
  const groups = new Map<
    string,
    Array<Pick<CodexInspectionResult, 'id' | 'fileName' | 'action' | 'actionStatus'>>
  >();
  for (const item of results) {
    const fileName = item.fileName.trim();
    if (!isServerCodexInspectionAction(item.action) || !fileName) {
      continue;
    }
    if (!groups.has(fileName)) {
      groups.set(fileName, []);
      fileOrder.push(fileName);
    }
    groups.get(fileName)?.push(item);
  }
  for (const fileName of fileOrder) {
    const group = groups.get(fileName) ?? [];
    if (group.length === 0) continue;
    const action = group[0].action;
    if (group.some((item) => item.action !== action)) continue;
    if (isActionableServerCodexInspectionResult(group[0])) {
      canonicalIds.add(group[0].id);
    }
  }
  return canonicalIds;
};

export const getMixedServerCodexInspectionActionIds = (
  results: Array<Pick<CodexInspectionResult, 'id' | 'fileName' | 'action'>>
) => {
  const mixedIds = new Set<number>();
  const groups = new Map<string, Array<Pick<CodexInspectionResult, 'id' | 'fileName' | 'action'>>>();
  for (const item of results) {
    const fileName = item.fileName.trim();
    if (!isServerCodexInspectionAction(item.action) || !fileName) {
      continue;
    }
    if (!groups.has(fileName)) {
      groups.set(fileName, []);
    }
    groups.get(fileName)?.push(item);
  }
  for (const group of groups.values()) {
    if (group.length === 0) continue;
    const action = group[0].action;
    if (!group.some((item) => item.action !== action)) continue;
    group.forEach((item) => mixedIds.add(item.id));
  }
  return mixedIds;
};

export const formatCurrentStateLabel = (item: CodexInspectionResultItem, t: TFunction) => {
  if (item.disabled) return t('monitoring.codex_inspection_state_disabled');
  return t('monitoring.codex_inspection_state_enabled');
};

export const countActions = (items: CodexInspectionResultItem[]) => {
  const summary = {
    delete: 0,
    disable: 0,
    enable: 0,
    reauth: 0,
    http401: 0,
  };

  items.forEach((item) => {
    if (item.action === 'delete') summary.delete += 1;
    if (item.action === 'disable') summary.disable += 1;
    if (item.action === 'enable') summary.enable += 1;
    if (item.action === 'reauth') summary.reauth += 1;
    if (item.statusCode === 401) summary.http401 += 1;
  });

  return summary;
};

export const createIdleProgressSnapshot = (): CodexInspectionProgressSnapshot => ({
  total: 0,
  completed: 0,
  inFlight: 0,
  pending: 0,
  percent: 0,
  status: 'idle',
  summary: {
    totalFiles: 0,
    probeSetCount: 0,
    sampledCount: 0,
    deleteCount: 0,
    disableCount: 0,
    enableCount: 0,
    reauthCount: 0,
    keepCount: 0,
  },
  startedAt: Date.now(),
  updatedAt: Date.now(),
});

export const createCompletedProgressSnapshot = (
  result: CodexInspectionRunResult
): CodexInspectionProgressSnapshot => {
  const total = Math.max(0, result.summary.sampledCount || result.results.length);
  return {
    total,
    completed: total,
    inFlight: 0,
    pending: 0,
    percent: total > 0 ? 100 : 0,
    status: 'completed',
    summary: {
      totalFiles: result.summary.totalFiles,
      probeSetCount: result.summary.probeSetCount,
      sampledCount: result.summary.sampledCount,
      deleteCount: result.summary.deleteCount,
      disableCount: result.summary.disableCount,
      enableCount: result.summary.enableCount,
      reauthCount: result.summary.reauthCount,
      keepCount: result.summary.keepCount,
    },
    startedAt: result.startedAt,
    updatedAt: result.finishedAt || Date.now(),
  };
};

export const filterByAction = (items: CodexInspectionResultItem[], filter: ActionFilter) => {
  if (filter === 'all') return items;
  if (filter === 'http_401') return items.filter((item) => item.statusCode === 401);
  return items.filter((item) => item.action === filter);
};

export const isCodexInspectionAutoExecutionEnabled = (
  mode: CodexInspectionAutoActionMode
) => mode !== 'none';

export const getCodexInspectionProblemActionMode = (
  mode: CodexInspectionAutoActionMode
): CodexInspectionProblemActionMode => {
  if (mode === 'disable' || mode === 'delete') return mode;
  return 'none';
};

export const composeCodexInspectionAutoActionMode = (
  enabled: boolean,
  problemActionMode: CodexInspectionProblemActionMode
): CodexInspectionAutoActionMode => {
  if (!enabled) return 'none';
  if (problemActionMode === 'disable' || problemActionMode === 'delete') {
    return problemActionMode;
  }
  return 'enable';
};

export const formatAutoActionModeLabel = (
  mode: CodexInspectionAutoActionMode,
  t: TFunction
) => {
  switch (mode) {
    case 'delete':
      return t('monitoring.codex_inspection_settings_auto_action_mode_delete');
    case 'disable':
      return t('monitoring.codex_inspection_settings_auto_action_mode_disable');
    case 'enable':
      return t('monitoring.codex_inspection_settings_auto_action_mode_enable');
    case 'none':
    default:
      return t('monitoring.codex_inspection_settings_auto_action_mode_none');
  }
};
