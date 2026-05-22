import type { TFunction } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchClaudeQuota,
  fetchGeminiCliCodeAssist,
  fetchGeminiCliQuotaBuckets,
} from '@/utils/quota';
import type { MonitoringAccountQuotaTarget } from '@/features/monitoring/accountOverviewQuotaTargets';
import { requestAccountQuota } from './monitoringCenterPageModel';

vi.mock('@/utils/quota', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/quota')>();
  return {
    ...actual,
    fetchAntigravityQuota: vi.fn(),
    fetchClaudeQuota: vi.fn(),
    fetchCodexQuota: vi.fn(),
    fetchGeminiCliCodeAssist: vi.fn(),
    fetchGeminiCliQuotaBuckets: vi.fn(),
    fetchKimiQuota: vi.fn(),
  };
});

const t = ((key: string, options?: Record<string, unknown>) => {
  const copy: Record<string, string> = {
    'antigravity_quota.title': 'Antigravity Quota',
    'claude_quota.title': 'Claude Quota',
    'claude_quota.plan_label': 'Plan',
    'claude_quota.plan_pro': 'Pro',
    'claude_quota.extra_usage_label': 'Extra Usage',
    'claude_quota.empty_windows': 'No Claude quota data',
    'claude_quota.five_hour': '5-hour limit',
    'codex_quota.title': 'Codex Quota',
    'codex_quota.empty_windows': 'No Codex quota data',
    'gemini_cli_quota.title': 'Gemini CLI Quota',
    'gemini_cli_quota.tier_label': 'Tier',
    'gemini_cli_quota.credit_label': 'Google One AI Credits',
    'gemini_cli_quota.credit_amount': '{{count}} credits',
    'gemini_cli_quota.empty_buckets': 'No Gemini quota data',
    'gemini_cli_quota.remaining_amount': 'Remaining {{count}}',
    'kimi_quota.title': 'Kimi Quota',
    'kimi_quota.empty_data': 'No Kimi quota data',
  };
  let value = copy[key] ?? key;
  Object.entries(options ?? {}).forEach(([name, replacement]) => {
    value = value.replace(`{{${name}}}`, String(replacement));
  });
  return value;
}) as TFunction;

const createTarget = (
  overrides: Partial<MonitoringAccountQuotaTarget>
): MonitoringAccountQuotaTarget => ({
  key: overrides.key ?? 'claude::1::auth.json',
  provider: overrides.provider ?? 'claude',
  authIndex: overrides.authIndex ?? '1',
  authLabel: overrides.authLabel ?? 'Auth',
  fileName: overrides.fileName ?? 'auth.json',
  file: overrides.file ?? {
    name: overrides.fileName ?? 'auth.json',
    type: overrides.provider ?? 'claude',
    authIndex: overrides.authIndex ?? '1',
  },
  accountId: overrides.accountId ?? null,
  planType: overrides.planType ?? null,
});

describe('monitoringCenterPageModel account quota', () => {
  beforeEach(() => {
    vi.mocked(fetchClaudeQuota).mockReset();
    vi.mocked(fetchGeminiCliCodeAssist).mockReset();
    vi.mocked(fetchGeminiCliQuotaBuckets).mockReset();
  });

  it('maps Claude usage windows into account quota entries', async () => {
    vi.mocked(fetchClaudeQuota).mockResolvedValue({
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          labelKey: 'claude_quota.five_hour',
          usedPercent: 40,
          resetLabel: '05/20 12:00',
        },
      ],
      planType: 'plan_pro',
      extraUsage: {
        is_enabled: true,
        used_credits: 150,
        monthly_limit: 500,
        utilization: null,
      },
    });

    const entry = await requestAccountQuota(createTarget({ provider: 'claude' }), t);

    expect(entry).toMatchObject({
      provider: 'claude',
      providerLabel: 'Claude Quota',
      metaLabels: ['Claude Quota', 'Plan: Pro', 'Extra Usage: $1.50 / $5.00'],
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          remainingPercent: 60,
          resetLabel: '05/20 12:00',
        },
      ],
    });
  });

  it('maps Gemini CLI buckets and supplementary tier metadata', async () => {
    vi.mocked(fetchGeminiCliQuotaBuckets).mockResolvedValue({
      authIndex: '2',
      projectId: 'project-1',
      buckets: [
        {
          id: 'gemini-pro-series',
          label: 'Gemini Pro Series',
          remainingFraction: 0.25,
          remainingAmount: 12,
          resetTime: undefined,
          tokenType: 'tokens',
        },
      ],
    });
    vi.mocked(fetchGeminiCliCodeAssist).mockResolvedValue({
      tierLabel: 'Ultra',
      tierId: 'g1-ultra-tier',
      creditBalance: 7,
    });

    const entry = await requestAccountQuota(
      createTarget({
        provider: 'gemini-cli',
        authIndex: '2',
        fileName: 'gemini-cli.json',
      }),
      t
    );

    expect(entry.metaLabels).toEqual([
      'Gemini CLI Quota',
      'Tier: Ultra',
      'Google One AI Credits: 7 credits',
    ]);
    expect(entry.windows).toMatchObject([
      {
        id: 'gemini-pro-series',
        label: 'Gemini Pro Series',
        remainingPercent: 25,
        resetLabel: '-',
        usageLabel: 'Remaining 12 · tokens',
      },
    ]);
    expect(fetchGeminiCliCodeAssist).toHaveBeenCalledWith('2', 'project-1', t);
  });
});
