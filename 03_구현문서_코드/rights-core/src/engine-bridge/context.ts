export type BlobStore = { put(digest: string, bytes: Uint8Array): Promise<string>; get(uri: string): Promise<Uint8Array> };

/** 봉인 문서는 불변이므로 digest 기준 프로세스 내 캐시가 항상 유효하다. */
export type BridgeCtx = { blobs: BlobStore; cache: Map<string, unknown> };

export function createBridgeCtx(blobs: BlobStore): BridgeCtx {
  return { blobs, cache: new Map() };
}
