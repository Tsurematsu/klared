import React from 'react';
import { Box, Spacer, Text, useWindowSize } from 'ink';
import type { NodeAgentInfo } from '../types/k8s.js';

export interface HeaderProps {
  context: string;
  clusterVersion: string;
  kubectlVersion: string;
  agents: NodeAgentInfo[];
  orphanCount: number;
  lastSync: Date | null;
  refreshing: boolean;
}

function formatTime(date: Date | null): string {
  if (!date) return '--:--:--';
  return date.toLocaleTimeString('es-ES', { hour12: false });
}

export const Header: React.FC<HeaderProps> = ({
  context,
  clusterVersion,
  agents,
  orphanCount,
  lastSync,
  refreshing,
}) => {
  const { columns } = useWindowSize();
  const wide = (columns || 100) >= 102;
  const readyCount = agents.filter((a) => a.ready && !a.unschedulable).length;
  const allReady = agents.length > 0 && readyCount === agents.length;

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        klared
      </Text>
      <Text dimColor> │ </Text>
      <Text>
        <Text dimColor>ctx:</Text>
        <Text bold color="green">
          {context}
        </Text>
      </Text>
      {wide ? (
        <>
          <Text dimColor> │ </Text>
          <Text dimColor>{clusterVersion}</Text>
        </>
      ) : null}
      <Text dimColor> │ </Text>
      <Text>
        <Text dimColor>agentes:</Text>
        <Text color={allReady ? 'green' : 'yellow'} bold>
          {readyCount}/{agents.length}
        </Text>
      </Text>
      <Text dimColor> │ </Text>
      {orphanCount > 0 ? (
        <Text color="yellow" bold>
          ⚠ {orphanCount} huérf.
        </Text>
      ) : (
        <Text color="green">OK</Text>
      )}
      <Spacer />
      <Text color={refreshing ? 'yellow' : 'gray'}>
        {refreshing ? '⟳ sync' : formatTime(lastSync)}
      </Text>
    </Box>
  );
};
