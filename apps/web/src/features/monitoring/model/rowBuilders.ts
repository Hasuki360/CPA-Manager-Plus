import { formatApiKeyHashLabel } from './base';
import { sanitizeApiKeyDisplayText, shouldPreferApiKeyAlias } from './apiKeys';
import { getRangeBounds } from './range';
import type {
  MonitoringAccountRow,
  MonitoringApiKeyRow,
  MonitoringCustomTimeRange,
  MonitoringEventRow,
  MonitoringRealtimeRow,
  MonitoringSummary,
  MonitoringTimeRange,
} from './types';

const UNKNOWN_API_KEY_GROUP_PREFIX = 'unknown-client-api-key';

const isEffectiveLabel = (value: string) => {
  const trimmed = value.trim();
  return Boolean(trimmed) && trimmed !== '-';
};

const looksLikeMaskedUsageSource = (value: string) => {
  const trimmed = value.trim();
  return trimmed.startsWith('m:') || trimmed.startsWith('k:');
};

const resolveAccountDisplayName = (account: string, channels: Iterable<string>) => {
  const channelLabels = Array.from(new Set(Array.from(channels).filter(isEffectiveLabel)));
  if (looksLikeMaskedUsageSource(account) && channelLabels.length === 1) {
    return channelLabels[0];
  }
  return account || channelLabels[0] || '-';
};

export const shouldIncludeInStats = (
  row: Pick<MonitoringEventRow, 'failed' | 'inputTokens' | 'outputTokens'>
) => row.failed || row.inputTokens > 0 || row.outputTokens > 0;

export const buildRangeFilteredRows = (
  rows: MonitoringEventRow[],
  timeRange: MonitoringTimeRange,
  customTimeRange: MonitoringCustomTimeRange | null | undefined,
  searchQuery: string,
  searchApiKeyHash?: string
) => {
  const nowMs = Date.now();
  const bounds = getRangeBounds(timeRange, nowMs, customTimeRange);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const normalizedSearchApiKeyHash = String(searchApiKeyHash || '')
    .trim()
    .toLowerCase();
  if (!bounds) return [];

  return rows.filter((row) => {
    if (row.timestampMs < bounds.startMs || row.timestampMs > bounds.endMs) {
      return false;
    }

    if (
      normalizedQuery &&
      !row.searchText.includes(normalizedQuery) &&
      !(normalizedSearchApiKeyHash && row.apiKeyHash === normalizedSearchApiKeyHash)
    ) {
      return false;
    }

    return true;
  });
};

const buildRecentPattern = (rows: MonitoringEventRow[], limit = 10) =>
  rows
    .slice()
    .sort((left, right) => right.timestampMs - left.timestampMs)
    .slice(0, limit)
    .reverse()
    .map((row) => !row.failed);

export const buildMonitoringSummary = (rows: MonitoringEventRow[]): MonitoringSummary => {
  const totalCalls = rows.length;
  const failureCalls = rows.filter((row) => row.failed).length;
  const successCalls = Math.max(totalCalls - failureCalls, 0);
  const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens, 0);
  const reasoningTokens = rows.reduce((sum, row) => sum + row.reasoningTokens, 0);
  const cachedTokens = rows.reduce((sum, row) => sum + row.cachedTokens, 0);
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.totalCost, 0);

  let latencySum = 0;
  let latencyCount = 0;
  rows.forEach((row) => {
    if (row.latencyMs === null) return;
    latencySum += row.latencyMs;
    latencyCount += 1;
  });

  const taskMap = new Map<string, boolean>();
  rows.forEach((row) => {
    const existing = taskMap.get(row.taskKey) ?? false;
    taskMap.set(row.taskKey, existing || row.failed);
  });

  const approxTasks = taskMap.size;
  const approxTaskFailures = Array.from(taskMap.values()).filter(Boolean).length;
  const zeroTokenRows = rows.filter((row) => row.totalTokens === 0);

  const activeDays = new Set(rows.map((row) => row.dayKey));
  const activeDayCount = Math.max(activeDays.size, 1);
  const nowMs = Date.now();
  const windowStart = nowMs - 30 * 60 * 1000;
  const recentRows = rows.filter(
    (row) => row.timestampMs >= windowStart && row.timestampMs <= nowMs
  );
  const recentTokens = recentRows.reduce((sum, row) => sum + row.totalTokens, 0);

  return {
    totalCalls,
    successCalls,
    failureCalls,
    successRate: totalCalls > 0 ? successCalls / totalCalls : 1,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    totalTokens,
    totalCost,
    averageLatencyMs: latencyCount > 0 ? latencySum / latencyCount : null,
    rpm30m: recentRows.length / 30,
    tpm30m: recentTokens / 30,
    avgDailyRequests: totalCalls / activeDayCount,
    avgDailyTokens: totalTokens / activeDayCount,
    approxTasks,
    approxTaskFailures,
    approxTaskSuccessRate:
      approxTasks > 0 ? Math.max(approxTasks - approxTaskFailures, 0) / approxTasks : 1,
    zeroTokenCalls: zeroTokenRows.length,
    zeroTokenModels: Array.from(new Set(zeroTokenRows.map((row) => row.model))).sort(),
  };
};

