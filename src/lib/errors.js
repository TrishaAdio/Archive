class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const badRequest = (message, extra) => new AppError(400, "bad_request", message, extra);
const unauthorized = (message = "Unauthorized") => new AppError(401, "unauthorized", message);
const forbidden = (code, message) => new AppError(403, code, message);
const notFound = (message = "Not found") => new AppError(404, "not_found", message);
const conflict = (message) => new AppError(409, "conflict", message);

export { AppError, badRequest, conflict, forbidden, notFound, unauthorized };
