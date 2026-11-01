// ============================================================
// RepoVerse — Controller
// Default view: full-screen graph + search bar only.
// Picking a repo (click or search) slides in the drawer with details and tools.
// ============================================================

(function () {
  'use strict';

  let graph = null;
  let searchEngine = null;

  const DRAWER_W = 400;
  const $canvas = document.getElementById('graph-canvas');
  const $search = document.getElementById('hud-search');
  const $clear = document.getElementById('btn-clear-search');
  const $dropdown = document.getElementById('hud-dropdown');
  const $drawer = document.getElementById('editorial-drawer');
  const $drawerContent = document.getElementById('drawer-content');
  const $tooltip = document.getElementById('minimal-tooltip');
  const $pathStrip = document.getElementById('active-path-strip');
  const $pathStripText = document.getElementById('path-strip-text');

  const $modalTrace = document.getElementById('modal-trace');
  const $modalBlueprints = document.getElementById('modal-blueprints');
  const $modalMcp = document.getElementById('modal-mcp-panel');

  // Search state
  let results = [];          // repos currently listed in the dropdown
  let activeIndex = -1;      // keyboard-highlighted row
  let activeNiche = null;    // niche being browsed
  let selectedRepo = null;

  const repoById = new Map(REPOS.map(r => [r.id, r]));
  const catById = new Map(CATEGORIES.map(c => [c.id, c]));

  function init() {
    searchEngine = new SearchEngine(REPOS, CATEGORIES, RELATIONSHIPS);
    graph = new GraphRenderer($canvas, REPOS, CATEGORIES, RELATIONSHIPS);

    $search.placeholder = `Search ${REPOS.length} repos by what you want to build…`;
    // Signature uses the same emblem as the signal
    document.getElementById('sig-bat-path')?.setAttribute('d', GraphRenderer.batSvgPath(64));

    bindGraph();
    bindSearch();
    bindDrawer();
    bindTracePath();
    bindBlueprints();
    bindMcp();
    bindModals();
    bindShortcuts();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const isMobile = () => window.innerWidth <= 720;

  // ── Graph callbacks ────────────────────────────────────
  function bindGraph() {
    graph.onHover = (node, cx, cy) => {
      if (!node) {
        $tooltip.classList.remove('visible');
        return;
      }
      if ($tooltip.dataset.id !== node.id) {
        $tooltip.dataset.id = node.id;
        $tooltip.innerHTML = `
          <div class="tooltip-title">${escapeHtml(node.name)}</div>
          <div class="tooltip-sub">★ ${SearchEngine.formatStars(node.stars)} • ${escapeHtml(catById.get(node.category)?.name || '')} • ${node.year}</div>
        `;
      }
      $tooltip.style.transform = `translate(${cx + 14}px, ${cy + 14}px)`;
      $tooltip.classList.add('visible');
    };

    graph.onSelect = node => {
      closeDropdown();
      if (node) openRepo(repoById.get(node.id), false);
      else closeDrawer();
    };
  }

  // ── Search ─────────────────────────────────────────────
  function bindSearch() {
    let debounce = null;

    $search.addEventListener('focus', () => renderDropdown());

    $search.addEventListener('input', () => {
      activeNiche = null;
      $clear.classList.toggle('hidden', !$search.value);
      clearTimeout(debounce);
      debounce = setTimeout(renderDropdown, 60);
    });

    $search.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!results.length) return;
        activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        updateActiveRow(true);
      } else if (e.key === 'Enter') {
        const repo = results[activeIndex >= 0 ? activeIndex : 0];
        if (repo) {
          openRepo(repo, true);
          closeDropdown();
          $search.blur();
        }
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        if ($search.value || activeNiche) clearSearch();
        else { closeDropdown(); $search.blur(); }
      }
    });

    $clear.addEventListener('click', () => {
      clearSearch();
      $search.focus();
    });

    // Clicking anywhere outside the search shell closes the dropdown (focus highlight stays)
    document.addEventListener('pointerdown', e => {
      if (!document.getElementById('search-shell').contains(e.target)) closeDropdown();
    });
  }

  function clearSearch() {
    $search.value = '';
    activeNiche = null;
    $clear.classList.add('hidden');
    graph.setFocus(null);
    renderDropdown();
  }

  function closeDropdown() {
    $dropdown.classList.add('hidden');
  }

  function renderDropdown() {
    const query = $search.value.trim();
    activeIndex = -1;

    if (activeNiche) {
      renderNiche(activeNiche);
      return;
    }

    if (!query) {
      results = [];
      graph.setFocus(null);
      const counts = {};
      REPOS.forEach(r => { counts[r.category] = (counts[r.category] || 0) + 1; });
      $dropdown.innerHTML = `
        <div class="dd-section">Browse by niche</div>
        <div class="niche-grid">
          ${CATEGORIES.map(c => `
            <button class="niche-chip" data-cat="${c.id}" title="${escapeHtml(c.desc)}">
              <span class="dd-dot" style="color:${c.color}"></span>
              <span>${escapeHtml(c.name)}</span>
              <span class="count">${counts[c.id] || 0}</span>
            </button>`).join('')}
        </div>
      `;
      $dropdown.querySelectorAll('.niche-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          activeNiche = btn.dataset.cat;
          renderNiche(activeNiche);
          const ids = REPOS.filter(r => r.category === activeNiche).map(r => r.id);
          graph.fitToNodes(ids, $dropdown.getBoundingClientRect().bottom + 10);
          $search.focus();
        });
      });
      $dropdown.classList.remove('hidden');
      return;
    }

    const found = searchEngine.search(query);
    results = found.map(f => f.repo);
    graph.setFocus(results.map(r => r.id));

    if (!results.length) {
      $dropdown.innerHTML = `<div class="dd-empty">Nothing for “${escapeHtml(query)}”. Try what you want to do: “redact pii”, “local llm”, “self-hosted crm”, “game engine”.</div>`;
      $dropdown.classList.remove('hidden');
      return;
    }

    renderList(`${results.length} matches`, found.map(f => ({ repo: f.repo, reason: f.matchReason })));
  }

  function renderNiche(catId) {
    const cat = catById.get(catId);
    results = REPOS.filter(r => r.category === catId).sort((a, b) => b.stars - a.stars);
    graph.setFocus(results.map(r => r.id));
    renderList(`${cat.name} · ${results.length} repos`, results.map(r => ({ repo: r })), true);
  }

  function renderList(title, rows, withBack) {
    $dropdown.innerHTML = `
      <div class="dd-section">${withBack ? '<a href="#" id="dd-back" style="color:inherit; text-decoration:none;">← niches</a> · ' : ''}${escapeHtml(title)}</div>
      ${rows.map(({ repo, reason }, i) => `
        <div class="dd-item" data-i="${i}">
          <span class="dd-dot" style="color:${catById.get(repo.category)?.color || '#fff'}"></span>
          <div class="dd-body">
            <div class="dd-title">${escapeHtml(repo.name)}<span class="dd-meta">${escapeHtml(repo.fullName)} · ${escapeHtml(catById.get(repo.category)?.name || '')}</span></div>
            <div class="dd-desc">${escapeHtml(reason && !reason.startsWith('Related') ? reason : repo.desc)}</div>
          </div>
          <span class="dd-stars">★ ${SearchEngine.formatStars(repo.stars)}</span>
        </div>`).join('')}
    `;

    $dropdown.querySelectorAll('.dd-item').forEach(el => {
      const repo = results[+el.dataset.i];
      el.addEventListener('click', () => {
        openRepo(repo, true);
        closeDropdown();
      });
      // Preview on the graph while moving through the list
      el.addEventListener('mouseenter', () => {
        activeIndex = +el.dataset.i;
        updateActiveRow(false);
      });
    });

    const back = document.getElementById('dd-back');
    if (back) back.addEventListener('click', e => {
      e.preventDefault();
      activeNiche = null;
      graph.setFocus(null);
      graph.resetView();
      renderDropdown();
      $search.focus();
    });

    $dropdown.classList.remove('hidden');
  }

  function updateActiveRow(scroll) {
    $dropdown.querySelectorAll('.dd-item').forEach(el => {
      const on = +el.dataset.i === activeIndex;
      el.classList.toggle('active', on);
      if (on && scroll) el.scrollIntoView({ block: 'nearest' });
    });
  }

  // ── Drawer ─────────────────────────────────────────────
  function bindDrawer() {
    document.getElementById('btn-close-drawer').addEventListener('click', closeDrawer);
    document.getElementById('btn-reset-view').addEventListener('click', () => {
      closeDrawer();
      clearPath();
      graph.resetView();
    });
  }

  function openRepo(repo, fly) {
    if (!repo) return;
    selectedRepo = repo;
    graph.setInsetRight(isMobile() ? 0 : DRAWER_W);
    graph.select(repo.id, true);
    if (fly) graph.flyToNode(repo.id);
    renderDrawer(repo);
    $drawer.classList.add('open');
    document.body.classList.add('drawer-open');
  }

  function closeDrawer() {
    selectedRepo = null;
    $drawer.classList.remove('open');
    document.body.classList.remove('drawer-open');
    graph.setInsetRight(0);
    graph.select(null, false);
  }

  function renderDrawer(repo) {
    const neighbors = [...(graph.adj.get(repo.id) || [])].map(id => {
      const rel = RELATIONSHIPS.find(r => (r.source === repo.id && r.target === id) || (r.target === repo.id && r.source === id));
      return { repo: repoById.get(id), type: rel ? rel.type : 'related' };
    }).filter(n => n.repo).sort((a, b) => b.repo.stars - a.repo.stars);

    const cat = catById.get(repo.category);
    $drawerContent.innerHTML = `
      <div class="drawer-category" style="color:${cat?.color || 'inherit'}">${escapeHtml(cat?.name || repo.category)}</div>
      <h2 class="drawer-title">${escapeHtml(repo.name)}</h2>
      <div class="drawer-full-name">${escapeHtml(repo.fullName)}${repo.archived ? ' · <span style="color:var(--c-salmon)">archived</span>' : ''}</div>

      <div class="drawer-metrics">
        <div class="metric-item">★ <span>${SearchEngine.formatStars(repo.stars)}</span></div>
        <div class="metric-item">LANG: <span>${escapeHtml(repo.language)}</span></div>
        <div class="metric-item">LIC: <span>${escapeHtml(repo.license)}</span></div>
        <div class="metric-item">SINCE: <span>${repo.year}</span></div>
      </div>

      <p class="drawer-desc">${escapeHtml(repo.desc)}</p>

      <div class="drawer-actions" style="margin-bottom:8px;">
        <a href="${repo.url}" target="_blank" rel="noopener" class="btn-minimal btn-primary">Open on GitHub ↗</a>
        <button class="btn-minimal" id="btn-copy-repo-clone">Copy clone command</button>
      </div>

      <div class="drawer-heading">Use it to</div>
      <ul class="drawer-use-cases">
        ${(repo.useCases || []).map(u => `<li>${escapeHtml(u)}</li>`).join('')}
      </ul>

      <div class="drawer-heading">Tags</div>
      <div class="drawer-tags">
        ${(repo.tags || []).map(t => `<span class="drawer-tag">#${escapeHtml(t)}</span>`).join('')}
      </div>

      <div class="drawer-heading">Connected repos (${neighbors.length})</div>
      <div class="drawer-connections">
        ${neighbors.length === 0 ? '<span style="font-size:11px; color:var(--text-dim)">No direct connections yet.</span>' : ''}
        ${neighbors.map(n => `
          <div class="drawer-conn-item" data-id="${n.repo.id}">
            <span style="font-weight:600;">${escapeHtml(n.repo.name)}</span>
            <span class="drawer-conn-type">${n.type}</span>
          </div>
        `).join('')}
      </div>
    `;
    $drawer.scrollTop = 0;

    $drawerContent.querySelectorAll('.drawer-conn-item').forEach(el => {
      el.addEventListener('click', () => openRepo(repoById.get(el.dataset.id), true));
      el.addEventListener('mouseenter', () => { graph.hoverId = el.dataset.id; graph.dirty = true; });
      el.addEventListener('mouseleave', () => { graph.hoverId = null; graph.dirty = true; });
    });

    const cloneBtn = document.getElementById('btn-copy-repo-clone');
    cloneBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(`git clone ${repo.url}.git`).then(() => {
        cloneBtn.textContent = 'Copied!';
        setTimeout(() => { cloneBtn.textContent = 'Copy clone command'; }, 1500);
      });
    });
  }

  // ── Route strip (Trace / Blueprints) ───────────────────
  function showPath(ids, label) {
    graph.setPath(ids);
    graph.fitToNodes(ids);
    $pathStripText.textContent = label;
    $pathStrip.classList.remove('hidden');
  }

  function clearPath() {
    graph.setPath(null);
    $pathStrip.classList.add('hidden');
  }

  // ── Trace Path ─────────────────────────────────────────
  function bindTracePath() {
    const sourceSel = document.getElementById('trace-source');
    const targetSel = document.getElementById('trace-target');
    const resultBox = document.getElementById('trace-result-box');
    const summaryElem = document.getElementById('trace-summary');
    const stepsList = document.getElementById('trace-steps-list');
    const applyBtn = document.getElementById('btn-apply-trace');
    let currentPath = null;

    document.getElementById('btn-trace').addEventListener('click', () => {
      const sorted = [...REPOS].sort((a, b) => a.name.localeCompare(b.name));
      const options = sorted.map(r => `<option value="${r.id}">${escapeHtml(r.name)} (${escapeHtml(catById.get(r.category)?.name || '')})</option>`).join('');
      sourceSel.innerHTML = options;
      targetSel.innerHTML = options;
      sourceSel.value = selectedRepo ? selectedRepo.id : 'ollama';
      targetSel.value = selectedRepo && selectedRepo.id !== 'nextjs' ? 'nextjs' : 'react';
      resultBox.classList.add('hidden');
      $modalTrace.classList.remove('hidden');
    });

    document.getElementById('btn-swap-trace').addEventListener('click', () => {
      const tmp = sourceSel.value;
      sourceSel.value = targetSel.value;
      targetSel.value = tmp;
    });

    document.getElementById('btn-run-trace').addEventListener('click', () => {
      const s = sourceSel.value, t = targetSel.value;
      resultBox.classList.remove('hidden');
      if (s === t) {
        summaryElem.textContent = 'Pick two different repositories.';
        stepsList.innerHTML = '';
        applyBtn.style.display = 'none';
        return;
      }
      currentPath = searchEngine.findPath(s, t);
      if (!currentPath) {
        summaryElem.textContent = 'No connection path between these repos yet.';
        stepsList.innerHTML = '';
        applyBtn.style.display = 'none';
        return;
      }
      applyBtn.style.display = 'inline-block';
      summaryElem.textContent = `${currentPath.distance} hops from ${currentPath.steps[0].repo.name} to ${currentPath.steps[currentPath.steps.length - 1].repo.name}`;
      stepsList.innerHTML = currentPath.steps.map((st, i) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 10px; background:rgba(255,255,255,0.03); border-radius:3px; font-size:11px;">
          <div>
            <span style="font-family:var(--font-mono); font-weight:600; color:var(--text-dim); margin-right:8px;">${String(i + 1).padStart(2, '0')}</span>
            <span style="color:var(--text-title); font-weight:600;">${escapeHtml(st.repo.name)}</span>
            <span style="font-size:10px; color:var(--text-dim); margin-left:6px;">(${escapeHtml(st.repo.language)})</span>
          </div>
          ${st.edgeType ? `<span style="font-family:var(--font-mono); font-size:9.5px; color:var(--c-amber)">${st.edgeType}</span>` : ''}
        </div>
      `).join('');
    });

    applyBtn.addEventListener('click', () => {
      if (!currentPath) return;
      $modalTrace.classList.add('hidden');
      closeDrawer();
      showPath(currentPath.path, currentPath.steps.map(s => s.repo.name).join(' → '));
    });

    document.getElementById('btn-close-path').addEventListener('click', clearPath);
  }

  // ── Blueprints ─────────────────────────────────────────
  function bindBlueprints() {
    const grid = document.getElementById('blueprints-grid');
    const detail = document.getElementById('blueprint-detail');
    const stepsElem = document.getElementById('blueprint-steps');
    let activeStack = null;

    document.getElementById('btn-blueprints').addEventListener('click', () => {
      grid.classList.remove('hidden');
      detail.classList.add('hidden');
      grid.innerHTML = CURATED_STACKS.map(st => `
        <div class="blueprint-card" data-id="${st.id}" style="padding:14px; background:rgba(255,255,255,0.03); border:1px solid var(--border-hairline); border-radius:6px; cursor:pointer;">
          <div style="font-size:18px; margin-bottom:4px;">${st.icon}</div>
          <div style="font-size:13px; font-weight:700; color:var(--text-title); margin-bottom:2px;">${escapeHtml(st.name)}</div>
          <div style="font-size:11px; color:var(--text-dim); line-height:1.4;">${escapeHtml(st.desc)}</div>
        </div>
      `).join('');

      grid.querySelectorAll('.blueprint-card').forEach(c => {
        c.addEventListener('click', () => {
          activeStack = CURATED_STACKS.find(s => s.id === c.dataset.id);
          grid.classList.add('hidden');
          detail.classList.remove('hidden');
          document.getElementById('blueprint-title').textContent = `${activeStack.icon} ${activeStack.name}`;
          document.getElementById('blueprint-desc').textContent = activeStack.desc;
          stepsElem.innerHTML = activeStack.steps.map((step, idx) => `
            <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:8px 12px; background:rgba(255,255,255,0.02); border-left:2px solid var(--c-amber); font-size:11.5px;">
              <div>
                <span style="font-size:9.5px; text-transform:uppercase; color:var(--text-dim); display:block;">Step ${idx + 1}: ${escapeHtml(step.role)}</span>
                <strong style="color:var(--text-title)">${escapeHtml(repoById.get(step.repoId)?.name || step.repoId)}</strong>
              </div>
              <span style="font-size:10.5px; color:var(--text-dim); text-align:right;">${escapeHtml(step.note)}</span>
            </div>
          `).join('');
        });
      });

      $modalBlueprints.classList.remove('hidden');
    });

    document.getElementById('btn-back-blueprints').addEventListener('click', () => {
      detail.classList.add('hidden');
      grid.classList.remove('hidden');
    });

    document.getElementById('btn-apply-blueprint').addEventListener('click', () => {
      if (!activeStack) return;
      $modalBlueprints.classList.add('hidden');
      closeDrawer();
      const ids = activeStack.steps.map(s => s.repoId);
      showPath(ids, `${activeStack.name}: ` + ids.map(id => repoById.get(id)?.name || id).join(' → '));
    });
  }

  // ── MCP console ────────────────────────────────────────
  function bindMcp() {
    const select = document.getElementById('mcp-select-tool');
    const inputs = document.getElementById('mcp-dynamic-inputs');
    const output = document.getElementById('mcp-raw-output');
    const repoOptions = sel => REPOS.map(r => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${r.id}</option>`).join('');

    function updateInputs(tool) {
      const current = selectedRepo ? selectedRepo.id : 'langchain';
      if (tool === 'search_repositories') {
        inputs.innerHTML = `<input type="text" id="mcp-in-query" class="modal-select" value="local vector search" placeholder="Query intent...">`;
      } else if (tool === 'get_repo_details') {
        inputs.innerHTML = `<select id="mcp-in-repo" class="modal-select">${repoOptions(current)}</select>`;
      } else if (tool === 'trace_connection_path') {
        inputs.innerHTML = `
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
            <select id="mcp-in-src" class="modal-select">${repoOptions(current)}</select>
            <select id="mcp-in-tgt" class="modal-select">${repoOptions('fastapi')}</select>
          </div>`;
      } else {
        inputs.innerHTML = '';
      }
    }

    document.getElementById('btn-mcp').addEventListener('click', () => {
      $modalMcp.classList.remove('hidden');
      updateInputs(select.value);
    });
    select.addEventListener('change', () => updateInputs(select.value));

    document.getElementById('btn-execute-mcp').addEventListener('click', () => {
      const tool = select.value;
      const args = {};
      if (tool === 'search_repositories') args.query = document.getElementById('mcp-in-query')?.value || '';
      else if (tool === 'get_repo_details') args.repo_id = document.getElementById('mcp-in-repo')?.value || '';
      else if (tool === 'trace_connection_path') {
        args.source_repo = document.getElementById('mcp-in-src')?.value || '';
        args.target_repo = document.getElementById('mcp-in-tgt')?.value || '';
      }
      output.textContent = JSON.stringify(searchEngine.executeMcpTool(tool, args), null, 2);
    });

    const flash = (btn, text) => {
      const old = btn.textContent;
      btn.textContent = text;
      setTimeout(() => { btn.textContent = old; }, 1400);
    };

    document.getElementById('btn-copy-mcp-raw').addEventListener('click', e => {
      navigator.clipboard.writeText(output.textContent).then(() => flash(e.target, 'Copied!'));
    });

    document.getElementById('btn-copy-mcp-server-config').addEventListener('click', e => {
      const conf = { mcpServers: { repoverse: { command: 'npx', args: ['-y', 'repoverse-mcp-server'] } } };
      navigator.clipboard.writeText(JSON.stringify(conf, null, 2)).then(() => flash(e.target, 'Copied!'));
    });

    document.getElementById('btn-export-mcp-json').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ categories: CATEGORIES, repos: REPOS, relationships: RELATIONSHIPS }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'repoverse_atlas.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }

  // ── Modals & keyboard ──────────────────────────────────
  function bindModals() {
    document.querySelectorAll('.modal-close-icon').forEach(btn => {
      btn.addEventListener('click', () => document.getElementById(btn.dataset.close)?.classList.add('hidden'));
    });
    document.querySelectorAll('.editorial-modal-backdrop').forEach(modal => {
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
    });
  }

  function bindShortcuts() {
    window.addEventListener('keydown', e => {
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        $search.focus();
        $search.select();
      } else if (e.key === 'Escape') {
        const openModal = [...document.querySelectorAll('.editorial-modal-backdrop')].find(m => !m.classList.contains('hidden'));
        if (openModal) openModal.classList.add('hidden');
        else if ($drawer.classList.contains('open')) closeDrawer();
        else if (!$pathStrip.classList.contains('hidden')) clearPath();
        else if ($search.value) clearSearch();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
