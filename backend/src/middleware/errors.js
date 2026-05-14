export function notFound(req, res) {
  res.status(404).json({ error: "Route not found" });
}

export function errorHandler(error, req, res, _next) {
  const statusCode = error.statusCode || (error.code === "LIMIT_FILE_SIZE" ? 400 : 500);
  const uploadMessage = error.code === "LIMIT_FILE_SIZE" ? "PDF must be 7MB or smaller." : null;
  const message = uploadMessage || error.publicMessage || (statusCode >= 500 ? "Internal server error" : error.message);

  if (statusCode >= 500) {
    console.error(error);
  }

  res.status(statusCode).json({ error: message });
}
