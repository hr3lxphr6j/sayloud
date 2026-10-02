/**
 * Test to reproduce the zlibjs loading issue in worker environment.
 * 
 * The problem: kuromoji's BrowserDictionaryLoader does
 * `var zlib = require("zlibjs/bin/gunzip.min.js")` and then
 * `new zlib.Zlib.Gunzip()`. When zlibjs is loaded via importScripts(),
 * it attaches to global but the require() returns undefined.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('zlibjs loading mechanism', () => {
  test('should understand how zlibjs attaches to global', () => {
    const global = globalThis as any;
    
    // Load zlibjs source to inspect how it exports
    const zlibPath = join(process.cwd(), 'node_modules/.pnpm/zlibjs@0.3.1/node_modules/zlibjs/bin/gunzip.min.js');
    const zlibSource = readFileSync(zlibPath, 'utf-8');
    
    // Check what zlibjs does at the end
    const exportPattern = /t\(["']Zlib/g;
    const matches = zlibSource.match(exportPattern);
    
    console.log('\nzlibjs export statements:', matches);
    console.log('\nLast 500 chars of zlibjs:');
    console.log(zlibSource.slice(-500));
    
    // Execute zlibjs in this context
    const func = new Function('exports', 'module', zlibSource);
    const mockModule = { exports: {} };
    func(mockModule.exports, mockModule);
    
    console.log('\nAfter executing zlibjs:');
    console.log('mockModule.exports:', Object.keys(mockModule.exports));
    console.log('global.Zlib:', global.Zlib);
    
    // The issue: zlibjs uses UMD pattern but in strict mode context
    // `this` might not be the global object
  });
});
