const SLIDES = [
  {
    id: 'dashboard',
    tab: 'Dashboard',
    badge: 'Vista principal · refresco cada 5s',
    title: 'Dashboard en vivo de túneles cloudflared',
    file: './images/dashboard.png',
    terminalTitle: 'klared — Dashboard principal (tsure.io/cloudflared=true)',
    description:
      'Muestra todos los túneles gestionados con su namespace, ID único, estado en vivo (/ready), réplicas, agentes actuales vs. permitidos y versión fija de cloudflare/cloudflared.',
    points: [
      'Destaca URL interna sugerida del namespace lista para copiar con (c).',
      'Advierte automáticamente si el túnel corre en un agente distinto al de la app (tráfico por tailnet).',
      'Incluye indicador de auditoría de huérfanos en la cabecera y refresco automático cada 5s.',
    ],
  },
  {
    id: 'create',
    tab: 'Nuevo túnel (n)',
    badge: 'Atajo: n',
    title: 'Instalación guiada con token seguro y rollback',
    file: './images/create-tunnel.png',
    terminalTitle: 'klared — Nuevo túnel cloudflared',
    description:
      'Formulario compacto adaptado a terminales estándar: valida DNS-1123 en vivo, enmascara el token (aceptando también el comando completo de Zero Trust), filtra agentes compatibles con k3access y consulta la última versión estable.',
    points: [
      'Envía Secret y Deployment por stdin a kubectl apply -f - sin exponer el token en argumentos.',
      'Marca el namespace con tsure.io/klared-<id>=true para integrarse con k3access.',
      'Si el rollout falla o expira, ejecuta rollback completo dejando el clúster limpio.',
    ],
  },
];

let currentIndex = 0;

const tabsContainer = document.getElementById('gallery-tabs');
const thumbStrip = document.getElementById('thumb-strip');
const stageImg = document.getElementById('stage-img');
const stageTerminalTitle = document.getElementById('stage-terminal-title');
const stageBadge = document.getElementById('stage-badge');
const stageTitle = document.getElementById('stage-title');
const stageDesc = document.getElementById('stage-desc');
const stagePoints = document.getElementById('stage-points');
const stageZoomTrigger = document.getElementById('stage-zoom-trigger');
const heroZoomTrigger = document.getElementById('hero-zoom-trigger');

const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxCaption = document.getElementById('lightbox-caption');
const lightboxClose = document.getElementById('lightbox-close');
const lightboxPrev = document.getElementById('lightbox-prev');
const lightboxNext = document.getElementById('lightbox-next');

function renderGallery(index) {
  currentIndex = (index + SLIDES.length) % SLIDES.length;
  const slide = SLIDES[currentIndex];

  stageImg.src = slide.file;
  stageImg.alt = slide.title;
  stageTerminalTitle.textContent = slide.terminalTitle;
  stageBadge.textContent = slide.badge;
  stageTitle.textContent = slide.title;
  stageDesc.textContent = slide.description;

  stagePoints.innerHTML = '';
  for (const point of slide.points) {
    const li = document.createElement('li');
    li.textContent = point;
    stagePoints.appendChild(li);
  }

  document.querySelectorAll('#gallery-tabs .gallery-tab').forEach((btn, idx) => {
    btn.classList.toggle('active', idx === currentIndex);
    btn.setAttribute('aria-selected', idx === currentIndex ? 'true' : 'false');
  });

  document.querySelectorAll('.thumb-btn').forEach((btn, idx) => {
    btn.classList.toggle('active', idx === currentIndex);
  });

  if (lightbox.classList.contains('open')) {
    lightboxImg.src = slide.file;
    lightboxImg.alt = slide.title;
    lightboxCaption.textContent = `${currentIndex + 1}/${SLIDES.length} — ${slide.title}`;
  }
}

function openLightbox(index) {
  renderGallery(index);
  const slide = SLIDES[currentIndex];
  lightboxImg.src = slide.file;
  lightboxImg.alt = slide.title;
  lightboxCaption.textContent = `${currentIndex + 1}/${SLIDES.length} — ${slide.title}`;
  lightbox.classList.add('open');
  lightbox.setAttribute('aria-hidden', 'false');
}

function closeLightbox() {
  lightbox.classList.remove('open');
  lightbox.setAttribute('aria-hidden', 'true');
}

