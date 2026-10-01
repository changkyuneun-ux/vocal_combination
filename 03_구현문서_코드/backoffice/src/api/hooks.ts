import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { api, ApiError, type ApiOptions, type Paged } from "./client.ts";
import { useActor } from "../app/actor.ts";

function withParams(path: string, params: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
  const s = q.toString();
  return s ? `${path}${path.includes("?") ? "&" : "?"}${s}` : path;
}

export function useList<T>(key: string, path: string, params?: Record<string, string | undefined>) {
  const actor = useActor();
  const q = useInfiniteQuery<Paged<T>, ApiError, { pages: Paged<T>[] }, unknown[], string | null>({
    queryKey: [key, actor, path, params ?? {}],
    initialPageParam: null,
    queryFn: ({ pageParam }) => api<Paged<T>>("GET", withParams(path, { ...params, after: pageParam ?? undefined }), undefined, { actorOverride: actor }),
    getNextPageParam: (last) => last.next,
  });
  const pages = (q.data?.pages ?? []).flatMap((p) => p.items);
  const last = q.data?.pages[q.data.pages.length - 1];
  return { ...q, pages, next: last?.next ?? null, loadMore: () => { void q.fetchNextPage(); } };
}

export function useGet<T>(key: unknown[], path: string, opts: { refetchInterval?: number | false; api?: ApiOptions; enabled?: boolean } = {}): UseQueryResult<T, ApiError> {
  const actor = useActor();
  const effective = opts.api?.actorOverride ?? actor;
  return useQuery<T, ApiError>({
    queryKey: [...key, effective],
    queryFn: () => api<T>("GET", path, undefined, { ...opts.api, actorOverride: effective }),
    refetchInterval: opts.refetchInterval ?? false,
    enabled: opts.enabled ?? true,
  });
}

export function useAction<I, O>(fn: (i: I) => Promise<O>, invalidate: string[]): UseMutationResult<O, ApiError, I> {
  const qc = useQueryClient();
  const actor = useActor();
  return useMutation<O, ApiError, I>({
    mutationKey: ["action", actor],
    mutationFn: fn,
    onSuccess: () => Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: [k] }))).then(() => undefined),
  });
}
