import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { SnapshotReader } from "./snapshot.ts";

const heartbeatMilliseconds = 10_000;
const pageEntry = join(import.meta.dir, "page", "index.html");

/**
 * A browser page on another origin, or a DNS-rebinding host name, must not read run files through
 * the hub. Requests with no Origin (curl, tests) pass.
 */
export function isLocalRequest(request: Request, port: number): boolean {
  const local = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  return (
    (origin === null || local.some((authority) => origin === `http://${authority}`)) &&
    (host === null || local.includes(host))
  );
}

/**
 * Builds the page once, at start (a production build of `hub/page/`: plain React, no React
 * Compiler). Null while the page does not exist. Maps URL path to file.
 */
async function buildPage(): Promise<Map<string, Blob> | null> {
  if (!existsSync(pageEntry)) return null;
  const build = await Bun.build({
    entrypoints: [pageEntry],
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    target: "browser",
    publicPath: "/assets/",
    naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
  });
  if (!build.success)
    throw new Error(`hub page build failed:\n${build.logs.map((log) => log.message).join("\n")}`);
  const files = new Map<string, Blob>();
  for (const output of build.outputs)
    files.set(
      output.kind === "entry-point" && output.path.endsWith(".html")
        ? "/"
        : `/assets/${basename(output.path)}`,
      output,
    );
  return files;
}

const headers = { "x-content-type-options": "nosniff", "cache-control": "no-store" };
const text = (body: string, status: number, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...headers, "content-type": "text/plain", ...extra } });

/**
 * Serves the hub. Routes are `GET /`, `GET /assets/*`, `GET /api/snapshot` and `GET /events`
 * (Server-Sent Events). Any other method gets 405, any other path 404. No handler reads a file
 * or runs a tool: they send what the snapshot reader already holds.
 *
 * The hub renders no Markdown or run text on the server: run and ticket text leaves only as JSON
 * strings, and the page puts it in the document as text.
 */
export async function serve(reader: SnapshotReader, port: number) {
  const page = await buildPage();
  const encoder = new TextEncoder();

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(request) {
      if (request.method !== "GET") return text("method not allowed", 405, { allow: "GET" });
      if (!isLocalRequest(request, server.port!)) return text("foreign origin", 403);
      const { pathname } = new URL(request.url);

      if (pathname === "/api/snapshot")
        return new Response(reader.json(), {
          headers: { ...headers, "content-type": "application/json" },
        });

      if (pathname === "/events") {
        let cleanup = () => {};
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (json: string) => controller.enqueue(encoder.encode(`data: ${json}\n\n`));
            send(reader.json());
            const unsubscribe = reader.subscribe(send);
            const heartbeat = setInterval(
              () => controller.enqueue(encoder.encode(": keep-alive\n\n")),
              heartbeatMilliseconds,
            );
            cleanup = () => {
              unsubscribe();
              clearInterval(heartbeat);
            };
            request.signal.addEventListener("abort", cleanup);
          },
          cancel: () => cleanup(),
        });
        return new Response(stream, {
          headers: { ...headers, "content-type": "text/event-stream", connection: "keep-alive" },
        });
      }

      if (pathname === "/" || pathname.startsWith("/assets/")) {
        if (page === null)
          return text("the hub page is not built: hub/page/index.html is missing", 503);
        const file = page.get(pathname);
        return file
          ? new Response(file, { headers: { ...headers, "content-type": file.type } })
          : text("not found", 404);
      }
      return text("not found", 404);
    },
  });
  return server;
}
