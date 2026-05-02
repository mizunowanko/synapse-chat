---
"@synapse-chat/server": minor
---

`startSupervisor` adds graceful shutdown, PM worker health checks, and a restart cap.

- `SupervisorOptions` gains `shutdownTimeout`, `healthCheckInterval`, `healthCheckTimeout`, `maxRestarts`, `onFatal`, `onTerminate`, and `installGlobalHandlers`. All optional; defaults preserve the previous behaviour (5s shutdown timeout, no health check, unbounded restarts).
- `SupervisorHandle` exposes `stop()` as an alias for `shutdown()`. The `shutdown` sequence now SIGKILLs any child that fails to exit within `shutdownTimeout`, instead of leaving it dangling when the supervisor itself exits.
- When `healthCheckInterval` is set, the supervisor pings the PM worker over IPC. Missed pongs (after `healthCheckTimeout`) cause a SIGKILL → restart cycle, catching hung CLI subprocesses.
- When a child exceeds `maxRestarts`, `onFatal(label, count)` runs and the supervisor initiates its own shutdown so the embedding process can exit cleanly.
