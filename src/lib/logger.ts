import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import pretty from 'pino-pretty';
import { getConfig } from '../config/index.js';

export type Logger = pino.Logger;

/** Fields every log line can carry, so runs stay greppable across steps. */
export interface LogContext {
  run_id?: number;
  store_id?: number;
  domain?: string;
  step?: string;
}

function buildLogger(): Logger {
  const config = getConfig();
  mkdirSync(config.paths.logs, { recursive: true });

  const day = new Date().toISOString().slice(0, 10);
  const fileStream = createWriteStream(path.join(config.paths.logs, `${day}.log`), { flags: 'a' });

  const consoleStream = config.log.pretty
    ? pretty({
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
        messageFormat: '{if step}[{step}] {end}{msg}',
      })
    : process.stdout;

  return pino(
    {
      level: config.log.level,
      base: null, // pid/hostname add nothing for a local single-process run
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream([
      { stream: consoleStream, level: config.log.level },
      { stream: fileStream, level: 'debug' }, // file keeps more detail than the console
    ]),
  );
}

let root: Logger | undefined;

export function logger(): Logger {
  root ??= buildLogger();
  return root;
}

/** Child logger that stamps every line with the given context. */
export function childLogger(context: LogContext, parent: Logger = logger()): Logger {
  return parent.child(context);
}

/** Silent logger for tests, so assertions are not buried in output. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
