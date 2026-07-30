/**
 * @file disputes-request-lifecycle.test.ts
 * @description Tests for the disputes request lifecycle documentation (issue #1048).
 *
 * These tests verify:
 * - The file exists at the expected path and is readable
 * - All required top-level sections are present
 * - All five CRUD operation diagrams are present
 * - The state machine diagram is present
 * - The error flow diagram is present
 * - Mermaid code fences are well-formed (opening + closing)
 * - The key source files table references expected files
 * - Related documentation links point to existing docs
 * - No common Markdown issues (empty links, unclosed fences)
 */

import fs from 'fs';
import path from 'path';

const DOC_PATH = path.join(
  __dirname,
  '../../docs/disputes-request-lifecycle.md',
);

describe('Disputes Request Lifecycle doc (docs/disputes-request-lifecycle.md)', () => {
  // ── File existence ─────────────────────────────────────────────────────────

  describe('file existence and readability', () => {
    it('exists at the expected path', () => {
      expect(fs.existsSync(DOC_PATH)).toBe(true);
    });

    it('is readable', () => {
      expect(() => fs.readFileSync(DOC_PATH, 'utf-8')).not.toThrow();
    });

    it('is not empty', () => {
      const content = fs.readFileSync(DOC_PATH, 'utf-8');
      expect(content.trim().length).toBeGreaterThan(0);
    });
  });

  // ── Required top-level sections ────────────────────────────────────────────

  describe('required top-level sections', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(DOC_PATH, 'utf-8');
    });

    it('has a H1 title referencing "Disputes Request Lifecycle"', () => {
      expect(content).toMatch(/^# Disputes Request Lifecycle/m);
    });

    it('references issue #1048', () => {
      expect(content).toMatch(/#1048/);
    });

    it('has a Stack Overview section', () => {
      expect(content).toMatch(/## Stack Overview/m);
    });

    it('has a Common Middleware Chain section', () => {
      expect(content).toMatch(/## Common Middleware Chain/m);
    });

    it('has an Operations section', () => {
      expect(content).toMatch(/## Operations/m);
    });

    it('has a State Machine section', () => {
      expect(content).toMatch(/## State Machine/m);
    });

    it('has an Error Flow section', () => {
      expect(content).toMatch(/## Error Flow/m);
    });

    it('has a Key Source Files section', () => {
      expect(content).toMatch(/## Key Source Files/m);
    });

    it('has a Related Documentation section', () => {
      expect(content).toMatch(/## Related Documentation/m);
    });
  });

  // ── CRUD operation diagrams ────────────────────────────────────────────────

  describe('per-operation sequence diagrams', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(DOC_PATH, 'utf-8');
    });

    it('covers POST /disputes — Create Dispute', () => {
      expect(content).toMatch(/POST.*disputes.*Create Dispute/i);
    });

    it('covers GET /disputes — List Disputes', () => {
      expect(content).toMatch(/GET.*disputes.*List Disputes/i);
    });

    it('covers GET /disputes/:id — Get Dispute', () => {
      expect(content).toMatch(/GET.*disputes.*id.*Get Dispute/i);
    });

    it('covers PATCH /disputes/:id — Update Dispute', () => {
      expect(content).toMatch(/PATCH.*disputes.*id.*Update Dispute/i);
    });

    it('covers DELETE /disputes/:id — Delete Dispute', () => {
      expect(content).toMatch(/DELETE.*disputes.*id.*Delete Dispute/i);
    });

    it('covers batch operations', () => {
      expect(content).toMatch(/[Bb]atch/);
    });
  });

  // ── Mermaid diagram validation ─────────────────────────────────────────────

  describe('Mermaid code blocks', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(DOC_PATH, 'utf-8');
    });

    it('has at least one mermaid sequenceDiagram block', () => {
      expect(content).toMatch(/```mermaid[\s\S]*?sequenceDiagram/m);
    });

    it('has at least one stateDiagram block', () => {
      expect(content).toMatch(/```mermaid[\s\S]*?stateDiagram/m);
    });

    it('all mermaid fences are closed', () => {
      const openCount = (content.match(/```mermaid/g) || []).length;
      // Each ```mermaid opening must have a matching ``` close
      // Count total ``` occurrences and ensure they come in pairs
      const allFences = (content.match(/```/g) || []).length;
      expect(allFences % 2).toBe(0);
      expect(openCount).toBeGreaterThan(0);
    });

    it('has multiple sequenceDiagram blocks (one per operation)', () => {
      const matches = content.match(/```mermaid[\s\S]*?sequenceDiagram/gm) || [];
      // Expect at least 5 (common chain + 5 ops)
      expect(matches.length).toBeGreaterThanOrEqual(5);
    });

    it('sequence diagrams reference the Client participant', () => {
      expect(content).toMatch(/participant Client/);
    });

    it('sequence diagrams reference Router/routes participant', () => {
      expect(content).toMatch(/participant Router/i);
    });

    it('sequence diagrams reference DisputesService', () => {
      expect(content).toMatch(/DisputesService/);
    });
  });

  // ── Key source files table ─────────────────────────────────────────────────

  describe('key source files table', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(DOC_PATH, 'utf-8');
    });

    const expectedFiles = [
      'disputes.routes.ts',
      'disputes.controller.ts',
      'disputes.service.ts',
      'dispute.dto.ts',
      'disputes.validation.ts',
      'validate.middleware.ts',
      'authorization.ts',
      'disputesErrorHandler.ts',
      'apiResponse.ts',
    ];

    expectedFiles.forEach((file) => {
      it(`references source file: ${file}`, () => {
        expect(content).toContain(file);
      });
    });
  });

  // ── State machine content ──────────────────────────────────────────────────

  describe('state machine', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(DOC_PATH, 'utf-8');
    });

    it('lists all DisputeStatus values', () => {
      expect(content).toMatch(/\bopen\b/);
      expect(content).toMatch(/\bunder_review\b/);
      expect(content).toMatch(/\bresolved\b/);
      expect(content).toMatch(/\bescalated\b/);
    });

    it('describes "resolved" as a terminal state', () => {
      expect(content).toMatch(/terminal/i);
    });

    it('mentions invalid_state_transition error code', () => {
      expect(content).toContain('invalid_state_transition');
    });
  });

  // ── Error flow content ────────────────────────────────────────────────────

  describe('error flow', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(DOC_PATH, 'utf-8');
    });

    it('references disputesErrorHandler', () => {
      expect(content).toContain('disputesErrorHandler');
    });

    it('references DisputeError', () => {
      expect(content).toContain('DisputeError');
    });

    it('references AppError', () => {
      expect(content).toContain('AppError');
    });

    it('documents dispute_not_found error code', () => {
      expect(content).toContain('dispute_not_found');
    });

    it('documents HTTP 404 status for dispute_not_found', () => {
      // Table row: dispute_not_found | 404 | ...
      expect(content).toMatch(/dispute_not_found.*404/);
    });

    it('documents HTTP 400 for invalid_state_transition', () => {
      expect(content).toMatch(/invalid_state_transition.*400/);
    });
  });

  // ── Middleware chain ───────────────────────────────────────────────────────

  describe('common middleware chain documentation', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(DOC_PATH, 'utf-8');
    });

    it('mentions feature flag', () => {
      expect(content).toMatch(/[Ff]eature [Ff]lag|DISPUTES_ENABLED|feature_disabled/);
    });

    it('mentions rate limiter', () => {
      expect(content).toMatch(/[Rr]ate [Ll]imit/);
    });

    it('mentions JWT authentication', () => {
      expect(content).toMatch(/JWT|requireAuth/);
    });

    it('mentions RBAC permission check', () => {
      expect(content).toMatch(/requirePermission|RBAC|[Pp]ermission/);
    });

    it('mentions Zod validation', () => {
      expect(content).toMatch(/Zod|zod/);
    });

    it('documents 429 rate limit response', () => {
      expect(content).toMatch(/429/);
    });

    it('documents 401 unauthorized response', () => {
      expect(content).toMatch(/401/);
    });

    it('documents 403 forbidden response', () => {
      expect(content).toMatch(/403/);
    });

    it('documents 400 validation error response', () => {
      expect(content).toMatch(/400/);
    });
  });

  // ── Related docs links ─────────────────────────────────────────────────────

  describe('related documentation links', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(DOC_PATH, 'utf-8');
    });

    const relatedDocs = [
      { link: 'disputes-flow.md', label: 'disputes-flow' },
      { link: 'disputes.md', label: 'disputes.md API reference' },
      { link: 'runbook-disputes.md', label: 'runbook' },
    ];

    relatedDocs.forEach(({ link, label }) => {
      it(`links to related doc: ${label}`, () => {
        expect(content).toContain(link);
      });
    });

    it('has no empty markdown links []() ', () => {
      expect(content).not.toMatch(/\[.*?\]\(\s*\)/);
    });
  });

  // ── Soft-delete lifecycle ─────────────────────────────────────────────────

  describe('soft-delete lifecycle section', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(DOC_PATH, 'utf-8');
    });

    it('describes soft-delete', () => {
      expect(content).toMatch(/[Ss]oft.?[Dd]elete|softDelete/);
    });

    it('describes restore', () => {
      expect(content).toMatch(/[Rr]estore/);
    });

    it('describes purge', () => {
      expect(content).toMatch(/[Pp]urge/);
    });

    it('references retention window', () => {
      expect(content).toMatch(/[Rr]etention/);
    });
  });

  // ── Escrow hooks ──────────────────────────────────────────────────────────

  describe('escrow hooks documentation', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(DOC_PATH, 'utf-8');
    });

    it('mentions EscrowHooks', () => {
      expect(content).toMatch(/EscrowHooks/);
    });

    it('describes side effects as fire-and-forget / non-fatal', () => {
      expect(content).toMatch(/[Ff]ire.and.forget|non.fatal/i);
    });
  });

  // ── Response shape ────────────────────────────────────────────────────────

  describe('response envelope documentation', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(DOC_PATH, 'utf-8');
    });

    it('shows the ok() helper is used', () => {
      expect(content).toMatch(/ok\(res/);
    });

    it('shows the fail() helper is used', () => {
      expect(content).toMatch(/fail\(res/);
    });

    it('documents requestId in responses', () => {
      expect(content).toMatch(/requestId/);
    });

    it('documents correlationId in responses', () => {
      expect(content).toMatch(/correlationId/);
    });
  });

  // ── Stack overview table ──────────────────────────────────────────────────

  describe('stack overview table', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(DOC_PATH, 'utf-8');
    });

    it('has a markdown table with Layer column', () => {
      expect(content).toMatch(/\| Layer\s*\|/);
    });

    it('mentions in-memory store', () => {
      expect(content).toMatch(/[Ii]n.memory/);
    });
  });
});
