import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import {
  IconCopy,
  IconEye,
  IconEyeOff,
  IconFilter,
  IconSlidersHorizontal,
} from '@/components/ui/icons';
import {
  PaginationControls,
  RecentPattern,
} from '@/features/monitoring/components/MonitoringShared';
import { MonitoringPanel } from '@/features/monitoring/components/MonitoringPanel';
import { formatPercent } from '@/features/monitoring/components/accountOverviewPresentation';
import { buildRealtimeSourceDisplay } from '@/features/monitoring/realtimeSourceDisplay';
import type { MonitoringEventRow } from '@/features/monitoring/hooks/useMonitoringData';
import type { AccountDisplayMode } from '@/features/monitoring/accountOverviewState';
import { useNotificationStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import { maskSensitiveText, truncateText } from '@/utils/format';
import { formatCompactNumber, formatUsd } from '@/utils/usage';
import styles from '../MonitoringCenterPage.module.scss';

type RealtimeLogRow = MonitoringEventRow & {
  requestCount: number;
  successRate: number;
  streamKey: string;
  recentPattern: boolean[];
};

type PaginationState<T> = {
  currentPage: number;
  totalPages: number;
  pageItems: T[];
  startItem: number;
  endItem: number;
};

type RealtimeEventsPanelProps = {
  embedded?: boolean;
  rows: RealtimeLogRow[];
  pagination: PaginationState<RealtimeLogRow>;
  pageSize: number;
  scopedFailureCount: number;
  failedOnlyActive: boolean;
  eventsHasMore: boolean;
  eventsLoadingMore: boolean;
  eventsTotalCount: number;
  eventsLoadedCount: number;
  overallLoading: boolean;
  hasPrices: boolean;
  accountDisplayMode: AccountDisplayMode;
  locale: string;
  emptyState: ReactNode;
  t: TFunction;
  onToggleFailedOnly: () => void;
  onAccountDisplayModeChange: (mode: AccountDisplayMode) => void;
  visibleColumns: RealtimeVisibleColumnKey[];
  onVisibleColumnsChange: (columns: RealtimeVisibleColumnKey[]) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onLoadMoreEvents: () => void;
};

export type RealtimeEventsPanelActionsProps = {
  rowCount: number;
  scopedFailureCount: number;
  failedOnlyActive: boolean;
  accountDisplayMode: AccountDisplayMode;
  t: TFunction;
  onToggleFailedOnly: () => void;
  onAccountDisplayModeChange: (mode: AccountDisplayMode) => void;
  visibleColumns: RealtimeVisibleColumnKey[];
  onVisibleColumnsChange: (columns: RealtimeVisibleColumnKey[]) => void;
};

const REALTIME_PAGE_SIZE_OPTIONS = [10, 50, 100, 150, 300] as const;
const FAILURE_TOOLTIP_VIEWPORT_MARGIN = 12;
const FAILURE_TOOLTIP_OFFSET = 8;
const FAILURE_TOOLTIP_MAX_WIDTH = 420;
const FAILURE_TOOLTIP_MAX_HEIGHT = 240;
const FAILURE_TOOLTIP_CLOSE_DELAY_MS = 120;

type FailureTooltipPlacement = 'above' | 'below';

export type RealtimeVisibleColumnKey =
  | 'reasoning'
  | 'recent'
  | 'successRate'
  | 'calls'
  | 'tps'
  | 'latency'
  | 'time'
  | 'usage'
  | 'cost';

export const DEFAULT_REALTIME_VISIBLE_COLUMNS: RealtimeVisibleColumnKey[] = [
  'reasoning',
  'recent',
  'successRate',
  'calls',
  'tps',
  'latency',
  'time',
  'usage',
  'cost',
];

const realtimeBaseColumnCount = 3;

type FailureTooltipPosition = {
  placement: FailureTooltipPlacement;
  style: CSSProperties;
};

const formatOptionalText = (value: string | null | undefined) => {
  const trimmed = String(value || '').trim();
  return trimmed || '-';
};

const formatReadableText = (value: string | null | undefined) => {
  const trimmed = String(value || '').trim();
  return trimmed && trimmed !== '-' ? trimmed : '';
};

const shortLabel = (
  t: TFunction,
  shortKey: string,
  fallbackKey: string,
  fallbackDefault?: string
) => {
  const fallback = t(fallbackKey, fallbackDefault ? { defaultValue: fallbackDefault } : undefined);
  const label = t(shortKey, { defaultValue: fallback });
  return label === shortKey ? (fallbackDefault ?? fallback) : label;
};

const formatShortHash = (value: string | null | undefined) => {
  const trimmed = formatReadableText(value);
  return trimmed ? `#${trimmed.slice(0, 8)}` : '';
};

const buildRealtimeColumnOptions = (t: TFunction) =>
  [
    {
      key: 'reasoning',
      label: shortLabel(t, 'monitoring.reasoning_effort_short', 'monitoring.reasoning_effort'),
    },
    {
      key: 'recent',
      label: shortLabel(t, 'monitoring.recent_status_short', 'monitoring.recent_status'),
    },
    {
      key: 'successRate',
      label: shortLabel(
        t,
        'monitoring.column_success_rate_short',
        'monitoring.column_success_rate'
      ),
    },
    {
      key: 'calls',
      label: shortLabel(t, 'monitoring.total_calls_short', 'monitoring.total_calls', 'Calls'),
    },
    {
      key: 'tps',
      label: t('monitoring.column_output_tps'),
    },
    {
      key: 'latency',
      label: `${t('monitoring.ttft_short')} / ${t('monitoring.elapsed_short')}`,
    },
    {
      key: 'time',
      label: t('monitoring.column_time'),
    },
    {
      key: 'usage',
      label: shortLabel(t, 'monitoring.this_call_usage_short', 'monitoring.this_call_usage'),
    },
    {
      key: 'cost',
      label: shortLabel(t, 'monitoring.this_call_cost_short', 'monitoring.this_call_cost'),
    },
  ] satisfies Array<{ key: RealtimeVisibleColumnKey; label: string }>;

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const resolveFailureTooltipPosition = (anchor: HTMLElement): FailureTooltipPosition | null => {
  if (typeof window === 'undefined') return null;

  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxWidth = Math.max(
    220,
    Math.min(
      FAILURE_TOOLTIP_MAX_WIDTH,
      Math.max(0, viewportWidth - FAILURE_TOOLTIP_VIEWPORT_MARGIN * 2)
    )
  );
  const left = clampNumber(
    rect.left,
    FAILURE_TOOLTIP_VIEWPORT_MARGIN,
    Math.max(
      FAILURE_TOOLTIP_VIEWPORT_MARGIN,
      viewportWidth - maxWidth - FAILURE_TOOLTIP_VIEWPORT_MARGIN
    )
  );
  const spaceBelow =
    viewportHeight - rect.bottom - FAILURE_TOOLTIP_VIEWPORT_MARGIN - FAILURE_TOOLTIP_OFFSET;
  const spaceAbove = rect.top - FAILURE_TOOLTIP_VIEWPORT_MARGIN - FAILURE_TOOLTIP_OFFSET;
  const placement: FailureTooltipPlacement =
    spaceBelow >= FAILURE_TOOLTIP_MAX_HEIGHT || spaceBelow >= spaceAbove ? 'below' : 'above';
  const availableHeight = Math.max(0, placement === 'below' ? spaceBelow : spaceAbove);
  const maxHeight = Math.min(FAILURE_TOOLTIP_MAX_HEIGHT, availableHeight);
  const baseStyle: CSSProperties = {
    left,
    maxHeight,
    maxWidth,
  };

  return placement === 'below'
    ? {
        placement,
        style: {
          ...baseStyle,
          top: rect.bottom + FAILURE_TOOLTIP_OFFSET,
        },
      }
    : {
        placement,
        style: {
          ...baseStyle,
          bottom: viewportHeight - rect.top + FAILURE_TOOLTIP_OFFSET,
        },
      };
};

const buildRealtimeApiKeyDisplay = (row: MonitoringEventRow, t: TFunction) => {
  const label = formatReadableText(row.apiKeyLabel);
  const masked = formatReadableText(row.apiKeyMasked);
  const hash = formatReadableText(row.apiKeyHash);
  const shortHash = formatShortHash(hash);
  const display = label || masked || shortHash;

  if (!display) {
    return null;
  }

  const titleParts = [
    `${t('monitoring.realtime_api_key_label')}: ${display}`,
    masked && masked !== display ? `${t('monitoring.realtime_api_key_masked')}: ${masked}` : '',
    hash ? `${t('monitoring.realtime_api_key_hash')}: ${hash}` : '',
    formatReadableText(row.executorType)
      ? `${shortLabel(t, 'monitoring.executor_type_short', 'monitoring.executor_type')}: ${formatReadableText(row.executorType)}`
      : '',
  ].filter(Boolean);

  return {
    display,
    title: titleParts.join('\n'),
  };
};

const formatTokensPerSecond = (value: number | null | undefined, locale: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '--';

  const absValue = Math.abs(value);
  const maximumFractionDigits = absValue < 1 ? 2 : absValue < 10 ? 1 : 0;
  try {
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits,
      minimumFractionDigits: 0,
    }).format(value);
  } catch {
    return value.toFixed(maximumFractionDigits);
  }
};

