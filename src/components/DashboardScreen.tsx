import React, { useMemo } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import type {
  ServiceEndpointInfo,
  TunnelInfo,
  ZeroTrustServiceType,
} from '../types/k8s.js';
import { buildZeroTrustUrlEntries } from '../utils/validation.js';

export type DashboardFocusArea = 'table' | 'panel';
export type QuickPanelItem = 'agents' | 'move' | 'replicas' | 'namespace';

export const QUICK_PANEL_ITEMS: readonly QuickPanelItem[] = [
  'agents',
  'move',
  'replicas',
  'namespace',
] as const;

export interface QuickPanelState {
  activeItem: QuickPanelItem;
  moveTarget: string | null;
  moveOptionsCount: number;
  moveDirty: boolean;
  draftReplicas: number;
  maxReplicas: number;
  replicasDirty: boolean;
  draftNamespace: string;
  draftNamespaceBadge: string | null;
  namespaceOptionsCount: number;
  namespaceDirty: boolean;
  busyText: string | null;
}

export interface DashboardScreenProps {
  tunnels: TunnelInfo[];
  clusterServices: ServiceEndpointInfo[];
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

function ztTypeColor(ztType: ZeroTrustServiceType): string {
  switch (ztType) {
    case 'HTTP':
      return 'green';
    case 'HTTPS':
      return 'cyan';
    case 'TCP':
      return 'yellow';
    case 'SSH':
      return 'magenta';
    case 'RDP':
      return 'blue';
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
  clusterServices,
  selectedIndex,
  focusArea,
  panelState,
  error,
}) => {
  const { columns, rows } = useWindowSize();
  const termWidth = Math.max(72, (columns || 100) - 6);
  const compact = termWidth < 96;
  const sideBySide = (columns || 100) >= 104;

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

  // Reserve lines for header (3), table chrome (4), lower panels, footer (4)
  const panelReserve = tunnels.length > 0 ? (sideBySide ? 9 : 13) : 2;
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
      (panelState.moveDirty ||
        panelState.replicasDirty ||
        panelState.namespaceDirty),
  );

  const ztEntries = useMemo(
    () => buildZeroTrustUrlEntries(clusterServices, selected?.namespace ?? null),
    [clusterServices, selected?.namespace],
  );
  const sameNsZtEntries = useMemo(
    () => ztEntries.filter((e) => e.sameNamespace),
    [ztEntries],
  );
  const otherNsZtEntries = useMemo(
    () => ztEntries.filter((e) => !e.sameNamespace),
    [ztEntries],
  );

  const controlsPreviewMax = Math.max(
    16,
    (sideBySide ? Math.floor(termWidth * 0.52) : termWidth) - 24,
  );

