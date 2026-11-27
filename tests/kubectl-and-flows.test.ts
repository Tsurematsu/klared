import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KubectlError,
  setKubectlExecutorForTesting,
  spawnKubectl,
} from '../src/services/kubectl.js';
import {
  buildOrphanAuditReport,
  deleteTunnel,
  installTunnel,
  updateTunnelAssignment,
} from '../src/services/tunnels.js';
import type { NodeAgentInfo, TunnelInfo } from '../src/types/k8s.js';

const FAKE_TOKEN = 'eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJhYmNkZWYxMiIsInMiOiJzZWNyZXQifQ==';

function makeMockNodesJson() {
  return JSON.stringify({
    items: [
      {
        metadata: {
          name: 'k3s-agent1',
          labels: {
            'kubernetes.io/hostname': 'k3s-agent1',
            'node-role.kubernetes.io/worker': 'true',
          },
        },
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
          addresses: [{ type: 'InternalIP', address: '100.64.0.11' }],
          nodeInfo: { kubeletVersion: 'v1.32.2+k3s1', osImage: 'Ubuntu' },
        },
      },
      {
        metadata: {
          name: 'k3s-agent2',
          labels: {
            'kubernetes.io/hostname': 'k3s-agent2',
            'node-role.kubernetes.io/worker': 'true',
          },
        },
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
          addresses: [{ type: 'InternalIP', address: '100.64.0.12' }],
          nodeInfo: { kubeletVersion: 'v1.32.2+k3s1', osImage: 'Ubuntu' },
        },
      },
    ],
  });
}

function makeMockNamespacesJson() {
  return JSON.stringify({
    items: [
      {
        metadata: {
          name: 'mi-app',
          labels: { 'tsure.io/managed': 'true' },
          annotations: {},
        },
        status: { phase: 'Active' },
      },
    ],
  });
}

afterEach(() => {
  setKubectlExecutorForTesting(null);
});

describe('Wrapper spawnKubectl (sin shell, stdin y redacción)', () => {
  it('reporta NOT_INSTALLED cuando el binario no existe', async () => {
    await assert.rejects(
      () => spawnKubectl(['version'], { timeoutMs: 2_000 }, 'kubectl-inexistente-klared'),
      (err: unknown) =>
        err instanceof KubectlError && err.code === 'NOT_INSTALLED',
    );
  });

  it('pasa stdin de forma segura y redacta secretos en errores', async () => {
    const ok = await spawnKubectl(
      ['-e', 'const fs=require("fs"); process.stdout.write(fs.readFileSync(0,"utf8"));'],
      { stdin: 'hola-stdin', timeoutMs: 3_000 },
      process.execPath,
    );
    assert.equal(ok.stdout, 'hola-stdin');

    await assert.rejects(
      () =>
        spawnKubectl(
          ['-e', `console.error("fallo con ${FAKE_TOKEN}"); process.exit(1);`],
          { redact: [FAKE_TOKEN], timeoutMs: 3_000 },
          process.execPath,
        ),
      (err: unknown) =>
        err instanceof KubectlError &&
        !err.message.includes(FAKE_TOKEN) &&
        err.message.includes('[REDACTED]'),
    );
  });
});

