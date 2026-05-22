import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MonitoringAnalyticsEventRow } from '@/services/api/usageService';
import type { AuthFileItem } from '@/types/authFile';
import type { CredentialInfo } from '@/types/sourceInfo';
import { buildSourceInfoMap } from '@/utils/sourceResolver';
import { collectUsageDetailsWithEndpoint, normalizeAuthIndex } from '@/utils/usage';
import { readString } from '../model/base';
import { buildApiKeyDisplayMap } from '../model/apiKeys';
import { buildMonitoringAuthMetaMap } from '../model/authMeta';
import { getRangeBounds, shouldUseHourlyTimeline } from '../model/range';
import {
  buildChannelRows,
  buildFailureRows,
  buildFailureSourceRows,
  buildHourlyDistribution,
  buildModelRows,
  buildModelShareRows,
  buildStatusChips,
  buildTaskBuckets,
  buildTimeline,
} from '../model/chartBuilders';
import {
  buildAnalyticsFilters,
  buildChannelRowsFromAnalytics,
  buildFailureRowsFromAnalytics,
  buildFailureSourceRowsFromAnalytics,
  buildHourlyDistributionFromAnalytics,
  buildModelRowsFromAnalytics,
  buildModelShareRowsFromAnalytics,
  buildSummaryFromAnalytics,
  buildTaskBucketsFromAnalytics,
  buildTimelineFromAnalytics,
  buildUsageDetailsFromAnalyticsEvents,
  mergeAnalyticsEventItems,
} from '../model/analyticsAdapters';
import { buildEventRows } from '../model/eventRows';
import {
  buildMonitoringSummary,
  buildRangeFilteredRows,
  shouldIncludeInStats,
} from '../model/rowBuilders';
import type {
  MonitoringAuthMeta,
  MonitoringChannelMeta,
  MonitoringMetadata,
  UseMonitoringDataParams,
  UseMonitoringDataReturn,
} from '../model/types';
import { loadMonitoringMetaPayload } from '../services/monitoringMetaService';
import { useMonitoringAnalytics } from './useMonitoringAnalytics';

export type {
  MonitoringAccountModelSpendRow,
  MonitoringAccountRow,
  MonitoringApiKeyModelSpendRow,
  MonitoringApiKeyRow,
  MonitoringChannelMeta,
  MonitoringChannelRow,
  MonitoringCustomTimeRange,
  MonitoringEventRow,
  MonitoringFailureRow,
  MonitoringFailureSourceRow,
  MonitoringKpi,
  MonitoringMetadata,
  MonitoringModelRow,
  MonitoringModelShareRow,
  MonitoringRealtimeRow,
  MonitoringScopeFilters,
  MonitoringStatusChip,
  MonitoringStatusTone,
  MonitoringSummary,
  MonitoringTaskBucketRow,
  MonitoringTimeRange,
  MonitoringTimelinePoint,
  UseMonitoringDataParams,
  UseMonitoringDataReturn,
} from '../model/types';
export { buildApiKeyDisplayMap } from '../model/apiKeys';
export { buildMonitoringAuthMetaMap } from '../model/authMeta';
export { getRangeBounds } from '../model/range';
export {
  buildAccountRows,
  buildApiKeyRows,
  buildMonitoringSummary,
  buildRangeFilteredRows,
  buildRealtimeMonitorRows,
} from '../model/rowBuilders';

const MONITORING_EVENTS_PAGE_LIMIT = 500;

interface MonitoringEventsPageState {
  scopeKey: string;
  beforeMs: number | null;
  items: MonitoringAnalyticsEventRow[];
  hasMore: boolean;
  loadingMore: boolean;
  lastPageKey: string;
}

const createEventsPageState = (scopeKey = ''): MonitoringEventsPageState => ({
  scopeKey,
  beforeMs: null,
  items: [],
  hasMore: false,
  loadingMore: false,
  lastPageKey: '',
});

const buildEventsPageKey = (
  scopeKey: string,
  beforeMs: number | null,
  pageItems: MonitoringAnalyticsEventRow[],
  nextBeforeMs: number
) =>
  [
    scopeKey,
    beforeMs ?? 'root',
    nextBeforeMs,
    pageItems.length,
    pageItems[0]?.event_hash ?? '',
    pageItems[pageItems.length - 1]?.event_hash ?? '',
  ].join(':');

export const buildMonitoringEventsScopeKey = (
  timeRange: UseMonitoringDataParams['timeRange'],
  analyticsBounds: { startMs: number; endMs: number } | null,
  searchQuery: string,
  searchApiKeyHash: string | undefined,
  filters: unknown,
  granularity: string
) =>
  JSON.stringify({
    range: timeRange,
    bounds:
      timeRange === 'custom'
        ? analyticsBounds
        : analyticsBounds
          ? { startMs: analyticsBounds.startMs }
          : null,
    searchQuery,
    searchApiKeyHash,
    filters,
    granularity,
  });

