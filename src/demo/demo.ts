// `npm run demo`: the real TUI on the made-up factory of demo-factory.ts,
// with no daemon, GitHub or Claude behind it. Look around the screens and
// open the conversations; commands are acknowledged and go nowhere.
// ctrl+c quits. Plain .ts (no JSX) so Node runs it without a build step.
import { createElement as h } from 'react';
import { render } from 'ink';
import { App } from '../tui/app.ts';
import { DEMO_CWD, DemoConnection } from './demo-factory.ts';

process.env.TZ ??= 'UTC';
await render(h(App, { connection: new DemoConnection(), cwd: DEMO_CWD })).waitUntilExit();
