const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const logFile = path.join(LOG_DIR, 'system.log');
const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLevel = levels[process.env.LOG_LEVEL || 'INFO'] || 1;

function write(level, msg) {
  if (levels[level] < currentLevel) return;
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFile(logFile, line, () => {});
}

module.exports = {
  debug: (m) => write('DEBUG', m),
  info:  (m) => write('INFO', m),
  warn:  (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
};
