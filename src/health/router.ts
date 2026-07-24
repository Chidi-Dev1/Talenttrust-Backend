/**
 * @module health/router
 * @description Express router exposing the hardened /health endpoint.
 *
 * Security notes:
 * - Probe detail strings are stripped in production to avoid leaking
 *   internal topology to unauthenticated callers.
 * - HTTP 200 for "ok", 503 for "degraded" so load-balancers can act on it.
 * - Cache-Control: no-store prevents stale health data from caches.
 * - Query parameters are validated against {@link HealthQuerySchema} so that
 *   unknown keys are rejected and `verbose` is constrained to "true"/"false".
 */

import { Router, Request, Response } from "express";
import { runHealthCheck } from "./checker";
import { Probe, HealthResponse } from "./types";
import { validateQuery } from "../middleware/validation";
import { HealthQuerySchema } from "./validation";

/**
 * Build the health router.
 *
 * @param probes - Optional probe override (useful in tests).
 */
export function buildHealthRouter(probes?: Probe[]): Router {
  const router = Router();

  router.get("/", validateQuery(HealthQuerySchema), async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");

    const result = await runHealthCheck(probes);

    // Respect the `verbose` query param — include detail strings when
    // verbose=true is explicitly requested (non-production only).
    const isVerbose = req.query['verbose'] === 'true';
    const isProduction = process.env.NODE_ENV === "production";

    // Strip probe details in production to avoid topology leakage.
    // Outside production, details are stripped unless verbose=true is set.
    const sanitized: HealthResponse =
      isProduction || !isVerbose
        ? {
            ...result,
            probes: result.probes.map(({ name, ok, latencyMs }) => ({
              name,
              ok,
              latencyMs,
            })),
          }
        : result;

    res.status(sanitized.status === "ok" ? 200 : 503).json(sanitized);
  });

  return router;
}