  const renderPanelItem = (
    item: QuickPanelItem,
    label: string,
    valueText: string,
    options: {
      dirty?: boolean;
      canSlide?: boolean;
      valueColor?: string;
      suffix?: string | null;
    } = {},
  ) => {
    const isFocused = panelFocused && panelState?.activeItem === item;
    const { dirty = false, canSlide = false, valueColor, suffix } = options;
    const prefix = isFocused ? '▸ ' : '  ';
    const paddedLabel = label.padEnd(9);
    const bracketColor = isFocused
      ? dirty
        ? 'yellow'
        : 'cyan'
      : dirty
        ? 'yellow'
        : 'gray';
    const displayVal = canSlide ? `<${valueText}>` : valueText;

    return (
      <Text color={bracketColor} bold={isFocused} wrap="truncate-end">
        {prefix}[
        <Text color={isFocused ? 'cyan' : 'white'} bold={isFocused}>
          {paddedLabel}:
        </Text>{' '}
        <Text
          color={
            dirty
              ? 'yellow'
              : (valueColor ?? (isFocused ? 'green' : 'white'))
          }
          bold={isFocused || dirty}
        >
          {displayVal}
        </Text>
        {dirty ? <Text color="yellow">*</Text> : null}]
        {suffix ? <Text dimColor> {suffix}</Text> : null}
      </Text>
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
              ⏎ Enter abre multiselección de agentes permitidos.
            </Text>
          );
        case 'move':
          if (selected.replicas === 0) {
            return (
              <Text color="magenta" wrap="truncate-end">
                Pausado — reactívalo en Inspección (i) → (p).
              </Text>
            );
          }
          if (panelState.moveDirty && panelState.moveTarget) {
            return (
              <Text color="yellow" bold wrap="truncate-end">
                ⏎ Enter moverá a {panelState.moveTarget} sin corte (Esc cancela).
              </Text>
            );
          }
          return (
            <Text dimColor wrap="truncate-end">
              {panelState.moveOptionsCount > 1
                ? '←/→ cambia agente destino · Enter aplica.'
                : 'Solo 1 agente permitido Ready — edita Agentes.'}
            </Text>
          );
        case 'replicas':
          if (panelState.replicasDirty) {
            return (
              <Text color="yellow" bold wrap="truncate-end">
                ⏎ Enter escalará a {panelState.draftReplicas} réplica
                {panelState.draftReplicas === 1 ? '' : 's'} (máx {panelState.maxReplicas}).
              </Text>
            );
          }
          return (
            <Text dimColor wrap="truncate-end">
              ←/→ ajusta réplicas (1..{panelState.maxReplicas}) · Enter aplica.
            </Text>
          );
        case 'namespace':
          if (panelState.namespaceDirty) {
            return (
              <Text color="yellow" bold wrap="truncate-end">
                ⏎ Enter moverá al namespace "{panelState.draftNamespace}" sin corte.
              </Text>
            );
          }
          return (
            <Text dimColor wrap="truncate-end">
              ←/→ cambia namespace (k3access + default) · (l) lista.
            </Text>
          );
      }
    }

    if (selected.hasMissingAllowedAgents) {
      return (
        <Text color="red" wrap="truncate-end">
          ✗ Sin agentes con {selected.nodeLabelKey} — Tab → Agentes.
        </Text>
      );
    }
    if (selected.status === 'pending') {
      return (
        <Text color="yellow" wrap="truncate-end">
          ⚠ Pod Pending — (i) diagnóstico o Tab para ajustar.
        </Text>
      );
    }
    if (selected.crossNodeTrafficWarning) {
      return (
        <Text color="cyan" wrap="truncate-end">
          ℹ Tailnet: túnel [{selected.runningAgents.join(',')}] · app [{selected.appPodNodes.join(',')}].
        </Text>
      );
    }
    return (
      <Text dimColor wrap="truncate-end">
        <Text color="white">{selected.resourceName}</Text>
        {' · '}
        <Text color="yellow">{selected.nodeLabelKey}</Text>
        {selected.description ? ` · ${selected.description}` : ''}
      </Text>
    );
  };

  const renderZeroTrustPanel = () => {
    if (!selected) return null;
    const displayList =
      sameNsZtEntries.length > 0 ? sameNsZtEntries : otherNsZtEntries;
    const isCrossOnly = sameNsZtEntries.length === 0 && otherNsZtEntries.length > 0;
    const maxPreview = sideBySide ? 4 : 2;

    return (
      <Box
        borderStyle="round"
        borderColor="green"
        flexDirection="column"
        paddingX={1}
        flexGrow={1}
        width={sideBySide ? '48%' : undefined}
      >
        <Box justifyContent="space-between">
          <Text bold color="green" wrap="truncate-end">
            Zero Trust URLs ({selected.namespace})
          </Text>
          <Text dimColor wrap="truncate-end">
            (z) abrir y copiar
          </Text>
        </Box>

        {displayList.length === 0 ? (
          <Box flexDirection="column">
            <Text dimColor wrap="truncate-end">
              Sin Services TCP detectados en el clúster todavía.
            </Text>
            <Text dimColor wrap="truncate-end">
              Cuando exista un Service en "{selected.namespace}", verás aquí Type + URL.
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {isCrossOnly ? (
              <Text color="yellow" wrap="truncate-end">
                Sin Services en "{selected.namespace}" · otros namespaces (FQDN):
              </Text>
            ) : null}
            {displayList.slice(0, maxPreview).map((entry) => (
              <Text
                key={`${entry.namespace}/${entry.serviceName}:${entry.port}`}
                wrap="truncate-end"
              >
                <Text color={ztTypeColor(entry.ztType)} bold>
                  {entry.ztType.padEnd(5)}
                </Text>{' '}
                <Text color="white">{entry.fullUrl}</Text>{' '}
                <Text dimColor>
                  ({entry.sameNamespace ? entry.serviceType : entry.namespace})
                </Text>
              </Text>
            ))}
            {displayList.length > maxPreview ? (
              <Text dimColor wrap="truncate-end">
                +{displayList.length - maxPreview} más — pulsa (z) para ver y copiar
              </Text>
            ) : null}
          </Box>
        )}

        <Text dimColor wrap="truncate-end">
          Zero Trust → Public Hostname · {sameNsZtEntries.length} en ns
          {otherNsZtEntries.length > 0 ? ` · ${otherNsZtEntries.length} otros ns` : ''}
        </Text>
      </Box>
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
              <Text color="green" bold>(z)</Text> para URLs Zero Trust,{' '}
              <Text color="cyan" bold>(l)</Text> para namespaces o{' '}
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

      {/* Paneles inferiores: Controles (lista vertical) + Asistente Zero Trust URLs */}
      {selected && panelState ? (
        <Box flexDirection={sideBySide ? 'row' : 'column'}>
          <Box
            borderStyle="round"
            borderColor={panelFocused ? (hasAnyDirty ? 'yellow' : 'cyan') : 'gray'}
            flexDirection="column"
            paddingX={1}
            width={sideBySide ? '52%' : undefined}
            marginRight={sideBySide ? 1 : 0}
          >
            <Box justifyContent="space-between">
              <Text bold color={panelFocused ? 'cyan' : 'white'} wrap="truncate-end">
                Controles: {selected.name}
              </Text>
              <Text dimColor wrap="truncate-end">
                {panelFocused ? '↑/↓ · ←/→ · Enter' : 'Tab → editar'}
              </Text>
            </Box>

            <Box flexDirection="column">
              {renderPanelItem(
                'agents',
                'Agentes',
                formatAgentsPreview(selected.allowedAgents, controlsPreviewMax),
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
              {renderPanelItem('namespace', 'Namespace', panelState.draftNamespace, {
                canSlide: true,
                dirty: panelState.namespaceDirty,
                valueColor: 'yellow',
                suffix: panelState.draftNamespaceBadge
                  ? `[${panelState.draftNamespaceBadge}]`
                  : null,
              })}
            </Box>

            {renderPanelHint()}
          </Box>

          {renderZeroTrustPanel()}
        </Box>
      ) : null}
    </Box>
  );
};
