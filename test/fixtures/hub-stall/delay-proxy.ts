// A proxy in front of a hub (ARK-T702): `bun delay-proxy.ts <hub port> <seconds> <arrived file>`.
// It listens on a free port and prints it, writes the arrived file when a request reaches it, holds
// the request for the given seconds counted from that arrival, then forwards it to the hub.
import { writeFileSync } from "node:fs";

const [hubPort, seconds, arrivedFile] = process.argv.slice(2);
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    writeFileSync(arrivedFile, "");
    await Bun.sleep(Number(seconds) * 1000);
    const { pathname, search } = new URL(request.url);
    return fetch(`http://127.0.0.1:${hubPort}${pathname}${search}`);
  },
});
console.log(`proxy on ${server.port}`);
