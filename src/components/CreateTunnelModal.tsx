import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type {
  NamespaceMeta,
  NodeAgentInfo,
  OperationStepLog,
  TunnelInfo,
  TunnelProtocol,
} from '../types/k8s.js';
import {
  buildResourceName,
  computeAgentEligibility,
  DEFAULT_CLOUDFLARED_VERSION,
  DEFAULT_TUNNEL_PROTOCOL,
  extractTunnelToken,
  formatNodeSelectorDisplay,
  TUNNEL_PROTOCOLS,
  validateImageVersion,
  validateTunnelName,
} from '../utils/validation.js';
import { fetchLatestCloudflaredVersion } from '../services/manifests.js';
import {
  installTunnel,
  type InstallTunnelResult,
} from '../services/tunnels.js';
import { copyToClipboard } from '../services/clipboard.js';
import { TextInput } from './TextInput.js';
import { StepList } from './StepList.js';

export interface CreateTunnelModalProps {
  nodes: NodeAgentInfo[];
  namespaces: NamespaceMeta[];
  existingTunnels: TunnelInfo[];
  onCreated: (result: InstallTunnelResult) => void;
  onCancel: () => void;
}

type FieldId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
// 0: name, 1: token, 2: namespace, 3: agents, 4: replicas, 5: protocol, 6: imageVersion, 7: description

const PROTOCOL_HINTS: Record<TunnelProtocol, string> = {
  http2: 'TCP 7844/443 (recomendado, evita bloqueos UDP)',
  auto: 'QUIC primero con fallback a HTTP/2',
  quic: 'UDP 7844 (requiere salida UDP permitida)',
};

