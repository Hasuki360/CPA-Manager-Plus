import { describe, expect, it } from 'vitest';
import {
  buildAccountRows,
  buildApiKeyRows,
  buildApiKeyDisplayMap,
  buildMonitoringAuthMetaMap,
  buildRangeFilteredRows,
  type MonitoringEventRow,
} from './useMonitoringData';
import { sha256Hex } from '@/utils/apiKeyHash';
import type { AuthFileItem } from '@/types';

const createMonitoringEventRow = (
  overrides: Partial<MonitoringEventRow> = {}
): MonitoringEventRow => ({
  id: overrides.id ?? 'row-1',
  timestamp: overrides.timestamp ?? '2026-05-09T01:12:43.000Z',
  timestampMs: overrides.timestampMs ?? Date.parse('2026-05-09T01:12:43.000Z'),
  dayKey: overrides.dayKey ?? '2026-05-09',
  hourLabel: overrides.hourLabel ?? '01:00',
  model: overrides.model ?? 'gpt-4.1',
  endpoint: overrides.endpoint ?? '/v1/chat/completions',
  endpointMethod: overrides.endpointMethod ?? 'POST',
  endpointPath: overrides.endpointPath ?? '/v1/chat/completions',
  sourceKey: overrides.sourceKey ?? 'source:alpha',
  source: overrides.source ?? 'alpha.json',
  sourceMasked: overrides.sourceMasked ?? 'a***',
  account: overrides.account ?? 'amount-myth-resend@duck.com',
  accountMasked: overrides.accountMasked ?? 'amo***@duck.com',
  authIndex: overrides.authIndex ?? 'auth-123456',
  authIndexMasked: overrides.authIndexMasked ?? 'auth...3456',
  authLabel: overrides.authLabel ?? 'alpha.json',
  apiKeyHash: overrides.apiKeyHash ?? 'api-key-hash',
  apiKeyLabel: overrides.apiKeyLabel ?? 'ak********sh',
  apiKeyMasked: overrides.apiKeyMasked ?? 'ak********sh',
  provider: overrides.provider ?? 'codex',
  planType: overrides.planType ?? 'pro',
  channel: overrides.channel ?? 'codex',
  channelHost: overrides.channelHost ?? 'example.com',
  channelDisabled: overrides.channelDisabled ?? false,
  failed: overrides.failed ?? false,
  statsIncluded: overrides.statsIncluded ?? true,
  latencyMs: overrides.latencyMs ?? 1200,
  inputTokens: overrides.inputTokens ?? 10,
  outputTokens: overrides.outputTokens ?? 5,
  reasoningTokens: overrides.reasoningTokens ?? 0,
  cachedTokens: overrides.cachedTokens ?? 3,
  totalTokens: overrides.totalTokens ?? 18,
  totalCost: overrides.totalCost ?? 0.12,
  taskKey: overrides.taskKey ?? 'task-1',
  searchText: overrides.searchText ?? 'amount myth resend',
});

