import { Request, Response, NextFunction } from "express";
import { recordHttpRequest, startTimer } from "./metrics.js";

/**
 * Express middleware to record HTTP metrics
 */
export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const endTimer = startTimer();

  // Store the original end method
  const originalEnd = res.end.bind(res);

  // Override res.end to record metrics when response is sent
  (res.end as any) = function (chunk?: any, encoding?: any, callback?: any) {
    // Record the HTTP request metrics
    const duration = endTimer();
    const method = req.method;
    const endpoint = req.route?.path || req.path;
    const statusCode = res.statusCode;

    recordHttpRequest(method, endpoint, statusCode, duration);

    // Call the original end method
    return originalEnd(chunk, encoding, callback);
  };

  next();
}
