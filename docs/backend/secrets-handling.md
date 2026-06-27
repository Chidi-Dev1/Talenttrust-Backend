# Secrets Handling Policy

## Overview

The TalentTrust Backend uses a structured and secure approach to handling secrets and configuration. This ensures that sensitive information is never hardcoded, is easily rotatable, and can be managed across different environments (Development, Staging, Production).

## Core Concepts

### 1. `Secret<T>` Interface

Defined in `src/config/secrets.ts`, the `Secret` interface provides a unified way to interact with sensitive data:

```typescript
export interface Secret<T> {
  get(): T;
  refresh(): Promise<void>;
}
```

- `get()`: Returns the current value of the secret synchronously.
- `refresh()`: Updates the secret from its source asynchronously. This is crucial for supporting secret rotation without restarting the application.

### 2. `EnvSecret` Implementation

`EnvSecret` is an implementation of `Secret` that loads secrets from environment variables using the `dotenv` library.

```typescript
export class EnvSecret<T = string> implements Secret<T> {
  constructor(key: string, defaultValue?: T, transform?: (val: string) => T)
}
```

**Key Features:**
- **Fail-Fast Behavior**: If a required secret is missing and no default is provided, it throws an error immediately at initialization time: `Configuration Error: Missing required secret "KEY_NAME"`
- **Default Values**: Optional defaults for development environments
- **Type Transformation**: Supports converting raw string values to other types (e.g., string to number)
- **Refreshable**: Reloads the secret from the environment when `refresh()` is called

**Example Usage:**
```typescript
new EnvSecret<number>('PORT', 3001, (v) => parseInt(v, 10));
```

### 3. `SecretsManager`

A central registry for all application secrets that provides a unified interface.

**Key Methods:**
- `register<T>(name: string, secret: Secret<T>)`: Registers a secret with the manager (throws if already registered)
- `get<T>(name: string): Secret<T>`: Retrieves a registered secret (throws if not found)
- `getValue<T>(name: string): T`: Gets the current value of a secret directly
- `refreshAll(): Promise<void>`: Refreshes all registered secrets
- `clear(): void`: Clears all registered secrets (useful for testing)

**Example Usage:**
```typescript
import { secretsManager } from './config/secrets';

const dbUrl = secretsManager.getValue<string>('DATABASE_URL');
await secretsManager.refreshAll();
```

### 4. `RotatingSecret` Implementation

`RotatingSecret` is an implementation for secrets that need to be fetched asynchronously (e.g., from AWS Secrets Manager, HashiCorp Vault).

```typescript
export class RotatingSecret<T = string> implements Secret<T> {
  constructor(opts: {
    provider: () => Promise<string>;
    defaultValue?: T;
    transform?: (val: string) => T;
    refreshIntervalMs?: number;
    name?: string;
  })
}
```

**Key Features:**
- **Fail-Safe**: Retains the last successful value if a refresh fails
- **Background Refresh**: Optional automatic refresh at specified intervals
- **No Secret Logging**: Never logs secret material, only minimal error context

## Registered Secrets

The following secrets are registered in `initializeSecrets()` in `src/config/secrets.ts`:

| Secret Name | Environment Variable | Type | Default Value | Production Requirement | Description |
|-------------|----------------------|------|---------------|-----------------------|-------------|
| `PORT` | `PORT` | `number` | `3001` | Optional | Server port to listen on |
| `NODE_ENV` | `NODE_ENV` | `string` | `'development'` | Optional | Environment mode (`development`, `staging`, `production`) |
| `DATABASE_URL` | `DATABASE_URL` | `string` | `'postgresql://localhost:5432/talenttrust'` | **Required** | Database connection URL |
| `JWT_SECRET` | `JWT_SECRET` | `string` | `'dev-secret-keep-it-safe'` | **Required** | Secret key for signing JWT tokens |

**Important Notes:**
- Secrets marked as "**Required**" for production must have no default or must be explicitly overridden. The current defaults are for development only and must never be used in production.
- All secrets are self-initialized when the module loads, but `initializeSecrets()` can be called again if needed (e.g., for testing).

## Redaction Guarantees

The secrets layer provides the following guarantees:
- No secret values are ever logged by `SecretsManager` or `RotatingSecret`
- Error messages never include secret material, only secret names for context
- `RotatingSecret` intentionally swallows logging errors to avoid accidental secret exposure

Developers must still ensure they do not log secret values retrieved from `secretsManager.getValue()` manually.

## Secret Rotation Procedure

### 1. Using `RotatingSecret` for Production

For production secrets that require rotation, replace `EnvSecret` with `RotatingSecret` in `initializeSecrets()`:

```typescript
import { secretsManager, RotatingSecret } from './config/secrets';

const fetchJwtSecretFromVault = async (): Promise<string> => {
  // Fetch from your secrets provider (e.g., AWS Secrets Manager, HashiCorp Vault)
  return await vaultClient.getSecret('jwt-secret');
};

const rotatingJwtSecret = new RotatingSecret({
  provider: fetchJwtSecretFromVault,
  name: 'JWT_SECRET',
  refreshIntervalMs: 300_000, // Refresh every 5 minutes
});

secretsManager.register('JWT_SECRET', rotatingJwtSecret);
```

### 2. Manual Refresh

To refresh all secrets on demand:
```typescript
await secretsManager.refreshAll();
```

### 3. Environment Variable Rotation

For `EnvSecret` (environment variables), rotation typically requires:
1. Updating the environment variable in your deployment environment
2. Calling `secretsManager.refreshAll()` to reload the new value
3. Note: Some deployment environments require a restart to update process.env

## Security Best Practices

1. **No Hardcoded Secrets**: All sensitive values must be loaded via `SecretsManager`
2. **No Production Defaults**: Never use development defaults in production environments
3. **Environment Separation**: Use `.env` files for local development (ignored by Git) and secure environment variables in production
4. **Validation**: `EnvSecret` validates required secrets at startup, failing early
5. **Audit**: Never commit real secrets to version control

## Security Assumptions and Threat Scenarios

- **Assumption: Environment Security**: It is assumed that the environment where the backend is deployed (e.g., Kubernetes, Heroku, AWS Lambda) is secure and that environment variables are not accessible to unauthorized users.
- **Threat: Secret Leakage via Logs**: While `SecretsManager` and `RotatingSecret` avoid logging secrets, developers must ensure they do not log sensitive values retrieved from `getValue()`.
- **Threat: Weak Default Secrets**: Default values provided for development (e.g., `dev-secret-keep-it-safe`) must never be used in production.
- **Threat: Unauthorized Access to .env**: Local development `.env` files must be included in `.gitignore` to prevent accidental commits.

## Adding a New Secret

1. Open `src/config/secrets.ts`
2. In the `initializeSecrets()` function, register the new secret:
```typescript
secretsManager.register('MY_NEW_SECRET', new EnvSecret('MY_NEW_SECRET', 'optional-dev-default'));
```
3. Access the secret in your application:
```typescript
import { secretsManager } from '../config/secrets';
const secretValue = secretsManager.getValue('MY_NEW_SECRET');
```
4. Update `.env.example` with the new variable (without real values)
5. Update this documentation to include the new secret in the Registered Secrets table

## Testing

Comprehensive tests are located in `src/config/secrets.test.ts`. These tests cover:
- Successful loading from environment variables
- Usage of default values
- Error handling for missing required secrets
- Type transformation logic
- Secret rotation/refreshing
- `SecretsManager` registration and retrieval
- `RotatingSecret` fail-safe behavior
