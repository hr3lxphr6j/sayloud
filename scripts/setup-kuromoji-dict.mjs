#!/usr/bin/env node
/**
 * Copy kuromoji dictionary files to public directory.
 *
 * This script is run automatically after `pnpm install` to ensure
 * Japanese text-to-speech has the dictionaries it needs for Kanji→Kana
 * conversion.
 *
 * The dictionary files (~17MB) are excluded from git tracking but
 * regenerated on every install, so developers don't need to download
 * them manually.
 *
 * This is the only reason `kuromoji` is a dependency. The runtime code is
 * vendored (`lib/vendor/kuromoji`), and the analyzer that used to pull this
 * package in transitively is vendored too (`lib/vendor/kuroshiro-analyzer-kuromoji`),
 * so the package is not imported anywhere — but its `dict/*.dat.gz` are the
 * dictionary data the vendored loader reads at runtime. Removing it silently
 * costs Japanese its dictionary, hence the explicit dependency.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Find kuromoji dict directory in pnpm
const nodeModules = join(projectRoot, 'node_modules');
const pnpmDir = join(nodeModules, '.pnpm');

function findKuromojiDict() {
  if (!existsSync(pnpmDir)) {
    console.warn('⚠️  .pnpm directory not found, skipping kuromoji dict setup');
    return null;
  }

  const entries = readdirSync(pnpmDir);
  const kuromojiEntry = entries.find(entry => entry.startsWith('kuromoji@'));
  if (!kuromojiEntry) {
    console.warn('⚠️  kuromoji not found in node_modules, skipping dict setup');
    return null;
  }

  return join(pnpmDir, kuromojiEntry, 'node_modules', 'kuromoji', 'dict');
}

function main() {
  console.log('📚 Setting up kuromoji dictionaries for Japanese support...');

  const sourceDict = findKuromojiDict();
  if (!sourceDict || !existsSync(sourceDict)) {
    console.warn('⚠️  Kuromoji dict source not found, skipping');
    return;
  }

  const targetDict = join(projectRoot, 'public', 'kuromoji-dict');
  
  // Create target directory
  mkdirSync(targetDict, { recursive: true });

  // Copy all .dat.gz files
  const files = readdirSync(sourceDict).filter(f => f.endsWith('.dat.gz'));
  
  console.log(`   Copying ${files.length} dictionary files...`);
  
  let totalSize = 0;
  for (const file of files) {
    const source = join(sourceDict, file);
    const target = join(targetDict, file);
    copyFileSync(source, target);
    
    const stat = statSync(target);
    totalSize += stat.size;
  }

  const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
  console.log(`✅ Copied ${files.length} files (${sizeMB} MB) to public/kuromoji-dict/`);
}

main();
