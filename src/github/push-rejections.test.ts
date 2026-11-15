// Pure module: what the GitHub adapter says when GitHub refuses a push,
// which `git push --porcelain` writes to stdout alone.
import { expect, test } from 'vitest';
import { pushRejections } from './github.ts';

test('names each refused ref with GitHub’s reason', () => {
  const porcelain = [
    'To https://github.com/acme/widgets.git',
    '!\tf04a2139a1e27da767f6fd7adfdf889ed4dd8864:refs/heads/factory/T1-add-a-logout-button\t[remote rejected] (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)',
    'Done',
    '',
  ].join('\r\n');

  expect(pushRejections(porcelain)).toEqual([
    'refs/heads/factory/T1-add-a-logout-button: [remote rejected] (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)',
  ]);
});

test('says nothing of the refs that were pushed', () => {
  expect(pushRejections('To https://github.com/acme/widgets.git\n*\tabc:refs/heads/factory/T1-x\t[new branch]\nDone\n')).toEqual([]);
});
