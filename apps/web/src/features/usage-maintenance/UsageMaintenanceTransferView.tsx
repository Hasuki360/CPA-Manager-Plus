import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import {
  UsageImportProgressActions,
  UsageImportProgressView,
} from '@/components/usage/UsageImportProgressView';
import {
  getUsageServiceErrorCode,
  usageServiceApi,
  type UsageExportResponse,
  type UsageImportResponse,
  type UsageImportSession,
  type UsageImportSessionList,
  type UsageImportSessionStatus,
} from '@/services/api/usageService';
import { useNotificationStore } from '@/stores';
import { downloadBlob } from '@/utils/download';
import { formatDateTime, formatFileSize } from '@/utils/format';
import {
  cancelUsageImportFile,
  isUsageImportCancelledError,
  isUsageImportPausedError,
  uploadUsageImportFile,
  UsageImportFailedError,
  type UsageImportProgress,
} from '@/features/monitoring/services/usageImportSession';
import { isUsageImportFile } from '@/utils/usageImport';
import styles from './UsageMaintenanceTransferView.module.scss';

type Props = {
  serviceBase: string;
  managementKey?: string;
};

type ActiveTask = {
  file: File;
  progress: UsageImportProgress;
};

const activeStatuses = new Set<UsageImportSessionStatus>(['uploading', 'ready', 'processing']);
const resumableStatuses = new Set<UsageImportSessionStatus>(['uploading', 'ready']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isImportSession = (value: unknown): value is UsageImportSession => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.filename === 'string' &&
    typeof value.status === 'string' &&
    isFiniteNumber(value.size_bytes) &&
    isFiniteNumber(value.received_bytes) &&
    isFiniteNumber(value.chunk_size_bytes) &&
    isFiniteNumber(value.created_at_ms) &&
    isFiniteNumber(value.updated_at_ms) &&
    isFiniteNumber(value.expires_at_ms)
  );
};

const isImportSessionList = (value: unknown): value is UsageImportSessionList => {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return false;
  return (
    value.sessions.every(isImportSession) &&
    isFiniteNumber(value.total) &&
    isFiniteNumber(value.active_sessions) &&
    isFiniteNumber(value.max_sessions) &&
    isFiniteNumber(value.chunk_size_bytes) &&
    isFiniteNumber(value.disk_quota_bytes) &&
    isFiniteNumber(value.ttl_seconds)
  );
};

const progressPercent = (session: UsageImportSession) => {
  if (session.size_bytes <= 0) return 0;
  return Math.min(
    100,
    Math.max(0, Math.floor((session.received_bytes / session.size_bytes) * 100))
  );
};

const formatTTL = (
  seconds: number,
  t: (key: string, options?: Record<string, unknown>) => string
) => {
  const hours = Math.max(0, Math.round(seconds / 3600));
  return t('usage_maintenance.transfer_hours', { defaultValue: '{{hours}}h', hours });
};

const formatImportError = (
  error: unknown,
  t: (key: string, options?: Record<string, unknown>) => string
) => {
  const code = getUsageServiceErrorCode(error);
  const keyByCode: Record<string, string> = {
    usage_import_session_too_large: 'transfer_error_too_large',
    usage_import_session_quota_exceeded: 'transfer_error_quota',
    usage_import_session_limit_exceeded: 'transfer_error_limit',
    usage_import_session_conflict: 'transfer_error_conflict',
    usage_import_session_file_mismatch: 'transfer_error_file_mismatch',
    usage_import_session_not_found: 'transfer_error_not_found',
    usage_import_session_invalid_request: 'transfer_error_invalid',
  };
  return t(`usage_maintenance.${keyByCode[code] ?? 'transfer_error_generic'}`, {
    defaultValue:
      keyByCode[code] === 'transfer_error_too_large'
        ? 'The selected file exceeds the Manager Server disk quota.'
        : keyByCode[code] === 'transfer_error_quota'
          ? 'The Manager Server import disk quota is currently reserved by other sessions.'
          : keyByCode[code] === 'transfer_error_limit'
            ? 'The maximum number of active import sessions has been reached.'
            : keyByCode[code] === 'transfer_error_conflict'
              ? 'The selected file does not match the resumable session.'
              : keyByCode[code] === 'transfer_error_file_mismatch'
                ? 'The selected file does not match the uploaded session prefix. Choose the original file or start a new import.'
                : keyByCode[code] === 'transfer_error_not_found'
                  ? 'The resumable session has expired or no longer exists.'
                  : keyByCode[code] === 'transfer_error_invalid'
                    ? 'The import request is invalid.'
                    : 'The import request could not be completed.',
  });
};

