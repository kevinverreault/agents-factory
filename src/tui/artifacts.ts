// A task's artifacts as the conversation's rail and the task's detail list them.
import { createElement as h } from 'react';
import { Box, Text } from 'ink';
import { issueRef } from '../artifacts/capture.ts';
import type { ArtifactView } from '../protocol/factory-state.ts';

// What the task produced so far, live: captured from the run's tool calls.
// The newest come first, so a full rail cuts off the oldest.
export function ArtifactRail({ artifacts }: { artifacts: ArtifactView[] }) {
  return h(
    Box,
    { flexDirection: 'column', overflow: 'hidden' },
    h(Text, { bold: true }, 'Artifacts'),
    artifacts.length === 0 ? h(Text, { dimColor: true }, 'None yet.') : null,
    ...artifacts.toReversed().map((artifact) =>
      h(
        Box,
        { key: artifact.id, gap: 1 },
        h(Box, { width: 11, flexShrink: 0 }, h(Text, { dimColor: true }, artifactState(artifact))),
        h(Text, { wrap: 'truncate-start' }, artifactName(artifact)),
      ),
    ),
  );
}

function artifactState(artifact: ArtifactView): string {
  if (artifact.kind === 'issue') return 'issue';
  return artifact.committed ? 'committed' : 'uncommitted';
}

// A file by its path in the worktree, an issue as `owner/name#number`.
function artifactName(artifact: ArtifactView): string {
  return artifact.kind === 'file' ? artifact.path : issueRef(artifact.url);
}
