export interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  timestamp: string;
  path: string;
  correlationId?: string;
  /** Machine-readable specifics, only for errors that carry them (e.g. `CartChanged`, #42). */
  details?: Record<string, unknown>;
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