export const buildAccountRows = (rows: MonitoringEventRow[]): MonitoringAccountRow[] => {
  const grouped = new Map<
    string,
    {
      id: string;
      account: string;
      accountMasked: string;
      authLabels: Set<string>;
      authIndices: Set<string>;
      channels: Set<string>;
      modelMap: Map<
        string,
        {
          model: string;
          totalCalls: number;
          successCalls: number;
          failureCalls: number;
          inputTokens: number;
          outputTokens: number;
          cachedTokens: number;
          totalTokens: number;
          totalCost: number;
          lastSeenAt: number;
        }
      >;
      rows: MonitoringEventRow[];
      totalCalls: number;
      successCalls: number;
      failureCalls: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      totalTokens: number;
      totalCost: number;
      latencySum: number;
      latencyCount: number;
      lastSeenAt: number;
    }
  >();

  rows.forEach((row) => {
    const accountKey = row.account || row.authLabel || row.source;
    const existing = grouped.get(accountKey) ?? {
      id: accountKey,
      account: row.account,
      accountMasked: row.accountMasked,
      authLabels: new Set<string>(),
      authIndices: new Set<string>(),
      channels: new Set<string>(),
      modelMap: new Map(),
      rows: [] as MonitoringEventRow[],
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      latencySum: 0,
      latencyCount: 0,
      lastSeenAt: 0,
    };

    existing.rows.push(row);
    existing.authLabels.add(row.authLabel);
    existing.authIndices.add(row.authIndex);
    existing.channels.add(row.channel);
    existing.totalCalls += 1;
    existing.successCalls += row.failed ? 0 : 1;
    existing.failureCalls += row.failed ? 1 : 0;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cachedTokens += row.cachedTokens;
    existing.totalTokens += row.totalTokens;
    existing.totalCost += row.totalCost;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, row.timestampMs);

    if (row.latencyMs !== null) {
      existing.latencySum += row.latencyMs;
      existing.latencyCount += 1;
    }

    const modelEntry = existing.modelMap.get(row.model) ?? {
      model: row.model,
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      lastSeenAt: 0,
    };

    modelEntry.totalCalls += 1;
    modelEntry.successCalls += row.failed ? 0 : 1;
    modelEntry.failureCalls += row.failed ? 1 : 0;
    modelEntry.inputTokens += row.inputTokens;
    modelEntry.outputTokens += row.outputTokens;
    modelEntry.cachedTokens += row.cachedTokens;
    modelEntry.totalTokens += row.totalTokens;
    modelEntry.totalCost += row.totalCost;
    modelEntry.lastSeenAt = Math.max(modelEntry.lastSeenAt, row.timestampMs);
    existing.modelMap.set(row.model, modelEntry);

    grouped.set(accountKey, existing);
  });

  return Array.from(grouped.values())
    .map((item) => {
      const channels = Array.from(item.channels).sort();
      return {
        id: item.id,
        account: item.account,
        displayAccount: resolveAccountDisplayName(item.account, channels),
        accountMasked: item.accountMasked,
        authLabels: Array.from(item.authLabels).sort(),
        authIndices: Array.from(item.authIndices).sort(),
        channels,
        totalCalls: item.totalCalls,
        successCalls: item.successCalls,
        failureCalls: item.failureCalls,
        successRate: item.totalCalls > 0 ? item.successCalls / item.totalCalls : 1,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        cachedTokens: item.cachedTokens,
        totalTokens: item.totalTokens,
        totalCost: item.totalCost,
        averageLatencyMs: item.latencyCount > 0 ? item.latencySum / item.latencyCount : null,
        lastSeenAt: item.lastSeenAt,
        recentPattern: buildRecentPattern(item.rows),
        models: Array.from(item.modelMap.values())
          .map((model) => ({
            ...model,
            successRate: model.totalCalls > 0 ? model.successCalls / model.totalCalls : 1,
          }))
          .sort(
            (left, right) => right.totalCost - left.totalCost || right.totalCalls - left.totalCalls
          ),
      };
    })
    .sort(
      (left, right) =>
        right.lastSeenAt - left.lastSeenAt ||
        right.totalCalls - left.totalCalls ||
        right.totalCost - left.totalCost
    );
};

