'use strict';

const express = require('express');
const { verifyChain } = require('../lib/ledger');

const router = express.Router();

// GET /api/chain/verify -- walks the whole ledger and reports whether it's
// intact, and if not, exactly where it broke. Public: verifiability is the
// point of a hash-chained ledger.
router.get('/verify', (req, res) => {
  const result = verifyChain();
  res.json(result);
});

module.exports = router;
