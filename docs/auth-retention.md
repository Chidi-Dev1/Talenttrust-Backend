# Auth Data Retention

This document describes the data retention policy, storage behavior, and PII handling for the Auth subsystem in the Talenttrust-Backend system.

## 1. What's Stored

The auth subsystem manages several categories of authentication and authorization data:

### 1.1 User Credentials (`users` table)

Each registered user is stored as a row in the `users` SQLite table. The table stores:

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique user identifier |
| `username` | TEXT (unique) | Display name |
| `email` | TEXT (unique, normalized) | Trimmed + lowercased email address |
| `role` | enum | `client`, `freelancer`, or `both` |
| `password_hash` | TEXT (nullable) | scrypt hash with random salt (`<hex-salt>:<hex-hash>`) |
| `refresh_token_hash` | TEXT (nullable) | SHA-256 hash of the most recent refresh token |
| `created_at` | ISO-8601 | Account creation timestamp |

**Security properties:**
- Passwords are never stored in plaintext. The scrypt hash uses N=16384, r=8, p=1 with a 16-byte random salt per password.
- Refresh tokens are stored as SHA-256 hashes; the raw token is never persisted.
- Email uniqueness is enforced via a normalized expression index: `CREATE UNIQUE INDEX ... ON users (lower(trim(email)))`.

*Source: [`src/services/auth.service.ts`](../src/services/auth.service.ts), [`src/db/migrations.ts`](../src/db/migrations.ts) — Migration v1 & v7*

### 1.2 JWT Access Tokens (Transient)

Access tokens are short-lived JWTs signed with HS256:

| Property | Value |
|----------|-------|
| **TTL** | 15 minutes (`ACCESS_TOKEN_TTL`) |
| **Algorithm** | HS256 (configurable via `JWT_SIGN_ALGORITHMS` in `src/auth/jwtConfig.ts`) |
| **Payload** | `{ sub, email, role, iat, exp }` |
| **Storage** | Not persisted — stateless, validated via signature on each request |

*Source: [`src/services/auth.service.ts`](../src/services/auth.service.ts) — `issueTokens()`*

### 1.3 JWT Refresh Tokens (Rotated)

Refresh tokens are long-lived JWTs used to obtain new access-token pairs:

| Property | Value |
|----------|-------|
| **TTL** | 7 days (`REFRESH_TOKEN_TTL`) |
| **Algorithm** | HS256 |
| **Payload** | `{ sub, tok, iat, exp }` (where `tok` is a random 32-byte hex string) |
| **Storage** | SHA-256 hash stored in `users.refresh_token_hash` |
| **Rotation** | Old token hash is revoked (set to `NULL`) before a new pair is issued on each refresh |
| **Logout** | `refresh_token_hash` is set to `NULL`, invalidating the current token |

**Security properties:**
- Refresh token rotation: each use invalidates the previous token, preventing replay.
- Constant-time hash comparison (`timingSafeEqual`) prevents timing attacks on stored hash verification.
- The `tok` claim provides a per-token revocation signal independent of the JWT's `exp` claim.

*Source: [`src/services/auth.service.ts`](../src/services/auth.service.ts) — `refresh()`, `logout()`*

### 1.4 API Keys

API keys enable programmatic access to endpoints, managed via `POST /api/v1/auth/api-keys`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique key identifier |
| `name` | TEXT | Human-readable label |
| `key_hash` | TEXT | PBKDF2-SHA256 hash of the raw key |
| `key_salt` | TEXT | Random salt for the hash |
| `key_selector` | TEXT | SHA-256 hash used for lookups (prefix match) |
| `scope` | JSON array | Permissions (e.g., `["contracts:read"]`) |
| `created_by` | TEXT | User UUID who created the key |
| `expires_at` | ISO-8601 (nullable) | Optional expiration timestamp |
| `last_used_at` | ISO-8601 (nullable) | Last usage timestamp |
| `call_count` | INTEGER | Usage counter |
| `active` | BOOLEAN | Whether the key is active |
| `created_at` | ISO-8601 | Creation timestamp |
| `updated_at` | ISO-8601 | Last update timestamp |

**Security properties:**
- Raw API keys are **never stored** — only the PBKDF2-SHA256 hash and salt are persisted.
- Lookups use a SHA-256 key selector (prefix of the raw key hash) for index-friendly retrieval.
- The raw key is returned to the caller exactly once at creation time; if lost, a new key must be generated.

