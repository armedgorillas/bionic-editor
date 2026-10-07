/**
 * SCimilarity Visualization Engine
 * Implements Figure 3 (3b, 3c, 3d) from Heimberg et al. (2024)
 * Art-Inspired Theme: Vincent van Gogh's "The Starry Night"
 */

// Global State
let umapData = null;
let concordanceData = null;
let metadata = null;
let testResults = null;
let currentHighlight = ''; // Currently highlighted cell type ('' = all)

/**
 * Loads all four JSON data files in parallel
 */
async function loadData() {
  try {
    const [umapRes, concRes, metaRes, testRes] = await Promise.all([
      fetch('data/umap_data.json').then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching umap_data.json`);
        return r.json();
      }),
      fetch('data/concordance_matrix.json').then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching concordance_matrix.json`);
        return r.json();
      }),
      fetch('data/metadata.json').then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching metadata.json`);
        return r.json();
      }),
      fetch('data/test_results.json').then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching test_results.json`);
        return r.json();
      })
    ]);

    umapData = umapRes;
    concordanceData = concRes;
    metadata = metaRes;
    testResults = testRes;

    return true;
  } catch (err) {
    console.error("Failed to load pipeline data:", err);
    const errContainer = document.getElementById('error-banner');
    if (errContainer) {
      errContainer.style.display = 'block';
      errContainer.innerHTML = `<strong>Data Loading Alert:</strong> ${err.message}. Ensure mock data scripts have been run.`;
    }
    return false;
  }
}

/**
 * Populates controls: highlight dropdown and stats badges
 */
function setupControls() {
  const select = document.getElementById('highlightCellType');
  if (select && metadata && metadata.cell_types) {
    select.innerHTML = '<option value="">All Cell Types</option>';
    metadata.cell_types.forEach(ct => {
      const opt = document.createElement('option');
      opt.value = ct;
      opt.textContent = ct;
      select.appendChild(opt);
    });

    select.addEventListener('change', (e) => {
      currentHighlight = e.target.value;
      updateUMAPMarkers();
    });
  }

  const pointSlider = document.getElementById('pointSize');
  const pointDisplay = document.getElementById('pointSizeVal');
  if (pointSlider) {
    pointSlider.addEventListener('input', (e) => {
      if (pointDisplay) pointDisplay.textContent = e.target.value;
      updateUMAPMarkers();
    });
  }

  const opacitySlider = document.getElementById('opacity');
  const opacityDisplay = document.getElementById('opacityVal');
  if (opacitySlider) {
    opacitySlider.addEventListener('input', (e) => {
      if (opacityDisplay) opacityDisplay.textContent = e.target.value;
      updateUMAPMarkers();
    });
  }

  // Update cell counts in header stats
  if (metadata && metadata.global_stats) {
    const totalEl = document.getElementById('stat-total-cells');
    const concordEl = document.getElementById('stat-concordance');
    const typesEl = document.getElementById('stat-num-types');
    if (totalEl) totalEl.textContent = metadata.global_stats.total_cells.toLocaleString();
    if (concordEl) concordEl.textContent = `${metadata.global_stats.concordance_rate}%`;
    if (typesEl) typesEl.textContent = metadata.global_stats.num_cell_types;
  }
}

/**
 * Creates UMAP scatter plot for Author or Predicted annotations
 * Creates one trace per cell type to allow Plotly legend toggling.
 */
