import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeploymentManifest,
  buildSecretManifest,
  buildTunnelBundleYaml,
} from '../src/services/manifests.js';

describe('Generador de manifiestos (Secret + Deployment)', () => {
  const token = 'eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJhYmNkZWYxMiIsInMiOiJzZWNyZXQifQ==';

  it('genera el Secret con label tsure.io/cloudflared=true y stringData.token', () => {
    const yaml = buildSecretManifest({
      name: 'api-prod',
      namespace: 'mi-app-1',
      token,
    });
    assert.match(yaml, /kind: Secret/);
    assert.match(yaml, /name: "cloudflared-api-prod"/);
    assert.match(yaml, /namespace: "mi-app-1"/);
    assert.match(yaml, /tsure\.io\/cloudflared: "true"/);
    assert.match(yaml, new RegExp(`token: "${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  });

  it('genera el Deployment con afinidad por ID, topologySpread, tolerations 30s, probes y sin latest', () => {
    const yaml = buildDeploymentManifest({
      name: 'api-prod',
      namespace: 'mi-app-1',
      tunnelId: 'a3f9c2',
      agents: ['k3s-agent2', 'k3s-agent1'],
      replicas: 2,
      imageVersion: '2026.2.0',
      description: 'Túnel principal',
    });

    assert.match(yaml, /kind: Deployment/);
    assert.match(yaml, /name: "cloudflared-api-prod"/);
    assert.match(yaml, /namespace: "mi-app-1"/);
    assert.match(yaml, /tsure\.io\/cloudflared: "true"/);
    assert.match(yaml, /tsure\.io\/tunnel-id: "a3f9c2"/);
    assert.match(yaml, /tsure\.io\/agents: "k3s-agent1,k3s-agent2"/);
    assert.match(yaml, /tsure\.io\/description: "Túnel principal"/);
    assert.match(yaml, /replicas: 2/);
    assert.match(yaml, /maxSurge: 1/);
    assert.match(yaml, /maxUnavailable: 0/);
    assert.match(yaml, /key: "tsure\.io\/cloudflared-a3f9c2"/);
    assert.match(yaml, /operator: Exists/);
    assert.match(yaml, /topologyKey: kubernetes\.io\/hostname/);
    assert.match(yaml, /whenUnsatisfiable: ScheduleAnyway/);
    assert.match(yaml, /tolerationSeconds: 30/);
    assert.match(yaml, /image: "cloudflare\/cloudflared:2026\.2\.0"/);
    assert.match(yaml, /"--protocol","http2"/);
    assert.match(yaml, /startupProbe:/);
    assert.match(yaml, /failureThreshold: 18/);
    assert.match(yaml, /name: TUNNEL_TOKEN/);
    assert.match(yaml, /path: \/ready/);
    assert.match(yaml, /port: 2000/);
    assert.equal(yaml.includes(token), false);
  });

  it('permite configurar protocolo auto o quic y rechaza protocolos inválidos', () => {
    const autoYaml = buildDeploymentManifest({
      name: 'web',
      namespace: 'apps',
      tunnelId: '11aa22',
      agents: ['k3s-agent1'],
      replicas: 1,
      imageVersion: '2026.2.0',
      protocol: 'auto',
    });
    assert.match(autoYaml, /"--protocol","auto"/);

    const quicYaml = buildDeploymentManifest({
      name: 'web',
      namespace: 'apps',
      tunnelId: '11aa22',
      agents: ['k3s-agent1'],
      replicas: 1,
      imageVersion: '2026.2.0',
      protocol: 'quic',
    });
    assert.match(quicYaml, /"--protocol","quic"/);

    assert.throws(() =>
      buildDeploymentManifest({
        name: 'web',
        namespace: 'apps',
        tunnelId: '11aa22',
        agents: ['k3s-agent1'],
        replicas: 1,
        imageVersion: '2026.2.0',
        protocol: 'invalid' as never,
      }),
    );
  });

  it('combina Secret y Deployment separados por --- y rechaza latest', () => {
    const bundle = buildTunnelBundleYaml({
      name: 'web',
      namespace: 'apps',
      tunnelId: '11aa22',
      agents: ['k3s-agent1'],
      replicas: 1,
      imageVersion: '2026.2.0',
      token,
    });
    assert.equal(bundle.includes('\n---\n'), true);

    assert.throws(() =>
      buildDeploymentManifest({
        name: 'web',
        namespace: 'apps',
        tunnelId: '11aa22',
        agents: ['k3s-agent1'],
        replicas: 1,
        imageVersion: 'latest',
      }),
    );
  });
});
