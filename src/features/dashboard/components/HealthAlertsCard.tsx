import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DashboardChannelHealth,
  DashboardRecentFailure,
} from '@/services/api/usageService';
import type { MonitoringAuthMeta, MonitoringChannelMeta } from '@/features/monitoring/model/types';
import { formatDurationMs, normalizeAuthIndex } from '@/utils/usage';
import styles from './HealthAlertsCard.module.scss';

interface HealthAlertsCardProps {
  loading: boolean;
  recentFailures: DashboardRecentFailure[];
  channelHealth: DashboardChannelHealth[];
  authMetaMap: Map<string, MonitoringAuthMeta>;
  channelByAuthIndex: Map<string, MonitoringChannelMeta>;
  apiKeyAliasMap: Map<string, string>;
}

const shortHash = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return '-';
  return trimmed.length <= 12 ? trimmed : `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
};

export function HealthAlertsCard({
  loading,
  recentFailures,
  channelHealth,
  authMetaMap,
  channelByAuthIndex,
  apiKeyAliasMap,
}: HealthAlertsCardProps) {
  const { t, i18n } = useTranslation();

  const formatPercent = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        style: 'percent',
        maximumFractionDigits: 1,
      }).format,
    [i18n.language]
  );

  const resolveAuthMeta = (authIndex: string | undefined) => {
    const normalized = normalizeAuthIndex(authIndex) ?? '';
    if (!normalized || normalized === '-') return {};

    const authMeta = authMetaMap.get(normalized);
    const channelMeta =
      channelByAuthIndex.get(normalized) ||
      (authMeta?.authIndex ? channelByAuthIndex.get(authMeta.authIndex) : undefined);

    return { normalized, authMeta, channelMeta };
  };

  const resolveAuthDisplay = (authIndex: string | undefined, fallback = '') => {
    const { normalized, authMeta, channelMeta } = resolveAuthMeta(authIndex);
    if (!normalized) return fallback;

    return (
      channelMeta?.name ||
      authMeta?.label ||
      authMeta?.account ||
      authMeta?.provider ||
      fallback ||
      normalized
    );
  };

  const resolveChannelBaseDisplay = (channel: DashboardChannelHealth) => {
    const record = channel as DashboardChannelHealth & {
      auth_label?: string;
      account?: string;
      channel?: string;
    };
    const { normalized, authMeta, channelMeta } = resolveAuthMeta(channel.auth_index);
    const base =
      record.channel?.trim() ||
      channelMeta?.name ||
      record.auth_label?.trim() ||
      authMeta?.label ||
      record.account?.trim() ||
      authMeta?.account ||
      authMeta?.provider ||
      normalized ||
      channel.auth_index;

    const suffixCandidates = [
      record.auth_label,
      record.account,
      authMeta?.label,
      authMeta?.account,
      authMeta?.provider,
      normalized ? `#${shortHash(normalized)}` : '',
    ]
      .map((item) => item?.trim())
      .filter((item): item is string => Boolean(item && item !== '-' && item !== base));
    const suffix = Array.from(new Set(suffixCandidates))[0] || '';
    const title = [base, suffix, normalized || channel.auth_index].filter(Boolean).join(' · ');

    return { base, suffix, title };
  };

  const channelRows = channelHealth.slice(0, 5).map((channel, index) => ({
    channel,
    key: `${channel.auth_index}-${index}`,
    display: resolveChannelBaseDisplay(channel),
  }));
  const channelNameCounts = channelRows.reduce((map, row) => {
    map.set(row.display.base, (map.get(row.display.base) ?? 0) + 1);
    return map;
  }, new Map<string, number>());

  const resolveRecentFailureDisplay = (failure: DashboardRecentFailure) => {
    const record = failure as DashboardRecentFailure & {
      auth_label?: string;
      account?: string;
      channel?: string;
      api_key_alias?: string;
      source?: string;
    };
    const apiKeyAlias = apiKeyAliasMap.get((failure.api_key_hash || '').toLowerCase());
    return (
      record.channel?.trim() ||
      record.auth_label?.trim() ||
      record.account?.trim() ||
      resolveAuthDisplay(failure.auth_index) ||
      record.api_key_alias?.trim() ||
      apiKeyAlias ||
      record.source?.trim() ||
      shortHash(failure.source_hash || failure.api_key_hash)
    );
  };

  return (
    <>
      {/* 1. 渠道健康状态 */}
      <section className={styles.dataCard}>
        <div className={styles.cardHeader}>
          <h3>{t('dashboard.channel_health_status')}</h3>
        </div>
        <div className={styles.list}>
          {channelRows.map(({ channel, key, display }) => {
            const isDuplicateName = (channelNameCounts.get(display.base) ?? 0) > 1;
            const label =
              channel.auth_index === '-'
                ? t('dashboard.health_unlinked_channel')
                : isDuplicateName && display.suffix
                  ? `${display.base} · ${display.suffix}`
                  : display.base;

            return (
              <div key={key} className={styles.listItem}>
                <span className={`${styles.statusDot} ${styles[channel.tone] || ''}`} />
                <span
                  className={styles.label}
                  title={channel.auth_index === '-' ? undefined : display.title}
                >
                  {label}
                </span>
                <span className={styles.value}>{formatPercent(channel.success_rate)}</span>
              </div>
            );
          })}
          {channelHealth.length === 0 ? (
            <div className={styles.empty}>{loading ? '...' : t('dashboard.no_channel_health_data')}</div>
          ) : null}
        </div>
      </section>

      {/* 2. 最近失败请求 */}
      <section className={styles.dataCard}>
        <div className={styles.cardHeader}>
          <h3>{t('dashboard.recent_failed_requests')}</h3>
        </div>
        <div className={styles.list}>
          {recentFailures.slice(0, 3).map((failure) => (
            <div key={`${failure.timestamp_ms}-${failure.source_hash}-${failure.model}`} className={styles.failureItem}>
              <div className={styles.failureMeta}>
                <span className={styles.time}>{new Date(failure.timestamp_ms).toLocaleTimeString(i18n.language)}</span>
                <span className={styles.model}>{failure.model}</span>
              </div>
              <div className={styles.failureDetail}>
                <span title={[failure.auth_index, failure.source_hash, failure.api_key_hash].filter(Boolean).join(' · ')}>
                  {resolveRecentFailureDisplay(failure)}
                </span>
                <span>{formatDurationMs(failure.duration_ms, { locale: i18n.language })}</span>
              </div>
            </div>
          ))}
          {recentFailures.length === 0 ? (
            <div className={styles.empty}>{loading ? '...' : t('dashboard.no_recent_failures')}</div>
          ) : null}
        </div>
      </section>
    </>
  );
}
