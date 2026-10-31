import index from "../ui/index.html";
import { isLocalRequest, runAction } from "./hub/actions.ts";
import { createHub, knownUrls, markSeen } from "./hub/state.ts";

const stateIntervalMilliseconds = 1000;
const refreshIntervalMilliseconds = 3000;
const heartbeatMilliseconds = 10_000;

/**
 * Serves the hub. Port 0 picks a free port. Runs until the process ends.
 *
 * Ark's files are read every second, so a change in `events.ndjson` reaches the page at once.
 * Orca and Plannotator are read every 3 seconds in the background, each with a hard timeout,
 * and never delay that push.
 */
export function ui(port: number): void {
  const hub = createHub();
  const encoder = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let lastPushed = "";

  const push = () => {
    const json = JSON.stringify(hub.state());
    if (json === lastPushed) return;
    lastPushed = json;
    for (const client of clients) client.enqueue(encoder.encode(`data: ${json}\n\n`));
  };

  // ponytail: re-reads every run's log each second; watch the files if hundreds of runs make this slow.
  setInterval(push, stateIntervalMilliseconds);
  setInterval(() => {
    for (const client of clients) client.enqueue(encoder.encode(": keep-alive\n\n"));
  }, heartbeatMilliseconds);
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      await hub.refresh();
    } finally {
      refreshing = false;
    }
  };
  void refresh();
  setInterval(() => void refresh(), refreshIntervalMilliseconds);

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    routes: {
      "/": index,
      "/api/state": () => Response.json(hub.state()),
      "/api/needs-me": () => Response.json(hub.state().needs_me),
      "/api/events": () => {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              controller = streamController;
              clients.add(controller);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(hub.state())}\n\n`));
            },
            cancel() {
              clients.delete(controller);
            },
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
        );
      },
      "/api/seen": {
        POST: (request) => {
          if (!isLocalRequest(request, server.port!))
            return Response.json({ error: "foreign origin" }, { status: 403 });
          markSeen();
          return Response.json({ ok: true });
        },
      },
      "/api/actions/:name": {
        POST: async (request) => {
          if (!isLocalRequest(request, server.port!))
            return Response.json({ error: "foreign origin" }, { status: 403 });
          const params = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          const { status, body } = await runAction(
            request.params.name,
            params,
            knownUrls(hub.state()),
          );
          return Response.json(body, { status });
        },
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
  console.log(`Ark hub on http://127.0.0.1:${server.port}`);
}
