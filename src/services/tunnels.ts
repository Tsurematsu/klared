import crypto from 'node:crypto';
import type {
  ClusterSnapshot,
  NamespaceMeta,
  NodeAgentInfo,
  OperationStepLog,
  OrphanAuditReport,
  OrphanDeploymentIssue,
  OrphanNamespaceLabel,
  OrphanNodeLabel,
  ServiceEndpointInfo,
  TunnelHealthStatus,
  TunnelInfo,
  TunnelPodInfo,
  TunnelProtocol,
} from '../types/k8s.js';
import {
  AGENTS_ANNOTATION,
  buildNamespaceLabelKey,
  buildNodeLabelKey,
  buildResourceName,
  CLOUDFLARED_MANAGED_LABEL_KEY,
  computeAgentEligibility,
  DEFAULT_TUNNEL_PROTOCOL,
  DESCRIPTION_ANNOTATION,
  DESIRED_REPLICAS_ANNOTATION,
  detectZeroTrustServiceType,
  extractImageVersion,
  extractTunnelLogicalName,
  extractTunnelProtocol,
  extractTunnelToken,
  isDefaultNamespace,
  isSystemNamespace,
  summarizeCloudflaredLogDiagnostic,
  TUNNEL_ID_ANNOTATION,
  validateImageVersion,
  validateTunnelName,
  validateTunnelProtocol,
} from '../utils/validation.js';
import { runKubectl, runKubectlJson } from './kubectl.js';
import {
  buildSecretManifest,
  buildTunnelBundleYaml,
} from './manifests.js';
import { getWorkerAgents, listNamespacesMeta, listNodes } from './nodes.js';

interface K8sDeploymentItem {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    replicas?: number;
    template?: {
      spec?: {
        affinity?: {
          nodeAffinity?: {
            requiredDuringSchedulingIgnoredDuringExecution?: {
              nodeSelectorTerms?: Array<{
                matchExpressions?: Array<{
                  key?: string;
                  operator?: string;
                  values?: string[];
                }>;
              }>;
            };
          };
        };
        containers?: Array<{
          name?: string;
          image?: string;
          args?: string[];
        }>;
      };
    };
  };
  status?: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
  };
}

interface K8sDeploymentList {
  items: K8sDeploymentItem[];
}

interface K8sPodItem {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
  spec?: {
    nodeName?: string;
  };
  status?: {
    phase?: string;
    podIP?: string;
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
    }>;
    containerStatuses?: Array<{
      ready?: boolean;
      restartCount?: number;
      state?: {
        waiting?: {
          reason?: string;
          message?: string;
        };
      };
    }>;
  };
}

interface K8sPodList {
  items: K8sPodItem[];
}

interface K8sServiceItem {
  metadata?: {
    name?: string;
    namespace?: string;
  };
  spec?: {
    type?: string;
    clusterIP?: string;
    ports?: Array<{
      name?: string;
      port?: number;
      protocol?: string;
    }>;
  };
}

interface K8sServiceList {
  items: K8sServiceItem[];
}

function extractTunnelIdFromDeployment(dep: K8sDeploymentItem): string {
  const fromAnnotation = dep.metadata?.annotations?.[TUNNEL_ID_ANNOTATION]?.trim();
  if (fromAnnotation) return fromAnnotation;

  const terms =
    dep.spec?.template?.spec?.affinity?.nodeAffinity
      ?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? [];
  for (const term of terms) {
    for (const expr of term.matchExpressions ?? []) {
      const key = expr.key ?? '';
      if (key.startsWith('tsure.io/cloudflared-')) {
        return key.slice('tsure.io/cloudflared-'.length);
      }
    }
  }
  return 'sin-id';
}

function buildSuggestedUrls(serviceName: string, ports: ServiceEndpointInfo['ports']): string[] {
  const urls: string[] = [];
  for (const p of ports) {
    if ((p.protocol || 'TCP').toUpperCase() !== 'TCP') continue;
    const scheme = detectZeroTrustServiceType(p.port, p.name).toLowerCase();
    urls.push(`${scheme}://${serviceName}:${p.port}`);
  }
  return urls;
}

export function buildOrphanAuditReport(params: {
  nodes: NodeAgentInfo[];
  namespaces: NamespaceMeta[];
  tunnels: TunnelInfo[];
}): OrphanAuditReport {
  const activeTunnelIds = new Set(params.tunnels.map((t) => t.tunnelId));
  const existingNodeNames = new Set(params.nodes.map((n) => n.name));

  const orphanNodeLabels: OrphanNodeLabel[] = [];
  for (const node of params.nodes) {
    for (const id of node.cloudflaredIds) {
      if (!activeTunnelIds.has(id)) {
        orphanNodeLabels.push({
          nodeName: node.name,
          labelKey: buildNodeLabelKey(id),
          tunnelId: id,
        });
      }
    }
  }

  const orphanNamespaceLabels: OrphanNamespaceLabel[] = [];
  for (const ns of params.namespaces) {
    for (const id of ns.klaredIds) {
      const belongsHere = params.tunnels.some(
        (t) => t.namespace === ns.name && t.tunnelId === id,
      );
      if (!belongsHere) {
        orphanNamespaceLabels.push({
          namespace: ns.name,
          labelKey: buildNamespaceLabelKey(id),
          tunnelId: id,
        });
      }
    }
  }

  const brokenDeployments: OrphanDeploymentIssue[] = [];
  for (const tunnel of params.tunnels) {
    if (tunnel.allowedAgents.length === 0) {
      const missingAnnotated = tunnel.annotatedAgents.filter(
        (a) => !existingNodeNames.has(a),
      );
      const reason =
        missingAnnotated.length > 0
          ? `Los agentes asignados (${missingAnnotated.join(', ')}) ya no existen en el clúster.`
          : `Ningún nodo tiene el label ${tunnel.nodeLabelKey}=true.`;
      brokenDeployments.push({
        name: tunnel.name,
        resourceName: tunnel.resourceName,
        namespace: tunnel.namespace,
        tunnelId: tunnel.tunnelId,
        reason,
      });
    }
  }

  return {
    orphanNodeLabels,
    orphanNamespaceLabels,
    brokenDeployments,
    totalIssues:
      orphanNodeLabels.length +
      orphanNamespaceLabels.length +
      brokenDeployments.length,
  };
}

