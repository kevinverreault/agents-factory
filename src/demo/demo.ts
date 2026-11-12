// `npm run demo`: the real TUI on the made-up factory of demo-factory.ts,
// with no daemon, GitHub or Claude behind it. Look around the screens and
// open the conversations; commands are acknowledged and go nowhere.
// ctrl+c quits. Plain .ts (no JSX) so Node runs it without a build step.
import { createElement as h } from 'react';
import { render } from 'ink';
import { App } from '../tui/app.ts';
import { memoryPrefs } from '../tui/prefs.ts';
import { DEMO_CWD, DemoConnection } from './demo-factory.ts';

// Times show in the machine's zone: the demo pins it, as the media do.
process.env.TZ = 'UTC';
await render(h(App, { connection: new DemoConnection(), cwd: DEMO_CWD, prefs: memoryPrefs() })).waitUntilExit();
