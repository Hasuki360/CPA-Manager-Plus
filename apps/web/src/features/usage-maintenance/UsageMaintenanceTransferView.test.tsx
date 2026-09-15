import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageImportSession, UsageImportSessionList } from '@/services/api/usageService';
import {
  UsageImportFailedError,
  type UsageImportProgress,
} from '@/features/monitoring/services/usageImportSession';
import { UsageMaintenanceTransferView } from './UsageMaintenanceTransferView';

const { mocks } = vi.hoisted(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  return {
    mocks: {
      listUsageImportSessions: vi.fn(),
      exportUsage: vi.fn(),
      showNotification: vi.fn(),
      showConfirmation: vi.fn(),
      uploadUsageImportFile: vi.fn(),
      cancelUsageImportFile: vi.fn(),
      downloadBlob: vi.fn(),
      t: (key: string, options?: Record<string, unknown>) => {
        let value = typeof options?.defaultValue === 'string' ? options.defaultValue : key;
        for (const [name, replacement] of Object.entries(options ?? {})) {
          if (name !== 'defaultValue') value = value.split(`{{${name}}}`).join(String(replacement));
        }
        return value;
      },
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: mocks.t,
  }),
}));

vi.mock('@/stores', () => ({
  useNotificationStore: () => ({
    showNotification: mocks.showNotification,
    showConfirmation: mocks.showConfirmation,
  }),
}));

vi.mock('@/services/api/usageService', () => ({
  getUsageServiceErrorCode: (error: unknown) =>
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '',
  usageServiceApi: {
    listUsageImportSessions: mocks.listUsageImportSessions,
    exportUsage: mocks.exportUsage,
  },
}));

vi.mock('@/features/monitoring/services/usageImportSession', () => ({
  cancelUsageImportFile: mocks.cancelUsageImportFile,
  isUsageImportCancelledError: () => false,
  isUsageImportPausedError: () => false,
  UsageImportFailedError: class UsageImportFailedError extends Error {
    retryable = false;

    constructor(_session?: unknown) {
      super('usage import failed');
    }
  },
  uploadUsageImportFile: mocks.uploadUsageImportFile,
}));

vi.mock('@/utils/download', () => ({
  downloadBlob: mocks.downloadBlob,
}));

const sessionList = (overrides: Partial<UsageImportSessionList> = {}): UsageImportSessionList => ({
  sessions: [],
  total: 0,
  status_counts: {},
  active_sessions: 0,
  max_sessions: 2,
  chunk_size_bytes: 4 * 1024 * 1024,
  disk_quota_bytes: 16 * 1024 * 1024 * 1024,
  ttl_seconds: 24 * 60 * 60,
  ...overrides,
});

const getText = (node: ReactTestInstance): string =>
  node.children
    .map((child) =>
      typeof child === 'string' || typeof child === 'number' ? String(child) : getText(child)
    )
    .join('');

