import { type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { AuthFilesPage } from './AuthFilesPage';

const { mocks } = vi.hoisted(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  return {
    mocks: {
      connectionStatus: 'connected' as 'connected' | 'disconnected',
      list: vi.fn(),
      saveJsonObject: vi.fn(),
      uploadFiles: vi.fn(),
      deleteFiles: vi.fn(),
      deleteFileByName: vi.fn(),
      deleteAll: vi.fn(),
      showNotification: vi.fn(),
      showConfirmation: vi.fn(),
      navigate: vi.fn(),
      panelFeatureAvailability: {
        checking: false,
        managerServiceBase: 'http://manager.local:18317',
        serverCodexInspectionAvailable: true,
      },
      loadExcluded: vi.fn(async () => undefined),
      loadModelAlias: vi.fn(async () => undefined),
      listCodexInspectionRuns: vi.fn(),
      getCodexInspectionRun: vi.fn(),
      getHeaderSnapshots: vi.fn(),
      deleteExcluded: vi.fn(async () => undefined),
      deleteModelAlias: vi.fn(async () => undefined),
      handleMappingUpdate: vi.fn(async () => undefined),
      handleDeleteLink: vi.fn(async () => undefined),
      handleToggleFork: vi.fn(async () => undefined),
      handleRenameAlias: vi.fn(async () => undefined),
      handleDeleteAlias: vi.fn(async () => undefined),
      showModels: vi.fn(),
      closeModelsModal: vi.fn(),
      openPrefixProxyEditor: vi.fn(),
      closePrefixProxyEditor: vi.fn(),
      handlePrefixProxyChange: vi.fn(),
      handlePrefixProxySave: vi.fn(async () => undefined),
      codexQuota: {} as Record<string, unknown>,
      lastCodexInspectionLastRun: null as {
        result: {
          startedAt?: number;
          finishedAt?: number;
          results: Array<{
            fileName: string;
            runtimeId?: string | null;
            provider?: string | null;
            authIndex?: string | number | null;
            accountId?: string | null;
            accountSnapshot?: string | null;
            displayAccount?: string | null;
            statusCode?: number | null;
            action?: string | null;
            usedPercent?: number | null;
            isQuota?: boolean | null;
          }>;
        };
      } | null,
      t: (key: string, options?: Record<string, unknown>) => {
        if (options && typeof options.name === 'string') {
          return `${key}:${options.name}`;
        }
        return key;
      },
    },
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: mocks.t,
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('motion/mini', () => ({
  animate: () => ({ stop: () => {} }),
}));

vi.mock('@/hooks/useInterval', () => ({
  useInterval: () => {},
}));

vi.mock('@/hooks/useHeaderRefresh', () => ({
  useHeaderRefresh: () => {},
}));

vi.mock('@/hooks/usePanelFeatureAvailability', () => ({
  usePanelFeatureAvailability: () => mocks.panelFeatureAvailability,
}));

vi.mock('@/components/common/PageTransitionLayer', () => ({
  usePageTransitionLayer: () => ({ status: 'current' }),
}));

vi.mock('@/utils/clipboard', () => ({
  copyToClipboard: vi.fn(async () => undefined),
}));

vi.mock('@/services/api', () => ({
  authFilesApi: {
    list: mocks.list,
    saveJsonObject: mocks.saveJsonObject,
    uploadFiles: mocks.uploadFiles,
    deleteFiles: mocks.deleteFiles,
    deleteFileByName: mocks.deleteFileByName,
    deleteAll: mocks.deleteAll,
  },
}));

vi.mock('@/services/api/usageService', () => ({
  usageServiceApi: {
    listCodexInspectionRuns: mocks.listCodexInspectionRuns,
    getCodexInspectionRun: mocks.getCodexInspectionRun,
  },
  monitoringAnalyticsApi: {
    getHeaderSnapshots: mocks.getHeaderSnapshots,
  },
}));

vi.mock('@/stores', () => ({
  captureQuotaCacheGeneration: () => 0,
  commitIfQuotaCacheCurrent: (_generation: number, commit: () => void) => {
    commit();
    return true;
  },
  useNotificationStore: (
    selector?: (state: {
      showNotification: typeof mocks.showNotification;
      showConfirmation: typeof mocks.showConfirmation;
    }) => unknown
  ) => {
    const state = {
      showNotification: mocks.showNotification,
      showConfirmation: mocks.showConfirmation,
    };
    return selector ? selector(state) : state;
  },
  useAuthStore: (
    selector: (state: {
      connectionStatus: 'connected' | 'disconnected';
      apiBase: string;
      managementKey: string;
    }) => unknown
  ) =>
    selector({
      connectionStatus: mocks.connectionStatus,
      apiBase: 'http://manager.local:18317',
      managementKey: 'test-key',
    }),
  useThemeStore: (selector: (state: { resolvedTheme: 'dark' }) => unknown) =>
    selector({ resolvedTheme: 'dark' }),
  useQuotaStore: (selector: (state: { codexQuota: Record<string, unknown> }) => unknown) =>
    selector({ codexQuota: mocks.codexQuota }),
}));

vi.mock('@/features/authFiles/hooks/useAuthFilesOauth', () => ({
  useAuthFilesOauth: () => ({
    excluded: [],
    excludedError: 'ready',
    modelAlias: [],
    modelAliasError: 'ready',
    allProviderModels: {},
    loadExcluded: mocks.loadExcluded,
    loadModelAlias: mocks.loadModelAlias,
    deleteExcluded: mocks.deleteExcluded,
    deleteModelAlias: mocks.deleteModelAlias,
    handleMappingUpdate: mocks.handleMappingUpdate,
    handleDeleteLink: mocks.handleDeleteLink,
    handleToggleFork: mocks.handleToggleFork,
    handleRenameAlias: mocks.handleRenameAlias,
    handleDeleteAlias: mocks.handleDeleteAlias,
  }),
}));

vi.mock('@/features/authFiles/hooks/useAuthFilesModels', () => ({
  useAuthFilesModels: () => ({
    modelsModalOpen: false,
    modelsLoading: false,
    modelsList: [],
    modelsFileName: '',
    modelsFileType: '',
    modelsError: '',
    showModels: mocks.showModels,
    closeModelsModal: mocks.closeModelsModal,
  }),
}));

vi.mock('@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor', () => ({
  useAuthFilesPrefixProxyEditor: () => ({
    prefixProxyEditor: null,
    prefixProxyUpdatedText: '',
    prefixProxyDirty: false,
    openPrefixProxyEditor: mocks.openPrefixProxyEditor,
    closePrefixProxyEditor: mocks.closePrefixProxyEditor,
    handlePrefixProxyChange: mocks.handlePrefixProxyChange,
    handlePrefixProxySave: mocks.handlePrefixProxySave,
  }),
}));

vi.mock('@/features/authFiles/hooks/useAuthFilesStatusBarCache', () => ({
  useAuthFilesStatusBarCache: () => new Map(),
}));

vi.mock('@/features/monitoring/codexInspection', () => ({
  createCodexInspectionConnectionFingerprint: () => 'test-fingerprint',
  loadCodexInspectionLastRun: () => mocks.lastCodexInspectionLastRun,
}));

vi.mock('@/features/authFiles/uiState', () => ({
  normalizeAuthFilesSortMode: (value: string) => (value === 'default' ? 'default' : null),
  normalizeAuthFilesViewMode: (value: string) =>
    value === 'diagram' || value === 'list' ? value : null,
  readAuthFilesUiState: () => null,
  readPersistedAuthFilesCompactMode: () => null,
  writeAuthFilesUiState: vi.fn(),
  writePersistedAuthFilesCompactMode: vi.fn(),
}));

vi.mock('@/features/authFiles/components/AuthFileCard', () => ({
  AuthFileCard: (props: {
    file: { name: string; account?: unknown; authIndex?: unknown; auth_index?: unknown };
    codexStatusBadges?: Array<{ kind: string }>;
  }) => {
    const authIndex = props.file.authIndex ?? props.file.auth_index ?? '-';
    const key = `${props.file.name}::${String(authIndex)}`;
    return (
      <div
        data-auth-card={key}
        data-auth-account={String(props.file.account ?? '')}
        data-codex-badges={props.codexStatusBadges?.map((badge) => badge.kind).join(',') ?? ''}
      />
    );
  },
}));

vi.mock('@/features/authFiles/components/AuthFileModelsModal', () => ({
  AuthFileModelsModal: () => null,
}));

vi.mock('@/features/authFiles/components/AuthFilesPrefixProxyEditorModal', () => ({
  AuthFilesPrefixProxyEditorModal: () => null,
}));

vi.mock('@/features/authFiles/components/OAuthExcludedCard', () => ({
  OAuthExcludedCard: () => null,
}));

vi.mock('@/features/authFiles/components/OAuthModelAliasCard', () => ({
  OAuthModelAliasCard: () => null,
}));

vi.mock('@/components/ui/EmptyState', () => ({
  EmptyState: () => null,
}));

vi.mock('@/components/ui/ToggleSwitch', () => ({
  ToggleSwitch: () => null,
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: (props: { open: boolean; children: ReactNode; footer?: ReactNode }) => {
    if (!props.open) return null;
    return (
      <div>
        <div>{props.children}</div>
        <div>{props.footer}</div>
      </div>
    );
  },
}));

const findButtonByText = (renderer: ReactTestRenderer, text: string) => {
  const button = renderer.root.findAllByType(Button).find((node) => node.props.children === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
};

describe('AuthFilesPage real auth JSON paste flow', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.saveJsonObject.mockReset();
    mocks.uploadFiles.mockReset();
    mocks.deleteFiles.mockReset();
    mocks.deleteFileByName.mockReset();
    mocks.deleteAll.mockReset();
    mocks.showNotification.mockReset();
    mocks.showConfirmation.mockReset();
    mocks.loadExcluded.mockReset();
    mocks.loadModelAlias.mockReset();
    mocks.listCodexInspectionRuns.mockReset();
    mocks.getCodexInspectionRun.mockReset();
    mocks.getHeaderSnapshots.mockReset();
    mocks.connectionStatus = 'connected';
    mocks.codexQuota = {};
    mocks.panelFeatureAvailability = {
      checking: false,
      managerServiceBase: 'http://manager.local:18317',
      serverCodexInspectionAvailable: true,
    };
    mocks.lastCodexInspectionLastRun = null;

    mocks.list.mockResolvedValue({ files: [] });
    mocks.saveJsonObject.mockResolvedValue(undefined);
    mocks.uploadFiles.mockImplementation(async (files: File[]) => ({
      status: 'ok',
      uploaded: files.length,
      files: files.map((file) => file.name),
      failed: [],
    }));
    mocks.deleteFiles.mockResolvedValue({ deleted: 0, failed: [], files: [] });
    mocks.deleteFileByName.mockResolvedValue({ deleted: 0, failed: [], files: [] });
    mocks.deleteAll.mockResolvedValue(undefined);
    mocks.loadExcluded.mockResolvedValue(undefined);
    mocks.loadModelAlias.mockResolvedValue(undefined);
    mocks.listCodexInspectionRuns.mockResolvedValue({ items: [] });
    mocks.getCodexInspectionRun.mockResolvedValue({ run: { id: 1 }, results: [], logs: [] });
    mocks.getHeaderSnapshots.mockResolvedValue({
      generated_at_ms: 1_700_000_000_000,
      from_ms: 1_700_000_000_000,
      to_ms: 1_700_000_000_000,
      items: [],
    });
  });








  it('filters rendered Codex rows by selected plan', async () => {
    mocks.list.mockResolvedValue({
      files: [
        { name: 'plus-codex.json', type: 'codex', authIndex: 'plus', plan_type: 'plus' },
        { name: 'team-codex.json', type: 'codex', authIndex: 'team', plan_type: 'team' },
        { name: 'qwen.json', type: 'qwen' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<AuthFilesPage />);
    });

    await vi.waitFor(() => {
      const renderedCards = renderer!.root.findAll(
        (node) => typeof node.props['data-auth-card'] === 'string'
      );
      expect(renderedCards.map((node) => node.props['data-auth-card']).sort()).toEqual([
        'plus-codex.json::plus',
        'qwen.json::-',
        'team-codex.json::team',
      ]);
    });

    const planSelect = renderer!.root
      .findAllByType(Select)
      .find((node) => node.props.ariaLabel === 'auth_files.codex_plan_filter_label');
    if (!planSelect) throw new Error('Codex plan filter select not found');
    act(() => {
      planSelect.props.onChange('team');
    });

    await vi.waitFor(() => {
      const renderedCards = renderer!.root.findAll(
        (node) => typeof node.props['data-auth-card'] === 'string'
      );
      expect(renderedCards.map((node) => node.props['data-auth-card'])).toEqual([
        'team-codex.json::team',
      ]);
    });

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('scopes delete all to the selected Codex plan filter', async () => {
    mocks.list.mockResolvedValue({
      files: [
        {
          id: 'plus-codex.json',
          name: 'plus-codex.json',
          type: 'codex',
          authIndex: 'plus',
          plan_type: 'plus',
        },
        {
          id: 'team-codex.json',
          name: 'team-codex.json',
          type: 'codex',
          authIndex: 'team',
          plan_type: 'team',
        },
        { id: 'qwen.json', name: 'qwen.json', type: 'qwen' },
      ],
    });
    mocks.deleteFileByName.mockResolvedValue({
      deleted: 1,
      failed: [],
      files: ['team-codex.json'],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<AuthFilesPage />);
    });

    const planSelect = renderer!.root
      .findAllByType(Select)
      .find((node) => node.props.ariaLabel === 'auth_files.codex_plan_filter_label');
    if (!planSelect) throw new Error('Codex plan filter select not found');
    act(() => {
      planSelect.props.onChange('team');
    });

    await vi.waitFor(() => {
      const renderedCards = renderer!.root.findAll(
        (node) => typeof node.props['data-auth-card'] === 'string'
      );
      expect(renderedCards.map((node) => node.props['data-auth-card'])).toEqual([
        'team-codex.json::team',
      ]);
    });

    act(() => {
      findButtonByText(renderer!, 'auth_files.delete_filtered_result_button').props.onClick?.();
    });

    expect(mocks.showConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'auth_files.delete_filtered_result_confirm_file_scope',
      })
    );
    const confirmationCalls = mocks.showConfirmation.mock.calls;
    const confirmation = confirmationCalls[confirmationCalls.length - 1]?.[0] as
      | { onConfirm?: () => Promise<void> }
      | undefined;

    await act(async () => {
      await confirmation?.onConfirm?.();
    });

    expect(mocks.deleteAll).not.toHaveBeenCalled();
    expect(mocks.deleteFileByName).toHaveBeenCalledWith(
      'team-codex.json',
      'team-codex.json',
      undefined,
      [
        {
          name: 'team-codex.json',
          runtimeId: 'team-codex.json',
          authIndex: 'team',
          provider: 'codex',
        },
      ]
    );
    expect(mocks.deleteFiles).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('submits default session paste through modal and uploads converted codex payload', async () => {
    const sessionInput = JSON.stringify({
      user: { email: 'Session.User+tag@example.com' },
      account: { id: 'session-account' },
      accessToken: 'plain-access-token',
    });

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFilesPage />);
    });

    expect(renderer!.root.findAllByProps({ id: 'auth-json-paste-content' })).toHaveLength(0);

    act(() => {
      findButtonByText(renderer!, 'auth_files.paste_button').props.onClick?.();
    });

    const textarea = renderer!.root.findByProps({ id: 'auth-json-paste-content' });
    act(() => {
      textarea.props.onChange({ target: { value: sessionInput } });
    });

    await act(async () => {
      await findButtonByText(renderer!, 'auth_files.paste_save_button').props.onClick?.();
    });

    await vi.waitFor(() => {
      expect(mocks.saveJsonObject).toHaveBeenCalledWith(
        'codex-session-session.user+tag@example.com.json',
        expect.objectContaining({
          type: 'codex',
          email: 'Session.User+tag@example.com',
          account_id: 'session-account',
          access_token: 'plain-access-token',
        })
      );
    });
    await vi.waitFor(() => {
      expect(mocks.showNotification).toHaveBeenCalledWith(
        'auth_files.paste_success:codex-session-session.user+tag@example.com.json',
        'success'
      );
      expect(renderer!.root.findAllByProps({ id: 'auth-json-paste-content' })).toHaveLength(0);
    });

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('submits sub2api paste through modal and uploads converted codex array', async () => {
    const sub2apiInput = JSON.stringify({
      exported_at: '2026-06-01T12:00:00.000Z',
      proxies: [],
      accounts: [
        {
          name: 'First OpenAI',
          platform: 'openai',
          type: 'oauth',
          credentials: {
            access_token: 'first-access-token',
            email: 'first@example.com',
          },
        },
        {
          name: 'Second OpenAI',
          platform: 'openai',
          type: 'oauth',
          credentials: {
            access_token: 'second-access-token',
            email: 'second@example.com',
          },
        },
      ],
    });

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFilesPage />);
    });

    act(() => {
      findButtonByText(renderer!, 'auth_files.paste_button').props.onClick?.();
    });

    const select = renderer!.root
      .findAllByType(Select)
      .find((node) => node.props.ariaLabel === 'auth_files.paste_type_label');
    if (!select) throw new Error('Paste type select not found');
    act(() => {
      select.props.onChange('sub2api');
    });

    const textarea = renderer!.root.findByProps({ id: 'auth-json-paste-content' });
    act(() => {
      textarea.props.onChange({ target: { value: sub2apiInput } });
    });

    await act(async () => {
      await findButtonByText(renderer!, 'auth_files.paste_save_button').props.onClick?.();
    });

    await vi.waitFor(() => expect(mocks.uploadFiles).toHaveBeenCalledTimes(1));
    expect(mocks.saveJsonObject).not.toHaveBeenCalled();
    const uploadedFiles = mocks.uploadFiles.mock.calls[0]?.[0] as File[];
    expect(uploadedFiles).toHaveLength(2);
    const uploadedJson = await Promise.all(
      uploadedFiles.map(async (file) => JSON.parse(await file.text()) as Record<string, unknown>)
    );
    expect(uploadedJson).toEqual([
      expect.objectContaining({
        type: 'codex',
        email: 'first@example.com',
        access_token: 'first-access-token',
      }),
      expect.objectContaining({
        type: 'codex',
        email: 'second@example.com',
        access_token: 'second-access-token',
      }),
    ]);

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('keeps the paste modal open and does not upload invalid CPA JSON', async () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFilesPage />);
    });

    act(() => {
      findButtonByText(renderer!, 'auth_files.paste_button').props.onClick?.();
    });

    const select = renderer!.root
      .findAllByType(Select)
      .find((node) => node.props.ariaLabel === 'auth_files.paste_type_label');
    if (!select) throw new Error('Paste type select not found');
    act(() => {
      select.props.onChange('cpa');
    });

    const textarea = renderer!.root.findByProps({ id: 'auth-json-paste-content' });
    act(() => {
      textarea.props.onChange({ target: { value: '{"type":"codex"}' } });
    });

    await act(async () => {
      await findButtonByText(renderer!, 'auth_files.paste_save_button').props.onClick?.();
    });

    expect(mocks.saveJsonObject).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      'CPA auth JSON is missing required auth fields'
    );
    expect(renderer!.root.findAllByProps({ id: 'auth-json-paste-content' })).toHaveLength(1);

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('does not submit an open paste modal after connection is lost', async () => {
    const sessionInput = JSON.stringify({
      user: { email: 'Session.User+tag@example.com' },
      account: { id: 'session-account' },
      accessToken: 'plain-access-token',
    });
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFilesPage />);
    });

    act(() => {
      findButtonByText(renderer!, 'auth_files.paste_button').props.onClick?.();
    });

    const textarea = renderer!.root.findByProps({ id: 'auth-json-paste-content' });
    act(() => {
      textarea.props.onChange({ target: { value: sessionInput } });
    });

    mocks.connectionStatus = 'disconnected';
    act(() => {
      renderer!.update(<AuthFilesPage />);
    });

    await act(async () => {
      await findButtonByText(renderer!, 'auth_files.paste_save_button').props.onClick?.();
    });

    expect(mocks.saveJsonObject).not.toHaveBeenCalled();
    expect(renderer!.root.findAllByProps({ id: 'auth-json-paste-content' })).toHaveLength(1);

    await act(async () => {
      renderer!.unmount();
    });
  });
});
