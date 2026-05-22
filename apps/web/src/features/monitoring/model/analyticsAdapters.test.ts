import { describe, expect, it } from 'vitest';
import type { MonitoringAnalyticsEventRow } from '@/services/api/usageService';
import { buildUsageDetailsFromAnalyticsEvents } from './analyticsAdapters';

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
        input_tokens: 10,
        output_tokens: 5,
        cached_tokens: 2,
        reasoning_tokens: 1,
        total_tokens: 18,
        latency_ms: 123,
        failed: false,
      },
    ];

    const details = buildUsageDetailsFromAnalyticsEvents(events);

    expect(details[0]).toMatchObject({
      __modelName: 'alias-model',
      __resolvedModel: 'upstream-model',
      auth_project_id_snapshot: 'project-1',
    });
  });
});
