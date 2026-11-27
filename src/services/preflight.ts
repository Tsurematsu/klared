import type {
  NamespaceMeta,
  NodeAgentInfo,
  PreFlightResult,
  PreFlightStep,
} from '../types/k8s.js';
import { KubectlError, runKubectl, runKubectlJson } from './kubectl.js';
import { getWorkerAgents, listNamespacesMeta, listNodes } from './nodes.js';

interface KubectlVersionOutput {
  clientVersion?: {
    gitVersion?: string;
  };
}

export async function runPreFlight(
  onProgress?: (steps: PreFlightStep[]) => void,
): Promise<PreFlightResult> {
  const steps: PreFlightStep[] = [
    { id: 'binary', label: 'Verificar instalación de kubectl', status: 'pending' },
    { id: 'context', label: 'Validar contexto activo de kubeconfig', status: 'pending' },
    { id: 'cluster', label: 'Comprobar acceso al servidor k3s y agentes Ready', status: 'pending' },
    { id: 'rbac', label: 'Validar permisos RBAC (Secrets, Deployments, Nodes, Namespaces)', status: 'pending' },
    { id: 'namespaces', label: 'Leer namespaces existentes del clúster', status: 'pending' },
  ];

  const notify = () => {
    onProgress?.(steps.map((s) => ({ ...s })));
  };

  const setStep = (
    id: string,
    patch: Partial<Omit<PreFlightStep, 'id' | 'label'>>,
  ) => {
    const step = steps.find((s) => s.id === id);
    if (step) {
      Object.assign(step, patch);
    }
    notify();
  };

  let kubectlVersion = '-';
  let context = '-';
  let clusterVersion = '-';
  let nodes: NodeAgentInfo[] = [];
  let agents: NodeAgentInfo[] = [];
  let namespaces: NamespaceMeta[] = [];
  let canManageSecrets = false;
  let canManageDeployments = false;
  let canPatchNodes = false;
  let canPatchNamespaces = false;

  const failResult = (): PreFlightResult => ({
    ok: false,
    steps,
    kubectlVersion,
    context,
    clusterVersion,
    nodes,
    agents,
    namespaces,
    canManageSecrets,
    canManageDeployments,
    canPatchNodes,
    canPatchNamespaces,
  });

  // 1. Verificar binario kubectl
  setStep('binary', { status: 'running' });
  try {
    const ver = await runKubectlJson<KubectlVersionOutput>(
      ['version', '--client', '-o', 'json'],
      { timeoutMs: 8_000 },
    );
    kubectlVersion = ver.clientVersion?.gitVersion ?? 'instalado';
    setStep('binary', {
      status: 'ok',
      detail: `kubectl ${kubectlVersion}`,
    });
  } catch (err) {
    const isMissing = err instanceof KubectlError && err.code === 'NOT_INSTALLED';
    setStep('binary', {
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
      hint: isMissing
        ? 'Instala kubectl en el equipo local y asegúrate de que esté en el PATH.'
        : 'Verifica que el binario kubectl sea ejecutable.',
    });
    return failResult();
  }

  // 2. Validar contexto activo
  setStep('context', { status: 'running' });
  try {
    const ctxResult = await runKubectl(['config', 'current-context'], {
      timeoutMs: 8_000,
    });
    context = ctxResult.stdout.trim();
    if (!context) {
      throw new Error('No hay ningún contexto activo configurado en kubeconfig.');
    }
    setStep('context', {
      status: 'ok',
      detail: `Contexto activo: ${context}`,
    });
  } catch (err) {
    setStep('context', {
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
      hint: 'Configura ~/.kube/config (o KUBECONFIG) y selecciona un contexto activo.',
    });
    return failResult();
  }

  // 3. Conectividad con servidor k3s y agentes Ready (excluyendo control-plane)
  setStep('cluster', { status: 'running' });
  try {
    nodes = await listNodes();
    if (nodes.length === 0) {
      throw new Error('El clúster respondió pero no devolvió nodos.');
    }
    clusterVersion = nodes[0]?.version ?? '-';
    agents = getWorkerAgents(nodes);

    if (agents.length === 0) {
      setStep('cluster', {
        status: 'error',
        detail: `Se detectaron ${nodes.length} nodo(s), pero ningún agente worker (solo control-plane).`,
        hint: 'Conecta al menos un agente k3s (k3s-agent) al clúster para desplegar túneles.',
      });
      return failResult();
    }

    const readyAgents = agents.filter((a) => a.ready && !a.unschedulable);
    const namesSummary = agents
      .map((a) => `${a.name} (${a.status})`)
      .join(', ');

    if (readyAgents.length === 0) {
      setStep('cluster', {
        status: 'error',
        detail: `0/${agents.length} agentes Ready (${clusterVersion}) · ${namesSummary}`,
        hint: 'Verifica que al menos un agente k3s esté en estado Ready y schedulable.',
      });
      return failResult();
    }

    setStep('cluster', {
      status: readyAgents.length === agents.length ? 'ok' : 'warn',
      detail: `${readyAgents.length}/${agents.length} agentes Ready (${clusterVersion}) · ${namesSummary}`,
    });
  } catch (err) {
    setStep('cluster', {
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
      hint: 'Revisa conectividad (tailnet/LAN) con el servidor k3s y credenciales en ~/.kube/config.',
    });
    return failResult();
  }

  // 4. Permisos RBAC
  setStep('rbac', { status: 'running' });
  try {
    const canI = async (verb: string, resource: string): Promise<boolean> => {
      try {
        const res = await runKubectl(['auth', 'can-i', verb, resource], {
          timeoutMs: 8_000,
        });
        return res.stdout.trim().toLowerCase() === 'yes';
      } catch {
        return false;
      }
    };

    const [
      secCreate,
      secPatch,
      secDelete,
      depList,
      depCreate,
      depPatch,
      depDelete,
      nodePatch,
      nsList,
      nsPatch,
    ] = await Promise.all([
      canI('create', 'secrets'),
      canI('patch', 'secrets'),
      canI('delete', 'secrets'),
      canI('list', 'deployments.apps'),
      canI('create', 'deployments.apps'),
      canI('patch', 'deployments.apps'),
      canI('delete', 'deployments.apps'),
      canI('patch', 'nodes'),
      canI('list', 'namespaces'),
      canI('patch', 'namespaces'),
    ]);

    canManageSecrets = secCreate && secPatch && secDelete;
    canManageDeployments = depList && depCreate && depPatch && depDelete;
    canPatchNodes = nodePatch;
    canPatchNamespaces = nsPatch;

    const missing: string[] = [];
    if (!canManageSecrets) missing.push('secrets (create/patch/delete)');
    if (!canManageDeployments) missing.push('deployments (list/create/patch/delete)');
    if (!canPatchNodes) missing.push('nodes (patch)');
    if (!nsList) missing.push('namespaces (list)');

    if (missing.length > 0) {
      setStep('rbac', {
        status: 'error',
        detail: `Faltan permisos RBAC: ${missing.join(', ')}`,
        hint: 'Usa un contexto con permisos administrativos para crear Secrets/Deployments y etiquetar nodos.',
      });
      return failResult();
    }

    setStep('rbac', {
      status: canPatchNamespaces ? 'ok' : 'warn',
      detail: canPatchNamespaces
        ? 'Permisos completos (Secrets, Deployments, patch Nodes y patch Namespaces)'
        : 'Permisos base OK (sin patch en Namespaces: no se podrá marcar tsure.io/klared-<id> en namespaces)',
    });
  } catch (err) {
    setStep('rbac', {
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    });
    return failResult();
  }

  // 5. Lectura de namespaces
  setStep('namespaces', { status: 'running' });
  try {
    namespaces = await listNamespacesMeta();
    const userNamespaces = namespaces.filter((ns) => !ns.isProtected);
    const withAffinity = userNamespaces.filter((ns) => ns.nodeSelector).length;
    setStep('namespaces', {
      status: 'ok',
      detail: `${namespaces.length} namespaces (${userNamespaces.length} de usuario${
        withAffinity > 0 ? `, ${withAffinity} con afinidad k3access` : ''
      })`,
    });
  } catch (err) {
    setStep('namespaces', {
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
      hint: 'Verifica permisos de lectura sobre namespaces.',
    });
    return failResult();
  }

  return {
    ok: true,
    steps,
    kubectlVersion,
    context,
    clusterVersion,
    nodes,
    agents,
    namespaces,
    canManageSecrets,
    canManageDeployments,
    canPatchNodes,
    canPatchNamespaces,
  };
}