*Source: [`src/auth/apiKeys.ts`](../src/auth/apiKeys.ts), [`src/database/sqliteStore.ts`](../src/database/sqliteStore.ts)*

### 1.5 API Key Cache (Transient, In-Memory)

Validated API key results are cached in-memory for performance:

| Property | Value |
|----------|-------|
| **Storage** | In-memory `Map<string, ApiKeyInfo>` |
| **TTL** | 5 minutes (configurable via `API_KEY_CACHE_TTL_MS`) |
| **Invalidation** | Expired keys evicted on next access; full cache reset on key creation/deactivation |

*Source: [`src/auth/authCache.ts`](../src/auth/authCache.ts), [`src/auth/apiKeys.ts`](../src/auth/apiKeys.ts)*

### 1.6 Account Lockout State (Transient, In-Memory)

Per-account lockout tracking for failed login attempts:

| Property | Value |
|----------|-------|
| **Storage** | In-memory `Map<SHA256(email), FailureRecord>` |
| **Key derivation** | SHA-256 hash of normalized (trim+lowercase) email |
| **Defaults** | 5 failures → 15-minute lockout; 250ms base delay, ×2 per failure (max 5s) |
| **Decay window** | 15 minutes since last failure resets the counter |
| **Sweep GC** | Periodic sweep removes expired records (interval: max(60s, min(decayWindow/5, 300s))) |

**Security properties:**
- Raw emails never appear in heap snapshots — storage keys are SHA-256 hashed.
- Lockout is per-account, not per-IP, defeating distributed credential-stuffing attacks.
- Response timing is uniformly padded; locked accounts return the same `invalid_credentials` shape as non-locked ones.

*Source: [`src/auth/accountLockout.ts`](../src/auth/accountLockout.ts)*

### 1.7 Audit Trail Entries

Key auth events are logged to the tamper-evident audit log:

| Event | Trigger |
|-------|---------|
| `AUTH_LOGIN` | Successful login (emitted by auth middleware) |
| `AUTH_REGISTER` | New user registration |
| `AUTH_LOGOUT` | User logout |
| `AUTH_REFRESH` | Successful token refresh |
| `AUTH_LOCKOUT_TRIGGERED` | Account locked due to consecutive failures |
| `AUTH_LOCKOUT_RELEASED` | Locked account successfully authenticated |

*Source: [`src/auth/accountLockout.ts`](../src/auth/accountLockout.ts), [`src/middleware/authorization.ts`](../src/middleware/authorization.ts)*

## 2. Retention Windows and Purge Behavior

### 2.1 User Records (`users` table)

| Concern | Behaviour |
|---------|-----------|
| **Retention** | Indefinite — user records are not automatically purged |
| **Automated purge** | None — the `DataEntityType` enum does not include a `user_profile` purge integration in the auth context |
| **Deletion** | No soft-delete or hard-delete endpoint is currently exposed for user records |
| **Data minimization** | The `password_hash` and `refresh_token_hash` columns are nullable; if a user has never set a password or logged in, these fields remain `NULL` |

The `DataEntityType` enum in `src/retention/types.ts` includes `user_profile`, but the auth `users` table is not wired into the automated retention engine (`DataRetentionManager`), archival service, or purge pipeline.

*Source: [`src/retention/types.ts`](../src/retention/types.ts) — `DataEntityType` enum*

### 2.2 JWT Access Tokens

Access tokens are stateless and not stored server-side. They expire after 15 minutes:

| Concern | Behaviour |
|---------|-----------|
| **TTL** | 15 minutes (`ACCESS_TOKEN_TTL`) |
| **Revocation** | Not individually revocable — short TTL limits exposure window |
| **Server storage** | None — validated cryptographically per request |

*Source: [`src/services/auth.service.ts`](../src/services/auth.service.ts) — `issueTokens()`*

### 2.3 JWT Refresh Tokens

| Concern | Behaviour |
|---------|-----------|
| **TTL** | 7 days (`REFRESH_TOKEN_TTL`) |
| **Server storage** | SHA-256 hash in `users.refresh_token_hash` |
| **Rotation** | Each use invalidates the previous token (hash set to `NULL` before new hash stored) |
| **Logout** | Sets `refresh_token_hash` to `NULL` |
| **Purge** | No automated purge for expired hashes — the hash is overwritten on next login/refresh or cleared on logout |

