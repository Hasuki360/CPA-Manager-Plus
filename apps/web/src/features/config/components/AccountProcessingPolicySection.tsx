import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { IconRefreshCw } from '@/components/ui/icons';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  buildAccountProcessingPolicyViewModel,
  type AccountPolicyCapabilityKey,
  type AccountPolicyViewItem,
} from '@/features/config/model/accountProcessingPolicyViewModel';
import { usePanelFeatureAvailability } from '@/hooks/usePanelFeatureAvailability';
import {
  usageServiceApi,
  getUsageServiceErrorCode,
  type AccountProcessingPolicy,
  type AccountProcessingPolicyPatch,
  type CharityModelMonitorSite,
} from '@/services/api/usageService';
import { useAuthStore, useNotificationStore } from '@/stores';
import styles from './AccountProcessingPolicySection.module.scss';

const patchKeyByCapability: Record<AccountPolicyCapabilityKey, keyof AccountProcessingPolicyPatch> =
  {
    providerQuotaCooldown: 'codexQuotaCooldownEnabled',
    antigravityQuotaCooldown: 'antigravityQuotaCooldownEnabled',
    authIssueQueue: 'authIssueQueueEnabled',
    authIssueAutoDisable: 'authIssueAutoDisableEnabled',
    charityModelMonitor: 'charityModelMonitorEnabled',
  };

const toneClassByStatus: Record<AccountPolicyViewItem['statusTone'], string> = {
  on: styles.statusOn,
  off: styles.statusOff,
  blocked: styles.statusBlocked,
  locked: styles.statusLocked,
};

export function AccountProcessingPolicySection() {
  const managementKey = useAuthStore((state) => state.managementKey);
  const { managerServiceBase } = usePanelFeatureAvailability();
  return (
    <AccountProcessingPolicyContent
      key={JSON.stringify([managerServiceBase, managementKey])}
      managerServiceBase={managerServiceBase}
      managementKey={managementKey}
    />
  );
}

