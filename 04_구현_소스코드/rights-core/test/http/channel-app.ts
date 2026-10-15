import type { FastifyInstance } from "fastify";

/**
 * 테스트용: 사용자 API를 채널 경로로 보낸다. 채널은 x-actor로 정한다(기본 ops). /dev·/psp/webhook과 이미 채널이 붙은 경로는 그대로 둔다.
 * 사용자 API는 채널 아래에만 있으므로(다음 작업 5·6), 루트 경로로 쓰인 기존 테스트를 이 래퍼로 감싼다.
 */
export function viaChannel(app: FastifyInstance, channelOf: (actor: string | undefined) => string = () => "ops"): FastifyInstance {
  const route = (url: string, actor: string | undefined) => {
    if (url.startsWith("/dev/") || url === "/psp/webhook" || /^\/(ops|portal|performer|fan|partner)\//.test(url)) return url;
    return `/${channelOf(actor)}${url}`;
  };
  return new Proxy(app, {
    get(target, key) {
      if (key === "inject") {
        return (opts: any) => target.inject({ ...opts, url: route(opts.url, opts.headers?.["x-actor"]) });
      }
      const v = (target as any)[key];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
