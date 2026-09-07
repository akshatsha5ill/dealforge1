type LogLevel = 'info' | 'warn' | 'error';

const levels: Record<LogLevel, string> = { info: 'INFO', warn: 'WARN', error: 'ERROR' };

const log = (level: LogLevel, message: string, extra: Record<string, unknown> = {}) => {
  const entry = {
    level: levels[level] || level,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
};

export default {
  info: (msg: string, extra?: Record<string, unknown>) => log('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => log('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => log('error', msg, extra),
};
