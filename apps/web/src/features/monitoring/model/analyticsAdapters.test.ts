import { describe, expect, it } from 'vitest';
import type {
  MonitoringAnalyticsChannelShareRow,
  MonitoringAnalyticsEventRow,
} from '@/services/api/usageService';
import { buildSourceInfoMap } from '@/utils/sourceResolver';
import {
  buildChannelRowsFromAnalytics,
  buildFailureRowsFromAnalytics,
  buildFailureSourceRowsFromAnalytics,
  buildUsageDetailsFromAnalyticsEvents,
} from './analyticsAdapters';

describe('buildUsageDetailsFromAnalyticsEvents', () => {
  it('maps resolved model and auth project snapshots into usage details', () => {
    const events: MonitoringAnalyticsEventRow[] = [
      {
        event_hash: 'event-1',
        timestamp_ms: Date.UTC(2026, 4, 20, 1, 2, 3),
        model: 'alias-model',
        resolved_model: 'upstream-model',
        endpoint: 'POST /v1/chat/completions',
        method: 'POST',
        path: '/v1/chat/completions',
        auth_index: 'auth-1',
        source: 'source.json',
        source_hash: 'source-hash',
        api_key_hash: 'api-key-hash',
        account_snapshot: 'account@example.com',
        auth_label_snapshot: 'label',
        auth_provider_snapshot: 'codex',
        auth_project_id_snapshot: 'project-1',
        reasoning_effort: 'medium',
        input_tokens: 10,
        output_tokens: 5,
        cached_tokens: 0,
        cache_read_tokens: 4,
        cache_creation_tokens: 1,
        reasoning_tokens: 1,
        total_tokens: 18,
        latency_ms: 123,
        ttft_ms: 45,
        failed: true,
        fail_status_code: 429,
        fail_summary: 'rate limit exceeded',
      },
    ];

    const details = buildUsageDetailsFromAnalyticsEvents(events);

    expect(details[0]).toMatchObject({
      __modelName: 'alias-model',
      __resolvedModel: 'upstream-model',
      auth_project_id_snapshot: 'project-1',
      reasoning_effort: 'medium',
      latency_ms: 123,
      ttft_ms: 45,
      tokens: {
        cached_tokens: 0,
        cache_read_tokens: 4,
        cache_creation_tokens: 1,
      },
      failed: true,
      fail_status_code: 429,
      fail_summary: 'rate limit exceeded',
    });
  });

  it('trusts backend-deduped cached tokens from analytics events', () => {
    const events: MonitoringAnalyticsEventRow[] = [
      {
        event_hash: 'event-cache',
        timestamp_ms: Date.UTC(2026, 4, 20, 1, 2, 3),
        model: 'mixed-cache-model',
        endpoint: 'POST /v1/chat/completions',
        method: 'POST',
        path: '/v1/chat/completions',
        auth_index: 'auth-1',
        source: 'source.json',
        source_hash: 'source-hash',
        api_key_hash: 'api-key-hash',
        account_snapshot: '',
        auth_label_snapshot: '',
        auth_provider_snapshot: '',
        input_tokens: 100,
        output_tokens: 20,
        cached_tokens: 5,
        cache_read_tokens: 4,
        cache_creation_tokens: 1,
        reasoning_tokens: 0,
        total_tokens: 130,
        latency_ms: null,
        failed: false,
      },
    ];

    const details = buildUsageDetailsFromAnalyticsEvents(events);

    expect(details[0].tokens.cached_tokens).toBe(5);
    expect(details[0].tokens.cache_read_tokens).toBe(4);
    expect(details[0].tokens.cache_creation_tokens).toBe(1);
  });
});

