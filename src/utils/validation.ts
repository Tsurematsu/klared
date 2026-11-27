import type {
  AgentEligibility,
  NodeAgentInfo,
  NodeLabelOption,
  TunnelProtocol,
} from '../types/k8s.js';

export const TSURE_PREFIX = 'tsure.io/';
export const CLOUDFLARED_RESOURCE_PREFIX = 'cloudflared-';
export const CLOUDFLARED_MANAGED_LABEL_KEY = 'tsure.io/cloudflared';
export const CLOUDFLARED_NODE_LABEL_PREFIX = 'tsure.io/cloudflared-';
export const KLARED_NS_LABEL_PREFIX = 'tsure.io/klared-';

export const TUNNEL_ID_ANNOTATION = 'tsure.io/tunnel-id';
export const AGENTS_ANNOTATION = 'tsure.io/agents';
export const DESCRIPTION_ANNOTATION = 'tsure.io/description';
export const DESIRED_REPLICAS_ANNOTATION = 'tsure.io/desired-replicas';
export const NODE_LABEL_AFFINITY_ANNOTATION = 'tsure.io/node-label-affinity';

export const K8S_NODE_SELECTOR_ANNOTATION =
  'scheduler.alpha.kubernetes.io/node-selector';
export const TSURE_NODE_SELECTOR_ANNOTATION = 'tsure.io/node-selector';

export const DEFAULT_CLOUDFLARED_VERSION = '2026.2.0';
export const TUNNEL_PROTOCOLS: readonly TunnelProtocol[] = [
  'http2',
  'auto',
  'quic',
] as const;
export const DEFAULT_TUNNEL_PROTOCOL: TunnelProtocol = 'http2';

export const PROTECTED_NAMESPACES = new Set<string>([
  'default',
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'cnpg-system',
]);

const DNS_1123_REGEX = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const LABEL_KEY_PREFIX_REGEX =
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const LABEL_NAME_REGEX = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const LABEL_VALUE_REGEX = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;
const TUNNEL_ID_REGEX = /^[a-f0-9]{6,8}$/;
const IMAGE_TAG_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Max logical tunnel name length so "cloudflared-<name>" stays <= 63 chars */
export const MAX_TUNNEL_NAME_LENGTH = 63 - CLOUDFLARED_RESOURCE_PREFIX.length;

export function isProtectedNamespace(name: string): boolean {
  return PROTECTED_NAMESPACES.has(name);
}

export function buildResourceName(tunnelName: string): string {
  return `${CLOUDFLARED_RESOURCE_PREFIX}${tunnelName.trim()}`;
}

export function extractTunnelLogicalName(resourceName: string): string {
  if (resourceName.startsWith(CLOUDFLARED_RESOURCE_PREFIX)) {
    return resourceName.slice(CLOUDFLARED_RESOURCE_PREFIX.length);
  }
  return resourceName;
}

export function buildNodeLabelKey(tunnelId: string): string {
  return `${CLOUDFLARED_NODE_LABEL_PREFIX}${tunnelId}`;
}

export function buildNamespaceLabelKey(tunnelId: string): string {
  return `${KLARED_NS_LABEL_PREFIX}${tunnelId}`;
}

export function validateDns1123Name(
  name: string,
  fieldLabel = 'nombre',
  maxLength = 63,
): { valid: boolean; error?: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { valid: false, error: `El ${fieldLabel} es obligatorio.` };
  }
  if (trimmed.length > maxLength) {
    return {
      valid: false,
      error: `Máximo ${maxLength} caracteres según la norma DNS-1123.`,
    };
  }
  if (!DNS_1123_REGEX.test(trimmed)) {
    return {
      valid: false,
      error:
        'Solo minúsculas (a-z), números (0-9) y guiones medios; debe iniciar y terminar en alfanumérico.',
    };
  }
  return { valid: true };
}