const formatRealtimeUsageNumber = (value: number, locale: string) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  const normalizedLocale = locale.toLowerCase();
  if (!normalizedLocale.startsWith('zh')) {
    return formatCompactNumber(num);
  }

  const abs = Math.abs(num);
  const formatUnit = (threshold: number, suffix: string) => {
    const formatted = (num / threshold).toFixed(1).replace(/\.0$/, '');
    return `${formatted}${suffix}`;
  };
  if (abs >= 100_000_000) return formatUnit(100_000_000, '亿');
  if (abs >= 10_000) return formatUnit(10_000, '万');
  return abs >= 1 ? num.toFixed(0) : num.toFixed(2);
};

const formatRealtimeCompactDuration = (value: number | null | undefined, locale: string) => {
  if (value === null || value === undefined) return '--';

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return '--';

  const formatNumber = (numberValue: number, maximumFractionDigits: number) => {
    try {
      return new Intl.NumberFormat(locale, {
        maximumFractionDigits,
        minimumFractionDigits: 0,
      }).format(numberValue);
    } catch {
      return numberValue.toFixed(maximumFractionDigits);
    }
  };

  if (parsed < 1000) return `${formatNumber(Math.round(parsed), 0)} ms`;

  const seconds = parsed / 1000;
  return `${formatNumber(seconds, seconds < 10 ? 2 : 1)} s`;
};

