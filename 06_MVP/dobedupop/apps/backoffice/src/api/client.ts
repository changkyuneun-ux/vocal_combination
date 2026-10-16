import { currentActor } from "../app/actor.ts";
import { APPS, currentApp } from "../app/apps.ts";

export class ApiError extends Error {
  status: number;
  code: string;
  diagnostics: unknown[];
  constructor(status: number, code: string, message: string, diagnostics: unknown[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export type Paged<T> = { items: T[]; next: string | null };
export type Method = "GET" | "POST" | "PUT";
export type ApiOptions = { actorOverride?: string; fetchImpl?: typeof fetch; channel?: string };

async function request<T>(method: Method, url: string, body: unknown, actor: string | null, fetchImpl?: typeof fetch): Promise<T> {
  const headers: Record<string, string> = {};
  if (actor) headers["x-actor"] = actor;
  if (body !== undefined) headers["content-type"] = "application/json";
  const f = fetchImpl ?? fetch;
  const res = await f(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: unknown = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* 본문이 JSON이 아님 */ }
  if (!res.ok) {
    const e = (json ?? {}) as { code?: unknown; message?: unknown; diagnostics?: unknown };
    throw new ApiError(
      res.status,
      typeof e.code === "string" ? e.code : `HTTP_${res.status}`,
      typeof e.message === "string" ? e.message : text || res.statusText || `HTTP ${res.status}`,
      Array.isArray(e.diagnostics) ? e.diagnostics : [],
    );
  }
  return json as T;
}

/** /api/<채널> 접두(현재 앱의 채널: 운영 = ops, 포털 = portal), x-actor = currentActor()(actorOverride로 덮어쓴다). 비2xx는 ApiError. */
export function api<T>(method: Method, path: string, body?: unknown, opts: ApiOptions = {}): Promise<T> {
  const channel = opts.channel ?? APPS[currentApp()].channel;
  return request<T>(method, `/api/${channel}${path}`, body, opts.actorOverride ?? currentActor(), opts.fetchImpl);
}

/** /api/dev/… , x-actor 없음. */
export function devApi<T>(method: Method, path: string, body?: unknown, opts: Pick<ApiOptions, "fetchImpl"> = {}): Promise<T> {
  return request<T>(method, `/api/dev${path}`, body, null, opts.fetchImpl);
}

/** 원시 바이트 업로드(스템 오디오·참조 음원). JSON이 아니라 파일 그대로 보낸다. */
export async function apiUpload<T>(method: "PUT" | "POST", path: string, file: Blob, opts: ApiOptions = {}): Promise<T> {
  const channel = opts.channel ?? APPS[currentApp()].channel;
  const actor = opts.actorOverride ?? currentActor();
  const res = await (opts.fetchImpl ?? fetch)(`/api/${channel}${path}`, {
    method, body: file, headers: { "content-type": file.type || "application/octet-stream", ...(actor ? { "x-actor": actor } : {}) },
  });
  const text = await res.text();
  const json = (() => { try { return text ? JSON.parse(text) : undefined; } catch { return undefined; } })() as { code?: string; message?: string; diagnostics?: unknown[] } | undefined;
  if (!res.ok) throw new ApiError(res.status, json?.code ?? `HTTP_${res.status}`, json?.message ?? text, json?.diagnostics ?? []);
  return json as T;
}