export const CreateTunnelModal: React.FC<CreateTunnelModalProps> = ({
  nodes,
  namespaces,
  existingTunnels,
  onCreated,
  onCancel,
}) => {
  const [showSystemNs, setShowSystemNs] = useState(false);
  const visibleNamespaces = useMemo(() => {
    const filtered = showSystemNs
      ? namespaces
      : namespaces.filter((n) => !n.isProtected);
    return filtered.length > 0 ? filtered : namespaces;
  }, [namespaces, showSystemNs]);

  const [name, setName] = useState('');
  const [rawToken, setRawToken] = useState('');
  const [nsIndex, setNsIndex] = useState(0);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [agentCursor, setAgentCursor] = useState(0);
  const [replicas, setReplicas] = useState(1);
  const [protocol, setProtocol] = useState<TunnelProtocol>(DEFAULT_TUNNEL_PROTOCOL);
  const [imageVersion, setImageVersion] = useState(DEFAULT_CLOUDFLARED_VERSION);
  const [versionSource, setVersionSource] = useState<'loading' | 'github' | 'fallback'>('loading');
  const [description, setDescription] = useState('');

  const [focusField, setFocusField] = useState<FieldId>(0);
  const [phase, setPhase] = useState<'form' | 'running' | 'done'>('form');
  const [steps, setSteps] = useState<OperationStepLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<InstallTunnelResult | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchLatestCloudflaredVersion().then((res) => {
      if (!active) return;
      setImageVersion((prev) =>
        prev === DEFAULT_CLOUDFLARED_VERSION ? res.version : prev,
      );
      setVersionSource(res.source);
    });
    return () => {
      active = false;
    };
  }, []);

  const currentNs =
    visibleNamespaces[Math.min(nsIndex, Math.max(0, visibleNamespaces.length - 1))];

  const eligibility = useMemo(
    () => computeAgentEligibility(nodes, currentNs?.nodeSelector),
    [nodes, currentNs?.nodeSelector],
  );

  const eligibleAgents = useMemo(
    () => eligibility.filter((e) => e.eligible).map((e) => e.agent.name),
    [eligibility],
  );

  useEffect(() => {
    setSelectedAgents((prev) => {
      const stillValid = prev.filter((a) => eligibleAgents.includes(a));
      if (stillValid.length > 0) return stillValid;
      return eligibleAgents.length > 0 ? [eligibleAgents[0]!] : [];
    });
    setAgentCursor(0);
  }, [currentNs?.name, eligibleAgents.join(',')]);

  useEffect(() => {
    const max = Math.max(1, selectedAgents.length);
    setReplicas((prev) => Math.max(1, Math.min(prev, max)));
  }, [selectedAgents.length]);

  const nameValidation = useMemo(() => {
    if (!name) return { valid: true as const };
    const check = validateTunnelName(name);
    if (!check.valid) return check;
    const resName = buildResourceName(name);
    if (
      currentNs &&
      existingTunnels.some(
        (t) => t.namespace === currentNs.name && t.resourceName === resName,
      )
    ) {
      return {
        valid: false as const,
        error: `Ya existe "${resName}" en "${currentNs.name}".`,
      };
    }
    return { valid: true as const };
  }, [name, currentNs, existingTunnels]);

  const tokenCheck = useMemo(() => {
    if (!rawToken) return null;
    return extractTunnelToken(rawToken);
  }, [rawToken]);

  const versionCheck = useMemo(
    () => validateImageVersion(imageVersion),
    [imageVersion],
  );

  const handleInstall = async () => {
    if (phase !== 'form') return;
    if (!currentNs) {
      setError('No hay ningún namespace disponible.');
      return;
    }

    const nCheck = validateTunnelName(name);
    if (!nCheck.valid) {
      setError(nCheck.error ?? 'Nombre inválido.');
      setFocusField(0);
      return;
    }
    const resName = buildResourceName(name);
    if (
      existingTunnels.some(
        (t) => t.namespace === currentNs.name && t.resourceName === resName,
      )
    ) {
      setError(`Ya existe "${resName}" en "${currentNs.name}".`);
      setFocusField(0);
      return;
    }

    const tCheck = extractTunnelToken(rawToken);
    if (!tCheck.valid) {
      setError(tCheck.error ?? 'Token inválido.');
      setFocusField(1);
      return;
    }

    if (eligibleAgents.length === 0 || selectedAgents.length === 0) {
      setError('Selecciona al menos un agente Ready compatible con el namespace.');
      setFocusField(3);
      return;
    }

    if (!versionCheck.valid) {
      setError(versionCheck.error ?? 'Versión de imagen inválida.');
      setFocusField(6);
      return;
    }

    setError(null);
    setPhase('running');
    try {
      const result = await installTunnel(
        {
          name: name.trim(),
          rawToken,
          namespace: currentNs.name,
          agents: selectedAgents,
          replicas,
          imageVersion: versionCheck.normalized,
          protocol,
          description,
        },
        (progress) => setSteps(progress),
      );
      setInstallResult(result);
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('form');
    }
  };

  useInput(
    (input, key) => {
      if (phase === 'running') return;

      if (phase === 'done') {
        if (key.escape || key.return || input.toLowerCase() === 'q') {
          if (installResult) onCreated(installResult);
          else onCancel();
          return;
        }
        if (input.toLowerCase() === 'c' && installResult) {
          const firstUrl = installResult.services[0]?.suggestedUrls[0];
          if (firstUrl) {
            void copyToClipboard(firstUrl).then((res) => {
              setCopyFeedback(
                res.ok
                  ? `Copiado (${res.method}): ${firstUrl}`
                  : (res.error ?? 'No se pudo copiar.'),
              );
            });
          }
        }
        return;
      }

      if (key.escape) {
        onCancel();
        return;
      }

      if (key.ctrl && input.toLowerCase() === 's') {
        void handleInstall();
        return;
      }

      if (key.tab) {
        setFocusField((prev) => ((prev + 1) % 8) as FieldId);
        return;
      }

      if (focusField === 3) {
        if (key.upArrow) {
          if (agentCursor > 0) setAgentCursor((p) => p - 1);
          else setFocusField(2);
          return;
        }
        if (key.downArrow) {
          if (agentCursor < eligibility.length - 1) setAgentCursor((p) => p + 1);
          else setFocusField(4);
          return;
        }
        if (input === ' ') {
          const item = eligibility[agentCursor];
          if (item && item.eligible) {
            setSelectedAgents((prev) =>
              prev.includes(item.agent.name)
                ? prev.filter((a) => a !== item.agent.name)
                : [...prev, item.agent.name].sort(),
            );
            setError(null);
          }
          return;
        }
        if (key.return) {
          setFocusField(4);
          return;
        }
        return;
      }

      if (key.downArrow) {
        setFocusField((prev) => (prev < 7 ? ((prev + 1) as FieldId) : 0));
        return;
      }
      if (key.upArrow) {
        setFocusField((prev) => (prev > 0 ? ((prev - 1) as FieldId) : 7));
        return;
      }

      if (focusField === 2) {
        if (key.leftArrow) {
          setNsIndex(
            (prev) =>
              (prev - 1 + visibleNamespaces.length) %
              Math.max(1, visibleNamespaces.length),
          );
          return;
        }
        if (key.rightArrow || input === ' ') {
          setNsIndex(
            (prev) => (prev + 1) % Math.max(1, visibleNamespaces.length),
          );
          return;
        }
        if (input.toLowerCase() === 'y') {
          setShowSystemNs((prev) => !prev);
          setNsIndex(0);
          return;
        }
        if (key.return) {
          setFocusField(3);
          return;
        }
      }

      if (focusField === 4) {
        const maxRep = Math.max(1, selectedAgents.length);
        if (key.leftArrow) {
          setReplicas((prev) => Math.max(1, prev - 1));
          return;
        }
        if (key.rightArrow) {
          setReplicas((prev) => Math.min(maxRep, prev + 1));
          return;
        }
        if (key.return) {
          setFocusField(5);
          return;
        }
      }

      if (focusField === 5) {
        const curIdx = TUNNEL_PROTOCOLS.indexOf(protocol);
        if (key.leftArrow) {
          const nextIdx =
            (curIdx - 1 + TUNNEL_PROTOCOLS.length) % TUNNEL_PROTOCOLS.length;
          setProtocol(TUNNEL_PROTOCOLS[nextIdx]!);
          setError(null);
          return;
        }
        if (key.rightArrow || input === ' ') {
          const nextIdx = (curIdx + 1) % TUNNEL_PROTOCOLS.length;
          setProtocol(TUNNEL_PROTOCOLS[nextIdx]!);
          setError(null);
          return;
        }
        if (key.return) {
          setFocusField(6);
          return;
        }
      }
    },
    { isActive: phase !== 'running' },
  );

  if (phase === 'running') {
    return (
      <Box
        borderStyle="round"
        borderColor="cyan"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color="cyan">
          Instalando cloudflared-{name.trim()} en "{currentNs?.name}"...
        </Text>
        <StepList steps={steps} />
      </Box>
    );
  }

  if (phase === 'done' && installResult) {
    return (
      <Box
        borderStyle="round"
        borderColor="green"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color="green">
          ✓ "{installResult.resourceName}" instalado y Ready
        </Text>
        <Text>
          <Text dimColor>ns:</Text> <Text bold>{installResult.namespace}</Text>
          {' · '}
          <Text dimColor>id:</Text> <Text color="yellow">{installResult.tunnelId}</Text>
          {' · '}
          <Text dimColor>nodos:</Text>{' '}
          <Text color="green">{installResult.runningAgents.join(', ')}</Text>
        </Text>
        <Text bold color="cyan">
          Services en "{installResult.namespace}" (URL para Zero Trust):
        </Text>
        {installResult.services.length === 0 ? (
          <Text dimColor>  Sin Services TCP detectados todavía.</Text>
        ) : (
          installResult.services.slice(0, 4).map((svc) => (
            <Text key={svc.name}>
              • <Text bold>{svc.name}</Text>: <Text color="green">{svc.suggestedUrls.join(', ') || 'sin TCP'}</Text>
            </Text>
          ))
        )}
        {copyFeedback ? <Text color="green">✓ {copyFeedback}</Text> : null}
        <Text dimColor>
          {installResult.services.length > 0 ? '(c) Copiar 1ª URL · ' : ''}
          (Enter / Esc) Volver
        </Text>
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor="green"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="green">
        Nuevo túnel cloudflared{' '}
        <Text dimColor>(Tab/↑/↓ campo · ←/→ opción · Espacio agente · Ctrl+S crear)</Text>
      </Text>

      {/* 0. Nombre */}
      <Box>
        <Text bold={focusField === 0} color={focusField === 0 ? 'cyan' : undefined}>
          {focusField === 0 ? '▸ ' : '  '}Nombre:      
        </Text>
        <TextInput
          value={name}
          onChange={(val) => {
            setName(val);
            setError(null);
          }}
          onSubmit={() => setFocusField(1)}
          focus={focusField === 0}
          placeholder="mi-app"
        />
        <Text dimColor>
          {'  '}→ {name.trim() ? buildResourceName(name) : 'cloudflared-<nombre>'}
        </Text>
      </Box>
      {!nameValidation.valid && nameValidation.error ? (
        <Text color="red">    ✗ {nameValidation.error}</Text>
      ) : null}

      {/* 1. Token */}
      <Box>
        <Text bold={focusField === 1} color={focusField === 1 ? 'cyan' : undefined}>
          {focusField === 1 ? '▸ ' : '  '}Token:       
        </Text>
        <TextInput
          value={rawToken}
          onChange={(val) => {
            setRawToken(val);
            setError(null);
          }}
          onSubmit={() => setFocusField(2)}
          focus={focusField === 1}
          placeholder="pega token o comando Zero Trust (Ctrl+U limpia)"
          mask
        />
        {tokenCheck ? (
          tokenCheck.valid ? (
            <Text color="green">
              {'  '}✓ {tokenCheck.token.length}c
              {tokenCheck.extractedFromCommand ? ' (extraído)' : ''}
            </Text>
          ) : (
            <Text color="red">  ✗ {tokenCheck.error}</Text>
          )
        ) : null}
      </Box>

      {/* 2. Namespace */}
      <Box>
        <Text bold={focusField === 2} color={focusField === 2 ? 'cyan' : undefined}>
          {focusField === 2 ? '▸ ' : '  '}Namespace:   
        </Text>
        <Text bold color="cyan">
          ◀ {currentNs?.name ?? '(ninguno)'}
          {currentNs?.isProtected ? ' [sys]' : ''} ▶
        </Text>
        <Text dimColor> (y: {showSystemNs ? 'ocultar' : 'ver'} sys)</Text>
        {currentNs?.nodeSelector ? (
          <Text color="yellow"> · afinidad: {formatNodeSelectorDisplay(currentNs.nodeSelector)}</Text>
        ) : null}
      </Box>

      {/* 3. Agentes */}
      <Box flexDirection="column">
        <Text bold={focusField === 3} color={focusField === 3 ? 'cyan' : undefined}>
          {focusField === 3 ? '▸ ' : '  '}Agentes (Espacio marcar):
        </Text>
        {eligibility.length === 0 ? (
          <Text color="red">    No hay agentes worker en el clúster.</Text>
        ) : (
          eligibility.map((item, idx) => {
            const checked = selectedAgents.includes(item.agent.name);
            const isCursor = focusField === 3 && idx === agentCursor;
            return (
              <Text
                key={item.agent.name}
                color={
                  !item.eligible
                    ? 'gray'
                    : isCursor
                      ? 'cyan'
                      : checked
                        ? 'green'
                        : 'white'
                }
                bold={isCursor}
              >
                {'    '}
                {isCursor ? '▸ ' : '  '}
                {item.eligible ? (checked ? '[x]' : '[ ]') : '[-]'} {item.agent.name}{' '}
                ({item.agent.status})
                {item.disabledReason ? ` — ${item.disabledReason}` : ''}
              </Text>
            );
          })
        )}
        {eligibleAgents.length === 0 ? (
          <Text color="red" bold>
            {'    '}⚠ Intersección vacía con afinidad de "{currentNs?.name}" (quedaría Pending).
          </Text>
        ) : null}
      </Box>

      {/* 4. Réplicas */}
      <Box>
        <Text bold={focusField === 4} color={focusField === 4 ? 'cyan' : undefined}>
          {focusField === 4 ? '▸ ' : '  '}Réplicas:    
        </Text>
        <Text bold color="green">
          ◀ {replicas} / máx {Math.max(1, selectedAgents.length)} ▶
        </Text>
      </Box>

      {/* 5. Protocolo */}
      <Box>
        <Text bold={focusField === 5} color={focusField === 5 ? 'cyan' : undefined}>
          {focusField === 5 ? '▸ ' : '  '}Protocolo:   
        </Text>
        <Text bold color="cyan">
          ◀ {protocol} ▶
        </Text>
        <Text dimColor>  {PROTOCOL_HINTS[protocol]}</Text>
      </Box>

      {/* 6. Versión fija */}
      <Box>
        <Text bold={focusField === 6} color={focusField === 6 ? 'cyan' : undefined}>
          {focusField === 6 ? '▸ ' : '  '}Imagen tag:  
        </Text>
        <TextInput
          value={imageVersion}
          onChange={(val) => {
            setImageVersion(val);
            setError(null);
          }}
          onSubmit={() => setFocusField(7)}
          focus={focusField === 6}
          placeholder={DEFAULT_CLOUDFLARED_VERSION}
        />
        <Text dimColor>
          {'  '}
          ({versionSource === 'github'
            ? 'estable GitHub'
            : versionSource === 'loading'
              ? 'consultando...'
              : 'fallback'})
        </Text>
        {!versionCheck.valid && versionCheck.error ? (
          <Text color="red"> ✗ {versionCheck.error}</Text>
        ) : null}
      </Box>

      {/* 7. Descripción */}
      <Box>
        <Text bold={focusField === 7} color={focusField === 7 ? 'cyan' : undefined}>
          {focusField === 7 ? '▸ ' : '  '}Descripción: 
        </Text>
        <TextInput
          value={description}
          onChange={setDescription}
          onSubmit={() => {
            void handleInstall();
          }}
          focus={focusField === 7}
          placeholder="opcional (Enter para instalar)"
        />
      </Box>

      {error ? (
        <Text color="red" bold>
          ✗ {error}
        </Text>
      ) : null}

      <Text dimColor>
        (Ctrl+S / Enter en Descripción) Instalar · (Esc) Cancelar
      </Text>
    </Box>
  );
};
