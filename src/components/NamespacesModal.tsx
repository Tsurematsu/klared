import React, { useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type {
  NamespaceMeta,
  NodeAgentInfo,
  OperationStepLog,
  TunnelInfo,
} from '../types/k8s.js';
import {
  formatNodeSelectorDisplay,
  getSelectableNamespaces,
} from '../utils/validation.js';
import { migrateTunnelNamespace } from '../services/tunnels.js';
import { StepList } from './StepList.js';

export interface NamespacesModalProps {
  namespaces: NamespaceMeta[];
  nodes: NodeAgentInfo[];
  tunnels: TunnelInfo[];
  selectedTunnel: TunnelInfo | null;
  onMigrated: (message: string, targetNamespace: string) => void;
  onClose: () => void;
}

export const NamespacesModal: React.FC<NamespacesModalProps> = ({
  namespaces,
  nodes,
  tunnels,
  selectedTunnel,
  onMigrated,
  onClose,
}) => {
  const { rows } = useWindowSize();
  const [showSystem, setShowSystem] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<OperationStepLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  const visibleList = useMemo(() => {
    const selectable = getSelectableNamespaces(namespaces);
    if (!showSystem) return selectable;
    const system = namespaces
      .filter((ns) => ns.isSystem)
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...selectable, ...system];
  }, [namespaces, showSystem]);

  const safeCursor = Math.min(cursor, Math.max(0, visibleList.length - 1));
  const managedCount = namespaces.filter((n) => n.isManaged).length;

  const handleApply = async () => {
    if (!selectedTunnel || running) return;
    const target = visibleList[safeCursor];
    if (!target) return;

    if (target.isSystem) {
      setError(`"${target.name}" es un namespace de sistema y no admite túneles.`);
      return;
    }
    if (target.name === selectedTunnel.namespace) {
      onClose();
      return;
    }

    setError(null);
    setRunning(true);
    try {
      const res = await migrateTunnelNamespace({
        tunnel: selectedTunnel,
        targetNamespace: target.name,
        allNodes: nodes,
        namespaces,
        existingTunnels: tunnels,
        onProgress: (progress) => setSteps(progress),
      });
      onMigrated(
        `Túnel "${selectedTunnel.name}" movido al namespace "${res.targetNamespace}" sin corte.`,
        res.targetNamespace,
      );
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
        setShowSystem((prev) => !prev);
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
        setCursor((prev) =>
          Math.min(Math.max(0, visibleList.length - 1), prev + 1),
        );
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
    const chosen = visibleList[safeCursor];
    return (
      <Box
        borderStyle="round"
        borderColor="yellow"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color="yellow">
          Moviendo "{selectedTunnel.name}" ({selectedTunnel.namespace} → {chosen?.name})...
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
      Math.max(0, visibleList.length - maxVisible),
    ),
  );
  const sliced = visibleList.slice(scrollStart, scrollStart + maxVisible);

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan" wrap="truncate-end">
        Namespaces del clúster ({managedCount} k3access · default permitido)
        {selectedTunnel ? ` · túnel: ${selectedTunnel.name}` : ''}
      </Text>

      <Text dimColor wrap="truncate-end">
        {selectedTunnel
          ? `Actual: ${selectedTunnel.namespace} · elige destino y pulsa Enter para mover sin corte`
          : 'Solo lectura — crea un túnel con (n) para vincularlo a un namespace'}
      </Text>

      {visibleList.length === 0 ? (
        <Text color="yellow">No hay namespaces disponibles.</Text>
      ) : (
        <Box flexDirection="column">
          {sliced.map((ns, relIdx) => {
            const absIdx = scrollStart + relIdx;
            const isCursor = absIdx === safeCursor;
            const isCurrent = selectedTunnel?.namespace === ns.name;
            const badge = ns.isManaged
              ? 'k3access'
              : ns.isDefault
                ? 'default'
                : ns.isSystem
                  ? 'sistema'
                  : 'usuario';
            const badgeColor = ns.isManaged
              ? 'green'
              : ns.isDefault
                ? 'cyan'
                : ns.isSystem
                  ? 'gray'
                  : 'white';

            return (
              <Text
                key={ns.name}
                color={
                  isCursor
                    ? 'cyan'
                    : isCurrent
                      ? 'green'
                      : ns.isSystem
                        ? 'gray'
                        : 'white'
                }
                bold={isCursor || isCurrent}
                wrap="truncate-end"
              >
                {isCursor ? '▸ ' : '  '}
                {isCurrent ? '★ ' : '  '}
                {ns.name}{' '}
                <Text color={badgeColor}>[{badge}]</Text>
                {ns.toolLabels.length > 0 ? (
                  <Text color="yellow"> · tools: {ns.toolLabels.join(', ')}</Text>
                ) : null}
                {ns.nodeSelector ? (
                  <Text dimColor>
                    {' '}
                    · afinidad: {formatNodeSelectorDisplay(ns.nodeSelector)}
                  </Text>
                ) : null}
                {ns.description ? (
                  <Text dimColor> · {ns.description}</Text>
                ) : null}
              </Text>
            );
          })}
        </Box>
      )}

      {visibleList.length > maxVisible ? (
        <Text dimColor>
          Mostrando {scrollStart + 1}–{Math.min(visibleList.length, scrollStart + maxVisible)} de {visibleList.length} (↑/↓)
        </Text>
      ) : null}

      {error ? (
        <Text color="red" bold wrap="truncate-end">
          ✗ {error}
        </Text>
      ) : null}

      <Text dimColor>
        {selectedTunnel ? '(Enter) Mover túnel a este namespace · ' : ''}
        (s) {showSystem ? 'Ocultar sistema' : 'Ver sistema'} · (↑/↓) Navegar · (Esc / l) Cerrar
      </Text>
    </Box>
  );
};
