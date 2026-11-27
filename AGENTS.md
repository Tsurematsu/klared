# Contexto del proyecto: TUI para túneles cloudflared en k3s

> Nombre de trabajo de la herramienta: `ktun` (renombrable).
> Este documento le da contexto a un agente de terminal para construirla.
> Antes de escribir código, lee los repos de referencia (sección 2) y respeta sus convenciones.

---

## 1. Objetivo

Construir una **TUI de terminal** que instale y administre **túneles de Cloudflare administrados por dashboard** (remotely-managed, con token) dentro de un clúster **k3s**, con foco en:

1. **Instalación** guiada de un túnel (Secret + Deployment).
2. **Asignación y traslado selectivo entre agentes** usando un sistema de labels de nodo, de modo que el túnel pueda redesplegarse solo si un agente cae, o replicarse en varios.

Es la cuarta herramienta de un ecosistema personal. Debe sentirse igual que las otras tres (mismo stack, mismo contrato de labels, mismo estilo de atajos).

### Fuera de alcance (no hacer)

- No gestionar rutas/hostnames del túnel: eso se hace **manualmente en el dashboard de Zero Trust**.
- No usar la API de Cloudflare ni pedir credenciales de cuenta. Solo se maneja el **token del túnel**.
- No crear ni borrar namespaces: eso lo hace `k3access`.
- No tocar la red de Tailscale/Headscale ni las ACL: eso lo hace `tacl`.
- No manejar bases de datos: eso lo hace `kpg`.
- No instalar Ingress, operadores ni CRDs. El objetivo es consumo mínimo de RAM/CPU.

---

## 2. Ecosistema y repos de referencia

| Herramienta | Qué hace | Referencia |
|---|---|---|
| `tacl` | ACLs de Headscale (HuJSON, protección SSH) | https://tsurematsu.github.io/tacl/ |
| `kpg` | PostgreSQL con CloudNativePG (traslado entre nodos, backups) | https://tsurematsu.github.io/kpg/ |
| `k3access` | Namespaces de k3s con afinidad por agente y contrato `tsure.io/*` | https://tsurematsu.github.io/k3acess/ |

Repos: `github.com/Tsurematsu/tacl`, `github.com/Tsurematsu/kpg`, `github.com/Tsurematsu/k3acess`.

**Tarea previa obligatoria:** revisa `k3access` (es la referencia principal de stack y estructura) y `kpg` (referencia del sistema de labels y del traslado entre nodos). Replica sus convenciones de estructura de proyecto, pre-flight, manejo de errores, instalador y publicación de binarios. Si algo de este documento contradice lo que ves en esos repos, **pregunta antes de decidir**.

---

## 3. Entorno

- **Clúster:** k3s con 1 server y 2 agentes, cada uno en una VM distinta, misma LAN.
- **Red del clúster:** los nodos hablan por una tailnet (Tailscale con Headscale).
- **Instalación mínima:** se quiere mantener bajo el consumo de RAM y CPU. No añadir componentes al clúster.
- **Nombres de agentes de ejemplo:** `k3s-agent1`, `k3s-agent2`.
- **Almacenamiento:** `local-path` (irrelevante aquí: cloudflared no tiene estado).
- **Acceso:** el usuario ejecuta la herramienta en su equipo con `kubectl` configurado (`~/.kube/config`) con permisos de admin.

---

## 4. Stack técnico (igual que `k3access`)

- TypeScript, Node.js 20+, React 19 + Ink 8 para la TUI.
- Todas las llamadas a Kubernetes pasan por un único wrapper: `child_process.spawn('kubectl', args)` con **`shell: false`**, timeouts controlados y validación estricta de nombres DNS-1123.
- Binario autónomo opcional con `esbuild` + `node --build-sea`, sin dependencias nativas.
- Instalador `install.sh` / `install.ps1` que detecta la última release, verifica **SHA-256** y actualiza si se vuelve a ejecutar.
- Flag `--check` para validar el pre-flight sin abrir la TUI.
- Pruebas unitarias (typecheck + tests) para el wrapper de `kubectl`, la validación de nombres y la lógica de afinidad.

---

## 5. Contrato de labels y annotations (`tsure.io/*`)

Regla de oro: **cada herramienta es dueña exclusiva de sus labels y nunca sobrescribe los de otra.**

### Recursos propios de esta herramienta

Label en el Secret, el Deployment y el template del pod:

```
tsure.io/cloudflared: "true"
```

### Label de nodo por túnel (el sistema de asignación)

Cada túnel recibe un id corto único (6-8 caracteres hex, por ejemplo `a3f9c2`). Los agentes donde puede correr se etiquetan así:

```
tsure.io/cloudflared-<id>: "true"
```

La clave del label (parte posterior al prefijo) no puede superar 63 caracteres; con un id corto hay margen de sobra.

### Annotations en el Deployment (respaldo y auditoría)

```
tsure.io/tunnel-id: "<id>"
tsure.io/agents: "k3s-agent1,k3s-agent2"
tsure.io/description: "<texto libre>"
```

