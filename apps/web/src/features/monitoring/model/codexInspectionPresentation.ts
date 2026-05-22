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

export type RunStatus = 'idle' | 'running' | 'paused' | 'success' | 'error';

export type ActionFilter = CodexInspectionStoredActionFilter;

export type StatusTone = 'idle' | 'info' | 'good' | 'warn' | 'bad';

export type InspectionLogEntry = CodexInspectionStoredLogEntry;

export type ExecutionTriggerSource = 'manual' | 'auto';

export type SummaryCard = {
  key: string;
  label: string;
  value: string;
  meta: string;
  tone?: StatusTone;
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

export const ACTION_FILTERS: ActionFilter[] = ['all', 'delete', 'disable', 'enable'];

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
    case 'keep':
    default:
      return t('monitoring.codex_inspection_action_keep');
  }
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
  };

  items.forEach((item) => {
    if (item.action === 'delete') summary.delete += 1;
    if (item.action === 'disable') summary.disable += 1;
    if (item.action === 'enable') summary.enable += 1;
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
      keepCount: result.summary.keepCount,
    },
    startedAt: result.startedAt,
    updatedAt: result.finishedAt || Date.now(),
  };
};

export const filterByAction = (items: CodexInspectionResultItem[], filter: ActionFilter) => {
  if (filter === 'all') return items;
  return items.filter((item) => item.action === filter);
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
    case 'none':
    default:
      return t('monitoring.codex_inspection_settings_auto_action_mode_none');
  }
};
