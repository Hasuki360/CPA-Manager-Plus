import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildProviderRows,
  ClaudeEditDrawer,
  CodexEditDrawer,
  filterAndSortProviderRows,
  GeminiEditDrawer,
  OpenAIEditDrawer,
  PROVIDER_KIND_LABELS,
  ProviderDetailDrawer,
  ProviderHealthCheckDrawer,
  ProviderTable,
  ProviderToolbar,
  VertexEditDrawer,
  useProviderRecentRequests,
  type ProviderHealthCheckApplyAction,
  type ProviderKind,
  type ProviderKindFilter,
  type ProviderRow,
  type ProviderSortDirection,
  type ProviderSortOption,
} from '@/components/providers';
import {
  withDisableAllModelsRule,
  withoutDisableAllModelsRule,
} from '@/components/providers/utils';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { IconRefreshCw } from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePanelFeatureAvailability } from '@/hooks/usePanelFeatureAvailability';
import { providersApi } from '@/services/api';
import {
  usageServiceApi,
  type AccountProcessingPolicy,
  type CharityModelMonitorProviderState,
} from '@/services/api/usageService';
import { useAuthStore, useConfigStore, useNotificationStore, useThemeStore } from '@/stores';
import type { CloakConfig, GeminiKeyConfig, OpenAIProviderConfig, ProviderKeyConfig } from '@/types';
import styles from './AiProvidersPage.module.scss';

const PROVIDER_TABLE_DEFAULT_PAGE_SIZE = 10;
const PROVIDER_TABLE_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

const DEFAULT_CLOAK_CONFIG: CloakConfig = {
  mode: 'auto',
  strictMode: false,
  sensitiveWords: [],
};

const normalizeProviderUrl = (value?: string) => String(value ?? '').trim().replace(/\/+$/, '').toLowerCase();

const findCharityStateForRow = (
  row: ProviderRow,
  states: CharityModelMonitorProviderState[]
): CharityModelMonitorProviderState | null => {
  if (row.kind !== 'codex' && row.kind !== 'claude') return null;
  const rowBase = normalizeProviderUrl(row.baseUrl);
  const rowSection = row.kind === 'codex' ? 'codex-api-key' : 'claude-api-key';
  return (
    states.find(
      (state) =>
        normalizeProviderUrl(state.provider) === rowBase &&
        String(state.section ?? '').trim() === rowSection
    ) ?? null
  );
};

type Http500PresetKey = 'relaxed' | 'standard' | 'strict' | 'custom';

const HTTP500_PRESETS = {
  relaxed: {
    label: '宽松',
    description: '适合偶发波动的公益站，减少误封。',
    windowMinutes: 15,
    threshold: 5,
    durationMinutes: 10,
  },
  standard: {
    label: '标准',
    description: '推荐默认值，兼顾稳定和恢复速度。',
    windowMinutes: 10,
    threshold: 3,
    durationMinutes: 10,
  },
  strict: {
    label: '严格',
    description: '快速隔离异常通道，适合高失败率场景。',
    windowMinutes: 5,
    threshold: 2,
    durationMinutes: 15,
  },
} as const;

const resolveHttp500Preset = (draft: {
  windowMinutes: number;
  threshold: number;
  durationMinutes: number;
}): Http500PresetKey => {
  for (const [key, preset] of Object.entries(HTTP500_PRESETS)) {
    if (
      draft.windowMinutes === preset.windowMinutes &&
      draft.threshold === preset.threshold &&
      draft.durationMinutes === preset.durationMinutes
    ) {
      return key as Http500PresetKey;
    }
  }
  return 'custom';
};

