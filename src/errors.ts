export type ErrorCode =
  | "INVALID"
  | "EXISTS"
  | "NOT_FOUND"
  | "BUSY"
  | "TIMEOUT"
  | "ABORTED"
  | "HOST_FAILED";

export class ClamuxError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "ClamuxError";
  }
}
