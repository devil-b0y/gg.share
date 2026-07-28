// NSFW classification. Runs entirely on this machine: nsfwjs ships its
// MobileNetV2 model's weights bundled as base64 inside the npm package, so
// nsfwjs.load('MobileNetV2') makes zero network requests -- consistent
// with the "nothing about an upload ever leaves the server" guarantee.
//
// Backend selection: @tensorflow/tfjs-node gives a large speedup via
// native bindings, but those bindings may not have a prebuild for every
// Node version. We try it first and silently fall back to the pure-JS
// tfjs backend (already proven to work above) if it fails to load.
'use strict';

const fs = require('fs');
const sharp = require('sharp');
const config = require('../config');

let tf;
let usingNodeBackend = false;

function loadTf() {
  if (tf) return tf;
  if (!config.FORCE_TFJS_CPU) {
    try {
      tf = require('@tensorflow/tfjs-node');
      usingNodeBackend = true;
      console.log('[nsfw] using @tensorflow/tfjs-node (native) backend');
      return tf;
    } catch (err) {
      console.log('[nsfw] @tensorflow/tfjs-node unavailable, falling back to pure-JS backend:', err.message);
    }
  }
  tf = require('@tensorflow/tfjs');
  usingNodeBackend = false;
  return tf;
}

let modelPromise = null;
function getModel() {
  if (!modelPromise) {
    loadTf();
    const nsfwjs = require('nsfwjs');
    modelPromise = nsfwjs.load('MobileNetV2');
  }
  return modelPromise;
}

/** Converts a buffer (any sharp-readable image format) into a decoded
 * 224x224x3 uint8 tensor ready for classification. */
async function bufferToTensor(imageBuffer) {
  const { data, info } = await sharp(imageBuffer)
    .resize(224, 224, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);
}

/** predictions: array of {className, probability}. We only care about a
 * handful of buckets; unrecognized classNames are ignored. */
function scoreFromPredictions(predictions) {
  const byClass = {};
  for (const p of predictions) byClass[p.className] = p.probability;
  return {
    porn: byClass.Porn || 0,
    hentai: byClass.Hentai || 0,
    sexy: byClass.Sexy || 0,
    neutral: byClass.Neutral || 0,
    drawing: byClass.Drawing || 0
  };
}

/** Classifies a single image buffer. Returns the raw per-class scores. */
async function classifyImageBuffer(imageBuffer) {
  const model = await getModel();
  const tensor = await bufferToTensor(imageBuffer);
  try {
    const predictions = await model.classify(tensor);
    return scoreFromPredictions(predictions);
  } finally {
    tensor.dispose();
  }
}

/** Classifies a list of frame image file paths (already extracted by
 * server/lib/media.js#extractSampleFrames) and returns the worst-case
 * (highest porn+hentai) score across all frames, since a single bad frame
 * in a video should be enough to flag it. */
async function classifyVideoFrames(framePaths) {
  let worst = { porn: 0, hentai: 0, sexy: 0, neutral: 1, drawing: 0 };
  let worstMetric = -1;
  for (const framePath of framePaths) {
    const buf = fs.readFileSync(framePath);
    const score = await classifyImageBuffer(buf);
    const metric = score.porn + score.hentai;
    if (metric > worstMetric) {
      worstMetric = metric;
      worst = score;
    }
  }
  return worst;
}

function isUsingNodeBackend() {
  return usingNodeBackend;
}

module.exports = { classifyImageBuffer, classifyVideoFrames, isUsingNodeBackend, getModel };
