# Configuration

This document describes environment-variable configuration for the TalentTrust
backend. It currently focuses on the queue retry policy overrides.

## Retry policy overrides

Per-job-type retry/backoff behaviour can be overridden via environment
variables of the form:

```
RETRY_POLICY_{JOB_TYPE}_{PROPERTY}=value
```

`{JOB_TYPE}` is the upper-cased job-type name with hyphens replaced by
underscores, for example `EMAIL_NOTIFICATION`, `CONTRACT_PROCESSING`,
`REPUTATION_UPDATE`, `REPUTATION_RECOMPUTE`, `BLOCKCHAIN_SYNC`.

### Supported properties and bounds

All overrides are validated and clamped to safe bounds so that no environment
value can produce an unbounded backoff explosion. Out-of-range values are
clamped (not rejected) and a warning is emitted via the structured logger.

| Property     | Type    | Accepted range                                  | Notes |
| ------------ | ------- | ----------------------------------------------- | ----- |
| `ATTEMPTS`   | integer | `(0, MAX_RETRY_ATTEMPTS]` (max `10`)            | Coordinates with overall retry bounds. |
| `DELAY`      | integer | `[MIN_BACKOFF_DELAY, MAX_BACKOFF_DELAY]` (`1`–`300000` ms) | Base backoff delay in milliseconds. |
| `MULTIPLIER` | float   | `[MIN_BACKOFF_MULTIPLIER, MAX_BACKOFF_MULTIPLIER]` (`1`–`10`) | Only meaningful for `exponential` backoff. |
| `JITTER`     | float   | `[0, 1]`                                         | Values outside the range are ignored. |

### Validation rules

- Non-numeric, `NaN`, or non-positive values are ignored (the built-in default
  is kept).
- Values outside the accepted range are clamped to the nearest bound and a
  warning is logged.
- A `multiplier` is only meaningful for `exponential` backoff. If a resolved
  override declares a `fixed` backoff that still carries a `multiplier`, the
  multiplier is dropped so the resulting policy is internally consistent.
- Overrides are merged over the built-in `DEFAULT_RETRY_POLICIES`; the override
  precedence is preserved.

### Example

```dotenv
# Use a multiplier of 3 (valid, passes through)
RETRY_POLICY_EMAIL_NOTIFICATION_MULTIPLIER=3

# Requesting 100 is clamped to 10 (MAX_BACKOFF_MULTIPLIER) with a warning
RETRY_POLICY_BLOCKCHAIN_SYNC_MULTIPLIER=100

# Base delay in milliseconds (clamped to 300000 max)
RETRY_POLICY_CONTRACT_PROCESSING_DELAY=2000
```
