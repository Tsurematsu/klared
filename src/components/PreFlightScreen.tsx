import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { PreFlightStep } from '../types/k8s.js';

export interface PreFlightScreenProps {
  steps: PreFlightStep[];
  running: boolean;
  failed: boolean;
  onRetry: () => void;
  onExit: () => void;
}

function getStepIcon(status: PreFlightStep['status']): {
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

export const PreFlightScreen: React.FC<PreFlightScreenProps> = ({
  steps,
  running,
  failed,
  onRetry,
  onExit,
}) => {
  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === 'q') {
      onExit();
      return;
    }
    if (failed && input.toLowerCase() === 'r') {
      onRetry();
    }
  });

  const failedStep = steps.find((s) => s.status === 'error');

  return (
    <Box flexDirection="column" padding={1}>
      <Box
        borderStyle="round"
        borderColor={failed ? 'red' : 'cyan'}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <Text bold color="cyan">
          klared — Validación inicial de kubectl y clúster k3s
        </Text>
        <Text dimColor>
          Verificando kubectl, contexto, agentes Ready, permisos RBAC y namespaces
        </Text>

        <Box flexDirection="column" marginTop={1}>
          {steps.map((step) => {
            const icon = getStepIcon(step.status);
            return (
              <Box key={step.id} flexDirection="column" marginBottom={0}>
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

        {failed && failedStep?.hint ? (
          <Box
            marginTop={1}
            borderStyle="single"
            borderColor="yellow"
            paddingX={1}
            flexDirection="column"
          >
            <Text bold color="yellow">
              Acción sugerida:
            </Text>
            <Text>{failedStep.hint}</Text>
          </Box>
        ) : null}

        <Box marginTop={1}>
          {running ? (
            <Text color="cyan">Ejecutando comprobaciones...</Text>
          ) : failed ? (
            <Text>
              <Text bold color="yellow">
                (r)
              </Text>{' '}
              Reintentar ·{' '}
              <Text bold color="red">
                (q / Esc)
              </Text>{' '}
              Salir
            </Text>
          ) : (
            <Text color="green">Validación completada. Cargando dashboard...</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
};
