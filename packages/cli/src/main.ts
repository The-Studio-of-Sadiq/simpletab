import { defaultContext, run } from "./run";

const code = await run(process.argv.slice(2), defaultContext());
process.exitCode = code;
// Every command stops its connection, so Node normally exits by itself. If a socket or timer is
// ever left open, exit anyway rather than hang an agent's shell; the timer does not keep Node alive.
setTimeout(() => process.exit(code), 2_000).unref();
