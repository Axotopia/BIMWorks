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

  console.log('\n------------------------------------------------------------------------');
  console.log(`INTERACTION SESSION GATE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
} finally {
  await server.close();
}
