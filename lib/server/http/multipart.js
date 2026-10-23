// multipart/form-data parsing for the upload endpoint.
//
// Replaces multer's `memoryStorage()` + `.single('file')`. The whole upload
// is buffered in memory before it can be sniffed and re-encoded, so these
// limits are what bound the endpoint's memory use. `files`/`parts`/
// `fieldSize` matter as much as `fileSize`: without them a single request
// can carry thousands of parts, and the per-file cap does nothing to stop
// the total from being enormous.
'use strict';

const { Readable } = require('stream');
const Busboy = require('busboy');
const { HttpError } = require('./errors');

const UPLOAD_LIMITS = {
  fileSize: 100 * 1024 * 1024, // absolute ceiling; the per-type cap is enforced by the route
  files: 1,
  parts: 12,
  fields: 10,
  fieldNameSize: 100,
  fieldSize: 64 * 1024
};

// Same split multer made: an oversized file is "too large", every other
// violation means the request itself is malformed.
const tooLarge = () => new HttpError(413, 'file too large');
const malformed = () => new HttpError(400, 'malformed upload');

/**
 * Parses a multipart request into `{ fields, file }`, where `file` is
 * `{ fieldName, filename, mimeType, buffer }` or null.
 *
 * A request that isn't multipart at all resolves with no fields and no file
 * (the route then answers "no file provided"), matching multer.
 *
 * @param {Request} request
 * @param {object}  [opts]
 * @param {string}  [opts.fileField='file'] the only field allowed to carry a file
 * @param {object}  [opts.limits]           overrides for UPLOAD_LIMITS
 */
function parseMultipart(request, { fileField = 'file', limits = UPLOAD_LIMITS } = {}) {
  const contentType = request.headers.get('content-type') || '';
  if (!/^multipart\/form-data/i.test(contentType) || !request.body) {
    return Promise.resolve({ fields: {}, file: null });
  }

  return new Promise((resolve, reject) => {
    let busboy;
    try {
      busboy = Busboy({ headers: { 'content-type': contentType }, limits });
    } catch {
      reject(malformed()); // e.g. multipart without a boundary
      return;
    }

    const source = Readable.fromWeb(request.body);
    const fields = Object.create(null);
    let file = null;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      source.unpipe(busboy);
      source.destroy();
      reject(err);
    };

    busboy.on('field', (name, value, info) => {
      if (info.nameTruncated || info.valueTruncated) return fail(malformed());
      // A repeated key becomes an array, as with multer. Routes must
      // type-check every field rather than assume a string.
      if (name in fields) {
        fields[name] = [].concat(fields[name], value);
      } else {
        fields[name] = value;
      }
    });

    busboy.on('file', (name, stream, info) => {
      if (name !== fileField || file) {
        stream.resume();
        return fail(malformed());
      }
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => fail(tooLarge()));
      stream.on('end', () => {
        if (stream.truncated) return fail(tooLarge());
        file = { fieldName: name, filename: info.filename, mimeType: info.mimeType, buffer: Buffer.concat(chunks) };
      });
    });

    busboy.on('partsLimit', () => fail(malformed()));
    busboy.on('filesLimit', () => fail(malformed()));
    busboy.on('fieldsLimit', () => fail(malformed()));
    busboy.on('error', () => fail(malformed()));
    source.on('error', () => fail(malformed())); // client aborted mid-upload

    busboy.on('close', () => {
      if (settled) return;
      settled = true;
      resolve({ fields, file });
    });

    source.pipe(busboy);
  });
}

module.exports = { parseMultipart, UPLOAD_LIMITS };
