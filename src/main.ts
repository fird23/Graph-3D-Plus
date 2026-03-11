import { Plugin, ItemView, TFile, Setting } from 'obsidian';

const VIEW_TYPE = 'graph-3d-plus-view';

const DEFAULT_SETTINGS = {
  showTags: true,
  showAssets: true,
  showEdges: true,
  showOnlyHoverEdges: true,
  hideIsolated: false,
  searchText: '',
  searchHideNonMatches: false,
  colorByFolder: false,
  nodeScale: 1.0,
  edgeOpacity: 0.12,
  edgeHighlightOpacity: 0.75,
  repulsion: 2400,
  spring: 0.022,
  springLength: 92,
  gravity: 0.006,
  radial: 0.022,
  minDist: 18,
  maxRadius: 320,
  innerRadius: 60,
  isolateBoost: 0.25,
  physicsSpeed: 1.0,
};

const FOLDER_COLORS = [
  '#6cc7e6',
  '#f2b96c',
  '#9bd46b',
  '#d79adf',
  '#f27f7f',
  '#7cd7c2',
  '#c2c27c',
  '#89a7ff',
  '#ffa4d3',
  '#a0d18f',
];

function normalizeTag(tag: unknown): string | null {
  if (!tag) return null;
  let raw: unknown = tag;
  if (typeof tag === 'object') {
    const t = tag as { tag?: unknown; name?: unknown; value?: unknown };
    raw = t.tag ?? t.name ?? t.value ?? tag;
  }
  let t = String(raw).trim();
  if (!t) return null;
  if (t.startsWith('#')) t = t.slice(1);
  return '#' + t;
}

function extractTags(app, file): Set<string> {
  const tags = new Set<string>();
  const cache = app.metadataCache.getFileCache(file);
  if (cache?.tags) {
    for (const t of cache.tags) {
      const nt = normalizeTag(t.tag);
      if (nt) tags.add(nt);
    }
  }
  const fm = cache?.frontmatter || {};
  const fmTags = fm.tags ?? fm.tag ?? [];
  if (typeof fmTags === 'string') {
    const nt = normalizeTag(fmTags);
    if (nt) tags.add(nt);
  } else if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      const nt = normalizeTag(t);
      if (nt) tags.add(nt);
    }
  }
  return tags;
}

function topFolder(path: string): string {
  if (!path) return '';
  const idx = path.indexOf('/');
  if (idx === -1) return '';
  return path.slice(0, idx);
}

class Graph3DView extends ItemView {
  constructor(leaf, app, plugin) {
    super(leaf);
    this.app = app;
    this.plugin = plugin;
    this.nodes = [];
    this.edges = [];
    this.nodeById = new Map();
    this.adj = new Map();
    this.folderColor = new Map();
    this.zoom = 0.95;
    this.yaw = 0;
    this.pitch = 0;
    this.panX = 0;
    this.panY = 0;
    this.isDragging = false;
    this.isPanning = false;
    this.isNodeDragging = false;
    this.dragNodeId = null;
    this.dragDepth = null;
    this.lastX = 0;
    this.lastY = 0;
    this.dragMoved = 0;
    this.hoverId = null;
    this.projected = new Map();
    this.dpr = 1;
    this.lastTime = performance.now();
    this.settingsVisible = false;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'Graph 3D Plus';
  }

  getIcon() {
    return 'scatter-chart';
  }

  onOpen() {
    this.contentEl.addClass('graph3d-view');

    this.container = this.contentEl.createDiv({ cls: 'graph3d-container' });
    this.canvas = this.container.createEl('canvas', { cls: 'graph3d-canvas' });
    this.hint = this.container.createDiv({ cls: 'graph3d-hint' });
    this.hint.setText('ЛКМ: вращение/перетаскивание, ПКМ: перемещение, колесо: зум');

    this.settingsPanel = this.container.createDiv({ cls: 'graph3d-settings-panel is-hidden' });
    this.renderSettingsPanel();

    this.ctx = this.canvas.getContext('2d');

    this.addAction('settings', 'Настройки', () => this.toggleSettings());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();

    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.canvas.addEventListener('mouseleave', () => this.onMouseUp());
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.buildGraph();
    this.startRenderLoop();
  }