const getRealtimeDurationToneClass = (value: number | null | undefined) => {
  if (value === null || value === undefined) return undefined;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;

  if (parsed >= 30000) return styles.badText;
  if (parsed >= 15000) return styles.warnText;
  return styles.goodText;
};

const formatRealtimeDateParts = (timestampMs: number, locale: string) => {
  const date = new Date(timestampMs);
  return {
    date: date.toLocaleDateString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }),
    time: date.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }),
  };
};

const formatHeaderRecoverAt = (value: number | null | undefined, locale: string) => {
  if (!value || !Number.isFinite(value)) return '';
  return new Date(value).toLocaleString(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

const buildHeaderDiagnosticParts = (
  row: MonitoringEventRow,
  t: TFunction,
  locale: string
): string[] => {
  const parts: string[] = [];
  const compactSignal = (label: string, value: string | number | null | undefined, limit = 42) => {
    const normalized =
      typeof value === 'number'
        ? Number.isFinite(value)
          ? String(value)
          : ''
        : formatReadableText(value);
    return normalized ? `${label} ${truncateText(normalized, limit)}` : '';
  };
  const errorCode = row.headerErrorCode || row.responseMetadata?.errors?.code || '';
  const errorKind = row.headerErrorKind || row.responseMetadata?.errors?.kind || '';
  if (errorCode || errorKind) {
    parts.push(
      `${t('monitoring.header_error')}: ${[errorKind, errorCode].filter(Boolean).join(' / ')}`
    );
  }
  const traceId = row.headerTraceId || row.responseMetadata?.trace?.primary_trace_id || '';
  if (traceId) {
    parts.push(`${t('monitoring.header_trace')}: ${truncateText(traceId, 42)}`);
  }
  const quotaParts: string[] = [];
  const planType =
    row.headerQuotaPlanType ||
    row.responseMetadata?.quota?.plan_type ||
    row.responseMetadata?.quota?.active_limit ||
    '';
  if (planType) quotaParts.push(planType);
  const usedPercent =
    row.headerQuotaUsedPercent ?? row.responseMetadata?.quota?.used_percent ?? null;
  if (typeof usedPercent === 'number' && Number.isFinite(usedPercent)) {
    quotaParts.push(formatPercent(usedPercent / 100));
  }
  const recoverAt = formatHeaderRecoverAt(
    row.headerQuotaRecoverAtMs ?? row.responseMetadata?.quota?.recover_at_ms,
    locale
  );
  if (recoverAt) {
    quotaParts.push(`${t('monitoring.header_recover_at')} ${recoverAt}`);
  }
  if (quotaParts.length > 0) {
    parts.push(`${t('monitoring.header_quota')}: ${quotaParts.join(' · ')}`);
  }
  const routing = row.responseMetadata?.routing;
  const routingParts = [
    compactSignal('server', routing?.server),
    compactSignal('via', routing?.via),
    compactSignal('cf', routing?.cf_cache_status),
    compactSignal('site', routing?.site_cache_status),
    compactSignal('mife', routing?.mife_upstream_status),
  ].filter(Boolean);
  if (routingParts.length > 0) {
    parts.push(
      `${t('monitoring.header_routing', { defaultValue: 'Routing' })}: ${routingParts.join(' · ')}`
    );
  }
  const providers = row.responseMetadata?.providers;
  const providerParts = [
    compactSignal('antigravity', providers?.antigravity_trace_id),
    compactSignal('oneapi', providers?.oneapi_request_id),
    compactSignal('cf-ray', providers?.cloudflare_ray),
    compactSignal('cf-cache', providers?.cloudflare_cache_status),
  ].filter(Boolean);
  if (providerParts.length > 0) {
    parts.push(
      `${t('monitoring.header_provider', { defaultValue: 'Provider' })}: ${providerParts.join(' · ')}`
    );
  }
  const response = row.responseMetadata?.response;
  const contentType = response?.content_type || '';
  const responseParts = [
    row.failed && contentType && !contentType.includes('event-stream')
      ? truncateText(contentType, 48)
      : '',
    compactSignal('len', response?.content_length, 16),
    compactSignal('timing', response?.server_timing, 64),
  ].filter(Boolean);
  if (responseParts.length > 0) {
    parts.push(`${t('monitoring.header_response')}: ${responseParts.join(' · ')}`);
  }
  return parts;
};

const buildFailureMetaText = (row: MonitoringEventRow, t: TFunction, locale: string) => {
  if (!row.failed) return '';
  const parts: string[] = [];
  if (row.failStatusCode) {
    parts.push(
      `${shortLabel(t, 'monitoring.fail_status_code_short', 'monitoring.fail_status_code')} ${row.failStatusCode}`
    );
  }
  const body = maskSensitiveText(row.failSummary || '');
  if (body) {
    parts.push(truncateText(body, 96));
  }
  parts.push(...buildHeaderDiagnosticParts(row, t, locale).map((part) => truncateText(part, 96)));
  return parts.join(' · ');
};

const buildFailureDetails = (row: MonitoringEventRow, t: TFunction, locale: string) => {
  if (!row.failed) return null;
  const summary = maskSensitiveText(row.failSummary || '');
  const diagnostics = buildHeaderDiagnosticParts(row, t, locale);
  if (!row.failStatusCode && !summary && diagnostics.length === 0) return null;
  const statusText = row.failStatusCode
    ? `${shortLabel(t, 'monitoring.fail_status_code_short', 'monitoring.fail_status_code')} ${row.failStatusCode}`
    : '';
  return {
    statusCode: row.failStatusCode,
    statusText,
    summary,
    diagnostics,
    label: buildFailureMetaText(row, t, locale),
    copyText: [statusText, summary, ...diagnostics].filter(Boolean).join('\n'),
  };
};

type RealtimeFailureDetails = NonNullable<ReturnType<typeof buildFailureDetails>>;

type RealtimeFailureStatusProps = {
  details: RealtimeFailureDetails;
  tooltipId: string;
  t: TFunction;
  onCopy: (text: string) => void;
};

const isNodeInside = (element: HTMLElement | null, target: EventTarget | null) => {
  if (!element || typeof Node === 'undefined' || !(target instanceof Node)) return false;
  return element.contains(target);
};

function RealtimeFailureStatus({ details, tooltipId, t, onCopy }: RealtimeFailureStatusProps) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<FailureTooltipPosition | null>(null);
  const isBrowser = typeof document !== 'undefined';

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null || typeof window === 'undefined') return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const updateTooltipPosition = useCallback(() => {
    if (!triggerRef.current) return;
    const nextPosition = resolveFailureTooltipPosition(triggerRef.current);
    if (nextPosition) {
      setTooltipPosition(nextPosition);
    }
  }, []);

  const scheduleTooltipPositionUpdate = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      updateTooltipPosition();
    });
  }, [updateTooltipPosition]);

  const showTooltip = useCallback(() => {
    clearCloseTimer();
    updateTooltipPosition();
    setOpen(true);
  }, [clearCloseTimer, updateTooltipPosition]);

  const requestHideTooltip = useCallback(() => {
    clearCloseTimer();
    if (typeof window === 'undefined') {
      setOpen(false);
      return;
    }
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, FAILURE_TOOLTIP_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      const nextTarget = event.relatedTarget;
      if (
        isNodeInside(triggerRef.current, nextTarget) ||
        isNodeInside(tooltipRef.current, nextTarget)
      ) {
        return;
      }
      requestHideTooltip();
    },
    [requestHideTooltip]
  );

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setOpen(false);
  }, []);

  useEffect(() => {
    return () => {
      clearCloseTimer();
      if (rafRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [clearCloseTimer]);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;

    scheduleTooltipPositionUpdate();
    window.addEventListener('resize', scheduleTooltipPositionUpdate);
    window.addEventListener('scroll', scheduleTooltipPositionUpdate, true);

    return () => {
      window.removeEventListener('resize', scheduleTooltipPositionUpdate);
      window.removeEventListener('scroll', scheduleTooltipPositionUpdate, true);
    };
  }, [open, scheduleTooltipPositionUpdate]);

  const placement = tooltipPosition?.placement ?? 'below';
  const tooltipClassName = [
    styles.realtimeFailureTooltip,
    placement === 'above' ? styles.realtimeFailureTooltipAbove : styles.realtimeFailureTooltipBelow,
    open ? styles.realtimeFailureTooltipOpen : '',
  ]
    .filter(Boolean)
    .join(' ');
  const tooltip = (
    <span
      id={tooltipId}
      ref={tooltipRef}
      role="tooltip"
      className={tooltipClassName}
      style={isBrowser ? tooltipPosition?.style : undefined}
      onMouseEnter={clearCloseTimer}
      onMouseLeave={requestHideTooltip}
      onFocus={showTooltip}
      onBlur={handleBlur}
    >
      <button
        type="button"
        className={styles.realtimeFailureCopyButton}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCopy(details.copyText);
        }}
        title={t('common.copy')}
        aria-label={t('common.copy')}
      >
        <IconCopy size={13} />
      </button>
      {details.statusCode ? (
        <span className={styles.realtimeFailureTooltipStatus}>{details.statusText}</span>
      ) : null}
      {details.summary ? (
        <span className={styles.realtimeFailureTooltipBody}>{details.summary}</span>
      ) : null}
      {details.diagnostics.map((item) => (
        <span key={item} className={styles.realtimeFailureTooltipBody}>
          {item}
        </span>
      ))}
    </span>
  );

  return (
    <span
      ref={triggerRef}
      className={styles.realtimeFailureStatus}
      tabIndex={0}
      aria-describedby={tooltipId}
      aria-label={details.label}
      onMouseEnter={showTooltip}
      onMouseLeave={requestHideTooltip}
      onFocus={showTooltip}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <span className={`${styles.realtimeRequestStatus} ${styles.realtimeRequestStatusBad}`}>
        {t('monitoring.result_failed')}
      </span>
      {!isBrowser ? tooltip : null}
      {isBrowser && open ? createPortal(tooltip, document.body) : null}
    </span>
  );
}

