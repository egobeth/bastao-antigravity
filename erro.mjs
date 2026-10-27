export class BastaoError extends Error {
  constructor(message, code = 'GENERIC') {
    super(message);
    this.name = 'BastaoError';
    this.code = code;
  }
}