describe('analytics failure source display', () => {
  const authMetaMap = new Map([
    [
      'auth-1',
      {
        authIndex: 'auth-1',
        label: 'Team Auth',
        account: 'alice@example.com',
        provider: 'codex',
        status: 'active',
        disabled: false,
        unavailable: false,
        runtimeOnly: false,
        planType: 'pro',
        updatedAt: '',
      },
    ],
  ]);
  const authFileMap = new Map([['auth-1', { name: 'Team Auth', type: 'codex' }]]);
  const sourceInfoMap = buildSourceInfoMap({});
  const channelByAuthIndex = new Map([
    [
      'auth-1',
      {
        key: 'relay:0',
        name: 'Production Relay',
        baseUrl: 'https://relay.example.com/v1',
        host: 'relay.example.com',
        disabled: false,
        authIndices: ['auth-1'],
        modelNames: [],
      },
    ],
  ]);

  it('uses channel metadata for channel share rows when auth metadata exists', () => {
    const rows = buildChannelRowsFromAnalytics(
      [
        {
          auth_index: 'auth-1',
          source: 'm:sk-a...zzzz',
          account_snapshot: 'snapshot@example.com',
          auth_label_snapshot: 'Snapshot Auth',
          auth_provider_snapshot: 'codex',
          calls: 10,
          success: 8,
          failure: 2,
          tokens: 1000,
          cost: 0.12,
          average_latency_ms: 120,
        },
      ],
      authMetaMap,
      authFileMap,
      sourceInfoMap,
      channelByAuthIndex
    );

    expect(rows[0].label).toBe('Production Relay');
    expect(rows[0].host).toBe('relay.example.com');
    expect(rows[0].authLabels).toEqual(['Team Auth']);
  });

  it('uses channel share snapshots when current auth metadata is missing', () => {
    const rows = buildChannelRowsFromAnalytics(
      [
        {
          auth_index: 'legacy-auth',
          source: 'm:sk-a...zzzz',
          account_snapshot: 'legacy@example.com',
          auth_label_snapshot: 'Legacy Auth',
          auth_provider_snapshot: 'codex',
          calls: 4,
          success: 3,
          failure: 1,
          tokens: 500,
          cost: 0.04,
          average_latency_ms: 200,
        } satisfies MonitoringAnalyticsChannelShareRow,
      ],
      new Map(),
      new Map(),
      sourceInfoMap,
      new Map()
    );

    expect(rows[0].label).toBe('Legacy Auth');
    expect(rows[0].provider).toBe('codex');
    expect(rows[0].label).not.toBe('legacy-auth');
  });

  it('uses readable account metadata for recent failures instead of hashes', () => {
    const rows = buildFailureRowsFromAnalytics(
      [
        {
          timestamp_ms: Date.UTC(2026, 4, 20, 1, 2, 3),
          model: 'gpt-test',
          api_key_hash: 'api-key-hash',
          source: 'm:sk-a...zzzz',
          source_hash: 'source-hash',
          auth_index: 'auth-1',
          account_snapshot: 'snapshot@example.com',
          auth_label_snapshot: 'Snapshot Auth',
          auth_provider_snapshot: 'codex',
          endpoint: 'POST /v1/chat/completions',
          duration_ms: 123,
          fail_status_code: 429,
          fail_summary: 'rate limit exceeded',
        },
      ],
      authMetaMap,
      authFileMap,
      sourceInfoMap,
      channelByAuthIndex
    );

    expect(rows[0].source).toBe('Team Auth');
    expect(rows[0].channel).toBe('Production Relay');
    expect(rows[0].source).not.toBe('source-hash');
  });

  it('uses readable source labels for failure source rows', () => {
    const rows = buildFailureSourceRowsFromAnalytics(
      [
        {
          source_hash: 'source-hash',
          auth_index: 'auth-1',
          calls: 10,
          failure: 2,
          last_seen_ms: Date.UTC(2026, 4, 20, 1, 2, 3),
          average_latency_ms: 120,
        },
      ],
      authMetaMap,
      authFileMap,
      sourceInfoMap,
      channelByAuthIndex
    );

    expect(rows[0].label).toBe('Team Auth');
    expect(rows[0].channel).toBe('Production Relay');
    expect(rows[0].label).not.toBe('source-hash');
  });
});