describe('Flujo installTunnel con stdin y rollback', () => {
  it('etiqueta nodos + namespace, envía Secret/Deployment por stdin y espera rollout', async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];

    setKubectlExecutorForTesting(async (args, options) => {
      calls.push({ args, stdin: options?.stdin });
      if (args[0] === 'get' && args[1] === 'nodes') {
        return { stdout: makeMockNodesJson(), stderr: '', exitCode: 0 };
      }
      if (args[0] === 'get' && args[1] === 'namespaces') {
        return { stdout: makeMockNamespacesJson(), stderr: '', exitCode: 0 };
      }
      if (args[0] === 'get' && (args[1] === 'deployments' || args[1] === 'pods' || args[1] === 'services')) {
        return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0 };
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });

    const result = await installTunnel({
      name: 'web',
      rawToken: `cloudflared service install ${FAKE_TOKEN}`,
      namespace: 'mi-app',
      agents: ['k3s-agent1', 'k3s-agent2'],
      replicas: 1,
      imageVersion: '2026.2.0',
      description: 'Prueba',
    });

    assert.equal(result.resourceName, 'cloudflared-web');
    assert.equal(result.namespace, 'mi-app');

    // Nunca debe aparecer el token en argumentos de línea de comandos
    for (const c of calls) {
      assert.equal(c.args.join(' ').includes(FAKE_TOKEN), false);
    }

    const applyCall = calls.find((c) => c.args[0] === 'apply' && c.args[1] === '-f' && c.args[2] === '-');
    assert.ok(applyCall);
    assert.equal(applyCall.stdin?.includes(FAKE_TOKEN), true);

    const nsLabelCall = calls.find(
      (c) =>
        c.args[0] === 'label' &&
        c.args[1] === 'namespace' &&
        c.args[2] === 'mi-app' &&
        c.args[3] === `tsure.io/klared-${result.tunnelId}=true`,
    );
    assert.ok(nsLabelCall);
  });

  it('ejecuta rollback completo (Deployment, Secret, nodos y namespace) si rollout status falla', async () => {
    const calls: string[][] = [];

    setKubectlExecutorForTesting(async (args) => {
      calls.push(args);
      if (args[0] === 'get' && args[1] === 'nodes') {
        return { stdout: makeMockNodesJson(), stderr: '', exitCode: 0 };
      }
      if (args[0] === 'get' && args[1] === 'namespaces') {
        return { stdout: makeMockNamespacesJson(), stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rollout' && args[1] === 'status') {
        throw new Error('error: timed out waiting for the condition');
      }
      if (args[0] === 'logs') {
        return { stdout: 'ERR Failed to authenticate token', stderr: '', exitCode: 0 };
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });

    await assert.rejects(
      () =>
        installTunnel({
          name: 'roto',
          rawToken: FAKE_TOKEN,
          namespace: 'mi-app',
          agents: ['k3s-agent1'],
          replicas: 1,
          imageVersion: '2026.2.0',
        }),
      /Rollback completado/,
    );

    assert.ok(calls.some((a) => a[0] === 'delete' && a[1] === 'deployment' && a[2] === 'cloudflared-roto'));
    assert.ok(calls.some((a) => a[0] === 'delete' && a[1] === 'secret' && a[2] === 'cloudflared-roto'));
    assert.ok(calls.some((a) => a[0] === 'label' && a[1] === 'node' && a[2] === 'k3s-agent1' && a[3]?.endsWith('-')));
    assert.ok(calls.some((a) => a[0] === 'label' && a[1] === 'namespace' && a[2] === 'mi-app' && a[3]?.endsWith('-')));
  });
});

