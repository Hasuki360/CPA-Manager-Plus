import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  antigravitySubscriptionApi,
  type AntigravitySubscriptionSummary,
} from '@/services/api';
import type { AuthFileItem } from '@/types';
import {
  getStatusFromError,
  isAntigravityFile,
  isRuntimeOnlyAuthFile,
  normalizeAuthIndex,
} from '@/utils/quota';

export type AntigravitySubscriptionState = {
  status: 'idle' | 'loading' | 'success' | 'error';
  data?: AntigravitySubscriptionSummary;
  error?: string;
  errorStatus?: number;
};

type SubscriptionTarget = {
  file: AuthFileItem;
  authIndex: string | null;
  cacheKey: string;
};

type SubscriptionResult =
  | {
      name: string;
      cacheKey: string;
      status: 'success';
      data: AntigravitySubscriptionSummary;
    }
  | {
      name: string;
      cacheKey: string;
      status: 'error';
      error: string;
      errorStatus?: number;
    };

const successfulSubscriptionCache = new Map<string, AntigravitySubscriptionSummary>();
const inFlightSubscriptionRequests = new Map<
  string,
  Promise<AntigravitySubscriptionSummary | null>
>();

const buildCacheKey = (authIndex: string | null): string => authIndex ?? '';

const getCachedSubscriptionState = (
  cacheKey: string
): AntigravitySubscriptionState | undefined => {
  const data = successfulSubscriptionCache.get(cacheKey);
  return data ? { status: 'success', data } : undefined;
};

const requestAntigravitySubscription = (authIndex: string, cacheKey: string) => {
  const cached = successfulSubscriptionCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  const inFlight = inFlightSubscriptionRequests.get(cacheKey);
  if (inFlight) return inFlight;

  const request = antigravitySubscriptionApi
    .get(authIndex)
    .then((data) => {
      if (data) {
        successfulSubscriptionCache.set(cacheKey, data);
      }
      return data;
    })
    .finally(() => {
      inFlightSubscriptionRequests.delete(cacheKey);
    });

  inFlightSubscriptionRequests.set(cacheKey, request);
  return request;
};

export function useAntigravitySubscriptions(files: AuthFileItem[]) {
  const { t } = useTranslation();
  const [subscriptions, setSubscriptions] = useState<Record<string, AntigravitySubscriptionState>>(
    {}
  );
  const targets = useMemo(
    () =>
      files.reduce<SubscriptionTarget[]>((result, file) => {
        if (!isAntigravityFile(file) || isRuntimeOnlyAuthFile(file)) return result;
        const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
        result.push({
          file,
          authIndex,
          cacheKey: buildCacheKey(authIndex),
        });
        return result;
      }, []),
    [files]
  );

  useEffect(() => {
    const targetsToLoad = targets.filter((target) => {
      if (!target.authIndex) return true;
      return !successfulSubscriptionCache.has(target.cacheKey);
    });
    if (targetsToLoad.length === 0) return;

    let cancelled = false;
    const requestTargets = targetsToLoad.filter((target) => target.authIndex);

    void (async () => {
      if (cancelled) return;

      setSubscriptions((prev) => {
        const next = { ...prev };
        targetsToLoad.forEach((target) => {
          const cached = getCachedSubscriptionState(target.cacheKey);
          if (cached) {
            next[target.file.name] = cached;
          } else if (target.authIndex) {
            next[target.file.name] = { status: 'loading' };
          } else {
            next[target.file.name] = {
              status: 'error',
              error: t('antigravity_subscription.missing_auth_index'),
            };
          }
        });
        return next;
      });

      if (requestTargets.length === 0) return;

      const results = await Promise.all(
        requestTargets.map(async (target): Promise<SubscriptionResult> => {
          try {
            const data = await requestAntigravitySubscription(
              target.authIndex as string,
              target.cacheKey
            );
            if (!data) {
              return {
                name: target.file.name,
                cacheKey: target.cacheKey,
                status: 'error',
                error: t('antigravity_subscription.empty_data'),
              };
            }
            return {
              name: target.file.name,
              cacheKey: target.cacheKey,
              status: 'success',
              data,
            };
          } catch (err: unknown) {
            return {
              name: target.file.name,
              cacheKey: target.cacheKey,
              status: 'error',
              error: err instanceof Error ? err.message : t('common.unknown_error'),
              errorStatus: getStatusFromError(err),
            };
          }
        })
      );

      if (cancelled) return;

      setSubscriptions((prev) => {
        const next = { ...prev };
        results.forEach((result) => {
          if (result.status === 'success') {
            next[result.name] = { status: 'success', data: result.data };
          } else {
            next[result.name] = {
              status: 'error',
              error: result.error,
              errorStatus: result.errorStatus,
            };
          }
        });
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [t, targets]);

  return useMemo(() => {
    const current: Record<string, AntigravitySubscriptionState> = {};
    targets.forEach((target) => {
      const cached = getCachedSubscriptionState(target.cacheKey);
      if (cached) {
        current[target.file.name] = cached;
        return;
      }
      const existing = subscriptions[target.file.name];
      if (existing) {
        current[target.file.name] = existing;
      }
    });
    return current;
  }, [subscriptions, targets]);
}
