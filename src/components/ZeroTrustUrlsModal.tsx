import React, { useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type {
  ServiceEndpointInfo,
  TunnelInfo,
  ZeroTrustServiceType,
  ZeroTrustUrlEntry,
} from '../types/k8s.js';
import { buildZeroTrustUrlEntries } from '../utils/validation.js';
import { copyToClipboard } from '../services/clipboard.js';

export interface ZeroTrustUrlsModalProps {
  services: ServiceEndpointInfo[];
  selectedTunnel: TunnelInfo | null;
  onCopied: (message: string) => void;
  onClose: () => void;
}

type UrlFormatMode = 'full' | 'fqdn' | 'zt';

const FORMAT_LABELS: Record<UrlFormatMode, string> = {
  full: 'URL con protocolo (auto)',
  fqdn: 'URL FQDN (.svc.cluster.local)',
  zt: 'Solo host:puerto',
};

function typeColor(ztType: ZeroTrustServiceType): string {
  switch (ztType) {
    case 'HTTP':
      return 'green';
    case 'HTTPS':
      return 'cyan';
    case 'TCP':
      return 'yellow';
    case 'SSH':
      return 'magenta';
    case 'RDP':
      return 'blue';
  }
}

function formatEntryValue(entry: ZeroTrustUrlEntry, mode: UrlFormatMode): string {
  const scheme = entry.ztType.toLowerCase();
  switch (mode) {
    case 'full':
      return entry.fullUrl;
    case 'fqdn':
      return `${scheme}://${entry.fqdnTarget}`;
    case 'zt':
      return entry.recommendedTarget;
  }
}

export const ZeroTrustUrlsModal: React.FC<ZeroTrustUrlsModalProps> = ({
  services,
  selectedTunnel,
  onCopied,
  onClose,
}) => {
  const { rows } = useWindowSize();
  const tunnelNs = selectedTunnel?.namespace ?? null;

  const allEntries = useMemo(
    () => buildZeroTrustUrlEntries(services, tunnelNs),
    [services, tunnelNs],
  );

  // Build namespace filter list: tunnel's own namespace first (if tunnel selected), then "all", then each namespace with services
  const filterOptions = useMemo(() => {
    const distinctNs = [...new Set(allEntries.map((e) => e.namespace))].sort();
    const opts: Array<{ id: string; label: string }> = [];

    if (tunnelNs) {
      const sameCount = allEntries.filter((e) => e.namespace === tunnelNs).length;
      opts.push({
        id: `ns:${tunnelNs}`,
        label: `${tunnelNs} (túnel · ${sameCount})`,
      });
    }

    opts.push({
      id: 'all',
      label: `Todos los namespaces (${allEntries.length})`,
    });

    for (const ns of distinctNs) {
      if (ns === tunnelNs) continue;
      const count = allEntries.filter((e) => e.namespace === ns).length;
      opts.push({
        id: `ns:${ns}`,
        label: `${ns} (${count})`,
      });
    }

    return opts;
  }, [allEntries, tunnelNs]);

  // If the tunnel's own namespace has no services, default to "all" so the user immediately sees available services
  const [filterIdx, setFilterIdx] = useState(() => {
    if (!tunnelNs) return 0;
    const sameCount = allEntries.filter((e) => e.namespace === tunnelNs).length;
    return sameCount > 0 ? 0 : Math.min(1, Math.max(0, filterOptions.length - 1));
  });
  const [formatMode, setFormatMode] = useState<UrlFormatMode>('full');
  const [cursor, setCursor] = useState(0);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const safeFilterIdx = Math.min(
    filterIdx,
    Math.max(0, filterOptions.length - 1),
  );
  const currentFilter = filterOptions[safeFilterIdx] ?? {
    id: 'all',
    label: 'Todos',
  };

  const visibleEntries = useMemo(() => {
    if (currentFilter.id === 'all') return allEntries;
    const targetNs = currentFilter.id.slice('ns:'.length);
    return allEntries.filter((e) => e.namespace === targetNs);
  }, [allEntries, currentFilter.id]);

  const safeCursor = Math.min(cursor, Math.max(0, visibleEntries.length - 1));
  const selectedEntry = visibleEntries[safeCursor] ?? null;

  const handleCopy = () => {
    if (!selectedEntry) return;
    const value = formatEntryValue(selectedEntry, formatMode);
    void copyToClipboard(value).then((res) => {
      if (res.ok) {
        const msg = `Copiado para Zero Trust (${selectedEntry.ztType} · ${res.method}): ${value}`;
        setFeedback({ type: 'success', text: msg });
        onCopied(msg);
      } else {
        setFeedback({
          type: 'error',
          text: res.error ?? 'No se pudo copiar al portapapeles.',
        });
      }
    });
  };

  useInput((input, key) => {
    const lower = input.toLowerCase();

    if (key.escape || lower === 'q' || lower === 'z') {
      onClose();
      return;
    }

    if (key.leftArrow || key.rightArrow) {
      if (filterOptions.length > 1) {
        const delta = key.leftArrow ? -1 : 1;
        setFilterIdx(
          (prev) => (prev + delta + filterOptions.length) % filterOptions.length,
        );
        setCursor(0);
        setFeedback(null);
      }
      return;
    }

    if (lower === 'f') {
      setFormatMode((prev) =>
        prev === 'full' ? 'fqdn' : prev === 'fqdn' ? 'zt' : 'full',
      );
      setFeedback(null);
      return;
    }

    if (key.upArrow || lower === 'k') {
      setCursor((prev) => Math.max(0, prev - 1));
      setFeedback(null);
      return;
    }

    if (key.downArrow || lower === 'j') {
      setCursor((prev) =>
        Math.min(Math.max(0, visibleEntries.length - 1), prev + 1),
      );
      setFeedback(null);
      return;
    }

    if (key.return || lower === 'c') {
      handleCopy();
    }
  });

  const maxVisible = Math.max(4, (rows || 24) - 15);
  const scrollStart = Math.max(
    0,
    Math.min(
      safeCursor - Math.floor(maxVisible / 2),
      Math.max(0, visibleEntries.length - maxVisible),
    ),
  );
  const sliced = visibleEntries.slice(scrollStart, scrollStart + maxVisible);

  return (
    <Box
      borderStyle="round"
      borderColor="green"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="green" wrap="truncate-end">
        Asistente de URLs para Cloudflare Zero Trust
        {selectedTunnel
          ? ` · túnel: ${selectedTunnel.name} (ns: ${selectedTunnel.namespace})`
          : ''}
      </Text>

      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text dimColor>Namespace (←/→): </Text>
          <Text bold color="cyan">
            ◀ {currentFilter.label} ▶
          </Text>
        </Text>
        <Text wrap="truncate-end">
          <Text dimColor>Formato (f): </Text>
          <Text color="yellow">{FORMAT_LABELS[formatMode]}</Text>
        </Text>
      </Box>

      {visibleEntries.length === 0 ? (
        <Box paddingY={1} flexDirection="column">
          <Text color="yellow">
            No hay Services TCP en este filtro.
          </Text>
          <Text dimColor>
            {filterOptions.length > 1
              ? 'Usa ←/→ para ver Services de otros namespaces (vía FQDN .svc.cluster.local).'
              : 'Cuando despliegues un Service en tu namespace, aparecerá aquí automáticamente.'}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={0}>
          {sliced.map((entry, relIdx) => {
            const absIdx = scrollStart + relIdx;
            const isCursor = absIdx === safeCursor;
            const value = formatEntryValue(entry, formatMode);
            return (
              <Text
                key={`${entry.namespace}/${entry.serviceName}:${entry.port}`}
                color={isCursor ? 'cyan' : 'white'}
                bold={isCursor}
                wrap="truncate-end"
              >
                {isCursor ? '▸ ' : '  '}
                <Text color={typeColor(entry.ztType)} bold>
                  {entry.ztType.padEnd(5)}
                </Text>{' '}
                <Text color={isCursor ? 'green' : 'white'}>{value}</Text>{' '}
                <Text dimColor>
                  ({entry.namespace}
                  {entry.sameNamespace ? ' ★' : ''} · {entry.serviceType}
                  {entry.portName ? ` · ${entry.portName}` : ''})
                </Text>
              </Text>
            );
          })}
        </Box>
      )}

      {visibleEntries.length > maxVisible ? (
        <Text dimColor>
          Mostrando {scrollStart + 1}–{Math.min(visibleEntries.length, scrollStart + maxVisible)} de {visibleEntries.length} Services (↑/↓)
        </Text>
      ) : null}

      {/* Tarjeta guía exacta para pegar en Cloudflare Zero Trust */}
      {selectedEntry ? (
        <Box
          borderStyle="single"
          borderColor="gray"
          flexDirection="column"
          paddingX={1}
        >
          <Text bold dimColor>
            Cloudflare Zero Trust → Networks → Tunnels → Public Hostname → Service:
          </Text>
          <Text wrap="truncate-end">
            <Text dimColor>Type: </Text>
            <Text bold color={typeColor(selectedEntry.ztType)}>
              {selectedEntry.ztType}
            </Text>
            <Text dimColor>   │   URL: </Text>
            <Text bold color="green">
              {formatEntryValue(selectedEntry, formatMode)}
            </Text>
          </Text>
          <Text dimColor wrap="truncate-end">
            {selectedEntry.sameNamespace
              ? `Mismo namespace que el túnel (${selectedEntry.namespace}): sirve DNS corto (${selectedEntry.shortTarget}) o FQDN.`
              : tunnelNs
                ? `Service en "${selectedEntry.namespace}" y túnel en "${tunnelNs}": usa FQDN (${selectedEntry.fqdnTarget}) o mueve el túnel a "${selectedEntry.namespace}".`
                : `FQDN válido desde cualquier namespace: ${selectedEntry.fqdnTarget}`}
          </Text>
        </Box>
      ) : null}

      {feedback ? (
        <Text
          color={feedback.type === 'success' ? 'green' : 'red'}
          wrap="truncate-end"
        >
          {feedback.type === 'success' ? '✓ ' : '✗ '}
          {feedback.text}
        </Text>
      ) : null}

      <Text dimColor>
        {selectedEntry ? '(Enter / c) Copiar URL · ' : ''}
        (←/→) Namespace · (f) Formato · (Esc / z) Volver
      </Text>
    </Box>
  );
};
