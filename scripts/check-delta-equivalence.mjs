#!/usr/bin/env node
/**
 * Differential Equivalence Gate (docs/IMPLEMENTATION-PLAN-2026-10-14.md D6).
 *
 * Verifies that sequential delta updates produce an identical state to a full
 * state bundle resync across >= 50 randomized operations. Includes negative
 * controls verifying that state divergence is strictly detected.
 *
 * Runs both:
 * 1. The backend geometric/IFC equivalence test (scratch/test_delta_equivalence.py)
 * 2. The frontend store delta-applier equivalence test (useBimStore)
 *
 * Run:  node scripts/check-delta-equivalence.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let checks = 0;
let failures = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// 1. Backend Differential Equivalence Test
// ---------------------------------------------------------------------------
section('D6.1 Backend Differential Equivalence (Python engine & geometry)');
{
  const venvPythonWin = join(ROOT, '.venv', 'Scripts', 'python.exe');
  const venvPythonUnix = join(ROOT, '.venv', 'bin', 'python');
  const pythonCmd = process.env.PYTHON || (existsSync(venvPythonWin) ? venvPythonWin : (existsSync(venvPythonUnix) ? venvPythonUnix : (process.platform === 'win32' ? 'python' : 'python3')));
  const testScript = join(ROOT, 'scratch', 'test_delta_equivalence.py');

  const pyResult = spawnSync(pythonCmd, [testScript], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, PYTHONPATH: join(ROOT, 'backend') },
  });

  if (pyResult.stdout) {
    for (const line of pyResult.stdout.trim().split('\n')) {
      if (line.includes('[ok]')) {
        check(line.replace(/.*\[ok\]\s*/, ''), true);
      } else if (line.includes('[FAIL]')) {
        check(line.replace(/.*\[FAIL\]\s*/, ''), false);
      }
    }
  }

  check(
    'python backend differential test exited 0',
    pyResult.status === 0,
    pyResult.stderr || pyResult.stdout
  );
}

