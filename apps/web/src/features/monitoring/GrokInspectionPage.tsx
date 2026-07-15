import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePanelFeatureAvailability } from '@/hooks/usePanelFeatureAvailability';
import {
  usageServiceApi,
  type GrokInspectionResult,
  type GrokInspectionRun,
  type GrokInspectionRunDetail,
} from '@/services/api/usageService';
import { useAuthStore, useNotificationStore } from '@/stores';
import styles from '@/features/monitoring/CodexInspectionPage.module.scss';

const classificationLabel = (value: string) => {
  switch (value) {
    case 'healthy':
      return '健康';
    case 'permission_denied':
      return '权限被拒';
    case 'quota_exhausted':
      return '额度用尽';
    case 'reauth':
      return '需重新登录';
    case 'model_unavailable':
      return '模型不可用';
    case 'probe_error':
      return '探测异常';
    default:
      return value || '未知';
  }
};

const actionLabel = (value: string) => {
  switch (value) {
    case 'enable':
      return '启用';
    case 'disable':
      return '禁用';
    case 'delete':
      return '删除';
    default:
      return '保留';
  }
};

export function GrokInspectionPage() {
  const { t } = useTranslation();
  const managementKey = useAuthStore((state) => state.managementKey);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const featureAvailability = usePanelFeatureAvailability();
  const managerServiceBase = featureAvailability.managerServiceBase;

  const [includeDisabled, setIncludeDisabled] = useState(true);
  const [onlyDisabled, setOnlyDisabled] = useState(false);
  const [workers, setWorkers] = useState(4);
  const [running, setRunning] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [acting, setActing] = useState(false);
  const [runs, setRuns] = useState<GrokInspectionRun[]>([]);
  const [detail, setDetail] = useState<GrokInspectionRunDetail | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState('all');

  const disabled = connectionStatus !== 'connected' || !managerServiceBase;

  const loadHistory = useCallback(async () => {
    if (!managerServiceBase) return;
    setLoadingHistory(true);
    try {
      const response = await usageServiceApi.listGrokInspectionRuns(managerServiceBase, managementKey, 20);
      setRuns(response.items || []);
      if (response.items?.[0]?.id) {
        const latest = await usageServiceApi.getGrokInspectionRun(
          managerServiceBase,
          managementKey,
          response.items[0].id
        );
        setDetail(latest);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showNotification(`加载 Grok 巡检历史失败：${message}`, 'error');
    } finally {
      setLoadingHistory(false);
    }
  }, [managementKey, managerServiceBase, showNotification]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useHeaderRefresh(async () => {
    await loadHistory();
  });

  const filteredResults = useMemo(() => {
    const items = detail?.results || [];
    if (filter === 'all') return items;
    return items.filter((item) => item.classification === filter);
  }, [detail, filter]);

  const summary = detail?.run;

  const toggleSelected = (id: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectSuggested = () => {
    const next = new Set<number>();
    for (const item of detail?.results || []) {
      if (item.action === 'disable' || item.action === 'enable' || item.action === 'delete') {
        next.add(item.id);
      }
    }
    setSelected(next);
  };

  const runInspection = async () => {
    if (!managerServiceBase) return;
    setRunning(true);
    try {
      const result = await usageServiceApi.runGrokInspection(managerServiceBase, managementKey, {
        includeDisabled,
        onlyDisabled,
        workers,
      });
      setDetail(result);
      setSelected(new Set());
      await loadHistory();
      showNotification('Grok 巡检完成', 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showNotification(`Grok 巡检失败：${message}`, 'error');
    } finally {
      setRunning(false);
    }
  };

  const executeSelected = async (force?: string) => {
    if (!managerServiceBase || !detail?.run?.id || selected.size === 0) return;
    if (!window.confirm(force ? `确认对 ${selected.size} 个账号执行强制操作：${force}？` : `确认对 ${selected.size} 个账号执行建议操作？`)) {
      return;
    }
    setActing(true);
    try {
      const response = await usageServiceApi.executeGrokInspectionActions(
        managerServiceBase,
        managementKey,
        detail.run.id,
        Array.from(selected),
        force
      );
      setDetail(response.detail);
      const failed = response.outcomes.filter((item) => !item.success).length;
      if (failed > 0) {
        showNotification(`已执行，失败 ${failed} 个`, 'warning');
      } else {
        showNotification('操作完成', 'success');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showNotification(`执行失败：${message}`, 'error');
    } finally {
      setActing(false);
    }
  };

  const openRun = async (id: number) => {
    if (!managerServiceBase) return;
    try {
      const result = await usageServiceApi.getGrokInspectionRun(managerServiceBase, managementKey, id);
      setDetail(result);
      setSelected(new Set());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showNotification(`读取巡检结果失败：${message}`, 'error');
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <Card
          title={t('nav.grok_inspection', { defaultValue: 'Grok 账号巡检' })}
          extra={
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="secondary" size="sm" onClick={() => void loadHistory()} disabled={loadingHistory || disabled}>
                刷新
              </Button>
              <Button onClick={() => void runInspection()} loading={running} disabled={disabled || running}>
                开始巡检
              </Button>
            </div>
          }
        >
          <div className={styles.cardContent}>
            <p style={{ marginTop: 0, color: 'var(--text-secondary)' }}>
              融合进 CPAMP 的服务端 Grok/xAI 巡检。探测走 CPA `/v0/management/api-call`，默认只给建议，不自动删号。
            </p>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={includeDisabled}
                  onChange={(e) => setIncludeDisabled(e.target.checked)}
                />
                包含已禁用账号
              </label>
              <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={onlyDisabled}
                  onChange={(e) => setOnlyDisabled(e.target.checked)}
                />
                仅巡检已禁用账号
              </label>
              <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                并发
                <input
                  type="number"
                  min={1}
                  max={16}
                  value={workers}
                  onChange={(e) => setWorkers(Number.parseInt(e.target.value, 10) || 1)}
                  style={{ width: 64 }}
                />
              </label>
            </div>
            {!managerServiceBase ? (
              <div className="status-badge error" style={{ marginTop: 12 }}>
                Manager Server 未连接，无法运行服务端 Grok 巡检。
              </div>
            ) : null}
          </div>
        </Card>

        {summary ? (
          <Card title="最近一次结果摘要">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <span className="status-badge">状态：{summary.status}</span>
              <span className="status-badge">探测：{summary.probeSetCount}</span>
              <span className="status-badge success">健康：{summary.healthyCount}</span>
              <span className="status-badge error">权限：{summary.permissionCount}</span>
              <span className="status-badge error">额度：{summary.quotaCount}</span>
              <span className="status-badge error">重登：{summary.reauthCount}</span>
              <span className="status-badge">模型不可用：{summary.modelUnavailableCount}</span>
              <span className="status-badge">探测异常：{summary.probeErrorCount}</span>
            </div>
            {summary.error ? <div className="status-badge error" style={{ marginTop: 8 }}>{summary.error}</div> : null}
          </Card>
        ) : null}

        <Card
          title="巡检结果"
          extra={
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="all">全部分类</option>
                <option value="healthy">健康</option>
                <option value="permission_denied">权限被拒</option>
                <option value="quota_exhausted">额度用尽</option>
                <option value="reauth">需重新登录</option>
                <option value="model_unavailable">模型不可用</option>
                <option value="probe_error">探测异常</option>
              </select>
              <Button variant="secondary" size="sm" onClick={selectSuggested} disabled={!detail}>
                选中建议项
              </Button>
              <Button size="sm" onClick={() => void executeSelected()} loading={acting} disabled={acting || selected.size === 0}>
                执行建议
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void executeSelected('disable')} disabled={acting || selected.size === 0}>
                强制禁用
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void executeSelected('delete')} disabled={acting || selected.size === 0}>
                强制删除
              </Button>
            </div>
          }
        >
          <div style={{ overflowX: 'auto' }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th></th>
                  <th>账号</th>
                  <th>文件</th>
                  <th>状态</th>
                  <th>分类</th>
                  <th>建议</th>
                  <th>原因</th>
                  <th>HTTP</th>
                </tr>
              </thead>
              <tbody>
                {filteredResults.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ color: 'var(--text-tertiary)' }}>
                      暂无结果。点击“开始巡检”。
                    </td>
                  </tr>
                ) : (
                  filteredResults.map((item: GrokInspectionResult) => (
                    <tr key={item.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(item.id)}
                          onChange={() => toggleSelected(item.id)}
                        />
                      </td>
                      <td>{item.displayAccount}</td>
                      <td>{item.fileName}</td>
                      <td>{item.disabled ? '已禁用' : '启用中'}</td>
                      <td>{classificationLabel(item.classification)}</td>
                      <td>{actionLabel(item.action)}</td>
                      <td>{item.actionReason || item.error || '-'}</td>
                      <td>{item.statusCode ?? '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="历史记录">
          <div style={{ display: 'grid', gap: 8 }}>
            {runs.length === 0 ? (
              <div style={{ color: 'var(--text-tertiary)' }}>暂无历史。</div>
            ) : (
              runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => void openRun(run.id)}
                  style={{
                    textAlign: 'left',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 12,
                    padding: '10px 12px',
                    background: detail?.run?.id === run.id ? 'color-mix(in srgb, var(--primary-color) 10%, transparent)' : 'var(--surface-subtle)',
                    cursor: 'pointer',
                  }}
                >
                  #{run.id} · {run.status} · 探测 {run.probeSetCount} · 健康 {run.healthyCount} · 额度 {run.quotaCount} · 重登 {run.reauthCount}
                </button>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
