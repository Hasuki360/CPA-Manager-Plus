import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import type {
  UsageArchiveList,
  UsageArchiveRunSummary,
  UsageArchiveStatus,
  UsageMaintenanceStatus,
} from '@/services/api/usageService';
import { formatDateTime, formatFileSize } from '@/utils/format';
import {
  getArchiveRunAction,
  isArchiveRunCancellable,
  resolveProgressPercent,
  type ArchiveHistoryFilter,
  type ArchiveRunAction,
  type UsageMaintenanceView,
} from './usageMaintenanceModel';
import type { MaintenanceIntent } from './usageMaintenanceNavigation';
import styles from './UsageMaintenanceArchiveViews.module.scss';

const archiveStatuses = new Set([
  'previewed',
  'archiving',
  'archived',
  'verifying',
  'verified',
  'deleting',
  'completed',
  'failed',
  'cancelled',
]);
type Navigate = (view: UsageMaintenanceView) => void;
type Actions = {
  working: boolean;
  onAction: (run: UsageArchiveRunSummary, action: ArchiveRunAction) => void;
  actionDisabled: (run: UsageArchiveRunSummary, action: ArchiveRunAction) => boolean;
  actionTitle: (run: UsageArchiveRunSummary, action: ArchiveRunAction) => string | undefined;
  actionLabel: (run: UsageArchiveRunSummary, action: ArchiveRunAction) => string;
};

function RunActions({
  run,
  working,
  onAction,
  actionDisabled,
  actionTitle,
  actionLabel,
}: Actions & { run: UsageArchiveRunSummary }) {
  const action = getArchiveRunAction(run.status);
  const cancellable = isArchiveRunCancellable(run);
  return (
    <>
      {action ? (
        <Button
          size="sm"
          variant={
            action === 'delete' || run.resume_status === 'deleting' || run.status === 'deleting'
              ? 'danger'
              : 'primary'
          }
          disabled={working || actionDisabled(run, action)}
          title={actionTitle(run, action)}
          onClick={() => onAction(run, action)}
        >
          {actionLabel(run, action)}
        </Button>
      ) : null}
      {cancellable ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={working || actionDisabled(run, 'cancel')}
          title={actionTitle(run, 'cancel')}
          onClick={() => onAction(run, 'cancel')}
        >
          {actionLabel(run, 'cancel')}
        </Button>
      ) : null}
    </>
  );
}