const findButton = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAllByType('button').find((button) => getText(button).includes(text));

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const renderView = async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <UsageMaintenanceTransferView
        serviceBase="http://manager.local"
        managementKey="manager-key"
      />
    );
  });
  await flush();
  return renderer;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listUsageImportSessions.mockResolvedValue(sessionList());
  mocks.uploadUsageImportFile.mockResolvedValue({
    format: 'jsonl',
    added: 3,
    skipped: 1,
    total: 4,
    failed: 0,
    unsupported: 0,
    warnings: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('UsageMaintenanceTransferView', () => {
  it('loads session limits and downloads a sanitized export', async () => {
    mocks.exportUsage.mockResolvedValue({
      filename: 'usage-events.jsonl',
      blob: new Blob(['{"event_hash":"safe"}\n'], { type: 'application/x-ndjson' }),
    });
    const renderer = await renderView();

    expect(getText(renderer.root)).toContain('16.00 GB');
    const exportButton = findButton(renderer, 'Export sanitized JSONL');
    expect(exportButton).toBeDefined();
    await act(async () => {
      await exportButton?.props.onClick();
    });

    expect(mocks.exportUsage).toHaveBeenCalledWith('http://manager.local', 'manager-key');
    expect(mocks.downloadBlob).toHaveBeenCalledWith({
      filename: 'usage-events.jsonl',
      blob: expect.any(Blob),
    });
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'Sanitized usage JSONL export downloaded.',
      'success'
    );
    act(() => renderer.unmount());
  });

  it('keeps server-provided upload limits available in technical details', async () => {
    mocks.listUsageImportSessions.mockResolvedValueOnce(
      sessionList({ chunk_size_bytes: 7 * 1024 * 1024 })
    );
    const renderer = await renderView();

    const details = renderer.root.findByType('details');
    expect(details.props.open).not.toBe(true);
    expect(getText(details)).toContain('7.00 MB');
    expect(getText(renderer.root)).toContain('Server import quota: 16.00 GB');
    act(() => renderer.unmount());
  });

  it('shows a dedicated file-mismatch message and never starts a chunk upload', async () => {
    mocks.uploadUsageImportFile.mockRejectedValueOnce({
      code: 'usage_import_session_file_mismatch',
      message: 'raw server mismatch',
    });
    const renderer = await renderView();
    const input = renderer.root.findByProps({ type: 'file' });
    const file = new File(['different prefix'], 'history.jsonl');

    act(() => input.props.onChange({ target: { files: [file], value: 'history.jsonl' } }));
    const confirmation = mocks.showConfirmation.mock.calls[0][0] as {
      onConfirm: () => Promise<void>;
    };
    await act(async () => {
      await confirmation.onConfirm();
    });

    expect(getText(renderer.root)).toContain(
      'The selected file does not match the uploaded session prefix. Choose the original file or start a new import.'
    );
    expect(mocks.uploadUsageImportFile).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('confirms a supported file before starting the resumable import', async () => {
    const renderer = await renderView();
    const input = renderer.root.findByProps({ type: 'file' });
    const file = new File(['{"event_hash":"safe"}\n'], 'history.jsonl', {
      type: 'application/x-ndjson',
    });

    act(() => input.props.onChange({ target: { files: [file], value: 'history.jsonl' } }));
    const confirmation = mocks.showConfirmation.mock.calls[0]?.[0] as {
      onConfirm: () => Promise<void>;
    };
    expect(confirmation).toBeDefined();
    expect(confirmation).toHaveProperty('onConfirm');

    await act(async () => {
      await confirmation.onConfirm();
    });

    expect(mocks.uploadUsageImportFile).toHaveBeenCalledWith(
      expect.objectContaining({
        base: 'http://manager.local',
        managementKey: 'manager-key',
        file,
        sessionId: undefined,
      })
    );
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'Import complete: added 3, skipped 1, failed 0.',
      'success'
    );
    act(() => renderer.unmount());
  });

  it('maps session-list errors to safe localized copy', async () => {
    mocks.listUsageImportSessions.mockRejectedValueOnce({
      code: 'usage_import_session_quota_exceeded',
    });
    const renderer = await renderView();

    expect(getText(renderer.root)).toContain(
      'The Manager Server import disk quota is currently reserved by other sessions.'
    );
    expect(getText(renderer.root)).not.toContain('usage_import_session_quota_exceeded');
    act(() => renderer.unmount());
  });

  it('does not offer retry after a non-retryable processing failure', async () => {
    mocks.uploadUsageImportFile.mockRejectedValueOnce(
      new UsageImportFailedError({} as UsageImportSession)
    );
    const renderer = await renderView();
    const input = renderer.root.findByProps({ type: 'file' });
    const file = new File(['{}\n'], 'history.jsonl');

    act(() => input.props.onChange({ target: { files: [file], value: 'history.jsonl' } }));
    const confirmation = mocks.showConfirmation.mock.calls[0][0] as {
      onConfirm: () => Promise<void>;
    };
    await act(async () => {
      await confirmation.onConfirm();
    });

    expect(findButton(renderer, 'Resume upload')).toBeUndefined();
    act(() => renderer.unmount());
  });

  it('aborts an in-flight session-list request on unmount', async () => {
    const pending = deferred<UsageImportSessionList>();
    let signal: AbortSignal | undefined;
    mocks.listUsageImportSessions.mockImplementationOnce(
      (_base: string, _key: string, _options: unknown, requestSignal: AbortSignal) => {
        signal = requestSignal;
        return pending.promise;
      }
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <UsageMaintenanceTransferView
          serviceBase="http://manager.local"
          managementKey="manager-key"
        />
      );
      await Promise.resolve();
    });

    expect(signal?.aborted).toBe(false);
    act(() => renderer.unmount());
    expect(signal?.aborted).toBe(true);
    pending.resolve(sessionList());
    await pending.promise;
  });

  it('keeps a confirmed cancellation when the aborted upload reports a late pause', async () => {
    const pending = deferred<{
      format: string;
      added: number;
      total: number;
      skipped: number;
      failed: number;
    }>();
    const file = new File(['{}\n'], 'history.jsonl');
    const progress: UsageImportProgress = {
      filename: file.name,
      sessionId: 'cancelled-session',
      phase: 'uploading',
      status: 'uploading',
      uploadedBytes: 0,
      totalBytes: file.size,
      percent: 0,
    };
    let reportProgress!: (value: UsageImportProgress) => void;
    mocks.uploadUsageImportFile.mockImplementationOnce(
      (options: { onProgress: typeof reportProgress }) => {
        reportProgress = options.onProgress;
        reportProgress(progress);
        return pending.promise;
      }
    );
    mocks.cancelUsageImportFile.mockResolvedValueOnce({
      id: progress.sessionId,
      filename: file.name,
      status: 'cancelled',
      size_bytes: file.size,
      received_bytes: 0,
      chunk_size_bytes: file.size,
      created_at_ms: 1,
      updated_at_ms: 2,
      expires_at_ms: 3,
    });
    const renderer = await renderView();
    act(() =>
      renderer.root
        .findByProps({ type: 'file' })
        .props.onChange({ target: { files: [file], value: file.name } })
    );
    act(() => mocks.showConfirmation.mock.calls[0][0].onConfirm());
    await act(async () => findButton(renderer, 'usage_stats.import_cancel')!.props.onClick());
    expect(getText(renderer.root)).toContain('usage_stats.import_phase_cancelled');

    act(() => reportProgress({ ...progress, phase: 'paused' }));
    expect(getText(renderer.root)).toContain('usage_stats.import_phase_cancelled');
    expect(findButton(renderer, 'usage_stats.import_resume')).toBeUndefined();

    act(() => renderer.unmount());
    pending.resolve({ format: 'jsonl', added: 0, total: 0, skipped: 0, failed: 0 });
    await flush();
  });
});

