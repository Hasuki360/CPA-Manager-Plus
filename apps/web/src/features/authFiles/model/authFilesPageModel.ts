import type { TFunction } from 'i18next';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import {
  normalizePlanType,
  resolveCodexChatgptAccountId,
  resolveCodexPlanType,
} from '@/utils/quota';
import {
  getTypeLabel,
  parsePriorityValue,
} from '@/features/authFiles/constants';

export const easePower3Out = (progress: number) => 1 - (1 - progress) ** 4;
export const easePower2In = (progress: number) => progress ** 3;
export const BATCH_BAR_BASE_TRANSFORM = 'translateX(-50%)';
export const BATCH_BAR_HIDDEN_TRANSFORM = 'translateX(-50%) translateY(56px)';
export const DEFAULT_REGULAR_PAGE_SIZE = 9;
export const DEFAULT_COMPACT_PAGE_SIZE = 12;

const escapeWildcardSearchSegment = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const buildWildcardSearch = (value: string): RegExp | null => {
  if (!value.includes('*')) return null;
  const pattern = value.split('*').map(escapeWildcardSearchSegment).join('.*');
  return new RegExp(pattern, 'i');
};

const PREMIUM_CODEX_PLAN_TYPES = new Set(['pro', 'prolite', 'pro-lite', 'pro_lite']);

export const compareAuthFileName = (left: { name: string }, right: { name: string }) =>
  left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });

const getAuthFileNoteValue = (file: AuthFileItem): string => {
  const raw = file.note ?? file['note'];
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
};

export const compareAuthFileNote = (
  left: AuthFileItem,
  right: AuthFileItem,
  direction: 'asc' | 'desc'
) => {
  const leftNote = getAuthFileNoteValue(left);
  const rightNote = getAuthFileNoteValue(right);
  const leftKnown = leftNote.length > 0;
  const rightKnown = rightNote.length > 0;

  if (leftKnown || rightKnown) {
    if (!leftKnown) return 1;
    if (!rightKnown) return -1;
    const diff = leftNote.localeCompare(rightNote, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    if (diff !== 0) return direction === 'asc' ? diff : -diff;
  }

  return compareAuthFileName(left, right);
};

export const compareAuthFilePriority = (
  left: AuthFileItem,
  right: AuthFileItem,
  direction: 'asc' | 'desc'
) => {
  const leftPriority = parsePriorityValue(left.priority ?? left['priority']);
  const rightPriority = parsePriorityValue(right.priority ?? right['priority']);
  const leftKnown = leftPriority !== undefined;
  const rightKnown = rightPriority !== undefined;

  if (leftKnown || rightKnown) {
    if (!leftKnown) return 1;
    if (!rightKnown) return -1;
    const leftValue = leftPriority ?? 0;
    const rightValue = rightPriority ?? 0;
    const diff = direction === 'desc' ? rightValue - leftValue : leftValue - rightValue;
    if (diff !== 0) return diff;
  }

  return compareAuthFileName(left, right);
};

export const stringifySearchValue = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(stringifySearchValue);
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  return [];
};

const getCodexPlanLabel = (
  planType: string | null | undefined,
  t: TFunction
): string | null => {
  const normalized = normalizePlanType(planType);
  if (!normalized) return null;
  if (normalized === 'pro') return t('codex_quota.plan_pro');
  if (PREMIUM_CODEX_PLAN_TYPES.has(normalized) && normalized !== 'pro') {
    return t('codex_quota.plan_prolite');
  }
  if (normalized === 'plus') return t('codex_quota.plan_plus');
  if (normalized === 'team') return t('codex_quota.plan_team');
  if (normalized === 'free') return t('codex_quota.plan_free');
  return planType || normalized;
};

const getAuthFilePlanType = (file: AuthFileItem, quota?: CodexQuotaState): string | null =>
  resolveCodexPlanType(file) ?? quota?.planType ?? null;

export const getAuthFilePlanSortRank = (
  file: AuthFileItem,
  quota?: CodexQuotaState
): number | null => {
  const normalized = normalizePlanType(getAuthFilePlanType(file, quota));
  if (!normalized) return null;
  if (normalized === 'pro') return 50;
  if (PREMIUM_CODEX_PLAN_TYPES.has(normalized) && normalized !== 'pro') return 40;
  if (normalized === 'team') return 30;
  if (normalized === 'plus') return 20;
  if (normalized === 'free') return 10;
  return 0;
};

export const getAuthFileSearchValues = (
  file: AuthFileItem,
  t: TFunction,
  quota?: CodexQuotaState
) => {
  const planType = getAuthFilePlanType(file, quota);
  const planLabel = getCodexPlanLabel(planType, t);
  const accountId = resolveCodexChatgptAccountId(file);
  const type = file.type || file.provider;

  return [
    file.name,
    file.type,
    file.provider,
    type ? getTypeLabel(t, String(type)) : null,
    file.authIndex,
    file['auth_index'],
    file.status,
    file.state,
    file.statusMessage,
    file['status_message'],
    file.error,
    file.errorStatus,
    file['error_status'],
    quota?.status,
    quota?.error,
    quota?.errorStatus,
    planType,
    planLabel,
    accountId,
  ];
};
