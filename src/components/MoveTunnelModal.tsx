import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type {
  NodeAgentInfo,
  OperationStepLog,
  TunnelInfo,
} from '../types/k8s.js';
import { moveTunnelToAgent } from '../services/tunnels.js';
import { StepList } from './StepList.js';

export interface MoveTunnelModalProps {
  tunnel: TunnelInfo;
  allNodes: NodeAgentInfo[];
  onMoved: (summary: string) => void;
  onCancel: () => void;
}

export const MoveTunnelModal: React.FC<MoveTunnelModalProps> = ({
  tunnel,
  allNodes,
  onMoved,
  onCancel,
}) => {
  const candidates = useMemo(() => {
    return tunnel.allowedAgents
      .map((name) => allNodes.find((n) => n.name === name))
      .filter(
        (n): n is NodeAgentInfo =>
          Boolean(n && n.ready && !n.unschedulable && !n.isControlPlane),
      )
      .filter((n) => !tunnel.runningAgents.includes(n.name));
  }, [tunnel, allNodes]);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<OperationStepLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleMove = async () => {
    const target = candidates[selectedIdx];
    if (!target || running) return;
    setError(null);
    setRunning(true);
    try {
      await moveTunnelToAgent({
        tunnel,
        targetAgent: target.name,
        allNodes,
        onProgress: (progress) => setSteps(progress),
      });
      onMoved(`Túnel "${tunnel.name}" movido a ${target.name} sin cortes.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  };

  useInput(
    (input, key) => {
      if (running) return;
      if (key.escape || input.toLowerCase() === 'q') {
        onCancel();
        return;
      }
      if (candidates.length === 0) {
        if (key.return) onCancel();
        return;
      }
      if (key.upArrow) {
        setSelectedIdx((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIdx((prev) => Math.min(candidates.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        void handleMove();
      }
    },
    { isActive: !running },
  );

  if (running) {
    return (
      <Box
        borderStyle="round"
        borderColor="cyan"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color="cyan">
          Moviendo "{tunnel.name}" → {candidates[selectedIdx]?.name}...
        </Text>
        <StepList steps={steps} />
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        Mover ahora (sin corte): {tunnel.name}
      </Text>
      <Text dimColor>
        Actual: {tunnel.runningAgents.join(', ') || 'ninguno'} · Permitidos:{' '}
        {tunnel.allowedAgents.join(', ') || 'ninguno'}
      </Text>

      {tunnel.replicas === 0 ? (
        <Text color="yellow">Túnel pausado. Reactívalo con (p) primero.</Text>
      ) : candidates.length === 0 ? (
        <Text color="yellow">
          Sin otro agente permitido Ready. Agrega agentes con (e) primero.
        </Text>
      ) : (
        <Box flexDirection="column">
          {candidates.map((agent, idx) => {
            const isSelected = idx === selectedIdx;
            return (
              <Text
                key={agent.name}
                color={isSelected ? 'cyan' : 'white'}
                bold={isSelected}
              >
                {isSelected ? '▸ ' : '  '}
                {agent.name} ({agent.status} · {agent.internalIp})
              </Text>
            );
          })}
        </Box>
      )}

      {error ? (
        <Text color="red" bold wrap="truncate-end">
          ✗ {error}
        </Text>
      ) : null}

      <Text dimColor>
        {candidates.length > 0 && tunnel.replicas > 0 ? '(Enter) Mover · ' : ''}
        (Esc) Volver
      </Text>
    </Box>
  );
};
