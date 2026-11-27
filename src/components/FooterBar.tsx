import React from 'react';
import { Box, Text } from 'ink';

export interface FooterShortcut {
  key: string;
  label: string;
  color?: string;
  disabled?: boolean;
}

export interface FooterBarProps {
  shortcuts: FooterShortcut[];
  statusMessage?: { type: 'info' | 'success' | 'error'; text: string } | null;
}

export const FooterBar: React.FC<FooterBarProps> = ({
  shortcuts,
  statusMessage,
}) => {
  return (
    <Box flexDirection="column">
      {statusMessage ? (
        <Box paddingX={1}>
          <Text
            color={
              statusMessage.type === 'error'
                ? 'red'
                : statusMessage.type === 'success'
                  ? 'green'
                  : 'cyan'
            }
            wrap="truncate-end"
          >
            {statusMessage.type === 'error'
              ? '✗ '
              : statusMessage.type === 'success'
                ? '✓ '
                : 'ℹ '}
            {statusMessage.text}
          </Text>
        </Box>
      ) : null}

      <Box borderStyle="single" borderColor="gray" paddingX={1} flexWrap="wrap">
        {shortcuts.map((item) => (
          <Box key={`${item.key}-${item.label}`} marginRight={1}>
            <Text
              bold={!item.disabled}
              dimColor={item.disabled}
              color={item.disabled ? 'gray' : (item.color ?? 'cyan')}
            >
              ({item.key})
            </Text>
            <Text dimColor={item.disabled}>{item.label}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
};
