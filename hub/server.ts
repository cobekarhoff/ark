import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { exec } from "../cli/exec.ts";
import { proxyPort } from "../cli/proxy.ts";
import { resolveEvidenceImage, resolveRunFile } from "./run-detail.ts";
import type { SnapshotReader } from "./snapshot.ts";

const heartbeatMilliseconds = 10_000;
const pageEntry = join(import.meta.dir, "page", "index.html");

/**
 * A browser page on another origin, or a DNS-rebinding host name, must not read run files through
 * the hub. Requests with no Origin (curl, tests) pass.
 */
export function isLocalRequest(request: Request, authorities: string[]): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  return (
    (origin === null || authorities.some((authority) => origin === `http://${authority}`)) &&
    (host === null || authorities.includes(host))
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

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });

/** A run file longer than this is cut: the page shows text, not a download. */
const fileLimitBytes = 1 << 20;
const switchTimeoutMilliseconds = 5000;

/**
 * Serves the hub. Routes: `GET /`, `GET /assets/*`, `GET /api/snapshot`, `GET /events`
 * (Server-Sent Events), and on request `GET /api/run/<run>` (any run, open or closed),
 * `GET /api/run/<run>/transcript?file=&cursor=`, `GET /api/run/<run>/file?path=`,
 * `GET /api/run/<run>/evidence` (plan cases with base and head results, evidence files of non-test
 * ACs), `GET /api/run/<run>/image?path=` (an image under `results/evidence/`, ADR 0009) and
 * `GET /api/ticket/<project>/<ticket>` (the document of one ticket) and
 * `GET /api/ticket/<project>/<ticket>/cases` (the test cases of a ticket). The one POST
 * route is `POST /api/open-in-orca` (ADR 0009): it focuses a live terminal in Orca and does nothing
 * else. Any other method gets 405, any other path 404.
 *
 * A handler reads memory, asks the usage worker thread for one transcript page, or reads one small
 * run file the guard allows. It never runs a tool except `orca terminal switch`.
 *
 * The hub renders no Markdown or run text on the server: run and ticket text leaves only as JSON
 * strings or `text/plain`, and the page puts it in the document as text.
 */
export async function serve(reader: SnapshotReader, port: number, name?: string) {
  const page = await buildPage();
  const encoder = new TextEncoder();

  /**
   * `POST /api/open-in-orca {"terminal": <handle>}`. 403 unless the request came from the hub's own
   * page: a browser always sends Origin on a POST, so Origin and Host must be the same authority:
   * the hub's `127.0.0.1:<port>`, or its `--name` with or without the proxy port (a missing Origin is refused, unlike on GET). 400 for a body that is not that
   * JSON or a handle the current snapshot does not list as live. 502 when `orca` fails.
   */
  const postAuthorities = () => [
    `127.0.0.1:${server.port}`,
    ...(name ? [name, `${name}:${proxyPort}`] : []),
  ];
  const getAuthorities = () => [`localhost:${server.port}`, ...postAuthorities()];

  async function openInOrca(request: Request): Promise<Response> {
    // One authority for both headers: a mixed pair is foreign. localhost is not allowed here.
    const host = request.headers.get("host");
    if (
      host === null ||
      !postAuthorities().includes(host) ||
      request.headers.get("origin") !== `http://${host}`
    )
      return text("foreign origin", 403);
    let handle: unknown;
    try {
      handle = (await request.json())?.terminal;
    } catch {
      return text('body must be JSON: {"terminal": <handle>}', 400);
    }
    if (typeof handle !== "string" || !reader.liveTerminals().has(handle))
      return text("terminal is not live in the current snapshot", 400);
    // An argument array, never a shell string: the handle cannot inject anything.
    const output = await exec(
      ["orca", "terminal", "switch", "--terminal", handle],
      switchTimeoutMilliseconds,
    );
    return output === null ? text("orca failed", 502) : json({ ok: true });
  }

  async function runRoute(url: URL, runName: string, rest: string): Promise<Response> {
    const directory = reader.runDirectory(runName);
    if (directory === null) return text("no such run", 404);
    if (rest === "") return json(reader.runDetail(runName));
    if (rest === "/transcript") {
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      if (!Number.isSafeInteger(cursor) || cursor < 0) return text("bad cursor", 400);
      try {
        const result = await reader.transcript(runName, url.searchParams.get("file") ?? "", cursor);
        return result ? json(result) : text("no such session file in this run", 404);
      } catch {
        return text("the usage worker could not read the file", 502);
      }
    }
    if (rest === "/file") {
      const real = resolveRunFile(directory, url.searchParams.get("path") ?? "");
      if (real === null) return text("not found", 404);
      const file = Bun.file(real);
      const body = await file.slice(0, fileLimitBytes).text();
      return text(
        file.size > fileLimitBytes ? `${body}\n… cut at ${fileLimitBytes} bytes` : body,
        200,
        { "content-type": "text/plain; charset=utf-8" },
      );
    }
    if (rest === "/evidence") return json(reader.runEvidence(runName));
    if (rest === "/image") {
      const image = resolveEvidenceImage(directory, url.searchParams.get("path") ?? "");
      if (image === null) return text("not found", 404);
      // The type comes from the bytes the check read, never from the file name or Bun.file.
      return new Response(await Bun.file(image.real).bytes(), {
        headers: { ...headers, "content-type": image.type },
      });
    }
    return text("not found", 404);
  }

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    maxRequestBodySize: 1024,
    async fetch(request) {
      const url = new URL(request.url);
      const { pathname } = url;
      if (pathname === "/api/open-in-orca")
        return request.method === "POST"
          ? openInOrca(request)
          : text("method not allowed", 405, { allow: "POST" });
      if (request.method !== "GET") return text("method not allowed", 405, { allow: "GET" });
      if (!isLocalRequest(request, getAuthorities())) return text("foreign origin", 403);

      const cases = pathname.match(/^\/api\/ticket\/([^/]+)\/([^/]+)\/cases$/);
      if (cases) {
        try {
          const result = await reader.ticketCases(
            decodeURIComponent(cases[1]),
            decodeURIComponent(cases[2]),
          );
          return result ? json(result) : text("no such ticket", 404);
        } catch {
          return text("bad request", 400);
        }
      }

      const ticket = pathname.match(/^\/api\/ticket\/([^/]+)\/([^/]+)$/);
      if (ticket) {
        try {
          // The id only selects a listed ticket: the file is the one the hub listed, never a path built from the URL.
          const result = reader.ticketDocument(
            decodeURIComponent(ticket[1]),
            decodeURIComponent(ticket[2]),
          );
          return result ? json(result) : text("no such ticket", 404);
        } catch {
          return text("bad request", 400);
        }
      }

      const run = pathname.match(/^\/api\/run\/([^/]+)(\/transcript|\/file|\/evidence|\/image)?$/);
      if (run) {
        try {
          return await runRoute(url, decodeURIComponent(run[1]), run[2] ?? "");
        } catch {
          return text("bad request", 400);
        }
      }

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