export function AiProvidersPage() {
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const managementKey = useAuthStore((state) => state.managementKey);
  const featureAvailability = usePanelFeatureAvailability();
  const managerServiceBase = featureAvailability.managerServiceBase;

  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const updateConfigValue = useConfigStore((state) => state.updateConfigValue);
  const clearCache = useConfigStore((state) => state.clearCache);
  const isCacheValid = useConfigStore((state) => state.isCacheValid);

  const hasMounted = useRef(false);
  const [loading, setLoading] = useState(() => !isCacheValid());
  const [error, setError] = useState('');

  const [geminiKeys, setGeminiKeys] = useState<GeminiKeyConfig[]>(
    () => config?.geminiApiKeys || []
  );
  const [interactionsKeys, setInteractionsKeys] = useState<GeminiKeyConfig[]>(
    () => config?.interactionsApiKeys || []
  );
  const [codexConfigs, setCodexConfigs] = useState<ProviderKeyConfig[]>(
    () => config?.codexApiKeys || []
  );
  const [claudeConfigs, setClaudeConfigs] = useState<ProviderKeyConfig[]>(
    () => config?.claudeApiKeys || []
  );
  const [vertexConfigs, setVertexConfigs] = useState<ProviderKeyConfig[]>(
    () => config?.vertexApiKeys || []
  );
  const [openaiProviders, setOpenaiProviders] = useState<OpenAIProviderConfig[]>(
    () => config?.openaiCompatibility || []
  );

  const [configSwitchingKey, setConfigSwitchingKey] = useState<string | null>(null);
  const [charityPolicy, setCharityPolicy] = useState<AccountProcessingPolicy | null>(null);
  const [charityLoading, setCharityLoading] = useState(false);
  const [charitySaving, setCharitySaving] = useState(false);
  const [charityIntervalDraft, setCharityIntervalDraft] = useState(15);
  const [charityIntervalSaving, setCharityIntervalSaving] = useState(false);
  const [http500Draft, setHttp500Draft] = useState({
    windowMinutes: 10,
    threshold: 3,
    durationMinutes: 10,
  });
  const [http500Preset, setHttp500Preset] = useState<Http500PresetKey>('standard');
  const [http500Saving, setHttp500Saving] = useState(false);
  const http500DirtyRef = useRef(false);
  const [charityLoadError, setCharityLoadError] = useState('');

  // 表格筛选 / 排序 / 详情状态
  const [kindFilter, setKindFilter] = useState<ProviderKindFilter>('all');
  const [searchText, setSearchText] = useState('');
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [sortOption, setSortOption] = useState<ProviderSortOption>('priority');
  const [sortDirection, setSortDirection] = useState<ProviderSortDirection>('desc');
  const [detailRowKey, setDetailRowKey] = useState<string | null>(null);
  const [healthCheckOpen, setHealthCheckOpen] = useState(false);
  const [editDrawerKind, setEditDrawerKind] = useState<ProviderKind | null>(null);
  const [editDrawerIndex, setEditDrawerIndex] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PROVIDER_TABLE_DEFAULT_PAGE_SIZE);

  const disableControls = connectionStatus !== 'connected';
  const isSwitching = Boolean(configSwitchingKey);
  const actionsDisabled = disableControls || loading || isSwitching;

  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;

  const { usageByProvider, loadRecentRequests, refreshRecentRequests } = useProviderRecentRequests({
    enabled: isCurrentLayer,
  });

  const getErrorMessage = useCallback((err: unknown) => {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return '';
  }, []);

  const loadConfigs = useCallback(async () => {
    const hasValidCache = isCacheValid();
    if (!hasValidCache) {
      setLoading(true);
    }
    setError('');
    try {
      const [configResult, vertexResult, openaiResult] = await Promise.allSettled([
        fetchConfig(),
        providersApi.getVertexConfigs(),
        providersApi.getOpenAIProviders(),
      ]);

      if (configResult.status !== 'fulfilled') {
        throw configResult.reason;
      }

      const data = configResult.value;
      setGeminiKeys(data?.geminiApiKeys || []);
      setInteractionsKeys(data?.interactionsApiKeys || []);
      setCodexConfigs(data?.codexApiKeys || []);
      setClaudeConfigs(data?.claudeApiKeys || []);
      setVertexConfigs(data?.vertexApiKeys || []);
      setOpenaiProviders(data?.openaiCompatibility || []);

      if (vertexResult.status === 'fulfilled') {
        setVertexConfigs(vertexResult.value || []);
        updateConfigValue('vertex-api-key', vertexResult.value || []);
        clearCache('vertex-api-key');
      }

      if (openaiResult.status === 'fulfilled') {
        setOpenaiProviders(openaiResult.value || []);
        updateConfigValue('openai-compatibility', openaiResult.value || []);
        clearCache('openai-compatibility');
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err) || t('notification.refresh_failed');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [clearCache, fetchConfig, isCacheValid, t, updateConfigValue]);

  useEffect(() => {
    if (hasMounted.current) return;
    hasMounted.current = true;
    loadConfigs();
  }, [loadConfigs]);

  useEffect(() => {
    if (!isCurrentLayer) return;
    void loadRecentRequests().catch(() => {});
  }, [isCurrentLayer, loadRecentRequests]);

  useEffect(() => {
    if (config?.geminiApiKeys) setGeminiKeys(config.geminiApiKeys);
    if (config?.interactionsApiKeys) setInteractionsKeys(config.interactionsApiKeys);
    if (config?.codexApiKeys) setCodexConfigs(config.codexApiKeys);
    if (config?.claudeApiKeys) setClaudeConfigs(config.claudeApiKeys);
    if (config?.vertexApiKeys) setVertexConfigs(config.vertexApiKeys);
    if (config?.openaiCompatibility) setOpenaiProviders(config.openaiCompatibility);
  }, [
    config?.geminiApiKeys,
    config?.interactionsApiKeys,
    config?.codexApiKeys,
    config?.claudeApiKeys,
    config?.vertexApiKeys,
    config?.openaiCompatibility,
  ]);

  const handleRecentRequestsRefresh = useCallback(async () => {
    await refreshRecentRequests();
  }, [refreshRecentRequests]);

  const loadCharityPolicy = useCallback(async () => {
    if (!managerServiceBase || !managementKey) return;
    setCharityLoading(true);
    try {
      const data = await usageServiceApi.getAccountProcessingPolicy(
        managerServiceBase,
        managementKey
      );
      setCharityPolicy(data);
      setCharityLoadError('');
      setCharityIntervalDraft(data.charityModelMonitorIntervalMinutes ?? 15);
      const nextHttp500Draft = {
        windowMinutes: data.http500CooldownWindowMinutes ?? 10,
        threshold: data.http500CooldownThreshold ?? 3,
        durationMinutes: data.http500CooldownDurationMinutes ?? 10,
      };
      if (!http500DirtyRef.current) {
        setHttp500Draft(nextHttp500Draft);
        setHttp500Preset(resolveHttp500Preset(nextHttp500Draft));
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      setCharityLoadError(message ? `状态加载失败：${message}` : '状态加载失败，请稍后重试');
    } finally {
      setCharityLoading(false);
    }
  }, [getErrorMessage, managementKey, managerServiceBase]);

  useEffect(() => {
    if (!isCurrentLayer) return;
    void loadCharityPolicy();
  }, [isCurrentLayer, loadCharityPolicy]);

  useHeaderRefresh(handleRecentRequestsRefresh, isCurrentLayer);

  const openEditorDrawer = useCallback((kind: ProviderKind, editIndex: number | null) => {
    setDetailRowKey(null);
    setEditDrawerKind(kind);
    setEditDrawerIndex(editIndex);
  }, []);

  const closeEditorDrawer = useCallback(() => {
    setEditDrawerKind(null);
    setEditDrawerIndex(null);
  }, []);

  const handleDrawerSaved = useCallback(() => {
    void loadConfigs();
  }, [loadConfigs]);

  // 统一行集合与派生数据
  const rows = useMemo(
    () =>
      buildProviderRows({
        gemini: geminiKeys,
        interactions: interactionsKeys,
        codex: codexConfigs,
        claude: claudeConfigs,
        vertex: vertexConfigs,
        openai: openaiProviders,
        usageByProvider,
      }),
    [
      claudeConfigs,
      codexConfigs,
      geminiKeys,
      interactionsKeys,
      openaiProviders,
      usageByProvider,
      vertexConfigs,
    ]
  );

  const allModelNames = useMemo(() => {
    const names = new Set<string>();
    rows.forEach((row) => {
      row.modelNames.forEach((name) => names.add(name));
    });
    return Array.from(names).sort();
  }, [rows]);

  useEffect(() => {
    // 配置变更后清理已不存在的模型筛选项，避免筛选结果一直为空。
    setSelectedModels((prev) => {
      if (prev.size === 0) return prev;

      const availableModels = new Set(allModelNames);
      const next = new Set(Array.from(prev).filter((name) => availableModels.has(name)));
      return next.size === prev.size ? prev : next;
    });
  }, [allModelNames]);

  const visibleRows = useMemo(
    () =>
      filterAndSortProviderRows(rows, {
        kind: kindFilter,
        searchText,
        selectedModels,
        sortOption,
        sortDirection,
      }),
    [kindFilter, rows, searchText, selectedModels, sortDirection, sortOption]
  );

  const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pagedRows = visibleRows.slice(pageStart, pageStart + pageSize);
  const pageStartItem = visibleRows.length === 0 ? 0 : pageStart + 1;
  const pageEndItem = Math.min(visibleRows.length, pageStart + pageSize);

  useEffect(() => {
    setPage(1);
  }, [kindFilter, searchText, selectedModels, sortDirection, sortOption]);

  useEffect(() => {
    if (page === currentPage) return;
    setPage(currentPage);
  }, [currentPage, page]);

  const kindCounts = useMemo(() => {
    const counts: Record<ProviderKindFilter, number> = {
      all: rows.length,
      gemini: 0,
      interactions: 0,
      codex: 0,
      claude: 0,
      vertex: 0,
      openai: 0,
    };
    rows.forEach((row) => {
      counts[row.kind] += 1;
    });
    return counts;
  }, [rows]);

  const detailRow = useMemo(
    () => (detailRowKey ? (rows.find((row) => row.key === detailRowKey) ?? null) : null),
    [detailRowKey, rows]
  );

  const charityProviderStates = charityPolicy?.charityModelMonitorState?.lastProviderSync ?? [];
  const charityRows = useMemo(
    () => rows
      .map((row) => ({ row, state: findCharityStateForRow(row, charityProviderStates) }))
      .filter((item): item is { row: ProviderRow; state: CharityModelMonitorProviderState } => Boolean(item.state)),
    [charityProviderStates, rows]
  );
  const charityEnabled = charityPolicy?.charityModelMonitor?.enabled === true;
  const charityInterval = charityPolicy?.charityModelMonitorIntervalMinutes ?? 15;
  const charityIntervalUnchanged = charityIntervalDraft === charityInterval;

  const updateCharityIntervalDraft = useCallback((value: string) => {
    const parsed = Number.parseInt(value, 10);
    setCharityIntervalDraft(Number.isFinite(parsed) ? parsed : 0);
  }, []);

  const persistCharityInterval = useCallback(async () => {
    if (!managerServiceBase || !managementKey) return;
    setCharityIntervalSaving(true);
    try {
      const data = await usageServiceApi.updateAccountProcessingPolicy(
        managerServiceBase,
        managementKey,
        { charityModelMonitorIntervalMinutes: charityIntervalDraft }
      );
      setCharityPolicy(data);
      setCharityIntervalDraft(data.charityModelMonitorIntervalMinutes ?? 15);
      showNotification('公益站检查间隔已保存', 'success');
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      showNotification(`公益站检查间隔保存失败：${message}`, 'error');
    } finally {
      setCharityIntervalSaving(false);
    }
  }, [charityIntervalDraft, getErrorMessage, managementKey, managerServiceBase, showNotification]);

  const toggleCharityMonitor = useCallback(async (enabled: boolean) => {
    if (!managerServiceBase || !managementKey) return;
    setCharitySaving(true);
    try {
      const data = await usageServiceApi.updateAccountProcessingPolicy(
        managerServiceBase,
        managementKey,
        { charityModelMonitorEnabled: enabled }
      );
      setCharityPolicy(data);
      showNotification(enabled ? '公益站模型监控已开启' : '公益站模型监控已关闭', 'success');
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      showNotification(`公益站模型监控保存失败：${message}`, 'error');
    } finally {
      setCharitySaving(false);
    }
  }, [getErrorMessage, managementKey, managerServiceBase, showNotification]);

  const filtersActive =
    kindFilter !== 'all' || searchText.trim() !== '' || selectedModels.size > 0;

  const applyHttp500Preset = useCallback((presetKey: Exclude<Http500PresetKey, 'custom'>) => {
    const preset = HTTP500_PRESETS[presetKey];
    http500DirtyRef.current = true;
    setHttp500Preset(presetKey);
    setHttp500Draft({
      windowMinutes: preset.windowMinutes,
      threshold: preset.threshold,
      durationMinutes: preset.durationMinutes,
    });
  }, []);

  const http500Unchanged = useMemo(() => {
    if (!charityPolicy) return true;
    return (
      http500Draft.windowMinutes === (charityPolicy.http500CooldownWindowMinutes ?? 10) &&
      http500Draft.threshold === (charityPolicy.http500CooldownThreshold ?? 3) &&
      http500Draft.durationMinutes === (charityPolicy.http500CooldownDurationMinutes ?? 10)
    );
  }, [http500Draft, charityPolicy]);

  const updateHttp500Draft = useCallback(
    (field: 'windowMinutes' | 'threshold' | 'durationMinutes', value: string) => {
      const parsed = Number.parseInt(value, 10);
      http500DirtyRef.current = true;
      setHttp500Preset('custom');
      setHttp500Draft((current) => ({
        ...current,
        [field]: Number.isFinite(parsed) ? parsed : 0,
      }));
    },
    []
  );

  const persistHttp500Settings = useCallback(async () => {
    if (!managerServiceBase || !managementKey) return;
    setHttp500Saving(true);
    try {
      const data = await usageServiceApi.updateAccountProcessingPolicy(
        managerServiceBase,
        managementKey,
        {
          http500CooldownWindowMinutes: http500Draft.windowMinutes,
          http500CooldownThreshold: http500Draft.threshold,
          http500CooldownDurationMinutes: http500Draft.durationMinutes,
        }
      );
      setCharityPolicy(data);
      const nextHttp500Draft = {
        windowMinutes: data.http500CooldownWindowMinutes ?? 10,
        threshold: data.http500CooldownThreshold ?? 3,
        durationMinutes: data.http500CooldownDurationMinutes ?? 10,
      };
      setHttp500Draft(nextHttp500Draft);
      http500DirtyRef.current = false;
      setHttp500Preset(resolveHttp500Preset(nextHttp500Draft));
      showNotification('HTTP 500 通道关闭策略已保存', 'success');
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      showNotification(`HTTP 500 通道关闭策略保存失败：${message}`, 'error');
    } finally {
      setHttp500Saving(false);
    }
  }, [getErrorMessage, http500Draft, managementKey, managerServiceBase, showNotification]);

  const clearFilters = () => {
    setKindFilter('all');
    setSearchText('');
    setSelectedModels(new Set());
  };

  const applyProviderEnabledActions = async (
    actions: Map<string, ProviderHealthCheckApplyAction>
  ) => {
    if (actions.size === 0) return;

    const rowByKey = new Map(rows.map((row) => [row.key, row]));
    const previous = {
      gemini: geminiKeys,
      interactions: interactionsKeys,
      codex: codexConfigs,
      claude: claudeConfigs,
      vertex: vertexConfigs,
      openai: openaiProviders,
    };
    let nextGemini = geminiKeys;
    let nextInteractions = interactionsKeys;
    let nextCodex = codexConfigs;
    let nextClaude = claudeConfigs;
    let nextVertex = vertexConfigs;
    let nextOpenai = openaiProviders;
    const changed = {
      gemini: false,
      interactions: false,
      codex: false,
      claude: false,
      vertex: false,
      openai: false,
    };

    actions.forEach((action, providerKey) => {
      const row = rowByKey.get(providerKey);
      if (!row) return;
      const enabled = action === 'enable';
      if (row.enabled === enabled) return;

      if (row.kind === 'gemini') {
        const current = nextGemini[row.originalIndex];
        if (!current) return;
        const excludedModels = enabled
          ? withoutDisableAllModelsRule(current.excludedModels)
          : withDisableAllModelsRule(current.excludedModels);
        nextGemini = nextGemini.map((item, index) =>
          index === row.originalIndex ? { ...item, excludedModels } : item
        );
        changed.gemini = true;
      } else if (row.kind === 'interactions') {
        const current = nextInteractions[row.originalIndex];
        if (!current) return;
        const excludedModels = enabled
          ? withoutDisableAllModelsRule(current.excludedModels)
          : withDisableAllModelsRule(current.excludedModels);
        nextInteractions = nextInteractions.map((item, index) =>
          index === row.originalIndex ? { ...item, excludedModels } : item
        );
        changed.interactions = true;
      } else if (row.kind === 'codex') {
        const current = nextCodex[row.originalIndex];
        if (!current) return;
        const excludedModels = enabled
          ? withoutDisableAllModelsRule(current.excludedModels)
          : withDisableAllModelsRule(current.excludedModels);
        nextCodex = nextCodex.map((item, index) =>
          index === row.originalIndex ? { ...item, excludedModels } : item
        );
        changed.codex = true;
      } else if (row.kind === 'claude') {
        const current = nextClaude[row.originalIndex];
        if (!current) return;
        const excludedModels = enabled
          ? withoutDisableAllModelsRule(current.excludedModels)
          : withDisableAllModelsRule(current.excludedModels);
        nextClaude = nextClaude.map((item, index) =>
          index === row.originalIndex ? { ...item, excludedModels } : item
        );
        changed.claude = true;
      } else if (row.kind === 'vertex') {
        const current = nextVertex[row.originalIndex];
        if (!current) return;
        const excludedModels = enabled
          ? withoutDisableAllModelsRule(current.excludedModels)
          : withDisableAllModelsRule(current.excludedModels);
        nextVertex = nextVertex.map((item, index) =>
          index === row.originalIndex ? { ...item, excludedModels } : item
        );
        changed.vertex = true;
      } else {
        const current = nextOpenai[row.originalIndex];
        if (!current) return;
        nextOpenai = nextOpenai.map((item, index) =>
          index === row.originalIndex ? { ...item, disabled: !enabled } : item
        );
        changed.openai = true;
      }
    });

    if (!Object.values(changed).some(Boolean)) {
      showNotification(t('ai_providers.health_check_no_changes'), 'success');
      return;
    }

    setConfigSwitchingKey('health-check');

    const applyLocalState = (
      gemini: GeminiKeyConfig[],
      interactions: GeminiKeyConfig[],
      codex: ProviderKeyConfig[],
      claude: ProviderKeyConfig[],
      vertex: ProviderKeyConfig[],
      openai: OpenAIProviderConfig[]
    ) => {
      if (changed.gemini) {
        setGeminiKeys(gemini);
        updateConfigValue('gemini-api-key', gemini);
        clearCache('gemini-api-key');
      }
      if (changed.interactions) {
        setInteractionsKeys(interactions);
        updateConfigValue('interactions-api-key', interactions);
        clearCache('interactions-api-key');
      }
      if (changed.codex) {
        setCodexConfigs(codex);
        updateConfigValue('codex-api-key', codex);
        clearCache('codex-api-key');
      }
      if (changed.claude) {
        setClaudeConfigs(claude);
        updateConfigValue('claude-api-key', claude);
        clearCache('claude-api-key');
      }
      if (changed.vertex) {
        setVertexConfigs(vertex);
        updateConfigValue('vertex-api-key', vertex);
        clearCache('vertex-api-key');
      }
      if (changed.openai) {
        setOpenaiProviders(openai);
        updateConfigValue('openai-compatibility', openai);
        clearCache('openai-compatibility');
      }
    };

    applyLocalState(
      nextGemini,
      nextInteractions,
      nextCodex,
      nextClaude,
      nextVertex,
      nextOpenai
    );

    try {
      await Promise.all([
        changed.gemini ? providersApi.saveGeminiKeys(nextGemini) : Promise.resolve(),
        changed.interactions
          ? providersApi.saveInteractionsKeys(nextInteractions)
          : Promise.resolve(),
        changed.codex ? providersApi.saveCodexConfigs(nextCodex) : Promise.resolve(),
        changed.claude ? providersApi.saveClaudeConfigs(nextClaude) : Promise.resolve(),
        changed.vertex ? providersApi.saveVertexConfigs(nextVertex) : Promise.resolve(),
        changed.openai ? providersApi.saveOpenAIProviders(nextOpenai) : Promise.resolve(),
      ]);
      showNotification(t('ai_providers.health_check_apply_success'), 'success');
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      applyLocalState(
        previous.gemini,
        previous.interactions,
        previous.codex,
        previous.claude,
        previous.vertex,
        previous.openai
      );
      showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
      throw err;
    } finally {
      setConfigSwitchingKey(null);
    }
  };

  const setHealthCheckProviderEnabled = async (providerKey: string, enabled: boolean) => {
    await applyProviderEnabledActions(
      new Map([[providerKey, enabled ? 'enable' : 'disable']])
    );
  };

  // 启停（key-based providers 走 excludedModels 规则）
  const setConfigEnabled = async (
    provider: Exclude<ProviderKind, 'openai'>,
    index: number,
    enabled: boolean
  ) => {
    if (provider === 'gemini' || provider === 'interactions') {
      const source = provider === 'gemini' ? geminiKeys : interactionsKeys;
      const current = source[index];
      if (!current) return;

      const switchingKey = `${provider}:${current.apiKey}`;
      setConfigSwitchingKey(switchingKey);

      const previousList = source;
      const nextExcluded = enabled
        ? withoutDisableAllModelsRule(current.excludedModels)
        : withDisableAllModelsRule(current.excludedModels);
      const nextItem: GeminiKeyConfig = { ...current, excludedModels: nextExcluded };
      const nextList = previousList.map((item, idx) => (idx === index ? nextItem : item));

      if (provider === 'gemini') {
        setGeminiKeys(nextList);
        updateConfigValue('gemini-api-key', nextList);
        clearCache('gemini-api-key');
      } else {
        setInteractionsKeys(nextList);
        updateConfigValue('interactions-api-key', nextList);
        clearCache('interactions-api-key');
      }

      try {
        if (provider === 'gemini') {
          await providersApi.saveGeminiKeys(nextList);
        } else {
          await providersApi.saveInteractionsKeys(nextList);
        }
        showNotification(
          enabled ? t('notification.config_enabled') : t('notification.config_disabled'),
          'success'
        );
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        if (provider === 'gemini') {
          setGeminiKeys(previousList);
          updateConfigValue('gemini-api-key', previousList);
          clearCache('gemini-api-key');
        } else {
          setInteractionsKeys(previousList);
          updateConfigValue('interactions-api-key', previousList);
          clearCache('interactions-api-key');
        }
        showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
      } finally {
        setConfigSwitchingKey(null);
      }
      return;
    }

    const source =
      provider === 'codex'
        ? codexConfigs
        : provider === 'claude'
          ? claudeConfigs
          : vertexConfigs;
    const current = source[index];
    if (!current) return;

    const switchingKey = `${provider}:${current.apiKey}`;
    setConfigSwitchingKey(switchingKey);

    const previousList = source;
    const nextExcluded = enabled
      ? withoutDisableAllModelsRule(current.excludedModels)
      : withDisableAllModelsRule(current.excludedModels);
    const nextItem: ProviderKeyConfig = { ...current, excludedModels: nextExcluded };
    const nextList = previousList.map((item, idx) => (idx === index ? nextItem : item));

    if (provider === 'codex') {
      setCodexConfigs(nextList);
      updateConfigValue('codex-api-key', nextList);
      clearCache('codex-api-key');
    } else if (provider === 'claude') {
      setClaudeConfigs(nextList);
      updateConfigValue('claude-api-key', nextList);
      clearCache('claude-api-key');
    } else {
      setVertexConfigs(nextList);
      updateConfigValue('vertex-api-key', nextList);
      clearCache('vertex-api-key');
    }

    try {
      if (provider === 'codex') {
        await providersApi.saveCodexConfigs(nextList);
      } else if (provider === 'claude') {
        await providersApi.saveClaudeConfigs(nextList);
      } else {
        await providersApi.saveVertexConfigs(nextList);
      }
      showNotification(
        enabled ? t('notification.config_enabled') : t('notification.config_disabled'),
        'success'
      );
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      if (provider === 'codex') {
        setCodexConfigs(previousList);
        updateConfigValue('codex-api-key', previousList);
        clearCache('codex-api-key');
      } else if (provider === 'claude') {
        setClaudeConfigs(previousList);
        updateConfigValue('claude-api-key', previousList);
        clearCache('claude-api-key');
      } else {
        setVertexConfigs(previousList);
        updateConfigValue('vertex-api-key', previousList);
        clearCache('vertex-api-key');
      }
      showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
    } finally {
      setConfigSwitchingKey(null);
    }
  };

  const setOpenAIProviderEnabled = async (index: number, enabled: boolean) => {
    const current = openaiProviders[index];
    if (!current) return;

    const switchingKey = `openai:${current.name}:${index}`;
    setConfigSwitchingKey(switchingKey);

    const previousList = openaiProviders;
    const nextItem: OpenAIProviderConfig = { ...current, disabled: !enabled };
    const nextList = previousList.map((item, idx) => (idx === index ? nextItem : item));

    setOpenaiProviders(nextList);
    updateConfigValue('openai-compatibility', nextList);
    clearCache('openai-compatibility');

    try {
      await providersApi.updateOpenAIProviderDisabled(index, !enabled);
      showNotification(
        enabled ? t('notification.config_enabled') : t('notification.config_disabled'),
        'success'
      );
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      setOpenaiProviders(previousList);
      updateConfigValue('openai-compatibility', previousList);
      clearCache('openai-compatibility');
      showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
    } finally {
      setConfigSwitchingKey(null);
    }
  };

  const setProviderWebsocketsEnabled = async (
    provider: 'codex' | 'claude',
    index: number,
    enabled: boolean
  ) => {
    const source = provider === 'codex' ? codexConfigs : claudeConfigs;
    const current = source[index];
    if (!current) return;

    const switchingKey = `${provider}:${current.apiKey}:websockets`;
    setConfigSwitchingKey(switchingKey);

    const previousList = source;
    const nextItem: ProviderKeyConfig = { ...current, websockets: enabled };
    const nextList = previousList.map((item, idx) => (idx === index ? nextItem : item));

    if (provider === 'codex') {
      setCodexConfigs(nextList);
      updateConfigValue('codex-api-key', nextList);
      clearCache('codex-api-key');
    } else {
      setClaudeConfigs(nextList);
      updateConfigValue('claude-api-key', nextList);
      clearCache('claude-api-key');
    }

    try {
      if (provider === 'codex') {
        await providersApi.saveCodexConfigs(nextList);
        showNotification(t('notification.codex_config_updated'), 'success');
      } else {
        await providersApi.saveClaudeConfigs(nextList);
        showNotification(t('notification.claude_config_updated'), 'success');
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      if (provider === 'codex') {
        setCodexConfigs(previousList);
        updateConfigValue('codex-api-key', previousList);
        clearCache('codex-api-key');
      } else {
        setClaudeConfigs(previousList);
        updateConfigValue('claude-api-key', previousList);
        clearCache('claude-api-key');
      }
      showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
    } finally {
      setConfigSwitchingKey(null);
    }
  };

  const setProviderCloakEnabled = async (
    provider: 'codex' | 'claude',
    index: number,
    enabled: boolean
  ) => {
    const source = provider === 'codex' ? codexConfigs : claudeConfigs;
    const current = source[index];
    if (!current) return;

    const switchingKey = `${provider}:${current.apiKey}:cloak`;
    setConfigSwitchingKey(switchingKey);

    const previousList = source;
    const nextItem: ProviderKeyConfig = enabled
      ? { ...current, cloak: current.cloak ?? { ...DEFAULT_CLOAK_CONFIG, sensitiveWords: [] } }
      : { ...current };
    if (!enabled) {
      delete nextItem.cloak;
    }
    const nextList = previousList.map((item, idx) => (idx === index ? nextItem : item));

    if (provider === 'codex') {
      setCodexConfigs(nextList);
      updateConfigValue('codex-api-key', nextList);
      clearCache('codex-api-key');
    } else {
      setClaudeConfigs(nextList);
      updateConfigValue('claude-api-key', nextList);
      clearCache('claude-api-key');
    }

    try {
      if (provider === 'codex') {
        await providersApi.saveCodexConfigs(nextList);
        showNotification(t('notification.codex_config_updated'), 'success');
      } else {
        await providersApi.saveClaudeConfigs(nextList);
        showNotification(t('notification.claude_config_updated'), 'success');
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      if (provider === 'codex') {
        setCodexConfigs(previousList);
        updateConfigValue('codex-api-key', previousList);
        clearCache('codex-api-key');
      } else {
        setClaudeConfigs(previousList);
        updateConfigValue('claude-api-key', previousList);
        clearCache('claude-api-key');
      }
      showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
    } finally {
      setConfigSwitchingKey(null);
    }
  };

  const setProviderDisableCoolingEnabled = async (
    provider: 'gemini' | 'interactions' | 'codex' | 'claude' | 'openai',
    index: number,
    enabled: boolean
  ) => {
    if (provider === 'gemini' || provider === 'interactions') {
      const source = provider === 'gemini' ? geminiKeys : interactionsKeys;
      const current = source[index];
      if (!current) return;

      const switchingKey = `${provider}:${current.apiKey}:disable-cooling`;
      setConfigSwitchingKey(switchingKey);

      const previousList = source;
      const nextItem: GeminiKeyConfig = { ...current, disableCooling: enabled };
      const nextList = previousList.map((item, idx) => (idx === index ? nextItem : item));

      if (provider === 'gemini') {
        setGeminiKeys(nextList);
        updateConfigValue('gemini-api-key', nextList);
        clearCache('gemini-api-key');
      } else {
        setInteractionsKeys(nextList);
        updateConfigValue('interactions-api-key', nextList);
        clearCache('interactions-api-key');
      }

      try {
        if (provider === 'gemini') {
          await providersApi.saveGeminiKeys(nextList);
        } else {
          await providersApi.saveInteractionsKeys(nextList);
        }
        showNotification(
          t(
            provider === 'gemini'
              ? 'notification.gemini_key_updated'
              : 'notification.interactions_key_updated'
          ),
          'success'
        );
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        if (provider === 'gemini') {
          setGeminiKeys(previousList);
          updateConfigValue('gemini-api-key', previousList);
          clearCache('gemini-api-key');
        } else {
          setInteractionsKeys(previousList);
          updateConfigValue('interactions-api-key', previousList);
          clearCache('interactions-api-key');
        }
        showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
      } finally {
        setConfigSwitchingKey(null);
      }
      return;
    }

    if (provider === 'openai') {
      const current = openaiProviders[index];
      if (!current) return;

      const switchingKey = `${provider}:${current.name}:${index}:disable-cooling`;
      setConfigSwitchingKey(switchingKey);

      const previousList = openaiProviders;
      const nextItem: OpenAIProviderConfig = { ...current, disableCooling: enabled };
      const nextList = previousList.map((item, idx) => (idx === index ? nextItem : item));

      setOpenaiProviders(nextList);
      updateConfigValue('openai-compatibility', nextList);
      clearCache('openai-compatibility');

      try {
        await providersApi.saveOpenAIProviders(nextList);
        showNotification(t('notification.openai_provider_updated'), 'success');
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        setOpenaiProviders(previousList);
        updateConfigValue('openai-compatibility', previousList);
        clearCache('openai-compatibility');
        showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
      } finally {
        setConfigSwitchingKey(null);
      }
      return;
    }

    const source = provider === 'codex' ? codexConfigs : claudeConfigs;
    const current = source[index];
    if (!current) return;

    const switchingKey = `${provider}:${current.apiKey}:disable-cooling`;
    setConfigSwitchingKey(switchingKey);

    const previousList = source;
    const nextItem: ProviderKeyConfig = { ...current, disableCooling: enabled };
    const nextList = previousList.map((item, idx) => (idx === index ? nextItem : item));

    if (provider === 'codex') {
      setCodexConfigs(nextList);
      updateConfigValue('codex-api-key', nextList);
      clearCache('codex-api-key');
    } else {
      setClaudeConfigs(nextList);
      updateConfigValue('claude-api-key', nextList);
      clearCache('claude-api-key');
    }

    try {
      if (provider === 'codex') {
        await providersApi.saveCodexConfigs(nextList);
        showNotification(t('notification.codex_config_updated'), 'success');
      } else {
        await providersApi.saveClaudeConfigs(nextList);
        showNotification(t('notification.claude_config_updated'), 'success');
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      if (provider === 'codex') {
        setCodexConfigs(previousList);
        updateConfigValue('codex-api-key', previousList);
        clearCache('codex-api-key');
      } else {
        setClaudeConfigs(previousList);
        updateConfigValue('claude-api-key', previousList);
        clearCache('claude-api-key');
      }
      showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
    } finally {
      setConfigSwitchingKey(null);
    }
  };

  const setProviderPriority = async (row: ProviderRow, priority: number) => {
    const nextPriority = Math.trunc(priority);
    const switchingKey = `${row.key}:priority`;

    // 复用页面级切换锁，避免外层快捷优先级与抽屉保存、开关切换并发写入。
    if (row.kind === 'gemini' || row.kind === 'interactions') {
      const source = row.kind === 'gemini' ? geminiKeys : interactionsKeys;
      const current = source[row.originalIndex];
      if (!current || current.priority === nextPriority) return;

      setConfigSwitchingKey(switchingKey);
      const previousList = source;
      const nextList = previousList.map((item, idx) =>
        idx === row.originalIndex ? { ...item, priority: nextPriority } : item
      );

      if (row.kind === 'gemini') {
        setGeminiKeys(nextList);
        updateConfigValue('gemini-api-key', nextList);
        clearCache('gemini-api-key');
      } else {
        setInteractionsKeys(nextList);
        updateConfigValue('interactions-api-key', nextList);
        clearCache('interactions-api-key');
      }

      try {
        if (row.kind === 'gemini') {
          await providersApi.saveGeminiKeys(nextList);
        } else {
          await providersApi.saveInteractionsKeys(nextList);
        }
        showNotification(
          t(
            row.kind === 'gemini'
              ? 'notification.gemini_key_updated'
              : 'notification.interactions_key_updated'
          ),
          'success'
        );
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        if (row.kind === 'gemini') {
          setGeminiKeys(previousList);
          updateConfigValue('gemini-api-key', previousList);
          clearCache('gemini-api-key');
        } else {
          setInteractionsKeys(previousList);
          updateConfigValue('interactions-api-key', previousList);
          clearCache('interactions-api-key');
        }
        showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
      } finally {
        setConfigSwitchingKey(null);
      }
      return;
    }

    if (row.kind === 'openai') {
      const current = openaiProviders[row.originalIndex];
      if (!current || current.priority === nextPriority) return;

      setConfigSwitchingKey(switchingKey);
      const previousList = openaiProviders;
      const nextList = previousList.map((item, idx) =>
        idx === row.originalIndex ? { ...item, priority: nextPriority } : item
      );

      setOpenaiProviders(nextList);
      updateConfigValue('openai-compatibility', nextList);
      clearCache('openai-compatibility');

      try {
        await providersApi.saveOpenAIProviders(nextList);
        showNotification(t('notification.openai_provider_updated'), 'success');
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        setOpenaiProviders(previousList);
        updateConfigValue('openai-compatibility', previousList);
        clearCache('openai-compatibility');
        showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
      } finally {
        setConfigSwitchingKey(null);
      }
      return;
    }

    const source =
      row.kind === 'codex'
        ? codexConfigs
        : row.kind === 'claude'
          ? claudeConfigs
          : vertexConfigs;
    const current = source[row.originalIndex];
    if (!current || current.priority === nextPriority) return;

    setConfigSwitchingKey(switchingKey);
    const previousList = source;
    const nextList = previousList.map((item, idx) =>
      idx === row.originalIndex ? { ...item, priority: nextPriority } : item
    );

    if (row.kind === 'codex') {
      setCodexConfigs(nextList);
      updateConfigValue('codex-api-key', nextList);
      clearCache('codex-api-key');
    } else if (row.kind === 'claude') {
      setClaudeConfigs(nextList);
      updateConfigValue('claude-api-key', nextList);
      clearCache('claude-api-key');
    } else {
      setVertexConfigs(nextList);
      updateConfigValue('vertex-api-key', nextList);
      clearCache('vertex-api-key');
    }

    try {
      if (row.kind === 'codex') {
        await providersApi.saveCodexConfigs(nextList);
        showNotification(t('notification.codex_config_updated'), 'success');
      } else if (row.kind === 'claude') {
        await providersApi.saveClaudeConfigs(nextList);
        showNotification(t('notification.claude_config_updated'), 'success');
      } else {
        await providersApi.saveVertexConfigs(nextList);
        showNotification(t('notification.vertex_config_updated'), 'success');
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      if (row.kind === 'codex') {
        setCodexConfigs(previousList);
        updateConfigValue('codex-api-key', previousList);
        clearCache('codex-api-key');
      } else if (row.kind === 'claude') {
        setClaudeConfigs(previousList);
        updateConfigValue('claude-api-key', previousList);
        clearCache('claude-api-key');
      } else {
        setVertexConfigs(previousList);
        updateConfigValue('vertex-api-key', previousList);
        clearCache('vertex-api-key');
      }
      showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
    } finally {
      setConfigSwitchingKey(null);
    }
  };

  // 删除（按 provider 分派，沿用既有 API 契约）
  const deleteGemini = (index: number) => {
    const entry = geminiKeys[index];
    if (!entry) return;
    showConfirmation({
      title: t('ai_providers.gemini_delete_title', { defaultValue: 'Delete Gemini Key' }),
      message: t('ai_providers.gemini_delete_confirm'),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        try {
          await providersApi.deleteGeminiKey(entry.apiKey, entry.baseUrl);
          const next = geminiKeys.filter((_, idx) => idx !== index);
          setGeminiKeys(next);
          updateConfigValue('gemini-api-key', next);
          clearCache('gemini-api-key');
          showNotification(t('notification.gemini_key_deleted'), 'success');
        } catch (err: unknown) {
          const message = getErrorMessage(err);
          showNotification(`${t('notification.delete_failed')}: ${message}`, 'error');
        }
      },
    });
  };

  const deleteInteractions = (index: number) => {
    const entry = interactionsKeys[index];
    if (!entry) return;
    showConfirmation({
      title: t('ai_providers.interactions_delete_title'),
      message: t('ai_providers.interactions_delete_confirm'),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        try {
          await providersApi.deleteInteractionsKey(entry.apiKey, entry.baseUrl);
          const next = interactionsKeys.filter((_, idx) => idx !== index);
          setInteractionsKeys(next);
          updateConfigValue('interactions-api-key', next);
          clearCache('interactions-api-key');
          showNotification(t('notification.interactions_key_deleted'), 'success');
        } catch (err: unknown) {
          const message = getErrorMessage(err);
          showNotification(`${t('notification.delete_failed')}: ${message}`, 'error');
        }
      },
    });
  };

  const deleteProviderEntry = (type: 'codex' | 'claude', index: number) => {
    const source = type === 'codex' ? codexConfigs : claudeConfigs;
    const entry = source[index];
    if (!entry) return;
    showConfirmation({
      title: t(`ai_providers.${type}_delete_title`, {
        defaultValue: `Delete ${type === 'codex' ? 'Codex' : 'Claude'} Config`,
      }),
      message: t(`ai_providers.${type}_delete_confirm`),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        try {
          if (type === 'codex') {
            await providersApi.deleteCodexConfig(entry.apiKey, entry.baseUrl);
            const next = codexConfigs.filter((_, idx) => idx !== index);
            setCodexConfigs(next);
            updateConfigValue('codex-api-key', next);
            clearCache('codex-api-key');
            showNotification(t('notification.codex_config_deleted'), 'success');
          } else {
            await providersApi.deleteClaudeConfig(entry.apiKey, entry.baseUrl);
            const next = claudeConfigs.filter((_, idx) => idx !== index);
            setClaudeConfigs(next);
            updateConfigValue('claude-api-key', next);
            clearCache('claude-api-key');
            showNotification(t('notification.claude_config_deleted'), 'success');
          }
        } catch (err: unknown) {
          const message = getErrorMessage(err);
          showNotification(`${t('notification.delete_failed')}: ${message}`, 'error');
        }
      },
    });
  };

  const deleteVertex = (index: number) => {
    const entry = vertexConfigs[index];
    if (!entry) return;
    showConfirmation({
      title: t('ai_providers.vertex_delete_title', { defaultValue: 'Delete Vertex Config' }),
      message: t('ai_providers.vertex_delete_confirm'),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        try {
          await providersApi.deleteVertexConfig(entry.apiKey, entry.baseUrl);
          const next = vertexConfigs.filter((_, idx) => idx !== index);
          setVertexConfigs(next);
          updateConfigValue('vertex-api-key', next);
          clearCache('vertex-api-key');
          showNotification(t('notification.vertex_config_deleted'), 'success');
        } catch (err: unknown) {
          const message = getErrorMessage(err);
          showNotification(`${t('notification.delete_failed')}: ${message}`, 'error');
        }
      },
    });
  };

  const deleteOpenai = (index: number) => {
    const entry = openaiProviders[index];
    if (!entry) return;
    showConfirmation({
      title: t('ai_providers.openai_delete_title', { defaultValue: 'Delete OpenAI Provider' }),
      message: t('ai_providers.openai_delete_confirm'),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        try {
          await providersApi.deleteOpenAIProvider(entry.name);
          const next = openaiProviders.filter((_, idx) => idx !== index);
          setOpenaiProviders(next);
          updateConfigValue('openai-compatibility', next);
          clearCache('openai-compatibility');
          showNotification(t('notification.openai_provider_deleted'), 'success');
        } catch (err: unknown) {
          const message = getErrorMessage(err);
          showNotification(`${t('notification.delete_failed')}: ${message}`, 'error');
        }
      },
    });
  };

  // 行级回调分派
  const handleRowToggle = (row: ProviderRow, enabled: boolean) => {
    if (row.kind === 'openai') {
      void setOpenAIProviderEnabled(row.originalIndex, enabled);
    } else {
      void setConfigEnabled(row.kind, row.originalIndex, enabled);
    }
  };

  const handleRowWebsocketsToggle = (row: ProviderRow, enabled: boolean) => {
    if (row.kind !== 'codex' && row.kind !== 'claude') return;
    void setProviderWebsocketsEnabled(row.kind, row.originalIndex, enabled);
  };

  const handleRowCloakToggle = (row: ProviderRow, enabled: boolean) => {
    if (row.kind !== 'codex' && row.kind !== 'claude') return;
    void setProviderCloakEnabled(row.kind, row.originalIndex, enabled);
  };

  const handleRowDisableCoolingToggle = (row: ProviderRow, enabled: boolean) => {
    if (
      row.kind !== 'gemini' &&
      row.kind !== 'interactions' &&
      row.kind !== 'codex' &&
      row.kind !== 'claude' &&
      row.kind !== 'openai'
    ) {
      return;
    }
    void setProviderDisableCoolingEnabled(row.kind, row.originalIndex, enabled);
  };

  const handleRowPriorityChange = (row: ProviderRow, priority: number) => {
    void setProviderPriority(row, priority);
  };

  const handleRowEdit = (row: ProviderRow) => {
    setDetailRowKey(null);
    openEditorDrawer(row.kind, row.originalIndex);
  };

  const handleRowDelete = (row: ProviderRow) => {
    setDetailRowKey(null);
    if (row.kind === 'gemini') {
      deleteGemini(row.originalIndex);
    } else if (row.kind === 'interactions') {
      deleteInteractions(row.originalIndex);
    } else if (row.kind === 'codex' || row.kind === 'claude') {
      deleteProviderEntry(row.kind, row.originalIndex);
    } else if (row.kind === 'vertex') {
      deleteVertex(row.originalIndex);
    } else {
      deleteOpenai(row.originalIndex);
    }
  };

  const handleAdd = (kind: ProviderKind) => {
    openEditorDrawer(kind, null);
  };

  const handlePageSizeChange = (value: string) => {
    const nextSize = Number.parseInt(value, 10);
    if (!Number.isFinite(nextSize) || nextSize <= 0) return;
    setPageSize(nextSize);
    setPage(1);
  };

  const emptyState =
    rows.length > 0 && kindFilter !== 'all' && kindCounts[kindFilter] === 0 ? (
      // 当前类型尚无配置：直接给“添加该类型配置”入口，避免“清除筛选”死胡同
      <EmptyState
        title={t('ai_providers.kind_empty_title', { name: PROVIDER_KIND_LABELS[kindFilter] })}
        action={
          <Button
            size="sm"
            onClick={() => handleAdd(kindFilter)}
            disabled={actionsDisabled}
          >
            {t('ai_providers.add_kind_button', { name: PROVIDER_KIND_LABELS[kindFilter] })}
          </Button>
        }
      />
    ) : rows.length > 0 && filtersActive ? (
      <EmptyState
        title={t('ai_providers.table_filtered_empty_title')}
        description={t('ai_providers.table_filtered_empty_desc')}
        action={
          <Button variant="secondary" size="sm" onClick={clearFilters} disabled={actionsDisabled}>
            {t('ai_providers.clear_filters')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        title={t('ai_providers.table_empty_title')}
        description={t('ai_providers.table_empty_desc')}
      />
    );

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        {error && <div className="error-box">{error}</div>}

        <Card className={styles.charityMonitorCard}>
          <div className={styles.charityMonitorHeader}>
            <div>
              <h3>公益站模型监控与通道自愈</h3>
              <p>
                从 AI 提供商读取 Codex / Claude 通道，优先按自定义模型检查；全部缺失自动关闭，任意恢复自动启动。
              </p>
            </div>
            <div className={styles.charityMonitorActions}>
              <ToggleSwitch
                checked={charityEnabled}
                onChange={(value) => void toggleCharityMonitor(value)}
                disabled={actionsDisabled || charitySaving || charityLoading || !managerServiceBase}
                ariaLabel="公益站模型监控总开关"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void loadCharityPolicy()}
                disabled={charityLoading || !managerServiceBase}
              >
                <IconRefreshCw size={14} />
                刷新状态
              </Button>
            </div>
          </div>
          <div className={styles.charityMonitorSummary}>
            <span>总开关：{charityEnabled ? '已开启' : '已关闭'}</span>
            <span>最近检测：{charityPolicy?.charityModelMonitorState?.lastCheck || '暂无'}</span>
            <span>Codex 版本：{charityPolicy?.charityModelMonitorState?.lastCodexCliVersion || '等待同步'}</span>
          </div>
          {charityLoadError ? (
            <div className={styles.charityMonitorNotice}>{charityLoadError}</div>
          ) : null}
          {charityRows.length > 0 ? (
            <div className={styles.charityMonitorGrid}>
              {charityRows.map(({ row, state }) => (
                <section className={styles.charityProviderCard} key={`${row.key}:charity`}>
                  <div className={styles.charityProviderTitle}>
                    <strong>{state.site} / {state.label}</strong>
                    <span className={state.desiredEnabled ? styles.charityStatusOn : styles.charityStatusOff}>
                      {state.desiredEnabled ? '应开启' : '应关闭'}
                    </span>
                  </div>
                  <p>{row.baseUrl}</p>
                  <div className={styles.charityProviderMeta}>
                    <span>检查范围：{state.checkMode === 'custom' ? `自定义模型 ${state.customModels?.length ?? 0} 个` : `${row.kind === 'codex' ? 'gpt-*' : 'claude-*'}`}</span>
                    <span>命中：{state.matchedModels?.length ?? 0} 个</span>
                    <span>动作：{state.reason || (state.changed ? '已同步' : '无变化')}</span>
                    {state.headersChanged ? <span>请求头已同步</span> : null}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <p className={styles.charityMonitorEmpty}>
              暂无最近自愈结果。开启总开关后，worker 下次运行会按 AI 提供商自动匹配薄荷 / 君の / AnyRouter。
            </p>
          )}
          {charityPolicy?.charityModelMonitorState?.lastProviderError?.length ? (
            <div className={styles.charityMonitorErrors}>
              {charityPolicy.charityModelMonitorState.lastProviderError.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </div>
          ) : null}
          <div className={styles.charityIntervalPanel}>
            <label className={styles.numberField}>
              <span>检查间隔（分钟）</span>
              <input
                type="number"
                min={5}
                max={1440}
                value={charityIntervalDraft}
                onChange={(event) => updateCharityIntervalDraft(event.target.value)}
              />
              <small>每隔多少分钟检查一次公益站模型和通道状态，建议 15 分钟起。</small>
            </label>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void persistCharityInterval()}
              disabled={
                charityIntervalSaving ||
                charityIntervalUnchanged ||
                !managerServiceBase ||
                charityIntervalDraft < 5 ||
                charityIntervalDraft > 1440
              }
            >
              保存检查间隔
            </Button>
          </div>
        </Card>

        <Card className={styles.http500Card}>
          <div className={styles.charityMonitorHeader}>
            <div>
              <h3>HTTP 500 通道熔断</h3>
              <p>
                同一通道在指定窗口内累计 HTTP 500 次数达到阈值后自动关闭渠道，到期自动恢复。
              </p>
            </div>
            <div className={styles.charityMonitorActions}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void persistHttp500Settings()}
                disabled={http500Saving || http500Unchanged || !managerServiceBase}
              >
                保存关闭策略
              </Button>
            </div>
          </div>
          <div className={styles.http500PresetGrid}>
            {(Object.entries(HTTP500_PRESETS) as Array<[Exclude<Http500PresetKey, 'custom'>, typeof HTTP500_PRESETS[keyof typeof HTTP500_PRESETS]]>).map(([key, preset]) => (
              <button
                key={key}
                type="button"
                className={key === http500Preset ? styles.http500PresetActive : styles.http500PresetCard}
                onClick={() => applyHttp500Preset(key)}
              >
                <strong>{preset.label}</strong>
                <span>{preset.windowMinutes} 分钟内 {preset.threshold} 次，关闭渠道 {preset.durationMinutes} 分钟</span>
                <small>{preset.description}</small>
              </button>
            ))}
            <button
              type="button"
              className={http500Preset === 'custom' ? styles.http500PresetActive : styles.http500PresetCard}
              onClick={() => {
                http500DirtyRef.current = true;
                setHttp500Preset('custom');
              }}
            >
              <strong>自定义</strong>
              <span>{http500Draft.windowMinutes} 分钟内 {http500Draft.threshold} 次，关闭渠道 {http500Draft.durationMinutes} 分钟</span>
              <small>手动调整下面三项参数。</small>
            </button>
          </div>
          <div className={styles.http500Grid}>
            <label className={styles.numberField}>
              <span>统计窗口（分钟）</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={http500Draft.windowMinutes}
                onChange={(event) => updateHttp500Draft('windowMinutes', event.target.value)}
              />
              <small>只统计这个时间窗口内同一通道的 HTTP 500 失败次数。</small>
            </label>
            <label className={styles.numberField}>
              <span>触发次数</span>
              <input
                type="number"
                min={1}
                max={100}
                value={http500Draft.threshold}
                onChange={(event) => updateHttp500Draft('threshold', event.target.value)}
              />
              <small>窗口内累计达到该次数后，自动关闭这个通道。</small>
            </label>
            <label className={styles.numberField}>
              <span>关闭渠道时长（分钟）</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={http500Draft.durationMinutes}
                onChange={(event) => updateHttp500Draft('durationMinutes', event.target.value)}
              />
              <small>关闭后等待多久自动恢复；到期会重新参与调度。</small>
            </label>
          </div>
        </Card>

        <div>
          <ProviderToolbar
            kind={kindFilter}
            kindCounts={kindCounts}
            onKindChange={setKindFilter}
            searchText={searchText}
            onSearchTextChange={setSearchText}
            allModelNames={allModelNames}
            selectedModels={selectedModels}
            onSelectedModelsChange={setSelectedModels}
            sortOption={sortOption}
            onSortOptionChange={setSortOption}
            sortDirection={sortDirection}
            onSortDirectionChange={setSortDirection}
            disabled={actionsDisabled}
            resolvedTheme={resolvedTheme}
            onAdd={handleAdd}
            onHealthCheck={() => setHealthCheckOpen(true)}
            healthCheckDisabled={visibleRows.length === 0}
          />

          <Card>
            <ProviderTable
              rows={pagedRows}
              loading={loading}
              actionsDisabled={actionsDisabled}
              toggleDisabled={actionsDisabled}
              resolvedTheme={resolvedTheme}
              emptyState={emptyState}
              onShowDetail={(row) => setDetailRowKey(row.key)}
              onEdit={handleRowEdit}
              onDelete={handleRowDelete}
              onToggle={handleRowToggle}
              onPriorityChange={handleRowPriorityChange}
            />
            {visibleRows.length > 0 &&
              (visibleRows.length > PROVIDER_TABLE_DEFAULT_PAGE_SIZE ||
                pageSize !== PROVIDER_TABLE_DEFAULT_PAGE_SIZE) && (
              <div className={styles.paginationBar}>
                <div className={styles.paginationInfo}>
                  {t('monitoring.pagination_info', {
                    current: currentPage,
                    total: totalPages,
                    start: pageStartItem,
                    end: pageEndItem,
                    count: visibleRows.length,
                  })}
                </div>
                <div className={styles.paginationControls}>
                  <div className={styles.pageSizeField}>
                    <span>{t('monitoring.page_size_label')}</span>
                    <Select
                      value={String(pageSize)}
                      options={PROVIDER_TABLE_PAGE_SIZE_OPTIONS.map((size) => ({
                        value: String(size),
                        label: t('monitoring.page_size_option', { count: size }),
                      }))}
                      onChange={handlePageSizeChange}
                      disabled={loading}
                      fullWidth={false}
                      ariaLabel={t('monitoring.page_size_label')}
                      className={styles.pageSizeSelect}
                      triggerClassName={styles.pageSizeSelectTrigger}
                    />
                  </div>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => setPage(Math.max(1, currentPage - 1))}
                    disabled={loading || currentPage <= 1}
                  >
                    {t('monitoring.pagination_prev')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                    disabled={loading || currentPage >= totalPages}
                  >
                    {t('monitoring.pagination_next')}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>

      <ProviderDetailDrawer
        row={detailRow}
        open={detailRowKey !== null}
        usageByProvider={usageByProvider}
        resolvedTheme={resolvedTheme}
        actionsDisabled={actionsDisabled}
        toggleDisabled={actionsDisabled}
        onClose={() => setDetailRowKey(null)}
        onEdit={handleRowEdit}
        onDelete={handleRowDelete}
        onToggle={handleRowToggle}
        onToggleWebsockets={handleRowWebsocketsToggle}
        onToggleCloak={handleRowCloakToggle}
        onToggleDisableCooling={handleRowDisableCoolingToggle}
      />
      <ProviderHealthCheckDrawer
        open={healthCheckOpen}
        rows={visibleRows}
        actionsDisabled={actionsDisabled}
        onClose={() => setHealthCheckOpen(false)}
        onApplyResultActions={applyProviderEnabledActions}
        onSetProviderEnabled={setHealthCheckProviderEnabled}
      />
      <GeminiEditDrawer
        open={editDrawerKind === 'gemini'}
        editIndex={editDrawerIndex}
        disabled={actionsDisabled}
        onClose={closeEditorDrawer}
        onSaved={handleDrawerSaved}
      />
      <GeminiEditDrawer
        open={editDrawerKind === 'interactions'}
        editIndex={editDrawerIndex}
        disabled={actionsDisabled}
        onClose={closeEditorDrawer}
        onSaved={handleDrawerSaved}
        providerKind="interactions"
      />
      <CodexEditDrawer
        open={editDrawerKind === 'codex'}
        editIndex={editDrawerIndex}
        disabled={actionsDisabled}
        onClose={closeEditorDrawer}
        onSaved={handleDrawerSaved}
      />
      <VertexEditDrawer
        open={editDrawerKind === 'vertex'}
        editIndex={editDrawerIndex}
        disabled={actionsDisabled}
        onClose={closeEditorDrawer}
        onSaved={handleDrawerSaved}
      />
      <ClaudeEditDrawer
        open={editDrawerKind === 'claude'}
        editIndex={editDrawerIndex}
        disabled={actionsDisabled}
        onClose={closeEditorDrawer}
        onSaved={handleDrawerSaved}
      />
      <OpenAIEditDrawer
        open={editDrawerKind === 'openai'}
        editIndex={editDrawerIndex}
        disabled={actionsDisabled}
        onClose={closeEditorDrawer}
        onSaved={handleDrawerSaved}
      />
    </div>
  );
}
