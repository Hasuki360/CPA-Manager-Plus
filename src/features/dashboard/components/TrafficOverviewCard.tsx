import { useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DashboardTodayRequestHealthTimeline,
  DashboardTodayRequestHealthTimelinePoint,
  DashboardTokenMixSegment,
  DashboardTrafficPoint,
} from '@/services/api/usageService';
import { formatCompactNumber } from '@/utils/usage';
import styles from './TrafficOverviewCard.module.scss';

interface TrafficOverviewCardProps {
  timeline: DashboardTrafficPoint[];
  todayRequestHealthTimeline: DashboardTodayRequestHealthTimeline | null;
  tokenMix: DashboardTokenMixSegment[];
  loading: boolean;
}

type ChartStyle = CSSProperties & Record<'--calls-share' | '--tokens-share', number>;
type HealthCellStyle = CSSProperties & Record<'--cell-intensity', number>;
type DonutStyle = CSSProperties & Record<'--dash' | '--offset' | '--color', string>;

const fallbackHealthBucketMs = 10 * 60 * 1000;

const formatHour = (bucketMs: number, locale: string) =>
  new Date(bucketMs).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
  });

const tokenLabelMap: Record<string, string> = {
  input: 'dashboard.token_mix_input',
  output: 'dashboard.token_mix_output',
  reasoning: 'dashboard.token_mix_reasoning',
  cached: 'dashboard.token_mix_cached',
};

const tokenColorMap: Record<string, string> = {
  input: '#3b82f6',
  output: '#10b981',
  reasoning: '#8b5cf6',
  cached: '#f59e0b',
};

const healthToneClassMap: Record<string, string> = {
  future: 'healthFuture',
  empty: 'healthEmpty',
  good: 'healthGood',
  warn: 'healthWarn',
  bad: 'healthBad',
};

