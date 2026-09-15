import {
  resolveRetentionCutoff,
  toLocalDateTimeValue,
  type ArchiveHistoryFilter,
  type RetentionSelection,
} from './usageMaintenanceModel';

export type MaintenanceTab = 'organize' | 'transfer' | 'history';
export type MaintenanceIntent = 'archive' | 'cleanup';
export type MaintenancePanel = 'run' | 'advanced' | 'diagnostics' | null;

export type UsageMaintenanceNavigation = {
  tab: MaintenanceTab;
  panel: MaintenancePanel;
  runId: string | null;
  intent: MaintenanceIntent;
  retention: RetentionSelection;
  customCutoff: string;
  referenceNowMS: number;
  filter: ArchiveHistoryFilter;
};

const dayMS = 24 * 60 * 60 * 1000;
const tabs = new Set(['organize', 'transfer', 'history']);
const filters = new Set(['all', 'archiving', 'archived', 'verified', 'failed']);

export function readUsageMaintenanceNavigation(
  hash = typeof window === 'undefined' ? '' : window.location.hash,
  nowMS = Date.now()
): UsageMaintenanceNavigation {
  const [pathname, search = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(
    ['/usage-maintenance', '/demo/usage-maintenance'].includes(pathname) ? search : ''
  );
  const requestedTab = params.get('tab') ?? 'organize';
  const requestedFilter = params.get('filter') ?? 'all';
  const requestedDays = params.get('days');
  const retention: RetentionSelection =
    requestedDays === 'custom'
      ? 'custom'
      : requestedDays === '7' || requestedDays === '90'
        ? (Number(requestedDays) as 7 | 90)
        : 30;
  const before = Number(params.get('before'));
  const validBefore =
    Number.isFinite(before) &&
    before > 0 &&
    before <= (retention === 'custom' ? nowMS : nowMS - retention * dayMS);
  const run = params.get('run');
  const runId = run && /^[a-zA-Z0-9_-]{1,200}$/.test(run) ? run : null;
  const panel = params.get('panel');
  return {
    tab: tabs.has(requestedTab) ? (requestedTab as MaintenanceTab) : 'organize',
    panel:
      panel === 'advanced' || panel === 'diagnostics'
        ? panel
        : panel === 'run' && runId
          ? 'run'
          : null,
    runId,
    intent: params.get('intent') === 'cleanup' ? 'cleanup' : 'archive',
    retention,
    customCutoff: toLocalDateTimeValue(validBefore ? before : nowMS - 30 * dayMS),
    referenceNowMS: validBefore && retention !== 'custom' ? before + retention * dayMS : nowMS,
    filter: filters.has(requestedFilter) ? (requestedFilter as ArchiveHistoryFilter) : 'all',
  };
}

export function writeUsageMaintenanceNavigation(state: UsageMaintenanceNavigation): string {
  const params = new URLSearchParams();
  if (state.tab !== 'organize') params.set('tab', state.tab);
  if (state.intent !== 'archive') params.set('intent', state.intent);
  if (state.retention !== 30) params.set('days', String(state.retention));
  const cutoff = resolveRetentionCutoff(state.retention, state.customCutoff, state.referenceNowMS);
  if (cutoff) params.set('before', String(cutoff));
  if (state.filter !== 'all') params.set('filter', state.filter);
  if (state.runId) params.set('run', state.runId);
  if (state.panel) params.set('panel', state.panel);
  return `?${params.toString()}`;
}