describe('buildAccountRows', () => {
  it('keeps raw auth indices for account-level auth file linking', () => {
    const rows = buildAccountRows([
      createMonitoringEventRow(),
      createMonitoringEventRow({
        id: 'row-2',
        timestampMs: Date.parse('2026-05-09T02:12:43.000Z'),
        authIndex: 'auth-999999',
        authIndexMasked: 'auth...9999',
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].authIndices).toEqual(['auth-123456', 'auth-999999']);
  });
});

describe('buildMonitoringAuthMetaMap', () => {
  it('maps legacy auth indices to current auth metadata', () => {
    const authFiles: AuthFileItem[] = [
      {
        name: 'alice.json',
        provider: 'codex',
        authIndex: 'current-auth-index',
        path: '/tmp/auths/alice.json',
        account: 'alice@example.com',
      },
    ];

    const map = buildMonitoringAuthMetaMap(authFiles);

    expect(map.get('current-auth-index')?.account).toBe('alice@example.com');
    expect(map.get('6bf749cb7db0e15c')?.account).toBe('alice@example.com');
  });
});

describe('buildApiKeyDisplayMap', () => {
  it('prefers stored aliases while preserving masked configured keys', () => {
    const apiKey = 'sk-alias-test-key';
    const apiKeyHash = sha256Hex(apiKey);
    const map = buildApiKeyDisplayMap([apiKey], [{ apiKeyHash, alias: 'Team A', updatedAtMs: 1 }]);

    expect(map.get(apiKeyHash)?.label).toBe('Team A');
    expect(map.get(apiKeyHash)?.masked).toMatch(/^sk/);
  });

  it('masks key-like aliases before display', () => {
    const apiKey = 'sk-alias-test-key';
    const apiKeyHash = sha256Hex(apiKey);
    const map = buildApiKeyDisplayMap(
      [apiKey],
      [{ apiKeyHash, alias: 'sk-proj-secret-value-123456', updatedAtMs: 1 }]
    );

    expect(map.get(apiKeyHash)?.label).toMatch(/^sk/);
    expect(map.get(apiKeyHash)?.label).toContain('**');
    expect(map.get(apiKeyHash)?.label).not.toContain('secret-value');
  });
});

describe('buildApiKeyRows', () => {
  it('groups usage by client api key and aggregates model spend', () => {
    const rows = buildApiKeyRows([
      createMonitoringEventRow({
        id: 'row-1',
        apiKeyHash: 'hash-a',
        apiKeyLabel: 'Team A',
        apiKeyMasked: 'sk********aa',
        model: 'gpt-4.1',
        totalTokens: 18,
        totalCost: 0.12,
      }),
      createMonitoringEventRow({
        id: 'row-2',
        apiKeyHash: 'hash-a',
        apiKeyLabel: 'Team A',
        apiKeyMasked: 'sk********aa',
        model: 'gpt-4.1',
        failed: true,
        totalTokens: 7,
        totalCost: 0.03,
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      apiKeyHash: 'hash-a',
      apiKeyLabel: 'Team A',
      totalCalls: 2,
      successCalls: 1,
      failureCalls: 1,
      totalTokens: 25,
      totalCost: 0.15,
    });
    expect(rows[0].models[0]).toMatchObject({
      model: 'gpt-4.1',
      totalCalls: 2,
      failureCalls: 1,
    });
  });

  it('keeps unknown client keys separated by source and channel', () => {
    const rows = buildApiKeyRows([
      createMonitoringEventRow({
        id: 'unknown-1',
        apiKeyHash: '',
        apiKeyLabel: '-',
        apiKeyMasked: '-',
        sourceKey: 'source:a',
        authIndex: 'auth-a',
        channel: 'channel-a',
      }),
      createMonitoringEventRow({
        id: 'unknown-2',
        apiKeyHash: '',
        apiKeyLabel: '-',
        apiKeyMasked: '-',
        sourceKey: 'source:b',
        authIndex: 'auth-b',
        channel: 'channel-b',
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.isUnknown)).toBe(true);
  });
});

describe('buildRangeFilteredRows', () => {
  it('matches a raw api key search through its hash without breaking text search', () => {
    const rows = [
      createMonitoringEventRow({
        id: 'hash-a',
        apiKeyHash: 'hash-a',
        searchText: 'hash-a team a',
      }),
      createMonitoringEventRow({
        id: 'hash-b',
        apiKeyHash: 'hash-b',
        searchText: 'hash-b team b',
      }),
    ];

    expect(buildRangeFilteredRows(rows, 'all', null, 'team b', '').map((row) => row.id)).toEqual([
      'hash-b',
    ]);
    expect(
      buildRangeFilteredRows(rows, 'all', null, 'unmatched raw key', 'hash-a').map((row) => row.id)
    ).toEqual(['hash-a']);
  });
});