const resultSummary = (
  result: UsageImportResponse | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
) => {
  if (!result) return t('usage_maintenance.transfer_result_pending', { defaultValue: '—' });
  return t('usage_maintenance.transfer_result_summary', {
    defaultValue:
      'added {{added}} · skipped {{skipped}} · failed {{failed}} · unsupported {{unsupported}} · warnings {{warnings}}',
    added: result.added ?? 0,
    skipped: result.skipped ?? 0,
    failed: result.failed ?? 0,
    unsupported: result.unsupported ?? 0,
    warnings: result.warnings?.length ?? 0,
  });
};

const statusTone = (status: UsageImportSessionStatus) => {
  if (status === 'completed') return styles.success;
  if (status === 'failed') return styles.danger;
  if (status === 'cancelled') return styles.neutral;
  return styles.info;
};

export function UsageMaintenanceTransferView({ serviceBase, managementKey }: Props) {
  const { t, i18n } = useTranslation();
  const { showConfirmation, showNotification } = useNotificationStore();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingSessionIdRef = useRef<string | undefined>(undefined);
  const operationRef = useRef<AbortController | null>(null);
  const operationIDRef = useRef(0);
  const mountedRef = useRef(false);
  const contextGenerationRef = useRef(0);
  const sessionRequestRef = useRef<AbortController | null>(null);
  const sessionRequestIDRef = useRef(0);
  const [cancelPending, setCancelPending] = useState(false);
  const [sessionList, setSessionList] = useState<UsageImportSessionList | null>(null);
  const [activeTask, setActiveTask] = useState<ActiveTask | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    mountedRef.current = true;
    contextGenerationRef.current += 1;
    setActiveTask(null);
    setSelectedSessionId(null);
    setSessionList(null);
    setLoading(true);
    setCancelPending(false);
    setExporting(false);
    return () => {
      mountedRef.current = false;
      contextGenerationRef.current += 1;
      operationIDRef.current += 1;
      operationRef.current?.abort();
    };
  }, [managementKey, serviceBase]);

  const loadSessions = useCallback(
    async (background = false) => {
      if (!serviceBase) return;
      const requestID = ++sessionRequestIDRef.current;
      sessionRequestRef.current?.abort();
      const controller = new AbortController();
      sessionRequestRef.current = controller;
      if (background) setRefreshing(true);
      else setLoading(true);
      try {
        const result = await usageServiceApi.listUsageImportSessions(
          serviceBase,
          managementKey,
          {
            limit: 20,
          },
          controller.signal
        );
        if (requestID !== sessionRequestIDRef.current) return;
        if (!isImportSessionList(result)) {
          throw new Error('invalid import session response');
        }
        setSessionList(result);
        setError(null);
      } catch (cause) {
        if (controller.signal.aborted || requestID !== sessionRequestIDRef.current) return;
        setError(formatImportError(cause, t));
      } finally {
        if (requestID === sessionRequestIDRef.current) {
          if (background) setRefreshing(false);
          else setLoading(false);
          sessionRequestRef.current = null;
        }
      }
    },
    [managementKey, serviceBase, t]
  );

  useEffect(() => {
    void loadSessions();
    return () => {
      operationIDRef.current += 1;
      operationRef.current?.abort();
      operationRef.current = null;
      sessionRequestIDRef.current += 1;
      sessionRequestRef.current?.abort();
      sessionRequestRef.current = null;
    };
  }, [loadSessions]);

  const shouldPoll = Boolean(
    activeTask?.progress.phase === 'processing' ||
    sessionList?.sessions.some((session) => activeStatuses.has(session.status))
  );

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = globalThis.setInterval(() => void loadSessions(true), 5_000);
    return () => globalThis.clearInterval(timer);
  }, [loadSessions, shouldPoll]);

  const updateProgress = useCallback((file: File, progress: UsageImportProgress) => {
    setActiveTask((current) =>
      current?.file === file && current.progress.phase === 'cancelled'
        ? current
        : { file, progress }
    );
  }, []);

  const runImport = useCallback(
    async (file: File, sessionId?: string) => {
      if (!isUsageImportFile(file)) {
        showNotification(
          t('usage_maintenance.transfer_invalid_file', {
            defaultValue: 'Choose a JSONL, JSON, NDJSON, or text usage export.',
          }),
          'error'
        );
        return;
      }
      operationRef.current?.abort();
      const controller = new AbortController();
      operationRef.current = controller;
      const operationID = ++operationIDRef.current;
      setActiveTask({
        file,
        progress: {
          sessionId: sessionId ?? '',
          filename: file.name,
          phase: 'preparing',
          uploadedBytes: 0,
          totalBytes: file.size,
          percent: 0,
        },
      });
      try {
        const result = await uploadUsageImportFile({
          base: serviceBase,
          managementKey,
          file,
          sessionId,
          signal: controller.signal,
          onProgress: (progress) => {
            if (operationID === operationIDRef.current) updateProgress(file, progress);
          },
        });
        if (operationID !== operationIDRef.current) return;
        showNotification(
          t('usage_maintenance.transfer_import_success', {
            defaultValue:
              'Import complete: added {{added}}, skipped {{skipped}}, failed {{failed}}.',
            added: result.added ?? 0,
            skipped: result.skipped ?? 0,
            failed: result.failed ?? 0,
          }),
          (result.failed ?? 0) > 0 || (result.unsupported ?? 0) > 0 ? 'warning' : 'success'
        );
        await loadSessions(true);
      } catch (cause) {
        if (operationID !== operationIDRef.current) return;
        if (!isUsageImportPausedError(cause) && !isUsageImportCancelledError(cause)) {
          const retryable = cause instanceof UsageImportFailedError ? cause.retryable : true;
          setActiveTask((current) =>
            current?.file === file
              ? {
                  ...current,
                  progress: {
                    ...current.progress,
                    phase: 'failed',
                    error: formatImportError(cause, t),
                    retryable,
                  },
                }
              : current
          );
          showNotification(formatImportError(cause, t), 'error');
        }
        await loadSessions(true);
      } finally {
        if (operationID === operationIDRef.current) {
          operationRef.current = null;
        }
      }
    },
    [loadSessions, managementKey, serviceBase, showNotification, t, updateProgress]
  );

  const selectFile = useCallback(
    (file: File, sessionId?: string) => {
      const generation = contextGenerationRef.current;
      pendingSessionIdRef.current = sessionId;
      showConfirmation({
        title: sessionId
          ? t('usage_maintenance.transfer_resume_confirm_title', {
              defaultValue: 'Resume this import session?',
            })
          : t('usage_maintenance.transfer_import_confirm_title', {
              defaultValue: 'Import usage data?',
            }),
        message: t('usage_maintenance.transfer_import_confirm_message', {
          defaultValue:
            'Import {{name}}? Recognized duplicates will be skipped. Resume interrupted uploads with the original file.',
          name: file.name,
        }),
        confirmText: t('usage_maintenance.transfer_import_confirm_button', {
          defaultValue: sessionId ? 'Resume upload' : 'Start import',
        }),
        variant: 'primary',
        onConfirm: () => {
          if (!mountedRef.current || generation !== contextGenerationRef.current) return;
          pendingSessionIdRef.current = undefined;
          void runImport(file, sessionId);
        },
        onCancel: () => {
          pendingSessionIdRef.current = undefined;
        },
      });
    },
    [runImport, showConfirmation, t]
  );

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const sessionId = pendingSessionIdRef.current;
    pendingSessionIdRef.current = undefined;
    event.target.value = '';
    if (file) selectFile(file, sessionId);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    pendingSessionIdRef.current = undefined;
    const file = event.dataTransfer.files?.[0];
    if (file) selectFile(file);
  };

  const openFilePicker = () => {
    pendingSessionIdRef.current = undefined;
    inputRef.current?.click();
  };

  const handleExport = async () => {
    const generation = contextGenerationRef.current;
    setExporting(true);
    try {
      const response: UsageExportResponse = await usageServiceApi.exportUsage(
        serviceBase,
        managementKey
      );
      if (!mountedRef.current || generation !== contextGenerationRef.current) return;
      downloadBlob({ filename: response.filename || 'usage-events.jsonl', blob: response.blob });
      showNotification(
        t('usage_maintenance.transfer_export_success', {
          defaultValue: 'Sanitized usage JSONL export downloaded.',
        }),
        'success'
      );
    } catch (cause) {
      if (!mountedRef.current || generation !== contextGenerationRef.current) return;
      showNotification(formatImportError(cause, t), 'error');
    } finally {
      if (mountedRef.current && generation === contextGenerationRef.current) setExporting(false);
    }
  };

  const pauseImport = () => {
    operationRef.current?.abort();
  };

  const cancelImport = async () => {
    const generation = contextGenerationRef.current;
    const task = activeTask;
    if (!task?.progress.sessionId || cancelPending) return;
    setCancelPending(true);
    operationRef.current?.abort();
    try {
      const result = await cancelUsageImportFile({
        base: serviceBase,
        managementKey,
        sessionId: task.progress.sessionId,
        file: task.file,
      });
      if (!mountedRef.current || generation !== contextGenerationRef.current) return;
      if (result) {
        setActiveTask((current) =>
          current?.file === task.file
            ? {
                ...current,
                progress: {
                  ...current.progress,
                  sessionId: result.id,
                  filename: result.filename,
                  phase: 'cancelled',
                  status: result.status,
                  uploadedBytes: result.received_bytes,
                  totalBytes: result.size_bytes,
                  percent: progressPercent(result),
                  result: result.result,
                },
              }
            : current
        );
      }
      showNotification(
        t('usage_maintenance.transfer_cancelled', { defaultValue: 'Import session cancelled.' }),
        'success'
      );
      await loadSessions(true);
    } catch (cause) {
      if (!mountedRef.current || generation !== contextGenerationRef.current) return;
      showNotification(formatImportError(cause, t), 'error');
    } finally {
      if (mountedRef.current && generation === contextGenerationRef.current)
        setCancelPending(false);
    }
  };

  const activeSession = useMemo(
    () =>
      activeTask?.progress.sessionId
        ? sessionList?.sessions.find((session) => session.id === activeTask.progress.sessionId)
        : undefined,
    [activeTask?.progress.sessionId, sessionList?.sessions]
  );

  const handleSessionAction = (session: UsageImportSession) => {
    const task = activeTask;
    const current = activeTask?.progress;
    if (current?.sessionId === session.id) {
      if (
        current.phase === 'paused' ||
        (current.phase === 'failed' && current.retryable !== false)
      ) {
        if (task) void runImport(task.file, session.id);
      } else if (current.phase === 'uploading' || current.phase === 'processing') {
        pauseImport();
      }
      return;
    }
    if (session.status === 'processing') {
      void loadSessions(true);
      return;
    }
    if (
      resumableStatuses.has(session.status) ||
      (session.status === 'failed' && session.retryable)
    ) {
      pendingSessionIdRef.current = session.id;
      inputRef.current?.click();
    }
  };

  const statusLabel = (status: UsageImportSessionStatus) =>
    t(`usage_maintenance.transfer_status_${status}`, { defaultValue: status });

  const sessionActionLabel = (session: UsageImportSession) => {
    if (activeTask?.progress.sessionId === session.id) {
      if (
        activeTask.progress.phase === 'paused' ||
        (activeTask.progress.phase === 'failed' && activeTask.progress.retryable !== false)
      ) {
        return t('usage_maintenance.transfer_resume', { defaultValue: 'Resume upload' });
      }
      if (activeTask.progress.phase === 'uploading' || activeTask.progress.phase === 'processing') {
        return t('usage_maintenance.transfer_pause', { defaultValue: 'Pause' });
      }
    }
    if (session.status === 'processing') {
      return t('common.refresh', { defaultValue: 'Refresh' });
    }
    if (session.status === 'failed' && session.retryable) {
      return t('common.retry', { defaultValue: 'Retry' });
    }
    if (
      resumableStatuses.has(session.status) ||
      (session.status === 'failed' && session.retryable)
    ) {
      return t('usage_maintenance.transfer_resume', { defaultValue: 'Continue upload' });
    }
    return t('usage_maintenance.details', { defaultValue: 'Details' });
  };

  const sessionHasAction = (session: UsageImportSession) =>
    session.status === 'processing' ||
    resumableStatuses.has(session.status) ||
    (session.status === 'failed' && session.retryable === true);

  if (loading && !sessionList) {
    return (
      <div className={styles.loading}>{t('common.loading', { defaultValue: 'Loading…' })}</div>
    );
  }

  const sessions = sessionList?.sessions ?? [];
  const activeProgress = activeTask?.progress;
  const activeProgressSession = activeProgress?.sessionId
    ? sessions.find((session) => session.id === activeProgress.sessionId)
    : activeSession;

  return (
    <div className={styles.view}>
      <header className={styles.pageHeader}>
        <div>
          <h2>
            {t('usage_maintenance.transfer_page_title', { defaultValue: 'Import / export usage' })}
          </h2>
          <p>
            {t('usage_maintenance.transfer_page_subtitle', {
              defaultValue: 'Move online usage data with resumable imports and JSONL exports.',
            })}
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadSessions(true)}
            disabled={refreshing}
          >
            {t('common.refresh', { defaultValue: 'Refresh' })}
          </Button>
        </div>
      </header>

      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      {activeProgress ? (
        <div className={styles.activeCard} aria-live="polite">
          <UsageImportProgressView progress={activeProgress} />
          <UsageImportProgressActions
            progress={activeProgress}
            busy={cancelPending}
            onPause={pauseImport}
            onCancel={() => void cancelImport()}
            onResume={() => {
              if (activeTask)
                void runImport(activeTask.file, activeProgress.sessionId || undefined);
            }}
          />
        </div>
      ) : null}

      {activeProgressSession?.result ? (
        <div className={styles.resultCard}>
          <strong>
            {t('usage_maintenance.transfer_last_result', { defaultValue: 'Latest result' })}
          </strong>
          <span>{resultSummary(activeProgressSession.result, t)}</span>
          {(activeProgressSession.result.unsupported ?? 0) > 0 ? (
            <span>
              {t('usage_maintenance.transfer_unsupported_count', {
                defaultValue: '{{count}} unsupported',
                count: activeProgressSession.result.unsupported,
              })}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className={styles.layout}>
        <div className={styles.leftColumn}>
          <section className={styles.card}>
            <div className={styles.sectionHeader}>
              <h2>
                {t('usage_maintenance.transfer_import_title', { defaultValue: 'Import usage' })}
              </h2>
              <span className={`${styles.pill} ${styles.info}`}>
                {t('usage_maintenance.transfer_resumable', { defaultValue: 'Resumable' })}
              </span>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".json,.jsonl,.ndjson,.txt,application/json,application/x-ndjson,text/plain"
              className={styles.hiddenInput}
              onChange={handleFileChange}
            />
            <div
              className={`${styles.uploadBox} ${dragging ? styles.uploadBoxDragging : ''}`}
              role="button"
              tabIndex={0}
              onClick={openFilePicker}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openFilePicker();
                }
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              <span className={styles.cloud} aria-hidden="true">
                ☁
              </span>
              <strong>
                {t('usage_maintenance.transfer_drop_title', {
                  defaultValue: 'Drop a file here, or choose a file',
                })}
              </strong>
              <span>
                {t('usage_maintenance.transfer_supported_formats', {
                  defaultValue: 'JSONL, JSON arrays and earlier usage exports',
                })}
              </span>
              <small>
                {t('usage_maintenance.transfer_chunk_note', {
                  defaultValue:
                    'Server import quota: {{quota}}. Choose the original file to resume an interrupted upload.',
                  quota: formatFileSize(sessionList?.disk_quota_bytes ?? 0),
                })}
              </small>
            </div>
            <details className={styles.uploadDetails}>
              <summary>
                {t('usage_maintenance.transfer_upload_details', {
                  defaultValue: 'Upload limits and technical details',
                })}
              </summary>
              <div className={styles.statGrid}>
                <div className={styles.statBox}>
                  <span>
                    {t('usage_maintenance.transfer_chunk', { defaultValue: 'Upload chunk size' })}
                  </span>
                  <strong>{formatFileSize(sessionList?.chunk_size_bytes ?? 0)}</strong>
                </div>
                <div className={styles.statBox}>
                  <span>
                    {t('usage_maintenance.transfer_disk_quota', { defaultValue: 'Disk quota' })}
                  </span>
                  <strong>{formatFileSize(sessionList?.disk_quota_bytes ?? 0)}</strong>
                </div>
                <div className={styles.statBox}>
                  <span>
                    {t('usage_maintenance.transfer_concurrent', {
                      defaultValue: 'Active sessions',
                    })}
                  </span>
                  <strong>
                    {sessionList
                      ? `${sessionList.active_sessions} / ${sessionList.max_sessions}`
                      : '—'}
                  </strong>
                </div>
                <div className={styles.statBox}>
                  <span>
                    {t('usage_maintenance.transfer_expires', { defaultValue: 'Session lifetime' })}
                  </span>
                  <strong>{formatTTL(sessionList?.ttl_seconds ?? 0, t)}</strong>
                </div>
              </div>
            </details>
            <p className={styles.infoNote}>
              {t('usage_maintenance.transfer_dedupe_note', {
                defaultValue:
                  'Imports match records using identifiers in the file and skip recognized duplicates. Choose the original file to resume an upload.',
              })}
            </p>
          </section>

          <section className={styles.card}>
            <h2>
              {t('usage_maintenance.transfer_export_title', { defaultValue: 'Export usage' })}
            </h2>
            <p>
              {t('usage_maintenance.transfer_export_note', {
                defaultValue:
                  'Export a sanitized JSONL snapshot of all current online details. It excludes archived details already cleaned up and does not replace a complete disaster-recovery backup.',
              })}
            </p>
            <Button onClick={() => void handleExport()} loading={exporting}>
              ⇩{' '}
              {t('usage_maintenance.transfer_export_button', {
                defaultValue: 'Export sanitized JSONL',
              })}
            </Button>
          </section>
        </div>

        <section className={styles.card}>
          <div className={styles.sectionHeader}>
            <h2>
              {t('usage_maintenance.transfer_sessions_title', { defaultValue: 'Import sessions' })}
            </h2>
            <span className={styles.muted}>
              {t('usage_maintenance.transfer_session_count', {
                defaultValue: 'Current {{current}} / {{total}}',
                current: sessionList?.active_sessions ?? 0,
                total: sessionList?.max_sessions ?? 0,
              })}
            </span>
          </div>

          <div className={styles.sessionList}>
            {sessions.map((session) => (
              <article
                key={session.id}
                data-session-id={session.id}
                className={`${styles.sessionRecord} ${selectedSessionId === session.id ? styles.selectedRecord : ''}`}
              >
                <div className={styles.sessionHeader}>
                  <div>
                    <strong className={styles.filename} title={session.filename}>
                      {session.filename}
                    </strong>
                    <span>
                      {formatFileSize(session.size_bytes)} ·{' '}
                      {formatDateTime(new Date(session.updated_at_ms), i18n.language)}
                    </span>
                  </div>
                  <span className={`${styles.pill} ${statusTone(session.status)}`}>
                    {statusLabel(session.status)}
                  </span>
                </div>
                {session.result || session.status === 'failed' ? (
                  <p className={styles.muted}>
                    {session.status === 'failed'
                      ? session.retryable
                        ? t('usage_maintenance.transfer_retryable', { defaultValue: 'Retryable' })
                        : t('usage_maintenance.transfer_failed', {
                            defaultValue: 'Needs attention',
                          })
                      : resultSummary(session.result, t)}
                  </p>
                ) : null}
                {activeStatuses.has(session.status) ? (
                  <div
                    className={styles.miniProgress}
                    role="progressbar"
                    aria-label={t('usage_stats.import_progress_title')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progressPercent(session)}
                  >
                    <i style={{ width: `${progressPercent(session)}%` }} />
                  </div>
                ) : null}
                <div className={styles.rowActions}>
                  {sessionHasAction(session) ? (
                    <Button
                      size="sm"
                      variant={session.status === 'failed' ? 'primary' : 'secondary'}
                      onClick={() => handleSessionAction(session)}
                    >
                      {sessionActionLabel(session)}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={selectedSessionId === session.id}
                    onClick={() =>
                      setSelectedSessionId(selectedSessionId === session.id ? null : session.id)
                    }
                  >
                    {t('usage_maintenance.details', { defaultValue: 'Details' })}
                  </Button>
                </div>
                {selectedSessionId === session.id ? (
                  <div className={styles.detailCard}>
                    <div>
                      <strong>{session.filename}</strong>
                      <span className={styles.sessionID}>{session.id}</span>
                    </div>
                    <dl>
                      <div>
                        <dt>
                          {t('usage_maintenance.transfer_chunk', { defaultValue: 'Chunk size' })}
                        </dt>
                        <dd>{formatFileSize(session.chunk_size_bytes)}</dd>
                      </div>
                      <div>
                        <dt>
                          {t('usage_maintenance.transfer_expires', { defaultValue: 'Expires' })}
                        </dt>
                        <dd>{formatDateTime(new Date(session.expires_at_ms), i18n.language)}</dd>
                      </div>
                      <div>
                        <dt>
                          {t('usage_maintenance.transfer_retryable_label', {
                            defaultValue: 'Retryable',
                          })}
                        </dt>
                        <dd>
                          {session.retryable
                            ? t('common.yes', { defaultValue: 'Yes' })
                            : t('common.no', { defaultValue: 'No' })}
                        </dd>
                      </div>
                    </dl>
                    {session.result ? <p>{resultSummary(session.result, t)}</p> : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
          {sessions.length === 0 ? (
            <p className={styles.empty}>
              {t('usage_maintenance.transfer_no_sessions', {
                defaultValue: 'No import sessions yet.',
              })}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