If a user stops using the application, their `refresh_token_hash` will remain in the `users` table until the next login or refresh overwrites it, or until logout clears it.

*Source: [`src/services/auth.service.ts`](../src/services/auth.service.ts) — `refresh()`, `logout()`*

### 2.4 API Keys

| Concern | Behaviour |
|---------|-----------|
| **Retention** | Indefinite while `active = 1` and `expires_at` is null or in the future |
| **Expiration** | Optional `expires_at` timestamp — keys with `expires_at < now` are rejected at validation time |
| **Deactivation** | Keys can be deactivated (`active = 0`) via the API key management endpoint; deactivated keys are not accepted for authentication |
| **Purge** | No automated purge for expired or deactivated API keys |
| **Call count** | `call_count` increments on each successful use; provides usage telemetry |

*Source: [`src/auth/apiKeys.ts`](../src/auth/apiKeys.ts)*

### 2.5 API Key Cache

| Concern | Behaviour |
|---------|-----------|
| **TTL** | 5 minutes (configurable via `API_KEY_CACHE_TTL_MS`) |
| **Eviction** | TTL-based; expired entries are evicted lazily on next access |
| **Reset** | Full cache invalidation on key creation, deactivation, or deletion |
| **Process lifecycle** | Cache is cleared on process exit; no persistence across restarts |

*Source: [`src/auth/authCache.ts`](../src/auth/authCache.ts)*

### 2.6 Account Lockout State

| Concern | Behaviour |
|---------|-----------|
| **Storage** | In-memory only; lost on process restart |
| **Lockout duration** | 15 minutes (configurable via `AUTH_LOCKOUT_LOCKOUT_DURATION_MS`) |
| **Decay window** | 15 minutes since last failure (configurable via `AUTH_LOCKOUT_DECAY_WINDOW_MS`) |
| **Sweep** | Periodic GC removes records past lockout expiry AND past decay window |
| **Max record lifetime** | At most `decayWindowMs + sweepIntervalMs` for non-expired records |

*Source: [`src/auth/accountLockout.ts`](../src/auth/accountLockout.ts)*

### 2.7 Audit Trail Entries

Auth audit entries follow the general audit retention policy: retained **permanently** in the append-only, cryptographically verifiable audit ledger. No automated purge mechanism applies to auth-specific audit entries. See the [audit data retention policy](./audit-retention.md) for details.

## 3. PII Handling

### 3.1 User Records

The `users` table stores the following potential PII:

| Field | PII Classification | Handling |
|-------|-------------------|----------|
| `email` | **PII** (direct identifier) | Stored in normalized form (lowercased, trimmed). A unique index enforces case-insensitive uniqueness. |
| `username` | **PII** (display name) | Stored as-is; no redaction or masking applied at rest. |
| `password_hash` | **Sensitive** | scrypt hash with random per-user salt. Never stored or logged in plaintext. |
| `refresh_token_hash` | **Sensitive** | SHA-256 hash. Raw token never persisted. |

**Redaction in logs/audit:**
- The global redaction pipeline (`src/redact.ts`) redacts `password`, `secret`, `token`, `credential`, `apikey`, `api_key`, `private`, `refresh_token`, and `authorization` keys from log output.
- Email addresses in audit metadata are partially masked (e.g., `alice@example.com` → `ali***@example.com`) by the audit redaction pipeline.

*Source: [`src/redact.ts`](../src/redact.ts), [`src/logger.ts`](../src/logger.ts), [`src/audit/redact.ts`](../src/audit/redact.ts)*

### 3.2 JWT Tokens

| Field | PII Classification | Handling |
|-------|-------------------|----------|
| `sub` (user ID) | **Indirect identifier** | Internal UUID — not directly PII, but linkable to user record |
| `email` | **PII** (direct identifier) | Included in access token payload — transported over HTTPS |
| `role` | **Non-PII** | Metadata only |

**Security notes:**
- Access tokens contain the user's email in the payload. Compromise of a token exposes this PII.
- The short 15-minute TTL limits the exposure window of a leaked token.
- Tokens are transmitted in the `Authorization: Bearer <token>` header, which is redacted in audit logs.

### 3.3 API Keys

