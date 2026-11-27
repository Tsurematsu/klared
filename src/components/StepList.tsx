import React from 'react';
import { Box, Text } from 'ink';
import type { OperationStepLog } from '../types/k8s.js';

function getIcon(status: OperationStepLog['status']): {
  symbol: string;
  color: string;
} {
  switch (status) {
    case 'ok':
      return { symbol: '✓', color: 'green' };
    case 'warn':
      return { symbol: '⚠', color: 'yellow' };
    case 'error':
      return { symbol: '✗', color: 'red' };
    case 'running':
      return { symbol: '◐', color: 'cyan' };
    default:
      return { symbol: '○', color: 'gray' };
  }
}

export const StepList: React.FC<{ steps: OperationStepLog[] }> = ({ steps }) => {
  return (
    <Box flexDirection="column">
      {steps.map((step, idx) => {
        const icon = getIcon(step.status);
        return (
          <Box key={`${idx}-${step.label}`} flexDirection="column">
            <Box>
              <Text color={icon.color} bold>
                {icon.symbol}{' '}
              </Text>
              <Text bold={step.status === 'running' || step.status === 'error'}>
                {step.label}
              </Text>
            </Box>
            {step.detail ? (
              <Box marginLeft={2}>
                <Text
                  color={
                    step.status === 'error'
                      ? 'red'
                      : step.status === 'warn'
                        ? 'yellow'
                        : 'gray'
                  }
                >
                  {step.detail}
                </Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
};
