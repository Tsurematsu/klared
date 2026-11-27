import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNamespaceLabelKey,
  buildNodeLabelKey,
  buildResourceName,
  computeAgentEligibility,
  extractTunnelProtocol,
  extractTunnelToken,
  formatNodeSelectorDisplay,
  maskTokenForDisplay,
  parseNodeSelector,
  redactSecrets,
  summarizeCloudflaredLogDiagnostic,
  validateImageVersion,
  validateTunnelId,
  validateTunnelName,
  validateTunnelProtocol,
} from '../src/utils/validation.js';
import type { NodeAgentInfo } from '../src/types/k8s.js';

const MOCK_NODES: NodeAgentInfo[] = [
  {
    name: 'k3s-server',
    roles: ['control-plane', 'master'],
    isControlPlane: true,
    ready: true,
    unschedulable: false,
    status: 'Ready',
    version: 'v1.32.2+k3s1',
    internalIp: '100.64.0.10',
    osImage: 'Ubuntu 24.04',
    labels: {
      'kubernetes.io/hostname': 'k3s-server',
      'node-role.kubernetes.io/control-plane': 'true',
    },
    cloudflaredIds: [],
  },
  {
    name: 'k3s-agent1',
    roles: ['worker'],
    isControlPlane: false,
    ready: true,
    unschedulable: false,
    status: 'Ready',
    version: 'v1.32.2+k3s1',
    internalIp: '100.64.0.11',
    osImage: 'Ubuntu 24.04',
    labels: {
      'kubernetes.io/hostname': 'k3s-agent1',
      'node-role.kubernetes.io/worker': 'true',
    },
    cloudflaredIds: [],
  },
  {
    name: 'k3s-agent2',
    roles: ['apps'],
    isControlPlane: false,
    ready: true,
    unschedulable: false,
    status: 'Ready',
    version: 'v1.32.2+k3s1',
    internalIp: '100.64.0.12',
    osImage: 'Ubuntu 24.04',
    labels: {
      'kubernetes.io/hostname': 'k3s-agent2',
      'node-role.kubernetes.io/apps': 'true',
    },
    cloudflaredIds: [],
  },
  {
    name: 'k3s-agent3',
    roles: ['worker'],
    isControlPlane: false,
    ready: false,
    unschedulable: false,
    status: 'NotReady',
    version: 'v1.32.2+k3s1',
    internalIp: '100.64.0.13',
    osImage: 'Ubuntu 24.04',
    labels: {
      'kubernetes.io/hostname': 'k3s-agent3',
      'node-role.kubernetes.io/worker': 'true',
    },
    cloudflaredIds: [],
  },
];

describe('validateTunnelName y helpers de nombres/labels', () => {
  it('acepta nombres DNS-1123 válidos dentro del límite', () => {
    assert.equal(validateTunnelName('mi-app').valid, true);
    assert.equal(validateTunnelName('prod-api-01').valid, true);
    assert.equal(buildResourceName('mi-app'), 'cloudflared-mi-app');
    assert.equal(buildNodeLabelKey('a3f9c2'), 'tsure.io/cloudflared-a3f9c2');
    assert.equal(buildNamespaceLabelKey('a3f9c2'), 'tsure.io/klared-a3f9c2');
    assert.equal(validateTunnelId('a3f9c2'), true);
    assert.equal(validateTunnelId('INVALID'), false);
  });

  it('rechaza nombres inválidos o con prefijo cloudflared- duplicado', () => {
    assert.equal(validateTunnelName('').valid, false);
    assert.equal(validateTunnelName('MiApp').valid, false);
    assert.equal(validateTunnelName('-bad').valid, false);
    assert.equal(validateTunnelName('bad-').valid, false);
    assert.equal(validateTunnelName('bad_name').valid, false);
    assert.equal(validateTunnelName('cloudflared-api').valid, false);
    assert.equal(validateTunnelName('a'.repeat(52)).valid, false);
  });
});