export function validateTunnelName(name: string): {
  valid: boolean;
  error?: string;
} {
  const trimmed = name.trim();
  if (trimmed.startsWith(CLOUDFLARED_RESOURCE_PREFIX)) {
    return {
      valid: false,
      error: 'No incluyas el prefijo "cloudflared-"; se añade automáticamente.',
    };
  }
  return validateDns1123Name(trimmed, 'nombre del túnel', MAX_TUNNEL_NAME_LENGTH);
}

export function validateTunnelId(id: string): boolean {
  return TUNNEL_ID_REGEX.test(id);
}

export function validateImageVersion(version: string): {
  valid: boolean;
  normalized: string;
  error?: string;
} {
  const trimmed = version.trim();
  if (!trimmed) {
    return {
      valid: false,
      normalized: '',
      error: 'La versión de imagen es obligatoria.',
    };
  }
  if (trimmed.toLowerCase() === 'latest') {
    return {
      valid: false,
      normalized: trimmed,
      error: 'No se permite el tag "latest". Usa una versión fija (ej. 2026.2.0).',
    };
  }
  if (!IMAGE_TAG_REGEX.test(trimmed)) {
    return {
      valid: false,
      normalized: trimmed,
      error: 'Tag de imagen inválido. Ejemplo válido: 2026.2.0',
    };
  }
  return { valid: true, normalized: trimmed };
}

/**
 * Accepts either a raw Cloudflare tunnel token or a full command copied from
 * Cloudflare Zero Trust (e.g. `cloudflared service install <TOKEN>` or
 * `cloudflared tunnel run --token <TOKEN>`).
 */
export function extractTunnelToken(rawInput: string): {
  valid: boolean;
  token: string;
  extractedFromCommand: boolean;
  error?: string;
} {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {
      valid: false,
      token: '',
      extractedFromCommand: false,
      error: 'El token del túnel es obligatorio.',
    };
  }

  let candidate = trimmed;
  let extractedFromCommand = false;

  // Match `--token <TOKEN>` or `--token=<TOKEN>`
  const flagMatch = trimmed.match(/--token(?:=|\s+)['"]?([^\s'"]+)['"]?/i);
  if (flagMatch?.[1]) {
    candidate = flagMatch[1];
    extractedFromCommand = true;
  } else {
    // Match `service install <TOKEN>`
    const installMatch = trimmed.match(/\bservice\s+install\s+['"]?([^\s'"]+)['"]?/i);
    if (installMatch?.[1]) {
      candidate = installMatch[1];
      extractedFromCommand = true;
    } else {
      // Match `TUNNEL_TOKEN=<TOKEN>`
      const envMatch = trimmed.match(/\bTUNNEL_TOKEN=['"]?([^\s'"]+)['"]?/);
      if (envMatch?.[1]) {
        candidate = envMatch[1];
        extractedFromCommand = true;
      }
    }
  }

  // Strip surrounding quotes if pasted directly with quotes
  candidate = candidate.replace(/^['"]+|['"]+$/g, '').trim();

  if (/\s/.test(candidate)) {
    return {
      valid: false,
      token: '',
      extractedFromCommand,
      error: 'El token no debe contener espacios ni saltos de línea.',
    };
  }

  if (candidate.length < 16) {
    return {
      valid: false,
      token: '',
      extractedFromCommand,
      error: 'El token parece demasiado corto. Pega el token completo de Cloudflare.',
    };
  }

  if (!/^[A-Za-z0-9._~+/=-]+$/.test(candidate)) {
    return {
      valid: false,
      token: '',
      extractedFromCommand,
      error: 'El token contiene caracteres inválidos.',
    };
  }

  return {
    valid: true,
    token: candidate,
    extractedFromCommand,
  };
}

export function maskTokenForDisplay(token: string, maxBullets = 28): string {
  if (!token) return '';
  return '•'.repeat(Math.min(token.length, maxBullets));
}

export function redactSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  return result;
}

export interface NodeSelectorPair {
  key: string;
  value: string;
}

