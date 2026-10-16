/**
 * Python test suites gate runner.
 * Ensures backend regressions (like legacy container load crashes) fail npm run check.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function getPythonPath() {
  const venvWin = join(ROOT, '.venv', 'Scripts', 'python.exe');
  if (existsSync(venvWin)) return venvWin;
  const venvUnix = join(ROOT, '.venv', 'bin', 'python');
  if (existsSync(venvUnix)) return venvUnix;
  return process.platform === 'win32' ? 'python' : 'python3';
}

const pyExe = getPythonPath();
console.log(`Using Python executable: ${pyExe}`);

const SUITES = [
  'scratch/test_solver_capability.py',
  'scratch/test_container_fidelity.py',
  'scratch/test_dimensions_crud.py',
  'scratch/test_references.py',
  'scratch/test_transactions.py',
  'scratch/test_reference_move.py',
  'scratch/test_dependency_graph.py',
];

let failed = false;

for (const suite of SUITES) {
  const fullPath = join(ROOT, suite);
  console.log(`\n--- Running Python Suite: ${suite} ---`);
  const res = spawnSync(pyExe, [fullPath], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PYTHONPATH: join(ROOT, 'backend') },
  });

  if (res.status !== 0) {
    console.error(`FAILED: ${suite} exited with code ${res.status}`);
    failed = true;
    break;
  }
}

if (failed) {
  console.error('\nPYTHON SUITES GATE FAILED');
  process.exit(1);
} else {
  console.log('\n------------------------------------------------------------------------');
  console.log('PYTHON SUITES GATE PASSED');
}
