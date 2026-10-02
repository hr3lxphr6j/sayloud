/*
 * Forked from kuromoji@0.1.2
 * 
 * Original Copyright 2014 Takuya Asano
 * Copyright 2010-2014 Atilika Inc. and contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * MODIFICATIONS:
 * - Replaced zlibjs dependency with native DecompressionStream API
 * - Uses chrome.runtime.getURL for proper path resolution in extensions
 */

import DictionaryLoader from "./DictionaryLoader.js";

/**
 * BrowserDictionaryLoader inherits DictionaryLoader, using fetch + DecompressionStream
 * @param {string} dic_path Dictionary path
 * @constructor
 */
function BrowserDictionaryLoader(dic_path) {
    DictionaryLoader.apply(this, [dic_path]);
}

BrowserDictionaryLoader.prototype = Object.create(DictionaryLoader.prototype);

/**
 * Utility function to load gzipped dictionary using native DecompressionStream
 * @param {string} url Dictionary URL
 * @param {BrowserDictionaryLoader~onLoad} callback Callback function
 */
BrowserDictionaryLoader.prototype.loadArrayBuffer = function (url, callback) {
    // Test environment: use Node.js fs + zlib
    if (typeof process !== 'undefined' && process.versions?.node) {
        import('fs').then(fs => {
            return import('zlib').then(zlib => {
                // Convert URL to file path - remove leading slash and prepend 'public/'
                const filePath = url.startsWith('/') 
                    ? `public${url}` 
                    : `public/${url}`;
                try {
                    const gzipped = fs.readFileSync(filePath);
                    const decompressed = zlib.gunzipSync(gzipped);
                    callback(null, decompressed.buffer);
                } catch (err) {
                    callback(err, null);
                }
            });
        }).catch(err => callback(err, null));
        return;
    }

    // Resolve URL relative to extension root
    // In Chrome extensions, workers run in a chrome-extension:// context
    // and can use self.location to construct absolute URLs
    let resolvedUrl;
    
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
        // In extension context with chrome API (main thread, offscreen document)
        resolvedUrl = chrome.runtime.getURL(url);
    } else if (typeof self !== 'undefined' && self.location) {
        // In worker context: construct absolute URL from worker's location
        // Workers inherit chrome-extension:// origin from parent document
        resolvedUrl = new URL(url, self.location.origin + '/').href;
    } else {
        // Fallback: use as-is
        resolvedUrl = url;
    }
    
    console.log('[BrowserDictionaryLoader] Loading:', url, '→', resolvedUrl);

    fetch(resolvedUrl)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            // Use native DecompressionStream to decompress gzip
            return response.body
                .pipeThrough(new DecompressionStream('gzip'))
                .getReader();
        })
        .then(async reader => {
            const chunks = [];
            let totalLength = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                totalLength += value.length;
            }

            // Concatenate all chunks into a single ArrayBuffer
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }

            callback(null, result.buffer);
        })
        .catch(err => {
            callback(err, null);
        });
};

/**
 * Callback
 * @callback BrowserDictionaryLoader~onLoad
 * @param {Object} err Error object
 * @param {Uint8Array} buffer Loaded buffer
 */

export default BrowserDictionaryLoader;
