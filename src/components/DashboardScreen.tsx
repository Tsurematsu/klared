import React from 'react';
import { Box, Text, useWindowSize } from 'ink';
import type { TunnelInfo } from '../types/k8s.js';
import { formatCompactNodeLabel } from '../utils/validation.js';

export type DashboardFocusArea = 'table' | 'panel';
export type QuickPanelItem = 'agents' | 'move' | 'replicas' | 'label';

export const QUICK_PANEL_ITEMS: readonly QuickPanelItem[] = [
  'agents',
  'move',
  'replicas',
  'label',
] as const;

export interface QuickPanelState {
  activeItem: QuickPanelItem;
  moveTarget: string | null;
  moveOptionsCount: number;
  moveDirty: boolean;
  draftReplicas: number;
  maxReplicas: number;
  replicasDirty: boolean;
  draftLabel: string | null;
  draftLabelShort: string;
  labelOptionsCount: number;
  labelDirty: boolean;
  busyText: string | null;
}

export interface DashboardScreenProps {
  tunnels: TunnelInfo[];
  selectedIndex: number;
  focusArea: DashboardFocusArea;
  panelState: QuickPanelState | null;
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

function formatAgentsPreview(agents: string[], maxChars: number): string {
  if (agents.length === 0) return 'NINGUNO';
  const joined = agents.join(', ');
  if (joined.length <= maxChars) return joined;
  if (agents.length <= 2) {
    return `${joined.slice(0, Math.max(4, maxChars - 1))}…`;
  }
  const firstTwo = `${agents[0]}, ${agents[1]} +${agents.length - 2}`;
  if (firstTwo.length <= maxChars) return firstTwo;
  return `${agents[0]} +${agents.length - 1}`;
}

export const DashboardScreen: React.FC<DashboardScreenProps> = ({
  tunnels,
  selectedIndex,
  focusArea,
  panelState,
  error,
}) => {
  const { columns, rows } = useWindowSize();
  const termWidth = Math.max(72, (columns || 100) - 6);
  const compact = termWidth < 96;
  const twoColumns = termWidth >= 82;

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

  // Reserve lines for header (3), table chrome (4), quick panel (6-8), footer (4)
  const panelReserve = tunnels.length > 0 ? (twoColumns ? 7 : 9) : 2;
  const maxVisibleRows = Math.max(3, (rows || 24) - (11 + panelReserve));
  const scrollStart = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisibleRows / 2),
      Math.max(0, tunnels.length - maxVisibleRows),
    ),
  );
  const visibleTunnels = tunnels.slice(scrollStart, scrollStart + maxVisibleRows);
  const selected = tunnels[selectedIndex] ?? null;

  const tableFocused = focusArea === 'table';
  const panelFocused = focusArea === 'panel';

  const hasAnyDirty = Boolean(
    panelState &&
      (panelState.moveDirty || panelState.replicasDirty || panelState.labelDirty),
  );

  const cellWidth = twoColumns ? Math.floor((termWidth - 4) / 2) : termWidth - 2;
  const valuePreviewMax = Math.max(12, cellWidth - 15);

  const renderPanelItem = (
    item: QuickPanelItem,
    label: string,
    valueText: string,
    options: {
      dirty?: boolean;
      canSlide?: boolean;
      valueColor?: string;
    } = {},
  ) => {
    const isFocused = panelFocused && panelState?.activeItem === item;
    const { dirty = false, canSlide = false, valueColor } = options;
    const prefix = isFocused ? '▸ ' : '  ';
    const bracketColor = isFocused
      ? dirty
        ? 'yellow'
        : 'cyan'
      : dirty
        ? 'yellow'
        : 'gray';
    const displayVal = canSlide ? `<${valueText}>` : valueText;

    return (
      <Box width={twoColumns ? cellWidth : undefined}>
        <Text color={bracketColor} bold={isFocused} wrap="truncate-end">
          {prefix}[
          <Text color={isFocused ? 'cyan' : 'white'} bold={isFocused}>
            {label}:
          </Text>{' '}
          <Text
            color={
              dirty
                ? 'yellow'
                : valueColor ?? (isFocused ? 'green' : 'white')
            }
            bold={isFocused || dirty}
          >
            {displayVal}
          </Text>
          {dirty ? <Text color="yellow">*</Text> : null}]
        </Text>
      </Box>
    );
  };

  const renderPanelHint = () => {
    if (!selected || !panelState) return null;

    if (panelState.busyText) {
      return (
        <Text color="yellow" bold wrap="truncate-end">
          ⟳ {panelState.busyText}
        </Text>
      );
    }

    if (panelFocused) {
      switch (panelState.activeItem) {
        case 'agents':
          return (
            <Text color="cyan" wrap="truncate-end">
              ⏎ Enter abre el modal de multiselección de agentes permitidos.
            </Text>
          );
        case 'move':
          if (selected.replicas === 0) {
            return (
              <Text color="magenta" wrap="truncate-end">
                Túnel pausado — reactívalo en Inspección (i) → (p) antes de mover.
              </Text>
            );
          }
          if (panelState.moveDirty && panelState.moveTarget) {
            return (
              <Text color="yellow" bold wrap="truncate-end">
                ⏎ Enter moverá "{selected.name}" a {panelState.moveTarget} sin corte (Esc cancela).
              </Text>
            );
          }
          return (
            <Text dimColor wrap="truncate-end">
              {panelState.moveOptionsCount > 1
                ? 'Usa ←/→ para elegir otro agente permitido Ready y Enter para mover.'
                : 'Solo 1 agente permitido Ready — edita Agentes para añadir otro destino.'}
            </Text>
          );
        case 'replicas':
          if (panelState.replicasDirty) {
            return (
              <Text color="yellow" bold wrap="truncate-end">
                ⏎ Enter escalará "{selected.name}" a {panelState.draftReplicas} réplica
                {panelState.draftReplicas === 1 ? '' : 's'} (máx {panelState.maxReplicas}).
              </Text>
            );
          }
          return (
            <Text dimColor wrap="truncate-end">
              Usa ←/→ para ajustar réplicas (1..{panelState.maxReplicas}) y Enter para aplicar.
            </Text>
          );
        case 'label':
          if (panelState.labelDirty) {
            return (
              <Text color="yellow" bold wrap="truncate-end">
                ⏎ Enter aplicará afinidad de nodo:{' '}
                {panelState.draftLabel ?? 'ninguno (quitar label)'}.
              </Text>
            );
          }
          return (
            <Text dimColor wrap="truncate-end">
              {panelState.labelOptionsCount > 1
                ? 'Usa ←/→ para elegir label y Enter para aplicar · pulsa (l) para ver todos.'
                : 'Sin labels custom detectados en nodos · pulsa (l) para ver todos los labels.'}
            </Text>
          );
      }
    }

    // When table is focused, show alerts or concise tunnel metadata
    if (selected.hasMissingAllowedAgents) {
      return (
        <Text color="red" wrap="truncate-end">
          ✗ Sin agentes con {selected.nodeLabelKey} — pulsa Tab → Agentes para reasignar.
        </Text>
      );
    }
    if (selected.status === 'pending') {
      return (
        <Text color="yellow" wrap="truncate-end">
          ⚠ Pod en Pending — pulsa (i) para diagnóstico o Tab para ajustar agentes/label.
        </Text>
      );
    }
    if (selected.crossNodeTrafficWarning) {
      return (
        <Text color="cyan" wrap="truncate-end">
          ℹ Tráfico tailnet: túnel en [{selected.runningAgents.join(',')}] · app en [{selected.appPodNodes.join(',')}].
        </Text>
      );
    }
    return (
      <Text dimColor wrap="truncate-end">
        <Text color="white">{selected.resourceName}</Text>
        {' · '}
        <Text color="yellow">{selected.nodeLabelKey}</Text>
        {selected.extraNodeLabel ? (
          <>
            {' · '}label:{' '}
            <Text color="yellow">{formatCompactNodeLabel(selected.extraNodeLabel)}</Text>
          </>
        ) : null}
        {selected.services[0]?.suggestedUrls[0] ? (
          <>
            {' · '}URL:{' '}
            <Text color="green">{selected.services[0].suggestedUrls[0]}</Text>
            {selected.services.length > 1 ? ` (+${selected.services.length - 1})` : ''}
          </>
        ) : null}
        {selected.description ? ` · ${selected.description}` : ''}
      </Text>
    );
  };

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
        borderColor={tableFocused ? 'cyan' : 'gray'}
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
              Pulsa <Text color="green" bold>(n)</Text> para crear uno,{' '}
              <Text color="cyan" bold>(l)</Text> para ver labels de nodos o{' '}
              <Text color="yellow" bold>(a)</Text> para auditoría.
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
                <Text
                  color={isSelected ? (tableFocused ? 'cyan' : 'white') : undefined}
                  bold={isSelected}
                >
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

      {/* Panel de controles rápidos del túnel seleccionado */}
      {selected && panelState ? (
        <Box
          borderStyle="round"
          borderColor={panelFocused ? (hasAnyDirty ? 'yellow' : 'cyan') : 'gray'}
          flexDirection="column"
          paddingX={1}
        >
          <Box justifyContent="space-between">
            <Text bold color={panelFocused ? 'cyan' : 'white'} wrap="truncate-end">
              Controles: {selected.name}
              <Text dimColor> ({selected.namespace})</Text>
            </Text>
            <Text dimColor wrap="truncate-end">
              {panelFocused
                ? '↑/↓ ítem · ←/→ valor · Enter aplicar · Esc tabla'
                : 'Tab → controles · Enter/i → inspección'}
            </Text>
          </Box>

          {twoColumns ? (
            <>
              <Box>
                {renderPanelItem(
                  'agents',
                  'Agentes',
                  formatAgentsPreview(selected.allowedAgents, valuePreviewMax),
                  {
                    valueColor:
                      selected.allowedAgents.length > 0 ? 'green' : 'red',
                  },
                )}
                {renderPanelItem(
                  'move',
                  'Mover',
                  selected.replicas === 0
                    ? 'pausado'
                    : (panelState.moveTarget ?? 'sin Ready'),
                  {
                    canSlide: selected.replicas > 0,
                    dirty: panelState.moveDirty,
                    valueColor:
                      selected.replicas === 0
                        ? 'magenta'
                        : panelState.moveTarget
                          ? 'cyan'
                          : 'gray',
                  },
                )}
              </Box>
              <Box>
                {renderPanelItem(
                  'replicas',
                  'Réplicas',
                  panelState.draftReplicas === 0
                    ? '0 (pausa)'
                    : `${panelState.draftReplicas}/${panelState.maxReplicas}`,
                  {
                    canSlide: true,
                    dirty: panelState.replicasDirty,
                    valueColor:
                      panelState.draftReplicas === 0 ? 'magenta' : 'green',
                  },
                )}
                {renderPanelItem('label', 'Label', panelState.draftLabelShort, {
                  canSlide: true,
                  dirty: panelState.labelDirty,
                  valueColor: panelState.draftLabel ? 'yellow' : 'gray',
                })}
              </Box>
            </>
          ) : (
            <Box flexDirection="column">
              {renderPanelItem(
                'agents',
                'Agentes',
                formatAgentsPreview(selected.allowedAgents, valuePreviewMax),
                {
                  valueColor:
                    selected.allowedAgents.length > 0 ? 'green' : 'red',
                },
              )}
              {renderPanelItem(
                'move',
                'Mover',
                selected.replicas === 0
                  ? 'pausado'
                  : (panelState.moveTarget ?? 'sin Ready'),
                {
                  canSlide: selected.replicas > 0,
                  dirty: panelState.moveDirty,
                  valueColor:
                    selected.replicas === 0
                      ? 'magenta'
                      : panelState.moveTarget
                        ? 'cyan'
                        : 'gray',
                },
              )}
              {renderPanelItem(
                'replicas',
                'Réplicas',
                panelState.draftReplicas === 0
                  ? '0 (pausa)'
                  : `${panelState.draftReplicas}/${panelState.maxReplicas}`,
                {
                  canSlide: true,
                  dirty: panelState.replicasDirty,
                  valueColor:
                    panelState.draftReplicas === 0 ? 'magenta' : 'green',
                },
              )}
              {renderPanelItem('label', 'Label', panelState.draftLabelShort, {
                canSlide: true,
                dirty: panelState.labelDirty,
                valueColor: panelState.draftLabel ? 'yellow' : 'gray',
              })}
            </Box>
          )}

          {renderPanelHint()}
        </Box>
      ) : null}
    </Box>
  );
};
