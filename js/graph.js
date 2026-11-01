// ============================================================
// RepoVerse — Bat-Signal Graph Engine
// - Fixed world space: repos fill an original bat emblem projected on the clouds;
//   each niche owns a slice of the emblem, older repos sit nearer its centre
// - Collision-relaxed layout so nodes never stack
// - Render-on-demand: frames are only drawn while something moves
// - Pre-rendered glow sprites, spatial-grid hit testing, viewport culling
// - Pointer events: drag to pan, wheel / pinch to zoom, tap to select
// ============================================================

class GraphRenderer {
  constructor(canvas, repos, categories, relationships) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.repos = repos;
    this.categories = categories;
    this.relationships = relationships;

    // World geometry (screen-independent, so resizing never re-shuffles nodes)
    // The graph fills the disc of light; a smaller emblem sits at its centre
    this.signal = { cx: 0, cy: 0, rx: 1500, ry: 900 };
    this.BS = 520;                        // bat emblem half-width in world units
    this.rMin = 40;                       // clearance between the emblem and the nearest repos

    this.palette = {};
    categories.forEach(cat => {
      const hex = cat.color || '#ffffff';
      this.palette[cat.id] = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    });

    this._buildEmblem();
    this._buildSectors();

    // Interaction state
    this.hoverId = null;
    this.selectedId = null;
    this.focusIds = null;   // search results / niche browsing
    this.path = null;       // traced path or blueprint pipeline
    this.insetRight = 0;    // px covered by the side drawer

    // Camera: screen = world * s + (x, y)
    this.cam = { x: 0, y: 0, s: 1 };
    this.target = { x: 0, y: 0, s: 1 };
    this.fitScale = 1;
    this.userMoved = false;

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dirty = true;
    this.time = 0;
    this.pointer = { x: 0, y: 0, inside: false, moved: false };

    this._buildGraph();
    this._layout();
    this._buildGrid();
    this._makeSprites();
    this._resize();
    this._fit(true);
    this._bindEvents();

