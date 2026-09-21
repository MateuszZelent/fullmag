/**
 * Build and asset distribution script for @fullmag/runner-console.
 * Packages frontend assets into apps/runner-console/dist/ and scripts/local_runner/ui_dist/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SRC_DIR = __dirname;
const DIST_DIR = path.join(__dirname, 'dist');
const CONTAINER_UI_DIST = path.join(__dirname, '..', '..', 'scripts', 'local_runner', 'ui_dist');

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      if (child === 'dist' || child === 'node_modules') continue;
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

console.log('[build] Packaging Fullmag Runner Console assets...');

// 1. Build to apps/runner-console/dist
fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

copyRecursive(path.join(SRC_DIR, 'index.html'), path.join(DIST_DIR, 'index.html'));
copyRecursive(path.join(SRC_DIR, 'styles.css'), path.join(DIST_DIR, 'styles.css'));
copyRecursive(path.join(SRC_DIR, 'src'), path.join(DIST_DIR, 'src'));

// 2. Build/copy to scripts/local_runner/ui_dist for coordinator Docker image
fs.rmSync(CONTAINER_UI_DIST, { recursive: true, force: true });
fs.mkdirSync(CONTAINER_UI_DIST, { recursive: true });

copyRecursive(path.join(SRC_DIR, 'index.html'), path.join(CONTAINER_UI_DIST, 'index.html'));
copyRecursive(path.join(SRC_DIR, 'styles.css'), path.join(CONTAINER_UI_DIST, 'styles.css'));
copyRecursive(path.join(SRC_DIR, 'src'), path.join(CONTAINER_UI_DIST, 'src'));

console.log(`[build] Successfully built assets to:\n  - ${DIST_DIR}\n  - ${CONTAINER_UI_DIST}`);
