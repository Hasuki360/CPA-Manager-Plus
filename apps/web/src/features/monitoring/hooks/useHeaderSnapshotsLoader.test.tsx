import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  monitoringAnalyticsApi,
  type UsageHeaderSnapshot,
  type UsageHeaderSnapshotsResponse,
} from '@/services/api/usageService';
import { useHeaderSnapshotsLoader } from './useHeaderSnapshotsLoader';

vi.mock('@/services/api/usageService', () => ({
  monitoringAnalyticsApi: {
    getHeaderSnapshots: vi.fn(),
  },
}));

const getHeaderSnapshotsMock = vi.mocked(monitoringAnalyticsApi.getHeaderSnapshots);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const response = (eventHash: string): UsageHeaderSnapshotsResponse => ({
  generated_at_ms: 3,
  from_ms: 1,
  to_ms: 2,
  items: [{ event_hash: eventHash, timestamp_ms: 2 }],
});

describe('useHeaderSnapshotsLoader', () => {
  let renderer: ReactTestRenderer | null = null;
  let load: (() => Promise<void>) | null = null;
  const observedItems: UsageHeaderSnapshot[][] = [];

  beforeAll(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    load = null;
    observedItems.length = 0;
    getHeaderSnapshotsMock.mockReset();
  });

  function Harness({ serviceBase }: { serviceBase: string }) {
    const currentLoad = useHeaderSnapshotsLoader({
      serviceBase,
      managementKey: 'management-key',
      onItems: (items) => observedItems.push(items),
    });
    useEffect(() => {
      load = currentLoad;
      return () => {
        if (load === currentLoad) load = null;
      };
    }, [currentLoad]);
    return null;
  }

  it('deduplicates the same request and ignores a stale response after the service changes', async () => {
    const first = deferred<UsageHeaderSnapshotsResponse>();
    const second = deferred<UsageHeaderSnapshotsResponse>();
    getHeaderSnapshotsMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    await act(async () => {
      renderer = create(<Harness serviceBase="http://manager-a.local" />);
    });

    let firstLoad!: Promise<void>;
    let duplicateLoad!: Promise<void>;
    act(() => {
      firstLoad = load!();
      duplicateLoad = load!();
    });
    expect(getHeaderSnapshotsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer?.update(<Harness serviceBase="http://manager-b.local" />);
    });
    let secondLoad!: Promise<void>;
    act(() => {
      secondLoad = load!();
    });
    expect(getHeaderSnapshotsMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(response('stale'));
      await Promise.all([firstLoad, duplicateLoad]);
    });
    expect(observedItems).toEqual([[]]);

    await act(async () => {
      second.resolve(response('current'));
      await secondLoad;
    });
    expect(observedItems).toEqual([[], [{ event_hash: 'current', timestamp_ms: 2 }]]);
  });

  it('clears snapshots from the previous service when the replacement request fails', async () => {
    getHeaderSnapshotsMock
      .mockResolvedValueOnce(response('manager-a'))
      .mockRejectedValueOnce(new Error('manager-b unavailable'));

    await act(async () => {
      renderer = create(<Harness serviceBase="http://manager-a.local" />);
    });
    await act(async () => {
      await load!();
    });
    expect(observedItems).toEqual([[{ event_hash: 'manager-a', timestamp_ms: 2 }]]);

    await act(async () => {
      renderer?.update(<Harness serviceBase="http://manager-b.local" />);
    });
    await act(async () => {
      await load!();
    });

    expect(observedItems).toEqual([[{ event_hash: 'manager-a', timestamp_ms: 2 }], []]);
  });

  it('allows a failed request to be retried for the same service', async () => {
    getHeaderSnapshotsMock
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(response('recovered'));

    await act(async () => {
      renderer = create(<Harness serviceBase="http://manager.local" />);
    });
    await act(async () => {
      await load!();
      await load!();
    });

    expect(getHeaderSnapshotsMock).toHaveBeenCalledTimes(2);
    expect(observedItems).toEqual([[{ event_hash: 'recovered', timestamp_ms: 2 }]]);
  });

  it('ignores a response that resolves after the consumer unmounts', async () => {
    const request = deferred<UsageHeaderSnapshotsResponse>();
    getHeaderSnapshotsMock.mockReturnValueOnce(request.promise);

    await act(async () => {
      renderer = create(<Harness serviceBase="http://manager.local" />);
    });
    let pendingLoad!: Promise<void>;
    act(() => {
      pendingLoad = load!();
    });
    await act(async () => {
      renderer?.unmount();
      renderer = null;
    });
    await act(async () => {
      request.resolve(response('late'));
      await pendingLoad;
    });

    expect(observedItems).toEqual([]);
  });
});
