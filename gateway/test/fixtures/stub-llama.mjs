#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const port = Number(flagValue("--port") ?? 0);
const pidlog = flagValue("--stub-pidlog");
const crashAfter = Number(flagValue("--stub-crash-ms") ?? 0);

if (pidlog) appendFileSync(pidlog, `${process.pid}\n`);
if (crashAfter > 0) setTimeout(() => process.exit(1), crashAfter);

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  res.writeHead(200).end("{}");
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));