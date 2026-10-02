// Test dictionary loading
const fs = require('fs');
const zlib = require('zlib');

// Read one of the dictionary files
const filePath = 'public/kuromoji-dict/base.dat.gz';
const gzipped = fs.readFileSync(filePath);

console.log('Gzipped size:', gzipped.length);

// Decompress with Node.js zlib
const decompressed = zlib.gunzipSync(gzipped);
console.log('Decompressed size:', decompressed.length);
console.log('Decompressed type:', decompressed.constructor.name);
console.log('First 20 bytes:', Array.from(decompressed.slice(0, 20)));

// Try to interpret as Int32Array
const int32View = new Int32Array(decompressed.buffer, decompressed.byteOffset, decompressed.length / 4);
console.log('As Int32Array length:', int32View.length);
console.log('First 10 Int32 values:', Array.from(int32View.slice(0, 10)));
