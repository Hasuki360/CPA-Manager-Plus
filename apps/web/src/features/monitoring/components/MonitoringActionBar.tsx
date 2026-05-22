import type { ChangeEvent, ReactNode, RefObject } from 'react';
import { Link } from 'react-router-dom';
import type { TFunction } from 'i18next';
import { IconDownload, IconExternalLink, IconFileText, IconSettings } from '@/components/ui/icons';
import styles from '../MonitoringCenterPage.module.scss';

type MonitoringActionBarProps = {
  usageTransferAvailable: boolean;
  usageExporting: boolean;
  usageImporting: boolean;
  loggingToFile: boolean;
  usageImportInputRef: RefObject<HTMLInputElement | null>;
  t: TFunction;
  onUsageExport: () => void | Promise<void>;
  onUsageImportClick: () => void;
  onUsageImportChange: (event: ChangeEvent<HTMLInputElement>) => void;
  statusSummary: ReactNode;
};

export function MonitoringActionBar({
  usageTransferAvailable,
  usageExporting,
  usageImporting,
  loggingToFile,
  usageImportInputRef,
  t,
  onUsageExport,
  onUsageImportClick,
  onUsageImportChange,
  statusSummary,
}: MonitoringActionBarProps) {
  return (
    <section className={styles.actionBar} aria-label={t('common.action')}>
      <div className={styles.actionGroup}>
        <button
          type="button"
          className={`${styles.actionButton} ${styles.actionButtonPrimary}`}
          onClick={() => void onUsageExport()}
          disabled={!usageTransferAvailable || usageExporting || usageImporting}
          title={
            usageTransferAvailable
              ? t('usage_stats.export')
              : t('usage_stats.import_export_requires_usage_service')
          }
        >
          <IconDownload size={16} />
          <span>{usageExporting ? t('common.loading') : t('usage_stats.export')}</span>
        </button>
        <button
          type="button"
          className={`${styles.actionButton} ${styles.actionButtonPrimary}`}
          onClick={onUsageImportClick}
          disabled={!usageTransferAvailable || usageExporting || usageImporting}
          title={
            usageTransferAvailable
              ? t('usage_stats.import')
              : t('usage_stats.import_export_requires_usage_service')
          }
        >
          <IconFileText size={16} />
          <span>{usageImporting ? t('common.loading') : t('usage_stats.import')}</span>
        </button>
        <Link to="/model-prices" className={styles.actionButton}>
          <IconSettings size={16} />
          <span>{t('usage_stats.model_price_settings')}</span>
        </Link>
        <input
          ref={usageImportInputRef}
          type="file"
          accept=".json,.jsonl,.ndjson,.txt,application/json,application/x-ndjson,text/plain"
          style={{ display: 'none' }}
          onChange={onUsageImportChange}
        />
      </div>

      <div className={styles.actionBarMeta}>
        {statusSummary}
        {loggingToFile ? (
          <Link to="/logs" className={`${styles.actionButton} ${styles.quickNavLink}`}>
            <IconFileText size={16} />
            <span>{t('monitoring.open_logs')}</span>
            <IconExternalLink size={14} />
          </Link>
        ) : null}
      </div>
    </section>
  );
}
