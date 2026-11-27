import type { NamespaceMeta, NodeAgentInfo } from '../types/k8s.js';
import {
  CLOUDFLARED_NODE_LABEL_PREFIX,
  DESCRIPTION_ANNOTATION,
  isDefaultNamespace,
  isProtectedNamespace,
  isSystemNamespace,
  K8S_NODE_SELECTOR_ANNOTATION,
  KLARED_NS_LABEL_PREFIX,
  TSURE_MANAGED_LABEL_KEY,
  TSURE_NODE_SELECTOR_ANNOTATION,
  TSURE_PREFIX,
} from '../utils/validation.js';
import { runKubectlJson } from './kubectl.js';

interface K8sNodeList {
  items: Array<{
    metadata?: {
      name?: string;
      labels?: Record<string, string>;
    };
    spec?: {
      unschedulable?: boolean;
    };
    status?: {
      conditions?: Array<{
        type?: string;
        status?: string;
      }>;
      addresses?: Array<{
        type?: string;
        address?: string;
      }>;
      nodeInfo?: {
        kubeletVersion?: string;
        osImage?: string;
      };
    };
  }>;
}

interface K8sNamespaceList {
  items: Array<{
    metadata?: {
      name?: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    };
    status?: {
      phase?: string;
    };
  }>;
}

export async function listNodes(): Promise<NodeAgentInfo[]> {
  const data = await runKubectlJson<K8sNodeList>(['get', 'nodes', '-o', 'json'], {
    timeoutMs: 12_000,
  });

  const nodes: NodeAgentInfo[] = (data.items ?? []).map((item) => {
    const name = item.metadata?.name ?? 'desconocido';
    const labels = item.metadata?.labels ?? {};
    const roles = Object.keys(labels)
      .filter((k) => k.startsWith('node-role.kubernetes.io/'))
      .map((k) => k.slice('node-role.kubernetes.io/'.length))
      .filter(Boolean)
      .sort();

    const isControlPlane =
      roles.includes('control-plane') || roles.includes('master');

    const readyCondition = item.status?.conditions?.find(
      (c) => c.type === 'Ready',
    );
    const ready = readyCondition?.status === 'True';
    const unschedulable = Boolean(item.spec?.unschedulable);
    const baseStatus = ready ? 'Ready' : 'NotReady';
    const status = unschedulable
      ? `${baseStatus},SchedulingDisabled`
      : baseStatus;

    const internalIp =
      item.status?.addresses?.find((a) => a.type === 'InternalIP')?.address ??
      '-';

    const cloudflaredIds = Object.entries(labels)
      .filter(
        ([k, v]) =>
          k.startsWith(CLOUDFLARED_NODE_LABEL_PREFIX) &&
          v.toLowerCase() !== 'false',
      )
      .map(([k]) => k.slice(CLOUDFLARED_NODE_LABEL_PREFIX.length))
      .filter(Boolean)
      .sort();

    return {
      name,
      roles: roles.length > 0 ? roles : ['agent'],
      isControlPlane,
      ready,
      unschedulable,
      status,
      version: item.status?.nodeInfo?.kubeletVersion ?? '-',
      internalIp,
      osImage: item.status?.nodeInfo?.osImage ?? '-',
      labels,
      cloudflaredIds,
    };
  });

  nodes.sort((a, b) => a.name.localeCompare(b.name));
  return nodes;
}

export function getWorkerAgents(nodes: NodeAgentInfo[]): NodeAgentInfo[] {
  return nodes.filter((n) => !n.isControlPlane);
}

export async function listNamespacesMeta(): Promise<NamespaceMeta[]> {
  const data = await runKubectlJson<K8sNamespaceList>(
    ['get', 'namespaces', '-o', 'json'],
    { timeoutMs: 12_000 },
  );

  const list: NamespaceMeta[] = (data.items ?? []).map((item) => {
    const name = item.metadata?.name ?? 'desconocido';
    const labels = item.metadata?.labels ?? {};
    const annotations = item.metadata?.annotations ?? {};

    const k8sSel = annotations[K8S_NODE_SELECTOR_ANNOTATION]?.trim() || null;
    const tsureSel = annotations[TSURE_NODE_SELECTOR_ANNOTATION]?.trim() || null;

    let nodeSelector: string | null = null;
    let nodeSelectorSource: NamespaceMeta['nodeSelectorSource'] = null;
    if (k8sSel && tsureSel) {
      nodeSelector = k8sSel;
      nodeSelectorSource = 'k8s+tsure';
    } else if (k8sSel) {
      nodeSelector = k8sSel;
      nodeSelectorSource = 'k8s';
    } else if (tsureSel) {
      nodeSelector = tsureSel;
      nodeSelectorSource = 'tsure';
    }

    const klaredIds = Object.entries(labels)
      .filter(
        ([k, v]) =>
          k.startsWith(KLARED_NS_LABEL_PREFIX) && v.toLowerCase() !== 'false',
      )
      .map(([k]) => k.slice(KLARED_NS_LABEL_PREFIX.length))
      .filter(Boolean)
      .sort();

    const toolLabels = Object.entries(labels)
      .filter(
        ([k, v]) =>
          k.startsWith(TSURE_PREFIX) &&
          k !== TSURE_MANAGED_LABEL_KEY &&
          v.toLowerCase() !== 'false',
      )
      .map(([k]) => k.slice(TSURE_PREFIX.length))
      .filter(Boolean)
      .sort();

    return {
      name,
      phase: item.status?.phase ?? 'Active',
      isSystem: isSystemNamespace(name),
      isDefault: isDefaultNamespace(name),
      isProtected: isProtectedNamespace(name),
      isManaged: labels[TSURE_MANAGED_LABEL_KEY] === 'true',
      description: annotations[DESCRIPTION_ANNOTATION] ?? '',
      nodeSelector,
      nodeSelectorSource,
      labels,
      toolLabels,
      klaredIds,
    };
  });

  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}
