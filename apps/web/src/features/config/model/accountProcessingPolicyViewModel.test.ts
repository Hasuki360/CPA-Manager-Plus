import { describe, expect, it } from 'vitest';
import type { AccountProcessingPolicy } from '@/services/api/usageService';
import { buildAccountProcessingPolicyViewModel } from './accountProcessingPolicyViewModel';

function policy(overrides: Partial<AccountProcessingPolicy> = {}): AccountProcessingPolicy {
  return {
    source: 'startup',
    codexQuotaCooldown: {
      enabled: false,
      configured: false,
      source: 'startup',
      locked: false,
      envKey: 'USAGE_QUOTA_COOLDOWN_ENABLED',
      configFileKey: 'quotaCooldownEnabled',
    },
    antigravityQuotaCooldown: {
      enabled: false,
      configured: false,
      source: 'startup',
      locked: false,
      envKey: 'USAGE_ANTIGRAVITY_QUOTA_COOLDOWN_ENABLED',
      configFileKey: 'antigravityQuotaCooldownEnabled',
    },
    antigravityReverseProxy: {
      enabled: false,
      configured: false,
      source: 'startup',
      locked: false,
      envKey: '',
      configFileKey: 'antigravity.reverse-proxy.enabled',
    },
    authIssueQueue: {
      enabled: false,
      configured: false,
      source: 'startup',
      locked: false,
      envKey: 'USAGE_ACCOUNT_ACTIONS_ENABLED',
      configFileKey: 'accountActionsEnabled',
    },
    authIssueAutoDisable: {
      enabled: false,
      configured: false,
      source: 'startup',
      locked: false,
      envKey: 'USAGE_ACCOUNT_ACTIONS_AUTO_DISABLE',
      configFileKey: 'accountActionsAutoDisable',
      dependsOn: 'authIssueQueue',
    },
    charityModelMonitor: {
      enabled: false,
      configured: false,
      source: 'startup',
      locked: false,
      envKey: 'USAGE_CHARITY_MODEL_MONITOR_ENABLED',
      configFileKey: 'charityModelMonitorEnabled',
    },
    ...overrides,
  };
}

describe('buildAccountProcessingPolicyViewModel', () => {
  it('groups quota, auth issue, and header auto-update handling separately', () => {
    const groups = buildAccountProcessingPolicyViewModel(policy());

    expect(groups).toHaveLength(3);
    expect(groups[0].key).toBe('quota');
    expect(groups[0].items.map((item) => item.key)).toEqual([
      'providerQuotaCooldown',
      'antigravityQuotaCooldown',
      'antigravityReverseProxy',
    ]);
    expect(groups[1].key).toBe('authIssues');
    expect(groups[1].items.map((item) => item.key)).toEqual([
      'authIssueQueue',
      'authIssueAutoDisable',
    ]);
    expect(groups[2].key).toBe('extensions');
    expect(groups[2].items.map((item) => item.key)).toEqual(['charityModelMonitor']);
  });

  it('reflects the effective enabled state for the header auto-update toggle', () => {
    const groups = buildAccountProcessingPolicyViewModel(
      policy({
        charityModelMonitor: {
          enabled: true,
          configured: false,
          source: 'startup',
          locked: false,
          envKey: 'USAGE_CHARITY_MODEL_MONITOR_ENABLED',
          configFileKey: 'charityModelMonitorEnabled',
        },
      })
    );

    const charity = groups[2].items[0];
    expect(charity.configured).toBe(true);
    expect(charity.enabled).toBe(true);
    expect(charity.statusTone).toBe('on');
    expect(charity.toggleDisabled).toBe(false);
  });

  it('marks auto-disable as configured but blocked when its dependency is off', () => {
    const groups = buildAccountProcessingPolicyViewModel(
      policy({
        authIssueAutoDisable: {
          enabled: false,
          configured: true,
          source: 'database',
          locked: false,
          envKey: 'USAGE_ACCOUNT_ACTIONS_AUTO_DISABLE',
          configFileKey: 'accountActionsAutoDisable',
          dependsOn: 'authIssueQueue',
        },
      })
    );

    const autoDisable = groups[1].items[1];
    expect(autoDisable.configured).toBe(true);
    expect(autoDisable.enabled).toBe(false);
    expect(autoDisable.dependencyBlocked).toBe(true);
    expect(autoDisable.effectiveStateKey).toBe('accountPolicy.effective_blocked');
    expect(autoDisable.configuredStateKey).toBe('accountPolicy.configured_on');
    expect(autoDisable.toggleDisabled).toBe(false);
  });

  it('prevents enabling auto-disable before the auth issue queue is effective', () => {
    const groups = buildAccountProcessingPolicyViewModel(policy());

    const autoDisable = groups[1].items[1];
    expect(autoDisable.dependencyBlocked).toBe(true);
    expect(autoDisable.configured).toBe(false);
    expect(autoDisable.toggleDisabled).toBe(true);
  });

  it('uses locked status when a capability is controlled by environment variables', () => {
    const groups = buildAccountProcessingPolicyViewModel(
      policy({
        codexQuotaCooldown: {
          enabled: true,
          configured: true,
          source: 'env',
          locked: true,
          envKey: 'USAGE_QUOTA_COOLDOWN_ENABLED',
          configFileKey: 'quotaCooldownEnabled',
        },
      })
    );

    const quota = groups[0].items[0];
    expect(quota.key).toBe('providerQuotaCooldown');
    expect(quota.locked).toBe(true);
    expect(quota.statusTone).toBe('locked');
    expect(quota.toggleDisabled).toBe(true);
    expect(quota.effectiveStateKey).toBe('accountPolicy.effective_on');
  });
});
