import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type {
  NodeAgentInfo,
  OperationStepLog,
  TunnelInfo,
} from '../types/k8s.js';
import {
  computeAgentEligibility,
  formatNodeSelectorDisplay,
} from '../utils/validation.js';
import { updateTunnelAssignment } from '../services/tunnels.js';
import { StepList } from './StepList.js';

export interface EditAssignmentModalProps {
  tunnel: TunnelInfo;
  allNodes: NodeAgentInfo[];
  onUpdated: (summary: string) => void;
  onCancel: () => void;
}

export const EditAssignmentModal: React.FC<EditAssignmentModalProps> = ({
  tunnel,
  allNodes,
  onUpdated,
  onCancel,
}) => {
  const eligibility = useMemo(
    () => computeAgentEligibility(allNodes, tunnel.namespaceNodeSelector),
    [allNodes, tunnel.namespaceNodeSelector],
  );

  const [selectedAgents, setSelectedAgents] = useState<string[]>(() =>
    tunnel.allowedAgents.filter((a) =>
      eligibility.some((e) => e.agent.name === a),
    ),
  );
  const [replicas, setReplicas] = useState<number>(
    tunnel.replicas === 0 ? 0 : Math.max(1, tunnel.replicas),
  );
  const [focusSection, setFocusSection] = useState<'agents' | 'replicas'>('agents');
  const [cursor, setCursor] = useState(0);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<OperationStepLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tunnel.replicas === 0) return;
    const max = Math.max(1, selectedAgents.length);
    setReplicas((prev) => Math.max(1, Math.min(prev, max)));
  }, [selectedAgents.length, tunnel.replicas]);

  const toAdd = useMemo(
    () => selectedAgents.filter((a) => !tunnel.allowedAgents.includes(a)),
    [selectedAgents, tunnel.allowedAgents],
  );
  const toRemove = useMemo(
    () => tunnel.allowedAgents.filter((a) => !selectedAgents.includes(a)),
    [selectedAgents, tunnel.allowedAgents],
  );
  const willEvacuate = useMemo(
    () =>
      replicas > 0 &&
      tunnel.runningAgents.some((runningNode) => toRemove.includes(runningNode)),
    [replicas, tunnel.runningAgents, toRemove],
  );

  const handleApply = async () => {
    if (running) return;
    if (selectedAgents.length === 0) {
      setError('Debes mantener al menos un agente permitido.');
      return;
    }

    setError(null);
    setRunning(true);
    try {
      await updateTunnelAssignment(
        {
          tunnel,
          newAgents: selectedAgents,
          newReplicas: replicas,
          allNodes,
        },
        (progress) => setSteps(progress),
      );
      onUpdated(
        `Asignación de "${tunnel.name}" actualizada: [${selectedAgents.join(', ')}] (${replicas} rep).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  };

  useInput(
    (input, key) => {
      if (running) return;
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.ctrl && input.toLowerCase() === 's') {
        void handleApply();
        return;
      }
      if (key.tab) {
        setFocusSection((prev) => (prev === 'agents' ? 'replicas' : 'agents'));
        return;
      }

      if (focusSection === 'agents') {
        if (key.upArrow) {
          setCursor((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setCursor((prev) => Math.min(Math.max(0, eligibility.length - 1), prev + 1));
          return;
        }
        if (input === ' ') {
          const item = eligibility[cursor];
          if (!item) return;
          const checked = selectedAgents.includes(item.agent.name);
          if (checked) {
            setSelectedAgents((prev) => prev.filter((a) => a !== item.agent.name));
            setError(null);
          } else if (item.eligible) {
            setSelectedAgents((prev) => [...prev, item.agent.name].sort());
            setError(null);
          }
          return;
        }
        if (key.return) {
          void handleApply();
          return;
        }
      } else {
        if (tunnel.replicas > 0) {
          const max = Math.max(1, selectedAgents.length);
          if (key.leftArrow) {
            setReplicas((prev) => Math.max(1, prev - 1));
            return;
          }
          if (key.rightArrow) {
            setReplicas((prev) => Math.min(max, prev + 1));
            return;
          }
        }
        if (key.return) {
          void handleApply();
        }
      }
    },
    { isActive: !running },
  );

  if (running) {
    return (
      <Box
        borderStyle="round"
        borderColor="yellow"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color="yellow">
          Actualizando asignación sin corte para "{tunnel.name}"...
        </Text>
        <StepList steps={steps} />
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor="yellow"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="yellow">
        Editar agentes y réplicas: {tunnel.name} ({tunnel.namespace})
      </Text>
      <Text dimColor>
        Label: {tunnel.nodeLabelKey} · Actual: {tunnel.runningAgents.join(', ') || 'ninguno'}
        {tunnel.namespaceNodeSelector
          ? ` · ns-afinidad: ${formatNodeSelectorDisplay(tunnel.namespaceNodeSelector)}`
          : ''}
      </Text>

      <Text bold={focusSection === 'agents'} color={focusSection === 'agents' ? 'cyan' : undefined}>
        {focusSection === 'agents' ? '▸ ' : '  '}Agentes (↑/↓ y Espacio):
      </Text>
      {eligibility.map((item, idx) => {
        const checked = selectedAgents.includes(item.agent.name);
        const isCursor = focusSection === 'agents' && idx === cursor;
        const isRunningHere = tunnel.runningAgents.includes(item.agent.name);
        return (
          <Text
            key={item.agent.name}
            color={
              !item.eligible && !checked
                ? 'gray'
                : isCursor
                  ? 'cyan'
                  : checked
                    ? 'green'
                    : 'white'
            }
            bold={isCursor}
          >
            {'    '}
            {isCursor ? '▸ ' : '  '}
            {item.eligible || checked ? (checked ? '[x]' : '[ ]') : '[-]'} {item.agent.name}{' '}
            ({item.agent.status})
            {isRunningHere ? ' ★ activo' : ''}
            {item.disabledReason ? ` — ${item.disabledReason}` : ''}
          </Text>
        );
      })}

      <Box>
        <Text bold={focusSection === 'replicas'} color={focusSection === 'replicas' ? 'cyan' : undefined}>
          {focusSection === 'replicas' ? '▸ ' : '  '}Réplicas (Tab · ←/→):{' '}
        </Text>
        {tunnel.replicas === 0 ? (
          <Text color="magenta">0 (pausado)</Text>
        ) : (
          <Text bold color="green">
            ◀ {replicas} / máx {Math.max(1, selectedAgents.length)} ▶
          </Text>
        )}
      </Box>

      <Text dimColor wrap="truncate-end">
        Plan: +{toAdd.join(',') || '∅'} │ evacuar:{willEvacuate ? 'Sí (sin corte)' : 'No'} │ -{toRemove.join(',') || '∅'}
      </Text>

      {error ? (
        <Text color="red" bold wrap="truncate-end">
          ✗ {error}
        </Text>
      ) : null}

      <Text dimColor>
        (Enter / Ctrl+S) Aplicar · (Tab) Réplicas · (Esc) Cancelar
      </Text>
    </Box>
  );
};