| Field | PII Classification | Handling |
|-------|-------------------|----------|
| Raw API key | **Sensitive credential** | Generated, returned once, never stored. Prefix is stored as `key_hash`/`key_salt`. |
| `key_hash` / `key_salt` | **Non-PII** (one-way derived) | PBKDF2-SHA256 hash |
| `key_selector` | **Non-PII** (one-way derived) | SHA-256 hash used for lookups |
| `created_by` | **Indirect identifier** | User UUID — linkable to user record |
| `name` | **Low-risk** | Human-readable label chosen by the user |

### 3.4 Account Lockout State

| Field | PII Classification | Handling |
|-------|-------------------|----------|
| Storage key | **Non-PII** (one-way derived) | SHA-256 hash of normalized email |
| Failure count | **Non-PII** | Integer |
| Lockout deadline | **Non-PII** | Timestamp |

**Security notes:**
- Raw emails never appear in the lockout tracker's in-memory map — only SHA-256 hashes are stored.
- The `normalizeEmail()` function (trim + lowercase) is applied before hashing, ensuring `Alice@Example.com` and `alice@example.com` collide on the same storage key.
- Lockout audit entries (`AUTH_LOCKOUT_TRIGGERED`, `AUTH_LOCKOUT_RELEASED`) use the normalized email as the `actor` field but are subject to audit redaction.

### 3.5 Email Notifications

Auth-related email notifications (registration confirmation, password reset — if enabled) are sent through the notification subsystem. See the [email notifications documentation](./email-notifications.md) for details on notification data retention and PII handling.

## 4. Summary Table

| Data Store | Retention Window | Purge Mechanism | PII Exposure |
|------------|-----------------|-----------------|--------------|
| User records (`users` table) | Indefinite | None automated | `email` (direct PII), `username` (display name) |
| JWT access tokens | 15 minutes (TTL) | Automatic expiry | `email` in token payload |
| JWT refresh tokens (client) | 7 days (TTL) | Automatic expiry | `sub` (UUID) |
| JWT refresh tokens (server hash) | Until next login/refresh/logout | Overwritten on rotation; cleared on logout | SHA-256 hash (non-reversible) |
| API keys (active) | Indefinite or until `expires_at` | Manual deactivation | `created_by` (UUID), `name` (label) |
| API key cache | 5 minutes (TTL) | TTL eviction + lazy cleanup | Cached `ApiKeyInfo` (no raw key) |
| Account lockout state | 15 min lockout / 15 min decay | Timer-based sweep GC | SHA-256(email) only |
| Audit trail (auth events) | Permanent | None (append-only ledger) | Redacted via audit pipeline |

## 5. Configuration Reference

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `JWT_SECRET` | *Required* | HMAC secret for JWT signing/verification |
| `AUTH_LOCKOUT_ENABLED` | `true` | Master switch for account lockout |
| `AUTH_LOCKOUT_MAX_FAILURES` | `5` | Consecutive failures before lockout |
| `AUTH_LOCKOUT_LOCKOUT_DURATION_MS` | `900000` (15 min) | Lockout duration in milliseconds |
| `AUTH_LOCKOUT_DECAY_WINDOW_MS` | `900000` (15 min) | Inactivity window to reset failure counter |
| `AUTH_LOCKOUT_BASE_DELAY_MS` | `250` | First-failure response delay |
| `AUTH_LOCKOUT_DELAY_MULTIPLIER` | `2` | Exponential multiplier per failure |
| `AUTH_LOCKOUT_MAX_DELAY_MS` | `5000` | Maximum response delay |
| `API_KEY_CACHE_TTL_MS` | `300000` (5 min) | API key cache TTL |
| `API_KEYS_CURSOR_SECRET` | `talenttrust-api-keys-cursor-v1` | Secret for API key cursor pagination |

## 6. Related Documentation

- [Authentication Flow](./auth-flow.md) — detailed auth flow and middleware pipeline
- [Audit Data Retention & Purge Policy](./audit-retention.md) — permanent retention and cryptographic chain for audit entries
- [Data Retention & Lifecycle Management](./DATA_RETENTION.md) — system-wide retention engine, archival, and purge lifecycle
- [API Keys Documentation](./api-keys.md) — API key creation, management, and authentication
- [Configuration](./configuration.md) — environment variable reference
- [Email Notifications](./email-notifications.md) — notification data retention and PII handling
