"use strict";

const logger = require("./logger");
const db = require("./db");
const { configPath } = require("./config");
const { startScheduler } = require("./scheduler");
const { PORT } = require("./appConfig");
const express = require("express");
const fs = require("fs");
const path = require("path");

// Ensure config file exists
const configDir = path.dirname(configPath);
fs.mkdirSync(configDir, { recursive: true });
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, "[]", "utf8");
  logger.info({ configPath }, "Created empty accounts.json");
}

// Start the 6-hour scheduler
const schedulerTask = startScheduler();

// Express app
const app = express();
app.use(express.json());
app.use(require("./routes"));

// Global error handler
app.use((err, req, res, _next) => {
  logger.error({ err, path: req.path }, "Unhandled request error");
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, "invenchecker started");
});

// Graceful shutdown
function shutdown() {
  logger.info("Shutting down...");
  schedulerTask.stop();
  server.close(() => {
    db.close();
    logger.info("Shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