  onClose() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  toggleSettings() {
    this.settingsVisible = !this.settingsVisible;
    this.settingsPanel.toggleClass('is-hidden', !this.settingsVisible);
  }

  renderSettingsPanel() {
    const panel = this.settingsPanel;
    panel.empty();

    const header = panel.createDiv({ cls: 'graph3d-settings-header' });
    header.createEl('div', { text: 'Настройки' });
    const closeBtn = header.createEl('button', { text: '×' });
    closeBtn.addClass('graph3d-settings-close');
    closeBtn.onclick = () => this.toggleSettings();

    const body = panel.createDiv({ cls: 'graph3d-settings-body' });

    const s = this.plugin.settings;

    const section = (title) => {
      body.createEl('h3', { text: title });
    };

    section('Поиск');
    new Setting(body)
      .setName('Искать')
      .addText((t) =>
        t.setValue(s.searchText).onChange((v) => {
          s.searchText = v || '';
          void this.plugin.saveSettings();
          this.applyFiltersOnly();
        })
      );
    new Setting(body)
      .setName('Скрывать не совпадающие')
      .addToggle((t) =>
        t.setValue(s.searchHideNonMatches).onChange((v) => {
          s.searchHideNonMatches = v;
          void this.plugin.saveSettings();
          this.applyFiltersOnly();
        })
      );

    section('Фильтры');
    new Setting(body)
      .setName('Теги')
      .addToggle((t) =>
        t.setValue(s.showTags).onChange((v) => {
          s.showTags = v;
          void this.plugin.saveSettings();
          this.plugin.rebuildAll();
        })
      );

    new Setting(body)
      .setName('Вложения (не .md)')
      .addToggle((t) =>
        t.setValue(s.showAssets).onChange((v) => {
          s.showAssets = v;
          void this.plugin.saveSettings();
          this.plugin.rebuildAll();
        })
      );

    new Setting(body)
      .setName('Скрывать узлы без связей')
      .addToggle((t) =>
        t.setValue(s.hideIsolated).onChange((v) => {
          s.hideIsolated = v;
          void this.plugin.saveSettings();
          this.applyFiltersOnly();
        })
      );

    section('Отображение');
    new Setting(body)
      .setName('Линии связей')
      .addToggle((t) =>
        t.setValue(s.showEdges).onChange((v) => {
          s.showEdges = v;
          void this.plugin.saveSettings();
        })
      );

    new Setting(body)
      .setName('Линии только при наведении')
      .addToggle((t) =>
        t.setValue(s.showOnlyHoverEdges).onChange((v) => {
          s.showOnlyHoverEdges = v;
          void this.plugin.saveSettings();
        })
      );

    new Setting(body)
      .setName('Цвета по папкам')
      .addToggle((t) =>
        t.setValue(s.colorByFolder).onChange((v) => {
          s.colorByFolder = v;
          void this.plugin.saveSettings();
          this.buildFolderColors();
          this.renderSettingsPanel();
        })
      );

    const slider = (name, key, min, max, step) => {
      new Setting(body)
        .setName(name)
        .addSlider((sl) =>
          sl
            .setLimits(min, max, step)
            .setValue(s[key])
            .setDynamicTooltip()
            .onChange((v) => {
              s[key] = v;
              void this.plugin.saveSettings();
            })
        );
    };

    slider('Масштаб шариков', 'nodeScale', 0.6, 2.2, 0.1);
    slider('Прозрачность линий', 'edgeOpacity', 0.05, 0.35, 0.01);
    slider('Прозрачность подсветки', 'edgeHighlightOpacity', 0.3, 1.0, 0.05);
    slider('Отталкивание', 'repulsion', 800, 4200, 100);
    slider('Длина связи', 'springLength', 50, 160, 5);
    slider('Минимальная дистанция', 'minDist', 10, 30, 1);
    slider('Сила к центру', 'gravity', 0.002, 0.02, 0.001);
    slider('Притяжение по радиусу', 'radial', 0.005, 0.05, 0.001);
    slider('Размер сферы', 'maxRadius', 220, 620, 10);
    slider('Внутренний радиус', 'innerRadius', 20, 180, 5);
    slider('Разносить одиночные узлы', 'isolateBoost', 0.0, 0.7, 0.05);
    slider('Скорость физики', 'physicsSpeed', 0.4, 2.0, 0.1);

    if (s.colorByFolder) {
      section('Легенда папок');
      const legend = body.createDiv({ cls: 'graph3d-legend' });
      const entries = Array.from(this.folderColor.entries());
      if (entries.length === 0) {
        legend.createDiv({ text: 'Нет папок для отображения' });
      } else {
        for (const [folder, color] of entries) {
          const row = legend.createDiv({ cls: 'graph3d-legend-row' });
          const sw = row.createDiv({ cls: 'graph3d-legend-swatch' });
          sw.style.background = color;
          row.createDiv({ text: folder || '(корень)' });
        }
      }
    }
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr));
  }

  applyFiltersOnly() {
    const s = this.plugin.settings;
    const q = s.searchText.trim().toLowerCase();
    for (const node of this.nodes) {
      let visible = true;
      if (s.hideIsolated && (node.degree || 0) === 0) visible = false;
      if (q) {
        const label = String(node.label || '').toLowerCase();
        const path = node.file ? node.file.path.toLowerCase() : '';
        const hit = label.includes(q) || path.includes(q);
        if (s.searchHideNonMatches && !hit) visible = false;
      }
      node.visible = visible;
    }
  }

  buildFolderColors() {
    this.folderColor = new Map();
    if (!this.plugin.settings.colorByFolder) return;
    const folders = new Set();
    for (const node of this.nodes) {
      if (node.kind === 'tag') continue;
      folders.add(node.folder || '');
    }
    let i = 0;
    for (const f of folders) {
      this.folderColor.set(f, FOLDER_COLORS[i % FOLDER_COLORS.length]);
      i++;
    }
  }

  buildGraph() {
    this.nodes = [];
    this.edges = [];
    this.nodeById = new Map();
    this.adj = new Map();
    this.folderColor = new Map();

    const files = this.app.vault.getFiles();
    const s = this.plugin.settings;

    const addNode = (id, data) => {
      if (this.nodeById.has(id)) return this.nodeById.get(id);
      const node = { id, ...data, degree: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, pinned: false, visible: true };
      this.nodeById.set(id, node);
      this.nodes.push(node);
      return node;
    };

    for (const file of files) {
      const isMd = file.extension === 'md';
      if (!isMd && !s.showAssets) continue;
      const folder = topFolder(file.path);
      addNode(file.path, {
        label: file.basename,
        kind: isMd ? 'md' : 'asset',
        file,
        folder,
      });
    }

    const addEdge = (aId, bId, kind) => {
      if (!this.nodeById.has(aId) || !this.nodeById.has(bId)) return;
      this.edges.push({ a: aId, b: bId, kind });
      if (!this.adj.has(aId)) this.adj.set(aId, new Set());
      if (!this.adj.has(bId)) this.adj.set(bId, new Set());
      this.adj.get(aId).add(bId);
      this.adj.get(bId).add(aId);
    };

    for (const file of files) {
      if (file.extension !== 'md') continue;
      if (!this.nodeById.has(file.path)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.links) {
        for (const link of cache.links) {
          const dest = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
          if (dest instanceof TFile) addEdge(file.path, dest.path, 'link');
        }
      }
      if (cache?.embeds) {
        for (const link of cache.embeds) {
          const dest = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
          if (dest instanceof TFile) addEdge(file.path, dest.path, 'embed');
        }
      }

      if (s.showTags) {
        const tags = extractTags(this.app, file);
        for (const tag of tags) {
          const tagStr = String(tag);
          const tagId = 'tag:' + tagStr;
          addNode(tagId, { label: tagStr, kind: 'tag', folder: '' });
          addEdge(file.path, tagId, 'tag');
        }
      }
    }

    // Degree
    for (const edge of this.edges) {
      const a = this.nodeById.get(edge.a);
      const b = this.nodeById.get(edge.b);
      if (a) a.degree += 1;
      if (b) b.degree += 1;
    }

    // Sizes and radial target
    let maxDeg = 1;
    for (const node of this.nodes) maxDeg = Math.max(maxDeg, node.degree || 0);
    for (const node of this.nodes) {
      const sizeBase = 2.0;
      node.size = (sizeBase + Math.log2(2 + (node.degree || 0)) * 1.7) * s.nodeScale;
      const t = Math.log2(2 + (node.degree || 0)) / Math.log2(2 + maxDeg);
      node.targetRadiusFactor = 1 - Math.min(1, Math.max(0, t));
      if ((node.degree || 0) === 0) {
        node.targetRadiusFactor = Math.min(1, node.targetRadiusFactor + s.isolateBoost);
      }
    }

    // Search/filter visibility
    this.applyFiltersOnly();

    // Folder colors
    this.buildFolderColors();

    // Initial positions: sphere shell with inward jitter
    const n = this.nodes.length;
    const baseRadius = s.maxRadius;
    for (let i = 0; i < n; i++) {
      const node = this.nodes[i];
      const y = 1 - (i / Math.max(1, n - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const phi = i * Math.PI * (3 - Math.sqrt(5));
      const x = Math.cos(phi) * r;
      const z = Math.sin(phi) * r;
      const jitter = 0.86 + Math.random() * 0.22;
      node.x = x * baseRadius * jitter;
      node.y = y * baseRadius * jitter;
      node.z = z * baseRadius * jitter;
      node.vx = 0;
      node.vy = 0;
      node.vz = 0;
    }

    this.centerGraph();
  }

  centerGraph() {
    if (this.nodes.length === 0) return;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const n of this.nodes) {
      sx += n.x;
      sy += n.y;
      sz += n.z;
    }
    const cx = sx / this.nodes.length;
    const cy = sy / this.nodes.length;
    const cz = sz / this.nodes.length;
    for (const n of this.nodes) {
      n.x -= cx;
      n.y -= cy;
      n.z -= cz;
    }
  }

  stepPhysics(dt) {
    const nodes = this.nodes;
    const edges = this.edges;
    const n = nodes.length;
    if (n === 0) return;

    const s = this.plugin.settings;
    const layout = {
      step: 0.03 * s.physicsSpeed,
      repulsion: s.repulsion,
      spring: s.spring,
      springLength: s.springLength,
      gravity: s.gravity,
      radial: s.radial,
      repelSamples: Math.min(48, Math.max(12, Math.floor(n / 15))),
      minDist: s.minDist,
      maxRadius: s.maxRadius,
      innerRadius: s.innerRadius,
      damp: 0.88,
    };

    const idxById = new Map();
    for (let i = 0; i < n; i++) idxById.set(nodes[i].id, i);

    const fx = new Array(n).fill(0);
    const fy = new Array(n).fill(0);
    const fz = new Array(n).fill(0);

    // Springs
    for (const edge of edges) {
      const ai = idxById.get(edge.a);
      const bi = idxById.get(edge.b);
      if (ai == null || bi == null) continue;
      const a = nodes[ai];
      const b = nodes[bi];
      if (!a.visible || !b.visible) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.001;
      const diff = dist - layout.springLength;
      const force = layout.spring * diff;
      const nx = dx / dist;
      const ny = dy / dist;
      const nz = dz / dist;
      fx[ai] += nx * force;
      fy[ai] += ny * force;
      fz[ai] += nz * force;
      fx[bi] -= nx * force;
      fy[bi] -= ny * force;
      fz[bi] -= nz * force;
    }

    // Repulsion + collision (sampled)
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      if (!a.visible) continue;
      for (let sIdx = 0; sIdx < layout.repelSamples; sIdx++) {
        const j = (Math.random() * n) | 0;
        if (j === i) continue;
        const b = nodes[j];
        if (!b.visible) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        const dist2 = dx * dx + dy * dy + dz * dz + 1;
        const dist = Math.sqrt(dist2);
        const minD = layout.minDist + (a.size + b.size) * 0.8;
        if (dist < minD) {
          const push = (minD - dist) * 0.6;
          fx[i] += (dx / dist) * push;
          fy[i] += (dy / dist) * push;
          fz[i] += (dz / dist) * push;
        }
        const force = layout.repulsion / dist2;
        fx[i] += (dx / dist) * force;
        fy[i] += (dy / dist) * force;
        fz[i] += (dz / dist) * force;
      }
    }

    // Gravity to center
    for (let i = 0; i < n; i++) {
      if (!nodes[i].visible) continue;
      fx[i] -= nodes[i].x * layout.gravity;
      fy[i] -= nodes[i].y * layout.gravity;
      fz[i] -= nodes[i].z * layout.gravity;
    }

    // Radial target (higher degree -> closer to center)
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      if (!node.visible) continue;
      const r = Math.sqrt(node.x * node.x + node.y * node.y + node.z * node.z) + 0.001;
      const target = layout.innerRadius + (layout.maxRadius - layout.innerRadius) * node.targetRadiusFactor;
      const diff = r - target;
      const k = layout.radial * diff;
      fx[i] -= (node.x / r) * k;
      fy[i] -= (node.y / r) * k;
      fz[i] -= (node.z / r) * k;
    }

    // Integrate
    const step = layout.step * (dt / 16.67);
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      if (!node.visible) continue;
      if (node.pinned) {
        node.vx = 0;
        node.vy = 0;
        node.vz = 0;
        continue;
      }
      node.vx = (node.vx + fx[i]) * layout.damp;
      node.vy = (node.vy + fy[i]) * layout.damp;
      node.vz = (node.vz + fz[i]) * layout.damp;
      node.x += node.vx * step;
      node.y += node.vy * step;
      node.z += node.vz * step;

      const r = Math.sqrt(node.x * node.x + node.y * node.y + node.z * node.z);
      if (r > layout.maxRadius) {
        const k = layout.maxRadius / r;
        node.x *= k;
        node.y *= k;
        node.z *= k;
      }
    }
  }

  onMouseDown(e) {
    if (e.button === 0) {
      this.updateHover(e);
      if (this.hoverId) {
        this.isNodeDragging = true;
        this.dragNodeId = this.hoverId;
        const p = this.projected.get(this.dragNodeId);
        this.dragDepth = p ? p.z : null;
        const node = this.nodeById.get(this.dragNodeId);
        if (node) node.pinned = true;
        this.dragMoved = 0;
        return;
      }
      this.isDragging = true;
    } else if (e.button === 2) {
      this.isPanning = true;
    }
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  }

  onMouseMove(e) {
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (this.isNodeDragging && this.dragNodeId && this.dragDepth) {
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      const w = this.canvas.width;
      const h = this.canvas.height;
      const mx = e.offsetX * this.dpr;
      const my = e.offsetY * this.dpr;
      const world = this.screenToWorld(mx, my, this.dragDepth, w, h);
      if (world) {
        const node = this.nodeById.get(this.dragNodeId);
        if (node) {
          node.x = world.x;
          node.y = world.y;
          node.z = world.z;
        }
      }
    } else if (this.isDragging) {
      this.yaw += dx * 0.005;
      this.pitch += dy * 0.005;
      this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch));
    } else if (this.isPanning) {
      this.panX += dx * 1.0;
      this.panY += dy * 1.0;
    }

    this.updateHover(e);
  }

  onMouseUp(e) {
    if (this.isNodeDragging && this.dragNodeId) {
      const node = this.nodeById.get(this.dragNodeId);
      if (node) node.pinned = false;
      if (this.dragMoved < 6 && node?.file && e?.button === 0) {
        const leaf = this.app.workspace.getLeaf('tab') || this.app.workspace.getLeaf(false);
        void leaf.openFile(node.file, { active: true });
      }
    }
    this.isDragging = false;
    this.isPanning = false;
    this.isNodeDragging = false;
    this.dragNodeId = null;
    this.dragDepth = null;
    this.dragMoved = 0;
  }

  onWheel(e) {
    e.preventDefault();
    const delta = Math.sign(e.deltaY);
    this.zoom *= delta > 0 ? 0.9 : 1.1;
    this.zoom = Math.max(0.2, Math.min(4.0, this.zoom));
  }

  updateHover(e) {
    const mx = e.offsetX * this.dpr;
    const my = e.offsetY * this.dpr;
    let bestId = null;
    let bestDist = Infinity;
    for (const node of this.nodes) {
      if (!node.visible) continue;
      const p = this.projected.get(node.id);
      if (!p) continue;
      const dx = p.x - mx;
      const dy = p.y - my;
      const r = node.size * this.dpr + 4;
      const dist2 = dx * dx + dy * dy;
      if (dist2 <= r * r && dist2 < bestDist) {
        bestDist = dist2;
        bestId = node.id;
      }
    }
    this.hoverId = bestId;
  }

  screenToWorld(sx, sy, zc, w, h) {
    const fov = 660;
    const camDist = 760 / this.zoom;
    const dx1 = ((sx - w / 2 - this.panX) * zc) / fov;
    const dy1 = ((sy - h / 2 - this.panY) * zc) / fov;
    const dz2 = zc - camDist;

    const cosX = Math.cos(this.pitch);
    const sinX = Math.sin(this.pitch);
    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);

    const dy = dy1 * cosX + dz2 * sinX;
    const dz1 = -dy1 * sinX + dz2 * cosX;

    const x = dx1 * cosY + dz1 * sinY;
    const z = -dx1 * sinY + dz1 * cosY;

    return { x, y: dy, z };
  }

  projectPoint(x, y, z, w, h) {
    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    const cosX = Math.cos(this.pitch);
    const sinX = Math.sin(this.pitch);

    let dx = x * cosY - z * sinY;
    let dz = x * sinY + z * cosY;
    let dy = y * cosX - dz * sinX;
    dz = y * sinX + dz * cosX;

    const camDist = 760 / this.zoom;
    const fov = 660;
    const zc = dz + camDist;
    if (zc <= 10) return null;
    const sx = (dx * fov) / zc + w / 2 + this.panX;
    const sy = (dy * fov) / zc + h / 2 + this.panY;
    return { x: sx, y: sy, z: zc };
  }

  startRenderLoop() {
    const render = () => {
      this.draw();
      this.rafId = requestAnimationFrame(render);
    };
    render();
  }

  drawLabel(ctx, x, y, text) {
    const pad = 6 * this.dpr;
    ctx.font = `${12 * this.dpr}px ui-sans-serif, system-ui`;
    const w = ctx.measureText(text).width + pad * 2;
    const h = 18 * this.dpr;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect(x, y - h, w, h, 6 * this.dpr);
    ctx.fill();
    ctx.fillStyle = '#f0e6d0';
    ctx.fillText(text, x + pad, y - 5 * this.dpr);
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = performance.now();
    const dt = Math.min(40, now - this.lastTime);
    this.lastTime = now;

    this.stepPhysics(dt);

    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1f1f1f';
    ctx.fillRect(0, 0, w, h);

    this.projected = new Map();
    for (const node of this.nodes) {
      if (!node.visible) continue;
      const p = this.projectPoint(node.x, node.y, node.z, w, h);
      if (p) this.projected.set(node.id, p);
    }

    const s = this.plugin.settings;
    const hover = this.hoverId;
    const hoverSet = hover ? this.adj.get(hover) || new Set() : null;

    // Edges
    if (s.showEdges) {
      const baseAlpha = s.edgeOpacity;
      const hiAlpha = s.edgeHighlightOpacity;
      ctx.lineWidth = 1.0 * this.dpr;
      for (const edge of this.edges) {
        if (s.showOnlyHoverEdges && !hover) continue;
        const a = this.projected.get(edge.a);
        const b = this.projected.get(edge.b);
        if (!a || !b) continue;
        const isHi = hover && (edge.a === hover || edge.b === hover || (hoverSet && (hoverSet.has(edge.a) || hoverSet.has(edge.b))));
        const alpha = isHi ? hiAlpha : baseAlpha;
        if (alpha <= 0) continue;
        ctx.strokeStyle = `rgba(210, 200, 180, ${alpha})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Nodes (draw far to near)
    const nodesSorted = this.nodes.slice().filter((n) => n.visible).sort((n1, n2) => {
      const p1 = this.projected.get(n1.id);
      const p2 = this.projected.get(n2.id);
      return (p2?.z || 0) - (p1?.z || 0);
    });

    for (const node of nodesSorted) {
      const p = this.projected.get(node.id);
      if (!p) continue;
      let color = '#d6c7a1';
      if (node.kind === 'tag') color = '#d85a5a';
      if (node.kind === 'asset') color = '#5ac878';
      if (s.colorByFolder && node.kind !== 'tag') {
        color = this.folderColor.get(node.folder || '') || color;
      }
      const radius = node.size * this.dpr;
      const isHover = hover && (node.id === hover || (hoverSet && hoverSet.has(node.id)));
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.globalAlpha = isHover ? 1.0 : 0.9;
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1.0;

      if (isHover) {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.2 * this.dpr;
        ctx.stroke();
      }
    }

    // Label
    if (hover) {
      const node = this.nodeById.get(hover);
      const p = this.projected.get(hover);
      if (node && p) {
        this.drawLabel(ctx, p.x + 8 * this.dpr, p.y - 8 * this.dpr, node.label);
      }
    }
  }
}

class Graph3DPlusPlugin extends Plugin {
  onload() {
    this.settings = { ...DEFAULT_SETTINGS };
    void this.loadSettings().then(() => this.rebuildAll());

    this.registerView(VIEW_TYPE, (leaf) => new Graph3DView(leaf, this.app, this));

    this.addRibbonIcon('scatter-chart', 'Graph 3D Plus', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open-graph',
      name: 'Open graph',
      callback: () => {
        void this.activateView();
      },
    });

    const rebuild = () => this.rebuildAll();
    this.registerEvent(this.app.vault.on('create', rebuild));
    this.registerEvent(this.app.vault.on('delete', rebuild));
    this.registerEvent(this.app.vault.on('rename', rebuild));
    this.registerEvent(this.app.metadataCache.on('changed', rebuild));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  saveSettings() {
    return this.saveData(this.settings);
  }

  rebuildAll() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view?.buildGraph) view.buildGraph();
    }
  }

  onunload() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
  }

  activateView() {
    let leaf = this.app.workspace.getLeaf('tab');
    if (!leaf) leaf = this.app.workspace.getLeaf(false);
    void leaf.setViewState({ type: VIEW_TYPE, active: true }).then(() => {
      this.app.workspace.revealLeaf(leaf);
    });
  }
}

export default Graph3DPlusPlugin;

