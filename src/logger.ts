import winston from "winston";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.simple(),
    winston.format.errors({ stack: true }),
    winston.format.printf(
      (info) =>
        `${info.timestamp} ${info.level}: ${info.message}${
          info.stack ? `\n${info.stack}` : ""
        }`,
    ),
  ),
  transports: [new winston.transports.Console()],
});

export default logger;
