import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type {
  NodeAgentInfo,
  OperationStepLog,
  TunnelInfo,
} from '../types/k8s.js';
import { deleteTunnel } from '../services/tunnels.js';
import { TextInput } from './TextInput.js';
import { StepList } from './StepList.js';

export interface DeleteTunnelModalProps {
  tunnel: TunnelInfo;
  allNodes: NodeAgentInfo[];
  onDeleted: (name: string) => void;
  onCancel: () => void;
}

export const DeleteTunnelModal: React.FC<DeleteTunnelModalProps> = ({
  tunnel,
  allNodes,
  onDeleted,
  onCancel,
}) => {
  const [confirmName, setConfirmName] = useState('');
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done'>('confirm');
  const [steps, setSteps] = useState<OperationStepLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  const nodesWithLabel = allNodes
    .filter((n) => n.labels[tunnel.nodeLabelKey] !== undefined)
    .map((n) => n.name);

  const handleDelete = async () => {
    if (phase !== 'confirm') return;
    if (confirmName.trim() !== tunnel.name) {
      setError(`Debes escribir exactamente "${tunnel.name}" para confirmar.`);
      return;
    }

    setError(null);
    setPhase('running');
    try {
      await deleteTunnel({
        tunnel,
        allNodes,
        onProgress: (progress) => setSteps(progress),
      });
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('confirm');
    }
  };

  useInput(
    (input, key) => {
      if (phase === 'running') return;
      if (phase === 'done') {
        if (key.return || key.escape || input.toLowerCase() === 'q') {
          onDeleted(tunnel.name);
        }
        return;
      }
      if (key.escape) {
        onCancel();
      }
    },
    { isActive: phase !== 'running' },
  );

  if (phase === 'running') {
    return (
      <Box
        borderStyle="round"
        borderColor="red"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color="red">
          Eliminando "{tunnel.name}" y limpiando labels...
        </Text>
        <StepList steps={steps} />
      </Box>
    );
  }

  if (phase === 'done') {
    return (
      <Box
        borderStyle="round"
        borderColor="green"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color="green">
          ✓ Túnel "{tunnel.name}" eliminado (clúster sin labels huérfanos)
        </Text>
        <Text color="yellow">
          ⚠ Recuerda quitar manualmente las rutas/hostnames en Cloudflare Zero Trust (el túnel sigue existiendo en tu cuenta).
        </Text>
        <Text dimColor>(Enter / Esc) Volver</Text>
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor="red"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="red">
        Eliminar túnel: {tunnel.name} (ns: {tunnel.namespace})
      </Text>
      <Text dimColor wrap="truncate-end">
        Borrará: Deployment + Secret ({tunnel.resourceName}), {tunnel.nodeLabelKey} en [{nodesWithLabel.join(',') || '∅'}] y {tunnel.namespaceLabelKey} en ns.
      </Text>

      <Box>
        <Text>
          Confirmar escribiendo <Text bold color="red">{tunnel.name}</Text>:{' '}
        </Text>
        <TextInput
          value={confirmName}
          onChange={(val) => {
            setConfirmName(val);
            setError(null);
          }}
          onSubmit={() => {
            void handleDelete();
          }}
          focus={phase === 'confirm'}
          placeholder={tunnel.name}
        />
      </Box>

      {error ? (
        <Text color="red" bold wrap="truncate-end">
          ✗ {error}
        </Text>
      ) : null}

      <Text dimColor>(Enter) Eliminar · (Esc) Cancelar</Text>
    </Box>
  );
};