function isValidLabelKey(key: string): boolean {
  const parts = key.split('/');
  if (parts.length > 2) return false;
  if (parts.length === 1) {
    const name = parts[0] ?? '';
    return name.length > 0 && name.length <= 63 && LABEL_NAME_REGEX.test(name);
  }
  const [prefix, name] = parts;
  if (!prefix || !name) return false;
  if (prefix.length > 253 || name.length > 63) return false;
  return LABEL_KEY_PREFIX_REGEX.test(prefix) && LABEL_NAME_REGEX.test(name);
}

export function parseNodeSelector(raw: string | null | undefined): {
  valid: boolean;
  normalized: string | null;
  pairs: NodeSelectorPair[];
  error?: string;
} {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { valid: true, normalized: null, pairs: [] };
  }

  const segments = trimmed.split(',').map((s) => s.trim());
  const pairs: NodeSelectorPair[] = [];
  const seenKeys = new Set<string>();

  for (const segment of segments) {
    if (!segment) {
      return {
        valid: false,
        normalized: null,
        pairs: [],
        error: 'Selector vacío entre comas.',
      };
    }

    const eqIndex = segment.indexOf('=');
    if (eqIndex <= 0) {
      return {
        valid: false,
        normalized: null,
        pairs: [],
        error: `Formato inválido "${segment}". Debe ser clave=valor.`,
      };
    }

    const key = segment.slice(0, eqIndex).trim();
    const value = segment.slice(eqIndex + 1).trim();

    if (!isValidLabelKey(key)) {
      return {
        valid: false,
        normalized: null,
        pairs: [],
        error: `Clave de selector inválida: "${key}".`,
      };
    }

    if (value.length > 63 || !LABEL_VALUE_REGEX.test(value)) {
      return {
        valid: false,
        normalized: null,
        pairs: [],
        error: `Valor de selector inválido: "${value}".`,
      };
    }

    if (seenKeys.has(key)) {
      return {
        valid: false,
        normalized: null,
        pairs: [],
        error: `Clave duplicada en selector: "${key}".`,
      };
    }

    seenKeys.add(key);
    pairs.push({ key, value });
  }

  const normalized = pairs.map((p) => `${p.key}=${p.value}`).join(',');
  return { valid: true, normalized, pairs };
}

export function matchNodesForSelector(
  selector: string | null | undefined,
  nodes: NodeAgentInfo[],
): NodeAgentInfo[] {
  if (!selector) {
    return nodes;
  }
  const parsed = parseNodeSelector(selector);
  if (!parsed.valid || parsed.pairs.length === 0) {
    return [];
  }
  return nodes.filter((node) =>
    parsed.pairs.every(({ key, value }) => node.labels[key] === value),
  );
}

export function formatNodeSelectorDisplay(selector: string | null | undefined): string {
  if (!selector) {
    return 'Cualquiera';
  }
  const parsed = parseNodeSelector(selector);
  if (!parsed.valid || parsed.pairs.length === 0) {
    return selector;
  }
  if (parsed.pairs.length === 1) {
    const pair = parsed.pairs[0]!;
    if (pair.key === 'kubernetes.io/hostname') {
      return pair.value;
    }
    if (pair.key.startsWith('node-role.kubernetes.io/')) {
      const role = pair.key.slice('node-role.kubernetes.io/'.length);
      return `rol:${role}`;
    }
  }
  return selector;
}

/**
 * Evaluates which worker agents (excluding control-plane/master) are eligible
 * for a tunnel given the namespace's read-only node-selector affinity.
 */
