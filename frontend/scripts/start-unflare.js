const { execSync } = require('child_process');
const path = require('path');

function canRun(cmd) {
  try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; }
}

function run(cmd, cwd) {
  try {
    execSync(cmd, { stdio: 'inherit', cwd });
    return true;
  } catch {
    return false;
  }
}

(async () => {
  // Skip if Docker isn't installed
  const hasDocker = canRun('docker --version');
  if (!hasDocker) {
    console.log('[predev] Docker not found; skipping Unflare startup');
    return;
  }

  const repoRoot = path.resolve(process.cwd(), '..');
  const unflareDir = path.join(repoRoot, 'Unflare');

  // Prefer compose v2, then legacy, else run published image
  const ok = (canRun('docker compose version') && run('docker compose up -d', unflareDir))
    || (canRun('docker-compose --version') && run('docker-compose up -d', unflareDir));
  if (!ok) {
    // Best-effort fallback to run the public image
    run('docker run -d --name unflare -p 5002:5002 ghcr.io/iamyegor/unflare || true', repoRoot);
  }
})();


