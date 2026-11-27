import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import type {
  ClusterSnapshot,
  PreFlightResult,
  PreFlightStep,
} from './types/k8s.js';
import { runPreFlight } from './services/preflight.js';
import {
  getClusterSnapshot,
  restartTunnel,
  togglePauseTunnel,
} from './services/tunnels.js';
import { copyToClipboard } from './services/clipboard.js';
import { PreFlightScreen } from './components/PreFlightScreen.js';
import { Header } from './components/Header.js';
import { DashboardScreen } from './components/DashboardScreen.js';
import { FooterBar, type FooterShortcut } from './components/FooterBar.js';
import { CreateTunnelModal } from './components/CreateTunnelModal.js';
import { InspectTunnelModal } from './components/InspectTunnelModal.js';
import { EditAssignmentModal } from './components/EditAssignmentModal.js';
import { MoveTunnelModal } from './components/MoveTunnelModal.js';
import { RotateTokenModal } from './components/RotateTokenModal.js';
import { CopyUrlModal } from './components/CopyUrlModal.js';
import { DeleteTunnelModal } from './components/DeleteTunnelModal.js';
import { AgentsAuditModal } from './components/AgentsAuditModal.js';

type ActiveModal =
  | 'none'
  | 'create'
  | 'inspect'
  | 'edit'
  | 'move'
  | 'rotate'
  | 'copy'
  | 'delete'
  | 'agents';

const REFRESH_INTERVAL_MS = 5_000;