function createUMAPPlot(containerId, labelType) {
  const container = document.getElementById(containerId);
  if (!container || !umapData || !metadata) return;

  const isAuthor = (labelType === 'author');
  const xCoords = isAuthor ? umapData.x_author : umapData.x_scim;
  const yCoords = isAuthor ? umapData.y_author : umapData.y_scim;
  const labelIndices = isAuthor ? umapData.author_label_idx : umapData.pred_label_idx;
  const cellTypes = metadata.cell_types;
  const colorMap = metadata.color_map;

  const pointSize = parseFloat(document.getElementById('pointSize')?.value || 4);
  const baseOpacity = parseFloat(document.getElementById('opacity')?.value || 0.7);

  // Group coordinates by cell type index
  const traces = cellTypes.map((cellTypeName, idx) => {
    const xs = [];
    const ys = [];
    const text = [];
    const customData = [];

    for (let i = 0; i < labelIndices.length; i++) {
      if (labelIndices[i] === idx) {
        xs.push(xCoords[i]);
        ys.push(yCoords[i]);
        const id = umapData.cell_id[i];
        const authName = cellTypes[umapData.author_label_idx[i]];
        const predName = cellTypes[umapData.pred_label_idx[i]];
        text.push(`Cell ID: ${id}<br>Author: ${authName}<br>Predicted: ${predName}`);
        customData.push(id);
      }
    }

    const color = colorMap[cellTypeName] || '#333333';
    let traceOpacity = baseOpacity;
    if (currentHighlight !== '') {
      traceOpacity = (cellTypeName === currentHighlight) ? 0.95 : 0.15;
    }

    return {
      name: cellTypeName,
      x: xs,
      y: ys,
      text: text,
      mode: 'markers',
      type: 'scattergl',
      hoverinfo: 'text',
      marker: {
        size: pointSize,
        color: color,
        opacity: traceOpacity,
        line: { width: 0 }
      }
    };
  });

  const layout = {
    title: {
      text: isAuthor 
        ? '<b>Figure 3b</b>: Author Annotations (Ground Truth)' 
        : '<b>Figure 3c</b>: SCimilarity Predictions (Atlas Model)',
      font: { family: 'inherit', size: 14, color: '#1a2639' }
    },
    xaxis: {
      title: 'UMAP_1',
      showgrid: true,
      gridcolor: '#e2e8f0',
      zerolinecolor: '#cbd5e1'
    },
    yaxis: {
      title: 'UMAP_2',
      showgrid: true,
      gridcolor: '#e2e8f0',
      zerolinecolor: '#cbd5e1'
    },
    margin: { l: 50, r: 25, t: 45, b: 45 },
    legend: {
      orientation: 'h',
      x: 0,
      y: -0.2,
      font: { size: 10 }
    },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: '#f8fafc',
    hovermode: 'closest'
  };

  const config = {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d']
  };

  Plotly.newPlot(containerId, traces, layout, config);
}

/**
 * Updates marker sizes and opacities across both UMAP scatter plots without full re-render
 */
function updateUMAPMarkers() {
  const pointSize = parseFloat(document.getElementById('pointSize')?.value || 4);
  const baseOpacity = parseFloat(document.getElementById('opacity')?.value || 0.7);

  ['umap-author', 'umap-predicted'].forEach(containerId => {
    const el = document.getElementById(containerId);
    if (!el || !el.data) return;

    el.data.forEach((trace, traceIdx) => {
      let traceOpacity = baseOpacity;
      if (currentHighlight !== '') {
        traceOpacity = (trace.name === currentHighlight) ? 0.95 : 0.15;
      }
      Plotly.restyle(containerId, {
        'marker.size': pointSize,
        'marker.opacity': traceOpacity
      }, [traceIdx]);
    });
  });
}

/**
 * Creates Concordance Heatmap (Figure 3d)
 * Rows = Predicted Types, Columns = Author Types
 */
