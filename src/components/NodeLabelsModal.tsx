import React, { useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type {
  NodeAgentInfo,
  NodeLabelOption,
  OperationStepLog,
  TunnelInfo,
} from '../types/k8s.js';
import {
  collectClusterNodeLabels,
  formatCompactNodeLabel,
} from '../utils/validation.js';
import { updateTunnelNodeLabelAffinity } from '../services/tunnels.js';
import { StepList } from './StepList.js';

export interface NodeLabelsModalProps {
  nodes: NodeAgentInfo[];
  selectedTunnel: TunnelInfo | null;
  onApplied: (message: string) => void;
  onClose: () => void;
}

interface LabelRow {
  selector: string | null;
  display: string;
  nodesText: string;
  readyCount: number;
  isSystem: boolean;
  isActive: boolean;
}

export const NodeLabelsModal: React.FC<NodeLabelsModalProps> = ({
  nodes,
  selectedTunnel,
  onApplied,
  onClose,
}) => {
  const { rows } = useWindowSize();
  const [onlyCustom, setOnlyCustom] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<OperationStepLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  const allLabels = useMemo(() => collectClusterNodeLabels(nodes), [nodes]);

  const listRows = useMemo<LabelRow[]>(() => {
    const filtered: NodeLabelOption[] = onlyCustom
      ? allLabels.filter((l) => !l.isSystem)
      : allLabels;

    const items: LabelRow[] = [];
    if (selectedTunnel) {
      items.push({
        selector: null,
        display: '(ninguno — sin afinidad adicional)',
        nodesText: 'todos los agentes permitidos',
        readyCount: selectedTunnel.allowedAgents.length,
        isSystem: false,
        isActive: !selectedTunnel.extraNodeLabel,
      });
    }

    for (const opt of filtered) {
      items.push({
        selector: opt.selector,
        display: opt.selector,
        nodesText: opt.nodes.join(', '),
        readyCount: opt.readyNodes.length,
        isSystem: opt.isSystem,
        isActive: selectedTunnel?.extraNodeLabel === opt.selector,
      });
    }

    return items;
  }, [allLabels, onlyCustom, selectedTunnel]);

  const safeCursor = Math.min(cursor, Math.max(0, listRows.length - 1));
  const customCount = allLabels.filter((l) => !l.isSystem).length;

  const handleApply = async () => {
    if (!selectedTunnel || running) return;
    const item = listRows[safeCursor];
    if (!item) return;

    if (item.isActive) {
      onClose();
      return;
    }

    setError(null);
    setRunning(true);
    try {
      const res = await updateTunnelNodeLabelAffinity({
        tunnel: selectedTunnel,
        selector: item.selector,
        allNodes: nodes,
        onProgress: (progress) => setSteps(progress),
      });
      if (res.appliedSelector) {
        onApplied(
          `Label "${formatCompactNodeLabel(res.appliedSelector)}" aplicado a "${selectedTunnel.name}" (${res.matchedAgents.join(', ')}).`,
        );
      } else {
        onApplied(`Afinidad por label eliminada de "${selectedTunnel.name}".`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  };

  useInput(
    (input, key) => {
      if (running) return;
      const lower = input.toLowerCase();

      if (key.escape || lower === 'q' || lower === 'l') {
        onClose();
        return;
      }

      if (lower === 's') {
        setOnlyCustom((prev) => !prev);
        setCursor(0);
        setError(null);
        return;
      }

      if (key.upArrow || lower === 'k') {
        setCursor((prev) => Math.max(0, prev - 1));
        setError(null);
        return;
      }

      if (key.downArrow || lower === 'j') {
        setCursor((prev) => Math.min(Math.max(0, listRows.length - 1), prev + 1));
        setError(null);
        return;
      }

      if (key.return && selectedTunnel) {
        void handleApply();
      }
    },
    { isActive: !running },
  );

  if (running && selectedTunnel) {
    const chosen = listRows[safeCursor];
    return (
      <Box
        borderStyle="round"
        borderColor="yellow"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color="yellow">
          Aplicando label {chosen?.selector ?? 'ninguno'} en "{selectedTunnel.name}"...
        </Text>
        <StepList steps={steps} />
      </Box>
    );
  }

  const maxVisible = Math.max(5, (rows || 24) - 11);
  const scrollStart = Math.max(
    0,
    Math.min(
      safeCursor - Math.floor(maxVisible / 2),
      Math.max(0, listRows.length - maxVisible),
    ),
  );
  const visibleRows = listRows.slice(scrollStart, scrollStart + maxVisible);

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan" wrap="truncate-end">
        Labels de nodos del clúster ({allLabels.length} total · {customCount} custom)
        {selectedTunnel ? ` · túnel: ${selectedTunnel.name}` : ''}
      </Text>

      <Text dimColor wrap="truncate-end">
        Filtro: {onlyCustom ? 'Solo custom' : 'Todos (custom + sistema)'}
        {selectedTunnel
          ? ` · Activo: ${selectedTunnel.extraNodeLabel ?? 'ninguno'}`
          : ' · Solo lectura (crea un túnel para aplicar)'}
      </Text>

      {listRows.length === 0 ? (
        <Text color="yellow">
          No se encontraron labels {onlyCustom ? 'custom ' : ''}en los agentes worker.
        </Text>
      ) : (
        <Box flexDirection="column">
          {visibleRows.map((item, relIdx) => {
            const absIdx = scrollStart + relIdx;
            const isCursor = absIdx === safeCursor;
            return (
              <Text
                key={item.selector ?? '__none__'}
                color={
                  isCursor
                    ? 'cyan'
                    : item.isActive
                      ? 'green'
                      : item.isSystem
                        ? 'gray'
                        : 'white'
                }
                bold={isCursor || item.isActive}
                wrap="truncate-end"
              >
                {isCursor ? '▸ ' : '  '}
                {item.isActive ? '★ ' : '  '}
                {item.display}{' '}
                <Text dimColor={!isCursor} color={item.isSystem ? 'gray' : 'yellow'}>
                  [{item.isSystem ? 'sistema' : 'custom'}]
                </Text>{' '}
                <Text dimColor>
                  → {item.nodesText}
                  {item.selector !== null && item.readyCount === 0 ? ' (NotReady)' : ''}
                </Text>
              </Text>
            );
          })}
        </Box>
      )}

      {listRows.length > maxVisible ? (
        <Text dimColor>
          Mostrando {scrollStart + 1}–{Math.min(listRows.length, scrollStart + maxVisible)} de {listRows.length} (↑/↓)
        </Text>
      ) : null}

      {error ? (
        <Text color="red" bold wrap="truncate-end">
          ✗ {error}
        </Text>
      ) : null}

      <Text dimColor>
        {selectedTunnel ? '(Enter) Aplicar al túnel · ' : ''}
        (s) {onlyCustom ? 'Mostrar todos' : 'Solo custom'} · (↑/↓) Navegar · (Esc / l) Cerrar
      </Text>
    </Box>
  );
};