export async function getClusterSnapshot(): Promise<ClusterSnapshot> {
  const [nodes, namespaces, depList, podList, svcList] = await Promise.all([
    listNodes(),
    listNamespacesMeta(),
    runKubectlJson<K8sDeploymentList>([
      'get',
      'deployments',
      '-A',
      '-l',
      `${CLOUDFLARED_MANAGED_LABEL_KEY}=true`,
      '-o',
      'json',
    ]),
    runKubectlJson<K8sPodList>(['get', 'pods', '-A', '-o', 'json']),
    runKubectlJson<K8sServiceList>(['get', 'services', '-A', '-o', 'json']),
  ]);

  const agents = getWorkerAgents(nodes);
  const nsMap = new Map(namespaces.map((ns) => [ns.name, ns]));

  // Group Services by namespace
  const servicesByNs = new Map<string, ServiceEndpointInfo[]>();
  for (const rawSvc of svcList.items ?? []) {
    const ns = rawSvc.metadata?.namespace;
    const svcName = rawSvc.metadata?.name;
    if (!ns || !svcName) continue;
    if (ns === 'default' && svcName === 'kubernetes') continue;

    const ports = (rawSvc.spec?.ports ?? [])
      .filter((p) => typeof p.port === 'number')
      .map((p) => ({
        name: p.name,
        port: p.port!,
        protocol: p.protocol ?? 'TCP',
      }));

    const info: ServiceEndpointInfo = {
      name: svcName,
      namespace: ns,
      type: rawSvc.spec?.type ?? 'ClusterIP',
      clusterIp: rawSvc.spec?.clusterIP ?? '-',
      ports,
      suggestedUrls: buildSuggestedUrls(svcName, ports),
    };

    const bucket = servicesByNs.get(ns) ?? [];
    bucket.push(info);
    servicesByNs.set(ns, bucket);
  }
  const allUserServices: ServiceEndpointInfo[] = [];
  for (const [ns, list] of servicesByNs.entries()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
    if (!isSystemNamespace(ns)) {
      allUserServices.push(...list);
    }
  }
  allUserServices.sort((a, b) =>
    a.namespace === b.namespace
      ? a.name.localeCompare(b.name)
      : a.namespace.localeCompare(b.namespace),
  );

  // Group Pods by namespace (both tunnel pods and non-tunnel app pods)
  const allPods = podList.items ?? [];
  const appNodesByNs = new Map<string, Set<string>>();
  for (const pod of allPods) {
    const ns = pod.metadata?.namespace;
    const nodeName = pod.spec?.nodeName;
    if (!ns || !nodeName) continue;
    if (pod.metadata?.labels?.[CLOUDFLARED_MANAGED_LABEL_KEY] === 'true') {
      continue;
    }
    if (pod.status?.phase !== 'Running') continue;
    let set = appNodesByNs.get(ns);
    if (!set) {
      set = new Set<string>();
      appNodesByNs.set(ns, set);
    }
    set.add(nodeName);
  }

  const tunnels: TunnelInfo[] = (depList.items ?? []).map((dep) => {
    const resourceName = dep.metadata?.name ?? 'cloudflared-desconocido';
    const name = extractTunnelLogicalName(resourceName);
    const namespace = dep.metadata?.namespace ?? 'default';
    const annotations = dep.metadata?.annotations ?? {};
    const tunnelId = extractTunnelIdFromDeployment(dep);
    const nodeLabelKey = buildNodeLabelKey(tunnelId);
    const namespaceLabelKey = buildNamespaceLabelKey(tunnelId);
    const description = annotations[DESCRIPTION_ANNOTATION] ?? '';

    const container = dep.spec?.template?.spec?.containers?.[0];
    const image = container?.image ?? '';
    const imageVersion = extractImageVersion(image);
    const protocol = extractTunnelProtocol(container?.args);
    const replicas = dep.spec?.replicas ?? 1;
    const readyReplicas = dep.status?.readyReplicas ?? 0;
    const availableReplicas = dep.status?.availableReplicas ?? 0;
    const parsedDesired = Number.parseInt(
      annotations[DESIRED_REPLICAS_ANNOTATION] ?? '',
      10,
    );
    const desiredReplicasWhenPaused =
      Number.isFinite(parsedDesired) && parsedDesired >= 1 ? parsedDesired : 1;

    // Source of truth: nodes that carry tsure.io/cloudflared-<id>
    const allowedAgents = nodes
      .filter(
        (n) =>
          n.labels[nodeLabelKey] !== undefined &&
          n.labels[nodeLabelKey]?.toLowerCase() !== 'false',
      )
      .map((n) => n.name)
      .sort();

    const annotatedAgents = (annotations[AGENTS_ANNOTATION] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();

    const tunnelPods: TunnelPodInfo[] = allPods
      .filter(
        (p) =>
          p.metadata?.namespace === namespace &&
          p.metadata?.labels?.['app'] === resourceName &&
          p.metadata?.labels?.[CLOUDFLARED_MANAGED_LABEL_KEY] === 'true',
      )
      .map((p) => {
        const cs = p.status?.containerStatuses ?? [];
        const ready = cs.length > 0 && cs.every((c) => Boolean(c.ready));
        const restarts = cs.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
        const schedCond = p.status?.conditions?.find(
          (c) => c.type === 'PodScheduled' && c.status === 'False',
        );
        const waiting = cs.find((c) => c.state?.waiting)?.state?.waiting;

        return {
          name: p.metadata?.name ?? 'pod',
          nodeName: p.spec?.nodeName ?? null,
          phase: p.status?.phase ?? 'Unknown',
          ready,
          restarts,
          podIp: p.status?.podIP ?? '-',
          pendingReason: schedCond?.reason,
          pendingMessage: schedCond?.message,
          waitingReason: waiting?.reason,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const runningAgents = [
      ...new Set(
        tunnelPods
          .map((p) => p.nodeName)
          .filter((n): n is string => Boolean(n)),
      ),
    ].sort();

    const hasPendingPod = tunnelPods.some((p) => p.phase === 'Pending');
    const hasErrorPod = tunnelPods.some(
      (p) =>
        p.phase === 'Failed' ||
        p.waitingReason === 'CrashLoopBackOff' ||
        p.waitingReason === 'ImagePullBackOff' ||
        p.waitingReason === 'ErrImagePull',
    );

    let status: TunnelHealthStatus;
    let statusLabel: string;
    if (replicas === 0) {
      status = 'paused';
      statusLabel = '○ Pausado';
    } else if (hasErrorPod) {
      status = 'error';
      statusLabel = '✗ Error';
    } else if (hasPendingPod) {
      status = 'pending';
      statusLabel = '⚠ Pending';
    } else if (readyReplicas >= replicas && readyReplicas > 0) {
      status = 'ready';
      statusLabel = '● Ready';
    } else {
      status = 'rolling';
      statusLabel = '◐ Iniciando';
    }

    const nsMeta = nsMap.get(namespace);
    const appPodNodes = Array.from(appNodesByNs.get(namespace) ?? []).sort();
    const crossNodeTrafficWarning =
      runningAgents.length > 0 &&
      appPodNodes.length > 0 &&
      appPodNodes.some((appNode) => !runningAgents.includes(appNode));

    return {
      name,
      resourceName,
      namespace,
      tunnelId,
      nodeLabelKey,
      namespaceLabelKey,
      description,
      image,
      imageVersion,
      protocol,
      replicas,
      readyReplicas,
      availableReplicas,
      desiredReplicasWhenPaused,
      allowedAgents,
      annotatedAgents,
      runningAgents,
      pods: tunnelPods,
      status,
      statusLabel,
      namespaceNodeSelector: nsMeta?.nodeSelector ?? null,
      appPodNodes,
      crossNodeTrafficWarning,
      services: servicesByNs.get(namespace) ?? [],
      hasMissingAllowedAgents: allowedAgents.length === 0,
    };
  });

  tunnels.sort((a, b) =>
    a.namespace === b.namespace
      ? a.name.localeCompare(b.name)
      : a.namespace.localeCompare(b.namespace),
  );

  const orphans = buildOrphanAuditReport({ nodes, namespaces, tunnels });

  return {
    nodes,
    agents,
    namespaces,
    tunnels,
    services: allUserServices,
    orphans,
    podNodeSelectorEnabled: null,
    fetchedAt: new Date(),
  };
}

export function generateUniqueTunnelId(existingIds: Set<string>): string {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const id = crypto.randomBytes(3).toString('hex'); // 6 hex chars
    if (!existingIds.has(id)) {
      return id;
    }
  }
  return crypto.randomBytes(4).toString('hex');
}

export async function collectExistingTunnelIds(): Promise<Set<string>> {
  const [nodes, namespaces] = await Promise.all([
    listNodes(),
    listNamespacesMeta(),
  ]);
  const ids = new Set<string>();
  for (const node of nodes) {
    for (const id of node.cloudflaredIds) {
      ids.add(id);
    }
  }
  for (const ns of namespaces) {
    for (const id of ns.klaredIds) {
      ids.add(id);
    }
  }
  return ids;
}

export interface InstallTunnelParams {
  name: string;
  rawToken: string;
  namespace: string;
  agents: string[];
  replicas: number;
  imageVersion: string;
  protocol?: TunnelProtocol;
  description?: string;
}

export interface InstallTunnelResult {
  tunnelId: string;
  resourceName: string;
  namespace: string;
  runningAgents: string[];
  services: ServiceEndpointInfo[];
}

export async function installTunnel(
  params: InstallTunnelParams,
  onProgress?: (steps: OperationStepLog[]) => void,
): Promise<InstallTunnelResult> {
  const nameCheck = validateTunnelName(params.name);
  if (!nameCheck.valid) {
    throw new Error(nameCheck.error ?? 'Nombre de túnel inválido.');
  }
  const tokenCheck = extractTunnelToken(params.rawToken);
  if (!tokenCheck.valid) {
    throw new Error(tokenCheck.error ?? 'Token inválido.');
  }
  const versionCheck = validateImageVersion(params.imageVersion);
  if (!versionCheck.valid) {
    throw new Error(versionCheck.error ?? 'Versión de imagen inválida.');
  }
  const protocolCheck = validateTunnelProtocol(
    params.protocol ?? DEFAULT_TUNNEL_PROTOCOL,
  );
  if (!protocolCheck.valid) {
    throw new Error(protocolCheck.error ?? 'Protocolo de túnel inválido.');
  }

  const cleanName = params.name.trim();
  const resourceName = buildResourceName(cleanName);
  const namespace = params.namespace.trim();
  const uniqueAgents = [...new Set(params.agents)].sort();

  if (uniqueAgents.length === 0) {
    throw new Error('Debes elegir al menos un agente permitido.');
  }
  if (params.replicas < 1 || params.replicas > uniqueAgents.length) {
    throw new Error(
      `Las réplicas deben estar entre 1 y ${uniqueAgents.length} (número de agentes elegidos).`,
    );
  }

  const steps: OperationStepLog[] = [
    { label: 'Validar compatibilidad y generar ID único', status: 'pending' },
    { label: 'Etiquetar agentes permitidos', status: 'pending' },
    { label: 'Etiquetar namespace (contrato k3access)', status: 'pending' },
    { label: 'Crear Secret (vía stdin) y aplicar Deployment', status: 'pending' },
    { label: 'Esperar disponibilidad del túnel (/ready)', status: 'pending' },
  ];

  const emit = () => onProgress?.(steps.map((s) => ({ ...s })));
  const mark = (
    idx: number,
    status: OperationStepLog['status'],
    detail?: string,
  ) => {
    const step = steps[idx];
    if (step) {
      step.status = status;
      if (detail !== undefined) step.detail = detail;
    }
    emit();
  };

  let tunnelId = '';
  const labeledNodes: string[] = [];
  let labeledNamespace = false;
  let appliedResources = false;

  const rollback = async (): Promise<string[]> => {
    const notes: string[] = [];
    if (appliedResources) {
      await runKubectl(
        ['delete', 'deployment', resourceName, '-n', namespace, '--ignore-not-found=true'],
        { timeoutMs: 25_000 },
      ).catch((err) => {
        notes.push(`No se pudo eliminar Deployment en rollback: ${String(err)}`);
      });
      await runKubectl(
        ['delete', 'secret', resourceName, '-n', namespace, '--ignore-not-found=true'],
        { timeoutMs: 15_000 },
      ).catch((err) => {
        notes.push(`No se pudo eliminar Secret en rollback: ${String(err)}`);
      });
    }
    if (tunnelId && labeledNodes.length > 0) {
      const nodeKey = buildNodeLabelKey(tunnelId);
      for (const nodeName of labeledNodes) {
        await runKubectl(['label', 'node', nodeName, `${nodeKey}-`], {
          timeoutMs: 12_000,
        }).catch((err) => {
          notes.push(`No se pudo quitar label de ${nodeName}: ${String(err)}`);
        });
      }
    }
    if (tunnelId && labeledNamespace) {
      const nsKey = buildNamespaceLabelKey(tunnelId);
      await runKubectl(['label', 'namespace', namespace, `${nsKey}-`], {
        timeoutMs: 12_000,
      }).catch((err) => {
        notes.push(`No se pudo quitar label del namespace ${namespace}: ${String(err)}`);
      });
    }
    return notes;
  };

  try {
    // 1. Validate & generate unique ID
    mark(0, 'running');
    const [nodes, namespaces] = await Promise.all([
      listNodes(),
      listNamespacesMeta(),
    ]);
    const nsMeta = namespaces.find((n) => n.name === namespace);
    if (!nsMeta) {
      throw new Error(`El namespace "${namespace}" no existe.`);
    }
    const eligibility = computeAgentEligibility(nodes, nsMeta.nodeSelector);
    const eligibleSet = new Set(
      eligibility.filter((e) => e.eligible).map((e) => e.agent.name),
    );
    const invalidAgents = uniqueAgents.filter((a) => !eligibleSet.has(a));
    if (invalidAgents.length > 0) {
      throw new Error(
        `Agentes no elegibles para "${namespace}": ${invalidAgents.join(', ')}`,
      );
    }

    const existingIds = new Set<string>();
    for (const node of nodes) {
      for (const id of node.cloudflaredIds) existingIds.add(id);
    }
    for (const ns of namespaces) {
      for (const id of ns.klaredIds) existingIds.add(id);
    }
    tunnelId = generateUniqueTunnelId(existingIds);
    mark(0, 'ok', `ID ${tunnelId} · ${uniqueAgents.join(', ')}`);

    // 2. Label nodes
    mark(1, 'running');
    const nodeLabelKey = buildNodeLabelKey(tunnelId);
    for (const nodeName of uniqueAgents) {
      await runKubectl(
        ['label', 'node', nodeName, `${nodeLabelKey}=true`, '--overwrite'],
        { timeoutMs: 12_000 },
      );
      labeledNodes.push(nodeName);
    }
    mark(1, 'ok', `${nodeLabelKey}=true en ${labeledNodes.join(', ')}`);

    // 3. Label namespace (tsure.io/klared-<id>=true for k3access, skipping default/system)
    mark(2, 'running');
    const nsLabelKey = buildNamespaceLabelKey(tunnelId);
    if (!isDefaultNamespace(namespace) && !isSystemNamespace(namespace)) {
      await runKubectl(
        ['label', 'namespace', namespace, `${nsLabelKey}=true`, '--overwrite'],
        { timeoutMs: 12_000 },
      );
      labeledNamespace = true;
      mark(2, 'ok', `${nsLabelKey}=true en namespace ${namespace}`);
    } else {
      mark(2, 'ok', `Namespace "${namespace}" sin label adicional`);
    }

    // 4. Apply Secret + Deployment via stdin
    mark(3, 'running');
    const bundleYaml = buildTunnelBundleYaml({
      name: cleanName,
      namespace,
      tunnelId,
      agents: uniqueAgents,
      replicas: params.replicas,
      imageVersion: versionCheck.normalized,
      protocol: protocolCheck.normalized,
      description: params.description,
      token: tokenCheck.token,
    });
    await runKubectl(['apply', '-f', '-'], {
      stdin: bundleYaml,
      redact: [tokenCheck.token],
      timeoutMs: 25_000,
    });
    appliedResources = true;
    mark(3, 'ok', `Secret y Deployment ${resourceName} aplicados`);

    // 5. Wait for rollout status
    mark(4, 'running', 'Esperando /ready (máx. 90s)...');
    await runKubectl(
      [
        'rollout',
        'status',
        `deployment/${resourceName}`,
        '-n',
        namespace,
        '--timeout=90s',
      ],
      {
        timeoutMs: 95_000,
        redact: [tokenCheck.token],
        onStdout: (chunk) => {
          const line = chunk.trim().split('\n').pop();
          if (line) mark(4, 'running', line);
        },
      },
    );
    mark(4, 'ok', 'Túnel desplegado y respondiendo /ready');

    const snapshot = await getClusterSnapshot();
    const created = snapshot.tunnels.find(
      (t) => t.namespace === namespace && t.resourceName === resourceName,
    );

    return {
      tunnelId,
      resourceName,
      namespace,
      runningAgents: created?.runningAgents ?? uniqueAgents,
      services: created?.services ?? [],
    };
  } catch (err) {
    // Capture short pod logs before rollback if Deployment was created (helpful for invalid token)
    let diagnosticHint = '';
    if (appliedResources) {
      try {
        const logsRes = await runKubectl(
          ['logs', '-n', namespace, '-l', `app=${resourceName}`, '--tail=30'],
          { timeoutMs: 6_000, redact: [tokenCheck.token] },
        );
        diagnosticHint = summarizeCloudflaredLogDiagnostic(logsRes.stdout);
      } catch {
        // ignore if pod has no logs yet
      }
    }

    const rollbackNotes = await rollback();
    const failIdx = steps.findIndex((s) => s.status === 'running');
    if (failIdx >= 0) {
      mark(
        failIdx,
        'error',
        `Error — rollback ejecutado${rollbackNotes.length > 0 ? ' con avisos' : ''}`,
      );
    }

    const baseMsg = err instanceof Error ? err.message : String(err);
    const rollbackSuffix =
      rollbackNotes.length > 0
        ? ` (Avisos rollback: ${rollbackNotes.join('; ')})`
        : ' (Rollback completado: clúster dejado limpio)';
    throw new Error(`${baseMsg}${diagnosticHint}${rollbackSuffix}`);
  }
}

export interface UpdateAssignmentParams {
  tunnel: TunnelInfo;
  newAgents: string[];
  newReplicas: number;
  allNodes: NodeAgentInfo[];
}

/**
 * Safe zero-downtime agent reassignment (AGENTS.md section 7.3):
 * 1. Add labels to new agents first.
 * 2. Scale replicas if needed.
 * 3. If any running pod is on a node being removed, rollout restart + wait rollout status.
 *    (If rollout times out -> rollout undo + revert newly added node labels.)
 * 4. Remove labels from discarded agents.
 * 5. Sync tsure.io/agents mirror annotation.
 */
export async function updateTunnelAssignment(
  params: UpdateAssignmentParams,
  onProgress?: (steps: OperationStepLog[]) => void,
): Promise<void> {
  const { tunnel, newReplicas, allNodes } = params;
  const targetAgents = [...new Set(params.newAgents)].sort();

  if (targetAgents.length === 0) {
    throw new Error('No puedes dejar el túnel sin agentes permitidos.');
  }

  const maxReplicas = targetAgents.length;
  const clampedReplicas =
    tunnel.replicas === 0
      ? 0
      : Math.max(1, Math.min(newReplicas, maxReplicas));

  const eligibility = computeAgentEligibility(
    allNodes,
    tunnel.namespaceNodeSelector,
  );
  const eligibleNames = new Set(
    eligibility.filter((e) => e.eligible).map((e) => e.agent.name),
  );
  const toAdd = targetAgents.filter((a) => !tunnel.allowedAgents.includes(a));
  const toRemove = tunnel.allowedAgents.filter((a) => !targetAgents.includes(a));

  const ineligibleNew = toAdd.filter((a) => !eligibleNames.has(a));
  if (ineligibleNew.length > 0) {
    throw new Error(
      `Los agentes nuevos no son elegibles: ${ineligibleNew.join(', ')}`,
    );
  }

  const needsEvacuation =
    clampedReplicas > 0 &&
    tunnel.runningAgents.some((runningNode) => toRemove.includes(runningNode));
  const replicasChanged = clampedReplicas !== tunnel.replicas;

  const steps: OperationStepLog[] = [
    { label: 'Etiquetar agentes nuevos', status: 'pending' },
    { label: 'Ajustar réplicas si corresponde', status: 'pending' },
    { label: 'Evacuar pods de agentes descartados (sin corte)', status: 'pending' },
    { label: 'Retirar label de agentes descartados', status: 'pending' },
    { label: 'Actualizar annotation espejo tsure.io/agents', status: 'pending' },
  ];

  const emit = () => onProgress?.(steps.map((s) => ({ ...s })));
  const mark = (
    idx: number,
    status: OperationStepLog['status'],
    detail?: string,
  ) => {
    const step = steps[idx];
    if (step) {
      step.status = status;
      if (detail !== undefined) step.detail = detail;
    }
    emit();
  };

  const addedNodes: string[] = [];

  try {
    // Step 1: Add labels to new nodes
    mark(0, 'running');
    for (const nodeName of toAdd) {
      await runKubectl(
        ['label', 'node', nodeName, `${tunnel.nodeLabelKey}=true`, '--overwrite'],
        { timeoutMs: 12_000 },
      );
      addedNodes.push(nodeName);
    }
    mark(
      0,
      'ok',
      toAdd.length > 0 ? `Agregados: ${toAdd.join(', ')}` : 'Sin agentes nuevos',
    );

    // Step 2: Scale replicas if changed
    mark(1, 'running');
    if (replicasChanged) {
      await runKubectl(
        [
          'scale',
          `deployment/${tunnel.resourceName}`,
          '-n',
          tunnel.namespace,
          `--replicas=${clampedReplicas}`,
        ],
        { timeoutMs: 15_000 },
      );
      if (clampedReplicas > 0 && !needsEvacuation) {
        await runKubectl(
          [
            'rollout',
            'status',
            `deployment/${tunnel.resourceName}`,
            '-n',
            tunnel.namespace,
            '--timeout=90s',
          ],
          { timeoutMs: 95_000 },
        );
      }
      mark(1, 'ok', `Réplicas: ${tunnel.replicas} → ${clampedReplicas}`);
    } else {
      mark(1, 'ok', `Sin cambios (${clampedReplicas})`);
    }

    // Step 3: If pod is running on a node being removed, remove discarded labels ONLY AFTER
    // ensuring new nodes are labeled, OR temporarily unlabel discarded node -> rollout restart -> wait -> revert if fail.
    // To guarantee pods leave discarded nodes during rollout restart, we temporarily remove the label
    // from discarded nodes (new nodes are ALREADY labeled so valid targets exist), restart, and if rollout fails we restore!
    mark(2, 'running');
    if (needsEvacuation) {
      const removedTemporarily: string[] = [];
      try {
        for (const nodeName of toRemove) {
          await runKubectl(['label', 'node', nodeName, `${tunnel.nodeLabelKey}-`], {
            timeoutMs: 12_000,
          });
          removedTemporarily.push(nodeName);
        }

        await runKubectl(
          ['rollout', 'restart', `deployment/${tunnel.resourceName}`, '-n', tunnel.namespace],
          { timeoutMs: 15_000 },
        );

        await runKubectl(
          [
            'rollout',
            'status',
            `deployment/${tunnel.resourceName}`,
            '-n',
            tunnel.namespace,
            '--timeout=90s',
          ],
          {
            timeoutMs: 95_000,
            onStdout: (chunk) => {
              const line = chunk.trim().split('\n').pop();
              if (line) mark(2, 'running', line);
            },
          },
        );
        mark(2, 'ok', 'Rollout sin corte completado en los nuevos agentes');
        mark(3, 'ok', `Retirados: ${toRemove.join(', ')}`);
      } catch (rolloutErr) {
        // Restore discarded node labels and undo rollout to keep cluster consistent
        for (const nodeName of removedTemporarily) {
          await runKubectl(
            ['label', 'node', nodeName, `${tunnel.nodeLabelKey}=true`, '--overwrite'],
            { timeoutMs: 12_000 },
          ).catch(() => {});
        }
        await runKubectl(
          ['rollout', 'undo', `deployment/${tunnel.resourceName}`, '-n', tunnel.namespace],
          { timeoutMs: 20_000 },
        ).catch(() => {});
        for (const nodeName of addedNodes) {
          await runKubectl(['label', 'node', nodeName, `${tunnel.nodeLabelKey}-`], {
            timeoutMs: 12_000,
          }).catch(() => {});
        }
        mark(2, 'error', 'Rollout expirado/fallido — se ejecutó rollout undo');
        throw rolloutErr;
      }
    } else {
      mark(2, 'ok', 'No se requiere evacuación de pods');

      // Step 4: Remove labels from discarded nodes
      mark(3, 'running');
      for (const nodeName of toRemove) {
        await runKubectl(['label', 'node', nodeName, `${tunnel.nodeLabelKey}-`], {
          timeoutMs: 12_000,
        });
      }
      mark(
        3,
        'ok',
        toRemove.length > 0
          ? `Retirados: ${toRemove.join(', ')}`
          : 'Sin agentes descartados',
      );
    }

    // Step 5: Sync mirror annotation tsure.io/agents
    mark(4, 'running');
    await runKubectl(
      [
        'annotate',
        `deployment/${tunnel.resourceName}`,
        '-n',
        tunnel.namespace,
        `${AGENTS_ANNOTATION}=${targetAgents.join(',')}`,
        '--overwrite',
      ],
      { timeoutMs: 12_000 },
    );
    mark(4, 'ok', `tsure.io/agents=${targetAgents.join(',')}`);
  } catch (err) {
    const runningIdx = steps.findIndex((s) => s.status === 'running');
    if (runningIdx >= 0) {
      mark(runningIdx, 'error', err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

/**
 * Forces a zero-downtime move onto another allowed Ready agent while preserving
 * the full allowed agent set once the new pod is Ready.
 */
export async function moveTunnelToAgent(params: {
  tunnel: TunnelInfo;
  targetAgent: string;
  allNodes: NodeAgentInfo[];
  onProgress?: (steps: OperationStepLog[]) => void;
}): Promise<void> {
  const { tunnel, targetAgent, allNodes, onProgress } = params;
  if (tunnel.replicas === 0) {
    throw new Error('El túnel está pausado. Reactívalo con (p) antes de moverlo.');
  }
  if (!tunnel.allowedAgents.includes(targetAgent)) {
    throw new Error(
      `El agente "${targetAgent}" no está en el conjunto permitido del túnel.`,
    );
  }
  const targetNode = allNodes.find((n) => n.name === targetAgent);
  if (!targetNode || !targetNode.ready || targetNode.unschedulable) {
    throw new Error(`El agente destino "${targetAgent}" no está Ready.`);
  }

  const otherAllowed = tunnel.allowedAgents.filter((a) => a !== targetAgent);
  const steps: OperationStepLog[] = [
    { label: `Dirigir scheduling temporalmente hacia ${targetAgent}`, status: 'pending' },
    { label: 'Reiniciar Deployment y esperar /ready en el destino', status: 'pending' },
    { label: 'Restaurar labels del resto de agentes permitidos', status: 'pending' },
  ];

  const emit = () => onProgress?.(steps.map((s) => ({ ...s })));
  const mark = (
    idx: number,
    status: OperationStepLog['status'],
    detail?: string,
  ) => {
    const step = steps[idx];
    if (step) {
      step.status = status;
      if (detail !== undefined) step.detail = detail;
    }
    emit();
  };

  const temporarilyRemoved: string[] = [];

  try {
    mark(0, 'running');
    for (const nodeName of otherAllowed) {
      await runKubectl(['label', 'node', nodeName, `${tunnel.nodeLabelKey}-`], {
        timeoutMs: 12_000,
      });
      temporarilyRemoved.push(nodeName);
    }
    mark(0, 'ok', `Destino fijado en ${targetAgent}`);

    mark(1, 'running', 'Ejecutando rollout restart...');
    await runKubectl(
      ['rollout', 'restart', `deployment/${tunnel.resourceName}`, '-n', tunnel.namespace],
      { timeoutMs: 15_000 },
    );
    await runKubectl(
      [
        'rollout',
        'status',
        `deployment/${tunnel.resourceName}`,
        '-n',
        tunnel.namespace,
        '--timeout=90s',
      ],
      {
        timeoutMs: 95_000,
        onStdout: (chunk) => {
          const line = chunk.trim().split('\n').pop();
          if (line) mark(1, 'running', line);
        },
      },
    );
    mark(1, 'ok', `Pod listo en ${targetAgent}`);

    mark(2, 'running');
    for (const nodeName of temporarilyRemoved) {
      await runKubectl(
        ['label', 'node', nodeName, `${tunnel.nodeLabelKey}=true`, '--overwrite'],
        { timeoutMs: 12_000 },
      );
    }
    mark(2, 'ok', `Conjunto permitido restaurado (${tunnel.allowedAgents.join(', ')})`);
  } catch (err) {
    // Always restore temporarily removed node labels and undo rollout
    for (const nodeName of temporarilyRemoved) {
      await runKubectl(
        ['label', 'node', nodeName, `${tunnel.nodeLabelKey}=true`, '--overwrite'],
        { timeoutMs: 12_000 },
      ).catch(() => {});
    }
    await runKubectl(
      ['rollout', 'undo', `deployment/${tunnel.resourceName}`, '-n', tunnel.namespace],
      { timeoutMs: 20_000 },
    ).catch(() => {});
    const runningIdx = steps.findIndex((s) => s.status === 'running');
    if (runningIdx >= 0) {
      mark(runningIdx, 'error', 'Falló el traslado — rollout revertido y labels restaurados');
    }
    throw err;
  }
}

export async function restartTunnel(tunnel: TunnelInfo): Promise<void> {
  if (tunnel.replicas === 0) {
    throw new Error('El túnel está pausado (0 réplicas). Reactívalo con (p) primero.');
  }
  await runKubectl(
    ['rollout', 'restart', `deployment/${tunnel.resourceName}`, '-n', tunnel.namespace],
    { timeoutMs: 15_000 },
  );
  try {
    await runKubectl(
      [
        'rollout',
        'status',
        `deployment/${tunnel.resourceName}`,
        '-n',
        tunnel.namespace,
        '--timeout=90s',
      ],
      { timeoutMs: 95_000 },
    );
  } catch (err) {
    await runKubectl(
      ['rollout', 'undo', `deployment/${tunnel.resourceName}`, '-n', tunnel.namespace],
      { timeoutMs: 20_000 },
    ).catch(() => {});
    throw new Error(
      `El reinicio expiró o falló (se ejecutó rollout undo): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export async function togglePauseTunnel(tunnel: TunnelInfo): Promise<{
  paused: boolean;
  replicas: number;
}> {
  if (tunnel.replicas > 0) {
    await runKubectl(
      [
        'annotate',
        `deployment/${tunnel.resourceName}`,
        '-n',
        tunnel.namespace,
        `${DESIRED_REPLICAS_ANNOTATION}=${tunnel.replicas}`,
        '--overwrite',
      ],
      { timeoutMs: 12_000 },
    );
    await runKubectl(
      [
        'scale',
        `deployment/${tunnel.resourceName}`,
        '-n',
        tunnel.namespace,
        '--replicas=0',
      ],
      { timeoutMs: 15_000 },
    );
    return { paused: true, replicas: 0 };
  }

  const maxAllowed = Math.max(1, tunnel.allowedAgents.length);
  const targetReplicas = Math.max(
    1,
    Math.min(tunnel.desiredReplicasWhenPaused, maxAllowed),
  );
  await runKubectl(
    [
      'scale',
      `deployment/${tunnel.resourceName}`,
      '-n',
      tunnel.namespace,
      `--replicas=${targetReplicas}`,
    ],
    { timeoutMs: 15_000 },
  );
  await runKubectl(
    [
      'rollout',
      'status',
      `deployment/${tunnel.resourceName}`,
      '-n',
      tunnel.namespace,
      '--timeout=90s',
    ],
    { timeoutMs: 95_000 },
  );
  return { paused: false, replicas: targetReplicas };
}

export async function rotateTunnelToken(params: {
  tunnel: TunnelInfo;
  rawToken: string;
  onProgress?: (steps: OperationStepLog[]) => void;
}): Promise<void> {
  const { tunnel, rawToken, onProgress } = params;
  const tokenCheck = extractTunnelToken(rawToken);
  if (!tokenCheck.valid) {
    throw new Error(tokenCheck.error ?? 'Token inválido.');
  }

  const steps: OperationStepLog[] = [
    { label: 'Actualizar Secret vía stdin (sin exponer token)', status: 'pending' },
    { label: 'Reiniciar Deployment para aplicar el nuevo token', status: 'pending' },
    { label: 'Verificar disponibilidad /ready', status: 'pending' },
  ];
  const emit = () => onProgress?.(steps.map((s) => ({ ...s })));
  const mark = (
    idx: number,
    status: OperationStepLog['status'],
    detail?: string,
  ) => {
    const step = steps[idx];
    if (step) {
      step.status = status;
      if (detail !== undefined) step.detail = detail;
    }
    emit();
  };

  try {
    mark(0, 'running');
    const secretYaml = buildSecretManifest({
      name: tunnel.name,
      namespace: tunnel.namespace,
      token: tokenCheck.token,
    });
    await runKubectl(['apply', '-f', '-'], {
      stdin: secretYaml,
      redact: [tokenCheck.token],
      timeoutMs: 15_000,
    });
    mark(0, 'ok', `Secret ${tunnel.resourceName} actualizado`);

    if (tunnel.replicas === 0) {
      mark(1, 'ok', 'Túnel pausado (se aplicará al reactivar)');
      mark(2, 'ok', 'Omitido mientras está en 0 réplicas');
      return;
    }

    mark(1, 'running');
    await runKubectl(
      ['rollout', 'restart', `deployment/${tunnel.resourceName}`, '-n', tunnel.namespace],
      { timeoutMs: 15_000, redact: [tokenCheck.token] },
    );
    mark(1, 'ok', 'Reinicio disparado');

    mark(2, 'running', 'Esperando /ready (máx. 90s)...');
    await runKubectl(
      [
        'rollout',
        'status',
        `deployment/${tunnel.resourceName}`,
        '-n',
        tunnel.namespace,
        '--timeout=90s',
      ],
      {
        timeoutMs: 95_000,
        redact: [tokenCheck.token],
        onStdout: (chunk) => {
          const line = chunk.trim().split('\n').pop();
          if (line) mark(2, 'running', line);
        },
      },
    );
    mark(2, 'ok', 'Nuevo token validado y pod Ready');
  } catch (err) {
    const runningIdx = steps.findIndex((s) => s.status === 'running');
    if (runningIdx >= 0) {
      mark(
        runningIdx,
        'error',
        'El pod no llegó a Ready — revisa logs (token posiblemente inválido)',
      );
    }
    throw err;
  }
}

export async function deleteTunnel(params: {
  tunnel: TunnelInfo;
  allNodes: NodeAgentInfo[];
  onProgress?: (steps: OperationStepLog[]) => void;
}): Promise<void> {
  const { tunnel, allNodes, onProgress } = params;

  const steps: OperationStepLog[] = [
    { label: `Eliminar Deployment ${tunnel.resourceName}`, status: 'pending' },
    { label: `Eliminar Secret ${tunnel.resourceName}`, status: 'pending' },
    { label: `Retirar label ${tunnel.nodeLabelKey} de nodos`, status: 'pending' },
    { label: `Retirar label ${tunnel.namespaceLabelKey} del namespace`, status: 'pending' },
  ];
  const emit = () => onProgress?.(steps.map((s) => ({ ...s })));
  const mark = (
    idx: number,
    status: OperationStepLog['status'],
    detail?: string,
  ) => {
    const step = steps[idx];
    if (step) {
      step.status = status;
      if (detail !== undefined) step.detail = detail;
    }
    emit();
  };

  try {
    mark(0, 'running');
    await runKubectl(
      [
        'delete',
        'deployment',
        tunnel.resourceName,
        '-n',
        tunnel.namespace,
        '--ignore-not-found=true',
      ],
      { timeoutMs: 25_000 },
    );
    mark(0, 'ok', 'Deployment eliminado');

    mark(1, 'running');
    await runKubectl(
      [
        'delete',
        'secret',
        tunnel.resourceName,
        '-n',
        tunnel.namespace,
        '--ignore-not-found=true',
      ],
      { timeoutMs: 15_000 },
    );
    mark(1, 'ok', 'Secret eliminado');

    mark(2, 'running');
    const nodesWithLabel = allNodes
      .filter((n) => n.labels[tunnel.nodeLabelKey] !== undefined)
      .map((n) => n.name);
    for (const nodeName of nodesWithLabel) {
      await runKubectl(['label', 'node', nodeName, `${tunnel.nodeLabelKey}-`], {
        timeoutMs: 12_000,
      });
    }
    mark(
      2,
      'ok',
      nodesWithLabel.length > 0
        ? `Retirado de: ${nodesWithLabel.join(', ')}`
        : 'Ningún nodo tenía el label',
    );

    mark(3, 'running');
    if (
      !isDefaultNamespace(tunnel.namespace) &&
      !isSystemNamespace(tunnel.namespace)
    ) {
      await runKubectl(
        ['label', 'namespace', tunnel.namespace, `${tunnel.namespaceLabelKey}-`],
        { timeoutMs: 12_000 },
      ).catch(() => {
        // Namespace might not have the label if created manually
      });
      mark(3, 'ok', `Namespace ${tunnel.namespace} limpio`);
    } else {
      mark(3, 'ok', `Namespace "${tunnel.namespace}" sin cambios`);
    }
  } catch (err) {
    const runningIdx = steps.findIndex((s) => s.status === 'running');
    if (runningIdx >= 0) {
      mark(runningIdx, 'error', err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

export async function fetchTunnelLogs(
  tunnel: TunnelInfo,
  tailLines = 30,
): Promise<string[]> {
  if (tunnel.pods.length === 0) {
    return ['(No hay pods activos para este túnel)'];
  }
  const targetPod =
    tunnel.pods.find((p) => !p.ready) ?? tunnel.pods[0]!;
  try {
    const res = await runKubectl(
      [
        'logs',
        targetPod.name,
        '-n',
        tunnel.namespace,
        `--tail=${tailLines}`,
      ],
      { timeoutMs: 10_000 },
    );
    const lines = res.stdout
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean);
    return lines.length > 0 ? lines : ['(Sin líneas de log todavía)'];
  } catch (err) {
    return [
      `(No se pudieron leer logs de ${targetPod.name}: ${
        err instanceof Error ? err.message : String(err)
      })`,
    ];
  }
}

export async function cleanupOrphanLabels(params: {
  orphanNodeLabels: OrphanNodeLabel[];
  orphanNamespaceLabels: OrphanNamespaceLabel[];
}): Promise<{ removedNodes: number; removedNamespaces: number }> {
  let removedNodes = 0;
  let removedNamespaces = 0;

  for (const item of params.orphanNodeLabels) {
    await runKubectl(['label', 'node', item.nodeName, `${item.labelKey}-`], {
      timeoutMs: 12_000,
    });
    removedNodes += 1;
  }

  for (const item of params.orphanNamespaceLabels) {
    await runKubectl(
      ['label', 'namespace', item.namespace, `${item.labelKey}-`],
      { timeoutMs: 12_000 },
    );
    removedNamespaces += 1;
  }

  return { removedNodes, removedNamespaces };
}

/**
 * Scales a tunnel Deployment directly to the target replica count (1..allowedAgents)
 * and waits for rollout status.
 */
export async function scaleTunnelReplicas(params: {
  tunnel: TunnelInfo;
  newReplicas: number;
}): Promise<number> {
  const { tunnel, newReplicas } = params;
  if (tunnel.allowedAgents.length === 0) {
    throw new Error(
      'El túnel no tiene agentes permitidos. Asigna agentes antes de escalar.',
    );
  }
  const maxReplicas = Math.max(1, tunnel.allowedAgents.length);
  if (!Number.isInteger(newReplicas) || newReplicas < 1 || newReplicas > maxReplicas) {
    throw new Error(
      `Las réplicas deben estar entre 1 y ${maxReplicas} (agentes permitidos).`,
    );
  }

  await runKubectl(
    [
      'scale',
      `deployment/${tunnel.resourceName}`,
      '-n',
      tunnel.namespace,
      `--replicas=${newReplicas}`,
    ],
    { timeoutMs: 15_000 },
  );

  await runKubectl(
    [
      'rollout',
      'status',
      `deployment/${tunnel.resourceName}`,
      '-n',
      tunnel.namespace,
      '--timeout=90s',
    ],
    { timeoutMs: 95_000 },
  );

  return newReplicas;
}

interface K8sSecretItem {
  data?: {
    token?: string;
  };
}

export interface MigrateTunnelNamespaceParams {
  tunnel: TunnelInfo;
  targetNamespace: string;
  allNodes: NodeAgentInfo[];
  namespaces: NamespaceMeta[];
  existingTunnels: TunnelInfo[];
  onProgress?: (steps: OperationStepLog[]) => void;
}

export interface MigrateTunnelNamespaceResult {
  sourceNamespace: string;
  targetNamespace: string;
  agents: string[];
  replicas: number;
}

/**
 * Moves a stateless cloudflared tunnel to another namespace (e.g. from default
 * to a k3access-managed namespace like "flotip", or vice versa) with zero
 * downtime: creates Secret + Deployment in target first, waits for /ready,
 * and only then removes the old Deployment, Secret and source namespace label.
 */
export async function migrateTunnelNamespace(
  params: MigrateTunnelNamespaceParams,
): Promise<MigrateTunnelNamespaceResult> {
  const { tunnel, allNodes, namespaces, existingTunnels, onProgress } = params;
  const targetNamespace = params.targetNamespace.trim();

  if (!targetNamespace) {
    throw new Error('Debes indicar un namespace destino.');
  }
  if (targetNamespace === tunnel.namespace) {
    throw new Error(`El túnel ya corre en el namespace "${targetNamespace}".`);
  }

  const targetNs = namespaces.find((ns) => ns.name === targetNamespace);
  if (!targetNs) {
    throw new Error(`El namespace "${targetNamespace}" no existe.`);
  }
  if (targetNs.isSystem) {
    throw new Error(
      `No se permite mover túneles al namespace del sistema "${targetNamespace}".`,
    );
  }
  if (targetNs.phase !== 'Active') {
    throw new Error(
      `El namespace "${targetNamespace}" no está Active (${targetNs.phase}).`,
    );
  }
  if (
    existingTunnels.some(
      (t) =>
        t.namespace === targetNamespace &&
        t.resourceName === tunnel.resourceName,
    )
  ) {
    throw new Error(
      `Ya existe "${tunnel.resourceName}" en el namespace "${targetNamespace}".`,
    );
  }

  const steps: OperationStepLog[] = [
    { label: 'Validar compatibilidad con el namespace destino', status: 'pending' },
    { label: 'Leer token del Secret origen (en memoria)', status: 'pending' },
    { label: 'Preparar etiquetas de nodos y namespace destino', status: 'pending' },
    { label: `Desplegar Secret + Deployment en "${targetNamespace}"`, status: 'pending' },
    { label: 'Esperar /ready en destino (sin corte)', status: 'pending' },
    { label: `Limpiar recursos y label en "${tunnel.namespace}"`, status: 'pending' },
  ];

  const emit = () => onProgress?.(steps.map((s) => ({ ...s })));
  const mark = (
    idx: number,
    status: OperationStepLog['status'],
    detail?: string,
  ) => {
    const step = steps[idx];
    if (step) {
      step.status = status;
      if (detail !== undefined) step.detail = detail;
    }
    emit();
  };

  let token = '';
  const addedNodes: string[] = [];
  let labeledTargetNs = false;
  let appliedTarget = false;

  const rollbackTarget = async (): Promise<void> => {
    if (appliedTarget) {
      await runKubectl(
        [
          'delete',
          'deployment',
          tunnel.resourceName,
          '-n',
          targetNamespace,
          '--ignore-not-found=true',
        ],
        { timeoutMs: 25_000, redact: token ? [token] : [] },
      ).catch(() => {});
      await runKubectl(
        [
          'delete',
          'secret',
          tunnel.resourceName,
          '-n',
          targetNamespace,
          '--ignore-not-found=true',
        ],
        { timeoutMs: 15_000, redact: token ? [token] : [] },
      ).catch(() => {});
    }
    if (labeledTargetNs) {
      await runKubectl(
        ['label', 'namespace', targetNamespace, `${tunnel.namespaceLabelKey}-`],
        { timeoutMs: 12_000 },
      ).catch(() => {});
    }
    for (const nodeName of addedNodes) {
      await runKubectl(
        ['label', 'node', nodeName, `${tunnel.nodeLabelKey}-`],
        { timeoutMs: 12_000 },
      ).catch(() => {});
    }
  };

  try {
    // 1. Check agent compatibility with target namespace node-selector
    mark(0, 'running');
    const eligibility = computeAgentEligibility(allNodes, targetNs.nodeSelector);
    const eligibleNames = eligibility
      .filter((e) => e.eligible)
      .map((e) => e.agent.name)
      .sort();
    if (eligibleNames.length === 0) {
      throw new Error(
        `Ningún agente Ready es compatible con la afinidad del namespace "${targetNamespace}".`,
      );
    }

    const overlap = tunnel.allowedAgents
      .filter((a) => eligibleNames.includes(a))
      .sort();
    const nextAgents = overlap.length > 0 ? overlap : eligibleNames;
    const agentsToAdd = nextAgents.filter(
      (a) => !tunnel.allowedAgents.includes(a),
    );
    const agentsToRemove = tunnel.allowedAgents.filter(
      (a) => !nextAgents.includes(a),
    );
    const nextReplicas =
      tunnel.replicas === 0
        ? 0
        : Math.max(1, Math.min(tunnel.replicas, nextAgents.length));

    mark(
      0,
      'ok',
      `${tunnel.namespace} → ${targetNamespace} · agentes: ${nextAgents.join(', ')}`,
    );

    // 2. Read token from source Secret (in memory only, redacted)
    mark(1, 'running');
    const secretObj = await runKubectlJson<K8sSecretItem>(
      ['get', 'secret', tunnel.resourceName, '-n', tunnel.namespace, '-o', 'json'],
      { timeoutMs: 12_000 },
    );
    const encodedToken = secretObj.data?.token?.trim() ?? '';
    if (!encodedToken) {
      throw new Error(
        `No se encontró el campo "token" en el Secret "${tunnel.resourceName}" de "${tunnel.namespace}".`,
      );
    }
    token = Buffer.from(encodedToken, 'base64').toString('utf8').trim();
    if (!token) {
      throw new Error(
        `El token del Secret "${tunnel.resourceName}" está vacío.`,
      );
    }
    mark(1, 'ok', 'Token leído de forma segura');

    // 3. Label any new compatible nodes + target namespace (skipping default/system)
    mark(2, 'running');
    for (const nodeName of agentsToAdd) {
      await runKubectl(
        ['label', 'node', nodeName, `${tunnel.nodeLabelKey}=true`, '--overwrite'],
        { timeoutMs: 12_000, redact: [token] },
      );
      addedNodes.push(nodeName);
    }
    if (!targetNs.isDefault && !targetNs.isSystem) {
      await runKubectl(
        [
          'label',
          'namespace',
          targetNamespace,
          `${tunnel.namespaceLabelKey}=true`,
          '--overwrite',
        ],
        { timeoutMs: 12_000, redact: [token] },
      );
      labeledTargetNs = true;
    }
    mark(
      2,
      'ok',
      labeledTargetNs
        ? `${tunnel.namespaceLabelKey}=true en ${targetNamespace}`
        : `Destino "${targetNamespace}" listo`,
    );

    // 4. Apply Secret + Deployment in target namespace via stdin
    mark(3, 'running');
    const bundleYaml = buildTunnelBundleYaml({
      name: tunnel.name,
      namespace: targetNamespace,
      tunnelId: tunnel.tunnelId,
      agents: nextAgents,
      replicas: nextReplicas,
      imageVersion: tunnel.imageVersion,
      protocol: tunnel.protocol,
      description: tunnel.description,
      token,
    });
    await runKubectl(['apply', '-f', '-'], {
      stdin: bundleYaml,
      redact: [token],
      timeoutMs: 25_000,
    });
    appliedTarget = true;

    if (nextReplicas === 0 && tunnel.desiredReplicasWhenPaused > 0) {
      await runKubectl(
        [
          'annotate',
          `deployment/${tunnel.resourceName}`,
          '-n',
          targetNamespace,
          `${DESIRED_REPLICAS_ANNOTATION}=${Math.min(tunnel.desiredReplicasWhenPaused, nextAgents.length)}`,
          '--overwrite',
        ],
        { timeoutMs: 12_000, redact: [token] },
      ).catch(() => {});
    }
    mark(3, 'ok', `Aplicado en ${targetNamespace}`);

    // 5. Wait for rollout status in target namespace (zero downtime!)
    mark(4, 'running');
    if (nextReplicas > 0) {
      await runKubectl(
        [
          'rollout',
          'status',
          `deployment/${tunnel.resourceName}`,
          '-n',
          targetNamespace,
          '--timeout=90s',
        ],
        {
          timeoutMs: 95_000,
          redact: [token],
          onStdout: (chunk) => {
            const line = chunk.trim().split('\n').pop();
            if (line) mark(4, 'running', line);
          },
        },
      );
      mark(4, 'ok', `Túnel Ready en "${targetNamespace}"`);
    } else {
      mark(4, 'ok', 'Túnel pausado (0 réplicas)');
    }

    // 6. Clean up old Deployment, Secret, source namespace label & incompatible node labels
    mark(5, 'running');
    await runKubectl(
      [
        'delete',
        'deployment',
        tunnel.resourceName,
        '-n',
        tunnel.namespace,
        '--ignore-not-found=true',
      ],
      { timeoutMs: 25_000, redact: [token] },
    );
    await runKubectl(
      [
        'delete',
        'secret',
        tunnel.resourceName,
        '-n',
        tunnel.namespace,
        '--ignore-not-found=true',
      ],
      { timeoutMs: 15_000, redact: [token] },
    );
    if (
      !isDefaultNamespace(tunnel.namespace) &&
      !isSystemNamespace(tunnel.namespace)
    ) {
      await runKubectl(
        ['label', 'namespace', tunnel.namespace, `${tunnel.namespaceLabelKey}-`],
        { timeoutMs: 12_000 },
      ).catch(() => {});
    }
    for (const nodeName of agentsToRemove) {
      await runKubectl(
        ['label', 'node', nodeName, `${tunnel.nodeLabelKey}-`],
        { timeoutMs: 12_000 },
      ).catch(() => {});
    }
    mark(5, 'ok', `Origen "${tunnel.namespace}" limpiado`);

    return {
      sourceNamespace: tunnel.namespace,
      targetNamespace,
      agents: nextAgents,
      replicas: nextReplicas,
    };
  } catch (err) {
    await rollbackTarget();
    const runningIdx = steps.findIndex((s) => s.status === 'running');
    if (runningIdx >= 0) {
      mark(
        runningIdx,
        'error',
        `Error — destino revertido, origen "${tunnel.namespace}" intacto`,
      );
    }
    throw err;
  }
}