const formatPercent = (value: number | undefined, digits = 1) => {
  if (value === undefined || !Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(digits)}%`;
};

const formatMinuteLabel = (bucketMs: number | undefined, locale: string) => {
  if (!bucketMs) return '--';
  return new Date(bucketMs).toLocaleTimeString(locale, {
    minute: '2-digit',
  });
};

const buildHealthTitle = (
  point: DashboardTodayRequestHealthTimelinePoint,
  locale: string,
  t: (key: string) => string
) => {
  const time = formatHour(point.bucket_ms, locale);
  return `${time} · ${t('dashboard.traffic_calls')}: ${formatCompactNumber(point.calls)} · ${t('dashboard.request_health_success')}: ${formatCompactNumber(point.success)} · ${t('dashboard.request_health_failure')}: ${formatCompactNumber(point.failure)} · ${t('dashboard.success_rate')}: ${formatPercent(point.success_rate)}`;
};

export function TrafficOverviewCard({
  timeline,
  todayRequestHealthTimeline,
  tokenMix,
  loading,
}: TrafficOverviewCardProps) {
  const { t, i18n } = useTranslation();
  const [activeTokenSegment, setActiveTokenSegment] = useState<DashboardTokenMixSegment | null>(null);
  const hasData = timeline.some((point) => point.calls > 0 || point.tokens > 0);
  const totalTokens = tokenMix.reduce((acc, s) => acc + s.tokens, 0);
  const tokenPolyline = timeline
    .map((point, index) => {
      const x = timeline.length <= 1 ? 50 : (index / (timeline.length - 1)) * 100;
      const y = 100 - Math.max(0, Math.min(1, point.tokens_share)) * 100;
      return `${x},${y}`;
    })
    .join(' ');
  const healthPoints = todayRequestHealthTimeline?.points ?? [];
  const healthBucketMs = todayRequestHealthTimeline?.bucket_ms || fallbackHealthBucketMs;
  const healthRowsPerHour = Math.max(1, Math.round((60 * 60 * 1000) / healthBucketMs));
  const healthRows = healthPoints.length
    ? Array.from({ length: healthRowsPerHour }, (_, minuteIndex) =>
        Array.from({ length: 24 }, (_, hourIndex) => healthPoints[hourIndex * healthRowsPerHour + minuteIndex])
      )
    : [];
  const hourLabelIndexes = [0, 6, 12, 18, 23];

  return (
    <div className={styles.chartsGrid}>
      {/* 1. 流量趋势 */}
      <section className={`${styles.chartCard} ${styles.activityCard}`}>
        <div className={styles.cardHeader}>
          <h3>{t('dashboard.traffic_trend_today')}</h3>
          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={styles.dot} style={{ background: '#3b82f6' }} />{' '}
              {t('dashboard.traffic_calls')}
            </span>
            <span className={styles.legendItem}>
              <span className={styles.dot} style={{ background: '#10b981' }} />{' '}
              {t('dashboard.traffic_tokens')}
            </span>
          </div>
        </div>
        <div className={styles.chartFrame}>
          <div className={styles.yAxisLeft}>{t('dashboard.traffic_calls')}</div>
          <div className={styles.yAxisRight}>{t('dashboard.traffic_tokens')}</div>
          <div className={styles.barChart}>
            {timeline.map((point) => (
              <div
                key={point.bucket_ms}
                className={styles.barColumn}
                style={
                  {
                    '--calls-share': point.calls_share,
                    '--tokens-share': point.tokens_share,
                  } as ChartStyle
                }
                title={`${formatHour(point.bucket_ms, i18n.language)} · ${t('dashboard.traffic_calls')}: ${formatCompactNumber(point.calls)} · ${t('dashboard.traffic_tokens')}: ${formatCompactNumber(point.tokens)}`}
              >
                <div className={styles.callBar} />
              </div>
            ))}
            {hasData && (
              <svg className={styles.tokenLine} viewBox="0 0 100 100" preserveAspectRatio="none">
                <polyline points={tokenPolyline} />
              </svg>
            )}
            {!hasData && !loading && (
              <div className={styles.empty}>{t('dashboard.no_traffic_data')}</div>
            )}
            {loading && !hasData && <div className={styles.empty}>...</div>}
          </div>
        </div>
        <div className={styles.xAxis}>
          <span>00:00</span>
          <span>04:00</span>
          <span>08:00</span>
          <span>12:00</span>
          <span>16:00</span>
          <span>20:00</span>
        </div>
      </section>

      {/* 2. 请求健康时间线 */}
      <section className={`${styles.chartCard} ${styles.healthTimelineCard}`}>
        <div className={`${styles.cardHeader} ${styles.healthHeader}`}>
          <div className={styles.healthTitle}>
            <h3>{t('dashboard.request_health_timeline')}</h3>
            <p>{t('dashboard.request_health_timeline_desc')}</p>
          </div>
          <div className={styles.healthSummary}>
            <strong>{todayRequestHealthTimeline ? formatPercent(todayRequestHealthTimeline.success_rate) : '-'}</strong>
            <div className={styles.healthCounts}>
              <span>
                <i className={styles.healthGood} />{' '}
                {formatCompactNumber(todayRequestHealthTimeline?.success_calls ?? 0)}
              </span>
              <span>
                <i className={styles.healthBad} />{' '}
                {formatCompactNumber(todayRequestHealthTimeline?.failure_calls ?? 0)}
              </span>
            </div>
          </div>
        </div>
        <div className={styles.healthMatrix}>
          {healthRows.length > 0 ? (
            <div className={styles.healthHourAxis}>
              {hourLabelIndexes.map((index) => {
                const point = healthRows[0]?.[index];
                return (
                  <span key={index} style={{ gridColumn: index + 2 }}>
                    {point ? formatHour(point.bucket_ms, i18n.language).slice(0, 2) : '--'}
                  </span>
                );
              })}
            </div>
          ) : null}
          {healthRows.map((row, minuteIndex) => (
            <div key={minuteIndex} className={styles.healthDayRow}>
              <span className={styles.healthDayLabel}>
                {formatMinuteLabel(row[0]?.bucket_ms, i18n.language)}
              </span>
              <div className={styles.healthDayCells}>
                {row.map((point, hourIndex) =>
                  point ? (
                    <div
                      key={point.bucket_ms}
                      className={`${styles.healthCell} ${styles[healthToneClassMap[point.tone] ?? 'healthEmpty']}`}
                      style={{ '--cell-intensity': point.intensity } as HealthCellStyle}
                      title={buildHealthTitle(point, i18n.language, t)}
                    />
                  ) : (
                    <div
                      key={`${minuteIndex}-${hourIndex}`}
                      className={`${styles.healthCell} ${styles.healthFuture}`}
                    />
                  )
                )}
              </div>
            </div>
          ))}
          {healthPoints.length === 0 && !loading ? (
            <div className={styles.healthEmptyState}>{t('dashboard.request_health_no_data')}</div>
          ) : null}
          {healthPoints.length === 0 && loading ? (
            <div className={styles.healthEmptyState}>...</div>
          ) : null}
        </div>
        <div className={styles.healthLegend}>
          <span><i className={styles.healthEmpty} /> {t('dashboard.request_health_no_request')}</span>
          <span><i className={styles.healthGood} /> {t('dashboard.request_health_success')}</span>
          <span><i className={styles.healthWarn} /> {t('dashboard.request_health_warning')}</span>
          <span><i className={styles.healthBad} /> {t('dashboard.request_health_failure')}</span>
          <span><i className={styles.healthFuture} /> {t('dashboard.request_health_future')}</span>
        </div>
      </section>

      {/* 3. Token 构成 */}
      <section className={`${styles.chartCard} ${styles.tokenCard}`}>
        <div className={styles.cardHeader}>
          <h3>{t('dashboard.token_mix_today')}</h3>
        </div>
        <div className={styles.doughnutSection}>
          <div className={styles.doughnutChart}>
            <svg viewBox="0 0 100 100">
              <circle className={styles.doughnutTrack} cx="50" cy="50" r="35" />
              {
                tokenMix.reduce(
                  (acc, segment) => {
                    const startAngle = acc.currentAngle;
                    const sweepAngle = segment.share * 360;
                    acc.currentAngle += sweepAngle;

                    const radius = 35;
                    const circumference = 2 * Math.PI * radius;
                    const offset = (startAngle / 360) * circumference;
                    const length = segment.share * circumference;

                    return {
                      ...acc,
                      elements: [
                        ...acc.elements,
                        <circle
                          key={segment.key}
                          cx="50"
                          cy="50"
                          r={radius}
                          fill="none"
                          className={`${styles.doughnutSegment} ${
                            activeTokenSegment?.key === segment.key ? styles.doughnutSegmentActive : ''
                          }`}
                          style={
                            {
                              '--dash': `${length} ${circumference}`,
                              '--offset': `${-offset}`,
                              '--color': tokenColorMap[segment.key] || '#ccc',
                            } as DonutStyle
                          }
                          tabIndex={0}
                          role="img"
                          aria-label={`${t(tokenLabelMap[segment.key] || segment.key)} ${formatCompactNumber(segment.tokens)} ${(segment.share * 100).toFixed(1)}%`}
                          onMouseEnter={() => setActiveTokenSegment(segment)}
                          onMouseLeave={() => setActiveTokenSegment(null)}
                          onFocus={() => setActiveTokenSegment(segment)}
                          onBlur={() => setActiveTokenSegment(null)}
                        />,
                      ],
                    };
                  },
                  { currentAngle: 0, elements: [] as ReactNode[] }
                ).elements
              }
            </svg>
            <div className={styles.doughnutCenter}>
              <span className={styles.centerLabel}>{t('dashboard.total_tokens')}</span>
              <span className={styles.centerValue}>{formatCompactNumber(totalTokens)}</span>
            </div>
            {tokenMix.length === 0 ? (
              <div className={styles.tokenEmptyState}>
                {loading ? '...' : t('dashboard.no_token_mix_data')}
              </div>
            ) : null}
            {activeTokenSegment ? (
              <div className={styles.tokenTooltip}>
                <span className={styles.tokenTooltipLabel}>
                  <i style={{ background: tokenColorMap[activeTokenSegment.key] || '#ccc' }} />
                  {t(tokenLabelMap[activeTokenSegment.key] || activeTokenSegment.key)}
                </span>
                <strong>{formatCompactNumber(activeTokenSegment.tokens)}</strong>
                <span>{(activeTokenSegment.share * 100).toFixed(1)}%</span>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
