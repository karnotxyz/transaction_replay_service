import { Response } from "express";
import { HttpStatus } from "../constants.js";
import { AppError } from "../errors/index.js";
import logger from "../logger.js";

/**
 * Standard success response
 */
export interface SuccessResponse<T = any> {
  success: true;
  data: T;
  timestamp: string;
}

/**
 * Standard error response
 */
export interface ErrorResponse {
  success: false;
  error: {
    message: string;
    code?: string;
    details?: any;
  };
  timestamp: string;
}

/**
 * Send success response
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode: number = HttpStatus.OK,
): Response {
  const response: SuccessResponse<T> = {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };

  return res.status(statusCode).json(response);
}

/**
 * Send error response
 */
export function sendError(
  res: Response,
  error: Error | AppError | string,
  statusCode?: number,
): Response {
  // Determine status code
  let code = statusCode || HttpStatus.INTERNAL_SERVER_ERROR;
  let errorCode: string | undefined;
  let errorMessage: string;
  let details: any;

  if (error instanceof AppError) {
    code = error.statusCode;
    errorCode = error.code;
    errorMessage = error.message;

    // Include additional details for specific error types
    if ((error as any).details) {
      details = (error as any).details;
    }
  } else if (error instanceof Error) {
    errorMessage = error.message;
  } else {
    errorMessage = String(error);
  }

  const response: ErrorResponse = {
    success: false,
    error: {
      message: errorMessage,
      ...(errorCode && { code: errorCode }),
      ...(details && { details }),
    },
    timestamp: new Date().toISOString(),
  };

  // Log error
  if (code >= 500) {
    logger.error(`Server error: ${errorMessage}`, error);
  } else {
    logger.warn(`Client error: ${errorMessage}`);
  }

  return res.status(code).json(response);
}

/**
 * Handle async route errors
 */
export function asyncHandler(
  fn: (req: any, res: Response, next?: any) => Promise<any>,
) {
  return (req: any, res: Response, next: any) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      sendError(res, error);
    });
  };
}
