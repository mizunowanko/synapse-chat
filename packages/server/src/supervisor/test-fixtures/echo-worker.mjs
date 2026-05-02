// Test fixture: responds to ping with pong, exits on supervisor:shutdown.
process.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "supervisor:shutdown") {
    process.exit(0);
  } else if (msg.type === "ping") {
    try {
      process.send({ type: "pong" });
    } catch {
      // ignore
    }
  }
});

process.send({ type: "child:ready" });

// Keep alive
setInterval(() => {}, 60_000);
