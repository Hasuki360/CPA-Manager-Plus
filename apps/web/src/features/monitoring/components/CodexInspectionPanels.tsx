import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import styles from '../CodexInspectionPage.module.scss';

type PanelProps = {
  title: string;
  subtitle?: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
};

type SettingsSectionProps = {
  icon: ReactNode;
  title: string;
  children: ReactNode;
};

export function Panel({ title, subtitle, extra, children, className }: PanelProps) {
  return (
    <Card className={[styles.panel, className].filter(Boolean).join(' ')}>
      <div className={styles.panelHeader}>
        <div className={styles.panelHeading}>
          <h2 className={styles.panelTitle}>{title}</h2>
          {subtitle ? <p className={styles.panelSubtitle}>{subtitle}</p> : null}
        </div>
        {extra ? <div className={styles.panelExtra}>{extra}</div> : null}
      </div>
      {children}
    </Card>
  );
}

export function SettingsSection({ icon, title, children }: SettingsSectionProps) {
  return (
    <section className={styles.settingsSectionCard}>
      <header className={styles.settingsSectionHeader}>
        <span className={styles.settingsSectionIcon}>{icon}</span>
        <span>{title}</span>
      </header>
      {children}
    </section>
  );
}
