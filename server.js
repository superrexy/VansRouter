#!/usr/bin/env node
// Default VansRoute production port to 3003 when PORT env is not set.
// The standalone Next.js server otherwise falls back to 3000.
// Use PORT=20127 for `pnpm dev` (development server).
const path = require('node:path');
process.env.PORT ||= '3003';
require(process.env.RELEASE_SERVER || path.join(__dirname, '.next', 'standalone', 'server.js'));
