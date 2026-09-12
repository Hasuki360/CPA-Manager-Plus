import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountProcessingPolicy } from '@/services/api/usageService';

const mocks = vi.hoisted(() => ({
  managementKey: 'test-management-key',
  managerServiceBase: 'https://manager.test',
  getPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  showNotification: vi.fn(),
  navigate: vi.fn(),
  t: (key: string, options?: Record<string, unknown>) => {
    if (options?.returnObjects) return [];
    if (key === 'accountPolicy.charityModelMonitor_state_sync_value') {
      return `${key}:${options?.changed}/${options?.total},${options?.errors}`;
    }
    return key;
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/hooks/usePanelFeatureAvailability', () => ({
  usePanelFeatureAvailability: () => ({ managerServiceBase: mocks.managerServiceBase }),
}));
vi.mock('@/stores', () => ({
  useAuthStore: (selector: (state: { managementKey: string }) => unknown) =>
    selector({ managementKey: mocks.managementKey }),
  useNotificationStore: () => ({ showNotification: mocks.showNotification }),
}));
vi.mock('@/services/api/usageService', () => ({
  usageServiceApi: {
    getAccountProcessingPolicy: mocks.getPolicy,
    updateAccountProcessingPolicy: mocks.updatePolicy,
  },
  getUsageServiceErrorCode: () => undefined,
}));
vi.mock('@/components/ui/Modal', () => ({ Modal: () => null }));

import { AccountProcessingPolicySection } from './AccountProcessingPolicySection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const policy = (overrides: Partial<AccountProcessingPolicy> = {}): AccountProcessingPolicy => {
  const capability = { enabled: true, envKey: 'TEST_ENABLED', configFileKey: 'test-enabled' };
  return {
    source: 'db',
    codexQuotaCooldown: capability,
    antigravityQuotaCooldown: capability,
    antigravityReverseProxy: capability,
    authIssueQueue: capability,
    authIssueAutoDisable: capability,
    charityModelMonitor: capability,
    charityModelMonitorIntervalMinutes: 1440,
    charityModelMonitorSites: [
      {
        key: 'codex-headers',
        name: 'Codex headers',
        enabled: true,
        codexProviderSection: 'codex-api-key',
        codexBaseUrl: '*',
        syncCodexHeadersOnly: true,
      },
    ],
    charityModelMonitorState: {
      lastCodexCliVersion: '0.100.0',
      lastCheck: '2026-09-08T00:00:00Z',
      lastProviderSync: [],
    },
    ...overrides,
  };
};

let renderer: ReactTestRenderer | undefined;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const mount = async () => {
  await act(async () => {
    renderer = create(<AccountProcessingPolicySection />);
  });
  return renderer!;
};

const text = () =>
  renderer!.root
    .findAll((node) => typeof node.type === 'string')
    .flatMap((node) => node.children.filter((child) => typeof child === 'string'))
    .join('\n');

const button = (label: string) => {
  const result = renderer!.root
    .findAllByType('button')
    .find((node) => node.findAllByType('span').some((span) => span.children.includes(label)));
  expect(result, `button ${label}`).toBeDefined();
  return result!;
};

const click = async (label: string) => {
  await act(async () => button(label).props.onClick());
};