function createConcordanceHeatmap(containerId) {
  const container = document.getElementById(containerId);
  if (!container || !concordanceData) return;

  const { values, author_labels, pred_labels } = concordanceData;

  // Van Gogh "Starry Night" inspired heatmap colorscale:
  // Deep Prussian Blue (0%) -> Ultramarine -> Gold/Yellow (100%)
  const starryNightHeatmapScale = [
    [0.0, '#0f172a'],
    [0.2, '#1e3a8a'],
    [0.5, '#0284c7'],
    [0.8, '#f59e0b'],
    [1.0, '#fef08a']
  ];

  // Annotations for text inside cells
  const annotations = [];
  for (let i = 0; i < pred_labels.length; i++) {
    for (let j = 0; j < author_labels.length; j++) {
      const val = values[i][j];
      const textColor = val > 50 ? '#0f172a' : '#f8fafc';
      annotations.push({
        x: author_labels[j],
        y: pred_labels[i],
        text: `<b>${val}%</b>`,
        font: { family: 'inherit', size: 12, color: textColor },
        showarrow: false
      });
    }
  }

  const data = [{
    z: values,
    x: author_labels,
    y: pred_labels,
    type: 'heatmap',
    colorscale: starryNightHeatmapScale,
    colorbar: {
      title: 'Concordance (%)',
      titleside: 'right',
      len: 0.9
    },
    hoverongaps: false,
    hovertemplate: 'Author: %{x}<br>Predicted: %{y}<br>Agreement: %{z}%<extra></extra>'
  }];

  const layout = {
    title: {
      text: '<b>Figure 3d</b>: Cell Type Concordance Matrix (Rows = Predicted, Columns = Author)',
      font: { family: 'inherit', size: 15, color: '#1a2639' }
    },
    xaxis: {
      title: '<b>Author-Annotated Cell Types (Ground Truth)</b>',
      tickangle: -25
    },
    yaxis: {
      title: '<b>SCimilarity Predicted Cell Types</b>',
      autorange: 'reversed'
    },
    annotations: annotations,
    margin: { l: 180, r: 60, t: 50, b: 100 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: '#f8fafc'
  };

  const config = {
    responsive: true,
    displayModeBar: true,
    displaylogo: false
  };

  Plotly.newPlot(containerId, data, layout, config);
}

/**
 * Renders scientific validation test results table
 */
function renderTestResultsTable(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!testResults || !testResults.length) {
    container.innerHTML = '<p class="text-muted">No validation test results available.</p>';
    return;
  }

  let html = `
    <table class="report-table">
      <thead>
        <tr>
          <th>Test Name</th>
          <th>Status / Score</th>
          <th>Commentary & Scientific Notes</th>
        </tr>
      </thead>
      <tbody>
  `;

  testResults.forEach(test => {
    const isPass = (test.score === 1);
    const badgeClass = isPass ? 'badge-pass' : 'badge-fail';
    const statusText = isPass ? 'PASSED (1.0)' : `FAILED (${test.score})`;
    html += `
      <tr>
        <td><strong>${escapeHtml(test.test_name)}</strong></td>
        <td><span class="badge ${badgeClass}">${statusText}</span></td>
        <td>${escapeHtml(test.comment)}</td>
      </tr>
    `;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
}

/**
 * Renders the site tree of available markdown documents and wires up clicks
 */
async function renderSiteTree(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let docs = [];
  try {
    const res = await fetch('markdown/manifest.json');
    if (res.ok) {
      docs = await res.json();
    }
  } catch (e) {
    console.warn("Could not fetch markdown manifest, falling back to defaults", e);
  }

  if (!docs.length) {
    docs = [
      { name: "SPEC.md", title: "Project Specification (SPEC.md)", path: "markdown/SPEC.md" },
      { name: "overview.md", title: "Case Study Overview", path: "markdown/overview.md" }
    ];
  }

  let html = '<ul class="site-tree-list">';
  docs.forEach((doc, idx) => {
    const activeClass = (idx === 0) ? 'active' : '';
    html += `
      <li class="site-tree-item ${activeClass}" data-path="${escapeHtml(doc.path)}">
        <span class="tree-icon">📄</span>
        <span class="tree-title">${escapeHtml(doc.title || doc.name)}</span>
        <a class="download-link" href="${escapeHtml(doc.path)}" download title="Download raw file">⬇ Raw</a>
      </li>
    `;
  });
  html += '</ul>';
  container.innerHTML = html;

  // Add click handlers
  const items = container.querySelectorAll('.site-tree-item');
  items.forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('download-link')) return; // let default download happen
      items.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const docPath = item.getAttribute('data-path');
      loadAndRenderDocument(docPath);
    });
  });

  // Load the first document by default into doc-viewer
  if (docs.length > 0) {
    loadAndRenderDocument(docs[0].path);
  }
}

/**
 * Fetches and renders a markdown document inside #doc-viewer
 */
