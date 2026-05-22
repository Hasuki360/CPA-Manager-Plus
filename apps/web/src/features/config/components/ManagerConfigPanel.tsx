import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import styles from '../ConfigPage.module.scss';

type ManagerConfigPanelProps = {
  managerLoading: boolean;
  panelHostedByUsageService: boolean | null;
  detectedPanelBase: string;
  managerRuntimeModeLabel: string;
  managerServiceBase: string;
  disableControls: boolean;
  canConfigureRequestMonitoring: boolean;
  managerRequestMonitoringEnabled: boolean;
  managerCollectorMode: string;
  managerCollectorModeOptions: Array<{ value: string; label: string }>;
  managerPollIntervalMs: string;
  managerBatchSize: string;
  managerQueryLimit: string;
  managerRetentionSeconds: number;
  managerConfigSourceLabel: string;
  managerUsageStatisticsEnabled: boolean;
  onRefresh: () => void;
  onManagerServiceBaseChange: (value: string) => void;
  onRequestMonitoringChange: (value: boolean) => void;
  onCollectorModeChange: (value: string) => void;
  onPollIntervalMsChange: (value: string) => void;
  onBatchSizeChange: (value: string) => void;
  onQueryLimitChange: (value: string) => void;
};

export function ManagerConfigPanel({
  managerLoading,
  panelHostedByUsageService,
  detectedPanelBase,
  managerRuntimeModeLabel,
  managerServiceBase,
  disableControls,
  canConfigureRequestMonitoring,
  managerRequestMonitoringEnabled,
  managerCollectorMode,
  managerCollectorModeOptions,
  managerPollIntervalMs,
  managerBatchSize,
  managerQueryLimit,
  managerRetentionSeconds,
  managerConfigSourceLabel,
  managerUsageStatisticsEnabled,
  onRefresh,
  onManagerServiceBaseChange,
  onRequestMonitoringChange,
  onCollectorModeChange,
  onPollIntervalMsChange,
  onBatchSizeChange,
  onQueryLimitChange,
}: ManagerConfigPanelProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.managerConfigPanel}>
      <div className={styles.managerConfigHeader}>
        <div>
          <h2>{t('config_management.manager.title')}</h2>
          <p>{t('config_management.manager.boundary_hint')}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={onRefresh} loading={managerLoading}>
          {t('common.refresh')}
        </Button>
      </div>

      <section className={styles.managerSection}>
        <div className={styles.managerSectionHeader}>
          <div>
            <h3>{t('config_management.manager.runtime_title')}</h3>
            <p>
              {panelHostedByUsageService === true
                ? t('config_management.manager.runtime_embedded_hint')
                : t('config_management.manager.runtime_external_hint')}
            </p>
          </div>
          <span className={styles.managerRuntimeBadge}>{managerRuntimeModeLabel}</span>
        </div>

        {panelHostedByUsageService === true ? (
          <div className={styles.managerReadonlyGrid}>
            <div>
              <span>{t('config_management.manager.service_base')}</span>
              <strong>{detectedPanelBase}</strong>
            </div>
          </div>
        ) : (
          <Input
            label={t('config_management.manager.external_service_base')}
            placeholder="http://127.0.0.1:18317"
            value={managerServiceBase}
            onChange={(event) => onManagerServiceBaseChange(event.target.value)}
            disabled={disableControls || managerLoading}
            hint={t('config_management.manager.external_service_hint')}
          />
        )}
      </section>

      <section className={styles.managerSection}>
        <div className={styles.managerSectionHeader}>
          <div>
            <h3>{t('config_management.manager.request_monitoring_title')}</h3>
            <p>{t('config_management.manager.request_monitoring_hint')}</p>
          </div>
          <ToggleSwitch
            label={t('config_management.manager.request_monitoring_enabled')}
            labelPosition="left"
            checked={managerRequestMonitoringEnabled}
            onChange={onRequestMonitoringChange}
            disabled={disableControls || managerLoading || !canConfigureRequestMonitoring}
          />
        </div>

        {!canConfigureRequestMonitoring ? (
          <div className={styles.managerDependencyNote}>
            {t('config_management.manager.request_monitoring_dependency')}
          </div>
        ) : null}

        <div className={styles.managerQueueNote}>
          {t('config_management.manager.request_monitoring_queue_note')}
        </div>

        <div className={styles.managerConfigGrid}>
          <div className={styles.managerField}>
            <span className={styles.managerFieldLabel}>
              {t('config_management.manager.collector_mode')}
            </span>
            <Select
              value={managerCollectorMode}
              options={managerCollectorModeOptions}
              triggerClassName={styles.managerSelectTrigger}
              onChange={onCollectorModeChange}
              disabled={
                disableControls ||
                managerLoading ||
                !managerRequestMonitoringEnabled ||
                !canConfigureRequestMonitoring
              }
              ariaLabel={t('config_management.manager.collector_mode')}
            />
          </div>
          <Input
            label={t('config_management.manager.poll_interval_ms')}
            type="number"
            min="1"
            placeholder="500"
            value={managerPollIntervalMs}
            onChange={(event) => onPollIntervalMsChange(event.target.value)}
            disabled={
              disableControls ||
              managerLoading ||
              !managerRequestMonitoringEnabled ||
              !canConfigureRequestMonitoring
            }
            hint={t('config_management.manager.poll_interval_hint', {
              seconds: managerRetentionSeconds,
            })}
          />
          <Input
            label={t('config_management.manager.batch_size')}
            type="number"
            min="1"
            placeholder="100"
            value={managerBatchSize}
            onChange={(event) => onBatchSizeChange(event.target.value)}
            disabled={
              disableControls ||
              managerLoading ||
              !managerRequestMonitoringEnabled ||
              !canConfigureRequestMonitoring
            }
          />
          <Input
            label={t('config_management.manager.query_limit')}
            type="number"
            min="1"
            placeholder="50000"
            value={managerQueryLimit}
            onChange={(event) => onQueryLimitChange(event.target.value)}
            disabled={
              disableControls ||
              managerLoading ||
              !managerRequestMonitoringEnabled ||
              !canConfigureRequestMonitoring
            }
          />
        </div>
      </section>

      <div className={styles.managerMetaGrid}>
        <div>
          <span>{t('config_management.manager.config_source')}</span>
          <strong>{managerConfigSourceLabel}</strong>
        </div>
        <div>
          <span>{t('config_management.manager.cpa_usage_enabled')}</span>
          <strong>{managerUsageStatisticsEnabled ? t('common.enabled') : t('common.disabled')}</strong>
        </div>
        <div>
          <span>{t('config_management.manager.cpa_retention')}</span>
          <strong>
            {t('config_management.manager.cpa_retention_value', {
              seconds: managerRetentionSeconds,
            })}
          </strong>
        </div>
      </div>
    </div>
  );
}