La **fuente de verdad** de qué agentes están permitidos es el conjunto de nodos con el label `tsure.io/cloudflared-<id>`. La annotation `tsure.io/agents` es solo un espejo para auditar.

### Relación con `k3access`

- El namespace puede tener `scheduler.alpha.kubernetes.io/node-selector` y `tsure.io/node-selector` (afinidad del namespace). **Léelos, no los modifiques.**
- Esta herramienta **no pone labels en el namespace**. `k3access` ya impide editar o borrar un namespace con pods activos en cualquier agente, así que un túnel desplegado queda protegido de forma natural.
- Si `k3access` define un label de uso para herramientas en el namespace, léelo en la referencia antes de asumir nada.

---

## 6. Manifiesto base

La herramienta genera esto (sustituir `NOMBRE`, `NAMESPACE`, `ID`, la versión de la imagen y las réplicas):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflared-NOMBRE
  namespace: NAMESPACE
  labels:
    tsure.io/cloudflared: "true"
stringData:
  token: "TOKEN"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudflared-NOMBRE
  namespace: NAMESPACE
  labels:
    tsure.io/cloudflared: "true"
  annotations:
    tsure.io/tunnel-id: "ID"
    tsure.io/agents: "k3s-agent1,k3s-agent2"
spec:
  replicas: 1
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: cloudflared-NOMBRE
  template:
    metadata:
      labels:
        app: cloudflared-NOMBRE
        tsure.io/cloudflared: "true"
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: tsure.io/cloudflared-ID
                    operator: Exists
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: cloudflared-NOMBRE
      tolerations:
        - key: node.kubernetes.io/unreachable
          operator: Exists
          effect: NoExecute
          tolerationSeconds: 30
        - key: node.kubernetes.io/not-ready
          operator: Exists
          effect: NoExecute
          tolerationSeconds: 30
      containers:
        - name: cloudflared
          image: cloudflare/cloudflared:<VERSION_FIJA>
          args: ["tunnel", "--no-autoupdate", "--metrics", "0.0.0.0:2000", "run"]
          env:
            - name: TUNNEL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: cloudflared-NOMBRE
                  key: token
          resources:
            requests: { cpu: 10m, memory: 32Mi }
            limits: { cpu: 200m, memory: 128Mi }
          readinessProbe:
            httpGet: { path: /ready, port: 2000 }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /ready, port: 2000 }
            initialDelaySeconds: 10
            periodSeconds: 15
```

Notas de diseño:

- **Sin Service ni NodePort ni Ingress:** cloudflared solo hace conexiones salientes hacia Cloudflare.
- **`readinessProbe` + `maxUnavailable: 0`:** garantizan que en un traslado el pod nuevo esté listo antes de retirar el viejo. Cloudflare admite varios conectores del mismo túnel a la vez, así que no hay corte.
- **`tolerations` de 30 s:** reducen el failover por defecto (~5 min) solo para este Deployment, sin tocar el resto del clúster.
- **Versión de imagen fija:** no usar `latest`. Debe consultarse la última versión estable y dejar la elegida visible en la TUI.
- **Nombres:** los recursos siguen el patrón `cloudflared-<nombre>`. La herramienta solo reconoce y opera sobre recursos con el label `tsure.io/cloudflared: "true"`. **Nunca debe tocar Deployments ajenos.**

---

## 7. Flujos funcionales

### 7.1 Pre-flight (al iniciar y con `--check`)

1. `kubectl` instalado y contexto activo.
2. Conectividad con el servidor k3s.
3. Agentes en estado `Ready`.
4. Permisos RBAC para: crear Secrets y Deployments, y hacer `patch` sobre `nodes` (necesario para etiquetar).
5. Lectura de namespaces existentes.

Si algo falla, mostrar un mensaje claro y no abrir el dashboard.

### 7.2 Instalación de un túnel

1. Pedir: nombre, **token** (entrada enmascarada), namespace (lista de los existentes) y descripción opcional.
2. Pedir **agentes permitidos** (checklist de agentes `Ready`). Deshabilitar los que no sean compatibles con la afinidad del namespace (ver 7.5).
3. Pedir número de **réplicas** (por defecto 1; máximo = número de agentes elegidos).
4. Generar `ID` único y comprobar que no exista ya un label igual en el clúster.
5. **Etiquetar los nodos** elegidos con `tsure.io/cloudflared-<id>=true`.
6. Crear el Secret (token por stdin, ver 8) y aplicar el Deployment.
7. Esperar `kubectl rollout status` con timeout.
8. Mostrar nodo(s) donde cayó, estado `/ready` y los Services del namespace con su puerto, para que el usuario arme la URL interna que pegará en el dashboard (por ejemplo `http://backend:80`).
9. Si algo falla a mitad: **revertir** lo creado (labels, Secret, Deployment) y reportar.

### 7.3 Cambio de asignación de agentes

El orden importa para no perder el túnel:

1. **Agregar** el label a los agentes nuevos.
2. Si el pod actual corre en un agente que se va a quitar, ejecutar `kubectl rollout restart` y **esperar** `rollout status`.
3. **Quitar** el label de los agentes descartados.
4. Actualizar la annotation `tsure.io/agents`.