describe('extractTunnelToken y seguridad de secretos', () => {
  const sampleToken = 'eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJhYmNkZWYxMiIsInMiOiJzZWNyZXQifQ==';

  it('acepta token directo y comandos pegados desde Zero Trust', () => {
    const direct = extractTunnelToken(sampleToken);
    assert.equal(direct.valid, true);
    assert.equal(direct.token, sampleToken);
    assert.equal(direct.extractedFromCommand, false);

    const fromInstall = extractTunnelToken(
      `sudo cloudflared service install ${sampleToken}`,
    );
    assert.equal(fromInstall.valid, true);
    assert.equal(fromInstall.token, sampleToken);
    assert.equal(fromInstall.extractedFromCommand, true);

    const fromFlag = extractTunnelToken(
      `cloudflared tunnel run --token "${sampleToken}"`,
    );
    assert.equal(fromFlag.valid, true);
    assert.equal(fromFlag.token, sampleToken);
    assert.equal(fromFlag.extractedFromCommand, true);

    const fromEnv = extractTunnelToken(`TUNNEL_TOKEN=${sampleToken}`);
    assert.equal(fromEnv.valid, true);
    assert.equal(fromEnv.token, sampleToken);
    assert.equal(fromEnv.extractedFromCommand, true);
  });

  it('rechaza tokens vacíos, muy cortos o con espacios', () => {
    assert.equal(extractTunnelToken('').valid, false);
    assert.equal(extractTunnelToken('corto').valid, false);
    assert.equal(extractTunnelToken('token con espacios raros 123456789').valid, false);
  });

  it('enmascara y redacta secretos correctamente', () => {
    const masked = maskTokenForDisplay(sampleToken, 12);
    assert.equal(masked, '••••••••••••');
    assert.equal(masked.includes('eyJ'), false);

    const redacted = redactSecrets(
      `error aplicando ${sampleToken} en cluster`,
      [sampleToken],
    );
    assert.equal(redacted.includes(sampleToken), false);
    assert.equal(redacted.includes('[REDACTED]'), true);
  });
});

describe('validateImageVersion', () => {
  it('rechaza latest y acepta tags fijos', () => {
    assert.equal(validateImageVersion('latest').valid, false);
    assert.equal(validateImageVersion('LATEST').valid, false);
    assert.equal(validateImageVersion('').valid, false);
    const ok = validateImageVersion('2026.2.0');
    assert.equal(ok.valid, true);
    assert.equal(ok.normalized, '2026.2.0');
  });
});

describe('computeAgentEligibility (exclusión de control-plane y afinidad k3access)', () => {
  it('excluye control-plane y marca NotReady como no elegible', () => {
    const res = computeAgentEligibility(MOCK_NODES, null);
    assert.deepEqual(
      res.map((r) => r.agent.name),
      ['k3s-agent1', 'k3s-agent2', 'k3s-agent3'],
    );
    assert.equal(res[0]?.eligible, true);
    assert.equal(res[1]?.eligible, true);
    assert.equal(res[2]?.eligible, false);
    assert.match(res[2]?.disabledReason ?? '', /NotReady/);
  });

  it('calcula la intersección con tsure.io/node-selector del namespace', () => {
    const parsed = parseNodeSelector('kubernetes.io/hostname=k3s-agent2');
    assert.equal(parsed.valid, true);
    assert.equal(formatNodeSelectorDisplay(parsed.normalized), 'k3s-agent2');

    const res = computeAgentEligibility(MOCK_NODES, parsed.normalized);
    const eligibleNames = res.filter((r) => r.eligible).map((r) => r.agent.name);
    assert.deepEqual(eligibleNames, ['k3s-agent2']);

    const agent1 = res.find((r) => r.agent.name === 'k3s-agent1');
    assert.equal(agent1?.eligible, false);
    assert.equal(agent1?.matchesNamespace, false);
    assert.match(agent1?.disabledReason ?? '', /Incompatible/);
  });

  it('deja intersección vacía cuando el namespace apunta a un agente NotReady', () => {
    const res = computeAgentEligibility(
      MOCK_NODES,
      'kubernetes.io/hostname=k3s-agent3',
    );
    assert.equal(res.filter((r) => r.eligible).length, 0);
  });
});

describe('Protocolo de túnel y diagnóstico de logs cloudflared', () => {
  it('valida y extrae protocolo desde args del contenedor', () => {
    assert.deepEqual(validateTunnelProtocol('http2'), {
      valid: true,
      normalized: 'http2',
    });
    assert.deepEqual(validateTunnelProtocol('AUTO'), {
      valid: true,
      normalized: 'auto',
    });
    assert.equal(validateTunnelProtocol('grpc').valid, false);

    assert.equal(
      extractTunnelProtocol(['tunnel', '--protocol', 'http2', 'run']),
      'http2',
    );
    assert.equal(
      extractTunnelProtocol(['tunnel', '--protocol=quic', 'run']),
      'quic',
    );
    assert.equal(
      extractTunnelProtocol(['tunnel', '--no-autoupdate', 'run']),
      'auto',
    );
  });

  it('identifica QUIC bloqueado, token inválido y líneas ERR en logs', () => {
    const quicHint = summarizeCloudflaredLogDiagnostic(
      'INF precheck component="UDP Connectivity" details="QUIC connection failed"\nINF precheck complete suggested_protocol=http2',
    );
    assert.match(quicHint, /QUIC.*http2/i);

    const tokenHint = summarizeCloudflaredLogDiagnostic(
      'ERR Provided Tunnel token is not valid',
    );
    assert.match(tokenHint, /token.*inválido/i);

    const errHint = summarizeCloudflaredLogDiagnostic(
      'INF Starting tunnel\nERR some unexpected edge error\nINF other info',
    );
    assert.match(errHint, /some unexpected edge error/);
  });
});
