export { Firehose } from "./firehose";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/ws" || pathname === "/api/stats") {
      return env.FIREHOSE.getByName("bluesky").fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