describe('Flujo updateTunnelAssignment (orden seguro) y deleteTunnel', () => {
  const nodes: NodeAgentInfo[] = [
    {
      name: 'k3s-agent1',
      roles: ['worker'],
      isControlPlane: false,
      ready: true,
      unschedulable: false,
      status: 'Ready',
      version: 'v1.32.2+k3s1',
      internalIp: '100.64.0.11',
      osImage: 'Ubuntu',
      labels: {
        'kubernetes.io/hostname': 'k3s-agent1',
        'tsure.io/cloudflared-abc123': 'true',
      },
      cloudflaredIds: ['abc123'],
    },
    {
      name: 'k3s-agent2',
      roles: ['worker'],
      isControlPlane: false,
      ready: true,
      unschedulable: false,
      status: 'Ready',
      version: 'v1.32.2+k3s1',
      internalIp: '100.64.0.12',
      osImage: 'Ubuntu',
      labels: {
        'kubernetes.io/hostname': 'k3s-agent2',
      },
      cloudflaredIds: [],
    },
  ];

  const baseTunnel: TunnelInfo = {
    name: 'web',
    resourceName: 'cloudflared-web',
    namespace: 'mi-app',
    tunnelId: 'abc123',
    nodeLabelKey: 'tsure.io/cloudflared-abc123',
    namespaceLabelKey: 'tsure.io/klared-abc123',
    description: '',
    image: 'cloudflare/cloudflared:2026.2.0',
    imageVersion: '2026.2.0',
    replicas: 1,
    readyReplicas: 1,
    availableReplicas: 1,
    desiredReplicasWhenPaused: 1,
    allowedAgents: ['k3s-agent1'],
    annotatedAgents: ['k3s-agent1'],
    runningAgents: ['k3s-agent1'],
    pods: [],
    status: 'ready',
    statusLabel: '● Ready',
    namespaceNodeSelector: null,
    appPodNodes: [],
    crossNodeTrafficWarning: false,
    services: [],
    hasMissingAllowedAgents: false,
  };

  it('agrega el label nuevo ANTES de retirar el viejo y reinicia el Deployment', async () => {
    const calls: string[][] = [];
    setKubectlExecutorForTesting(async (args) => {
      calls.push(args);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });

    await updateTunnelAssignment({
      tunnel: baseTunnel,
      newAgents: ['k3s-agent2'],
      newReplicas: 1,
      allNodes: nodes,
    });

    const addIdx = calls.findIndex(
      (a) => a[0] === 'label' && a[2] === 'k3s-agent2' && a[3] === 'tsure.io/cloudflared-abc123=true',
    );
    const removeIdx = calls.findIndex(
      (a) => a[0] === 'label' && a[2] === 'k3s-agent1' && a[3] === 'tsure.io/cloudflared-abc123-',
    );
    const restartIdx = calls.findIndex((a) => a[0] === 'rollout' && a[1] === 'restart');
    const annotateIdx = calls.findIndex(
      (a) => a[0] === 'annotate' && a.includes('tsure.io/agents=k3s-agent2'),
    );

    assert.ok(addIdx >= 0);
    assert.ok(removeIdx > addIdx);
    assert.ok(restartIdx > removeIdx);
    assert.ok(annotateIdx > restartIdx);
  });

  it('elimina Deployment, Secret, labels de nodos y label tsure.io/klared-<id> del namespace', async () => {
    const calls: string[][] = [];
    setKubectlExecutorForTesting(async (args) => {
      calls.push(args);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });

    await deleteTunnel({ tunnel: baseTunnel, allNodes: nodes });

    assert.ok(calls.some((a) => a[0] === 'delete' && a[1] === 'deployment' && a[2] === 'cloudflared-web'));
    assert.ok(calls.some((a) => a[0] === 'delete' && a[1] === 'secret' && a[2] === 'cloudflared-web'));
    assert.ok(
      calls.some(
        (a) => a[0] === 'label' && a[1] === 'node' && a[2] === 'k3s-agent1' && a[3] === 'tsure.io/cloudflared-abc123-',
      ),
    );
    assert.ok(
      calls.some(
        (a) => a[0] === 'label' && a[1] === 'namespace' && a[2] === 'mi-app' && a[3] === 'tsure.io/klared-abc123-',
      ),
    );
  });
});

describe('Auditoría de huérfanos', () => {
  it('detecta labels de nodo, labels de namespace y Deployments sin agentes válidos', () => {
    const report = buildOrphanAuditReport({
      nodes: [
        {
          name: 'k3s-agent1',
          roles: ['worker'],
          isControlPlane: false,
          ready: true,
          unschedulable: false,
          status: 'Ready',
          version: 'v1.32.2+k3s1',
          internalIp: '100.64.0.11',
          osImage: 'Ubuntu',
          labels: { 'tsure.io/cloudflared-dead01': 'true' },
          cloudflaredIds: ['dead01'],
        },
      ],
      namespaces: [
        {
          name: 'mi-app',
          phase: 'Active',
          isProtected: false,
          description: '',
          nodeSelector: null,
          nodeSelectorSource: null,
          labels: { 'tsure.io/klared-dead01': 'true' },
          klaredIds: ['dead01'],
        },
      ],
      tunnels: [
        {
          name: 'huerfano',
          resourceName: 'cloudflared-huerfano',
          namespace: 'mi-app',
          tunnelId: '999999',
          nodeLabelKey: 'tsure.io/cloudflared-999999',
          namespaceLabelKey: 'tsure.io/klared-999999',
          description: '',
          image: 'cloudflare/cloudflared:2026.2.0',
          imageVersion: '2026.2.0',
          replicas: 1,
          readyReplicas: 0,
          availableReplicas: 0,
          desiredReplicasWhenPaused: 1,
          allowedAgents: [],
          annotatedAgents: ['k3s-agent-viejo'],
          runningAgents: [],
          pods: [],
          status: 'pending',
          statusLabel: '⚠ Pending',
          namespaceNodeSelector: null,
          appPodNodes: [],
          crossNodeTrafficWarning: false,
          services: [],
          hasMissingAllowedAgents: true,
        },
      ],
    });

    assert.equal(report.orphanNodeLabels.length, 1);
    assert.equal(report.orphanNamespaceLabels.length, 1);
    assert.equal(report.brokenDeployments.length, 1);
    assert.equal(report.totalIssues, 3);
  });
});
