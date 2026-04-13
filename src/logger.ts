import { config } from './config.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const currentLevel = LEVELS[config.logLevel] ?? 1;

type LogEntry = {
  time: string;
  level: string;
  module: string;
  message: string;
  data?: unknown;
};

// 订阅者列表，用于 WebSocket 推送
const subscribers: ((entry: LogEntry) => void)[] = [];

export function onLog(fn: (entry: LogEntry) => void) {
  subscribers.push(fn);
  return () => {
    const idx = subscribers.indexOf(fn);
    if (idx >= 0) subscribers.splice(idx, 1);
  };
}

function emit(level: string, module: string, message: string, data?: unknown) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const entry: LogEntry = { time, level, module, message, data };
  subscribers.forEach(fn => fn(entry));
  return entry;
}

function fmt(entry: LogEntry): string {
  const tag = entry.level.toUpperCase().padEnd(5);
  const prefix = `[${entry.time}] [${tag}] [${entry.module}]`;
  if (entry.data !== undefined) {
    return `${prefix} ${entry.message} ${JSON.stringify(entry.data)}`;
  }
  return `${prefix} ${entry.message}`;
}

export function createLogger(module: string) {
  return {
    debug(msg: string, data?: unknown) {
      if (currentLevel <= 0) console.debug(fmt(emit('debug', module, msg, data)));
    },
    info(msg: string, data?: unknown) {
      if (currentLevel <= 1) console.log(fmt(emit('info', module, msg, data)));
    },
    warn(msg: string, data?: unknown) {
      if (currentLevel <= 2) console.warn(fmt(emit('warn', module, msg, data)));
    },
    error(msg: string, data?: unknown) {
      if (currentLevel <= 3) console.error(fmt(emit('error', module, msg, data)));
    },
  };
}
