import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import type {
  ClusterSnapshot,
  PreFlightResult,
  PreFlightStep,
} from './types/k8s.js';
import { runPreFlight } from './services/preflight.js';
import {
  getClusterSnapshot,
  moveTunnelToAgent,
  scaleTunnelReplicas,
  updateTunnelNodeLabelAffinity,
} from './services/tunnels.js';
import {
  collectClusterNodeLabels,
  formatCompactNodeLabel,
} from './utils/validation.js';
import { PreFlightScreen } from './components/PreFlightScreen.js';
import { Header } from './components/Header.js';
import {
  DashboardScreen,
  QUICK_PANEL_ITEMS,
  type DashboardFocusArea,
  type QuickPanelState,
} from './components/DashboardScreen.js';
import { FooterBar, type FooterShortcut } from './components/FooterBar.js';
import { CreateTunnelModal } from './components/CreateTunnelModal.js';
import { InspectTunnelModal } from './components/InspectTunnelModal.js';
import { EditAssignmentModal } from './components/EditAssignmentModal.js';
import { RotateTokenModal } from './components/RotateTokenModal.js';
import { CopyUrlModal } from './components/CopyUrlModal.js';
import { DeleteTunnelModal } from './components/DeleteTunnelModal.js';
import { AgentsAuditModal } from './components/AgentsAuditModal.js';
import { NodeLabelsModal } from './components/NodeLabelsModal.js';

