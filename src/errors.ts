export class UserError extends Error {}

export function describeError(error: unknown): string {
  if (error instanceof UserError) return error.message;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const messages: Record<string, string> = {
    ECONNREFUSED: 'Connection refused. Check the database or target service.',
    ENOTFOUND: 'DNS lookup failed.', EAI_AGAIN: 'Temporary DNS lookup failure.',
    ETIMEDOUT: 'Operation timed out.', ECONNRESET: 'Connection reset by peer.',
    ENOENT: 'Input file or output directory does not exist.', EEXIST: 'Output file already exists; choose a new path.',
    EACCES: 'Permission denied.', '28P01': 'PostgreSQL authentication failed. Check DATABASE_URL.',
    '3D000': 'PostgreSQL database does not exist.', '42P01': 'Database schema missing. Run npm run db:migrate.',
    '42703': 'Database schema is outdated. Run npm run db:migrate.',
    '23505': 'Duplicate database record.', '23514': 'Database constraint rejected the record.',
    ERR_INVALID_URL: 'Invalid URL. Provide an absolute HTTP(S) URL.',
    ERR_PARSE_ARGS_UNKNOWN_OPTION: 'Unknown CLI option. Use --help.',
    ERR_PARSE_ARGS_INVALID_OPTION_VALUE: 'Invalid or missing CLI option value. Use --help.',
    ERR_INVALID_IP_ADDRESS: 'Invalid IP address returned by the HTTP DNS resolver.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate hostname mismatch.', DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed TLS certificate rejected.',
    CERT_HAS_EXPIRED: 'TLS certificate expired.', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate verification failed.',
  };
  if (messages[code]) return `${messages[code]} [${code}]`;
  if (/^(?:ERR_[A-Z_]+|E[A-Z0-9_]+|[0-9A-Z]{5})$/.test(code)) return `Operation failed [${code}]. Untrusted error details withheld.`;
  if (/^CSV_[A-Z_]+$/.test(code)) return `Invalid CSV input [${code}].`;
  // Never echo arbitrary error messages: database details, paths and server text can contain secrets.
  return 'Unexpected operation failure. No raw error details were printed to protect credentials.';
}