export function UsageMaintenanceOverviewView({
  maintenance,
  archives,
  selectedRunId,
  stale = false,
  working,
  onNavigate,
  onOpenRun,
}: {
  maintenance: UsageMaintenanceStatus;
  archives: UsageArchiveRunSummary[];
  selectedRunId?: string | null;
  stale?: boolean;
  working: boolean;
  onNavigate: Navigate;
  onOpenRun: (run: UsageArchiveRunSummary) => void;
}) {
  const { t, i18n } = useTranslation();
  const formatTime = (value?: number) =>
    value ? formatDateTime(new Date(value), i18n.language) : '—';
  const resumable = [maintenance.active_run, ...archives]
    .filter((run, index, all): run is UsageArchiveRunSummary =>
      Boolean(
        run &&
        run.id !== selectedRunId &&
        getArchiveRunAction(run.status) &&
        all.findIndex((item) => item?.id === run.id) === index
      )
    )
    .slice(0, 3);
  return (
    <div className={styles.view}>
      <dl className={styles.summary}>
        <div>
          <dt>{t('usage_maintenance.raw_events', { defaultValue: 'Online details' })}</dt>
          <dd>{stale ? '—' : maintenance.raw_event_count.toLocaleString(i18n.language)}</dd>
          <small>
            {t('usage_maintenance.workspace_archived_subset', {
              defaultValue: 'Including {{count}} already archived',
              count: stale
                ? '—'
                : (maintenance.raw_archived_event_count?.toLocaleString(i18n.language) ?? '—'),
            })}
          </small>
        </div>
        <div>
          <dt>{t('usage_maintenance.deleted_events', { defaultValue: 'Details cleaned up' })}</dt>
          <dd>{stale ? '—' : maintenance.raw_deleted_event_count.toLocaleString(i18n.language)}</dd>
          <small>
            {t('usage_maintenance.workspace_deleted_hint', {
              defaultValue: 'Removed from online detail queries',
            })}
          </small>
        </div>
        <div className={styles.rangeSummary}>
          <dt>
            {t('usage_maintenance.online_range_title', { defaultValue: 'Current online range' })}
          </dt>
          <dd>
            {stale ? (
              '—'
            ) : maintenance.raw_event_count === 0 ? (
              t('usage_maintenance.raw_range_empty')
            ) : maintenance.raw_min_timestamp_ms && maintenance.raw_max_timestamp_ms ? (
              <>
                {formatTime(maintenance.raw_min_timestamp_ms)}
                <br />
                {formatTime(maintenance.raw_max_timestamp_ms)}
              </>
            ) : (
              t('usage_maintenance.raw_range_unavailable')
            )}
          </dd>
        </div>
      </dl>
      {resumable.length > 0 ? (
        <section className={styles.continuations}>
          <div className={styles.sectionHeader}>
            <strong>
              {t('usage_maintenance.workspace_continue', {
                defaultValue: 'Continue an existing operation',
              })}
            </strong>
            <Button variant="ghost" size="sm" onClick={() => onNavigate('history')}>
              {t('usage_maintenance.workspace_records', { defaultValue: 'Processing records' })}
            </Button>
          </div>
          {resumable.map((run) => (
            <div className={styles.continuation} key={run.id} data-run-id={run.id}>
              <span>
                {formatTime(run.created_at_ms)} ·{' '}
                {t(`usage_maintenance.run_status_${run.status}`, { defaultValue: run.status })}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={working}
                onClick={() => onOpenRun(run)}
              >
                {t('usage_maintenance.workspace_continue_record', {
                  defaultValue: 'Continue this record',
                })}
              </Button>
            </div>
          ))}
          <p className={styles.hint}>
            {t('usage_maintenance.workspace_existing_scope', {
              defaultValue:
                'Each record has its own complete data range. Review it before cleanup; the range selected for a new archive does not limit an existing record.',
            })}
          </p>
        </section>
      ) : null}
    </div>
  );
}

type HistoryProps = Actions & {
  archiveList: UsageArchiveList;
  filter: ArchiveHistoryFilter;
  loading: boolean;
  canGoBack: boolean;
  onFilter: (filter: ArchiveHistoryFilter) => void;
  onNextPage: () => void;
  onPreviousPage: () => void;
  onRefresh: () => void;
  onNavigate: Navigate;
  onOpenRun: (run: UsageArchiveRunSummary) => void;
};

