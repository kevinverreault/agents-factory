import { describe, expect, test } from 'vitest';
import { editExternally, editorCommand } from './edit-externally.ts';

// An "editor" that appends a list item and a line break to the file it is given.
const appendItem = `node -e "require('fs').appendFileSync(process.argv[1], '\\n- two\\n')"`;

describe('the operator’s own editor', () => {
  test('is $VISUAL, else $EDITOR, else the platform’s', () => {
    expect(editorCommand({ VISUAL: 'code --wait', EDITOR: 'nano' }, 'linux')).toBe('code --wait');
    expect(editorCommand({ EDITOR: 'nano' }, 'linux')).toBe('nano');
    expect(editorCommand({ VISUAL: ' ' }, 'win32')).toBe('notepad');
    expect(editorCommand({}, 'linux')).toBe('vi');
  });

  test('gives back the text as saved, without the line break the editor ended it with', async () => {
    expect(await editExternally('- one', 'prompt.md', appendItem)).toEqual({ ok: true, text: '- one\n- two' });
  });

  test('leaves the text be when the editor fails', async () => {
    const edited = await editExternally('kept', 'prompt.md', 'node -e "process.exit(3)"');
    expect(edited).toEqual({ ok: false, reason: expect.stringContaining('code 3') });
  });
});
