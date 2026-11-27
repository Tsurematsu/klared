import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { TunnelInfo } from '../types/k8s.js';
import {
  formatCompactNodeLabel,
  formatNodeSelectorDisplay,
} from '../utils/validation.js';
import {
  fetchTunnelLogs,
  restartTunnel,
  togglePauseTunnel,
} from '../services/tunnels.js';
import { copyToClipboard } from '../services/clipboard.js';

export interface InspectTunnelModalProps {
  tunnel: TunnelInfo;
  orphanCount: number;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onOpenEdit: () => void;
  onOpenRotateToken: () => void;
  onOpenAudit: () => void;
  onOpenCopyUrl: () => void;
  onOpenDelete: () => void;
}

export const InspectTunnelModal: React.FC<InspectTunnelModalProps> = ({
  tunnel,
  orphanCount,
  onClose,
  onRefresh,
  onOpenEdit,
  onOpenRotateToken,
  onOpenAudit,
  onOpenCopyUrl,
  onOpenDelete,
}) => {
  const { rows } = useWindowSize();
  const [logs, setLogs] = useState<string[]>(['Cargando logs...']);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: 'info' | 'success' | 'error';
    text: string;
  } | null>(null);

  const loadLogs = useCallback(async () => {
    setLoadingLogs(true);
    const lines = await fetchTunnelLogs(tunnel, 20);
    setLogs(lines);
    setLoadingLogs(false);
  }, [tunnel]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const handleRestart = async () => {
    if (busyAction) return;
    setBusyAction(`Reiniciando "${tunnel.name}"...`);
    setFeedback({ type: 'info', text: `Reiniciando "${tunnel.name}" y esperando /ready...` });
    try {
      await restartTunnel(tunnel);
      await onRefresh();
      await loadLogs();
      setFeedback({
        type: 'success',
        text: `Túnel "${tunnel.name}" reiniciado y Ready.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleTogglePause = async () => {
    if (busyAction) return;
    const willPause = tunnel.replicas > 0;
    setBusyAction(
      willPause
        ? `Pausando "${tunnel.name}" (escalando a 0)...`
        : `Reactivando "${tunnel.name}"...`,
    );
    setFeedback({
      type: 'info',
      text: willPause
        ? `Pausando "${tunnel.name}" (escalando a 0)...`
        : `Reactivando "${tunnel.name}" y esperando /ready...`,
    });
    try {
      const res = await togglePauseTunnel(tunnel);
      await onRefresh();
      setFeedback({
        type: 'success',
        text: res.paused
          ? `Túnel "${tunnel.name}" pausado (Secret y labels conservados).`
          : `Túnel "${tunnel.name}" reactivado (${res.replicas} réplica${res.replicas === 1 ? '' : 's'}).`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  };

  useInput(
    (input, key) => {
      if (busyAction) return;
      const lower = input.toLowerCase();
      if (key.escape || lower === 'q') {
        onClose();
        return;
      }
      if (lower === 'u') {
        void onRefresh().then(() => loadLogs());
        setFeedback({ type: 'info', text: 'Refrescando estado y logs...' });
        return;
      }
      if (lower === 'r') {
        void handleRestart();
        return;
      }
      if (lower === 'p') {
        void handleTogglePause();
        return;
      }
      if (lower === 't') {
        onOpenRotateToken();
        return;
      }
      if (lower === 'a') {
        onOpenAudit();
        return;
      }
      if (lower === 'x') {
        onOpenDelete();
        return;
      }
      if (lower === 'e') {
        onOpenEdit();
        return;
      }
      if (lower === 'c') {
        const allUrls = tunnel.services.flatMap((s) => s.suggestedUrls);
        if (allUrls.length === 0) {
          setFeedback({
            type: 'error',
            text: `No hay Services TCP en "${tunnel.namespace}" para copiar URL.`,
          });
          return;
        }
        if (allUrls.length === 1) {
          const url = allUrls[0]!;
          void copyToClipboard(url).then((res) => {
            setFeedback(
              res.ok
                ? { type: 'success', text: `Copiado (${res.method}): ${url}` }
                : { type: 'error', text: res.error ?? 'No se pudo copiar.' },
            );
          });
          return;
        }
        onOpenCopyUrl();
      }
    },
    { isActive: !busyAction },
  );

  const hasUnreadyRunningPod = tunnel.pods.some(
    (p) => p.phase === 'Running' && !p.ready,
  );
  const pendingPods = tunnel.pods.filter((p) => p.phase === 'Pending');
  const maxLogLines = Math.max(3, Math.min(7, (rows || 24) - 17));
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
        <Text dimColor>{tunnel.imageVersion}</Text> · proto:{' '}
        <Text color="cyan">{tunnel.protocol}</Text> · label:{' '}
        <Text color={tunnel.extraNodeLabel ? 'yellow' : 'gray'}>
          {formatCompactNodeLabel(tunnel.extraNodeLabel)}
        </Text>{' '}
        · permitidos:{' '}
        <Text color={tunnel.allowedAgents.length > 0 ? 'green' : 'red'}>
          {tunnel.allowedAgents.join(', ') || 'NINGUNO'}
        </Text>
      </Text>

      <Text dimColor wrap="truncate-end">
        Labels: {tunnel.nodeLabelKey} · {tunnel.namespaceLabelKey}
        {tunnel.extraNodeLabel ? ` · afinidad: ${tunnel.extraNodeLabel}` : ''}
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

      {busyAction ? (
        <Text color="yellow" bold wrap="truncate-end">
          ⟳ {busyAction}
        </Text>
      ) : feedback ? (
        <Text
          color={
            feedback.type === 'error'
              ? 'red'
              : feedback.type === 'success'
                ? 'green'
                : 'cyan'
          }
          wrap="truncate-end"
        >
          {feedback.type === 'error' ? '✗ ' : feedback.type === 'success' ? '✓ ' : 'ℹ '}
          {feedback.text}
        </Text>
      ) : null}

      <Box flexWrap="wrap">
        <Text color="cyan" bold>(r)</Text>
        <Text>Reiniciar  </Text>
        <Text color="magenta" bold>(p)</Text>
        <Text>{tunnel.replicas === 0 ? 'Activar' : 'Pausar'}  </Text>
        <Text color="magenta" bold>(t)</Text>
        <Text>Token  </Text>
        <Text color={orphanCount > 0 ? 'yellow' : 'cyan'} bold>(a)</Text>
        <Text>{orphanCount > 0 ? `Audit(${orphanCount})` : 'Audit'}  </Text>
        <Text color="green" bold>(c)</Text>
        <Text>URL  </Text>
        <Text color="red" bold>(x)</Text>
        <Text>Borrar  </Text>
        <Text color="cyan" bold>(u)</Text>
        <Text>Logs  </Text>
        <Text dimColor>(Esc/q)Volver</Text>
      </Box>
    </Box>
  );
};
