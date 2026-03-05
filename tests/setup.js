'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Each Jest worker process gets a unique config file via its PID.
// DB is in-memory so each test file starts with a fresh database.
process.env.DB_PATH = ':memory:';
process.env.LOG_LEVEL = 'silent';
process.env.CONFIG_PATH = path.join(os.tmpdir(), `invenchecker-test-${process.pid}.json`);

fs.writeFileSync(process.env.CONFIG_PATH, '[]', 'utf8');
