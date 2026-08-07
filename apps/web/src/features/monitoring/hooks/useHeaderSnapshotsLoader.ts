import { useCallback, useEffect, useRef } from 'react';
import { monitoringAnalyticsApi, type UsageHeaderSnapshot } from '@/services/api/usageService';

interface UseHeaderSnapshotsLoaderOptions {
  serviceBase: string;
  managementKey: string;
  onItems: (items: UsageHeaderSnapshot[]) => void;
}

interface HeaderSnapshotsRequest {
  serviceBase: string;
  managementKey: string;
  promise: Promise<void>;
}

export function useHeaderSnapshotsLoader({
  serviceBase,
  managementKey,
  onItems,
}: UseHeaderSnapshotsLoaderOptions) {
  const inFlightRef = useRef<HeaderSnapshotsRequest | null>(null);
  const onItemsRef = useRef(onItems);
  const scopeVersionRef = useRef(0);
  const initializedScopeRef = useRef(false);
  onItemsRef.current = onItems;

  useEffect(() => {
    scopeVersionRef.current += 1;
    inFlightRef.current = null;
    if (initializedScopeRef.current) {
      onItemsRef.current([]);
    } else {
      initializedScopeRef.current = true;
    }
    return () => {
      scopeVersionRef.current += 1;
      inFlightRef.current = null;
    };
  }, [managementKey, serviceBase]);

  return useCallback(async () => {
    if (!serviceBase) {
      inFlightRef.current = null;
      onItemsRef.current([]);
      return;
    }
    const currentRequest = inFlightRef.current;
    if (
      currentRequest?.serviceBase === serviceBase &&
      currentRequest.managementKey === managementKey
    ) {
      await currentRequest.promise;
      return;
    }

    const scopeVersion = scopeVersionRef.current;
    const inFlight: HeaderSnapshotsRequest = {
      serviceBase,
      managementKey,
      promise: Promise.resolve(),
    };
    inFlight.promise = (async () => {
      try {
        const response = await monitoringAnalyticsApi.getHeaderSnapshots(
          serviceBase,
          managementKey,
          { days: 30, limit: 1000 }
        );
        if (
          inFlightRef.current === inFlight &&
          scopeVersionRef.current === scopeVersion
        ) {
          onItemsRef.current(response.items ?? []);
        }
      } catch {
        // Preserve the last successful snapshot when a refresh fails.
      } finally {
        if (inFlightRef.current === inFlight) {
          inFlightRef.current = null;
        }
      }
    })();
    inFlightRef.current = inFlight;
    await inFlight.promise;
  }, [managementKey, serviceBase]);
}