export function UsageArchiveHistoryView({
  archiveList,
  filter,
  loading,
  canGoBack,
  onFilter,
  onNextPage,
  onPreviousPage,
  onRefresh,
  onNavigate,
  onOpenRun,
  ...actions
}: HistoryProps) {
  const { t, i18n } = useTranslation();
  const formatTime = (value?: number) =>
    value ? formatDateTime(new Date(value), i18n.language) : '—';
  const filters: ArchiveHistoryFilter[] = ['all', 'archiving', 'archived', 'verified', 'failed'];
  const counts = archiveList.status_counts;
  return (
    <section className={styles.view} aria-busy={loading}>
      <div className={styles.sectionHeader}>
        <p className={styles.hint}>
          {t('usage_maintenance.history_subtitle', {
            defaultValue:
              'Review the range and result of each operation, or continue where it stopped.',
          })}
        </p>
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="secondary"
            onClick={onRefresh}
            disabled={loading || actions.working}
          >
            {t('common.refresh')}
          </Button>
          <Button size="sm" onClick={() => onNavigate('create')} disabled={actions.working}>
            {t('usage_maintenance.workspace_new', { defaultValue: 'New operation' })}
          </Button>
        </div>
      </div>
      <div
        className={styles.filterBar}
        role="group"
        aria-label={t('usage_maintenance.history_filters', {
          defaultValue: 'Archive status filters',
        })}
      >
        {filters.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={filter === item}
            className={filter === item ? styles.filterActive : ''}
            onClick={() => onFilter(item)}
          >
            {t(`usage_maintenance.history_filter_${item}`, { defaultValue: item })}
            {counts ? (
              <span>
                {item === 'all'
                  ? Object.values(counts).reduce((sum, count) => sum + count, 0)
                  : (counts[item] ?? 0)}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className={styles.recordList}>
        {archiveList.runs.map((run) => (
          <article key={run.id} className={styles.record} data-run-id={run.id}>
            <div>
              <button className={styles.recordTitle} type="button" onClick={() => onOpenRun(run)}>
                {formatTime(run.created_at_ms)}
              </button>
              <p className={styles.hint}>
                {t('usage_maintenance.cutoff', { defaultValue: 'Archive events before' })}{' '}
                {formatTime(run.cutoff_timestamp_ms)}
              </p>
            </div>
            <div className={styles.recordCounts}>
              <span>
                {t('usage_maintenance.archived_count', { defaultValue: 'Archived' })}{' '}
                <strong>{run.archived_event_count.toLocaleString(i18n.language)}</strong>
              </span>
              <span>
                {t('usage_maintenance.deleted_events', { defaultValue: 'Cleaned up' })}{' '}
                <strong>{run.deleted_event_count.toLocaleString(i18n.language)}</strong>
              </span>
            </div>
            <span className={styles.pill} data-status={run.status}>
              {archiveStatuses.has(run.status)
                ? t(`usage_maintenance.run_status_${run.status}`, { defaultValue: run.status })
                : run.status}
            </span>
            <div className={styles.actions}>
              <Button size="sm" variant="ghost" onClick={() => onOpenRun(run)}>
                {t('usage_maintenance.details', { defaultValue: 'Details' })}
              </Button>
              <RunActions run={run} {...actions} />
            </div>
          </article>
        ))}
      </div>
      {!loading && archiveList.runs.length === 0 ? (
        <p className={styles.empty}>{t('usage_maintenance.no_runs')}</p>
      ) : null}
      <div className={styles.pagination}>
        <Button
          size="sm"
          variant="secondary"
          disabled={!canGoBack || loading}
          onClick={onPreviousPage}
        >
          {t('common.previous', { defaultValue: 'Previous' })}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!archiveList.next_cursor || loading}
          onClick={onNextPage}
        >
          {t('common.next', { defaultValue: 'Next' })}
        </Button>
      </div>
    </section>
  );
}

type RunViewProps = Actions & {
  archive: UsageArchiveStatus;
  active: boolean;
  maintenance: UsageMaintenanceStatus;
  intent?: MaintenanceIntent;
  details?: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onStopWaiting: () => void;
  onOpenDetails?: () => void;
};

export function UsageArchiveRunView({
  archive,
  active,
  maintenance,
  intent = 'archive',
  details = false,
  onBack,
  onRefresh,
  onStopWaiting,
  onOpenDetails,
  ...actions
}: RunViewProps) {
  const { t, i18n } = useTranslation();
  const run = archive.run;
  const formatTime = (value?: number) =>
    value ? formatDateTime(new Date(value), i18n.language) : '—';
  const statusLabel = (value: string) =>
    archiveStatuses.has(value)
      ? t(`usage_maintenance.run_status_${value}`, { defaultValue: value })
      : value;
  const modeLabel =
    run.mode === 'manual' || run.mode === 'retention'
      ? t(`usage_maintenance.run_mode_${run.mode}`, { defaultValue: run.mode })
      : run.mode;
  const deleting =
    run.status === 'deleting' || run.resume_status === 'deleting' || run.status === 'completed';
  const progress = deleting
    ? resolveProgressPercent(run.deleted_event_count, run.event_count)
    : run.status === 'archiving' || run.resume_status === 'archiving'
      ? resolveProgressPercent(run.archived_event_count, run.event_count)
      : null;
  const action = getArchiveRunAction(run.status);
  const disabledReason = action ? actions.actionTitle(run, action) : undefined;
  const steps =
    deleting || intent === 'cleanup' ? ['archive', 'verify', 'delete'] : ['archive', 'verify'];
  const stepOrder = deleting
    ? run.status === 'completed'
      ? 4
      : 3
    : run.status === 'verified'
      ? 3
      : run.status === 'verifying' || run.status === 'archived' || run.resume_status === 'verifying'
        ? 2
        : 1;

  return (
    <div className={styles.view}>
      <section className={styles.card}>
        <div className={styles.runHeader}>
          <div>
            <h2>
              {run.status === 'verified'
                ? intent === 'cleanup'
                  ? t('usage_maintenance.workspace_ready_cleanup', {
                      defaultValue: 'Archive verified. Review cleanup next.',
                    })
                  : t('usage_maintenance.workspace_archive_done', {
                      defaultValue: 'Archive complete. Online details are still available.',
                    })
                : run.status === 'completed'
                  ? t('usage_maintenance.cleanup_complete_title', {
                      defaultValue: 'Online detail cleanup complete',
                    })
                  : t('usage_maintenance.workspace_current', { defaultValue: 'Current operation' })}
            </h2>
            <p>{formatTime(run.created_at_ms)}</p>
          </div>
          <span className={styles.pill} data-status={run.status}>
            {statusLabel(run.status)}
          </span>
        </div>
        <ol
          className={styles.stepper}
          aria-label={t('usage_maintenance.run_steps_label', {
            defaultValue: 'Archive workflow progress',
          })}
        >
          {steps.map((step, index) => (
            <li
              key={step}
              data-complete={stepOrder > index + 1}
              aria-current={
                stepOrder === index + 1 && run.status !== 'failed' && run.status !== 'cancelled'
                  ? 'step'
                  : undefined
              }
            >
              <span>{stepOrder > index + 1 ? '✓' : index + 1}</span>
              {t(`usage_maintenance.guided_step_${step}`)}
            </li>
          ))}
        </ol>
        <p className={styles.scope}>
          <strong>
            {t('usage_maintenance.cutoff', { defaultValue: 'Archive events before' })}
          </strong>{' '}
          {formatTime(run.cutoff_timestamp_ms)}
        </p>
        <dl className={styles.runCounts}>
          <div>
            <dt>
              {t('usage_maintenance.workspace_record_count', {
                defaultValue: 'Events in this record',
              })}
            </dt>
            <dd>{run.event_count.toLocaleString(i18n.language)}</dd>
          </div>
          <div>
            <dt>{t('usage_maintenance.archived_count', { defaultValue: 'Archived' })}</dt>
            <dd>{run.archived_event_count.toLocaleString(i18n.language)}</dd>
          </div>
          <div>
            <dt>{t('usage_maintenance.deleted_events', { defaultValue: 'Cleaned up' })}</dt>
            <dd>{run.deleted_event_count.toLocaleString(i18n.language)}</dd>
          </div>
        </dl>
        {progress !== null ? (
          <div className={styles.progress}>
            <div>
              {t(
                deleting
                  ? 'usage_maintenance.workspace_delete_progress'
                  : 'usage_maintenance.workspace_archive_progress',
                { defaultValue: deleting ? 'Cleanup progress' : 'Archive progress' }
              )}{' '}
              <strong>{progress.toFixed(1)}%</strong>
            </div>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-label={t(
                deleting
                  ? 'usage_maintenance.workspace_delete_progress'
                  : 'usage_maintenance.workspace_archive_progress'
              )}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
            >
              <i style={{ width: `${progress}%` }} />
            </div>
          </div>
        ) : null}
        {run.status === 'verified' ? (
          <p className={styles.hint}>
            {t('usage_maintenance.workspace_existing_scope', {
              defaultValue:
                'Cleanup applies to this entire archive record. It is separate from the range selected for a new archive.',
            })}
          </p>
        ) : null}
        {run.status === 'failed' ? (
          <p className={styles.warning}>
            {t('usage_maintenance.resume_detail_note', {
              defaultValue: 'Continue the failed stage of this operation.',
            })}
          </p>
        ) : null}
        {disabledReason ? <p className={styles.warning}>{disabledReason}</p> : null}
        <div className={styles.actions}>
          <RunActions run={run} {...actions} />
          {actions.working ? (
            <Button size="sm" variant="secondary" onClick={onStopWaiting}>
              {t('usage_maintenance.archive_prepare_stop', { defaultValue: 'Stop waiting' })}
            </Button>
          ) : null}
          {onOpenDetails ? (
            <Button size="sm" variant="ghost" onClick={onOpenDetails}>
              {t('usage_maintenance.details', { defaultValue: 'Details' })}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onRefresh} disabled={actions.working}>
            {t('common.refresh')}
          </Button>
          {!details ? (
            <Button size="sm" variant="ghost" onClick={onBack} disabled={actions.working}>
              {t('usage_maintenance.workspace_new', { defaultValue: 'New operation' })}
            </Button>
          ) : null}
        </div>
        {active || actions.working ? (
          <p className={styles.hint}>
            {t('usage_maintenance.stop_waiting_note', {
              defaultValue:
                'Stopping the browser wait leaves the current server job running. Reopen this record to check its state and continue any remaining stages.',
            })}
          </p>
        ) : null}
      </section>
      {details ? (
        <details className={styles.card} open>
          <summary>
            {t('usage_maintenance.workspace_technical', { defaultValue: 'Technical details' })}
          </summary>
          <dl className={styles.keyValues}>
            <div>
              <dt>{t('usage_maintenance.technical_run_id')}</dt>
              <dd className={styles.mono}>{run.id}</dd>
            </div>
            <div>
              <dt>{t('usage_maintenance.technical_mode')}</dt>
              <dd>{modeLabel}</dd>
            </div>
            <div>
              <dt>{t('usage_maintenance.technical_resume_status')}</dt>
              <dd>{run.resume_status ? statusLabel(run.resume_status) : '—'}</dd>
            </div>
            <div>
              <dt>{t('usage_maintenance.preview_target_event')}</dt>
              <dd>{run.target_event_id.toLocaleString(i18n.language)}</dd>
            </div>
            <div>
              <dt>{t('usage_maintenance.uncompressed_size')}</dt>
              <dd>{formatFileSize(run.archived_uncompressed_bytes)}</dd>
            </div>
            <div>
              <dt>{t('usage_maintenance.compressed_size')}</dt>
              <dd>{formatFileSize(run.archived_compressed_bytes)}</dd>
            </div>
            <div>
              <dt>{t('usage_maintenance.verified_at')}</dt>
              <dd>{formatTime(run.verified_at_ms)}</dd>
            </div>
            <div>
              <dt>{t('usage_maintenance.updated_at')}</dt>
              <dd>{formatTime(run.updated_at_ms)}</dd>
            </div>
            {maintenance.active_lock ? (
              <div>
                <dt>{t('usage_maintenance.lock_title')}</dt>
                <dd>
                  {maintenance.active_lock.operation} · {maintenance.active_lock.run_id}
                </dd>
              </div>
            ) : null}
          </dl>
          <h3>{t('usage_maintenance.segment_summary', { defaultValue: 'Segment summary' })}</h3>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('usage_maintenance.technical_status')}</th>
                  <th>{t('usage_maintenance.technical_event_ids')}</th>
                  <th>{t('usage_maintenance.preview_range')}</th>
                  <th>{t('usage_maintenance.workspace_record_count')}</th>
                  <th>{t('usage_maintenance.uncompressed_size')}</th>
                  <th>{t('usage_maintenance.compressed_size')}</th>
                  <th>{t('usage_maintenance.verified_at')}</th>
                </tr>
              </thead>
              <tbody>
                {archive.segments.map((segment) => (
                  <tr key={segment.sequence}>
                    <td>{segment.sequence}</td>
                    <td>{statusLabel(segment.status)}</td>
                    <td>
                      {segment.first_event_id.toLocaleString(i18n.language)} –{' '}
                      {segment.last_event_id.toLocaleString(i18n.language)}
                    </td>
                    <td>
                      {formatTime(segment.min_timestamp_ms)} –{' '}
                      {formatTime(segment.max_timestamp_ms)}
                    </td>
                    <td>{segment.event_count.toLocaleString(i18n.language)}</td>
                    <td>{formatFileSize(segment.uncompressed_bytes)}</td>
                    <td>{formatFileSize(segment.compressed_bytes)}</td>
                    <td>{formatTime(segment.verified_at_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {archive.segments.length === 0 ? (
            <p className={styles.hint}>{t('usage_maintenance.no_segments')}</p>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
