// The nsfwjs npm package ships its MobileNetV2 model weights bundled as
// base64 data inside the package itself (see node_modules/nsfwjs/dist/cjs/
// model_imports/mobilenet_v2.js) -- there is nothing to download. This
// script just loads the model once at setup time as a sanity check, so a
// broken install is caught here rather than on the first real upload.
'use strict';

async function main() {
  console.log('Verifying the bundled NSFW model loads correctly (no network access used)...');
  const nsfwjs = require('nsfwjs');
  const start = Date.now();
  const model = await nsfwjs.load('MobileNetV2');
  console.log(`Model loaded OK in ${Date.now() - start}ms.`);
  void model;
}

main().catch((err) => {
  console.error('Failed to load the NSFW model:', err);
  process.exit(1);
});
