import winston from "winston";
import { LogConfig } from "./constants.js";

/**
 * Remove emojis from a string if emoji logging is disabled
 */
function removeEmojis(text: string): string {
  if (LogConfig.USE_EMOJIS) {
    return text;
  }
  // Remove all emojis using regex
  return text
    .replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
      "",
    )
    .trim();
}

/**
 * Custom format for logging
 */
const customFormat = winston.format.printf((info) => {
  const message = removeEmojis(info.message as string);
  const timestamp = info.timestamp;
  const level = info.level;
  const stack = info.stack ? `\n${info.stack}` : "";

  if (LogConfig.STRUCTURED_LOGGING) {
    // Structured JSON logging for production
    const logObject: Record<string, any> = {
      timestamp,
      level,
      message,
    };

    if (info.stack) {
      logObject.stack = info.stack;
    }

    if (info.metadata) {
      logObject.metadata = info.metadata;
    }

    return JSON.stringify(logObject);
  }

  // Human-readable logging for development
  return `${timestamp} ${level}: ${message}${stack}`;
});

/**
 * Create Winston logger instance
 */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp({
      format: "YYYY-MM-DD HH:mm:ss",
    }),
    winston.format.errors({ stack: true }),
    customFormat,
  ),
  transports: [
    new winston.transports.Console({
      stderrLevels: ["error"],
    }),
  ],
});

/**
 * Add file transport in production
 */
if (process.env.NODE_ENV === "production") {
  logger.add(
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
  );

  logger.add(
    new winston.transports.File({
      filename: "logs/combined.log",
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
  );
}

export default logger;
