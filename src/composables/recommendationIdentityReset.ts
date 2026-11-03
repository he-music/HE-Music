import { getCurrentScope, onScopeDispose, ref, watch } from "vue";

export interface RecommendationOwner {
  readonly accountId: string;
  readonly epoch: number;
}

export interface RecommendationIdentityResetDependencies {
  reset: (signal: AbortSignal) => Promise<unknown>;
  currentOwner: () => RecommendationOwner | undefined;
  showSuccess: () => void;
  showUnknownResult: () => void;
}

const sameOwner = (left: RecommendationOwner | undefined, right: RecommendationOwner) =>
  left?.accountId === right.accountId && left.epoch === right.epoch;

export const createRecommendationIdentityReset = (
  dependencies: RecommendationIdentityResetDependencies,
) => {
  const loading = ref(false);
  let pending: { owner: RecommendationOwner; controller: AbortController } | undefined;
  let disposed = false;
  const stop = watch(
    dependencies.currentOwner,
    (owner) => {
      if (pending && !sameOwner(owner, pending.owner)) pending.controller.abort();
    },
    { flush: "sync" },
  );
  const reset = async (owner = dependencies.currentOwner()) => {
    if (disposed || loading.value || !owner || !sameOwner(dependencies.currentOwner(), owner))
      return;
    const attempt = { owner, controller: new AbortController() };
    pending = attempt;
    loading.value = true;
    const isCurrent = () =>
      !disposed &&
      !attempt.controller.signal.aborted &&
      sameOwner(dependencies.currentOwner(), owner);
    try {
      await dependencies.reset(attempt.controller.signal);
      if (!isCurrent()) return;
      dependencies.showSuccess();
    } catch {
      if (isCurrent()) dependencies.showUnknownResult();
    } finally {
      if (pending === attempt) pending = undefined;
      loading.value = false;
    }
  };
  const dispose = () => {
    disposed = true;
    pending?.controller.abort();
    stop();
  };
  if (getCurrentScope()) onScopeDispose(dispose);
  return { loading, reset, dispose };
};
