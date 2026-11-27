export interface NodeAgentInfo {
  name: string;
  roles: string[];
  isControlPlane: boolean;
  ready: boolean;
  unschedulable: boolean;
  status: string;
  version: string;
  internalIp: string;
  osImage: string;
  labels: Record<string, string>;
  cloudflaredIds: string[];
}

export interface AgentEligibility {
  agent: NodeAgentInfo;
  eligible: boolean;
  matchesNamespace: boolean;
  disabledReason: string | null;
}

export interface NamespaceMeta {
  name: string;
  phase: string;
  isSystem: boolean;
  isDefault: boolean;
  isProtected: boolean;
  isManaged: boolean;
  description: string;
  nodeSelector: string | null;
  nodeSelectorSource: 'k8s+tsure' | 'k8s' | 'tsure' | null;
  labels: Record<string, string>;
  toolLabels: string[];
  klaredIds: string[];
}

export type ZeroTrustServiceType = 'HTTP' | 'HTTPS' | 'TCP' | 'SSH' | 'RDP';

export interface ZeroTrustUrlEntry {
  serviceName: string;
  namespace: string;
  serviceType: string;
  clusterIp: string;
  port: number;
  portName?: string;
  ztType: ZeroTrustServiceType;
  /** Short DNS valid within the same namespace: "<svc>:<port>" */
  shortTarget: string;
  /** Cluster FQDN valid from any namespace: "<svc>.<ns>.svc.cluster.local:<port>" */
  fqdnTarget: string;
  /** Recommended target for the Cloudflare Zero Trust URL field */
  recommendedTarget: string;
  /** Full URL with scheme (e.g. "http://web:80" or "tcp://flotip-rw:5432") */
  fullUrl: string;
  /** True when the Service lives in the same namespace as the tunnel */
  sameNamespace: boolean;
}

export interface ServiceEndpointInfo {
  name: string;
  namespace: string;
  type: string;
  clusterIp: string;
  ports: Array<{
    name?: string;
    port: number;
    protocol: string;
  }>;
  suggestedUrls: string[];
}

export interface TunnelPodInfo {
  name: string;
  nodeName: string | null;
  phase: string;
  ready: boolean;
  restarts: number;
  podIp: string;
  pendingReason?: string;
  pendingMessage?: string;
  waitingReason?: string;
}

export type TunnelProtocol = 'http2' | 'auto' | 'quic';

export type TunnelHealthStatus =
  | 'ready'
  | 'rolling'
  | 'paused'
  | 'pending'
  | 'error';

export interface TunnelInfo {
  /** Logical name without the "cloudflared-" prefix */
  name: string;
  /** Kubernetes Deployment and Secret name ("cloudflared-<name>") */
  resourceName: string;
  namespace: string;
  tunnelId: string;
  nodeLabelKey: string;
  namespaceLabelKey: string;
  description: string;
  image: string;
  imageVersion: string;
  protocol: TunnelProtocol;
  replicas: number;
  readyReplicas: number;
  availableReplicas: number;
  desiredReplicasWhenPaused: number;
  /** Source of truth: nodes that currently carry tsure.io/cloudflared-<id> */
  allowedAgents: string[];
  /** Mirror annotation tsure.io/agents */
  annotatedAgents: string[];
  /** Distinct node names where pods are currently scheduled */
  runningAgents: string[];
  pods: TunnelPodInfo[];
  status: TunnelHealthStatus;
  statusLabel: string;
  /** Namespace node-selector read-only from k3access */
  namespaceNodeSelector: string | null;
  /** Non-tunnel app pods running in this namespace (for tailnet cross-node hint) */
  appPodNodes: string[];
  crossNodeTrafficWarning: boolean;
  services: ServiceEndpointInfo[];
  hasMissingAllowedAgents: boolean;
}

export interface OrphanNodeLabel {
  nodeName: string;
  labelKey: string;
  tunnelId: string;
}

export interface OrphanNamespaceLabel {
  namespace: string;
  labelKey: string;
  tunnelId: string;
}

export interface OrphanDeploymentIssue {
  name: string;
  resourceName: string;
  namespace: string;
  tunnelId: string;
  reason: string;
}

export interface OrphanAuditReport {
  orphanNodeLabels: OrphanNodeLabel[];
  orphanNamespaceLabels: OrphanNamespaceLabel[];
  brokenDeployments: OrphanDeploymentIssue[];
  totalIssues: number;
}

export interface ClusterSnapshot {
  nodes: NodeAgentInfo[];
  agents: NodeAgentInfo[];
  namespaces: NamespaceMeta[];
  tunnels: TunnelInfo[];
  services: ServiceEndpointInfo[];
  orphans: OrphanAuditReport;
  podNodeSelectorEnabled: boolean | null;
  fetchedAt: Date;
}

export type PreFlightStepStatus = 'pending' | 'running' | 'ok' | 'warn' | 'error';

export interface PreFlightStep {
  id: string;
  label: string;
  status: PreFlightStepStatus;
  detail?: string;
  hint?: string;
}

export interface PreFlightResult {
  ok: boolean;
  steps: PreFlightStep[];
  kubectlVersion: string;
  context: string;
  clusterVersion: string;
  nodes: NodeAgentInfo[];
  agents: NodeAgentInfo[];
  namespaces: NamespaceMeta[];
  canManageSecrets: boolean;
  canManageDeployments: boolean;
  canPatchNodes: boolean;
  canPatchNamespaces: boolean;
}

export interface OperationStepLog {
  label: string;
  status: 'pending' | 'running' | 'ok' | 'warn' | 'error';
  detail?: string;
}
