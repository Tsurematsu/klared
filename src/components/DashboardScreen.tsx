import React from 'react';
import { Box, Text, useWindowSize } from 'ink';
import type { TunnelInfo } from '../types/k8s.js';

export interface DashboardScreenProps {
  tunnels: TunnelInfo[];
  selectedIndex: number;
  error: string | null;
}

function fitText(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) {
    return text.padEnd(width);
  }
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

function statusColor(status: TunnelInfo['status']): string {
  switch (status) {
    case 'ready':
      return 'green';
    case 'paused':
      return 'magenta';
    case 'rolling':
      return 'cyan';
    case 'pending':
      return 'yellow';
    case 'error':
      return 'red';
  }
}

function formatNodesColumn(tunnel: TunnelInfo): string {
  const running =
    tunnel.replicas === 0
      ? '(pausa)'
      : tunnel.runningAgents.length > 0
        ? tunnel.runningAgents.join(',')
        : 'Pending';
  const allowed =
    tunnel.allowedAgents.length > 0
      ? tunnel.allowedAgents.join(',')
      : 'SIN AGENTES';
  return `${running} [${allowed}]`;
}

export const DashboardScreen: React.FC<DashboardScreenProps> = ({
  tunnels,
  selectedIndex,
  error,
}) => {
  const { columns, rows } = useWindowSize();
  const termWidth = Math.max(72, (columns || 100) - 6);
  const compact = termWidth < 96;

  const colName = compact ? 13 : 16;
  const colNs = compact ? 12 : 14;
  const colId = 7;
  const colStatus = compact ? 10 : 12;
  const colRep = 4;
  const colVer = compact ? 8 : 10;
  const colNodes = Math.max(
    14,
    termWidth - (colName + colNs + colId + colStatus + colRep + colVer + 9),
  );

  // Reserve lines for header (3), table chrome (4), detail strip (2), footer (4)
  const maxVisibleRows = Math.max(4, (rows || 24) - 13);
  const scrollStart = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisibleRows / 2),
      Math.max(0, tunnels.length - maxVisibleRows),
    ),
  );
  const visibleTunnels = tunnels.slice(scrollStart, scrollStart + maxVisibleRows);
  const selected = tunnels[selectedIndex] ?? null;

  return (
    <Box flexDirection="column">
      {error ? (
        <Box paddingX={1}>
          <Text color="red" wrap="truncate-end">
            ✗ Error sincronizando: {error}
          </Text>
        </Box>
      ) : null}

      <Box
        borderStyle="round"
        borderColor="gray"
        flexDirection="column"
        paddingX={1}
      >
        <Box>
          <Text bold dimColor>
            {'  '}
            {fitText('TÚNEL', colName)}{' '}
            {fitText('NAMESPACE', colNs)}{' '}
            {fitText('ID', colId)}{' '}
            {fitText('ESTADO', colStatus)}{' '}
            {fitText('REP', colRep)}{' '}
            {fitText('NODOS (ACTUAL [PERM])', colNodes)}{' '}
            {fitText('VER', colVer)}
          </Text>
        </Box>

        <Box>
          <Text dimColor>{'─'.repeat(Math.min(termWidth, 160))}</Text>
        </Box>

        {tunnels.length === 0 ? (
          <Box paddingY={1} flexDirection="column">
            <Text color="yellow" bold>
              No hay túneles gestionados por klared (tsure.io/cloudflared=true).
            </Text>
            <Text dimColor>
              Pulsa <Text color="green" bold>(n)</Text> para crear uno o{' '}
              <Text color="cyan" bold>(a)</Text> para ver agentes y auditoría.
            </Text>
          </Box>
        ) : (
          visibleTunnels.map((tunnel, relIdx) => {
            const absIdx = scrollStart + relIdx;
            const isSelected = absIdx === selectedIndex;
            const repText = `${tunnel.readyReplicas}/${tunnel.replicas}`;
            const nodesText = formatNodesColumn(tunnel);

            return (
              <Box key={`${tunnel.namespace}/${tunnel.resourceName}`}>
                <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                  {isSelected ? '▸ ' : '  '}
                  {fitText(tunnel.name, colName)}
                </Text>
                <Text> </Text>
                <Text color={isSelected ? 'cyan' : 'white'}>
                  {fitText(tunnel.namespace, colNs)}
                </Text>
                <Text> </Text>
                <Text color="yellow">{fitText(tunnel.tunnelId, colId)}</Text>
                <Text> </Text>
                <Text color={statusColor(tunnel.status)}>
                  {fitText(tunnel.statusLabel, colStatus)}
                </Text>
                <Text> </Text>
                <Text
                  color={
                    tunnel.readyReplicas === tunnel.replicas && tunnel.replicas > 0
                      ? 'green'
                      : 'gray'
                  }
                >
                  {fitText(repText, colRep)}
                </Text>
                <Text> </Text>
                <Text
                  color={
                    tunnel.hasMissingAllowedAgents
                      ? 'red'
                      : isSelected
                        ? 'white'
                        : 'gray'
                  }
                >
                  {fitText(nodesText, colNodes)}
                </Text>
                <Text> </Text>
                <Text dimColor={!isSelected}>
                  {fitText(tunnel.imageVersion, colVer)}
                </Text>
              </Box>
            );
          })
        )}

        {tunnels.length > maxVisibleRows ? (
          <Text dimColor>
            Mostrando {scrollStart + 1}–{Math.min(tunnels.length, scrollStart + maxVisibleRows)} de {tunnels.length} túneles (↑/↓)
          </Text>
        ) : null}
      </Box>

      {/* Tira compacta del túnel seleccionado (máx 2 líneas) */}
      {selected ? (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor wrap="truncate-end">
            <Text color="white" bold>
              {selected.resourceName}
            </Text>
            {' · '}
            <Text color="yellow">{selected.nodeLabelKey}</Text>
            {selected.services[0]?.suggestedUrls[0] ? (
              <>
                {' · '}URL:{' '}
                <Text color="green">{selected.services[0].suggestedUrls[0]}</Text>
                {selected.services.length > 1 ? ` (+${selected.services.length - 1})` : ''}
              </>
            ) : null}
            {selected.description ? ` · ${selected.description}` : ''}
          </Text>

          {selected.hasMissingAllowedAgents ? (
            <Text color="red" wrap="truncate-end">
              ✗ Sin agentes con {selected.nodeLabelKey} — pulsa (e) para reasignar.
            </Text>
          ) : selected.status === 'pending' ? (
            <Text color="yellow" wrap="truncate-end">
              ⚠ Pod en Pending — pulsa (i) para causa o (e) para ajustar agentes.
            </Text>
          ) : selected.crossNodeTrafficWarning ? (
            <Text color="cyan" wrap="truncate-end">
              ℹ Tráfico tailnet: túnel en [{selected.runningAgents.join(',')}] · app en [{selected.appPodNodes.join(',')}].
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
};