async function loadAndRenderDocument(docPath) {
  const viewer = document.getElementById('doc-viewer');
  if (!viewer) return;

  viewer.innerHTML = '<div class="loading-spinner">Loading document...</div>';

  try {
    const res = await fetch(docPath);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${docPath}`);
    const mdText = await res.text();
    viewer.innerHTML = renderMarkdownToHTML(mdText);
  } catch (err) {
    viewer.innerHTML = `
      <div class="doc-error">
        <h4>Error Loading Document</h4>
        <p>${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

/**
 * Renders markdown text into semantic HTML with robust formatting
 */
function renderMarkdownToHTML(md) {
  if (typeof window.marked !== 'undefined' && typeof window.marked.parse === 'function') {
    return window.marked.parse(md);
  }

  // Pure JavaScript markdown fallback renderer
  let html = md;
  // Code blocks ```...```
  html = html.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/gm, (match, lang, code) => {
    return `<pre><code class="language-${lang}">${escapeHtml(code.trim())}</code></pre>`;
  });
  // Inline code `...`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Headers
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  // Blockquotes
  html = html.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');
  // Bold & Italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/<((?:https?|mailto):[^>]+)>/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  // Unordered list items
  html = html.replace(/^\- (.*$)/gim, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
  // Paragraphs
  const paragraphs = html.split(/\n{2,}/);
  html = paragraphs.map(p => {
    p = p.trim();
    if (!p) return '';
    if (p.startsWith('<h') || p.startsWith('<pre') || p.startsWith('<ul') || p.startsWith('<blockquote') || p.startsWith('<table')) {
      return p;
    }
    return `<p>${p.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return html;
}

/**
 * Renders Group Info & Metadata
 */
function renderGroupInfo(containerId) {
  const container = document.getElementById(containerId);
  if (!container || !metadata) return;

  const membersList = (metadata.members || []).map(m => `<li><strong>${escapeHtml(m)}</strong></li>`).join('');

  container.innerHTML = `
    <div class="group-info-card">
      <div class="info-item">
        <span class="info-label">Group Name:</span>
        <span class="info-value group-name-badge">${escapeHtml(metadata.group_name || 'SCimilarity Research Consortium')}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Project Theme:</span>
        <span class="info-value">${escapeHtml(metadata.artwork_theme || 'The Starry Night (Vincent van Gogh)')}</span>
      </div>
      <div class="info-item full-row">
        <span class="info-label">Members:</span>
        <ul class="members-list">
          ${membersList}
        </ul>
      </div>
    </div>
  `;
}

/**
 * Automatically scans page headings and populates sidebar table of contents
 */
function generateTOC(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const headings = document.querySelectorAll('main h2[id], main h3[id]');
  if (!headings.length) {
    container.innerHTML = '<p class="toc-empty">No sections found.</p>';
    return;
  }

  let html = '<ul class="toc-list">';
  headings.forEach(heading => {
    const level = heading.tagName.toLowerCase();
    const text = heading.textContent.replace(/^[0-9.]+\s*/, '').trim();
    const id = heading.id;
    html += `
      <li class="toc-item toc-${level}">
        <a href="#${id}">${escapeHtml(text)}</a>
      </li>
    `;
  });
  html += '</ul>';
  container.innerHTML = html;
}

/**
 * Helper to escape HTML characters
 */
function escapeHtml(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Main Initialization Sequence
 */
async function init() {
  const loaded = await loadData();
  if (!loaded) return;

  setupControls();
  createUMAPPlot('umap-author', 'author');
  createUMAPPlot('umap-predicted', 'predicted');
  createConcordanceHeatmap('concordance-heatmap');
  renderTestResultsTable('test-results-table');
  renderSiteTree('site-tree');
  renderGroupInfo('group-info');
  generateTOC('sidebar-toc');

  // Handle window resizing for responsive Plotly charts
  window.addEventListener('resize', () => {
    const plots = ['umap-author', 'umap-predicted', 'concordance-heatmap'];
    plots.forEach(id => {
      const el = document.getElementById(id);
      if (el && el.data) {
        Plotly.Plots.resize(el);
      }
    });
  });
}

// Kick off when DOM is ready
document.addEventListener('DOMContentLoaded', init);
