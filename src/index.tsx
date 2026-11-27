#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { runPreFlight } from './services/preflight.js';
import { getClusterSnapshot } from './services/tunnels.js';

const ALT_SCREEN_ENTER = '\x1b[?1049h\x1b[H';
const ALT_SCREEN_LEAVE = '\x1b[?1049l';

function printHelp(): void {
  console.log(`klared — Gestor TUI de túneles cloudflared para k3s (tsure.io/*)

Uso:
  klared            Abre la interfaz interactiva (TUI)
  klared --check    Ejecuta la validación pre-flight y resume los túneles sin abrir TUI
  klared --help     Muestra esta ayuda
`);
}

async function runCheckMode(): Promise<void> {
  const result = await runPreFlight();
  for (const step of result.steps) {
    const icon =
      step.status === 'ok'
        ? '✓'
        : step.status === 'warn'
          ? '⚠'
          : step.status === 'error'
            ? '✗'
            : '○';
    console.log(`${icon} ${step.label}${step.detail ? ` — ${step.detail}` : ''}`);
    if (step.hint) {
      console.log(`  ↳ ${step.hint}`);
    }
  }

  if (!result.ok) {
    process.exitCode = 1;
    return;
  }

  const snapshot = await getClusterSnapshot();
  console.log(`\nTúneles gestionados (tsure.io/cloudflared=true): ${snapshot.tunnels.length}`);
  for (const t of snapshot.tunnels) {
    const running = t.runningAgents.length > 0 ? t.runningAgents.join(',') : '-';
    const allowed = t.allowedAgents.length > 0 ? t.allowedAgents.join(',') : 'NINGUNO';
    console.log(
      `  - ${t.name} (ns: ${t.namespace}, id: ${t.tunnelId}) | ${t.statusLabel} ${t.readyReplicas}/${t.replicas} | actual: ${running} | permitidos: ${allowed} | img: ${t.imageVersion}`,
    );
  }

  if (snapshot.orphans.totalIssues > 0) {
    console.log(`\n⚠ Auditoría de huérfanos (${snapshot.orphans.totalIssues}):`);
    for (const item of snapshot.orphans.orphanNodeLabels) {
      console.log(`  - Nodo ${item.nodeName}: label huérfano ${item.labelKey}`);
    }
    for (const item of snapshot.orphans.orphanNamespaceLabels) {
      console.log(`  - Namespace ${item.namespace}: label huérfano ${item.labelKey}`);
    }
    for (const item of snapshot.orphans.brokenDeployments) {
      console.log(`  - Deployment ${item.resourceName} (${item.namespace}): ${item.reason}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  if (args.includes('--check') || args.includes('-c')) {
    await runCheckMode();
    return;
  }

  let restored = false;
  const restoreScreen = () => {
    if (restored) return;
    restored = true;
    if (process.stdout.isTTY) {
      process.stdout.write(ALT_SCREEN_LEAVE);
    }
  };

  if (process.stdout.isTTY) {
    process.stdout.write(ALT_SCREEN_ENTER);
  }

  process.once('SIGINT', () => {
    restoreScreen();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    restoreScreen();
    process.exit(0);
  });
  process.once('exit', restoreScreen);

  try {
    const instance = render(<App />);
    await instance.waitUntilExit();
  } finally {
    restoreScreen();
  }
}

void main().catch((err) => {
  if (process.stdout.isTTY) {
    process.stdout.write(ALT_SCREEN_LEAVE);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
