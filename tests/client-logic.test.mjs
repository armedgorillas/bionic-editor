import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Compile pure TS helpers via tsx in a quick ESM import check (using node --import tsx or esbuild)
// We can run a tiny node child with tsx so we test the exact client TypeScript modules directly!
const ROOT = path.resolve(import.meta.dirname, '..');

test('Client Pure Logic Unit Tests (Explorer Filter & Resizable Layout)', async (t) => {
  await t.test('filterAndSortTree keeps plans/, code/, src/, data/, figures/, web-report/ visible while filtering dot-items and aux coding files', () => {
    const script = `
      import assert from 'node:assert/strict';
      import { filterAndSortTree } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'client/src/components/Explorer/filterTree.ts')).href)};

      const sampleTree = [
        { name: '.bionic', path: '.bionic', isDirectory: true, isDotItem: true, category: 'config', children: [
          { name: 'config.json', path: '.bionic/config.json', isDirectory: false, isDotItem: false, category: 'config' }
        ]},
        { name: '.gitignore', path: '.gitignore', isDirectory: false, isDotItem: true, category: 'config' },
        { name: 'requirements.txt', path: 'requirements.txt', isDirectory: false, isDotItem: false, category: 'config' },
        { name: 'tests', path: 'tests', isDirectory: true, isDotItem: false, category: 'aux-code', children: [
          { name: 'test_panel_1.py', path: 'tests/test_panel_1.py', isDirectory: false, category: 'aux-code' }
        ]},
        { name: 'code', path: 'code', isDirectory: true, isDotItem: false, category: 'code', children: [
          { name: 'analyze.py', path: 'code/analyze.py', isDirectory: false, extension: '.py', category: 'code' }
        ]},
        { name: 'plans', path: 'plans', isDirectory: true, isDotItem: false, category: 'plan', children: [
          { name: 'panel_1.md', path: 'plans/panel_1.md', isDirectory: false, extension: '.md', category: 'plan' }
        ]},
        { name: 'data', path: 'data', isDirectory: true, isDotItem: false, category: 'data', children: [
          { name: 'manifest.json', path: 'data/manifest.json', isDirectory: false, extension: '.json', category: 'config' },
          { name: 'DATA_MANIFEST.md', path: 'data/DATA_MANIFEST.md', isDirectory: false, extension: '.md', category: 'document' }
        ]},
        { name: 'web-report', path: 'web-report', isDirectory: true, isDotItem: false, category: 'report', children: [] },
        { name: 'NOTES.md', path: 'NOTES.md', isDirectory: false, extension: '.md', category: 'document' },
        { name: 'SPEC.md', path: 'SPEC.md', isDirectory: false, extension: '.md', category: 'document' }
      ];

      // Default Scientist View: hide dot-items & aux coding files, pin docs first
      const def = filterAndSortTree(sampleTree, {
        showDotItems: false,
        showAuxCodingFiles: false,
        documentsFirst: true,
        projectRootFile: 'SPEC.md'
      });

      const names = def.visibleTree.map(i => i.name);
      assert.equal(names[0], 'SPEC.md', 'Project Root File pinned first');
      assert.equal(names[1], 'NOTES.md', 'Other .md documents follow');
      assert.ok(names.includes('code'), 'code/ always visible');
      assert.ok(names.includes('plans'), 'plans/ always visible');
      assert.ok(names.includes('data'), 'data/ always visible');
      assert.ok(names.includes('web-report'), 'web-report/ always visible');
      assert.equal(names.includes('.bionic'), false, 'dot-folder hidden by default');
      assert.equal(names.includes('.gitignore'), false, 'dotfile hidden by default');
      assert.equal(names.includes('requirements.txt'), false, 'aux config hidden by default');
      assert.equal(names.includes('tests'), false, 'aux tests/ hidden by default');

      // Inside data/, manifest.json is hidden in Scientist View while DATA_MANIFEST.md is visible
      const dataNode = def.visibleTree.find(i => i.name === 'data');
      assert.equal(dataNode.children.some(c => c.name === 'manifest.json'), false);
      assert.equal(dataNode.children.some(c => c.name === 'DATA_MANIFEST.md'), true);
      assert.ok(def.hiddenCount > 0);

      // Toggling showDotItems reveals .bionic and .gitignore while keeping aux coding hidden
      const withDots = filterAndSortTree(sampleTree, {
        showDotItems: true,
        showAuxCodingFiles: false,
        documentsFirst: true,
        projectRootFile: 'SPEC.md'
      });
      assert.ok(withDots.visibleTree.some(i => i.name === '.bionic'));
      assert.ok(withDots.visibleTree.some(i => i.name === '.gitignore'));
      assert.equal(withDots.visibleTree.some(i => i.name === 'tests'), false);

      // Coding Mode reveals aux coding & data/manifest.json
      const coding = filterAndSortTree(sampleTree, {
        showDotItems: false,
        showAuxCodingFiles: true,
        documentsFirst: true,
        projectRootFile: 'SPEC.md'
      });
      assert.ok(coding.visibleTree.some(i => i.name === 'tests'));
      assert.ok(coding.visibleTree.some(i => i.name === 'requirements.txt'));
      assert.equal(coding.visibleTree.some(i => i.name === '.bionic'), false, 'dot-folders remain independent of Coding Mode');
      const codingData = coding.visibleTree.find(i => i.name === 'data');
      assert.equal(codingData.children.some(c => c.name === 'manifest.json'), true);
    `;
    execFileSync('npx', ['tsx', '-e', script], { cwd: ROOT, stdio: 'pipe' });
  });

  await t.test('clampLayoutWidths enforces bounds and auto-collapses left sidebar on narrow viewports', () => {
    const script = `
      import assert from 'node:assert/strict';
      import { clampLayoutWidths, DEFAULT_LAYOUT, MIN_CENTER_WIDTH } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'client/src/hooks/useResizableLayout.ts')).href)};

      // Normal desktop width preserves requested sizes
      const wide = clampLayoutWidths(1440, { ...DEFAULT_LAYOUT, leftWidth: 300, rightWidth: 450 });
      assert.equal(wide.leftWidth, 300);
      assert.equal(wide.rightWidth, 450);
      assert.equal(wide.leftCollapsed, false);

      // Narrow viewport (< 820px) auto-collapses left sidebar and leaves >= MIN_CENTER_WIDTH
      const narrow = clampLayoutWidths(760, { ...DEFAULT_LAYOUT, leftWidth: 260, rightWidth: 420 });
      assert.equal(narrow.leftCollapsed, true);
      assert.ok(760 - narrow.rightWidth >= MIN_CENTER_WIDTH);

      // Medium viewport (900px) with oversized sidebars clamps cleanly so center >= MIN_CENTER_WIDTH
      const medium = clampLayoutWidths(900, { ...DEFAULT_LAYOUT, leftWidth: 420, rightWidth: 500 });
      assert.ok(900 - medium.leftWidth - medium.rightWidth >= MIN_CENTER_WIDTH);
    `;
    execFileSync('npx', ['tsx', '-e', script], { cwd: ROOT, stdio: 'pipe' });
  });
});