export const App: React.FC = () => {
  const { exit } = useApp();

  // Pre-flight state
  const [phase, setPhase] = useState<'preflight' | 'dashboard'>('preflight');
  const [preFlightSteps, setPreFlightSteps] = useState<PreFlightStep[]>([]);
  const [preFlightRunning, setPreFlightRunning] = useState(true);
  const [preFlightFailed, setPreFlightFailed] = useState(false);
  const [preFlightData, setPreFlightData] = useState<PreFlightResult | null>(
    null,
  );

  // Dashboard state
  const [snapshot, setSnapshot] = useState<ClusterSnapshot | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [modal, setModal] = useState<ActiveModal>('none');
  const [refreshing, setRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'info' | 'success' | 'error';
    text: string;
  } | null>(null);

  const isRefreshingRef = useRef(false);

  const showToast = useCallback(
    (type: 'info' | 'success' | 'error', text: string) => {
      setStatusMessage({ type, text });
    },
    [],
  );

  useEffect(() => {
    if (!statusMessage) return;
    const timer = setTimeout(() => setStatusMessage(null), 6_000);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  const executePreFlight = useCallback(async () => {
    setPreFlightRunning(true);
    setPreFlightFailed(false);
    const result = await runPreFlight((steps) => {
      setPreFlightSteps(steps);
    });
    setPreFlightSteps(result.steps);
    setPreFlightRunning(false);

    if (!result.ok) {
      setPreFlightFailed(true);
      return;
    }

    setPreFlightData(result);
    try {
      const initial = await getClusterSnapshot();
      setSnapshot(initial);
      setSyncError(null);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    }
    setPhase('dashboard');
  }, []);

  useEffect(() => {
    void executePreFlight();
  }, [executePreFlight]);

  const refreshCluster = useCallback(async () => {
    if (!preFlightData || isRefreshingRef.current) return;
    isRefreshingRef.current = true;
    setRefreshing(true);
    try {
      const latest = await getClusterSnapshot();
      setSnapshot(latest);
      setSyncError(null);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      isRefreshingRef.current = false;
      setRefreshing(false);
    }
  }, [preFlightData]);

  useEffect(() => {
    if (phase !== 'dashboard' || modal !== 'none' || busyAction) return;
    const interval = setInterval(() => {
      void refreshCluster();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [phase, modal, busyAction, refreshCluster]);

  const tunnels = snapshot?.tunnels ?? [];
  const nodes = snapshot?.nodes ?? preFlightData?.nodes ?? [];
  const agents = snapshot?.agents ?? preFlightData?.agents ?? [];
  const namespaces = snapshot?.namespaces ?? preFlightData?.namespaces ?? [];
  const orphans = snapshot?.orphans ?? {
    orphanNodeLabels: [],
    orphanNamespaceLabels: [],
    brokenDeployments: [],
    totalIssues: 0,
  };

  useEffect(() => {
    setSelectedIndex((prev) => {
      if (tunnels.length === 0) return 0;
      return Math.min(prev, tunnels.length - 1);
    });
  }, [tunnels.length]);

  const selectedTunnel = tunnels[selectedIndex] ?? null;

  useInput(
    (input, key) => {
      if (busyAction) return;
      const lower = input.toLowerCase();

      if (key.escape || lower === 'q') {
        exit();
        return;
      }

      if (key.upArrow || lower === 'k') {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.downArrow || lower === 'j') {
        setSelectedIndex((prev) =>
          Math.min(Math.max(0, tunnels.length - 1), prev + 1),
        );
        return;
      }

      if (lower === 'n') {
        setModal('create');
        return;
      }

      if (lower === 'a') {
        setModal('agents');
        return;
      }

      if (lower === 'u') {
        void refreshCluster();
        showToast('info', 'Refrescando túneles, agentes y auditoría...');
        return;
      }

      if (!selectedTunnel) return;

      if (lower === 'i' || key.return) {
        setModal('inspect');
        return;
      }

      if (lower === 'e') {
        setModal('edit');
        return;
      }

      if (lower === 'm') {
        setModal('move');
        return;
      }

      if (lower === 't') {
        setModal('rotate');
        return;
      }

      if (lower === 'x') {
        setModal('delete');
        return;
      }

      if (lower === 'c') {
        const allUrls = selectedTunnel.services.flatMap((s) => s.suggestedUrls);
        if (allUrls.length === 0) {
          showToast(
            'error',
            `No hay Services TCP en "${selectedTunnel.namespace}" para copiar URL.`,
          );
          return;
        }
        if (allUrls.length === 1) {
          const url = allUrls[0]!;
          void copyToClipboard(url).then((res) => {
            if (res.ok) {
              showToast('success', `URL copiada (${res.method}): ${url}`);
            } else {
              showToast('error', res.error ?? 'No se pudo copiar al portapapeles.');
            }
          });
          return;
        }
        setModal('copy');
        return;
      }

      if (lower === 'r') {
        setBusyAction(true);
        showToast('info', `Reiniciando "${selectedTunnel.name}"...`);
        void restartTunnel(selectedTunnel)
          .then(() => {
            showToast(
              'success',
              `Túnel "${selectedTunnel.name}" reiniciado y Ready.`,
            );
            return refreshCluster();
          })
          .catch((err) => {
            showToast('error', err instanceof Error ? err.message : String(err));
          })
          .finally(() => setBusyAction(false));
        return;
      }

      if (lower === 'p') {
        const willPause = selectedTunnel.replicas > 0;
        setBusyAction(true);
        showToast(
          'info',
          willPause
            ? `Pausando "${selectedTunnel.name}" (escalando a 0)...`
            : `Reactivando "${selectedTunnel.name}"...`,
        );
        void togglePauseTunnel(selectedTunnel)
          .then((res) => {
            showToast(
              'success',
              res.paused
                ? `Túnel "${selectedTunnel.name}" pausado (Secret y labels conservados).`
                : `Túnel "${selectedTunnel.name}" reactivado (${res.replicas} réplica${res.replicas === 1 ? '' : 's'}).`,
            );
            return refreshCluster();
          })
          .catch((err) => {
            showToast('error', err instanceof Error ? err.message : String(err));
          })
          .finally(() => setBusyAction(false));
      }
    },
    { isActive: phase === 'dashboard' && modal === 'none' && !busyAction },
  );

  if (phase === 'preflight' || !preFlightData) {
    return (
      <PreFlightScreen
        steps={preFlightSteps}
        running={preFlightRunning}
        failed={preFlightFailed}
        onRetry={() => {
          void executePreFlight();
        }}
        onExit={exit}
      />
    );
  }

  const hasTunnel = Boolean(selectedTunnel);
  const dashboardShortcuts: FooterShortcut[] = [
    { key: 'n', label: 'Nuevo', color: 'green' },
    { key: 'i', label: 'Ver', color: 'cyan', disabled: !hasTunnel },
    { key: 'e', label: 'Agentes', color: 'yellow', disabled: !hasTunnel },
    { key: 'm', label: 'Mover', color: 'yellow', disabled: !hasTunnel },
    { key: 'r', label: 'Reiniciar', color: 'cyan', disabled: !hasTunnel },
    {
      key: 'p',
      label: selectedTunnel?.replicas === 0 ? 'Activar' : 'Pausar',
      color: 'magenta',
      disabled: !hasTunnel,
    },
    { key: 't', label: 'Token', color: 'magenta', disabled: !hasTunnel },
    { key: 'c', label: 'URL', color: 'green', disabled: !hasTunnel },
    {
      key: 'a',
      label: orphans.totalIssues > 0 ? `Audit(${orphans.totalIssues})` : 'Audit',
      color: orphans.totalIssues > 0 ? 'yellow' : 'cyan',
    },
    { key: 'x', label: 'Borrar', color: 'red', disabled: !hasTunnel },
    { key: 'u', label: 'Sync', color: 'cyan' },
    { key: 'Q', label: 'Salir', color: 'red' },
  ];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header
        context={preFlightData.context}
        clusterVersion={preFlightData.clusterVersion}
        kubectlVersion={preFlightData.kubectlVersion}
        agents={agents}
        orphanCount={orphans.totalIssues}
        lastSync={snapshot?.fetchedAt ?? null}
        refreshing={refreshing || busyAction}
      />

      {modal === 'none' ? (
        <>
          <DashboardScreen
            tunnels={tunnels}
            selectedIndex={selectedIndex}
            error={syncError}
          />
          <FooterBar shortcuts={dashboardShortcuts} statusMessage={statusMessage} />
        </>
      ) : null}

      {modal === 'create' ? (
        <CreateTunnelModal
          nodes={nodes}
          namespaces={namespaces}
          existingTunnels={tunnels}
          onCreated={(result) => {
            setModal('none');
            showToast(
              'success',
              `Túnel "${result.resourceName}" listo en ${result.runningAgents.join(', ')}.`,
            );
            void refreshCluster();
          }}
          onCancel={() => setModal('none')}
        />
      ) : null}

      {modal === 'inspect' && selectedTunnel ? (
        <InspectTunnelModal
          tunnel={selectedTunnel}
          onClose={() => setModal('none')}
          onOpenEdit={() => setModal('edit')}
          onOpenRotateToken={() => setModal('rotate')}
        />
      ) : null}

      {modal === 'edit' && selectedTunnel ? (
        <EditAssignmentModal
          tunnel={selectedTunnel}
          allNodes={nodes}
          onUpdated={(msg) => {
            setModal('none');
            showToast('success', msg);
            void refreshCluster();
          }}
          onCancel={() => setModal('none')}
        />
      ) : null}

      {modal === 'move' && selectedTunnel ? (
        <MoveTunnelModal
          tunnel={selectedTunnel}
          allNodes={nodes}
          onMoved={(msg) => {
            setModal('none');
            showToast('success', msg);
            void refreshCluster();
          }}
          onCancel={() => setModal('none')}
        />
      ) : null}

      {modal === 'rotate' && selectedTunnel ? (
        <RotateTokenModal
          tunnel={selectedTunnel}
          onRotated={(msg) => {
            setModal('none');
            showToast('success', msg);
            void refreshCluster();
          }}
          onCancel={() => setModal('none')}
        />
      ) : null}

      {modal === 'copy' && selectedTunnel ? (
        <CopyUrlModal
          tunnel={selectedTunnel}
          onCopied={(msg) => {
            setModal('none');
            showToast('success', msg);
          }}
          onClose={() => setModal('none')}
        />
      ) : null}

      {modal === 'delete' && selectedTunnel ? (
        <DeleteTunnelModal
          tunnel={selectedTunnel}
          allNodes={nodes}
          onDeleted={(deletedName) => {
            setModal('none');
            showToast('success', `Túnel "${deletedName}" eliminado.`);
            void refreshCluster();
          }}
          onCancel={() => setModal('none')}
        />
      ) : null}

      {modal === 'agents' ? (
        <AgentsAuditModal
          nodes={nodes}
          tunnels={tunnels}
          orphans={orphans}
          onCleaned={(msg) => {
            setModal('none');
            showToast('success', msg);
            void refreshCluster();
          }}
          onClose={() => setModal('none')}
        />
      ) : null}
    </Box>
  );
};