SLIDES.forEach((slide, idx) => {
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'gallery-tab';
  tab.textContent = slide.tab;
  tab.setAttribute('role', 'tab');
  tab.addEventListener('click', () => renderGallery(idx));
  tabsContainer.appendChild(tab);

  const thumb = document.createElement('button');
  thumb.type = 'button';
  thumb.className = 'thumb-btn';
  thumb.title = slide.title;
  thumb.innerHTML = `<img src="${slide.file}" alt="${slide.title}" loading="lazy" />`;
  thumb.addEventListener('click', () => renderGallery(idx));
  thumbStrip.appendChild(thumb);
});

stageZoomTrigger.addEventListener('click', () => openLightbox(currentIndex));
heroZoomTrigger.addEventListener('click', () => openLightbox(0));
lightboxClose.addEventListener('click', closeLightbox);
lightboxPrev.addEventListener('click', () => renderGallery(currentIndex - 1));
lightboxNext.addEventListener('click', () => renderGallery(currentIndex + 1));

lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) closeLightbox();
});

document.addEventListener('keydown', (e) => {
  if (!lightbox.classList.contains('open')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowRight') renderGallery(currentIndex + 1);
  if (e.key === 'ArrowLeft') renderGallery(currentIndex - 1);
});

renderGallery(0);

// Interactive agent intersection simulator
const simAgent1 = document.getElementById('sim-agent1');
const simAgent2 = document.getElementById('sim-agent2');
const simNsSelector = document.getElementById('sim-ns-selector');
const simResult = document.getElementById('sim-result');

function updateSimulator() {
  const agents = [
    { name: 'k3s-agent1', ready: simAgent1.checked },
    { name: 'k3s-agent2', ready: simAgent2.checked },
  ];
  const nsSel = simNsSelector.value;

  const eligible = agents.filter((a) => {
    if (!a.ready) return false;
    if (nsSel !== 'any' && a.name !== nsSel) return false;
    return true;
  });

  if (eligible.length === 0) {
    simResult.className = 'sim-result blocked';
    simResult.innerHTML =
      '<strong>✗ INTERSECCIÓN VACÍA — Despliegue bloqueado (quedaría Pending)</strong>' +
      '<ul><li>Ningún agente Ready cumple simultáneamente con la afinidad del namespace.</li>' +
      '<li>klared deshabilita los nodos incompatibles/NotReady y te avisa antes de aplicar.</li></ul>';
    return;
  }

  if (eligible.length === 1) {
    simResult.className = 'sim-result audit';
    simResult.innerHTML =
      `<strong>⚠ 1 AGENTE ELEGIBLE: ${eligible[0].name} (máx. 1 réplica)</strong>` +
      '<ul><li>El túnel correrá en ese agente sin redundancia multi-nodo.</li>' +
      (nsSel !== 'any'
        ? `<li>Restringido por tsure.io/node-selector=${nsSel} (solo lectura desde k3access).</li>`
        : '<li>Habilita otro agente Ready para activar failover automático en ~30–60 s.</li>') +
      '</ul>';
    return;
  }

  simResult.className = 'sim-result allowed';
  simResult.innerHTML =
    '<strong>✓ 2 AGENTES ELEGIBLES: k3s-agent1, k3s-agent2 (hasta 2 réplicas)</strong>' +
    '<ul><li>Con 1 réplica: failover automático al otro agente en ~30–60 s si un nodo cae.</li>' +
    '<li>Con 2 réplicas: topologySpreadConstraints reparte 1 pod por agente.</li></ul>';
}

[simAgent1, simAgent2, simNsSelector].forEach((el) =>
  el.addEventListener('change', updateSimulator),
);
updateSimulator();

// Install tabs
const installTabs = document.querySelectorAll('[data-install-tab]');
const installPanels = document.querySelectorAll('[data-install-panel]');

installTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.getAttribute('data-install-tab');
    installTabs.forEach((btn) => {
      const active = btn === tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    installPanels.forEach((panel) => {
      panel.classList.toggle(
        'active',
        panel.getAttribute('data-install-panel') === target,
      );
    });
  });
});

// Copy buttons
document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const targetId = btn.getAttribute('data-copy-target');
    const targetEl = document.getElementById(targetId);
    if (!targetEl) return;
    try {
      await navigator.clipboard.writeText(targetEl.textContent.trim());
      const prev = btn.textContent;
      btn.textContent = '✓ Copiado';
      setTimeout(() => {
        btn.textContent = prev;
      }, 1600);
    } catch {
      btn.textContent = 'Error al copiar';
    }
  });
});
