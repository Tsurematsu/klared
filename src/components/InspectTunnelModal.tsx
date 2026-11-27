import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { TunnelInfo } from '../types/k8s.js';
import { formatNodeSelectorDisplay } from '../utils/validation.js';
import { fetchTunnelLogs } from '../services/tunnels.js';
import { copyToClipboard } from '../services/clipboard.js';

export interface InspectTunnelModalProps {
  tunnel: TunnelInfo;
  onClose: () => void;
  onOpenEdit: () => void;
  onOpenRotateToken: () => void;
}

export const InspectTunnelModal: React.FC<InspectTunnelModalProps> = ({
  tunnel,
  onClose,
  onOpenEdit,
  onOpenRotateToken,
}) => {
  const { rows } = useWindowSize();
  const [logs, setLogs] = useState<string[]>(['Cargando logs...']);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  const loadLogs = useCallback(async () => {
    setLoadingLogs(true);
    const lines = await fetchTunnelLogs(tunnel, 20);
    setLogs(lines);
    setLoadingLogs(false);
  }, [tunnel]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  useInput((input, key) => {
    const lower = input.toLowerCase();
    if (key.escape || lower === 'q') {
      onClose();
      return;
    }
    if (lower === 'r') {
      void loadLogs();
      return;
    }
    if (lower === 'e') {
      onOpenEdit();
      return;
    }
    if (lower === 't') {
      onOpenRotateToken();
      return;
    }
    if (lower === 'c') {
      const firstUrl = tunnel.services[0]?.suggestedUrls[0];
      if (!firstUrl) {
        setCopyMsg('No hay Services TCP en este namespace.');
        return;
      }
      void copyToClipboard(firstUrl).then((res) => {
        setCopyMsg(
          res.ok
            ? `Copiado (${res.method}): ${firstUrl}`
            : (res.error ?? 'No se pudo copiar.'),
        );
      });
    }
  });

  const hasUnreadyRunningPod = tunnel.pods.some(
    (p) => p.phase === 'Running' && !p.ready,
  );
  const pendingPods = tunnel.pods.filter((p) => p.phase === 'Pending');
  const maxLogLines = Math.max(3, Math.min(8, (rows || 24) - 16));
  const svcUrls = tunnel.services.flatMap((s) => s.suggestedUrls);

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan" wrap="truncate-end">
        Inspección: {tunnel.name} ({tunnel.resourceName}) · ns:{tunnel.namespace} · id:{tunnel.tunnelId}
      </Text>

      <Text wrap="truncate-end">
        <Text bold>{tunnel.statusLabel}</Text> ({tunnel.readyReplicas}/{tunnel.replicas}) · img:{' '}
        <Text dimColor>{tunnel.imageVersion}</Text> · permitidos:{' '}
        <Text color={tunnel.allowedAgents.length > 0 ? 'green' : 'red'}>
          {tunnel.allowedAgents.join(', ') || 'NINGUNO'}
        </Text>
      </Text>

      <Text dimColor wrap="truncate-end">
        Labels: {tunnel.nodeLabelKey} · {tunnel.namespaceLabelKey}
        {tunnel.namespaceNodeSelector
          ? ` · ns-afinidad: ${formatNodeSelectorDisplay(tunnel.namespaceNodeSelector)}`
          : ''}
        {tunnel.description ? ` · "${tunnel.description}"` : ''}
      </Text>

      {tunnel.crossNodeTrafficWarning ? (
        <Text color="cyan" wrap="truncate-end">
          ℹ Tailnet: túnel en [{tunnel.runningAgents.join(',')}] · app en [{tunnel.appPodNodes.join(',')}].
        </Text>
      ) : null}

      {/* Pods */}
      <Text bold color="white">
        Pods ({tunnel.pods.length}):
      </Text>
      {tunnel.pods.length === 0 ? (
        <Text dimColor>
          {'  '}
          {tunnel.replicas === 0 ? 'Pausado (0 réplicas).' : 'Sin pods reportados.'}
        </Text>
      ) : (
        tunnel.pods.slice(0, 3).map((pod) => (
          <Box key={pod.name} flexDirection="column">
            <Text wrap="truncate-end">
              {'  '}
              <Text color={pod.ready ? 'green' : pod.phase === 'Pending' ? 'yellow' : 'red'}>
                {pod.ready ? '●' : '◐'}
              </Text>{' '}
              {pod.name} @ <Text color="cyan">{pod.nodeName ?? 'sin nodo'}</Text> · {pod.phase} · /ready:
              <Text color={pod.ready ? 'green' : 'yellow'}>{pod.ready ? 'OK' : 'NO'}</Text> · R:{pod.restarts}
              {pod.waitingReason ? ` (${pod.waitingReason})` : ''}
            </Text>
            {pod.pendingMessage ? (
              <Text color="yellow" wrap="truncate-end">
                {'    '}↳ {pod.pendingMessage}
              </Text>
            ) : null}
          </Box>
        ))
      )}

      {pendingPods.length > 0 ? (
        <Text color="yellow" wrap="truncate-end">
          ⚠ Pending: revisa afinidad/labels y corrige con (e).
        </Text>
      ) : hasUnreadyRunningPod ? (
        <Text color="yellow" wrap="truncate-end">
          ⚠ /ready=NO: revisa logs abajo; si el token es inválido, rótalo con (t).
        </Text>
      ) : null}

      {/* Services */}
      <Text wrap="truncate-end">
        <Text bold>Services ({tunnel.services.length}):</Text>{' '}
        {svcUrls.length > 0 ? (
          <Text color="green">{svcUrls.slice(0, 3).join(' · ')}</Text>
        ) : (
          <Text dimColor>ninguno en "{tunnel.namespace}"</Text>
        )}
      </Text>

      {/* Logs */}
      <Text bold>
        Logs {loadingLogs ? '(cargando...)' : `(últimas ${Math.min(logs.length, maxLogLines)} líneas)`}:
      </Text>
      {logs.slice(-maxLogLines).map((line, idx) => (
        <Text key={idx} dimColor wrap="truncate-end">
          {'  '}
          {line}
        </Text>
      ))}

      {copyMsg ? <Text color="green">✓ {copyMsg}</Text> : null}

      <Text dimColor>
        (e) Agentes · (t) Token · (c) Copiar URL · (r) Logs · (Esc/q) Volver
      </Text>
    </Box>
  );
};