export const buildApiKeyRows = (rows: MonitoringEventRow[]): MonitoringApiKeyRow[] => {
  const grouped = new Map<
    string,
    {
      id: string;
      apiKeyHash: string;
      apiKeyLabel: string;
      apiKeyMasked: string;
      isUnknown: boolean;
      authLabels: Set<string>;
      sourceLabels: Set<string>;
      channels: Set<string>;
      modelMap: Map<
        string,
        {
          model: string;
          totalCalls: number;
          successCalls: number;
          failureCalls: number;
          inputTokens: number;
          outputTokens: number;
          cachedTokens: number;
          totalTokens: number;
          totalCost: number;
          lastSeenAt: number;
        }
      >;
      totalCalls: number;
      successCalls: number;
      failureCalls: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      totalTokens: number;
      totalCost: number;
      latencySum: number;
      latencyCount: number;
      lastSeenAt: number;
    }
  >();

  rows.forEach((row) => {
    const hasKnownApiKey = Boolean(
      row.apiKeyHash ||
        (row.apiKeyLabel && row.apiKeyLabel !== '-') ||
        (row.apiKeyMasked && row.apiKeyMasked !== '-')
    );
    const apiKeyGroupKey = hasKnownApiKey
      ? row.apiKeyHash || row.apiKeyLabel || row.apiKeyMasked
      : `${UNKNOWN_API_KEY_GROUP_PREFIX}:${row.sourceKey}:${row.authIndex || row.authLabel || '-'}:${row.channel || '-'}:${row.provider || '-'}`;
    const existing = grouped.get(apiKeyGroupKey) ?? {
      id: apiKeyGroupKey,
      apiKeyHash: row.apiKeyHash,
      apiKeyLabel: sanitizeApiKeyDisplayText(row.apiKeyLabel),
      apiKeyMasked: sanitizeApiKeyDisplayText(row.apiKeyMasked),
      isUnknown: !hasKnownApiKey,
      authLabels: new Set<string>(),
      sourceLabels: new Set<string>(),
      channels: new Set<string>(),
      modelMap: new Map(),
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      latencySum: 0,
      latencyCount: 0,
      lastSeenAt: 0,
    };

    if (!existing.apiKeyHash && row.apiKeyHash) {
      existing.apiKeyHash = row.apiKeyHash;
    }
    if (!existing.apiKeyMasked && row.apiKeyMasked) {
      existing.apiKeyMasked = sanitizeApiKeyDisplayText(row.apiKeyMasked);
    }
    if (
      shouldPreferApiKeyAlias(row.apiKeyLabel, row.apiKeyMasked) &&
      !shouldPreferApiKeyAlias(existing.apiKeyLabel, existing.apiKeyMasked)
    ) {
      existing.apiKeyLabel = sanitizeApiKeyDisplayText(row.apiKeyLabel, existing.apiKeyLabel);
    }
    existing.authLabels.add(row.authLabel);
    existing.sourceLabels.add(row.sourceMasked || row.source);
    existing.channels.add(row.channel);

    existing.totalCalls += 1;
    existing.successCalls += row.failed ? 0 : 1;
    existing.failureCalls += row.failed ? 1 : 0;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cachedTokens += row.cachedTokens;
    existing.totalTokens += row.totalTokens;
    existing.totalCost += row.totalCost;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, row.timestampMs);

    if (row.latencyMs !== null) {
      existing.latencySum += row.latencyMs;
      existing.latencyCount += 1;
    }

    const modelEntry = existing.modelMap.get(row.model) ?? {
      model: row.model,
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      lastSeenAt: 0,
    };

    modelEntry.totalCalls += 1;
    modelEntry.successCalls += row.failed ? 0 : 1;
    modelEntry.failureCalls += row.failed ? 1 : 0;
    modelEntry.inputTokens += row.inputTokens;
    modelEntry.outputTokens += row.outputTokens;
    modelEntry.cachedTokens += row.cachedTokens;
    modelEntry.totalTokens += row.totalTokens;
    modelEntry.totalCost += row.totalCost;
    modelEntry.lastSeenAt = Math.max(modelEntry.lastSeenAt, row.timestampMs);
    existing.modelMap.set(row.model, modelEntry);

    grouped.set(apiKeyGroupKey, existing);
  });

  return Array.from(grouped.values())
    .map((item) => ({
      id: item.id,
      apiKeyHash: item.apiKeyHash,
      apiKeyLabel: item.apiKeyLabel || item.apiKeyMasked || formatApiKeyHashLabel(item.apiKeyHash),
      apiKeyMasked: item.apiKeyMasked || item.apiKeyLabel || formatApiKeyHashLabel(item.apiKeyHash),
      isUnknown: item.isUnknown,
      authLabels: Array.from(item.authLabels).filter(Boolean).sort(),
      sourceLabels: Array.from(item.sourceLabels).filter(Boolean).sort(),
      channels: Array.from(item.channels).filter(Boolean).sort(),
      totalCalls: item.totalCalls,
      successCalls: item.successCalls,
      failureCalls: item.failureCalls,
      successRate: item.totalCalls > 0 ? item.successCalls / item.totalCalls : 1,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cachedTokens: item.cachedTokens,
      totalTokens: item.totalTokens,
      totalCost: item.totalCost,
      averageLatencyMs: item.latencyCount > 0 ? item.latencySum / item.latencyCount : null,
      lastSeenAt: item.lastSeenAt,
      models: Array.from(item.modelMap.values())
        .map((model) => ({
          ...model,
          successRate: model.totalCalls > 0 ? model.successCalls / model.totalCalls : 1,
        }))
        .sort(
          (left, right) => right.totalCost - left.totalCost || right.totalCalls - left.totalCalls
        ),
    }))
    .sort(
      (left, right) =>
        right.lastSeenAt - left.lastSeenAt ||
        right.totalCalls - left.totalCalls ||
        right.totalCost - left.totalCost
    );
};