export const mergeMonitoringEventsPageItems = (
  previousItems: MonitoringAnalyticsEventRow[],
  pageItems: MonitoringAnalyticsEventRow[],
  requestBeforeMs: number | null
) => {
  if (requestBeforeMs) {
    return mergeAnalyticsEventItems(previousItems, pageItems);
  }
  if (previousItems.length === 0) {
    return pageItems;
  }
  return mergeAnalyticsEventItems(pageItems, previousItems);
};

export function useMonitoringData({
  usage,
  config,
  modelPrices,
  apiKeyAliases,
  timeRange,
  customTimeRange,
  searchQuery,
  searchApiKeyHash,
  scopeFilters,
}: UseMonitoringDataParams): UseMonitoringDataReturn {
  const [authFiles, setAuthFiles] = useState<AuthFileItem[]>([]);
  const [channels, setChannels] = useState<MonitoringChannelMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [analyticsNowMs, setAnalyticsNowMs] = useState(() => Date.now());
  const [eventsPageState, setEventsPageState] = useState<MonitoringEventsPageState>(() =>
    createEventsPageState()
  );

  const analyticsBounds = useMemo(() => {
    const bounds = getRangeBounds(timeRange, analyticsNowMs, customTimeRange);
    if (!bounds) return null;
    return {
      startMs: Number.isFinite(bounds.startMs) && bounds.startMs > 0 ? bounds.startMs : 1,
      endMs: Math.max(bounds.endMs, 1),
    };
  }, [analyticsNowMs, customTimeRange, timeRange]);

  const refreshMeta = useCallback(
    async (showLoading: boolean = true) => {
      if (showLoading) {
        setLoading(true);
        setError('');
      }

      const payload = await loadMonitoringMetaPayload(config);
      setAuthFiles(payload.authFiles);
      setChannels(payload.channels);
      setError(payload.error);
      setLoading(false);
      setEventsPageState((previous) =>
        previous.beforeMs === null && !previous.loadingMore
          ? previous
          : { ...previous, beforeMs: null, loadingMore: false }
      );
      setAnalyticsNowMs(Date.now());
    },
    [config]
  );

  useEffect(() => {
    let cancelled = false;

    loadMonitoringMetaPayload(config).then((payload) => {
      if (cancelled) return;
      setAuthFiles(payload.authFiles);
      setChannels(payload.channels);
      setError(payload.error);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [config]);

  const authMetaMap = useMemo(() => buildMonitoringAuthMetaMap(authFiles), [authFiles]);

  const uniqueAuthMeta = useMemo(() => {
    const map = new Map<string, MonitoringAuthMeta>();
    authMetaMap.forEach((item) => {
      map.set(item.authIndex, item);
    });
    return Array.from(map.values());
  }, [authMetaMap]);

  const authFileMap = useMemo(() => {
    const map = new Map<string, CredentialInfo>();
    authFiles.forEach((entry) => {
      const authIndex = normalizeAuthIndex(entry['auth_index'] ?? entry.authIndex);
      if (!authIndex) return;
      map.set(authIndex, {
        name:
          readString(entry.label) ||
          readString(entry.name) ||
          readString(entry.email) ||
          readString(entry.account) ||
          authIndex,
        type: readString(entry.provider) || readString(entry.type),
      });
    });
    return map;
  }, [authFiles]);

  const sourceInfoMap = useMemo(
    () =>
      buildSourceInfoMap({
        geminiApiKeys: config?.geminiApiKeys || [],
        claudeApiKeys: config?.claudeApiKeys || [],
        codexApiKeys: config?.codexApiKeys || [],
        vertexApiKeys: config?.vertexApiKeys || [],
        openaiCompatibility: config?.openaiCompatibility || [],
      }),
    [config]
  );

  const channelByAuthIndex = useMemo(() => {
    const map = new Map<string, MonitoringChannelMeta>();
    channels.forEach((channel) => {
      channel.authIndices.forEach((authIndex) => {
        map.set(authIndex, channel);
      });
    });
    return map;
  }, [channels]);

  const apiKeyDisplayMap = useMemo(() => {
    return buildApiKeyDisplayMap(config?.apiKeys || [], apiKeyAliases || []);
  }, [apiKeyAliases, config?.apiKeys]);

  const analyticsFilters = useMemo(
    () => buildAnalyticsFilters(scopeFilters, authMetaMap, channels),
    [authMetaMap, channels, scopeFilters]
  );

  const analyticsGranularity = useMemo(
    () => (shouldUseHourlyTimeline(timeRange, customTimeRange) ? 'hour' : 'day'),
    [customTimeRange, timeRange]
  );

  const eventsScopeKey = useMemo(
    () =>
      buildMonitoringEventsScopeKey(
        timeRange,
        analyticsBounds,
        searchQuery,
        searchApiKeyHash,
        analyticsFilters,
        analyticsGranularity
      ),
    [
      analyticsBounds,
      analyticsFilters,
      analyticsGranularity,
      searchApiKeyHash,
      searchQuery,
      timeRange,
    ]
  );

  const activeEventsPageState =
    eventsPageState.scopeKey === eventsScopeKey
      ? eventsPageState
      : createEventsPageState(eventsScopeKey);
  const eventsBeforeMs = activeEventsPageState.beforeMs;
  const eventItems = activeEventsPageState.items;
  const eventsHasMore = activeEventsPageState.hasMore;
  const eventsLoadingMore = activeEventsPageState.loadingMore;

  const analytics = useMonitoringAnalytics({
    fromMs: analyticsBounds?.startMs,
    toMs: analyticsBounds?.endMs,
    nowMs: analyticsNowMs,
    searchQuery,
    searchApiKeyHash,
    filters: analyticsFilters,
    include: {
      summary: true,
      timeline: true,
      hourly_distribution: true,
      model_share: true,
      channel_share: true,
      model_stats: true,
      failure_sources: true,
      task_buckets: true,
      recent_failures: 8,
      events_page: { limit: MONITORING_EVENTS_PAGE_LIMIT, before_ms: eventsBeforeMs },
      granularity: analyticsGranularity,
    },
    throttleMs: 1_000,
  });
  const analyticsData = analytics.data;

  useEffect(() => {
    const page = analyticsData?.events;
    if (!page) return;
    const requestBeforeMs = eventsBeforeMs;
    const pageKey = buildEventsPageKey(
      eventsScopeKey,
      requestBeforeMs,
      page.items,
      page.next_before_ms
    );
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setEventsPageState((previous) => {
        const base =
          previous.scopeKey === eventsScopeKey
            ? previous
            : createEventsPageState(eventsScopeKey);
        if (base.lastPageKey === pageKey) return base;
        return {
          scopeKey: eventsScopeKey,
          beforeMs: requestBeforeMs,
          items: mergeMonitoringEventsPageItems(base.items, page.items, requestBeforeMs),
          hasMore: page.has_more,
          loadingMore: false,
          lastPageKey: pageKey,
        };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [analyticsData?.events, eventsScopeKey, eventsBeforeMs]);

  useEffect(() => {
    if (analytics.error) {
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        setEventsPageState((previous) =>
          previous.loadingMore ? { ...previous, loadingMore: false } : previous
        );
      });
      return () => {
        cancelled = true;
      };
    }
  }, [analytics.error]);

  const loadMoreEvents = useCallback(() => {
    if (analytics.loading || eventsLoadingMore || !eventsHasMore) return;
    const nextBeforeMs = analyticsData?.events?.next_before_ms;
    if (!nextBeforeMs) return;
    setEventsPageState((previous) => {
      const base =
        previous.scopeKey === eventsScopeKey
          ? previous
          : createEventsPageState(eventsScopeKey);
      if (base.loadingMore) return base;
      return { ...base, beforeMs: nextBeforeMs, loadingMore: true };
    });
  }, [
    analyticsData?.events?.next_before_ms,
    analytics.loading,
    eventsScopeKey,
    eventsHasMore,
    eventsLoadingMore,
  ]);

  const allRows = useMemo(() => {
    const details = analyticsData
      ? buildUsageDetailsFromAnalyticsEvents(eventItems)
      : collectUsageDetailsWithEndpoint(usage);
    return buildEventRows(
      details,
      authMetaMap,
      authFileMap,
      sourceInfoMap,
      channelByAuthIndex,
      modelPrices,
      apiKeyDisplayMap
    ).sort((left, right) => right.timestampMs - left.timestampMs);
  }, [
    apiKeyDisplayMap,
    authFileMap,
    authMetaMap,
    channelByAuthIndex,
    analyticsData,
    eventItems,
    modelPrices,
    sourceInfoMap,
    usage,
  ]);

  const filteredRows = useMemo(
    () =>
      buildRangeFilteredRows(allRows, timeRange, customTimeRange, searchQuery, searchApiKeyHash),
    [allRows, customTimeRange, searchApiKeyHash, searchQuery, timeRange]
  );
  const statsRows = useMemo(() => filteredRows.filter(shouldIncludeInStats), [filteredRows]);

  const summary = useMemo(
    () =>
      analyticsData?.summary
        ? buildSummaryFromAnalytics(analyticsData.summary)
        : buildMonitoringSummary(statsRows),
    [analyticsData, statsRows]
  );
  const timelineData = useMemo(
    () =>
      analyticsData?.timeline
        ? {
            granularity:
              analyticsData.granularity === 'hour' ? ('hour' as const) : ('day' as const),
            points: buildTimelineFromAnalytics(analyticsData.timeline, analyticsData.granularity),
          }
        : buildTimeline(statsRows, timeRange, customTimeRange),
    [analyticsData, customTimeRange, statsRows, timeRange]
  );
  const hourlyDistribution = useMemo(
    () =>
      analyticsData?.hourly_distribution
        ? buildHourlyDistributionFromAnalytics(analyticsData.hourly_distribution)
        : buildHourlyDistribution(statsRows),
    [analyticsData, statsRows]
  );
  const modelShareRows = useMemo(
    () =>
      analyticsData?.model_share
        ? buildModelShareRowsFromAnalytics(analyticsData.model_share, analyticsData.model_stats)
        : buildModelShareRows(statsRows),
    [analyticsData, statsRows]
  );
  const channelRows = useMemo(
    () =>
      analyticsData?.channel_share
        ? buildChannelRowsFromAnalytics(analyticsData.channel_share, authMetaMap, channelByAuthIndex)
        : buildChannelRows(statsRows),
    [analyticsData, authMetaMap, channelByAuthIndex, statsRows]
  );
  const modelRows = useMemo(
    () =>
      analyticsData?.model_stats
        ? buildModelRowsFromAnalytics(analyticsData.model_stats)
        : buildModelRows(statsRows),
    [analyticsData, statsRows]
  );
  const failureSourceRows = useMemo(
    () =>
      analyticsData?.failure_sources
        ? buildFailureSourceRowsFromAnalytics(
            analyticsData.failure_sources,
            authMetaMap,
            channelByAuthIndex
          )
        : buildFailureSourceRows(statsRows),
    [analyticsData, authMetaMap, channelByAuthIndex, statsRows]
  );
  const taskBuckets = useMemo(
    () =>
      analyticsData?.task_buckets
        ? buildTaskBucketsFromAnalytics(
            analyticsData.task_buckets,
            authMetaMap,
            authFileMap,
            sourceInfoMap,
            channelByAuthIndex
          )
        : buildTaskBuckets(statsRows),
    [analyticsData, authFileMap, authMetaMap, channelByAuthIndex, sourceInfoMap, statsRows]
  );
  const recentFailures = useMemo(
    () =>
      analyticsData?.recent_failures
        ? buildFailureRowsFromAnalytics(
            analyticsData.recent_failures,
            authMetaMap,
            channelByAuthIndex
          )
        : buildFailureRows(statsRows),
    [analyticsData, authMetaMap, channelByAuthIndex, statsRows]
  );

  const metadata = useMemo<MonitoringMetadata>(() => {
    const planTypes = Array.from(
      new Set(uniqueAuthMeta.map((item) => item.planType).filter((item) => item && item !== '-'))
    ).sort();

    return {
      totalAuthFiles: authFiles.length,
      activeAuthFiles: uniqueAuthMeta.filter(
        (item) => !item.disabled && !item.unavailable && item.status === 'active'
      ).length,
      unavailableAuthFiles: uniqueAuthMeta.filter((item) => item.unavailable).length,
      runtimeOnlyAuthFiles: uniqueAuthMeta.filter((item) => item.runtimeOnly).length,
      totalChannels: channels.length,
      enabledChannels: channels.filter((item) => !item.disabled).length,
      configuredModels: Array.from(new Set(channels.flatMap((item) => item.modelNames))).length,
      planTypes,
    };
  }, [authFiles.length, channels, uniqueAuthMeta]);

  const statusChips = useMemo(() => buildStatusChips(metadata), [metadata]);

  return {
    loading: loading || analytics.loading,
    error: [error, analytics.error].filter(Boolean).join('；'),
    authFiles,
    channels,
    summary,
    metadata,
    statusChips,
    timeline: timelineData.points,
    timelineGranularity: timelineData.granularity,
    hourlyDistribution,
    modelShareRows,
    channelRows,
    modelRows,
    failureSourceRows,
    taskBuckets,
    recentFailures,
    filteredRows,
    eventsHasMore,
    eventsLoadingMore,
    lastRefreshedAt: analytics.lastRefreshedAt,
    refreshMeta,
    loadMoreEvents,
  };
}
