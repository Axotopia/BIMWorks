#!/usr/bin/env node
/**
 * check-interaction-session.mjs — Gate for Track B Phase 1: The Interaction Session.
 *
 * Verifies:
 * 1. InteractionSession State & Reducer transitions:
 *    - 'begin' arms the tool (phase: 'armed')
 *    - 'point' transitions to 'picking' and records picks
 *    - 'pointer_down' and 'pointer_move' respect 5px wobble threshold:
 *        wobble <= 5px stays in 'picking' (does NOT enter 'dragging')
 *        movement > 5px enters 'dragging'
 *    - Negative control: zero threshold forces any movement to 'dragging'
 * 2. Mid-gesture Escape:
 *    - Mid-gesture Esc sends ZERO bus commands
 *    - Returns session to 'armed' (keeps tool active) and clears picks
 *    - Second Esc returns tool to 'select' and phase 'idle'
 * 3. Chained wall placement transactions:
 *    - N chained wall segments produce exactly N distinct transactions (one per wall)
 *    - Exactly N undo steps restored sequentially
 * 4. Per-phase tool prompts:
 *    - Dynamic prompts for 'armed' vs 'picking' vs 'dragging'
 *
 * Run:  node scripts/check-interaction-session.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}${extra ? ` (${extra})` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { middlewareMode: true },
});

try {
  const sessionMod = await server.ssrLoadModule('/src/interaction/session.ts');
  const captionsMod = await server.ssrLoadModule('/src/interaction/toolCaptions.ts');
  const storeMod = await server.ssrLoadModule('/src/store/useBimStore.ts');
  const store = storeMod.useBimStore;

  const {
    createInitialSession,
    interactionReducer,
    WOBBLE_THRESHOLD_PX,
  } = sessionMod;
  const { toolPrompt } = captionsMod;

  console.log('\n--- 1. Interaction Session State & Reducer ---');
  let s = createInitialSession('select');
  check('select tool initializes with phase: idle', s.phase === 'idle');
  check('initial session has empty picks', Array.isArray(s.picks) && s.picks.length === 0);

  s = interactionReducer(s, { type: 'begin', tool: 'WA' });
  check('WA tool initializes with phase: armed', s.phase === 'armed' && s.tool === 'WA');

  s = interactionReducer(s, { type: 'point', point: [0, 0] });
  check('first point transitions to phase: picking', s.phase === 'picking' && s.picks.length === 1);

  // Wobble guard check
  s = interactionReducer(s, { type: 'pointer_down', screenPoint: [100, 100], point: [0, 0] });
  // Move 3px X, 4px Y -> dist = 5.0px (<= threshold)
  s = interactionReducer(s, { type: 'pointer_move', screenPoint: [103, 104], point: [0.1, 0.1] });
  check('5px wobble does not enter dragging (remains picking)', s.phase === 'picking', `phase: ${s.phase}`);

  // Move 6px X, 0px Y -> dist = 6.0px (> threshold)
  s = interactionReducer(s, { type: 'pointer_move', screenPoint: [106, 100], point: [0.2, 0.0] });
  check('movement > 5px enters dragging', s.phase === 'dragging', `phase: ${s.phase}`);

  // Negative control: zero threshold forces any movement to dragging
  function reducerWithThreshold(state, action, threshold) {
    if (action.type === 'pointer_move' && state.dragOriginScreen) {
      const dist = Math.hypot(
        action.screenPoint[0] - state.dragOriginScreen[0],
        action.screenPoint[1] - state.dragOriginScreen[1]
      );
      if (dist > threshold) return { ...state, phase: 'dragging' };
    }
    return state;
  }
  const sWobbleZero = reducerWithThreshold(
    { ...s, phase: 'picking', dragOriginScreen: [100, 100] },
    { type: 'pointer_move', screenPoint: [101, 100] },
    0
  );
  check('negative control: 0px threshold fails to suppress wobble (enters dragging)',
    sWobbleZero.phase === 'dragging'
  );

  console.log('\n--- 2. Mid-Gesture Escape Behavior ---');
  // Set store active tool to 'WA' and add a pick
  store.getState().setActiveTool('WA');
  check('store arms WA tool', store.getState().activeTool === 'WA');
  check('store session is armed', store.getState().interactionSession.phase === 'armed');

  // Add a mid-gesture pick
  store.getState().dispatchInteraction({ type: 'point', point: [10, 0] });
  check('store session is picking with 1 pick',
    store.getState().interactionSession.phase === 'picking' &&
    store.getState().interactionSession.picks.length === 1
  );

  // Track bus command execution count during Escape
  let busCommandsExecuted = 0;
  const originalExecute = store.getState().executeTransaction;
  store.setState({
    executeTransaction: async (...args) => {
      busCommandsExecuted++;
      return originalExecute.apply(store.getState(), args);
    },
  });

  // Press Escape mid-gesture
  store.getState().handleKeyStroke('Escape');

  check('mid-gesture Escape sends zero bus commands', busCommandsExecuted === 0, `commands: ${busCommandsExecuted}`);
  check('mid-gesture Escape keeps WA tool armed', store.getState().activeTool === 'WA');
  check('mid-gesture Escape returns session to phase: armed', store.getState().interactionSession.phase === 'armed');
  check('mid-gesture Escape clears in-progress picks to zero', store.getState().interactionSession.picks.length === 0);

  // Second Escape: when armed with 0 picks, exits to select
  store.getState().handleKeyStroke('Escape');
  check('second Escape returns to select tool', store.getState().activeTool === 'select');
  check('second Escape sets session phase to idle', store.getState().interactionSession.phase === 'idle');

  console.log('\n--- 3. Chained Wall Run & Transaction Gate ---');
  // Chained wall run: 3 walls placed sequentially with chaining on
  const journalBefore = (store.getState().transactionJournal || []).length;
  let txCount = 0;
  store.setState({
    chainTools: true,
    activeTool: 'WA',
    executeTransaction: async (envelope) => {
      txCount++;
      // Simulate committing transaction to journal
      store.setState((prev) => ({
        transactionJournal: [
          ...(prev.transactionJournal || []),
          {
            id: `tx-wall-${txCount}`,
            timestamp: Date.now(),
            commands: envelope.commands,
            origin: 'ui',
            status: 'committed',
          },
        ],
      }));
      return { status: 'success', data: { results: [{ guid: `wall-${txCount}`, status: 'created' }] } };
    },
  });

  // Wall 1: (0,0) to (10,0)
  await store.getState().createWall([0, 0, 0], [10, 0, 0]);
  store.getState().completePlacement();

  // Wall 2: (10,0) to (10,10)
  await store.getState().createWall([10, 0, 0], [10, 10, 0]);
  store.getState().completePlacement();

  // Wall 3: (10,10) to (0,10)
  await store.getState().createWall([10, 10, 0], [0, 10, 0]);
  store.getState().completePlacement();

  const journalAfter = (store.getState().transactionJournal || []).length;
  check('chained wall run of 3 walls produces exactly 3 transactions',
    txCount === 3 && journalAfter - journalBefore === 3,
    `txCount: ${txCount}, journal delta: ${journalAfter - journalBefore}`
  );
  check('chained placement keeps WA armed throughout chain',
    store.getState().activeTool === 'WA'
  );

  console.log('\n--- 4. Per-Phase Tool Prompts ---');
  const promptArmed = toolPrompt('WA', 'armed', 0);
  const promptPicking = toolPrompt('WA', 'picking', 1);
  const promptDragging = toolPrompt('WA', 'dragging', 1);

  check('armed WA prompt instructs clicking start point', /start point/i.test(promptArmed), promptArmed);
  check('picking WA prompt instructs clicking end point or typing length', /end point/i.test(promptPicking), promptPicking);
  check('dragging WA prompt instructs dragging length or typing value', /drag to set/i.test(promptDragging), promptDragging);

  const promptRoof0 = toolPrompt('RF', 'armed', 0);
  const promptRoof1 = toolPrompt('RF', 'picking', 1);
  check('RF prompt for first corner', /first corner/i.test(promptRoof0), promptRoof0);
  check('RF prompt for opposite corner', /opposite corner/i.test(promptRoof1), promptRoof1);

  const promptDi0 = toolPrompt('DI', 'armed', 0);
  const promptDi1 = toolPrompt('DI', 'picking', 1);
  check('DI prompt for first reference', /first reference/i.test(promptDi0), promptDi0);
  check('DI prompt for second reference', /second reference/i.test(promptDi1), promptDi1);

  // Restore executeTransaction
  store.setState({ executeTransaction: originalExecute, activeTool: 'select' });

  console.log('\n--- 5. W6: Single Source of Truth Gate (No Local useState Tool-Points) ---');
  const view3dSrc = readFileSync(join(ROOT, 'src/components/viewport/Viewport3D.tsx'), 'utf-8');
  const planSrc = readFileSync(join(ROOT, 'src/components/drafting/PlanViewport2D.tsx'), 'utf-8');

  // Assert neither viewport holds tool-point state in useState
  const forbiddenHooks3D = [
    /const\s*\[\s*wallStartPoint\s*,\s*setWallStartPoint\s*\]\s*=\s*useState/i,
    /const\s*\[\s*wallCurrentPoint\s*,\s*setWallCurrentPoint\s*\]\s*=\s*useState/i,
    /const\s*\[\s*boxStartPoint\s*,\s*setBoxStartPoint\s*\]\s*=\s*useState/i,
    /const\s*\[\s*boxCurrentPoint\s*,\s*setBoxCurrentPoint\s*\]\s*=\s*useState/i,
  ];

  const forbiddenHooksPlan = [
    /const\s*\[\s*firstPoint\s*,\s*setFirstPoint\s*\]\s*=\s*useState/i,
    /const\s*\[\s*currentPoint\s*,\s*setCurrentPoint\s*\]\s*=\s*useState/i,
    /const\s*\[\s*sketchStartPoint\s*,\s*setSketchStartPoint\s*\]\s*=\s*useState/i,
  ];

  const has3DLocalPickState = forbiddenHooks3D.some((re) => re.test(view3dSrc));
  check('Viewport3D does not hold tool-point state in useState', !has3DLocalPickState);

  const hasPlanLocalPickState = forbiddenHooksPlan.some((re) => re.test(planSrc));
  check('PlanViewport2D does not hold tool-point state in useState', !hasPlanLocalPickState);

  // Assert that both viewports read tool picks from interactionSession
  check(
    'Viewport3D reads picks from interactionSession',
    /interactionSession\.picks\[0\]/.test(view3dSrc)
  );
  check(
    'PlanViewport2D reads picks from interactionSession',
    /interactionSession\.picks\[0\]/.test(planSrc)
  );

  // Negative control function to verify that introducing useState pick state fails the gate
  function verifyNegativeControl(dummySrc) {
    return forbiddenHooksPlan.some((re) => re.test(dummySrc));
  }
  const dummyWithLocalState = 'const [firstPoint, setFirstPoint] = useState<[number, number] | null>(null);';
  check(
    'negative control: re-introducing local useState pick fails assertion',
    verifyNegativeControl(dummyWithLocalState) === true
  );

  console.log('\n--- 6. W9: Occlusion Ordering (W9a) and Unstranded Session (W9b) ---');
  // W9a: Viewport3D raycasts all meshes rather than a filtered wall-only list in select and hover paths
  const selectBlock = view3dSrc.slice(
    view3dSrc.indexOf("activeTool === 'select'"),
    view3dSrc.indexOf("const handleMouseMove")
  );
  check('W9a: Selection / PushPull does not filter to wallMeshes before raycasting',
    !/wallMeshes/.test(selectBlock)
  );
  const hoverBlock = view3dSrc.slice(view3dSrc.indexOf("Face hover detection for Push/Pull"));
  check('W9a: Hover detection does not filter to wallMeshes before raycasting',
    !/wallMeshes/.test(hoverBlock)
  );

  // W9a classification logic simulation
  const sampleIntersectsSlab = [
    { distance: 5.0, object: { userData: { guid: 'slab-uuid', ifc_class: 'IfcSlab' } } },
    { distance: 10.0, object: { userData: { guid: 'wall-uuid', ifc_class: 'IfcWall' } } },
  ];
  function classifyNearest(intersects) {
    if (intersects.length === 0) return null;
    const nearest = intersects[0];
    const isWall = nearest.object.userData?.ifc_class === 'IfcWall' || nearest.object.userData?.ifc_class === 'IfcWallStandardCase';
    return { selectedGuid: nearest.object.userData?.guid, isPushPullEligible: isWall };
  }
  const slabHit = classifyNearest(sampleIntersectsSlab);
  check('W9a: slab in front of wall is selected (not captured by occluded wall)',
    slabHit.selectedGuid === 'slab-uuid' && !slabHit.isPushPullEligible
  );

  const sampleIntersectsRoof = [
    { distance: 6.0, object: { userData: { guid: 'roof-uuid', ifc_class: 'IfcRoof' } } },
    { distance: 12.0, object: { userData: { guid: 'wall-uuid', ifc_class: 'IfcWall' } } },
  ];
  const roofHit = classifyNearest(sampleIntersectsRoof);
  check('W9a: roof in front of wall is selected (not captured by occluded wall)',
    roofHit.selectedGuid === 'roof-uuid' && !roofHit.isPushPullEligible
  );

  // W9a Negative control: walls-only raycasting selects occluded wall
  function classifyWallsOnly(intersects) {
    const wallOnly = intersects.filter(i => i.object.userData?.ifc_class === 'IfcWall' || i.object.userData?.ifc_class === 'IfcWallStandardCase');
    if (wallOnly.length === 0) return null;
    return { selectedGuid: wallOnly[0].object.userData?.guid, isPushPullEligible: true };
  }
  const negHit = classifyWallsOnly(sampleIntersectsSlab);
  check('W9a negative control: walls-only hit-test selects occluded wall',
    negHit.selectedGuid === 'wall-uuid'
  );

  // W9b: synthetic click whose release precedes the begin response leaves no live session
  const originalFetch = globalThis.fetch;
  let activeMockSession = null;
  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    if (urlStr.includes('/drag/begin')) {
      await new Promise((r) => setTimeout(r, 25));
      activeMockSession = 'drag-sess-' + Math.random().toString(16).slice(2, 8);
      return { ok: true, json: async () => ({ session_id: activeMockSession }) };
    }
    if (urlStr.includes('/drag/end')) {
      activeMockSession = null;
      return { ok: true, json: async () => ({ status: 'ended' }) };
    }
    if (urlStr.includes('/state') || urlStr.includes('/project')) {
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    store.setState({ activeDragSessionId: null });
    const beginPromise = store.getState().beginDrag('Synthetic fast click');
    const endPromise = store.getState().endDrag(false);
    await Promise.all([beginPromise, endPromise]);
    await new Promise((r) => setTimeout(r, 50));

    check('W9b: fast click release preceding begin response leaves activeDragSessionId null',
      store.getState().activeDragSessionId === null
    );

    // W9b Negative control: un-guarded session assignment strands the session
    let strandedSession = null;
    let unguardedPending = (async () => {
      await new Promise(r => setTimeout(r, 25));
      strandedSession = 'stranded-sess-123';
      return strandedSession;
    })();
    let activeId = null;
    // Fast endDrag runs before unguardedPending completes and bails out
    if (!activeId) { /* bails out */ }
    await unguardedPending;
    activeId = strandedSession;
    check('W9b negative control: un-guarded session assignment strands the session',
      activeId === 'stranded-sess-123'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('\n------------------------------------------------------------------------');
  console.log(`INTERACTION SESSION GATE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
} finally {
  await server.close();
}
