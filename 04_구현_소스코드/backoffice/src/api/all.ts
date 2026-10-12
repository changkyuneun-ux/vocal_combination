import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type Paged } from "./client.ts";
import { useActor } from "../app/actor.ts";

const MAX_PAGES = 50;

/** 모든 쪽을 따라가 항목을 모은다(limit=200). 현재 사용자로 읽고, 실패(403 등)는 그대로 던진다. */
export function useAll<T>(key: string, path: string, opts: { enabled?: boolean; refetchInterval?: number | false | ((data: T[] | undefined) => number | false) } = {}) {
  const actor = useActor();
  return useQuery<T[], ApiError>({
    queryKey: [key, actor, path],
    enabled: opts.enabled ?? true,
    refetchInterval: typeof opts.refetchInterval === "function"
      ? (query) => (opts.refetchInterval as (d: T[] | undefined) => number | false)(query.state.data)
      : opts.refetchInterval ?? false,
    queryFn: async () => {
      const out: T[] = [];
      let after: string | null = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const sep = path.includes("?") ? "&" : "?";
        const p: Paged<T> = await api<Paged<T>>("GET", `${path}${sep}limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`, undefined, { actorOverride: actor });
        out.push(...p.items);
        if (!p.next) return out;
        after = p.next;
      }
      return out;
    },
  });
}