export function computeAgentEligibility(
  nodes: NodeAgentInfo[],
  namespaceSelector: string | null | undefined,
): AgentEligibility[] {
  const workerAgents = nodes.filter((n) => !n.isControlPlane);
  const matchedSet = new Set(
    matchNodesForSelector(namespaceSelector, workerAgents).map((a) => a.name),
  );
  const selectorDisplay = formatNodeSelectorDisplay(namespaceSelector);

  return workerAgents.map((agent) => {
    const matchesNamespace = matchedSet.has(agent.name);
    if (!agent.ready) {
      return {
        agent,
        eligible: false,
        matchesNamespace,
        disabledReason: 'Agente NotReady',
      };
    }
    if (agent.unschedulable) {
      return {
        agent,
        eligible: false,
        matchesNamespace,
        disabledReason: 'SchedulingDisabled (cordon)',
      };
    }
    if (!matchesNamespace) {
      return {
        agent,
        eligible: false,
        matchesNamespace: false,
        disabledReason: `Incompatible con afinidad del namespace (${selectorDisplay})`,
      };
    }
    return {
      agent,
      eligible: true,
      matchesNamespace: true,
      disabledReason: null,
    };
  });
}

export function extractImageVersion(image: string): string {
  const idx = image.lastIndexOf(':');
  if (idx <= 0 || idx === image.length - 1) {
    return '-';
  }
  return image.slice(idx + 1);
}

export function validateTunnelProtocol(protocol: string | undefined): {
  valid: boolean;
  normalized: TunnelProtocol;
  error?: string;
} {
  const raw = (protocol ?? DEFAULT_TUNNEL_PROTOCOL).trim().toLowerCase();
  if (raw === 'http2' || raw === 'auto' || raw === 'quic') {
    return { valid: true, normalized: raw };
  }
  return {
    valid: false,
    normalized: DEFAULT_TUNNEL_PROTOCOL,
    error: `Protocolo inválido "${protocol ?? ''}". Usa http2, auto o quic.`,
  };
}

export function extractTunnelProtocol(args?: string[]): TunnelProtocol {
  if (!args || args.length === 0) return 'auto';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--protocol' || arg === '-p') {
      const next = (args[i + 1] ?? '').trim().toLowerCase();
      if (next === 'http2' || next === 'auto' || next === 'quic') {
        return next;
      }
    } else if (arg.startsWith('--protocol=')) {
      const val = arg.slice('--protocol='.length).trim().toLowerCase();
      if (val === 'http2' || val === 'auto' || val === 'quic') {
        return val;
      }
    }
  }
  return 'auto';
}

export function summarizeCloudflaredLogDiagnostic(rawLogs: string): string {
  const lines = rawLogs
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';

  const joined = lines.join('\n');

  if (
    /failed to dial.*quic|QUIC connection failed|suggested_protocol=http2/i.test(
      joined,
    )
  ) {
    return ' | Causa probable: QUIC (UDP 7844) bloqueado o sin respuesta en la red. Usa protocolo "http2".';
  }

  if (
    /Unauthorized|invalid tunnel token|failed to decode|not valid.*token|Provided Tunnel token is not valid/i.test(
      joined,
    )
  ) {
    return ' | Causa probable: token de Cloudflare inválido o revocado.';
  }

  const errorLines = lines.filter((l) => /\b(ERR|FTL)\b|error=/i.test(l));
  const picked = (errorLines.length > 0 ? errorLines : lines).slice(-2);
  return ` | Logs: ${picked.join(' / ')}`;
}

const SYSTEM_NODE_LABEL_PREFIXES = [
  'kubernetes.io/',
  'beta.kubernetes.io/',
  'node.kubernetes.io/',
  'k3s.io/',
  'node-role.kubernetes.io/',
];

export function isSystemNodeLabelKey(key: string): boolean {
  return SYSTEM_NODE_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export interface ParsedSingleNodeLabel {
  valid: boolean;
  selector: string | null;
  key: string | null;
  value: string | null;
  error?: string;
}

export function parseSingleNodeLabelSelector(
  raw: string | null | undefined,
): ParsedSingleNodeLabel {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { valid: true, selector: null, key: null, value: null };
  }

  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) {
    if (!isValidLabelKey(trimmed)) {
      return {
        valid: false,
        selector: null,
        key: null,
        value: null,
        error: `Clave de label inválida: "${trimmed}".`,
      };
    }
    return { valid: true, selector: trimmed, key: trimmed, value: null };
  }

  const key = trimmed.slice(0, eqIdx).trim();
  const value = trimmed.slice(eqIdx + 1).trim();
  if (!isValidLabelKey(key)) {
    return {
      valid: false,
      selector: null,
      key: null,
      value: null,
      error: `Clave de label inválida: "${key}".`,
    };
  }
  if (value.length > 63 || !LABEL_VALUE_REGEX.test(value)) {
    return {
      valid: false,
      selector: null,
      key: null,
      value: null,
      error: `Valor de label inválido: "${value}".`,
    };
  }
  const selector = value === '' ? key : `${key}=${value}`;
  return {
    valid: true,
    selector,
    key,
    value: value === '' ? null : value,
  };
}

