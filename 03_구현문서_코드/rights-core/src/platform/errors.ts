export type Diagnostic = { code: string; path: string; message: string };
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500;

/** 서비스 계층의 업무 오류. HTTP 계층은 status와 code, diagnostics를 그대로 응답한다. */
export class DomainError extends Error {
  readonly code: string;
  readonly status: HttpStatus;
  readonly diagnostics: readonly Diagnostic[];
  constructor(code: string, status: HttpStatus, message: string, diagnostics: readonly Diagnostic[] = []) {
    super(message);
    this.code = code;
    this.status = status;
    this.diagnostics = diagnostics;
  }
}

export const notFound = (what: string, id: string) => new DomainError("NOT_FOUND", 404, `${what} not found: ${id}`);
export const conflict = (code: string, message: string) => new DomainError(code, 409, message);
export const invalid = (code: string, message: string, diagnostics: readonly Diagnostic[] = []) =>
  new DomainError(code, 422, message, diagnostics);
