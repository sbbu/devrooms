// Fully stop devrooms for this repo — including the pty-host, which ENDS all
// terminal sessions. This is the deliberate counterpart to the normal close,
// which now leaves the host running so sessions survive.
//
// Also the way to cycle the host after editing src/pty-host.ts: stop, then start.
import { killStaleDaemon, killStaleVite, killStaleElectron, killByPort } from './lib-cleanup.mjs';

const root = process.cwd();
const port = Number(process.env.DEVROOMS_PORT || process.env.PORT || 4317);

killStaleElectron(root);
killStaleVite();
killStaleDaemon(root, port);
killByPort(port + 1); // the pty-host — this is what ends the sessions

console.log(`devrooms: stopped daemon, vite, electron, and pty-host on :${port}/:${port + 1} — sessions ended.`);