describe('AccountProcessingPolicySection request headers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.managementKey = 'test-management-key';
    mocks.managerServiceBase = 'https://manager.test';
    mocks.getPolicy.mockResolvedValue(policy());
    mocks.updatePolicy.mockResolvedValue(policy({ charityModelMonitorState: undefined }));
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.useRealTimers();
  });

  it('keeps the last header sync state when the config PATCH omits it', async () => {
    await mount();
    expect(text()).toContain('0.100.0');

    await click('accountPolicy.charity_config_save');

    expect(mocks.updatePolicy).toHaveBeenCalledWith('https://manager.test', 'test-management-key', {
      charityModelMonitorIntervalMinutes: 1440,
      charityModelMonitorSites: policy().charityModelMonitorSites,
    });
    expect(text()).toContain('0.100.0');
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'accountPolicy.charity_config_saved',
      'success'
    );
  });

  it('keeps header sync state after toggling the legacy monitor switch', async () => {
    const updated = policy({ charityModelMonitorState: undefined });
    updated.charityModelMonitor = { ...updated.charityModelMonitor, enabled: false };
    mocks.updatePolicy.mockResolvedValue(updated);
    await mount();

    await act(async () => {
      renderer!.root
        .findByProps({ 'aria-label': 'accountPolicy.charityModelMonitor_toggle' })
        .props.onChange({ target: { checked: false } });
    });

    expect(mocks.updatePolicy).toHaveBeenCalledWith('https://manager.test', 'test-management-key', {
      charityModelMonitorEnabled: false,
    });
    expect(
      renderer!.root.findByProps({ 'aria-label': 'accountPolicy.charityModelMonitor_toggle' }).props
        .checked
    ).toBe(false);
    expect(text()).toContain('0.100.0');
  });

  it('quietly refreshes header state after a save without discarding a new draft', async () => {
    vi.useFakeTimers();
    const saved = policy();
    mocks.getPolicy
      .mockResolvedValueOnce(saved)
      .mockResolvedValue(policy({ charityModelMonitorState: { lastCodexCliVersion: '0.101.0' } }));
    await mount();
    await click('accountPolicy.charity_config_save');
    await act(async () => {
      renderer!.root.findByProps({ type: 'number' }).props.onChange({ target: { value: '90' } });
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mocks.getPolicy.mock.calls.length).toBeGreaterThan(1);
    expect(mocks.getPolicy.mock.calls.length).toBeLessThanOrEqual(4);
    expect(text()).toContain('0.101.0');
    expect(renderer!.root.findByProps({ type: 'number' }).props.value).toBe('90');
    expect(mocks.showNotification).toHaveBeenCalledTimes(1);

    const calls = mocks.getPolicy.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.getPolicy).toHaveBeenCalledTimes(calls);
  });

  it('refreshes runtime state after a monitor toggle too', async () => {
    vi.useFakeTimers();
    await mount();
    await act(async () => {
      renderer!.root
        .findByProps({ 'aria-label': 'accountPolicy.charityModelMonitor_toggle' })
        .props.onChange({ target: { checked: false } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.getPolicy.mock.calls.length).toBeGreaterThan(1);
  });

  it.each(['4', '10081', '5.5', '60minutes', '1e2', '', 'Infinity'])(
    'rejects invalid interval %j before sending any PATCH',
    async (value) => {
      await mount();
      await act(async () => {
        renderer!.root.findByProps({ type: 'number' }).props.onChange({ target: { value } });
      });
      await click('accountPolicy.charity_config_save');
      expect(mocks.updatePolicy).not.toHaveBeenCalled();
      expect(text()).toContain('accountPolicy.charity_interval_invalid');
    }
  );

  it.each(['5', '10080'])(
    'accepts boundary interval %s and an explicit empty site list',
    async (value) => {
      await mount();
      await act(async () => {
        renderer!.root.findByProps({ type: 'number' }).props.onChange({ target: { value } });
        renderer!.root.findByType('textarea').props.onChange({ target: { value: '[]' } });
      });
      await click('accountPolicy.charity_config_save');
      expect(mocks.updatePolicy).toHaveBeenCalledWith(
        'https://manager.test',
        'test-management-key',
        { charityModelMonitorIntervalMinutes: Number(value), charityModelMonitorSites: [] }
      );
    }
  );

  it.each([
    { matchedProviders: 7, updatedProviders: 3, expected: '3/7' },
    { matchedProviders: 0, updatedProviders: 0, expected: '0/0' },
    {
      expected:
        'accountPolicy.charityModelMonitor_state_unknown/accountPolicy.charityModelMonitor_state_unknown',
    },
  ])(
    'uses real provider counts, including zero and legacy unknown: $expected',
    async ({ expected, ...counts }) => {
      mocks.getPolicy.mockResolvedValue(
        policy({
          charityModelMonitorState: {
            lastProviderSync: [
              {
                site: 'codex-headers',
                label: 'Codex headers',
                section: 'codex-api-key',
                provider: '*',
                desiredEnabled: true,
                headersChanged: true,
                ...counts,
              },
            ],
            lastProviderError: ['one site failed'],
          },
        })
      );
      await mount();
      expect(text()).toContain(`accountPolicy.charityModelMonitor_state_sync_value:${expected},1`);
    }
  );

  it('isolates unsaved config drafts when the connection changes in the same component', async () => {
    await mount();
    await act(async () => {
      renderer!.root.findByProps({ type: 'number' }).props.onChange({ target: { value: '60' } });
      renderer!.root
        .findByType('textarea')
        .props.onChange({ target: { value: '[{"key":"old-draft"}]' } });
    });
    mocks.managementKey = 'other-management-key';
    mocks.managerServiceBase = 'https://other-manager.test';
    mocks.getPolicy.mockResolvedValue(
      policy({
        charityModelMonitorIntervalMinutes: 120,
        charityModelMonitorSites: [],
        charityModelMonitorState: { lastCodexCliVersion: '0.200.0' },
      })
    );
    await act(async () => renderer!.update(<AccountProcessingPolicySection />));

    expect(renderer!.root.findByProps({ type: 'number' }).props.value).toBe('120');
    expect(renderer!.root.findByType('textarea').props.value).toBe('[]');
    expect(text()).toContain('0.200.0');
    expect(text()).not.toContain('0.100.0');
  });

  it('ignores an older GET that completes after a config save', async () => {
    const olderRead = deferred<AccountProcessingPolicy>();
    await mount();
    mocks.getPolicy.mockReturnValueOnce(olderRead.promise);
    await click('accountPolicy.refresh');
    mocks.updatePolicy.mockResolvedValue(
      policy({
        charityModelMonitorIntervalMinutes: 120,
        charityModelMonitorState: { lastCodexCliVersion: '0.200.0' },
      })
    );
    await act(async () => {
      renderer!.root.findByProps({ type: 'number' }).props.onChange({ target: { value: '120' } });
    });
    await click('accountPolicy.charity_config_save');
    await act(async () => olderRead.resolve(policy()));

    expect(renderer!.root.findByProps({ type: 'number' }).props.value).toBe('120');
    expect(text()).toContain('0.200.0');
    expect(text()).not.toContain('0.100.0');
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a save that %s after switching connections',
    async (outcome) => {
      const oldSave = deferred<AccountProcessingPolicy>();
      await mount();
      mocks.updatePolicy.mockReturnValueOnce(oldSave.promise);
      await click('accountPolicy.charity_config_save');
      mocks.managementKey = 'new-management-key';
      mocks.getPolicy.mockResolvedValue(
        policy({
          charityModelMonitorState: { lastCodexCliVersion: '0.200.0' },
        })
      );
      await act(async () => renderer!.update(<AccountProcessingPolicySection />));
      await act(async () => {
        if (outcome === 'resolve') oldSave.resolve(policy());
        else oldSave.reject(new Error('old connection failed'));
      });

      expect(text()).toContain('0.200.0');
      expect(mocks.showNotification).not.toHaveBeenCalled();
    }
  );

  it('does not let a delayed background GET overwrite a newer manual refresh', async () => {
    vi.useFakeTimers();
    const delayed = deferred<AccountProcessingPolicy>();
    await mount();
    await click('accountPolicy.charity_config_save');
    mocks.getPolicy.mockReturnValueOnce(delayed.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    mocks.getPolicy.mockResolvedValue(
      policy({
        charityModelMonitorState: { lastCodexCliVersion: '0.200.0' },
      })
    );
    await click('accountPolicy.refresh');
    await act(async () => delayed.resolve(policy()));
    expect(text()).toContain('0.200.0');
    expect(text()).not.toContain('0.100.0');
  });

  it.each(['config', 'toggle'])('blocks competing actions during a %s save', async (kind) => {
    const pending = deferred<AccountProcessingPolicy>();
    await mount();
    mocks.updatePolicy.mockReturnValueOnce(pending.promise);
    if (kind === 'config') await click('accountPolicy.charity_config_save');
    else
      await act(async () => {
        renderer!.root
          .findByProps({ 'aria-label': 'accountPolicy.charityModelMonitor_toggle' })
          .props.onChange({ target: { checked: false } });
      });

    expect(button('accountPolicy.refresh').props.disabled).toBe(true);
    expect(button('accountPolicy.charity_config_save').props.disabled).toBe(true);
    expect(
      renderer!.root
        .findAllByType('input')
        .filter((node) => node.props.type === 'checkbox')
        .every((node) => node.props.disabled)
    ).toBe(true);
    await click('accountPolicy.charity_config_save');
    await click('accountPolicy.refresh');
    expect(mocks.updatePolicy).toHaveBeenCalledTimes(1);
    expect(mocks.getPolicy).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(policy()));
    expect(button('accountPolicy.refresh').props.disabled).toBe(false);
    expect(button('accountPolicy.charity_config_save').props.disabled).toBe(false);
  });

  it('keeps a successful save successful when quiet status reads fail', async () => {
    vi.useFakeTimers();
    await mount();
    mocks.getPolicy.mockRejectedValue(new Error('status unavailable'));
    await click('accountPolicy.charity_config_save');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.getPolicy).toHaveBeenCalledTimes(3);
    expect(text()).toContain('0.100.0');
    expect(mocks.showNotification.mock.calls).toEqual([
      ['accountPolicy.charity_config_saved', 'success'],
    ]);
    expect(renderer!.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
  });

  it('cleans up scheduled background reads on unmount', async () => {
    vi.useFakeTimers();
    await mount();
    await click('accountPolicy.charity_config_save');
    act(() => renderer!.unmount());
    renderer = undefined;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.getPolicy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
