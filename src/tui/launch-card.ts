// The launch card, minimal for now: a repository and a prompt, launched as
// one HITL stage that opens its conversation.
import { createElement as h, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
import { edit } from './text-input.ts';

type Props = {
  connection: FactoryConnection;
  state: FactoryState;
  // The repository holding the TUI's working directory, if any.
  here: string | null;
  onLaunched(taskId: string): void;
  onCancel(): void;
};

export function LaunchCard({ connection, state, here, onLaunched, onCancel }: Props) {
  const repositories = Object.keys(state.repositories);
  const [repo, setRepo] = useState(here && repositories.includes(here) ? here : (repositories[0] ?? null));
  const [prompt, setPrompt] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.tab && repo) return setRepo(repositories[(repositories.indexOf(repo) + 1) % repositories.length]!);
    if (key.return) {
      if (!repo || !prompt.trim()) return;
      void connection.send({ type: 'launchTask', repo, prompt }).then((reply) => {
        if (reply.ok) onLaunched((reply.value as { taskId: string }).taskId);
        else setRefusal(reply.reason);
      });
      return;
    }
    // Keys typed in one burst arrive before a re-render.
    setPrompt((prompt) => edit(prompt, input, key) ?? prompt);
  });

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
    h(Text, { bold: true }, 'Launch a task'),
    repo
      ? h(Box, { gap: 2 }, h(Text, { dimColor: true }, 'Repository'), h(Text, null, repo))
      : h(Text, { color: 'yellow' }, 'Register a repository first: run `agents-factory repo add` in a clone.'),
    h(Box, { gap: 2 }, h(Text, { dimColor: true }, 'Prompt    '), h(Text, null, `${prompt}▏`)),
    refusal ? h(Text, { color: 'red' }, refusal) : null,
    h(Text, { dimColor: true }, 'enter launch · tab repository · esc back'),
  );
}
