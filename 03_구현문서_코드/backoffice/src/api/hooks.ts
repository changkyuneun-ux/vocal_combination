import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { api, ApiError, type ApiOptions, type Paged } from "./client.ts";
import { currentActor } from "../app/actor.ts";

function withParams(path: string, params: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
  const s = q.toString();
  return s ? `${path}${path.includes("?") ? "&" : "?"}${s}` : path;
}

export function useList<T>(key: string, path: string, params?: Record<string, string | undefined>) {
  const q = useInfiniteQuery<Paged<T>, ApiError, { pages: Paged<T>[] }, unknown[], string | null>({
    queryKey: [key, currentActor(), path, params ?? {}],
    initialPageParam: null,
    queryFn: ({ pageParam }) => api<Paged<T>>("GET", withParams(path, { ...params, after: pageParam ?? undefined })),
    getNextPageParam: (last) => last.next,
  });
  const pages = (q.data?.pages ?? []).flatMap((p) => p.items);
  const last = q.data?.pages[q.data.pages.length - 1];
  return { ...q, pages, next: last?.next ?? null, loadMore: () => { void q.fetchNextPage(); } };
}

export function useGet<T>(key: unknown[], path: string, opts: { refetchInterval?: number | false; api?: ApiOptions; enabled?: boolean } = {}): UseQueryResult<T, ApiError> {
  return useQuery<T, ApiError>({
    queryKey: [...key, opts.api?.actorOverride ?? currentActor()],
    queryFn: () => api<T>("GET", path, undefined, opts.api),
    refetchInterval: opts.refetchInterval ?? false,
    enabled: opts.enabled ?? true,
  });
}

export function useAction<I, O>(fn: (i: I) => Promise<O>, invalidate: string[]): UseMutationResult<O, ApiError, I> {
  const qc = useQueryClient();
  return useMutation<O, ApiError, I>({
    mutationFn: fn,
    onSuccess: () => Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: [k] }))).then(() => undefined),
  });
}