Por qué: `requiredDuringSchedulingIgnoredDuringExecution` solo se evalúa al programar un pod. Quitar el label no evacúa un pod que ya corre. Y si se quitara antes de agregar los nuevos, un reinicio podría dejar el pod sin ningún nodo válido.

Validaciones: no permitir dejar el conjunto vacío; ajustar réplicas si superan el nuevo número de agentes.

### 7.4 Otras acciones

| Tecla | Acción |
|---|---|
| `n` | Nuevo túnel |
| `Enter` / `i` | Inspeccionar: pods, nodo, estado `/ready`, logs recientes, agentes permitidos |
| `e` | Editar asignación de agentes y réplicas (flujo 7.3) |
| `m` | Mover ya: forzar reinicio hacia otro agente permitido |
| `r` | Reiniciar el Deployment |
| `p` | Pausar (escalar a 0) y reactivar, conservando Secret y labels |
| `t` | Rotar token (actualizar Secret y reiniciar) |
| `c` | Copiar la URL interna sugerida |
| `x` | Eliminar con confirmación (ver 7.6) |
| `u` | Refrescar |
| `Q` / `Esc` | Salir |

### 7.5 Compatibilidad con la afinidad del namespace

Si el namespace tiene `tsure.io/node-selector` (o `scheduler.alpha.kubernetes.io/node-selector`), el pod debe cumplir **ambas** condiciones: la del namespace y la del label del túnel. La herramienta debe:

- Calcular la **intersección** y ofrecer solo agentes válidos.
- Avisar si la intersección queda vacía (el pod quedaría `Pending`).
- Recordar que la annotation del namespace solo se aplica si el admission plugin `PodNodeSelector` está habilitado en el server k3s. Si no lo está, advertirlo sin bloquear.

### 7.6 Eliminación

1. Confirmación explícita mostrando qué se borra.
2. Borrar Deployment y Secret.
3. **Quitar el label `tsure.io/cloudflared-<id>` de todos los nodos.**
4. Aviso final: las rutas del dashboard de Cloudflare hay que quitarlas manualmente, y el túnel sigue existiendo en la cuenta.

### 7.7 Auditoría de huérfanos

Detectar y ofrecer limpiar (nunca automáticamente):

- Labels `tsure.io/cloudflared-*` en nodos sin Deployment asociado.
- Deployments con `tsure.io/cloudflared: "true"` cuyos agentes ya no existen.

---

## 8. Reglas de seguridad

- **El token nunca va en argumentos de línea de comandos**: pasarlo por stdin a `kubectl apply -f -` para que no aparezca en `ps` ni en el historial.
- No imprimir el token en logs, errores ni capturas. En pantalla mostrarlo enmascarado.
- Validar nombres con DNS-1123 antes de enviarlos a `kubectl`. Sin interpolación en shell.
- Operar solo sobre recursos con el label `tsure.io/cloudflared: "true"`.
- Toda acción destructiva pide confirmación.

---

## 9. Casos límite a manejar

- Agente caído o `NotReady` al elegir destino: mostrarlo deshabilitado.
- Pod en `Pending` por falta de nodos válidos: detectarlo, explicar la causa (afinidad del namespace, labels, recursos) y ofrecer corregir.
- Rollout que expira: ejecutar `kubectl rollout undo`, avisar y dejar el estado consistente.
- Token inválido: el pod arranca pero no queda `ready`. Mostrar los logs y sugerir rotar el token.
- Dos túneles en el mismo namespace: cada uno con su `ID` y su propio label de nodo, sin interferir.
- Un túnel en un agente distinto al de la app: el tráfico cruza la tailnet. Mostrar un aviso informativo (no bloqueante).

---

## 10. Criterios de aceptación

1. Puedo instalar un túnel eligiendo namespace, token y 1 o más agentes, y queda `ready` en menos de ~90 s.
2. Si apago el agente donde corre, el pod se reprograma en otro agente permitido en aproximadamente 30-60 s.
3. Puedo cambiar la asignación de agentes sin cortar el túnel.
4. Con `replicas: 2` y dos agentes, quedan repartidas una por agente.
5. `--check` valida el pre-flight sin abrir la TUI.
6. Eliminar un túnel deja el clúster sin labels huérfanos.
7. La herramienta nunca modifica recursos ni labels de `kpg`, `k3access` o `tacl`.
8. El consumo adicional en el clúster es solo el pod de cloudflared (~20-50 MB de RAM por réplica).

---

## 11. Orden de trabajo sugerido

1. Leer `k3access` y `kpg`. Resumir sus convenciones antes de escribir código.
2. Wrapper de `kubectl` + pre-flight + `--check`.
3. Generador de manifiestos (Secret + Deployment) con pruebas.
4. Flujo de instalación (7.2) con rollback.
5. Cambio de asignación (7.3) y compatibilidad con el namespace (7.5).
6. Resto de acciones (7.4), eliminación (7.6) y auditoría (7.7).
7. TUI completa, instalador con SHA-256 y empaquetado.

Ante cualquier decisión ambigua, **pregunta antes de implementar**.
