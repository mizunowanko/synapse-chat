// Test fixture: ignores all IPC messages (does NOT respond to ping or shutdown).
// Also ignores SIGTERM. Used to test:
//   - health check timeout → SIGKILL
//   - shutdownTimeout → SIGKILL
process.on("message", () => {
  // intentionally ignore
});
process.on("SIGTERM", () => {
  // intentionally ignore
});

process.send({ type: "child:ready" });

// Keep alive
setInterval(() => {}, 60_000);
