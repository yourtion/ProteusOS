import pino from "pino";

export type Logger = pino.Logger;

/** 运维日志（stderr JSONL）；与 SQLite 事件账本是两条独立通道（ADR 0004） */
export function createLogger(): Logger {
  return pino(
    { level: process.env.PROTEUS_LOG ?? "info", base: undefined },
    pino.destination({ dest: 2, sync: true }),
  );
}
