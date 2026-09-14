import { createInterface } from "node:readline";

// A local protocol fixture: no credentials, model calls, or network access.
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let pendingCollision;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { ready: true } });
  else if (message.method === "echo") {
    setTimeout(() => send({ id: message.id, result: message.params.value }), message.params.delay ?? 0);
  } else if (message.method === "early-event") {
    const output = JSON.stringify({ method: "turn/completed", params: { threadId: "fixture", turn: { id: "early", status: "completed" } } }) + "\n";
    process.stdout.write(output.slice(0, 17));
    setTimeout(() => {
      process.stdout.write(output.slice(17));
      send({ id: message.id, result: { turn: { id: "early" } } });
    }, 10);
  } else if (message.method === "collision") {
    pendingCollision = message.id;
    send({ id: message.id, method: "item/commandExecution/requestApproval", params: {} });
  } else if (!message.method && message.id === pendingCollision) {
    send({ id: pendingCollision, result: { rejected: message.error?.code === -32601 } });
    pendingCollision = null;
  } else if (message.method === "exit-now") process.exit(0);
  else if (message.method === "invalid-json") process.stdout.write("not json\n");
  else if (message.method === "reject") send({ id: message.id, error: { code: -32000, message: "Task already has an active writer" } });
  // 'never-respond' deliberately leaves the request pending.
});
