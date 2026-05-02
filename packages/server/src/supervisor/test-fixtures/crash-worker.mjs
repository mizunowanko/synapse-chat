// Test fixture: signals ready, then exits with code 1 after a tick.
// Used to test restart backoff and maxRestarts → onFatal escalation.
process.send({ type: "child:ready" });
setTimeout(() => process.exit(1), 20);