type ActiveModal =
  | 'none'
  | 'create'
  | 'inspect'
  | 'edit'
  | 'rotate'
  | 'copy'
  | 'delete'
  | 'agents'
  | 'labels';

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
  const [focusArea, setFocusArea] = useState<DashboardFocusArea>('table');
  const [panelIndex, setPanelIndex] = useState(0);
  const [modal, setModal] = useState<ActiveModal>('none');
  const [returnToInspect, setReturnToInspect] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [busyText, setBusyText] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'info' | 'success' | 'error';
    text: string;
  } | null>(null);

  // Quick panel draft values for the selected tunnel
  const [draftMoveTarget, setDraftMoveTarget] = useState<string | null>(null);
  const [draftReplicas, setDraftReplicas] = useState<number>(1);
  const [draftLabel, setDraftLabel] = useState<string | null>(null);

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
    if (tunnels.length === 0) {
      setFocusArea('table');
    }
  }, [tunnels.length]);

  const selectedTunnel = tunnels[selectedIndex] ?? null;

  // Ready allowed agents for the Mover quick control
  const moveOptions = useMemo(() => {
    if (!selectedTunnel) return [];
    const readyAllowed = selectedTunnel.allowedAgents.filter((name) => {
      const n = nodes.find((node) => node.name === name);
      return Boolean(n && n.ready && !n.unschedulable && !n.isControlPlane);
    });
    // Put currently running agent(s) first for predictable starting position
    return [...readyAllowed].sort((a, b) => {
      const aRunning = selectedTunnel.runningAgents.includes(a) ? 0 : 1;
      const bRunning = selectedTunnel.runningAgents.includes(b) ? 0 : 1;
      if (aRunning !== bRunning) return aRunning - bRunning;
      return a.localeCompare(b);
    });
  }, [selectedTunnel, nodes]);

  // Label options for the Label quick control (ninguno + custom cluster node labels + active label)
  const panelLabelOptions = useMemo(() => {
    const discovered = collectClusterNodeLabels(nodes);
    const custom = discovered.filter((opt) => !opt.isSystem);
    const entries: Array<{ selector: string | null; shortLabel: string }> = [
      { selector: null, shortLabel: 'ninguno' },
      ...custom.map((opt) => ({
        selector: opt.selector,
        shortLabel: opt.shortLabel,
      })),
    ];

    const activeExtra = selectedTunnel?.extraNodeLabel ?? null;
    if (activeExtra && !entries.some((e) => e.selector === activeExtra)) {
      entries.push({
        selector: activeExtra,
        shortLabel: formatCompactNodeLabel(activeExtra),
      });
    }
    return entries;
  }, [nodes, selectedTunnel?.extraNodeLabel]);

  const resetPanelDrafts = useCallback(() => {
    if (!selectedTunnel) {
      setDraftMoveTarget(null);
      setDraftReplicas(1);
      setDraftLabel(null);
      return;
    }
    setDraftMoveTarget(
      selectedTunnel.runningAgents[0] ?? moveOptions[0] ?? null,
    );
    setDraftReplicas(selectedTunnel.replicas);
    setDraftLabel(selectedTunnel.extraNodeLabel);
  }, [selectedTunnel, moveOptions]);

  const selectedTunnelKey = selectedTunnel
    ? `${selectedTunnel.namespace}/${selectedTunnel.resourceName}:${selectedTunnel.runningAgents.join(',')}:${selectedTunnel.replicas}:${selectedTunnel.extraNodeLabel ?? ''}:${selectedTunnel.allowedAgents.join(',')}`
    : '';

  const prevTunnelKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevTunnelKeyRef.current !== selectedTunnelKey) {
      prevTunnelKeyRef.current = selectedTunnelKey;
      resetPanelDrafts();
    }
  }, [selectedTunnelKey, resetPanelDrafts]);

  const maxReplicas = selectedTunnel
    ? Math.max(1, selectedTunnel.allowedAgents.length)
    : 1;

  const activePanelItem = QUICK_PANEL_ITEMS[panelIndex] ?? 'agents';

  const currentMoveTarget =
    draftMoveTarget && moveOptions.includes(draftMoveTarget)
      ? draftMoveTarget
      : (selectedTunnel?.runningAgents[0] ?? moveOptions[0] ?? null);

  const moveDirty = Boolean(
    selectedTunnel &&
      selectedTunnel.replicas > 0 &&
      currentMoveTarget &&
      !selectedTunnel.runningAgents.includes(currentMoveTarget),
  );
  const replicasDirty = Boolean(
    selectedTunnel &&
      draftReplicas >= 1 &&
      draftReplicas !== selectedTunnel.replicas,
  );
  const labelDirty = Boolean(
    selectedTunnel && draftLabel !== selectedTunnel.extraNodeLabel,
  );

  const currentLabelEntry =
    panelLabelOptions.find((o) => o.selector === draftLabel) ?? {
      selector: draftLabel,
      shortLabel: formatCompactNodeLabel(draftLabel),
    };

  const panelState: QuickPanelState | null = selectedTunnel
    ? {
        activeItem: activePanelItem,
        moveTarget: currentMoveTarget,
        moveOptionsCount: moveOptions.length,
        moveDirty,
        draftReplicas,
        maxReplicas,
        replicasDirty,
        draftLabel,
        draftLabelShort: currentLabelEntry.shortLabel,
        labelOptionsCount: panelLabelOptions.length,
        labelDirty,
        busyText,
      }
    : null;

  const closeSubModal = useCallback(
    (forceDashboard = false) => {
      if (!forceDashboard && returnToInspect && selectedTunnel) {
        setReturnToInspect(false);
        setModal('inspect');
      } else {
        setReturnToInspect(false);
        setModal('none');
      }
    },
    [returnToInspect, selectedTunnel],
  );

  const applyQuickMove = useCallback(() => {
    if (!selectedTunnel || busyAction) return;
    if (selectedTunnel.replicas === 0) {
      showToast(
        'error',
        'Túnel pausado. Reactívalo en Inspección (i) → (p) antes de moverlo.',
      );
      return;
    }
    if (moveOptions.length <= 1) {
      showToast(
        'info',
        'Solo hay 1 agente permitido Ready. Abre Agentes para añadir otro destino.',
      );
      return;
    }
    if (!currentMoveTarget || selectedTunnel.runningAgents.includes(currentMoveTarget)) {
      showToast(
        'info',
        `Ya corre en ${currentMoveTarget ?? 'este agente'}. Usa ←/→ para elegir otro destino.`,
      );
      return;
    }

    const target = currentMoveTarget;
    setBusyAction(true);
    setBusyText(`Moviendo "${selectedTunnel.name}" → ${target} sin corte...`);
    showToast('info', `Moviendo "${selectedTunnel.name}" → ${target}...`);
    void moveTunnelToAgent({
      tunnel: selectedTunnel,
      targetAgent: target,
      allNodes: nodes,
    })
      .then(() => {
        showToast('success', `Túnel "${selectedTunnel.name}" movido a ${target} sin corte.`);
        return refreshCluster();
      })
      .catch((err) => {
        showToast('error', err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setBusyAction(false);
        setBusyText(null);
      });
  }, [selectedTunnel, busyAction, moveOptions.length, currentMoveTarget, nodes, showToast, refreshCluster]);

  const applyQuickReplicas = useCallback(() => {
    if (!selectedTunnel || busyAction) return;
    if (draftReplicas < 1) {
      showToast(
        'info',
        'Para pausar (0) usa Inspección (i) → (p), o usa → para subir a 1+.',
      );
      return;
    }
    if (draftReplicas === selectedTunnel.replicas) {
      showToast('info', 'Sin cambios en réplicas. Usa ←/→ para ajustar.');
      return;
    }

    const targetCount = draftReplicas;
    setBusyAction(true);
    setBusyText(`Escalando "${selectedTunnel.name}" a ${targetCount} réplica${targetCount === 1 ? '' : 's'}...`);
    showToast(
      'info',
      `Escalando "${selectedTunnel.name}" a ${targetCount} réplica${targetCount === 1 ? '' : 's'}...`,
    );
    void scaleTunnelReplicas({
      tunnel: selectedTunnel,
      newReplicas: targetCount,
    })
      .then(() => {
        showToast(
          'success',
          `"${selectedTunnel.name}" escalado a ${targetCount} réplica${targetCount === 1 ? '' : 's'}.`,
        );
        return refreshCluster();
      })
      .catch((err) => {
        showToast('error', err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setBusyAction(false);
        setBusyText(null);
      });
  }, [selectedTunnel, busyAction, draftReplicas, showToast, refreshCluster]);

  const applyQuickLabel = useCallback(() => {
    if (!selectedTunnel || busyAction) return;
    if (draftLabel === selectedTunnel.extraNodeLabel) {
      showToast(
        'info',
        'Sin cambios en label. Usa ←/→ para cambiar o pulsa (l) para ver todos.',
      );
      return;
    }

    const targetLabel = draftLabel;
    setBusyAction(true);
    setBusyText(
      targetLabel
        ? `Aplicando label "${formatCompactNodeLabel(targetLabel)}" en "${selectedTunnel.name}"...`
        : `Quitando afinidad por label en "${selectedTunnel.name}"...`,
    );
    showToast(
      'info',
      targetLabel
        ? `Aplicando afinidad ${targetLabel} en "${selectedTunnel.name}"...`
        : `Quitando afinidad por label en "${selectedTunnel.name}"...`,
    );
    void updateTunnelNodeLabelAffinity({
      tunnel: selectedTunnel,
      selector: targetLabel,
      allNodes: nodes,
    })
      .then((res) => {
        if (res.appliedSelector) {
          showToast(
            'success',
            `Label "${formatCompactNodeLabel(res.appliedSelector)}" aplicado a "${selectedTunnel.name}" (${res.matchedAgents.join(', ')}).`,
          );
        } else {
          showToast(
            'success',
            `Afinidad por label eliminada de "${selectedTunnel.name}".`,
          );
        }
        return refreshCluster();
      })
      .catch((err) => {
        showToast('error', err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setBusyAction(false);
        setBusyText(null);
      });
  }, [selectedTunnel, busyAction, draftLabel, nodes, showToast, refreshCluster]);

  useInput(
    (input, key) => {
      if (busyAction) return;
      const lower = input.toLowerCase();

      // Always allow Q to exit from dashboard
      if (lower === 'q') {
        exit();
        return;
      }

      // Esc backs out from panel to table; on table exits app
      if (key.escape) {
        if (focusArea === 'panel') {
          resetPanelDrafts();
          setFocusArea('table');
        } else {
          exit();
        }
        return;
      }

      // Global dashboard shortcuts
      if (lower === 'n') {
        setReturnToInspect(false);
        setModal('create');
        return;
      }

      if (lower === 'l') {
        setReturnToInspect(false);
        setModal('labels');
        return;
      }

      if (lower === 'u') {
        void refreshCluster();
        showToast('info', 'Refrescando túneles, agentes y auditoría...');
        return;
      }

      // Allow Audit directly when cluster has 0 tunnels (no Inspect available yet)
      if (lower === 'a' && !selectedTunnel) {
        setReturnToInspect(false);
        setModal('agents');
        return;
      }

      if (!selectedTunnel) return;

      if (lower === 'i') {
        setReturnToInspect(false);
        setModal('inspect');
        return;
      }

      // Tab navigation between Table and Quick Control Panel
      if (key.tab) {
        if (key.shift) {
          if (focusArea === 'table') {
            setFocusArea('panel');
            setPanelIndex(QUICK_PANEL_ITEMS.length - 1);
          } else if (panelIndex > 0) {
            setPanelIndex((prev) => prev - 1);
          } else {
            setFocusArea('table');
          }
        } else {
          if (focusArea === 'table') {
            setFocusArea('panel');
            setPanelIndex(0);
          } else if (panelIndex < QUICK_PANEL_ITEMS.length - 1) {
            setPanelIndex((prev) => prev + 1);
          } else {
            setFocusArea('table');
          }
        }
        return;
      }

      if (focusArea === 'table') {
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
        if (key.return) {
          setReturnToInspect(false);
          setModal('inspect');
          return;
        }
        return;
      }

      // Focus is on the Quick Control Panel
      if (key.upArrow || lower === 'k') {
        setPanelIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow || lower === 'j') {
        setPanelIndex((prev) =>
          Math.min(QUICK_PANEL_ITEMS.length - 1, prev + 1),
        );
        return;
      }

      if (key.leftArrow || key.rightArrow) {
        const delta = key.rightArrow ? 1 : -1;
        if (activePanelItem === 'move' && moveOptions.length > 0 && selectedTunnel.replicas > 0) {
          const curIdx = currentMoveTarget
            ? Math.max(0, moveOptions.indexOf(currentMoveTarget))
            : 0;
          const nextIdx =
            (curIdx + delta + moveOptions.length) % moveOptions.length;
          setDraftMoveTarget(moveOptions[nextIdx] ?? null);
          return;
        }
        if (activePanelItem === 'replicas') {
          setDraftReplicas((prev) => {
            if (prev === 0 && delta > 0) return 1;
            if (prev === 0 && delta < 0) return 0;
            return Math.max(1, Math.min(maxReplicas, prev + delta));
          });
          return;
        }
        if (activePanelItem === 'label' && panelLabelOptions.length > 0) {
          const curIdx = Math.max(
            0,
            panelLabelOptions.findIndex((o) => o.selector === draftLabel),
          );
          const nextIdx =
            (curIdx + delta + panelLabelOptions.length) %
            panelLabelOptions.length;
          setDraftLabel(panelLabelOptions[nextIdx]?.selector ?? null);
          return;
        }
        return;
      }

      if (key.return) {
        if (activePanelItem === 'agents') {
          setReturnToInspect(false);
          setModal('edit');
          return;
        }
        if (activePanelItem === 'move') {
          applyQuickMove();
          return;
        }
        if (activePanelItem === 'replicas') {
          applyQuickReplicas();
          return;
        }
        if (activePanelItem === 'label') {
          applyQuickLabel();
          return;
        }
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
    { key: 'i', label: 'Inspección', color: 'cyan', disabled: !hasTunnel },
    { key: 'l', label: 'Labels', color: 'yellow' },
    {
      key: 'Tab',
      label: focusArea === 'panel' ? 'Tabla' : 'Panel',
      color: 'cyan',
      disabled: !hasTunnel,
    },
    ...(hasTunnel
      ? []
      : [
          {
            key: 'a',
            label:
              orphans.totalIssues > 0
                ? `Audit(${orphans.totalIssues})`
                : 'Audit',
            color: orphans.totalIssues > 0 ? 'yellow' : 'cyan',
          },
        ]),
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
            focusArea={focusArea}
            panelState={panelState}
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
          orphanCount={orphans.totalIssues}
          onClose={() => setModal('none')}
          onRefresh={refreshCluster}
          onOpenEdit={() => {
            setReturnToInspect(true);
            setModal('edit');
          }}
          onOpenRotateToken={() => {
            setReturnToInspect(true);
            setModal('rotate');
          }}
          onOpenAudit={() => {
            setReturnToInspect(true);
            setModal('agents');
          }}
          onOpenCopyUrl={() => {
            setReturnToInspect(true);
            setModal('copy');
          }}
          onOpenDelete={() => {
            setReturnToInspect(true);
            setModal('delete');
          }}
        />
      ) : null}

      {modal === 'edit' && selectedTunnel ? (
        <EditAssignmentModal
          tunnel={selectedTunnel}
          allNodes={nodes}
          onUpdated={(msg) => {
            closeSubModal();
            showToast('success', msg);
            void refreshCluster();
          }}
          onCancel={() => closeSubModal()}
        />
      ) : null}

      {modal === 'labels' ? (
        <NodeLabelsModal
          nodes={nodes}
          selectedTunnel={selectedTunnel}
          onApplied={(msg) => {
            setModal('none');
            showToast('success', msg);
            void refreshCluster();
          }}
          onClose={() => setModal('none')}
        />
      ) : null}

      {modal === 'rotate' && selectedTunnel ? (
        <RotateTokenModal
          tunnel={selectedTunnel}
          onRotated={(msg) => {
            closeSubModal();
            showToast('success', msg);
            void refreshCluster();
          }}
          onCancel={() => closeSubModal()}
        />
      ) : null}

      {modal === 'copy' && selectedTunnel ? (
        <CopyUrlModal
          tunnel={selectedTunnel}
          onCopied={(msg) => {
            closeSubModal();
            showToast('success', msg);
          }}
          onClose={() => closeSubModal()}
        />
      ) : null}

      {modal === 'delete' && selectedTunnel ? (
        <DeleteTunnelModal
          tunnel={selectedTunnel}
          allNodes={nodes}
          onDeleted={(deletedName) => {
            closeSubModal(true);
            showToast('success', `Túnel "${deletedName}" eliminado.`);
            void refreshCluster();
          }}
          onCancel={() => closeSubModal()}
        />
      ) : null}

      {modal === 'agents' ? (
        <AgentsAuditModal
          nodes={nodes}
          tunnels={tunnels}
          orphans={orphans}
          onCleaned={(msg) => {
            closeSubModal();
            showToast('success', msg);
            void refreshCluster();
          }}
          onClose={() => closeSubModal()}
        />
      ) : null}
    </Box>
  );
};
