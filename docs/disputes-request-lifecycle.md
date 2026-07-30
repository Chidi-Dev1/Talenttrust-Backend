# Disputes Request Lifecycle

> **Issue #1048** — Sequence diagrams for the disputes request lifecycle:
> middleware → handler → service → in-memory store.

This document provides per-operation sequence diagrams showing how each HTTP
request travels through the full disputes stack, from the HTTP client all the
way down to the in-memory store and back.

## Table of Contents

- [Stack Overview](#stack-overview)
- [Common Middleware Chain](#common-middleware-chain)
- [Operations](#operations)
  - [POST /disputes — Create Dispute](#post-disputes--create-dispute)
  - [GET /disputes — List Disputes](#get-disputes--list-disputes)
  - [GET /disputes/:id — Get Dispute](#get-disputesid--get-dispute)
  - [PATCH /disputes/:id — Update Dispute](#patch-disputesid--update-dispute)
  - [DELETE /disputes/:id — Delete Dispute](#delete-disputesid--delete-dispute)
- [Batch Operation](#batch-operation)
- [State Machine](#state-machine)
- [Error Flow](#error-flow)
- [Key Source Files](#key-source-files)

---

## Stack Overview

Every disputes request passes through the following layers in order:

| Layer | File(s) | Responsibility |
|-------|---------|----------------|
| Express Router | `src/routes/disputes.routes.ts` | Feature flag, observability, rate limiting, route dispatch |
| Auth Middleware | `src/middleware/authorization.ts` | JWT verification (`requireAuth`), RBAC (`requirePermission`) |
| Validation Middleware | `src/middleware/validate.middleware.ts` | Zod schema enforcement on body / query / params |
| Route Handler (inline) | `src/routes/disputes.routes.ts` | Orchestration, logging, calls `ok()` / `fail()` |
| DisputesController | `src/controllers/disputes.controller.ts` | Used by batch endpoint; individual CRUD routes use inline handlers |
| DisputesService | `src/services/disputes.service.ts` | Business logic, state-machine validation, side effects |
| In-memory Store | `src/services/disputes.service.ts` (`disputeStore Map`) | Persistence (demo — production would use a real DB) |
| Response Helpers | `src/utils/apiResponse.ts` | `ok()` / `fail()` — standard JSON envelope |
| Error Handler | `src/middleware/disputesErrorHandler.ts` | Maps `DisputeError` → `AppError` for global handler |

---

## Common Middleware Chain

Every request to `/api/v1/disputes*` passes through this shared stack before
reaching the route-specific handler:

```mermaid
sequenceDiagram
    participant Client
    participant Express as Express App
    participant FeatureFlag as Feature Flag Middleware
    participant ObsMiddleware as Observability Middleware
    participant RateLimiter as Rate Limiter (disputes tier)
    participant AuthN as requireAuth (JWT verify)
    participant AuthZ as requirePermission (RBAC)
    participant Validator as Validation Middleware (Zod)
    participant Handler as Route Handler

    Client->>Express: HTTP Request
    Express->>FeatureFlag: disputes.routes.ts — feature flag check
    alt DISPUTES_ENABLED = false
        FeatureFlag-->>Client: 404 feature_disabled
    end
    FeatureFlag->>ObsMiddleware: pass through
    Note over ObsMiddleware: hooks res.on('finish') to record<br/>duration + status metrics
    ObsMiddleware->>RateLimiter: pass through
    alt Rate limit exceeded
        RateLimiter-->>Client: 429 Too Many Requests<br/>Retry-After header set
    end
    RateLimiter->>AuthN: pass through
    alt Missing / invalid JWT
        AuthN-->>Client: 401 Unauthorized
    end
    alt Expired JWT
        AuthN-->>Client: 401 Unauthorized
    end
    AuthN->>AuthZ: req.user attached
    alt Insufficient role/permission
        AuthZ-->>Client: 403 Forbidden
    end
    AuthZ->>Validator: permission granted
    alt Schema validation fails
        Validator-->>Client: 400 validation_error<br/>(Zod details array)
    end
    Validator->>Handler: validated req.body / req.query / req.params
```

---

## Operations

### POST /disputes — Create Dispute

**Permission required**: `disputes:create` (roles: `admin`, `client`, `freelancer`)

```mermaid
sequenceDiagram
    participant Client
    participant Router as Router<br/>(disputes.routes.ts)
    participant AuthZ as requirePermission<br/>('disputes','create')
    participant Validator as validateRequest<br/>(createDisputeSchema)
    participant Handler as POST / handler<br/>(inline lambda)
    participant ApiResponse as ok() helper<br/>(apiResponse.ts)

    Client->>Router: POST /api/v1/disputes<br/>Authorization: Bearer &lt;token&gt;<br/>{ contractId, reason, raisedBy }

    Note over Router: Feature flag + observability +<br/>rate limiter already applied (see common chain)

    Router->>AuthZ: requirePermission('disputes','create')
    AuthZ-->>Router: 403 Forbidden (if insufficient role)
    AuthZ->>Validator: pass (role ok)

    Validator->>Validator: Zod parse { contractId:uuid, reason:string, raisedBy?:uuid }
    Validator-->>Router: 400 validation_error (if invalid)
    Validator->>Handler: req.body sanitised & validated

    Handler->>Handler: log.info('Creating dispute', { disputeId })
    Handler->>Handler: generate disputeId = "dispute-" + Date.now()
    Handler->>Handler: build dispute object<br/>{ id, contractId, status:'open', createdAt }

    Note over Handler: Routes inline handler builds the dispute directly<br/>(does NOT call DisputesService.createDispute here)

    Handler->>ApiResponse: ok(res, { dispute }, correlationId?, 201)
    ApiResponse-->>Client: 201 Created<br/>{ status:'success', data:{ dispute }, requestId, correlationId? }
```

> **Note**: The inline POST handler on the route builds the object itself without
> calling `DisputesService.createDispute()`. The controller's `createDispute`
> method (also in-memory, no service call for create) exists for direct
> programmatic use but is not wired to the route.

---

### GET /disputes — List Disputes

**Permission required**: `disputes:list` (roles: `admin`, `auditor`, `client` ownOnly, `freelancer` ownOnly)

```mermaid
sequenceDiagram
    participant Client
    participant Router as Router<br/>(disputes.routes.ts)
    participant AuthZ as requirePermission<br/>('disputes','list')
    participant Validator as validateQuery<br/>(listDisputesQuerySchema)
    participant Handler as GET / handler<br/>(inline lambda)
    participant ApiResponse as ok() helper

    Client->>Router: GET /api/v1/disputes?page=1&limit=20&status=open
    Router->>AuthZ: check disputes:list permission
    AuthZ-->>Router: 403 Forbidden (if insufficient role)
    AuthZ->>Validator: pass

    Validator->>Validator: Zod coerce & validate<br/>{ page?:int, limit?:int(max 100), status?, contractId?:uuid }
    Validator-->>Router: 400 validation_error
    Validator->>Handler: req.query validated

    Handler->>Handler: log.info('Listing disputes', { query })

    Note over Handler: Returns empty list (stub implementation).<br/>Production would call DisputesService.listDisputes()

    Handler->>ApiResponse: ok(res, { disputes:[], total:0 }, correlationId?)
    ApiResponse-->>Client: 200 OK<br/>{ status:'success', data:{ disputes:[], total:0 }, requestId }
```

---

### GET /disputes/:id — Get Dispute

**Permission required**: `disputes:read` (roles: `admin`, `auditor`, `client` ownOnly, `freelancer` ownOnly)

```mermaid
sequenceDiagram
    participant Client
    participant Router as Router<br/>(disputes.routes.ts)
    participant AuthZ as requirePermission<br/>('disputes','read')
    participant Validator as validateParams<br/>(disputeParamsSchema)
    participant Handler as GET /:id handler<br/>(inline lambda)
    participant ApiResponse as ok() helper

    Client->>Router: GET /api/v1/disputes/550e8400-e29b-41d4-a716-446655440000
    Router->>AuthZ: check disputes:read permission
    AuthZ-->>Router: 403 Forbidden
    AuthZ->>Validator: pass

    Validator->>Validator: Zod parse { id: uuid }
    Validator-->>Router: 400 validation_error (id not a UUID)
    Validator->>Handler: req.params.id validated

    Handler->>Handler: log.info('Getting dispute', { disputeId })
    Handler->>Handler: build stub response<br/>{ id, status:'open', createdAt }

    Note over Handler: Inline handler returns stub data.<br/>Controller.getDisputeById() calls DisputesService.getDisputeById()

    Handler->>ApiResponse: ok(res, { dispute }, correlationId?)
    ApiResponse-->>Client: 200 OK<br/>{ status:'success', data:{ dispute }, requestId }
```

#### GET /:id via DisputesController (programmatic path)

When `DisputesController.getDisputeById` is called (e.g. in integration tests
or future rewiring), the call continues into the service and store:

```mermaid
sequenceDiagram
    participant Caller
    participant Controller as DisputesController<br/>(disputes.controller.ts)
    participant Service as DisputesService<br/>(disputes.service.ts)
    participant Store as disputeStore<br/>(in-memory Map)
    participant DTO as mapToDisputeResponse()<br/>(dispute.dto.ts)
    participant ApiResponse as ok() / fail()

    Caller->>Controller: getDisputeById(req, res, next)
    Controller->>Controller: resolveLogger(res)<br/>traceContext(res) → { requestId }
    Controller->>Controller: log.info('disputes.getDisputeById: start')

    Controller->>Service: disputesService.getDisputeById(id)
    Service->>Store: disputeStore.get(id)
    alt Not found in Map
        Store-->>Service: undefined
        Service->>Service: throw DisputeError('dispute_not_found', 404)
        Service-->>Controller: throws DisputeError
        Controller->>Controller: log.warn('disputes.getDisputeById: not found')
        Controller->>ApiResponse: fail(res,'dispute_not_found', msg, 404)
        ApiResponse-->>Caller: 404 { status:'error', error:{ code, message, requestId } }
    end
    alt Soft-deleted (deletedAt set, includeDeleted=false)
        Store-->>Service: record with deletedAt
        Service->>Service: isSoftDeleted() → true → throw DisputeError 404
        Service-->>Controller: throws DisputeError
        Controller->>ApiResponse: fail(res,'dispute_not_found', msg, 404)
    end
    Store-->>Service: DisputeRecord
    Service-->>Controller: { ...dispute } (shallow copy)

    Controller->>Controller: log.info('disputes.getDisputeById: success')
    Controller->>DTO: mapToDisputeResponse(dispute)
    DTO-->>Controller: DisputeResponseDto
    Controller->>ApiResponse: ok(res, dto)
    ApiResponse-->>Caller: 200 { status:'success', data: DisputeResponseDto, requestId }
```

---

### PATCH /disputes/:id — Update Dispute

**Permission required**: `disputes:update` (roles: `admin`, `client` ownOnly)

This is the most involved path because it triggers state-machine validation and
cascading side effects (escrow hooks, notifications).

```mermaid
sequenceDiagram
    participant Client
    participant Router as Router<br/>(disputes.routes.ts)
    participant AuthZ as requirePermission<br/>('disputes','update')
    participant Validator as validateSchema<br/>(body:updateDisputeSchema + params:disputeParamsSchema)
    participant Handler as PATCH /:id handler<br/>(inline lambda)
    participant Service as DisputesService<br/>.updateDispute()
    participant StateMachine as validateTransition()<br/>(VALID_TRANSITIONS)
    participant Store as disputeStore Map
    participant EscrowHooks as EscrowHooks<br/>.onStateTransition()
    participant ApiResponse as ok() / fail()
    participant ErrorHandler as disputesErrorHandler

    Client->>Router: PATCH /api/v1/disputes/:id<br/>{ status?, resolution? }

    Router->>AuthZ: requirePermission('disputes','update')
    AuthZ-->>Router: 403 Forbidden
    AuthZ->>Validator: pass

    Validator->>Validator: Zod parse combined schema<br/>body: { status?:enum, resolution?:string(max 2000) }<br/>params: { id: uuid }
    Validator-->>Router: 400 validation_error
    Validator->>Handler: req.body + req.params validated

    Handler->>Handler: log.info('Updating dispute', { disputeId, updateFields })
    Handler->>Service: disputesService.updateDispute(id, { status?, resolution? })

    Service->>Store: disputeStore.get(id)
    alt Not found / soft-deleted
        Store-->>Service: undefined or deletedAt set
        Service-->>Handler: throws DisputeError(dispute_not_found, 404)
        Handler->>ApiResponse: fail(res,'dispute_not_found', msg, 404)
        ApiResponse-->>Client: 404
    end
    Store-->>Service: current DisputeRecord

    alt status field present in payload
        Service->>StateMachine: validateTransition(currentStatus, newStatus)
        Note over StateMachine: VALID_TRANSITIONS map:<br/>open → { under_review, resolved, escalated }<br/>under_review → { resolved, escalated }<br/>escalated → { resolved }<br/>resolved → {} (terminal)
        alt Invalid transition
            StateMachine-->>Service: throws DisputeError(invalid_state_transition, 400)
            Service-->>Handler: propagates error
            Handler->>ErrorHandler: next(error)
            ErrorHandler->>ErrorHandler: mapDisputeErrorToAppError(error)
            ErrorHandler-->>Client: 400 invalid_state_transition
        end
        StateMachine-->>Service: transition valid
    end

    Service->>Service: build updatedDispute = { ...dispute, status:newStatus, updatedAt }
    Service->>Store: disputeStore.set(id, updatedDispute)
    Store-->>Service: stored

    alt status changed (not a no-op)
        Service->>EscrowHooks: EscrowHooks.onStateTransition(oldStatus, newStatus, payload)
        Note over EscrowHooks: Fire-and-forget — failure does NOT<br/>roll back the dispute update
        EscrowHooks-->>Service: resolved (or rejected, non-fatal)
        alt Side effect fails
            Service->>Service: log.warn('[DisputesService] Side effect dispatch failed (non-fatal)')
        end
    end

    Service-->>Handler: updatedDisputeRecord
    Handler->>ApiResponse: ok(res, { dispute:{ id, ...body, updatedAt } }, correlationId?)
    ApiResponse-->>Client: 200 OK<br/>{ status:'success', data:{ dispute }, requestId }
```

---

### DELETE /disputes/:id — Delete Dispute

**Permission required**: `disputes:delete` (role: `admin` only)

The route-level DELETE is a stub (returns success without hitting the service).
`DisputesService.softDeleteDispute()` is available but not wired to this route.

```mermaid
sequenceDiagram
    participant Client
    participant Router as Router<br/>(disputes.routes.ts)
    participant AuthZ as requirePermission<br/>('disputes','delete')
    participant Handler as DELETE /:id handler<br/>(inline lambda)
    participant ApiResponse as ok() helper

    Client->>Router: DELETE /api/v1/disputes/:id<br/>Authorization: Bearer &lt;admin-token&gt;

    Router->>AuthZ: requirePermission('disputes','delete')
    AuthZ-->>Router: 403 Forbidden (non-admin)
    AuthZ->>Handler: pass (admin only)

    Handler->>Handler: log.info('Deleting dispute', { disputeId })

    Note over Handler: Stub: returns success without calling service.<br/>Service has softDeleteDispute(id) and purgeExpiredDisputes()<br/>for programmatic/scheduled use.

    Handler->>ApiResponse: ok(res, { message:'Dispute {id} deleted successfully' }, correlationId?)
    ApiResponse-->>Client: 200 OK<br/>{ status:'success', data:{ message }, requestId }
```

#### Soft-Delete / Restore / Purge (service level)

`DisputesService` provides full soft-delete lifecycle for use by scheduled jobs
and internal tooling:

```mermaid
sequenceDiagram
    participant Caller as Caller (job / internal)
    participant Service as DisputesService
    participant SoftDeleteUtils as softDelete utils<br/>(utils/softDelete.ts)
    participant Store as disputeStore Map

    %% Soft Delete
    Caller->>Service: softDeleteDispute(id, now)
    Service->>Store: disputeStore.get(id)
    alt Not found
        Store-->>Service: undefined → DisputeError(404)
    end
    alt Already soft-deleted
        Store-->>Service: deletedAt set → DisputeError(dispute_already_deleted, 409)
    end
    Service->>Store: set record.deletedAt = now, updatedAt = now
    Service-->>Caller: updated DisputeRecord

    %% Restore
    Caller->>Service: restoreDispute(id, now)
    Service->>Store: disputeStore.get(id)
    Service->>SoftDeleteUtils: isWithinRetentionWindow(deletedAt, retentionDays, now)
    alt Past retention window
        SoftDeleteUtils-->>Service: false → SoftDeleteRetentionError
    end
    Service->>Store: set record.deletedAt = null, updatedAt = now
    Service-->>Caller: restored DisputeRecord

    %% Purge
    Caller->>Service: purgeExpiredDisputes(now)
    Service->>Store: iterate all entries
    Service->>SoftDeleteUtils: isPastRetentionWindow(deletedAt, retentionDays, now)
    alt Past window
        Service->>Store: disputeStore.delete(id)
    end
    Service-->>Caller: count of purged records
```

---

## Batch Operation

**Route**: `POST /api/v1/disputes/batch` (handled by `DisputesController.processBatch`)

```mermaid
sequenceDiagram
    participant Client
    participant Router as Router
    participant Controller as DisputesController<br/>.processBatch()
    participant Service as DisputesService<br/>.processBatch()
    participant ItemLoop as per-item loop
    participant UpdateDispute as .updateDispute(id, payload)
    participant ApiResponse as ok()

    Client->>Router: POST /api/v1/disputes/batch<br/>[ { id, status?, resolution? }, ... ]

    Router->>Controller: processBatch(req, res, next)
    Controller->>Controller: log.info('disputes.processBatch: start', { batchSize })

    Controller->>Service: disputesService.processBatch(operations)

    loop For each operation[i]
        Service->>ItemLoop: try updateDispute(operation.id, payload)
        ItemLoop->>UpdateDispute: getDisputeById → validateTransition → save → side-effects
        alt Success
            UpdateDispute-->>ItemLoop: updatedDispute
            ItemLoop->>Service: push { index, success:true, dispute }
        end
        alt Failure (DisputeError or other)
            UpdateDispute-->>ItemLoop: throws error
            ItemLoop->>Service: push { index, success:false, error:{ code, message } }
            Note over ItemLoop: Item failure does NOT abort<br/>remaining items
        end
    end

    Service-->>Controller: BatchOperationResult[]
    Controller->>Controller: log.info('disputes.processBatch: success', { resultsCount })
    Controller->>ApiResponse: ok(res, { results })
    ApiResponse-->>Client: 200 OK<br/>{ status:'success', data:{ results:[ {index,success,dispute?} ] } }
```

---

## State Machine

```mermaid
stateDiagram-v2
    [*] --> open : createDispute()
    open --> under_review : updateDispute (status=under_review)
    open --> resolved : updateDispute (status=resolved)
    open --> escalated : updateDispute (status=escalated)
    under_review --> resolved : updateDispute (status=resolved)
    under_review --> escalated : updateDispute (status=escalated)
    escalated --> resolved : updateDispute (status=resolved)
    resolved --> [*] : terminal — no further transitions
```

Any transition not shown above is rejected by `validateTransition()` with
`DisputeError('invalid_state_transition', 400)`.

---

## Error Flow

```mermaid
sequenceDiagram
    participant Handler as Route Handler
    participant Next as Express next(error)
    participant DisputesErrorHandler as disputesErrorHandler<br/>(middleware/disputesErrorHandler.ts)
    participant GlobalHandler as Global Error Handler<br/>(middleware/errorHandlers.ts)
    participant Client

    Handler->>Next: next(DisputeError | unknown)
    Next->>DisputesErrorHandler: error passed to middleware chain

    alt DisputeError instance
        DisputesErrorHandler->>DisputesErrorHandler: mapDisputeErrorToAppError(error)<br/>code→statusCode lookup<br/>code→safe message lookup
        DisputesErrorHandler->>GlobalHandler: next(AppError)
    else Any other error
        DisputesErrorHandler->>GlobalHandler: next(error) — pass through
    end

    GlobalHandler->>GlobalHandler: format standard error envelope<br/>{ status:'error', error:{ code, message, requestId } }
    GlobalHandler-->>Client: HTTP error response
```

**Error code → status mapping** (from `disputesErrorHandler.ts`):

| DisputeError code | HTTP Status | Safe message |
|---|---|---|
| `dispute_not_found` | 404 | The requested dispute was not found |
| `invalid_state_transition` | 400 | The requested state transition is not allowed |
| `internal_error` | 500 | An unexpected error occurred while processing the dispute |

---

## Key Source Files

| Purpose | Path |
|---------|------|
| Route definitions + inline handlers | `src/routes/disputes.routes.ts` |
| Controller (batch, DI usage) | `src/controllers/disputes.controller.ts` |
| Business logic + state machine | `src/services/disputes.service.ts` |
| DTO / response mapping | `src/modules/disputes/dto/dispute.dto.ts` |
| Zod validation schemas | `src/routes/disputes.validation.ts` |
| Validation middleware factory | `src/middleware/validate.middleware.ts` |
| JWT auth + RBAC middleware | `src/middleware/authorization.ts` |
| Error normalisation middleware | `src/middleware/disputesErrorHandler.ts` |
| Response envelope helpers | `src/utils/apiResponse.ts` |
| Soft-delete utilities | `src/utils/softDelete.ts` |
| Escrow side-effect hooks | `src/hooks/escrow.hooks.ts` |

## Related Documentation

- [disputes-flow.md](./disputes-flow.md) — High-level architecture overview
- [disputes.md](./disputes.md) — API reference
- [disputes-examples.md](./disputes-examples.md) — cURL examples
- [runbook-disputes.md](./runbook-disputes.md) — Operations runbook
- [disputes-retention.md](./disputes-retention.md) — Soft-delete retention policy
- [disputes-concurrency-tests.md](./disputes-concurrency-tests.md) — Concurrency test notes
