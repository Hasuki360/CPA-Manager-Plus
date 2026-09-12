import type { AccountPolicyCapability, AccountProcessingPolicy } from '@/services/api/usageService';

export type AccountPolicyCapabilityKey =
  | 'providerQuotaCooldown'
  | 'antigravityQuotaCooldown'
  | 'antigravityReverseProxy'
  | 'authIssueQueue'
  | 'authIssueAutoDisable'
  | 'charityModelMonitor';

export type AccountPolicyGroupKey = 'quota' | 'authIssues' | 'extensions';

export interface AccountPolicyViewOptions {
  loading?: boolean;
  savingKey?: AccountPolicyCapabilityKey | null;
}

export interface AccountPolicyViewItem {
  key: AccountPolicyCapabilityKey;
  capability: AccountPolicyCapability;
  configured: boolean;
  enabled: boolean;
  locked: boolean;
  source: string;
  dependencyKey?: AccountPolicyCapabilityKey;
  dependencyBlocked: boolean;
  toggleDisabled: boolean;
  nested: boolean;
  titleKey: string;
  descriptionKey: string;
  behaviorKey: string;
  summaryKey: string;
  toggleLabelKey: string;
  effectiveStateKey: string;
  configuredStateKey: string;
  statusTone: 'on' | 'off' | 'blocked' | 'locked';
}

export interface AccountPolicyViewGroup {
  key: AccountPolicyGroupKey;
  titleKey: string;
  descriptionKey: string;
  items: AccountPolicyViewItem[];
}

const capabilityKeys: AccountPolicyCapabilityKey[] = [
  'providerQuotaCooldown',
  'antigravityQuotaCooldown',
  'antigravityReverseProxy',
  'authIssueQueue',
  'authIssueAutoDisable',
  'charityModelMonitor',
];

const capabilitySourceKey: Record<
  AccountPolicyCapabilityKey,
  | 'codexQuotaCooldown'
  | 'antigravityQuotaCooldown'
  | 'antigravityReverseProxy'
  | 'authIssueQueue'
  | 'authIssueAutoDisable'
  | 'charityModelMonitor'
> = {
  providerQuotaCooldown: 'codexQuotaCooldown',
  antigravityQuotaCooldown: 'antigravityQuotaCooldown',
  antigravityReverseProxy: 'antigravityReverseProxy',
  authIssueQueue: 'authIssueQueue',
  authIssueAutoDisable: 'authIssueAutoDisable',
  charityModelMonitor: 'charityModelMonitor',
};

const capabilityMetadata: Record<
  AccountPolicyCapabilityKey,
  Pick<
    AccountPolicyViewItem,
    'titleKey' | 'descriptionKey' | 'behaviorKey' | 'summaryKey' | 'toggleLabelKey' | 'nested'
  >
> = {
  providerQuotaCooldown: {
    titleKey: 'accountPolicy.providerQuotaCooldown_title',
    descriptionKey: 'accountPolicy.providerQuotaCooldown_description',
    behaviorKey: 'accountPolicy.providerQuotaCooldown_behavior',
    summaryKey: 'accountPolicy.providerQuotaCooldown_summary',
    toggleLabelKey: 'accountPolicy.providerQuotaCooldown_toggle',
    nested: false,
  },
  antigravityQuotaCooldown: {
    titleKey: 'accountPolicy.antigravityQuotaCooldown_title',
    descriptionKey: 'accountPolicy.antigravityQuotaCooldown_description',
    behaviorKey: 'accountPolicy.antigravityQuotaCooldown_behavior',
    summaryKey: 'accountPolicy.antigravityQuotaCooldown_summary',
    toggleLabelKey: 'accountPolicy.antigravityQuotaCooldown_toggle',
    nested: false,
  },
  antigravityReverseProxy: {
    titleKey: 'accountPolicy.antigravityReverseProxy_title',
    descriptionKey: 'accountPolicy.antigravityReverseProxy_description',
    behaviorKey: 'accountPolicy.antigravityReverseProxy_behavior',
    summaryKey: 'accountPolicy.antigravityReverseProxy_summary',
    toggleLabelKey: 'accountPolicy.antigravityReverseProxy_toggle',
    nested: false,
  },
  authIssueQueue: {
    titleKey: 'accountPolicy.authIssueQueue_title',
    descriptionKey: 'accountPolicy.authIssueQueue_description',
    behaviorKey: 'accountPolicy.authIssueQueue_behavior',
    summaryKey: 'accountPolicy.authIssueQueue_summary',
    toggleLabelKey: 'accountPolicy.authIssueQueue_toggle',
    nested: false,
  },
  authIssueAutoDisable: {
    titleKey: 'accountPolicy.authIssueAutoDisable_title',
    descriptionKey: 'accountPolicy.authIssueAutoDisable_description',
    behaviorKey: 'accountPolicy.authIssueAutoDisable_behavior',
    summaryKey: 'accountPolicy.authIssueAutoDisable_summary',
    toggleLabelKey: 'accountPolicy.authIssueAutoDisable_toggle',
    nested: true,
  },
  charityModelMonitor: {
    titleKey: 'accountPolicy.charityModelMonitor_title',
    descriptionKey: 'accountPolicy.charityModelMonitor_description',
    behaviorKey: 'accountPolicy.charityModelMonitor_behavior',
    summaryKey: 'accountPolicy.charityModelMonitor_summary',
    toggleLabelKey: 'accountPolicy.charityModelMonitor_toggle',
    nested: false,
  },
};