export function formatCompactNodeLabel(
  selector: string | null | undefined,
): string {
  const parsed = parseSingleNodeLabelSelector(selector);
  if (!parsed.valid || !parsed.key) {
    return selector?.trim() || 'ninguno';
  }
  const slashIdx = parsed.key.lastIndexOf('/');
  const baseKey = slashIdx >= 0 ? parsed.key.slice(slashIdx + 1) : parsed.key;
  if (!parsed.value || parsed.value.toLowerCase() === 'true') {
    return baseKey;
  }
  return `${baseKey}=${parsed.value}`;
}

export function matchNodesForLabelAffinity(
  selector: string | null | undefined,
  nodes: NodeAgentInfo[],
): NodeAgentInfo[] {
  if (!selector) return nodes;
  const parsed = parseSingleNodeLabelSelector(selector);
  if (!parsed.valid || !parsed.key) return [];
  const key = parsed.key;
  if (parsed.value === null) {
    return nodes.filter((node) => node.labels[key] !== undefined);
  }
  return nodes.filter((node) => node.labels[key] === parsed.value);
}

/**
 * Discovers existing node labels across worker agents (excluding control-plane
 * and internal tsure.io/cloudflared-* per-tunnel labels).
 */
export function collectClusterNodeLabels(
  nodes: NodeAgentInfo[],
): NodeLabelOption[] {
  const workerAgents = nodes.filter((n) => !n.isControlPlane);
  const bySelector = new Map<
    string,
    {
      key: string;
      value: string;
      selector: string;
      nodes: Set<string>;
      readyNodes: Set<string>;
      isSystem: boolean;
    }
  >();

  for (const agent of workerAgents) {
    for (const [key, value] of Object.entries(agent.labels)) {
      if (key.startsWith(CLOUDFLARED_NODE_LABEL_PREFIX)) continue;
      if (key === CLOUDFLARED_MANAGED_LABEL_KEY) continue;

      const selector = value === '' ? key : `${key}=${value}`;
      let entry = bySelector.get(selector);
      if (!entry) {
        entry = {
          key,
          value,
          selector,
          nodes: new Set(),
          readyNodes: new Set(),
          isSystem: isSystemNodeLabelKey(key),
        };
        bySelector.set(selector, entry);
      }
      entry.nodes.add(agent.name);
      if (agent.ready && !agent.unschedulable) {
        entry.readyNodes.add(agent.name);
      }
    }
  }

  const rawList = Array.from(bySelector.values());
  const shortCounts = new Map<string, number>();
  for (const item of rawList) {
    const short = formatCompactNodeLabel(item.selector);
    shortCounts.set(short, (shortCounts.get(short) ?? 0) + 1);
  }

  const result: NodeLabelOption[] = rawList.map((item) => {
    const compact = formatCompactNodeLabel(item.selector);
    const shortLabel =
      (shortCounts.get(compact) ?? 0) > 1 ? item.selector : compact;
    return {
      key: item.key,
      value: item.value,
      selector: item.selector,
      shortLabel,
      nodes: Array.from(item.nodes).sort(),
      readyNodes: Array.from(item.readyNodes).sort(),
      isSystem: item.isSystem,
    };
  });

  result.sort((a, b) => {
    if (a.isSystem !== b.isSystem) return a.isSystem ? 1 : -1;
    return a.selector.localeCompare(b.selector);
  });

  return result;
}
