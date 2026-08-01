import { pino } from "pino"
import { env, isProduction } from "./env.ts"

/**
 * JSON logs in production (readable by whatever host's log viewer), pretty
 * colourised lines in development.
 *
 * `redact` is not optional decoration here: this server handles an OAuth
 * refresh token and a Supabase secret key, and the easiest way to leak either
 * is to log an object that happens to contain one.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "refresh_token",
      "refresh_token_enc",
      "access_token",
      "access_token_enc",
      "*.refresh_token",
      "*.refresh_token_enc",
      "*.access_token",
      "*.access_token_enc",
      "req.headers.authorization",
      "req.headers.cookie",
      "headers.authorization",
    ],
    censor: "[redacted]",
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }),
})

/** A child logger tagged with the subsystem, so a tick's lines group together. */
export function loggerFor(subsystem: string): typeof logger {
  return logger.child({ subsystem })
}