const groupDefinitions: Array<{
  key: AccountPolicyGroupKey;
  titleKey: string;
  descriptionKey: string;
  itemKeys: AccountPolicyCapabilityKey[];
}> = [
  {
    key: 'quota',
    titleKey: 'accountPolicy.group_quota_title',
    descriptionKey: 'accountPolicy.group_quota_description',
    itemKeys: ['providerQuotaCooldown', 'antigravityQuotaCooldown', 'antigravityReverseProxy'],
  },
  {
    key: 'authIssues',
    titleKey: 'accountPolicy.group_auth_issues_title',
    descriptionKey: 'accountPolicy.group_auth_issues_description',
    itemKeys: ['authIssueQueue', 'authIssueAutoDisable'],
  },
  {
    key: 'extensions',
    titleKey: 'accountPolicy.group_extensions_title',
    descriptionKey: 'accountPolicy.group_extensions_description',
    itemKeys: ['charityModelMonitor'],
  },
];

export function buildAccountProcessingPolicyViewModel(
  status: AccountProcessingPolicy,
  options: AccountPolicyViewOptions = {}
): AccountPolicyViewGroup[] {
  const itemByKey = Object.fromEntries(
    capabilityKeys.map((key) => [key, buildItem(status, key, options)])
  ) as Record<AccountPolicyCapabilityKey, AccountPolicyViewItem>;

  return groupDefinitions.map((group) => ({
    key: group.key,
    titleKey: group.titleKey,
    descriptionKey: group.descriptionKey,
    items: group.itemKeys.map((key) => itemByKey[key]),
  }));
}

function buildItem(
  status: AccountProcessingPolicy,
  key: AccountPolicyCapabilityKey,
  options: AccountPolicyViewOptions
): AccountPolicyViewItem {
  const capability = status[capabilitySourceKey[key]];
  // charityModelMonitor's backend "configured" flag only means "explicitly set
  // in the database"; the toggle should reflect the effective switch instead.
  const configured =
    key === 'charityModelMonitor'
      ? Boolean(capability.enabled)
      : (capability.configured ?? capability.enabled);
  const enabled = Boolean(capability.enabled);
  const locked = Boolean(capability.locked);
  const dependencyKey = parseCapabilityKey(capability.dependsOn);
  const dependencyCapability = dependencyKey
    ? status[capabilitySourceKey[dependencyKey]]
    : undefined;
  const dependencyBlocked = Boolean(
    dependencyKey && dependencyCapability && !dependencyCapability.enabled
  );
  const toggleDisabled = Boolean(
    options.loading ||
    (options.savingKey !== null && options.savingKey !== undefined) ||
    locked ||
    (dependencyBlocked && !configured)
  );
  const statusTone = locked ? 'locked' : dependencyBlocked ? 'blocked' : enabled ? 'on' : 'off';

  return {
    key,
    capability,
    configured: Boolean(configured),
    enabled,
    locked,
    source: capability.source || 'startup',
    dependencyKey,
    dependencyBlocked,
    toggleDisabled,
    effectiveStateKey: dependencyBlocked
      ? 'accountPolicy.effective_blocked'
      : enabled
        ? 'accountPolicy.effective_on'
        : 'accountPolicy.effective_off',
    configuredStateKey: configured ? 'accountPolicy.configured_on' : 'accountPolicy.configured_off',
    statusTone,
    ...capabilityMetadata[key],
  };
}

function parseCapabilityKey(value?: string): AccountPolicyCapabilityKey | undefined {
  if (!value) return undefined;
  return capabilityKeys.includes(value as AccountPolicyCapabilityKey)
    ? (value as AccountPolicyCapabilityKey)
    : undefined;
}
