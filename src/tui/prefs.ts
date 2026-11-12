// The TUI's own settings, kept between sessions in `tui.json` under the
// factory's home: a display setting of the operator's terminal, so the TUI
// reads and writes it itself, not the daemon. Only whether the task tree
// hides Done and Cancelled tasks, for now.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type TuiPrefs = { hideFinished: boolean };

export type PrefsStore = {
  load(): TuiPrefs;
  save(prefs: TuiPrefs): void;
};

export const DEFAULT_PREFS: TuiPrefs = { hideFinished: false };

// The settings in `path`. A missing, unreadable or malformed file loads as
// the defaults, and a save that fails leaves the TUI as it is.
export function filePrefs(path: string): PrefsStore {
  return {
    load() {
      try {
        return parse(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        return { ...DEFAULT_PREFS };
      }
    },
    save(prefs) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        // A temp file of its own: two TUIs may save at once.
        const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        writeFileSync(temp, `${JSON.stringify(prefs, null, 2)}\n`);
        renameSync(temp, path);
      } catch {
        // Not remembered this time; the setting still holds for this session.
      }
    },
  };
}

// Settings that live only as long as the store: for tests and the demo,
// which leave the operator's file alone.
export function memoryPrefs(initial: TuiPrefs = DEFAULT_PREFS): PrefsStore & { saved: TuiPrefs[] } {
  let current = { ...initial };
  const saved: TuiPrefs[] = [];
  return {
    saved,
    load: () => ({ ...current }),
    save(prefs) {
      current = { ...prefs };
      saved.push({ ...prefs });
    },
  };
}

function parse(raw: unknown): TuiPrefs {
  const prefs = { ...DEFAULT_PREFS };
  if (raw && typeof raw === 'object' && typeof (raw as { hideFinished?: unknown }).hideFinished === 'boolean') {
    prefs.hideFinished = (raw as { hideFinished: boolean }).hideFinished;
  }
  return prefs;
}