function AccountProcessingPolicyContent({
  managerServiceBase,
  managementKey,
}: {
  managerServiceBase: string;
  managementKey: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showNotification } = useNotificationStore();

  const [status, setStatus] = useState<AccountProcessingPolicy | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<AccountPolicyCapabilityKey | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState<{
    key: AccountPolicyCapabilityKey;
    message: string;
  } | null>(null);
  const [confirmAutoDisableOpen, setConfirmAutoDisableOpen] = useState(false);

  const [charityIntervalDraft, setCharityIntervalDraft] = useState('1440');
  const [charitySitesDraft, setCharitySitesDraft] = useState('');
  const [charityDraftDirty, setCharityDraftDirty] = useState(false);
  const [charityConfigError, setCharityConfigError] = useState('');
  const [savingCharityConfig, setSavingCharityConfig] = useState(false);
  const [refreshAfterSave, setRefreshAfterSave] = useState(0);
  const requestVersion = useRef(0);
  const mutationPending = useRef(false);
  const saving = savingCharityConfig || savingKey !== null;

  useEffect(
    () => () => {
      requestVersion.current += 1;
    },
    []
  );

  const charityState = status?.charityModelMonitorState;
  const providerSync = charityState?.lastProviderSync ?? [];
  const providerCount = (field: 'matchedProviders' | 'updatedProviders') =>
    providerSync.every((entry) => typeof entry[field] === 'number')
      ? providerSync.reduce((sum, entry) => sum + entry[field]!, 0)
      : t('accountPolicy.charityModelMonitor_state_unknown');

  useEffect(() => {
    if (!refreshAfterSave || !managerServiceBase || !managementKey) return;
    let cancelled = false;
    const request = requestVersion.current;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const refreshState = async () => {
      if (cancelled || request !== requestVersion.current) return;
      attempts += 1;
      try {
        const data = await usageServiceApi.getAccountProcessingPolicy(
          managerServiceBase,
          managementKey
        );
        if (!cancelled && request === requestVersion.current) {
          // Refresh runtime state only: a delayed GET must not replace saved policy or drafts.
          setStatus(
            (previous) =>
              previous && {
                ...previous,
                charityModelMonitorState:
                  data.charityModelMonitorState ?? previous.charityModelMonitorState,
              }
          );
        }
      } catch {
        // The PATCH succeeded. A failed background read must not report a failed save.
      }
      if (!cancelled && request === requestVersion.current && attempts < 2) {
        timer = setTimeout(() => void refreshState(), 3000);
      }
    };
    timer = setTimeout(() => void refreshState(), 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refreshAfterSave, managerServiceBase, managementKey]);

  useEffect(() => {
    if (!status || charityDraftDirty) return;
    setCharityIntervalDraft(String(status.charityModelMonitorIntervalMinutes ?? 1440));
    setCharitySitesDraft(JSON.stringify(status.charityModelMonitorSites ?? [], null, 2));
  }, [status, charityDraftDirty]);

  const saveCharityConfig = useCallback(async () => {
    if (!managerServiceBase || !managementKey || mutationPending.current) return;
    const interval = Number(charityIntervalDraft);
    if (
      !/^\d+$/.test(charityIntervalDraft.trim()) ||
      !Number.isInteger(interval) ||
      interval < 5 ||
      interval > 10080
    ) {
      setCharityConfigError(t('accountPolicy.charity_interval_invalid'));
      return;
    }
    let sites: CharityModelMonitorSite[];
    try {
      const parsed: unknown = JSON.parse(charitySitesDraft || '[]');
      if (
        !Array.isArray(parsed) ||
        parsed.some((item) => typeof item !== 'object' || item === null)
      ) {
        throw new Error('expected an array of site objects');
      }
      sites = parsed as CharityModelMonitorSite[];
    } catch (err) {
      setCharityConfigError(
        t('accountPolicy.charity_sites_invalid', {
          message: err instanceof Error ? err.message : String(err),
        })
      );
      return;
    }
    const request = ++requestVersion.current;
    mutationPending.current = true;
    setLoading(false);
    setSavingCharityConfig(true);
    setCharityConfigError('');
    try {
      const patch: AccountProcessingPolicyPatch = {
        charityModelMonitorIntervalMinutes: interval,
        charityModelMonitorSites: sites,
      };
      const data = await usageServiceApi.updateAccountProcessingPolicy(
        managerServiceBase,
        managementKey,
        patch
      );
      if (request !== requestVersion.current) return;
      setStatus((previous) => ({
        ...data,
        charityModelMonitorState:
          data.charityModelMonitorState ?? previous?.charityModelMonitorState,
      }));
      setCharityDraftDirty(false);
      setRefreshAfterSave((value) => value + 1);
      showNotification(
        t('accountPolicy.charity_config_saved', {
          defaultValue: 'Sync configuration saved.',
        }),
        'success'
      );
    } catch (err) {
      if (request !== requestVersion.current) return;
      const message = err instanceof Error ? err.message : String(err || 'request failed');
      setCharityConfigError(message);
      showNotification(
        t('accountPolicy.save_failed', { message, defaultValue: `Save failed: ${message}` }),
        'error'
      );
    } finally {
      mutationPending.current = false;
      if (request === requestVersion.current) setSavingCharityConfig(false);
    }
  }, [
    charityIntervalDraft,
    charitySitesDraft,
    managerServiceBase,
    managementKey,
    showNotification,
    t,
  ]);

  const load = useCallback(async () => {
    if (!managerServiceBase || !managementKey || mutationPending.current) return;
    const request = ++requestVersion.current;
    setLoading(true);
    setLoadError('');
    setSaveError(null);
    try {
      const data = await usageServiceApi.getAccountProcessingPolicy(
        managerServiceBase,
        managementKey
      );
      if (request !== requestVersion.current) return;
      setStatus(data);
    } catch (err) {
      if (request !== requestVersion.current) return;
      const message = err instanceof Error ? err.message : String(err || 'request failed');
      setLoadError(message);
      showNotification(
        t('accountPolicy.load_failed', { message, defaultValue: `Load failed: ${message}` }),
        'error'
      );
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, [managerServiceBase, managementKey, showNotification, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const persistCapability = useCallback(
    async (key: AccountPolicyCapabilityKey, value: boolean) => {
      if (!managerServiceBase || !managementKey || mutationPending.current) return;
      const request = ++requestVersion.current;
      mutationPending.current = true;
      setLoading(false);
      setSavingKey(key);
      setSaveError(null);
      try {
        const patch: AccountProcessingPolicyPatch = { [patchKeyByCapability[key]]: value };
        const data = await usageServiceApi.updateAccountProcessingPolicy(
          managerServiceBase,
          managementKey,
          patch
        );
        if (request !== requestVersion.current) return;
        setStatus((previous) => ({
          ...data,
          charityModelMonitorState:
            data.charityModelMonitorState ?? previous?.charityModelMonitorState,
        }));
        setRefreshAfterSave((value) => value + 1);
        showNotification(
          t('accountPolicy.save_success', { defaultValue: 'Account processing policy updated.' }),
          'success'
        );
      } catch (err) {
        if (request !== requestVersion.current) return;
        const code = getUsageServiceErrorCode(err);
        const message =
          code === 'account_processing_policy_env_locked'
            ? t('accountPolicy.env_locked_hint', {
                defaultValue:
                  'This switch is locked by an environment variable. Update the service environment variable and restart to change it.',
              })
            : err instanceof Error
              ? err.message
              : String(err || 'request failed');
        setSaveError({ key, message });
        showNotification(
          t('accountPolicy.save_failed', { message, defaultValue: `Save failed: ${message}` }),
          'error'
        );
      } finally {
        mutationPending.current = false;
        if (request === requestVersion.current) setSavingKey(null);
      }
    },
    [managerServiceBase, managementKey, showNotification, t]
  );

  const updateCapability = useCallback(
    (key: AccountPolicyCapabilityKey, value: boolean) => {
      if (key === 'authIssueAutoDisable' && value) {
        setConfirmAutoDisableOpen(true);
        return;
      }
      void persistCapability(key, value);
    },
    [persistCapability]
  );

  const confirmAutoDisable = useCallback(() => {
    setConfirmAutoDisableOpen(false);
    void persistCapability('authIssueAutoDisable', true);
  }, [persistCapability]);

  const renderCapabilityCard = (item: AccountPolicyViewItem) => {
    const behavior = t(item.behaviorKey, {
      returnObjects: true,
      defaultValue: [],
    }) as string[];
    const cardClassName = [
      styles.card,
      item.nested ? styles.nestedCard : '',
      toneClassByStatus[item.statusTone],
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <section className={cardClassName} key={item.key}>
        <header className={styles.cardHeader}>
          <h5 className={styles.cardTitle}>{t(item.titleKey)}</h5>
          <ToggleSwitch
            checked={item.configured}
            onChange={(value) => updateCapability(item.key, value)}
            disabled={item.toggleDisabled}
            ariaLabel={t(item.toggleLabelKey)}
          />
        </header>

        {item.locked ? (
          <p className={styles.envLockedReason}>
            {t('accountPolicy.env_locked_reason', {
              envKey: item.capability.envKey,
              defaultValue:
                'Locked by the {{envKey}} environment variable. Update it and restart the service to change this switch.',
            })}
          </p>
        ) : null}

        {item.dependencyBlocked ? (
          <p className={styles.dependencyNote}>
            {item.configured
              ? t('accountPolicy.authIssueAutoDisable_configured_dependency_note')
              : t('accountPolicy.authIssueAutoDisable_dependency_note')}
          </p>
        ) : null}

        <details className={styles.advancedInfo}>
          <summary className={styles.advancedSummary}>
            {t('accountPolicy.advanced_summary', {
              defaultValue: 'Details: behavior / config field / environment variable',
            })}
          </summary>
          <div className={styles.advancedBody}>
            <p className={styles.cardDescription}>{t(item.descriptionKey)}</p>
            <ul className={styles.behaviorList}>
              {behavior.map((line: string, idx: number) => (
                <li key={`${item.key}-behavior-${idx}`}>{line}</li>
              ))}
            </ul>
            <div className={styles.metaRow}>
              <span className={styles.metaLabel}>
                {t('accountPolicy.meta_source', { defaultValue: 'Source' })}
              </span>
              <span className={styles.metaValue}>
                {t(`accountPolicy.source_${item.source}`, { defaultValue: item.source })}
              </span>
            </div>
            <div className={styles.metaRow}>
              <span className={styles.metaLabel}>
                {t('accountPolicy.meta_config_key', { defaultValue: 'Config key' })}
              </span>
              <span className={styles.metaValue}>
                <code>{item.capability.configFileKey}</code>
              </span>
            </div>
            <div className={styles.metaRow}>
              <span className={styles.metaLabel}>
                {t('accountPolicy.meta_env_key', { defaultValue: 'Environment variable' })}
              </span>
              <span className={styles.metaValue}>
                <code>{item.capability.envKey}</code>
              </span>
            </div>
          </div>
        </details>

        {item.key === 'charityModelMonitor' && charityState ? (
          <div className={styles.charityState}>
            <div className={styles.charityStateRow}>
              <span className={styles.charityStateLabel}>
                {t('accountPolicy.charityModelMonitor_state_last_check')}
              </span>
              <span>
                {charityState.lastCheck
                  ? new Date(charityState.lastCheck).toLocaleString()
                  : t('accountPolicy.charityModelMonitor_state_never')}
              </span>
            </div>
            <div className={styles.charityStateRow}>
              <span className={styles.charityStateLabel}>
                {t('accountPolicy.charityModelMonitor_state_codex_version')}
              </span>
              <span>{charityState.lastCodexCliVersion || '-'}</span>
            </div>
            <div className={styles.charityStateRow}>
              <span className={styles.charityStateLabel}>
                {t('accountPolicy.charityModelMonitor_state_sync')}
              </span>
              <span>
                {t('accountPolicy.charityModelMonitor_state_sync_value', {
                  changed: providerCount('updatedProviders'),
                  total: providerCount('matchedProviders'),
                  errors: (charityState.lastProviderError ?? []).length,
                })}
              </span>
            </div>
          </div>
        ) : null}

        {item.key === 'charityModelMonitor' ? (
          <div className={styles.charityConfig}>
            <Input
              label={t('accountPolicy.charity_interval')}
              hint={t('accountPolicy.charity_interval_hint')}
              type="number"
              min={5}
              max={10080}
              step={1}
              value={charityIntervalDraft}
              onChange={(event) => {
                setCharityIntervalDraft(event.target.value);
                setCharityDraftDirty(true);
              }}
              disabled={saving}
            />
            <div className={styles.charityConfigRow}>
              <span className={styles.charityConfigLabel}>
                {t('accountPolicy.charity_sites_json')}
              </span>
              <textarea
                className={styles.charitySitesJson}
                value={charitySitesDraft}
                spellCheck={false}
                disabled={saving}
                onChange={(event) => {
                  setCharitySitesDraft(event.target.value);
                  setCharityDraftDirty(true);
                }}
              />
              <span className={styles.charityConfigHint}>
                {t('accountPolicy.charity_sites_hint')}
              </span>
            </div>
            {charityConfigError ? (
              <div className={styles.charityConfigError} role="alert">
                {charityConfigError}
              </div>
            ) : null}
            <div className={styles.cardActions}>
              <Button
                variant="secondary"
                size="sm"
                loading={savingCharityConfig}
                disabled={savingKey !== null}
                onClick={() => void saveCharityConfig()}
              >
                {t('accountPolicy.charity_config_save')}
              </Button>
            </div>
          </div>
        ) : null}

        {item.key === 'authIssueQueue' ? (
          <div className={styles.cardActions}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/monitoring/account-actions')}
            >
              {t('accountPolicy.open_auth_issues', { defaultValue: 'Open Auth Issues' })}
            </Button>
          </div>
        ) : null}
      </section>
    );
  };

  const groups = status
    ? buildAccountProcessingPolicyViewModel(status, {
        loading: loading || savingCharityConfig,
        savingKey,
      })
    : [];

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div className={styles.sectionHeaderText}>
          <h3 className={styles.sectionTitle}>
            {t('accountPolicy.section_title', { defaultValue: 'Account Processing Policy' })}
          </h3>
          <p className={styles.sectionHint}>
            {t('accountPolicy.section_hint', {
              defaultValue:
                'Only affects new request-monitoring events. Queued or running tasks continue to finish.',
            })}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading || saving}>
          <IconRefreshCw size={14} />
          {t('accountPolicy.refresh', { defaultValue: 'Refresh' })}
        </Button>
      </div>

      {loadError && !status ? (
        <div className={styles.errorState}>
          <strong>{t('accountPolicy.load_failed_title', { defaultValue: 'Load failed' })}</strong>
          <span>{loadError}</span>
        </div>
      ) : (
        <>
          {saveError ? (
            <div className={styles.saveErrorBanner} role="alert">
              <strong>{t(`accountPolicy.${saveError.key}_title`)}</strong>
              <span>{saveError.message}</span>
            </div>
          ) : null}
          {loadError ? (
            <div className={styles.saveErrorBanner} role="alert">
              <strong>
                {t('accountPolicy.load_failed_title', { defaultValue: 'Load failed' })}
              </strong>
              <span>{loadError}</span>
            </div>
          ) : null}
          <div className={styles.groups}>
            {groups.map((group) => (
              <section className={styles.group} key={group.key}>
                <header className={styles.groupHeader}>
                  <h4>{t(group.titleKey)}</h4>
                </header>
                <div className={styles.cards}>{group.items.map(renderCapabilityCard)}</div>
              </section>
            ))}
          </div>
        </>
      )}

      <Modal
        open={confirmAutoDisableOpen}
        title={t('accountPolicy.authIssueAutoDisable_confirm_title', {
          defaultValue: 'Enable auth issue auto-disable?',
        })}
        width={560}
        onClose={() => setConfirmAutoDisableOpen(false)}
        footer={
          <div className={styles.confirmFooter}>
            <Button
              variant="secondary"
              onClick={() => setConfirmAutoDisableOpen(false)}
              disabled={savingKey !== null}
            >
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button
              variant="danger"
              onClick={confirmAutoDisable}
              loading={savingKey === 'authIssueAutoDisable'}
            >
              {t('accountPolicy.authIssueAutoDisable_confirm_button', {
                defaultValue: 'Enable auto-disable',
              })}
            </Button>
          </div>
        }
      >
        <div className={styles.confirmBody}>
          <p>{t('accountPolicy.authIssueAutoDisable_confirm_body')}</p>
          <ul>
            <li>{t('accountPolicy.authIssueAutoDisable_confirm_disable_only')}</li>
            <li>{t('accountPolicy.authIssueAutoDisable_confirm_no_recovery')}</li>
            <li>{t('accountPolicy.authIssueAutoDisable_confirm_requires_queue')}</li>
          </ul>
        </div>
      </Modal>
    </section>
  );
}
