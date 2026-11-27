import {
  AGENTS_ANNOTATION,
  buildNodeLabelKey,
  buildResourceName,
  CLOUDFLARED_MANAGED_LABEL_KEY,
  DEFAULT_CLOUDFLARED_VERSION,
  DESCRIPTION_ANNOTATION,
  TUNNEL_ID_ANNOTATION,
  validateImageVersion,
  validateTunnelId,
  validateTunnelName,
} from '../utils/validation.js';

export interface SecretManifestParams {
  name: string;
  namespace: string;
  token: string;
}

export interface DeploymentManifestParams {
  name: string;
  namespace: string;
  tunnelId: string;
  agents: string[];
  replicas: number;
  imageVersion: string;
  description?: string;
}

export interface TunnelBundleParams extends DeploymentManifestParams {
  token: string;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function buildSecretManifest(params: SecretManifestParams): string {
  const nameCheck = validateTunnelName(params.name);
  if (!nameCheck.valid) {
    throw new Error(nameCheck.error ?? 'Nombre de túnel inválido.');
  }
  if (!params.token.trim()) {
    throw new Error('El token del túnel es obligatorio.');
  }

  const resourceName = buildResourceName(params.name);

  return [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${yamlString(resourceName)}`,
    `  namespace: ${yamlString(params.namespace.trim())}`,
    '  labels:',
    `    ${CLOUDFLARED_MANAGED_LABEL_KEY}: "true"`,
    'stringData:',
    `  token: ${yamlString(params.token.trim())}`,
    '',
  ].join('\n');
}

export function buildDeploymentManifest(
  params: DeploymentManifestParams,
): string {
  const nameCheck = validateTunnelName(params.name);
  if (!nameCheck.valid) {
    throw new Error(nameCheck.error ?? 'Nombre de túnel inválido.');
  }
  if (!validateTunnelId(params.tunnelId)) {
    throw new Error(`ID de túnel inválido: "${params.tunnelId}".`);
  }
  const versionCheck = validateImageVersion(params.imageVersion);
  if (!versionCheck.valid) {
    throw new Error(versionCheck.error ?? 'Versión de imagen inválida.');
  }
  if (params.agents.length === 0) {
    throw new Error('Debes seleccionar al menos un agente permitido.');
  }
  if (!Number.isInteger(params.replicas) || params.replicas < 0) {
    throw new Error('El número de réplicas debe ser un entero mayor o igual a 0.');
  }

  const resourceName = buildResourceName(params.name);
  const namespace = params.namespace.trim();
  const nodeLabelKey = buildNodeLabelKey(params.tunnelId);
  const sortedAgents = [...new Set(params.agents)].sort();
  const description = (params.description ?? '').trim();

  const annotations: string[] = [
    `    ${TUNNEL_ID_ANNOTATION}: ${yamlString(params.tunnelId)}`,
    `    ${AGENTS_ANNOTATION}: ${yamlString(sortedAgents.join(','))}`,
  ];
  if (description) {
    annotations.push(`    ${DESCRIPTION_ANNOTATION}: ${yamlString(description)}`);
  }

  return [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    `  name: ${yamlString(resourceName)}`,
    `  namespace: ${yamlString(namespace)}`,
    '  labels:',
    `    ${CLOUDFLARED_MANAGED_LABEL_KEY}: "true"`,
    '  annotations:',
    ...annotations,
    'spec:',
    `  replicas: ${params.replicas}`,
    '  strategy:',
    '    type: RollingUpdate',
    '    rollingUpdate:',
    '      maxSurge: 1',
    '      maxUnavailable: 0',
    '  selector:',
    '    matchLabels:',
    `      app: ${yamlString(resourceName)}`,
    '  template:',
    '    metadata:',
    '      labels:',
    `        app: ${yamlString(resourceName)}`,
    `        ${CLOUDFLARED_MANAGED_LABEL_KEY}: "true"`,
    '    spec:',
    '      affinity:',
    '        nodeAffinity:',
    '          requiredDuringSchedulingIgnoredDuringExecution:',
    '            nodeSelectorTerms:',
    '              - matchExpressions:',
    `                  - key: ${yamlString(nodeLabelKey)}`,
    '                    operator: Exists',
    '      topologySpreadConstraints:',
    '        - maxSkew: 1',
    '          topologyKey: kubernetes.io/hostname',
    '          whenUnsatisfiable: ScheduleAnyway',
    '          labelSelector:',
    '            matchLabels:',
    `              app: ${yamlString(resourceName)}`,
    '      tolerations:',
    '        - key: node.kubernetes.io/unreachable',
    '          operator: Exists',
    '          effect: NoExecute',
    '          tolerationSeconds: 30',
    '        - key: node.kubernetes.io/not-ready',
    '          operator: Exists',
    '          effect: NoExecute',
    '          tolerationSeconds: 30',
    '      containers:',
    '        - name: cloudflared',
    `          image: ${yamlString(`cloudflare/cloudflared:${versionCheck.normalized}`)}`,
    '          args: ["tunnel", "--no-autoupdate", "--metrics", "0.0.0.0:2000", "run"]',
    '          env:',
    '            - name: TUNNEL_TOKEN',
    '              valueFrom:',
    '                secretKeyRef:',
    `                  name: ${yamlString(resourceName)}`,
    '                  key: token',
    '          resources:',
    '            requests:',
    '              cpu: 10m',
    '              memory: 32Mi',
    '            limits:',
    '              cpu: 200m',
    '              memory: 128Mi',
    '          readinessProbe:',
    '            httpGet:',
    '              path: /ready',
    '              port: 2000',
    '            periodSeconds: 5',
    '          livenessProbe:',
    '            httpGet:',
    '              path: /ready',
    '              port: 2000',
    '            initialDelaySeconds: 10',
    '            periodSeconds: 15',
    '',
  ].join('\n');
}

export function buildTunnelBundleYaml(params: TunnelBundleParams): string {
  const secretYaml = buildSecretManifest({
    name: params.name,
    namespace: params.namespace,
    token: params.token,
  });
  const deploymentYaml = buildDeploymentManifest(params);
  return `${secretYaml}---\n${deploymentYaml}`;
}

export async function fetchLatestCloudflaredVersion(): Promise<{
  version: string;
  source: 'github' | 'fallback';
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_500);
  try {
    const res = await fetch(
      'https://api.github.com/repos/cloudflare/cloudflared/releases/latest',
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'klared-tui',
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      return { version: DEFAULT_CLOUDFLARED_VERSION, source: 'fallback' };
    }
    const data = (await res.json()) as { tag_name?: string };
    const tag = (data.tag_name ?? '').trim();
    const check = validateImageVersion(tag);
    if (check.valid) {
      return { version: check.normalized, source: 'github' };
    }
  } catch {
    // Offline or rate-limited -> fallback to pinned stable version
  } finally {
    clearTimeout(timer);
  }
  return { version: DEFAULT_CLOUDFLARED_VERSION, source: 'fallback' };
}