export const buildRealtimeMonitorRows = (rows: MonitoringEventRow[]): MonitoringRealtimeRow[] => {
  const grouped = new Map<
    string,
    {
      id: string;
      account: string;
      accountMasked: string;
      authLabel: string;
      authIndexMasked: string;
      provider: string;
      requestType: string;
      model: string;
      channel: string;
      rows: MonitoringEventRow[];
      latestFailed: boolean;
      successCalls: number;
      failureCalls: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      totalTokens: number;
      totalCost: number;
      latencySum: number;
      latencyCount: number;
      latestLatencyMs: number | null;
      lastSeenAt: number;
    }
  >();

  rows.forEach((row) => {
    const requestType = `${row.endpointMethod} ${row.endpointPath}`.trim();
    const key = [
      row.account || row.authLabel || row.source,
      row.authIndexMasked,
      row.provider,
      row.model,
      row.channel,
      requestType,
    ].join('::');

    const existing = grouped.get(key) ?? {
      id: key,
      account: row.account,
      accountMasked: row.accountMasked,
      authLabel: row.authLabel,
      authIndexMasked: row.authIndexMasked,
      provider: row.provider,
      requestType,
      model: row.model,
      channel: row.channel,
      rows: [] as MonitoringEventRow[],
      latestFailed: row.failed,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      latencySum: 0,
      latencyCount: 0,
      latestLatencyMs: null,
      lastSeenAt: 0,
    };

    existing.rows.push(row);
    existing.successCalls += row.failed ? 0 : 1;
    existing.failureCalls += row.failed ? 1 : 0;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cachedTokens += row.cachedTokens;
    existing.totalTokens += row.totalTokens;
    existing.totalCost += row.totalCost;

    if (row.timestampMs >= existing.lastSeenAt) {
      existing.lastSeenAt = row.timestampMs;
      existing.latestFailed = row.failed;
      existing.latestLatencyMs = row.latencyMs;
    }

    if (row.latencyMs !== null) {
      existing.latencySum += row.latencyMs;
      existing.latencyCount += 1;
    }

    grouped.set(key, existing);
  });

  return Array.from(grouped.values())
    .map((item) => {
      const totalCalls = item.successCalls + item.failureCalls;
      return {
        id: item.id,
        account: item.account,
        accountMasked: item.accountMasked,
        authLabel: item.authLabel,
        authIndexMasked: item.authIndexMasked,
        provider: item.provider,
        requestType: item.requestType,
        model: item.model,
        channel: item.channel,
        latestFailed: item.latestFailed,
        successRate: totalCalls > 0 ? item.successCalls / totalCalls : 1,
        totalCalls,
        successCalls: item.successCalls,
        failureCalls: item.failureCalls,
        averageLatencyMs: item.latencyCount > 0 ? item.latencySum / item.latencyCount : null,
        latestLatencyMs: item.latestLatencyMs,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        cachedTokens: item.cachedTokens,
        totalTokens: item.totalTokens,
        totalCost: item.totalCost,
        lastSeenAt: item.lastSeenAt,
        recentPattern: buildRecentPattern(item.rows),
      };
    })
    .sort(
      (left, right) => right.lastSeenAt - left.lastSeenAt || right.totalCalls - left.totalCalls
    );
};
