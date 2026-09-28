'use strict';

const os = require('node:os');
const path = require('node:path');

// DB is in-memory so each test file starts with a fresh database; tests set accounts with
// tests/helpers/accounts.js.
process.env.DB_PATH = ':memory:';
process.env.LOG_LEVEL = 'silent';
// Never pick up a real data/rules.json; tests rely on the built-in default rules.
process.env.RULES_PATH = path.join(os.tmpdir(), `invenchecker-test-rules-${process.pid}-missing.json`);
