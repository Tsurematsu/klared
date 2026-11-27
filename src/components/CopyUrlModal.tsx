import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TunnelInfo } from '../types/k8s.js';
import { copyToClipboard } from '../services/clipboard.js';

export interface CopyUrlModalProps {
  tunnel: TunnelInfo;
  onCopied: (message: string) => void;
  onClose: () => void;
}

export const CopyUrlModal: React.FC<CopyUrlModalProps> = ({
  tunnel,
  onCopied,
  onClose,
}) => {
  const entries = useMemo(() => {
    const list: Array<{ service: string; type: string; url: string }> = [];
    for (const svc of tunnel.services) {
      for (const url of svc.suggestedUrls) {
        list.push({ service: svc.name, type: svc.type, url });
      }
    }
    return list;
  }, [tunnel]);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === 'q') {
      onClose();
      return;
    }
    if (entries.length === 0) {
      if (key.return) onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIdx((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((prev) => Math.min(entries.length - 1, prev + 1));
      return;
    }
    if (key.return) {
      const target = entries[selectedIdx];
      if (!target) return;
      void copyToClipboard(target.url).then((res) => {
        if (res.ok) {
          onCopied(`URL copiada (${res.method}): ${target.url}`);
        } else {
          setError(res.error ?? 'No se pudo copiar al portapapeles.');
        }
      });
    }
  });

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="cyan">
        Copiar URL interna de "{tunnel.namespace}" (para Zero Trust)
      </Text>

      {entries.length === 0 ? (
        <Box marginTop={1}>
          <Text color="yellow">
            No hay Services con puertos TCP en el namespace "{tunnel.namespace}".
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {entries.map((entry, idx) => {
            const isSelected = idx === selectedIdx;
            return (
              <Text
                key={`${entry.service}-${entry.url}`}
                color={isSelected ? 'cyan' : 'white'}
                bold={isSelected}
              >
                {isSelected ? '▸ ' : '  '}
                <Text color="green">{entry.url}</Text>{' '}
                <Text dimColor>({entry.service} · {entry.type})</Text>
              </Text>
            );
          })}
        </Box>
      )}

      {error ? (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          {entries.length > 0 ? '(↑/↓) Elegir · (Enter) Copiar · ' : ''}
          (Esc) Cerrar
        </Text>
      </Box>
    </Box>
  );
};