const buildRealtimeTokenSummary = (row: MonitoringEventRow, t: TFunction, locale: string) => {
  const parts = [
    `I ${formatRealtimeUsageNumber(row.inputTokens, locale)}`,
    `O ${formatRealtimeUsageNumber(row.outputTokens, locale)}`,
  ];
  if (row.reasoningTokens > 0) {
    parts.push(`R ${formatRealtimeUsageNumber(row.reasoningTokens, locale)}`);
  }
  parts.push(`C ${formatRealtimeUsageNumber(row.cachedTokens, locale)}`);
  if (row.cacheCreationTokens > 0) {
    parts.push(
      `${shortLabel(t, 'monitoring.cache_creation_tokens_short', 'monitoring.cache_creation_tokens', 'Create')} ${formatRealtimeUsageNumber(row.cacheCreationTokens, locale)}`
    );
  }
  if (row.cacheReadTokens > 0) {
    parts.push(
      `${shortLabel(t, 'monitoring.cache_read_tokens_short', 'monitoring.cache_read_tokens', 'Read')} ${formatRealtimeUsageNumber(row.cacheReadTokens, locale)}`
    );
  }
  return parts.join(' · ');
};

export function RealtimeEventsPanelActions({
  rowCount,
  scopedFailureCount,
  failedOnlyActive,
  accountDisplayMode,
  t,
  onToggleFailedOnly,
  onAccountDisplayModeChange,
  visibleColumns,
  onVisibleColumnsChange,
}: RealtimeEventsPanelActionsProps) {
  const columnMenuRef = useRef<HTMLDivElement | null>(null);
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const nextAccountDisplayMode: AccountDisplayMode =
    accountDisplayMode === 'masked' ? 'full' : 'masked';
  const AccountDisplayIcon = accountDisplayMode === 'masked' ? IconEyeOff : IconEye;
  const logRowsLabel = shortLabel(t, 'monitoring.log_rows_short', 'monitoring.log_rows');
  const recentFailuresLabel = shortLabel(
    t,
    'monitoring.recent_failures_short',
    'monitoring.recent_failures'
  );
  const failedOnlyLabel = shortLabel(
    t,
    'monitoring.filter_status_failed_short',
    'monitoring.filter_status_failed'
  );
  const accountDisplayHint = t(
    accountDisplayMode === 'masked'
      ? 'monitoring.account_overview_show_full_accounts_hint'
      : 'monitoring.account_overview_show_masked_accounts_hint'
  );
  const columnOptions = buildRealtimeColumnOptions(t);

  useEffect(() => {
    if (!columnMenuOpen) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        columnMenuRef.current &&
        typeof Node !== 'undefined' &&
        target instanceof Node &&
        columnMenuRef.current.contains(target)
      ) {
        return;
      }
      setColumnMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [columnMenuOpen]);

  const updateColumn = (key: RealtimeVisibleColumnKey, checked: boolean) => {
    const next = checked
      ? [...visibleColumns, key]
      : visibleColumns.filter((columnKey) => columnKey !== key);
    onVisibleColumnsChange(
      DEFAULT_REALTIME_VISIBLE_COLUMNS.filter((columnKey) => next.includes(columnKey))
    );
  };

  return (
    <div className={`${styles.inlineMetrics} ${styles.realtimeHeaderActions}`}>
      <span title={t('monitoring.log_rows')}>{`${logRowsLabel}: ${rowCount}`}</span>
      <span title={t('monitoring.recent_failures')}>
        {`${recentFailuresLabel}: ${scopedFailureCount}`}
      </span>
      <button
        type="button"
        className={[
          styles.accountOverviewToolButton,
          accountDisplayMode === 'full' ? styles.accountDisplayModeButtonActive : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => onAccountDisplayModeChange(nextAccountDisplayMode)}
        title={accountDisplayHint}
        aria-label={accountDisplayHint}
      >
        <AccountDisplayIcon size={15} aria-hidden="true" />
        <span>
          {t(
            accountDisplayMode === 'masked'
              ? 'monitoring.account_overview_account_display_masked'
              : 'monitoring.account_overview_account_display_full'
          )}
        </span>
      </button>
      <button
        type="button"
        className={[styles.filterToggleChip, failedOnlyActive ? styles.filterToggleChipActive : '']
          .filter(Boolean)
          .join(' ')}
        onClick={onToggleFailedOnly}
        title={t('monitoring.filter_status_failed')}
      >
        <IconFilter size={14} aria-hidden="true" />
        {failedOnlyLabel}
      </button>
      <div className={styles.realtimeColumnMenuWrap} ref={columnMenuRef}>
        <button
          type="button"
          className={styles.accountOverviewToolButton}
          onClick={() => setColumnMenuOpen((open) => !open)}
          title={t('monitoring.realtime_columns_button', { defaultValue: 'Columns' })}
          aria-label={t('monitoring.realtime_columns_button', { defaultValue: 'Columns' })}
          aria-haspopup="menu"
          aria-expanded={columnMenuOpen}
        >
          <IconSlidersHorizontal size={14} aria-hidden="true" />
          <span>{t('monitoring.realtime_columns_button', { defaultValue: 'Columns' })}</span>
        </button>
        {columnMenuOpen ? (
          <div className={styles.realtimeColumnMenu} role="menu">
            <div className={styles.realtimeColumnMenuTitle}>
              {t('monitoring.realtime_columns_title', { defaultValue: 'Visible columns' })}
            </div>
            <div className={styles.realtimeColumnMenuGrid}>
              {columnOptions.map((option) => (
                <SelectionCheckbox
                  key={option.key}
                  checked={visibleColumns.includes(option.key)}
                  onChange={(checked) => updateColumn(option.key, checked)}
                  label={option.label}
                  ariaLabel={option.label}
                  className={styles.realtimeColumnMenuOption}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function RealtimeEventsPanel({
  embedded = false,
  rows,
  pagination,
  pageSize,
  scopedFailureCount,
  failedOnlyActive,
  eventsHasMore,
  eventsLoadingMore,
  eventsTotalCount,
  eventsLoadedCount,
  overallLoading,
  hasPrices,
  accountDisplayMode,
  locale,
  emptyState,
  t,
  onToggleFailedOnly,
  onAccountDisplayModeChange,
  visibleColumns,
  onVisibleColumnsChange,
  onPageChange,
  onPageSizeChange,
  onLoadMoreEvents,
}: RealtimeEventsPanelProps) {
  const tooltipIdPrefix = useId();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const visibleColumnSet = new Set(visibleColumns);
  const isColumnVisible = (column: RealtimeVisibleColumnKey) => visibleColumnSet.has(column);
  const visibleColumnCount = realtimeBaseColumnCount + visibleColumns.length;
  const sourceApiKeyLabel = shortLabel(
    t,
    'monitoring.column_source_api_key_short',
    'monitoring.column_source_api_key'
  );
  const reasoningEffortLabel = shortLabel(
    t,
    'monitoring.reasoning_effort_short',
    'monitoring.reasoning_effort'
  );
  const recentStatusLabel = shortLabel(
    t,
    'monitoring.recent_status_short',
    'monitoring.recent_status'
  );
  const requestStatusLabel = shortLabel(
    t,
    'monitoring.request_status_short',
    'monitoring.request_status'
  );
  const successRateLabel = shortLabel(
    t,
    'monitoring.column_success_rate_short',
    'monitoring.column_success_rate'
  );
  const totalCallsLabel = shortLabel(
    t,
    'monitoring.total_calls_short',
    'monitoring.total_calls',
    'Calls'
  );
  const usageLabel = shortLabel(
    t,
    'monitoring.this_call_usage_short',
    'monitoring.this_call_usage'
  );
  const costLabel = shortLabel(t, 'monitoring.this_call_cost_short', 'monitoring.this_call_cost');
  const handleCopyFailureDetails = async (text: string) => {
    const copied = await copyToClipboard(text);
    showNotification(
      t(copied ? 'notification.link_copied' : 'notification.copy_failed'),
      copied ? 'success' : 'error'
    );
  };
  const actions = (
    <RealtimeEventsPanelActions
      rowCount={rows.length}
      scopedFailureCount={scopedFailureCount}
      failedOnlyActive={failedOnlyActive}
      accountDisplayMode={accountDisplayMode}
      t={t}
      onToggleFailedOnly={onToggleFailedOnly}
      onAccountDisplayModeChange={onAccountDisplayModeChange}
      visibleColumns={visibleColumns}
      onVisibleColumnsChange={onVisibleColumnsChange}
    />
  );
  const content = (
    <>
      <div className={styles.tableWrapper}>
        <table className={`${styles.table} ${styles.realtimeTable}`}>
          <colgroup>
            <col />
            <col />
            {isColumnVisible('reasoning') ? <col /> : null}
            {isColumnVisible('recent') ? <col /> : null}
            <col />
            {isColumnVisible('successRate') ? <col /> : null}
            {isColumnVisible('calls') ? <col /> : null}
            {isColumnVisible('tps') ? <col /> : null}
            {isColumnVisible('latency') ? <col /> : null}
            {isColumnVisible('time') ? <col /> : null}
            {isColumnVisible('usage') ? <col /> : null}
            {isColumnVisible('cost') ? <col /> : null}
          </colgroup>
          <thead>
            <tr>
              <th>{sourceApiKeyLabel}</th>
              <th>{t('monitoring.column_model')}</th>
              {isColumnVisible('reasoning') ? <th>{reasoningEffortLabel}</th> : null}
              {isColumnVisible('recent') ? <th>{recentStatusLabel}</th> : null}
              <th>{requestStatusLabel}</th>
              {isColumnVisible('successRate') ? <th>{successRateLabel}</th> : null}
              {isColumnVisible('calls') ? <th>{totalCallsLabel}</th> : null}
              {isColumnVisible('tps') ? (
                <th className={styles.realtimeTpsColumn}>{t('monitoring.column_output_tps')}</th>
              ) : null}
              {isColumnVisible('latency') ? (
                <th className={styles.realtimeLatencyColumn}>
                <span className={styles.realtimeLatencyHeader}>
                  <span className={styles.realtimeMetricLeft}>{t('monitoring.ttft_short')}</span>
                  <span className={styles.realtimeMetricSeparator}>｜</span>
                  <span className={styles.realtimeMetricRight}>
                    {t('monitoring.elapsed_short')}
                  </span>
                </span>
                </th>
              ) : null}
              {isColumnVisible('time') ? <th>{t('monitoring.column_time')}</th> : null}
              {isColumnVisible('usage') ? <th>{usageLabel}</th> : null}
              {isColumnVisible('cost') ? <th>{costLabel}</th> : null}
            </tr>
          </thead>
          <tbody>
            {pagination.pageItems.map((row) => {
              const sourceDisplay = buildRealtimeSourceDisplay(row, t, accountDisplayMode);
              const apiKeyDisplay = buildRealtimeApiKeyDisplay(row, t);
              const showResolvedModel =
                row.resolvedModel &&
                row.resolvedModel.trim() &&
                row.resolvedModel.trim() !== row.model;
              const reasoningEffort = formatOptionalText(row.reasoningEffort);
              const serviceTier = formatOptionalText(row.serviceTier);
              const failureDetails = buildFailureDetails(row, t, locale);
              const failureTooltipId = failureDetails
                ? `${tooltipIdPrefix}-failure-tooltip-${row.id}`
                : undefined;
              const timeParts = formatRealtimeDateParts(row.timestampMs, locale);
              const hasTtftMs = row.ttftMs !== null && row.ttftMs !== undefined;
              const ttftToneClass = getRealtimeDurationToneClass(row.ttftMs);
              const latencyToneClass = getRealtimeDurationToneClass(row.latencyMs);
              return (
                <tr key={row.id} className={row.failed ? styles.logRowFailed : undefined}>
                  <td>
                    <div className={styles.logTypeCell}>
                      <div className={styles.primaryCell} title={sourceDisplay.title}>
                        <span>{sourceDisplay.primary}</span>
                        {sourceDisplay.meta ? <small>{sourceDisplay.meta}</small> : null}
                        {apiKeyDisplay ? (
                          <small className={styles.realtimeApiKeyLine} title={apiKeyDisplay.title}>
                            {`${t('monitoring.realtime_api_key_label')}: ${apiKeyDisplay.display}`}
                          </small>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td>
                    <div
                      className={`${styles.primaryCell} ${styles.realtimeModelCell}`}
                      title={[row.model, showResolvedModel ? row.resolvedModel : '']
                        .filter(Boolean)
                        .join('\n')}
                    >
                      <span className={`${styles.monoCell} ${styles.realtimeModelText}`}>
                        {row.model}
                      </span>
                      {showResolvedModel ? (
                        <small className={`${styles.monoCell} ${styles.realtimeModelText}`}>
                          {row.resolvedModel}
                        </small>
                      ) : null}
                    </div>
                  </td>
                  {isColumnVisible('reasoning') ? (
                    <td>
                      <div className={styles.primaryCell}>
                        {reasoningEffort !== '-' ? (
                          <span className={styles.realtimeReasoningBadge}>{reasoningEffort}</span>
                        ) : (
                          <span className={styles.mutedCell}>-</span>
                        )}
                        {serviceTier !== '-' ? (
                          <small>{`${shortLabel(t, 'monitoring.service_tier_short', 'monitoring.service_tier')}: ${serviceTier}`}</small>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                  {isColumnVisible('recent') ? (
                    <td>
                      <div className={styles.recentStatusCell}>
                        <RecentPattern pattern={row.recentPattern} variant="plain" />
                      </div>
                    </td>
                  ) : null}
                  <td>
                    <div className={styles.primaryCell}>
                      {failureDetails ? (
                        <RealtimeFailureStatus
                          details={failureDetails}
                          tooltipId={failureTooltipId ?? `${tooltipIdPrefix}-failure-tooltip`}
                          t={t}
                          onCopy={handleCopyFailureDetails}
                        />
                      ) : (
                        <span
                          className={[
                            styles.realtimeRequestStatus,
                            row.failed
                              ? styles.realtimeRequestStatusBad
                              : styles.realtimeRequestStatusGood,
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {row.failed
                            ? t('monitoring.result_failed')
                            : t('monitoring.result_success')}
                        </span>
                      )}
                    </div>
                  </td>
                  {isColumnVisible('successRate') ? (
                    <td
                      className={
                        row.successRate >= 0.95
                          ? styles.goodText
                          : row.successRate >= 0.85
                            ? styles.warnText
                            : styles.badText
                      }
                    >
                      {formatPercent(row.successRate)}
                    </td>
                  ) : null}
                  {isColumnVisible('calls') ? (
                    <td>{formatCompactNumber(row.requestCount)}</td>
                  ) : null}
                  {isColumnVisible('tps') ? (
                    <td className={styles.realtimeTpsColumn}>
                      <span className={styles.realtimeTpsCell}>
                        {formatTokensPerSecond(row.tokensPerSecond, locale)}
                      </span>
                    </td>
                  ) : null}
                  {isColumnVisible('latency') ? (
                    <td className={styles.realtimeLatencyColumn}>
                    <div className={styles.realtimeMetricCell}>
                      <span
                        className={[
                          styles.realtimeMetricText,
                          styles.realtimeMetricLeft,
                          ttftToneClass,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {hasTtftMs ? formatRealtimeCompactDuration(row.ttftMs, locale) : '--'}
                      </span>
                      <span className={styles.realtimeMetricSeparator}>｜</span>
                      <span
                        className={[
                          styles.realtimeMetricText,
                          styles.realtimeMetricRight,
                          latencyToneClass,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {formatRealtimeCompactDuration(row.latencyMs, locale)}
                      </span>
                    </div>
                    </td>
                  ) : null}
                  {isColumnVisible('time') ? (
                    <td>
                      <div className={styles.realtimeTimeCell}>
                        <span className={styles.realtimeTimeLine}>{timeParts.date}</span>
                        <span className={styles.realtimeTimeLine}>{timeParts.time}</span>
                      </div>
                    </td>
                  ) : null}
                  {isColumnVisible('usage') ? (
                    <td>
                      <div className={styles.primaryCell}>
                        <span>{formatRealtimeUsageNumber(row.totalTokens, locale)}</span>
                        <small>{buildRealtimeTokenSummary(row, t, locale)}</small>
                      </div>
                    </td>
                  ) : null}
                  {isColumnVisible('cost') ? (
                    <td>{hasPrices ? formatUsd(row.totalCost) : '--'}</td>
                  ) : null}
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={visibleColumnCount}>{emptyState}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <PaginationControls
        count={rows.length}
        currentPage={pagination.currentPage}
        totalPages={pagination.totalPages}
        startItem={pagination.startItem}
        endItem={pagination.endItem}
        pageSize={pageSize}
        pageSizeOptions={REALTIME_PAGE_SIZE_OPTIONS}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        t={t}
      />
      {rows.length > 0 ? (
        <div className={styles.loadMoreEventsBar}>
          <span className={styles.loadMoreEventsSummary}>
            {eventsHasMore
              ? t('monitoring.events_loaded_summary', {
                  loaded: eventsLoadedCount,
                  total: eventsTotalCount,
                })
              : t('monitoring.events_all_loaded', { total: eventsTotalCount })}
          </span>
          {eventsHasMore ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onLoadMoreEvents}
              disabled={eventsLoadingMore || overallLoading}
            >
              {eventsLoadingMore ? t('common.loading') : t('monitoring.load_more_events')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );

  if (embedded) {
    return content;
  }

  return (
    <MonitoringPanel
      title={t('monitoring.realtime_table_title')}
      subtitle={t('monitoring.realtime_table_desc')}
      className={styles.realtimePanel}
      extra={actions}
    >
      {content}
    </MonitoringPanel>
  );
}
