import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { OperationStepLog, TunnelInfo } from '../types/k8s.js';
import { extractTunnelToken } from '../utils/validation.js';
import { rotateTunnelToken } from '../services/tunnels.js';
import { TextInput } from './TextInput.js';
import { StepList } from './StepList.js';

export interface RotateTokenModalProps {
  tunnel: TunnelInfo;
  onRotated: (message: string) => void;
  onCancel: () => void;
}

export const RotateTokenModal: React.FC<RotateTokenModalProps> = ({
  tunnel,
  onRotated,
  onCancel,
}) => {
  const [rawToken, setRawToken] = useState('');
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<OperationStepLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  const tokenCheck = useMemo(
    () => (rawToken ? extractTunnelToken(rawToken) : null),
    [rawToken],
  );

  const handleSubmit = async () => {
    if (running) return;
    const check = extractTunnelToken(rawToken);
    if (!check.valid) {
      setError(check.error ?? 'Token inválido.');
      return;
    }

    setError(null);
    setRunning(true);
    try {
      await rotateTunnelToken({
        tunnel,
        rawToken,
        onProgress: (progress) => setSteps(progress),
      });
      onRotated(`Token rotado correctamente para "${tunnel.name}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  };

  useInput(
    (_input, key) => {
      if (running) return;
      if (key.escape) onCancel();
    },
    { isActive: !running },
  );

  if (running) {
    return (
      <Box
        borderStyle="round"
        borderColor="magenta"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color="magenta">
          Rotando token de "{tunnel.name}"...
        </Text>
        <StepList steps={steps} />
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor="magenta"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="magenta">
        Rotar token: {tunnel.name} ({tunnel.namespace})
      </Text>
      <Box>
        <Text>Nuevo token: </Text>
        <TextInput
          value={rawToken}
          onChange={(val) => {
            setRawToken(val);
            setError(null);
          }}
          onSubmit={() => {
            void handleSubmit();
          }}
          focus={!running}
          placeholder="pega token o comando Zero Trust (Ctrl+U limpia)"
          mask
        />
        {tokenCheck ? (
          tokenCheck.valid ? (
            <Text color="green">
              {'  '}✓ {tokenCheck.token.length}c
              {tokenCheck.extractedFromCommand ? ' (extraído)' : ''}
            </Text>
          ) : (
            <Text color="red">  ✗ {tokenCheck.error}</Text>
          )
        ) : null}
      </Box>

      {error ? (
        <Text color="red" bold wrap="truncate-end">
          ✗ {error}
        </Text>
      ) : null}

      <Text dimColor>(Enter) Actualizar Secret por stdin y reiniciar · (Esc) Cancelar</Text>
    </Box>
  );
};
