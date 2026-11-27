import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type {
  NodeAgentInfo,
  OrphanAuditReport,
  TunnelInfo,
} from '../types/k8s.js';
import { cleanupOrphanLabels } from '../services/tunnels.js';
import { TextInput } from './TextInput.js';

export interface AgentsAuditModalProps {
  nodes: NodeAgentInfo[];
  tunnels: TunnelInfo[];
  orphans: OrphanAuditReport;
  onCleaned: (summary: string) => void;
  onClose: () => void;
}

export const AgentsAuditModal: React.FC<AgentsAuditModalProps> = ({
  nodes,
  tunnels,
  orphans,
  onCleaned,
  onClose,
}) => {
  const [confirmMode, setConfirmMode] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanableCount =
    orphans.orphanNodeLabels.length + orphans.orphanNamespaceLabels.length;

  const handleClean = async () => {
    if (cleaning) return;
    if (confirmText.trim().toUpperCase() !== 'LIMPIAR') {
      setError('Escribe exactamente LIMPIAR para retirar los labels huérfanos.');
      return;
    }
    setError(null);
    setCleaning(true);
    try {
      const res = await cleanupOrphanLabels({
        orphanNodeLabels: orphans.orphanNodeLabels,
        orphanNamespaceLabels: orphans.orphanNamespaceLabels,
      });
      onCleaned(
        `Limpieza OK: ${res.removedNodes} label(s) de nodo y ${res.removedNamespaces} de namespace retirados.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCleaning(false);
    }
  };

  useInput(
    (input, key) => {
      if (cleaning) return;
      if (key.escape) {
        if (confirmMode) {
          setConfirmMode(false);
          setConfirmText('');
          setError(null);
        } else {
          onClose();
        }
        return;
      }
      if (!confirmMode) {
        const lower = input.toLowerCase();
        if (lower === 'q' || lower === 'a') {
          onClose();
          return;
        }
        if (lower === 'l' && cleanableCount > 0) {
          setConfirmMode(true);
          setError(null);
        }
      }
    },
    { isActive: !cleaning },
  );

  const workerAgents = nodes.filter((n) => !n.isControlPlane);
  const controlPlanes = nodes.filter((n) => n.isControlPlane);

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        Agentes k3s y Auditoría de huérfanos
      </Text>

      {workerAgents.map((agent) => {
        const runningHere = tunnels
          .filter((t) => t.runningAgents.includes(agent.name))
          .map((t) => t.name);
        return (
          <Text key={agent.name} wrap="truncate-end">
            <Text color={agent.ready ? 'green' : 'red'}>
              {agent.ready ? '●' : '○'}
            </Text>{' '}
            <Text bold>{agent.name}</Text> [{agent.status}] {agent.internalIp} · labels:{' '}
            <Text color="yellow">
              {agent.cloudflaredIds.length > 0 ? agent.cloudflaredIds.join(',') : '∅'}
            </Text>{' '}
            · pods: <Text color="cyan">{runningHere.join(',') || '∅'}</Text>
          </Text>
        );
      })}

      {controlPlanes.length > 0 ? (
        <Text dimColor wrap="truncate-end">
          Control-plane (excluido): {controlPlanes.map((n) => `${n.name} (${n.status})`).join(', ')}
        </Text>
      ) : null}

      <Text bold color={orphans.totalIssues > 0 ? 'yellow' : 'green'}>
        Auditoría ({orphans.totalIssues} hallazgo{orphans.totalIssues === 1 ? '' : 's'}):
      </Text>

      {orphans.totalIssues === 0 ? (
        <Text color="green">  ✓ Sin labels huérfanos ni Deployments sin agentes válidos.</Text>
      ) : (
        <Box flexDirection="column">
          {orphans.orphanNodeLabels.slice(0, 4).map((item) => (
            <Text key={`${item.nodeName}-${item.labelKey}`} color="yellow" wrap="truncate-end">
              • Nodo {item.nodeName}: {item.labelKey} (sin Deployment)
            </Text>
          ))}
          {orphans.orphanNamespaceLabels.slice(0, 4).map((item) => (
            <Text key={`${item.namespace}-${item.labelKey}`} color="yellow" wrap="truncate-end">
              • NS {item.namespace}: {item.labelKey} (sin Deployment)
            </Text>
          ))}
          {orphans.brokenDeployments.slice(0, 4).map((item) => (
            <Text key={`${item.namespace}/${item.resourceName}`} color="red" wrap="truncate-end">
              • {item.resourceName} ({item.namespace}): {item.reason}
            </Text>
          ))}
        </Box>
      )}

      {confirmMode ? (
        <Box>
          <Text color="magenta" bold>
            Escribe LIMPIAR ({cleanableCount} labels):{' '}
          </Text>
          <TextInput
            value={confirmText}
            onChange={(val) => {
              setConfirmText(val);
              setError(null);
            }}
            onSubmit={() => {
              void handleClean();
            }}
            focus={confirmMode && !cleaning}
            placeholder="LIMPIAR"
          />
        </Box>
      ) : null}

      {error ? (
        <Text color="red" bold wrap="truncate-end">
          ✗ {error}
        </Text>
      ) : null}

      {cleaning ? (
        <Text color="yellow">Limpiando labels huérfanos...</Text>
      ) : confirmMode ? (
        <Text dimColor>(Enter) Confirmar · (Esc) Cancelar</Text>
      ) : (
        <Text dimColor>
          {cleanableCount > 0 ? '(l) Limpiar huérfanos · ' : ''}
          (Esc / a / q) Cerrar
        </Text>
      )}
    </Box>
  );
};
