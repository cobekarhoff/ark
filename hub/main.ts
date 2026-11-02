import { createSnapshotReader } from "./snapshot.ts";
import { serve } from "./server.ts";

/** `bun hub/main.ts [--port <number>]`: serves the hub on 127.0.0.1, port 4317 unless told otherwise. 0 picks a free port. */
const flag = process.argv.indexOf("--port");
const port = flag === -1 ? 4317 : Number(process.argv[flag + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("--port must be a number from 0 to 65535");
  process.exit(1);
}

const reader = createSnapshotReader();
const server = await serve(reader, port);
console.log(`Ark hub on http://127.0.0.1:${server.port}`);
// The snapshot fills in while the server already answers: `unknown` until a source has read.
await reader.start();

const stop = () => {
  reader.stop();
  void server.stop(true).then(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
