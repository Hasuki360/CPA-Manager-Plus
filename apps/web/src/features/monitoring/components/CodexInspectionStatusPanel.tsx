import { Link } from 'react-router-dom';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import {
  IconExternalLink,
  IconSettings,
} from '@/components/ui/icons';
import {
  type CodexInspectionConfigurableSettings,
  type CodexInspectionProgressSnapshot,
} from '@/features/monitoring/codexInspection';
import {
  type RunStatus,
  type StatusTone,
  type SummaryCard,
} from '@/features/monitoring/model/codexInspectionPresentation';
import styles from '../CodexInspectionPage.module.scss';

type CodexInspectionStatusPanelProps = {
  inspectionSettings: CodexInspectionConfigurableSettings;
  statusTone: StatusTone;
  statusLabel: string;
  autoActionModeLabel: string;
  lastFinishedLabel: string | null;
  pendingActionCount: number;
  summaryCards: SummaryCard[];
  progress: CodexInspectionProgressSnapshot;
  progressLabel: string;
  showProgressBar: boolean;
  runStatus: RunStatus;
  runButtonLabel: string;
  executing: boolean;
  isInspectionInFlight: boolean;
  runDisabled: boolean;
  t: TFunction;
  onOpenSettings: () => void;
  onRunInspection: () => void;
  onPauseInspection: () => void;
  onStopInspection: () => void;
};

export function CodexInspectionStatusPanel({
  inspectionSettings,
  statusTone,
  statusLabel,
  autoActionModeLabel,
  lastFinishedLabel,
  pendingActionCount,
  summaryCards,
  progress,
  progressLabel,
  showProgressBar,
  runStatus,
  runButtonLabel,
  executing,
  isInspectionInFlight,
  runDisabled,
  t,
  onOpenSettings,
  onRunInspection,
  onPauseInspection,
  onStopInspection,
}: CodexInspectionStatusPanelProps) {
  return (
    <>
      <Card className={`${styles.panel} ${styles.statusPanel}`}>
        <div className={styles.statusBar}>
          <div className={styles.statusInfo}>
            <span className={`${styles.statusBadge} ${styles[`tone-${statusTone}`]}`}>
              <span className={styles.statusDot} aria-hidden="true" />
              {statusLabel}
            </span>
            <div className={styles.statusMeta}>
              <span>{`${t('monitoring.codex_inspection_target_type')}: ${inspectionSettings.targetType}`}</span>
              <span>{`${t('monitoring.codex_inspection_threshold')}: ${inspectionSettings.usedPercentThreshold}%`}</span>
              <span>{`${t('monitoring.codex_inspection_workers')}: ${inspectionSettings.workers}`}</span>
              <span>{`${t('monitoring.codex_inspection_sample_size')}: ${inspectionSettings.sampleSize || t('common.no')}`}</span>
              {inspectionSettings.autoActionMode !== 'none' ? (
                <span className={styles.statusMetaWarn}>
                  {`${t('monitoring.codex_inspection_settings_auto_action_mode_label')}: ${autoActionModeLabel}`}
                </span>
              ) : null}
              {lastFinishedLabel ? <span>{lastFinishedLabel}</span> : null}
              {pendingActionCount > 0 ? (
                <span
                  className={styles.statusMetaWarn}
                >{`${t('monitoring.codex_inspection_pending_total')} ${pendingActionCount}`}</span>
              ) : null}
            </div>
          </div>

          <div className={styles.statusActions}>
            <Link to="/auth-files" className={styles.quickLink}>
              <IconExternalLink size={14} />
              <span>{t('monitoring.codex_inspection_back')}</span>
            </Link>
            <button
              type="button"
              className={styles.iconButton}
              onClick={onOpenSettings}
              disabled={isInspectionInFlight || executing}
              aria-label={t('monitoring.codex_inspection_settings_button')}
              title={t('monitoring.codex_inspection_settings_button')}
            >
              <IconSettings size={16} />
            </button>
            <Button
              variant="primary"
              onClick={onRunInspection}
              loading={runStatus === 'running'}
              disabled={runDisabled}
            >
              {runButtonLabel}
            </Button>
            {isInspectionInFlight ? (
              <>
                <Button
                  variant="secondary"
                  onClick={onPauseInspection}
                  disabled={runStatus !== 'running' || executing}
                >
                  {t('monitoring.codex_inspection_pause')}
                </Button>
                <Button variant="danger" onClick={onStopInspection} disabled={executing}>
                  {t('monitoring.codex_inspection_stop')}
                </Button>
              </>
            ) : null}
          </div>
        </div>

        {showProgressBar ? (
          <div className={styles.progressSection}>
            <div className={styles.progressHeader}>
              <strong>{t('monitoring.codex_inspection_progress_title')}</strong>
              <span>{`${progress.percent}%`}</span>
            </div>
            <div className={styles.progressTrack}>
              <span
                className={styles.progressBar}
                style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
              />
            </div>
            <div className={styles.progressMeta}>
              <span>{progressLabel}</span>
              {runStatus === 'paused' ? <strong>{t('monitoring.codex_inspection_paused')}</strong> : null}
            </div>
          </div>
        ) : null}
      </Card>

      <section className={styles.summaryGrid}>
        {summaryCards.map((card) => (
          <Card
            key={card.key}
            className={[
              styles.summaryCard,
              card.tone ? styles[`tone-${card.tone}`] : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className={styles.summaryLabel}>{card.label}</span>
            <strong className={styles.summaryValue}>{card.value}</strong>
            <span className={styles.summaryMeta}>{card.meta}</span>
          </Card>
        ))}
      </section>
    </>
  );
}