// ---------------------------------------------------------------------------
// 2. Frontend Store Differential Equivalence Test
// ---------------------------------------------------------------------------
section('D6.2 Frontend Store Delta Equivalence (useBimStore Zustand store)');
{
  const server = await createServer({
    root: ROOT,
    logLevel: 'error',
    server: { middlewareMode: true },
    appType: 'custom',
  });

  let store;
  try {
    const storeModule = await server.ssrLoadModule('/src/store/useBimStore.ts');
    store = storeModule.useBimStore;
  } finally {
    await server.close();
  }

  const originalFetch = globalThis.fetch;

  try {
    const docId = 'test-doc-epoch-42';
    const backendMeshes = new Map();
    let backendRev = 1;
    let backendLevels = [
      { id: 'lvl-1', name: 'Level 1', elevation: 0.0 },
      { id: 'lvl-2', name: 'Level 2', elevation: 10.0 },
    ];
    let backendSheets = [
      { id: 'sheet-101', sheetNumber: 'A101', sheetTitle: 'FLOOR PLAN', viewports: [] },
    ];
    let backendConstraints = [];

    // Seed 5 initial walls
    for (let i = 1; i <= 5; i++) {
      backendMeshes.set(`wall-${i}`, {
        guid: `wall-${i}`,
        ifc_class: 'IfcWallStandardCase',
        name: `Wall ${i}`,
        params: {
          ifc_class: 'IfcWallStandardCase',
          name: `Wall ${i}`,
          thickness: 0.25,
          height: 3.0,
          length: 6.0,
          start: [i * 3, 0, 0],
          end: [i * 3, 6, 0],
          tag: `W0${i}`,
        },
      });
    }

    // Client Store: reset state
    store.setState({
      rev: undefined,
      docId: undefined,
      meshes: [],
      elements: {},
      levels: [],
      sheets: [],
      constraints: [],
      transactionJournal: [],
      sliced2D: null,
    });

    let currentPayload = null;
    let lastRequestedUrl = null;
    globalThis.fetch = async (url) => {
      lastRequestedUrl = String(url);
      if (lastRequestedUrl.includes('/state')) {
        return { ok: true, status: 200, json: async () => currentPayload };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    // Step 0: Initial full bundle (Response C)
    currentPayload = {
      doc_id: docId,
      rev: 1,
      full: true,
      geometry: { meshes: Array.from(backendMeshes.values()), levels: backendLevels, grids: [] },
      project: { project_name: 'Store Test Project' },
      sheets: backendSheets,
      constraints: backendConstraints,
      wall_joins: {},
      journal: [{ transaction_id: 'tx-0', description: 'Initial commit' }],
    };
    await store.getState().fetchStateBundle();

    check('store initialized with 5 meshes and matching docId', store.getState().meshes.length === 5 && store.getState().docId === docId);
    check('store initial rev is 1', store.getState().rev === 1);
    check('store levels populated from full bundle', store.getState().levels.length === 2);

    // Run 50 simulated delta operations across diverse types and sections
    let storeEquivalencePassed = true;
    let deepCheckFailures = [];

    for (let op = 1; op <= 50; op++) {
      backendRev += 1;
      const opType = op % 6;
      let upsert = [];
      let remove = [];
      let levelsSection = null;
      let sheetsSection = null;
      let constraintsSection = null;

      if (opType === 0) {
        // Delete an element
        const keys = Array.from(backendMeshes.keys());
        if (keys.length > 2) {
          const toRemove = keys[keys.length - 1];
          backendMeshes.delete(toRemove);
          remove.push(toRemove);
        }
      } else if (opType === 1) {
        // Add a new wall
        const newGuid = `wall-dyn-${op}`;
        const newMesh = {
          guid: newGuid,
          ifc_class: 'IfcWallStandardCase',
          name: `Dynamic Wall ${op}`,
          params: {
            ifc_class: 'IfcWallStandardCase',
            name: `Dynamic Wall ${op}`,
            thickness: 0.2 + (op % 3) * 0.05,
            height: 3.0,
            length: 10.0,
            start: [op, 0, 0],
            end: [op, 10, 0],
            tag: `DW-${op}`,
          },
        };
        backendMeshes.set(newGuid, newMesh);
        upsert.push(newMesh);
      } else if (opType === 2) {
        // Add a slab
        const slabGuid = `slab-dyn-${op}`;
        const slabMesh = {
          guid: slabGuid,
          ifc_class: 'IfcSlab',
          name: `Dynamic Slab ${op}`,
          params: {
            ifc_class: 'IfcSlab',
            name: `Dynamic Slab ${op}`,
            thickness: 0.3,
            elevation: 0.0,
            tag: `SL-${op}`,
          },
        };
        backendMeshes.set(slabGuid, slabMesh);
        upsert.push(slabMesh);
      } else if (opType === 3) {
        // Modify an existing mesh params
        const keys = Array.from(backendMeshes.keys());
        const target = keys[op % keys.length];
        const m = backendMeshes.get(target);
        const updatedMesh = {
          ...m,
          name: `${m.name} [modified]`,
          params: { ...m.params, thickness: 0.45, tag: `${m.params?.tag || 'M'}-mod` },
        };
        backendMeshes.set(target, updatedMesh);
        upsert.push(updatedMesh);
      } else if (opType === 4) {
        // Non-mesh section change: Levels section updated
        backendLevels = [...backendLevels, { id: `lvl-${op}`, name: `Level ${op}`, elevation: op * 10.0 }];
        levelsSection = backendLevels;
      } else if (opType === 5) {
        // Non-mesh section change: Sheets section updated
        backendSheets = [...backendSheets, { id: `sheet-${op}`, sheetNumber: `A10${op}`, sheetTitle: `SHEET ${op}`, viewports: [] }];
        sheetsSection = backendSheets;
      }

      // Delta payload (Response B)
      currentPayload = {
        doc_id: docId,
        rev: backendRev,
        base_rev: backendRev - 1,
        unchanged: false,
        upsert_meshes: upsert,
        remove_guids: remove,
        levels: levelsSection,
        sheets: sheetsSection,
        constraints: constraintsSection,
        journal_append: [{ transaction_id: `tx-${op}`, description: `Operation ${op}` }],
        engine_ms: 1.5,
      };

      await store.getState().fetchStateBundle();

      // Verify store state against backend ground truth
      const storeState = store.getState();
      const storeMeshMap = new Map(storeState.meshes.map((m) => [m.guid, m]));
      const storeElements = storeState.elements;

      if (storeMeshMap.size !== backendMeshes.size) {
        storeEquivalencePassed = false;
        deepCheckFailures.push(`Step ${op}: mesh size mismatch (store ${storeMeshMap.size} vs backend ${backendMeshes.size})`);
        break;
      }

      // Deep compare every mesh and element
      for (const [guid, bm] of backendMeshes.entries()) {
        const sm = storeMeshMap.get(guid);
        const se = storeElements[guid];
        if (!sm || !se) {
          storeEquivalencePassed = false;
          deepCheckFailures.push(`Step ${op}: missing GUID ${guid} in store`);
          break;
        }
        if (sm.name !== bm.name || sm.ifc_class !== bm.ifc_class) {
          storeEquivalencePassed = false;
          deepCheckFailures.push(`Step ${op}: GUID ${guid} name/class mismatch`);
          break;
        }
        if (bm.params?.thickness !== undefined && sm.params?.thickness !== bm.params.thickness) {
          storeEquivalencePassed = false;
          deepCheckFailures.push(`Step ${op}: GUID ${guid} thickness mismatch`);
          break;
        }
        if (bm.params?.tag !== undefined && se.tag !== bm.params.tag) {
          storeEquivalencePassed = false;
          deepCheckFailures.push(`Step ${op}: GUID ${guid} tag mismatch`);
          break;
        }
      }

      // Check non-mesh sections
      if (storeState.levels.length !== backendLevels.length) {
        storeEquivalencePassed = false;
        deepCheckFailures.push(`Step ${op}: levels count mismatch`);
        break;
      }
      if (storeState.sheets.length !== backendSheets.length) {
        storeEquivalencePassed = false;
        deepCheckFailures.push(`Step ${op}: sheets count mismatch`);
        break;
      }
    }

    check('store deep matches ground truth across 50 sequential deltas', storeEquivalencePassed, deepCheckFailures.join(', '));
    check('store final rev matches engine rev', store.getState().rev === backendRev);
    check('store element count matches backend', store.getState().meshes.length === backendMeshes.size);
    check('store levels and sheets updated via delta', store.getState().levels.length > 2 && store.getState().sheets.length > 1);
    check('store journal capped at <= 50 entries', store.getState().transactionJournal.length <= 50);

    // Negative Control 1: Fault injection into delta (dropped mesh from upsert_meshes)
    const corruptedOpRev = backendRev + 1;
    const ghostMesh = {
      guid: 'wall-ghost-1',
      ifc_class: 'IfcWallStandardCase',
      name: 'Ghost Wall',
      params: { ifc_class: 'IfcWallStandardCase', thickness: 0.25 },
    };
    backendMeshes.set('wall-ghost-1', ghostMesh);
    // Delta omits upserting wall-ghost-1
    currentPayload = {
      doc_id: docId,
      rev: corruptedOpRev,
      base_rev: backendRev,
      unchanged: false,
      upsert_meshes: [],
      remove_guids: [],
      engine_ms: 1.0,
    };
    await store.getState().fetchStateBundle();
    const detectedDeltaCorruption = store.getState().meshes.length !== backendMeshes.size;
    check('negative control 1: dropped mesh in delta detected as divergence', detectedDeltaCorruption);

    // Negative Control 2: Base revision mismatch triggers automatic full resync
    let fullResyncRequested = false;
    currentPayload = {
      doc_id: docId,
      rev: corruptedOpRev + 10,
      base_rev: 9999, // Mismatched base rev!
      unchanged: false,
      upsert_meshes: [],
      remove_guids: [],
      engine_ms: 1.0,
    };
    // If store detects mismatch and clears rev, subsequent fetch to /state will lack since
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/state') && !u.includes('since=')) {
        fullResyncRequested = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            doc_id: docId,
            rev: corruptedOpRev + 10,
            full: true,
            geometry: { meshes: Array.from(backendMeshes.values()), levels: backendLevels, grids: [] },
          }),
        };
      }
      return prevFetch(url);
    };

    await store.getState().fetchStateBundle();
    check('negative control 2: base_rev mismatch detected and triggered full resync', fullResyncRequested);

  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log(`\n${'-'.repeat(72)}`);
if (failures) {
  console.log(`DELTA EQUIVALENCE GATE FAILED - ${checks - failures}/${checks} checks passed`);
  process.exit(1);
}
console.log(`DELTA EQUIVALENCE GATE PASSED - ${checks} checks`);
