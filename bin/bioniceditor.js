#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');

const distServerEntry = path.join(packageRoot, 'dist-server', 'index.js');
const srcServerEntry = path.join(packageRoot, 'server', 'index.ts');

if (fs.existsSync(distServerEntry)) {
  await import(distServerEntry);
} else if (fs.existsSync(srcServerEntry)) {
  try {
    const { register } = await import('tsx/esm/api');
    register();
    await import(srcServerEntry);
  } catch (err) {
    console.error('Production build not found and tsx runner failed.');
    console.error('Please run "npm run build" to build Bionic Editor.');
    process.exit(1);
  }
} else {
  console.error('Error: Bionic Editor server entrypoint not found at:');
  console.error(` - ${distServerEntry}`);
  console.error(` - ${srcServerEntry}`);
  process.exit(1);
}