describe('maintenance import context lifetime', () => {
  it('does not execute a saved import confirmation after unmount', async () => {
    const renderer = await renderView();
    const file = new File(['{}'], 'history.jsonl');
    act(() =>
      renderer.root
        .findByProps({ type: 'file' })
        .props.onChange({ target: { files: [file], value: file.name } })
    );
    const confirmation = mocks.showConfirmation.mock.calls[0][0];
    act(() => renderer.unmount());
    await confirmation.onConfirm();
    expect(mocks.uploadUsageImportFile).not.toHaveBeenCalled();
  });

  it('rejects an old import confirmation after the service changes and changes back', async () => {
    const renderer = await renderView();
    const file = new File(['{}'], 'history.jsonl');
    act(() =>
      renderer.root
        .findByProps({ type: 'file' })
        .props.onChange({ target: { files: [file], value: file.name } })
    );
    const confirmation = mocks.showConfirmation.mock.calls[0][0];
    await act(async () => {
      renderer.update(
        <UsageMaintenanceTransferView serviceBase="http://other.local" managementKey="other-key" />
      );
    });
    await act(async () => {
      renderer.update(
        <UsageMaintenanceTransferView
          serviceBase="http://manager.local"
          managementKey="manager-key"
        />
      );
    });
    await confirmation.onConfirm();
    expect(mocks.uploadUsageImportFile).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('does not download a late export after the service changes', async () => {
    const pending = deferred<{ filename: string; blob: Blob }>();
    mocks.exportUsage.mockReturnValueOnce(pending.promise);
    const renderer = await renderView();
    act(() => {
      void findButton(renderer, 'Export sanitized JSONL')!.props.onClick();
    });
    await act(async () => {
      renderer.update(
        <UsageMaintenanceTransferView serviceBase="http://other.local" managementKey="other-key" />
      );
    });
    await act(async () => {
      pending.resolve({ filename: 'old.jsonl', blob: new Blob(['{}']) });
    });
    expect(mocks.downloadBlob).not.toHaveBeenCalled();
    expect(mocks.showNotification).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