    this._last = performance.now();
    requestAnimationFrame(t => this._frame(t));
  }

  // ── Data ──────────────────────────────────────────────
  _buildGraph() {
    const maxStars = Math.max(...this.repos.map(r => r.stars), 1);
    this.nodes = this.repos.map((repo, i) => ({
      ...repo,
      idx: i,
      weight: Math.sqrt(repo.stars / maxStars),
      rgb: this.palette[repo.category] || [255, 255, 255],
      // Natural variation in brightness, nudged up for popular repos
      bright: Math.min(1, 0.5 + this._hash(repo.id + '*') * 0.35 + Math.sqrt(repo.stars / maxStars) * 0.5),
      alpha: 0.85,
      x: 0,
      y: 0,
    }));
    this.nodeById = new Map(this.nodes.map(n => [n.id, n]));

    this.adj = new Map(this.nodes.map(n => [n.id, new Set()]));
    this.edges = [];
    this.relationships.forEach(rel => {
      const s = this.nodeById.get(rel.source);
      const t = this.nodeById.get(rel.target);
      if (!s || !t) return;
      this.edges.push({ s, t, type: rel.type });
      this.adj.get(s.id).add(t.id);
      this.adj.get(t.id).add(s.id);
    });

    // Label priority: biggest repos first
    this.byStars = [...this.nodes].sort((a, b) => b.stars - a.stars);
  }

  // ── Bat emblem geometry ───────────────────────────────
  // Right half of an original bat emblem in units of half-width (y points down), mirrored for the left.
  static batSegments() {
    return {
      start: [0, -0.19],
      segs: [
        ['L', [0.05, -0.205]],
        ['L', [0.078, -0.34]],              // ear tip
        ['L', [0.105, -0.17]],
        ['Q', [0.45, -0.1], [1.0, -0.37]],  // upper wing edge sweeping to the tip
        ['Q', [0.93, -0.05], [0.86, 0.1]],  // outer wing edge
        ['Q', [0.76, 0.0], [0.62, 0.14]],   // scallops
        ['Q', [0.52, 0.06], [0.4, 0.24]],
        ['Q', [0.3, 0.12], [0.17, 0.3]],
        ['Q', [0.08, 0.3], [0, 0.5]],       // tail point
      ],
    };
  }

  // Closed outline as a list of [x, y] points (quadratics flattened), unit scale
  static batOutline(steps = 14) {
    const { start, segs } = GraphRenderer.batSegments();
    const right = [start];
    let cur = start;
    const pieces = [];
    segs.forEach(seg => {
      const end = seg[0] === 'L' ? seg[1] : seg[2];
      pieces.push({ from: cur, ctrl: seg[0] === 'Q' ? seg[1] : null, to: end });
      cur = end;
    });
    const flatten = (p, mirror) => {
      const m = ([x, y]) => [mirror ? -x : x, y];
      const out = [];
      if (!p.ctrl) { out.push(m(p.to)); return out; }
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        out.push(m([u * u * p.from[0] + 2 * u * t * p.ctrl[0] + t * t * p.to[0], u * u * p.from[1] + 2 * u * t * p.ctrl[1] + t * t * p.to[1]]));
      }
      return out;
    };
    pieces.forEach(p => right.push(...flatten(p, false)));
    const left = [];
    [...pieces].reverse().forEach(p => left.push(...flatten({ from: p.to, ctrl: p.ctrl, to: p.from }, true)));
    return [...right, ...left];
  }

  // SVG path data for the same emblem (used by the signature corner)
  static batSvgPath(w = 64) {
    const pts = GraphRenderer.batOutline(10);
    const h = w / 2;
    return 'M' + pts.map(([x, y]) => `${(h + x * h).toFixed(2)} ${(h * 0.75 + y * h).toFixed(2)}`).join(' L') + ' Z';
  }

  _buildEmblem() {
    const S = this.BS;
    const { start, segs } = GraphRenderer.batSegments();
    const p = new Path2D();
    p.moveTo(start[0] * S, start[1] * S);
    const right = [];
    let cur = start;
    segs.forEach(seg => {
      const end = seg[0] === 'L' ? seg[1] : seg[2];
      right.push({ from: cur, seg });
      if (seg[0] === 'L') p.lineTo(end[0] * S, end[1] * S);
      else p.quadraticCurveTo(seg[1][0] * S, seg[1][1] * S, end[0] * S, end[1] * S);
      cur = end;
    });
    [...right].reverse().forEach(({ from, seg }) => {
      if (seg[0] === 'L') p.lineTo(-from[0] * S, from[1] * S);
      else p.quadraticCurveTo(-seg[1][0] * S, seg[1][1] * S, -from[0] * S, from[1] * S);
    });
    p.closePath();
    this.batPath = p;

    // Distance from the centre to the emblem edge for every direction (ray casting)
    const poly = GraphRenderer.batOutline(16).map(([x, y]) => [x * S, y * S]);
    this.rayN = 1440;
    this.rayR = new Float32Array(this.rayN);
    for (let i = 0; i < this.rayN; i++) {
      const a = (i / this.rayN) * Math.PI * 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      let best = Infinity;
      for (let j = 0; j < poly.length; j++) {
        const [x1, y1] = poly[j], [x2, y2] = poly[(j + 1) % poly.length];
        const ex = x2 - x1, ey = y2 - y1;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = (x1 * ey - y1 * ex) / den;
        const u = (x1 * dy - y1 * dx) / den;
        if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
      }
      this.rayR[i] = best === Infinity ? this.rMin * 2 : best;
    }
  }

  // Distance from the centre to the emblem edge (inner bound for repos)
  _edgeR(a) {
    const n = this.rayN;
    let i = Math.round((((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * n) % n;
    return this.rayR[i];
  }

  _innerR(a) {
    return this._edgeR(a) + this.rMin;
  }

  // Distance from the centre to the rim of the light (outer bound for repos)
  _outerR(a) {
    const { rx, ry } = this.signal;
    const c = Math.cos(a), s = Math.sin(a);
    return 0.93 / Math.sqrt((c * c) / (rx * rx) + (s * s) / (ry * ry));
  }

  // Each niche gets an angular slice of the emblem sized by how many repos it holds,
  // balanced between equal angles and equal area so wing tips don't swallow everything
  _buildSectors() {
    const counts = {};
    this.repos.forEach(r => { counts[r.category] = (counts[r.category] || 0) + 1; });
    const total = this.repos.length || 1;
    const N = this.rayN;
    const start = -Math.PI / 2;
    const weightAt = i => {
      const a = start + (i / N) * Math.PI * 2;
      const ro = this._outerR(a), ri = this._innerR(a);
      return ro * ro - ri * ri;
    };
    const areaW = [], cumA = [0];
    let sumArea = 0;
    for (let i = 0; i < N; i++) { const w = Math.max(weightAt(i), 1); areaW.push(w); sumArea += w; }
    for (let i = 0; i < N; i++) cumA.push(cumA[i] + 0.5 * areaW[i] / sumArea + 0.5 / N);

    this.sectors = {};
    this.catAngle = {};
    let idx = 0;
    let acc = 0;
    this.categories.forEach(cat => {
      const share = (counts[cat.id] || 0) / total;
      const from = idx;
      acc += share;
      while (idx < N && cumA[idx + 1] <= acc + 1e-9) idx++;
      const a0 = start + (from / N) * Math.PI * 2;
      const a1 = start + (Math.max(idx, from + 1) / N) * Math.PI * 2;
      this.sectors[cat.id] = { a0, a1 };
      this.catAngle[cat.id] = (a0 + a1) / 2;
    });
  }

  // Older repos sit near the emblem's centre, newer ones out toward its edge
  _yearT(year) {
    return Math.pow((Math.max(1990, Math.min(2026, year || 2020)) - 1990) / 36, 0.9);
  }

  _hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10000) / 10000;
  }

  // Place by niche slice + year depth inside the emblem, then relax overlaps within those bounds
  _layout() {
    // Area-even fill: radius² is linear in t, so the light is covered uniformly
    const rFor = (a, t) => {
      const ri = this._innerR(a), ro = this._outerR(a);
      return Math.sqrt(ri * ri + (ro * ro - ri * ri) * t);
    };
    // t = age rank within the niche: oldest next to the emblem, newest at the rim
    const byCat = {};
    this.nodes.forEach(n => { (byCat[n.category] = byCat[n.category] || []).push(n); });
    Object.values(byCat).forEach(list => {
      list.sort((p, q) => p.year - q.year || q.stars - p.stars);
      list.forEach((n, i) => { n.t = (i + 0.5) / list.length; });
    });
    this.nodes.forEach(n => {
      const sec = this.sectors[n.category] || { a0: 0, a1: 0.1 };
      n.a0 = sec.a0 + (sec.a1 - sec.a0) * 0.06;
      n.a1 = sec.a1 - (sec.a1 - sec.a0) * 0.06;
      n.a = n.a0 + this._hash(n.id) * (n.a1 - n.a0);
      n.r = rFor(n.a, n.t);
    });
    const clampNode = n => {
      n.a = Math.max(n.a0, Math.min(n.a1, n.a));
      const inner = this._innerR(n.a), outer = this._outerR(n.a);
      const ideal = rFor(n.a, n.t);
      const slack = (outer - inner) * 0.22;
      n.r = Math.max(inner, Math.min(outer, Math.max(ideal - slack, Math.min(ideal + slack, n.r))));
    };

    const minDist = 28;
    const cell = minDist;
    for (let iter = 0; iter < 80; iter++) {
      this.nodes.forEach(n => { n.x = n.r * Math.cos(n.a); n.y = n.r * Math.sin(n.a); });
      const grid = new Map();
      this.nodes.forEach(n => {
        const k = `${Math.floor(n.x / cell)},${Math.floor(n.y / cell)}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(n);
      });
      let moved = 0;
      this.nodes.forEach(n => {
        const cx = Math.floor(n.x / cell), cy = Math.floor(n.y / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const list = grid.get(`${cx + dx},${cy + dy}`);
          if (!list) continue;
          for (const m of list) {
            if (m.idx <= n.idx) continue;
            let vx = m.x - n.x, vy = m.y - n.y;
            let d = Math.hypot(vx, vy);
            const want = minDist + (n.weight + m.weight) * 8;
            if (d >= want) continue;
            if (d < 0.01) { vx = Math.cos(n.idx); vy = Math.sin(n.idx); d = 1; }
            const push = (want - d) / 2 / d;
            n.x -= vx * push; n.y -= vy * push;
            m.x += vx * push; m.y += vy * push;
            moved++;
          }
        }
      });
      // Back to polar with constraints
      this.nodes.forEach(n => {
        const mid = (n.a0 + n.a1) / 2;
        let da = Math.atan2(n.y, n.x) - mid;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        n.a = mid + da;
        n.r = Math.hypot(n.x, n.y);
        clampNode(n);
      });
      if (!moved) break;
    }
    this.nodes.forEach(n => { n.x = n.r * Math.cos(n.a); n.y = n.r * Math.sin(n.a); });
  }

  _buildGrid() {
    this.gridCell = 60;
    this.grid = new Map();
    this.nodes.forEach(n => {
      const k = `${Math.floor(n.x / this.gridCell)},${Math.floor(n.y / this.gridCell)}`;
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(n);
    });
  }

  // One glow + one core sprite per niche colour; drawImage is far cheaper than gradients per node
  _makeSprites() {
    this.sprites = {};
    Object.entries(this.palette).forEach(([id, [r, g, b]]) => {
      // Niche colour is only a faint tint on silver; full colour is kept for focus states
      const mix = (c, k, base) => Math.round(c * k + base * (1 - k));
      this.sprites[id] = {
        fill: `rgb(${mix(r, 0.08, 244)},${mix(g, 0.08, 246)},${mix(b, 0.08, 250)})`,
        accent: `rgb(${mix(r, 0.75, 222)},${mix(g, 0.75, 222)},${mix(b, 0.75, 222)})`,
      };
    });
    this.sprites._default = this.sprites[Object.keys(this.sprites)[0]];

    // Glow sprites: a gaussian-like falloff, mostly white with a whisper of the niche colour.
    // Drawn additively, so clusters brighten naturally where light overlaps.
    Object.entries(this.palette).forEach(([id, [r, g, b]]) => {
      const tint = (c, base) => Math.round(c * 0.22 + base * 0.78);
      const cr = tint(r, 225), cg = tint(g, 232), cb = tint(b, 255);
      const glow = document.createElement('canvas');
      glow.width = glow.height = 64;
      const gx = glow.getContext('2d');
      const grad = gx.createRadialGradient(32, 32, 0, 32, 32, 32);
      [[0, 0.55], [0.08, 0.38], [0.2, 0.16], [0.4, 0.05], [0.7, 0.012], [1, 0]].forEach(([t, a]) => {
        grad.addColorStop(t, `rgba(${cr},${cg},${cb},${a})`);
      });
      gx.fillStyle = grad;
      gx.fillRect(0, 0, 64, 64);
      this.sprites[id].glow = glow;
      if (window.createImageBitmap) createImageBitmap(glow).then(bmp => { this.sprites[id].glow = bmp; this.dirty = true; });
    });
  }

  // ── Viewport ──────────────────────────────────────────
  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.W = rect.width || window.innerWidth;
    this.H = rect.height || window.innerHeight;
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this._buildSky();

    const sig = this.signal;
    this.fitScale = Math.min((this.W - 60) / (sig.rx * 2 * 1.16), (this.H - 150) / (sig.ry * 2 * 1.12));
    this.dirty = true;
  }

  // Plain black backdrop
  _buildSky() {
    this.bg = document.createElement('canvas');
    this.bg.width = this.canvas.width;
    this.bg.height = this.canvas.height;
    const b = this.bg.getContext('2d');
    b.fillStyle = '#000000';
    b.fillRect(0, 0, this.bg.width, this.bg.height);
  }

  _viewCenter() {
    return { x: (this.W - this.insetRight) / 2, y: 60 + (this.H - 80) / 2 };
  }

  _fit(immediate) {
    const c = this._viewCenter();
    this.target = { x: c.x, y: c.y, s: this.fitScale };
    if (immediate) this.cam = { ...this.target };
    this.dirty = true;
  }

  resetView() {
    this.userMoved = false;
    this._fit(false);
  }

  setInsetRight(px) {
    this.insetRight = px;
  }

  flyToNode(id, scale) {
    const n = this.nodeById.get(id);
    if (!n) return;
    const s = Math.max(scale || this.fitScale * 2.4, this.target.s);
    const c = this._viewCenter();
    this.target = { x: c.x - n.x * s, y: c.y - n.y * s, s };
    this.userMoved = true;
  }

  fitToNodes(ids, insetTop = 0) {
    const list = ids.map(id => this.nodeById.get(id)).filter(Boolean);
    if (!list.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    list.forEach(n => { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); });
    // insetTop: space covered by an open search dropdown
    const pad = 90;
    const top = Math.max(80, insetTop);
    const w = this.W - this.insetRight, h = this.H - top - 20;
    const s = Math.min(this.fitScale * 5, Math.max(this.fitScale * 0.8, Math.min(w / (maxX - minX + pad * 2), h / (maxY - minY + pad * 2))));
    const cx = (this.W - this.insetRight) / 2, cy = top + h / 2;
    this.target = { x: cx - ((minX + maxX) / 2) * s, y: cy - ((minY + maxY) / 2) * s, s };
    this.userMoved = true;
  }

  // ── Public state setters ──────────────────────────────
  select(id, fly = true) {
    this.selectedId = id;
    if (id && fly) this.flyToNode(id);
    this.dirty = true;
  }

  setFocus(ids) {
    this.focusIds = ids && ids.length ? new Set(ids) : null;
    this.dirty = true;
  }

  setPath(ids) {
    this.path = ids && ids.length ? ids.filter(id => this.nodeById.has(id)) : null;
    this.dirty = true;
  }

  // ── Events ────────────────────────────────────────────
  _bindEvents() {
    const c = this.canvas;
    const pointers = new Map();
    let drag = null;
    let pinch = null;

    const local = e => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 1) {
        drag = { sx: p.x, sy: p.y, camX: this.cam.x, camY: this.cam.y, moved: false };
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: this.cam.s };
        drag = null;
      }
    });

    c.addEventListener('pointermove', e => {
      const p = local(e);
      this.pointer = { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY, inside: true, moved: true };

      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this._zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.s * d / pinch.d) / this.target.s, true);
        return;
      }

      if (drag) {
        const dx = p.x - drag.sx, dy = p.y - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) > 4) {
          drag.moved = true;
          c.classList.add('dragging');
          this._setHover(null);
        }
        if (drag.moved) {
          // Pan follows the pointer 1:1, no easing lag
          this.cam.x = this.target.x = drag.camX + dx;
          this.cam.y = this.target.y = drag.camY + dy;
          this.userMoved = true;
          this.dirty = true;
        }
      }
    });

    const end = e => {
      const wasTap = drag && !drag.moved && pointers.size === 1;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      c.classList.remove('dragging');
      if (wasTap) {
        const p = local(e);
        const n = this._hit(p.x, p.y);
        this.select(n ? n.id : null, !!n);
        if (this.onSelect) this.onSelect(n || null);
      }
      drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      this.pointer.inside = false;
      if (!drag) this._setHover(null);
    });

    c.addEventListener('wheel', e => {
      e.preventDefault();
      const p = local(e);
      // Trackpad pinch arrives as ctrl+wheel with small deltas
      const k = e.ctrlKey ? 0.012 : 0.0016;
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this._zoomAt(p.x, p.y, Math.exp(-delta * k), false);
    }, { passive: false });

    c.addEventListener('dblclick', e => {
      const p = local(e);
      this._zoomAt(p.x, p.y, 1.8, false);
    });

    window.addEventListener('resize', () => {
      this._resize();
      if (!this.userMoved) this._fit(true);
    });
  }

  _zoomAt(px, py, factor, immediate) {
    const minS = this.fitScale * 0.6, maxS = this.fitScale * 14;
    const s1 = Math.max(minS, Math.min(maxS, this.target.s * factor));
    const f = s1 / this.target.s;
    this.target.x = px - (px - this.target.x) * f;
    this.target.y = py - (py - this.target.y) * f;
    this.target.s = s1;
    if (immediate) this.cam = { ...this.target };
    this.userMoved = true;
    this.dirty = true;
  }

  _screenRadius(n) {
    const zoom = Math.pow(this.cam.s / this.fitScale, 0.5);
    return (0.8 + n.weight * 2.4) * zoom;
  }

  _hit(px, py) {
    const s = this.cam.s;
    const wx = (px - this.cam.x) / s, wy = (py - this.cam.y) / s;
    const reach = 14 / s + 12;
    const gc = this.gridCell;
    let best = null, bestD = Infinity;
    for (let gx = Math.floor((wx - reach) / gc); gx <= Math.floor((wx + reach) / gc); gx++) {
      for (let gy = Math.floor((wy - reach) / gc); gy <= Math.floor((wy + reach) / gc); gy++) {
        const list = this.grid.get(`${gx},${gy}`);
        if (!list) continue;
        for (const n of list) {
          const d = Math.hypot(n.x - wx, n.y - wy) * s;
          const r = Math.max(this._screenRadius(n) + 6, 10);
          if (d < r && d < bestD) { best = n; bestD = d; }
        }
      }
    }
    return best;
  }

  _setHover(node) {
    const id = node ? node.id : null;
    if (id === this.hoverId) {
      if (node && this.onHover) this.onHover(node, this.pointer.cx, this.pointer.cy);
      return;
    }
    this.hoverId = id;
    this.canvas.style.cursor = node ? 'pointer' : '';
    this.dirty = true;
    if (this.onHover) this.onHover(node, this.pointer.cx, this.pointer.cy);
  }

  // ── Frame loop ────────────────────────────────────────
  _frame(now) {
    const dt = Math.min((now - this._last) / 1000, 0.05);
    this._last = now;
    this.time += dt;

    // Hover is resolved once per frame, not once per mouse event
    if (this.pointer.moved && this.pointer.inside && !this.canvas.classList.contains('dragging')) {
      this.pointer.moved = false;
      this._setHover(this._hit(this.pointer.x, this.pointer.y));
    }

    let active = this._stepCamera(dt);
    active = this._stepAlpha(dt) || active;
    if (this.selectedId || this.path) active = true; // pulse + flowing path

    if (active || this.dirty) {
      this._draw();
      this.dirty = false;
    }
    requestAnimationFrame(t => this._frame(t));
  }

  _stepCamera(dt) {
    const k = 1 - Math.exp(-dt * 11);
    const c = this.cam, t = this.target;
    const dx = t.x - c.x, dy = t.y - c.y, ds = t.s - c.s;
    if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05 && Math.abs(ds) < t.s * 0.0005) {
      if (dx || dy || ds) { c.x = t.x; c.y = t.y; c.s = t.s; return true; }
      return false;
    }
    // Interpolate scale in log space so zoom speed feels constant
    const ls = Math.log(c.s) + (Math.log(t.s) - Math.log(c.s)) * k;
    const s1 = Math.exp(ls);
    // Keep the zoom anchor stable while scale eases
    const f = Math.abs(ds) > t.s * 0.001 ? (s1 - c.s) / ds : k;
    c.x += dx * f;
    c.y += dy * f;
    c.s = s1;
    return true;
  }

  _emphasis() {
    if (this.hoverId) {
      const set = new Set(this.adj.get(this.hoverId));
      set.add(this.hoverId);
      if (this.selectedId) set.add(this.selectedId);
      return set;
    }
    if (this.path) return new Set(this.path);
    if (this.selectedId) {
      const set = new Set(this.adj.get(this.selectedId));
      set.add(this.selectedId);
      return set;
    }
    return this.focusIds;
  }

  _stepAlpha(dt) {
    const E = this._emphasis();
    this._E = E;
    const k = 1 - Math.exp(-dt * 14);
    let changing = false;
    for (const n of this.nodes) {
      const target = E ? (E.has(n.id) ? 1 : 0.1) : 0.82;
      const d = target - n.alpha;
      if (Math.abs(d) > 0.004) { n.alpha += d * k; changing = true; }
      else n.alpha = target;
    }
    return changing;
  }

  // ── Drawing ───────────────────────────────────────────
  _draw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this._drawBackdrop(ctx);
    this._drawEdges(ctx);
    this._drawNodes(ctx);
    this._drawLabels(ctx);
  }

  _toScreen(wx, wy) {
    return [wx * this.cam.s + this.cam.x, wy * this.cam.s + this.cam.y];
  }

  _drawBackdrop(ctx) {
    const { s, x: ox, y: oy } = this.cam;
    const dpr = this.dpr;
    const sig = this.signal;
    const dim = this._E ? 0.6 : 1;
    const cx = ox + sig.cx * s, cy = oy + sig.cy * s;
    const rx = sig.rx * s, ry = sig.ry * s;

    // The emblem: a quiet silhouette at the centre of the network
    ctx.save();
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fill(this.batPath);
    ctx.lineWidth = 1 / s;
    ctx.strokeStyle = `rgba(220,228,245,${0.28 * dim})`;
    ctx.stroke(this.batPath);
    ctx.restore();

    // Niche names around the network, nudged apart so they never collide
    const focusCats = this._E ? new Set([...this._E].map(id => this.nodeById.get(id)?.category)) : null;
    ctx.font = '500 8.5px Inter, -apple-system, sans-serif';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.6px';
    const labels = this.categories.map(cat => {
      const a = this.catAngle[cat.id];
      const ca = Math.cos(a), sa = Math.sin(a);
      return { cat, side: ca >= 0 ? 1 : -1, x: cx + ca * rx * 1.02 + ca * 8, y: cy + sa * ry * 1.04 + sa * 6 };
    });
    [1, -1].forEach(side => {
      const list = labels.filter(l => l.side === side).sort((p, q) => p.y - q.y);
      for (let i = 1; i < list.length; i++) {
        if (list[i].y - list[i - 1].y < 13) list[i].y = list[i - 1].y + 13;
      }
    });
    ctx.textBaseline = 'middle';
    labels.forEach(({ cat, side, x, y }) => {
      const on = focusCats && focusCats.has(cat.id);
      ctx.textAlign = side > 0 ? 'left' : 'right';
      ctx.fillStyle = on ? this.sprites[cat.id].accent : `rgba(210,216,228,${focusCats ? 0.18 : 0.42})`;
      ctx.fillText(cat.name.toUpperCase(), x, y);
    });
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }

  _curve(ctx, a, b) {
    const [x1, y1] = this._toScreen(a.x, a.y);
    const [x2, y2] = this._toScreen(b.x, b.y);
    // Bow edges gently toward the web centre
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(mx + (this.cam.x - mx) * 0.2, my + (this.cam.y - my) * 0.2, x2, y2);
  }

  _drawEdges(ctx) {
    const E = this._E;
    const strong = [];

    // Hover/selection: edges touching that node. Search focus: edges inside the result set.
    const center = this.hoverId || this.selectedId;
    const isStrong = e => center
      ? (e.s.id === center || e.t.id === center)
      : (!this.path && E && E.has(e.s.id) && E.has(e.t.id));

    ctx.save();
    // Additive: where many threads cross, the network glows a little brighter
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath();
    for (const e of this.edges) {
      if (isStrong(e)) { strong.push(e); continue; }
      this._curve(ctx, e.s, e.t);
    }
    ctx.strokeStyle = `rgba(150,170,220,${E ? 0.025 : 0.075})`;
    ctx.lineWidth = 0.6;
    ctx.stroke();

    ctx.lineWidth = 1;
    for (const e of strong) {
      ctx.beginPath();
      this._curve(ctx, e.s, e.t);
      ctx.setLineDash(e.type === 'alternative-to' ? [3, 4] : e.type === 'depends-on' ? [1, 3] : []);
      ctx.strokeStyle = (this.sprites[e.s.category] || this.sprites._default).accent;
      ctx.globalAlpha = 0.7;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    // Traced path / blueprint pipeline: flowing line through the steps in order
    if (this.path && this.path.length > 1) {
      ctx.beginPath();
      for (let i = 0; i < this.path.length - 1; i++) {
        this._curve(ctx, this.nodeById.get(this.path[i]), this.nodeById.get(this.path[i + 1]));
      }
      ctx.setLineDash([4, 6]);
      ctx.lineDashOffset = -this.time * 20;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
    ctx.restore();
  }

  _drawNodes(ctx) {
    const pad = 60;
    const W = this.W, H = this.H;
    const E = this._E;
    const visible = [];
    for (const n of this.nodes) {
      const [x, y] = this._toScreen(n.x, n.y);
      if (x < -pad || y < -pad || x > W + pad || y > H + pad) continue;
      n.sx = x; n.sy = y; n.rs = this._screenRadius(n);
      visible.push(n);
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Soft light around every node; overlapping halos add up like real light
    for (const n of visible) {
      const a = n.alpha * n.bright;
      if (a < 0.04) continue;
      const big = n.id === this.hoverId || n.id === this.selectedId;
      const g = n.rs * (big ? 10 : 5.5 + n.weight * 6);
      ctx.globalAlpha = Math.min(1, a * (big ? 1.3 : 1.0));
      ctx.drawImage((this.sprites[n.category] || this.sprites._default).glow, n.sx - g, n.sy - g, g * 2, g * 2);
    }

    // Small cores; emphasised nodes take their niche accent
    const buckets = new Map();
    for (const n of visible) {
      const accent = E && E.has(n.id);
      const a = Math.round(Math.min(1, n.alpha * n.bright) * 10) / 10;
      if (a <= 0) continue;
      const key = n.category + '|' + a + '|' + (accent ? 1 : 0);
      if (!buckets.has(key)) buckets.set(key, { cat: n.category, a, accent, list: [] });
      buckets.get(key).list.push(n);
    }
    for (const { cat, a, accent, list } of buckets.values()) {
      const sp = this.sprites[cat] || this.sprites._default;
      ctx.globalAlpha = a * 0.85;
      ctx.fillStyle = accent ? sp.accent : sp.fill;
      ctx.beginPath();
      for (const n of list) {
        const c = Math.max(0.6, n.rs * 0.75);
        ctx.moveTo(n.sx + c, n.sy);
        ctx.arc(n.sx, n.sy, c, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // Hot white centre on the brighter nodes
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (const n of visible) {
      if (n.alpha * n.bright < 0.55 || n.rs < 1.6) continue;
      const c = Math.max(0.5, n.rs * 0.3);
      ctx.moveTo(n.sx + c, n.sy);
      ctx.arc(n.sx, n.sy, c, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();

    // Hover reticle
    if (this.hoverId) this._ring(ctx, this.nodeById.get(this.hoverId), 0.7, 0);
    // Selected: steady ring + soft pulse
    if (this.selectedId) {
      const n = this.nodeById.get(this.selectedId);
      this._ring(ctx, n, 0.9, 0);
      const p = (this.time * 0.6) % 1;
      this._ring(ctx, n, 0.4 * (1 - p), 16 * p);
    }
  }

  _ring(ctx, n, alpha, grow) {
    if (!n) return;
    const [x, y] = this._toScreen(n.x, n.y);
    const r = this._screenRadius(n) + 7 + grow;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  _drawLabels(ctx) {
    const E = this._E;
    const zoom = this.cam.s / this.fitScale;
    const W = this.W, H = this.H;
    const placed = [];
    const maxLabels = 90;

    // Priority: hovered/selected, then emphasised set, then by stars (more appear as you zoom in)
    const candidates = [];
    const seen = new Set();
    const push = n => { if (n && !seen.has(n)) { seen.add(n); candidates.push(n); } };
    if (!this._textW) this._textW = new Map();
    push(this.nodeById.get(this.hoverId));
    push(this.nodeById.get(this.selectedId));
    if (this.path) this.path.forEach(id => push(this.nodeById.get(id)));
    if (E) this.byStars.forEach(n => { if (E.has(n.id)) push(n); });
    const ambient = Math.round(14 * zoom * zoom);
    for (let i = 0; i < Math.min(ambient, this.byStars.length); i++) push(this.byStars[i]);

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const n of candidates) {
      if (placed.length >= maxLabels) break;
      const [x, y] = this._toScreen(n.x, n.y);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      const key = n.id === this.hoverId || n.id === this.selectedId;
      const font = key ? '500 12px Inter, -apple-system, sans-serif' : '400 9.5px Inter, -apple-system, sans-serif';
      const wKey = (key ? 'k' : 'n') + n.id;
      let tw = this._textW.get(wKey);
      if (tw === undefined) { ctx.font = font; tw = ctx.measureText(n.name).width; this._textW.set(wKey, tw); }
      const lx = x + this._screenRadius(n) + 6;
      const box = { x: lx - 2, y: y - 8, w: tw + 4, h: 16 };
      if (!key && placed.some(b => b.x < box.x + box.w && box.x < b.x + b.w && b.y < box.y + box.h && box.y < b.y + b.h)) continue;
      placed.push(box);
      ctx.font = font;

      const a = key ? 1 : Math.max(0, Math.min(1, (E && !E.has(n.id) ? 0.25 : 1) * n.alpha * 1.1));
      if (a < 0.05) continue;
      // Dark halo keeps text legible over edges
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(0,0,0,${0.8 * a})`;
      ctx.strokeText(n.name, lx, y);
      ctx.fillStyle = key ? '#ffffff' : `rgba(230,234,245,${0.85 * a})`;
      ctx.fillText(n.name, lx, y);
    }
  }
}
