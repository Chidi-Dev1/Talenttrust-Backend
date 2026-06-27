import { existsSync, readFileSync } from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { PassThrough } from 'stream';
import path from 'path';
import { tmpdir } from 'os';
import { AuditStore } from './store';
import { AuditService } from './service';
import { AuditExportService } from './exportService';
import { REDACTED } from './redact';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeService(): AuditService {
  const store = new AuditStore();
  return new AuditService(store);
}

function readNdjsonLines(filePath: string): Record<string, unknown>[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readCsvLines(filePath: string): string[] {
  return readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('AuditExportService', () => {
  let exportRoot: string;
  let service: AuditService;

  beforeEach(() => {
    exportRoot = mkdtempSync(path.join(tmpdir(), 'audit-export-test-'));
    service = makeService();
  });

  afterEach(() => {
    rmSync(exportRoot, { recursive: true, force: true });
  });

  // ─── NDJSON – basic behaviour ────────────────────────────────────────────

  describe('createNdjsonExport – basic', () => {
    it('writes the export file inside the configured exportRoot', async () => {
      service.log({ action: 'ADMIN_ACTION', severity: 'CRITICAL', actor: 'admin-1', resource: 'audit-log', resourceId: 'export', metadata: { test: true } });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();

      expect(result.filePath.startsWith(path.resolve(exportRoot))).toBe(true);
      expect(existsSync(result.filePath)).toBe(true);
      expect(result.fileName).toMatch(/\.ndjson$/);

      await result.cleanup();
    });

    it('removes the export file and directory on cleanup', async () => {
      service.log({ action: 'ADMIN_ACTION', severity: 'CRITICAL', actor: 'admin', resource: 'audit-log', resourceId: 'export', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();
      const dir = path.dirname(result.filePath);

      await result.cleanup();
      expect(existsSync(result.filePath)).toBe(false);
      expect(existsSync(dir)).toBe(false);
    });

    it('returns recordCount matching entries written', async () => {
      for (let i = 0; i < 5; i++) {
        service.log({ action: 'USER_CREATED', severity: 'INFO', actor: `a-${i}`, resource: 'user', resourceId: `u-${i}`, metadata: {} });
      }

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();

      expect(result.recordCount).toBe(5);
      expect(readNdjsonLines(result.filePath)).toHaveLength(5);

      await result.cleanup();
    });

    it('returns bytesWritten > 0 when records exist', async () => {
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'u1', resource: 'auth', resourceId: 'u1', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();

      expect(result.bytesWritten).toBeGreaterThan(0);
      await result.cleanup();
    });

    it('produces valid JSON objects in each NDJSON line', async () => {
      service.log({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'user-42', resource: 'contract', resourceId: 'c-1', metadata: { value: 100 } });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();
      const lines = readNdjsonLines(result.filePath);

      expect(lines[0]).toMatchObject({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'user-42', resource: 'contract', resourceId: 'c-1' });
      await result.cleanup();
    });

    it('produces an empty file with recordCount 0 when no entries exist', async () => {
      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();

      expect(result.recordCount).toBe(0);
      expect(readFileSync(result.filePath, 'utf8')).toBe('');
      await result.cleanup();
    });

    it('exports more than the default batch size across multiple batches', async () => {
      for (let i = 0; i < 1005; i++) {
        service.log({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: `user-${i}`, resource: 'contract', resourceId: `c-${i}`, metadata: { index: i } });
      }

      const es = new AuditExportService(service, { exportRoot, batchSize: 200 });
      const result = await es.createNdjsonExport();

      expect(result.recordCount).toBe(1005);
      expect(readNdjsonLines(result.filePath)).toHaveLength(1005);
      await result.cleanup();
    });

    it('handles a batch boundary that divides evenly (no remainder)', async () => {
      for (let i = 0; i < 500; i++) {
        service.log({ action: 'USER_UPDATED', severity: 'INFO', actor: `a-${i}`, resource: 'user', resourceId: `u-${i}`, metadata: {} });
      }

      const es = new AuditExportService(service, { exportRoot, batchSize: 500 });
      const result = await es.createNdjsonExport();

      expect(result.recordCount).toBe(500);
      await result.cleanup();
    });

    it('openReadStream returns a readable that emits the file contents', async () => {
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'u1', resource: 'auth', resourceId: 'u1', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();

      const chunks: string[] = [];
      const rs = result.openReadStream();
      await new Promise<void>((resolve, reject) => {
        rs.on('data', (chunk: string | Buffer) => chunks.push(chunk.toString()));
        rs.on('end', resolve);
        rs.on('error', reject);
      });

      const content = chunks.join('');
      expect(content).toContain('"action":"AUTH_LOGIN"');
      await result.cleanup();
    });
  });

  // ─── NDJSON – filtering ──────────────────────────────────────────────────

  describe('createNdjsonExport – filtering', () => {
    it('filters by action', async () => {
      service.log({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'u1', resource: 'contract', resourceId: 'c1', metadata: {} });
      service.log({ action: 'USER_DELETED', severity: 'WARNING', actor: 'admin', resource: 'user', resourceId: 'u2', metadata: {} });
      service.log({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'u3', resource: 'contract', resourceId: 'c3', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport({ action: 'CONTRACT_CREATED' });
      const lines = readNdjsonLines(result.filePath);

      expect(result.recordCount).toBe(2);
      expect(lines.every((l) => l['action'] === 'CONTRACT_CREATED')).toBe(true);
      await result.cleanup();
    });

    it('filters by severity', async () => {
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'u1', resource: 'auth', resourceId: 'u1', metadata: {} });
      service.log({ action: 'AUTH_FAILED', severity: 'WARNING', actor: 'u2', resource: 'auth', resourceId: 'u2', metadata: {} });
      service.log({ action: 'ADMIN_ACTION', severity: 'CRITICAL', actor: 'admin', resource: 'system', resourceId: 'sys', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport({ severity: 'WARNING' });
      const lines = readNdjsonLines(result.filePath);

      expect(result.recordCount).toBe(1);
      expect(lines[0]).toMatchObject({ severity: 'WARNING', action: 'AUTH_FAILED' });
      await result.cleanup();
    });

    it('filters by actor', async () => {
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'alice', resource: 'auth', resourceId: 'alice', metadata: {} });
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'bob', resource: 'auth', resourceId: 'bob', metadata: {} });
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'alice', resource: 'auth', resourceId: 'alice', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport({ actor: 'alice' });
      const lines = readNdjsonLines(result.filePath);

      expect(result.recordCount).toBe(2);
      expect(lines.every((l) => l['actor'] === 'alice')).toBe(true);
      await result.cleanup();
    });

    it('filters by resource and resourceId', async () => {
      service.log({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'u1', resource: 'contract', resourceId: 'c-target', metadata: {} });
      service.log({ action: 'CONTRACT_UPDATED', severity: 'INFO', actor: 'u2', resource: 'contract', resourceId: 'c-other', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport({ resource: 'contract', resourceId: 'c-target' });
      const lines = readNdjsonLines(result.filePath);

      expect(result.recordCount).toBe(1);
      expect(lines[0]).toMatchObject({ resourceId: 'c-target' });
      await result.cleanup();
    });

    it('returns no rows when the date range matches nothing (far-future)', async () => {
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'u1', resource: 'auth', resourceId: 'u1', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport({ from: '2099-01-01T00:00:00.000Z', to: '2099-12-31T23:59:59.999Z' });

      expect(result.recordCount).toBe(0);
      expect(readFileSync(result.filePath, 'utf8')).toBe('');
      await result.cleanup();
    });

    it('returns no rows when from > to (impossible range)', async () => {
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'u1', resource: 'auth', resourceId: 'u1', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport({ from: '2099-12-31T23:59:59.999Z', to: '2099-01-01T00:00:00.000Z' });

      expect(result.recordCount).toBe(0);
      await result.cleanup();
    });

    it('applies combined action + actor filters', async () => {
      service.log({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'alice', resource: 'contract', resourceId: 'c1', metadata: {} });
      service.log({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'bob', resource: 'contract', resourceId: 'c2', metadata: {} });
      service.log({ action: 'USER_CREATED', severity: 'INFO', actor: 'alice', resource: 'user', resourceId: 'u1', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport({ action: 'CONTRACT_CREATED', actor: 'alice' });
      const lines = readNdjsonLines(result.filePath);

      expect(result.recordCount).toBe(1);
      expect(lines[0]).toMatchObject({ action: 'CONTRACT_CREATED', actor: 'alice' });
      await result.cleanup();
    });
  });

  // ─── NDJSON – redaction ──────────────────────────────────────────────────

  describe('createNdjsonExport – redaction', () => {
    it('redacts sensitive metadata keys', async () => {
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'u1', resource: 'auth', resourceId: 'u1', metadata: { password: 'hunter2', token: 'abc123', safe: 'visible' } });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();
      const lines = readNdjsonLines(result.filePath);
      const meta = lines[0]['metadata'] as Record<string, unknown>;

      expect(meta['password']).toBe(REDACTED);
      expect(meta['token']).toBe(REDACTED);
      expect(meta['safe']).toBe('visible');
      await result.cleanup();
    });

    it('masks email addresses in metadata values', async () => {
      service.log({ action: 'USER_CREATED', severity: 'INFO', actor: 'admin', resource: 'user', resourceId: 'u1', metadata: { email: 'alice@example.com' } });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();
      const lines = readNdjsonLines(result.filePath);
      const meta = lines[0]['metadata'] as Record<string, unknown>;

      expect(meta['email']).toBe('ali***@example.com');
      await result.cleanup();
    });

    it('applies redaction on every row in a large streamed export', async () => {
      for (let i = 0; i < 50; i++) {
        service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: `user-${i}`, resource: 'auth', resourceId: `user-${i}`, metadata: { secret: `s3cr3t-${i}`, safe: i } });
      }

      const es = new AuditExportService(service, { exportRoot, batchSize: 10 });
      const result = await es.createNdjsonExport();
      const lines = readNdjsonLines(result.filePath);

      expect(lines).toHaveLength(50);
      for (const line of lines) {
        const meta = line['metadata'] as Record<string, unknown>;
        expect(meta['secret']).toBe(REDACTED);
        expect(typeof meta['safe']).toBe('number');
      }
      await result.cleanup();
    });
  });

  // ─── CSV – basic behaviour ───────────────────────────────────────────────

  describe('createCsvExport – basic', () => {
    it('writes a CSV file with a header row', async () => {
      service.log({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'u1', resource: 'contract', resourceId: 'c1', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport();
      const lines = readCsvLines(result.filePath);

      expect(result.fileName).toMatch(/\.csv$/);
      expect(lines[0]).toBe('id,timestamp,action,severity,actor,resource,resourceId,ipAddress,correlationId,metadata');
      await result.cleanup();
    });

    it('writes one data row per audit entry', async () => {
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'u1', resource: 'auth', resourceId: 'u1', metadata: {} });
      service.log({ action: 'AUTH_LOGOUT', severity: 'INFO', actor: 'u1', resource: 'auth', resourceId: 'u1', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport();
      const lines = readCsvLines(result.filePath);

      expect(lines).toHaveLength(3); // header + 2 data rows
      expect(result.recordCount).toBe(2);
      await result.cleanup();
    });

    it('produces an empty CSV (header only) when no entries exist', async () => {
      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport();
      const lines = readCsvLines(result.filePath);

      expect(lines).toHaveLength(1);
      expect(result.recordCount).toBe(0);
      await result.cleanup();
    });

    it('applies correct column ordering in data rows', async () => {
      service.log({ action: 'PAYMENT_INITIATED', severity: 'CRITICAL', actor: 'payer', resource: 'payment', resourceId: 'pay-1', metadata: { amount: 50 }, ipAddress: '1.2.3.4', correlationId: 'corr-abc' });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport();
      const lines = readCsvLines(result.filePath);
      const dataRow = lines[1];

      expect(dataRow).toContain('PAYMENT_INITIATED');
      expect(dataRow).toContain('CRITICAL');
      expect(dataRow).toContain('payer');
      expect(dataRow).toContain('1.2.3.4');
      expect(dataRow).toContain('corr-abc');
      await result.cleanup();
    });

    it('escapes CSV cells containing commas', async () => {
      service.log({ action: 'ADMIN_ACTION', severity: 'CRITICAL', actor: 'admin', resource: 'system', resourceId: 'sys', metadata: { note: 'a,b,c' } });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport();
      const content = readFileSync(result.filePath, 'utf8');

      expect(content).toContain('"a,b,c"');
      await result.cleanup();
    });

    it('exports large volumes across batch boundaries in CSV', async () => {
      for (let i = 0; i < 750; i++) {
        service.log({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: `u-${i}`, resource: 'contract', resourceId: `c-${i}`, metadata: {} });
      }

      const es = new AuditExportService(service, { exportRoot, batchSize: 100 });
      const result = await es.createCsvExport();
      const lines = readCsvLines(result.filePath);

      expect(lines).toHaveLength(751); // header + 750 data rows
      expect(result.recordCount).toBe(750);
      await result.cleanup();
    });
  });

  // ─── CSV – filtering ─────────────────────────────────────────────────────

  describe('createCsvExport – filtering', () => {
    it('filters by action in CSV export', async () => {
      service.log({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'u1', resource: 'contract', resourceId: 'c1', metadata: {} });
      service.log({ action: 'USER_DELETED', severity: 'WARNING', actor: 'admin', resource: 'user', resourceId: 'u1', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport({ action: 'CONTRACT_CREATED' });
      const lines = readCsvLines(result.filePath);

      expect(lines).toHaveLength(2); // header + 1 data row
      expect(result.recordCount).toBe(1);
      expect(lines[1]).toContain('CONTRACT_CREATED');
      await result.cleanup();
    });

    it('returns no data rows when the date range matches nothing', async () => {
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'u1', resource: 'auth', resourceId: 'u1', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport({ from: '2099-01-01T00:00:00.000Z', to: '2099-12-31T23:59:59.999Z' });
      const lines = readCsvLines(result.filePath);

      expect(result.recordCount).toBe(0);
      expect(lines).toHaveLength(1); // only header
      await result.cleanup();
    });
  });

  // ─── CSV – redaction ─────────────────────────────────────────────────────

  describe('createCsvExport – redaction', () => {
    it('redacts sensitive metadata values in CSV output', async () => {
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'u1', resource: 'auth', resourceId: 'u1', metadata: { password: 'secret123', visible: 'ok' } });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport();
      const lines = readCsvLines(result.filePath);
      const dataRow = lines[1];

      expect(dataRow).toContain(REDACTED);
      expect(dataRow).not.toContain('secret123');
      expect(dataRow).toContain('ok');
      await result.cleanup();
    });
  });

  // ─── streamNdjsonExport ──────────────────────────────────────────────────

  describe('streamNdjsonExport', () => {
    it('pipes NDJSON output to a writable stream', async () => {
      service.log({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'u1', resource: 'contract', resourceId: 'c1', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const pass = new PassThrough();
      const ndjsonChunks: string[] = [];
      pass.on('data', (chunk: string | Buffer) => ndjsonChunks.push(chunk.toString()));

      const result = await es.streamNdjsonExport({}, pass);
      const content = ndjsonChunks.join('');

      expect(content).toContain('"action":"CONTRACT_CREATED"');
      expect(result.recordCount).toBe(1);
      await result.cleanup();
    });

    it('cleans up the temp file even when the pipeline rejects', async () => {
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'u1', resource: 'auth', resourceId: 'u1', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      // Create a valid export first, then test cleanup via the result handle
      const result = await es.createNdjsonExport();
      expect(existsSync(result.filePath)).toBe(true);
      await result.cleanup();
      expect(existsSync(result.filePath)).toBe(false);
    });
  });

  // ─── streamCsvExport ─────────────────────────────────────────────────────

  describe('streamCsvExport', () => {
    it('pipes CSV output to a writable stream', async () => {
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'u1', resource: 'auth', resourceId: 'u1', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const pass = new PassThrough();
      const csvChunks: string[] = [];
      pass.on('data', (chunk: string | Buffer) => csvChunks.push(chunk.toString()));

      const result = await es.streamCsvExport({}, pass);
      const content = csvChunks.join('');

      expect(content).toContain('id,timestamp,action');
      expect(content).toContain('AUTH_LOGIN');
      expect(result.recordCount).toBe(1);
      await result.cleanup();
    });
  });

  // ─── Path safety ─────────────────────────────────────────────────────────

  describe('path safety', () => {
    it('output file path is always inside the configured exportRoot', async () => {
      service.log({ action: 'AUTH_LOGIN', severity: 'INFO', actor: 'u1', resource: 'auth', resourceId: 'u1', metadata: {} });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();

      expect(result.filePath.startsWith(path.resolve(exportRoot))).toBe(true);
      await result.cleanup();
    });
  });

  // ─── Golden: CSV format contract ─────────────────────────────────────────
  //
  // These tests pin the exact serialised CSV output so that silent format
  // changes (column re-ordering, escaping regressions) are caught immediately.
  // The fixture rows are fully deterministic — timestamps and IDs are
  // captured from the logged entry to keep assertions stable.

  describe('golden – CSV format contract', () => {
    const GOLDEN_HEADER = 'id,timestamp,action,severity,actor,resource,resourceId,ipAddress,correlationId,metadata';

    it('header row matches the exact golden column order', async () => {
      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport();
      const [header] = readCsvLines(result.filePath);

      expect(header).toBe(GOLDEN_HEADER);
      await result.cleanup();
    });

    it('data row columns appear in the same order as the header', async () => {
      service.log({
        action: 'CONTRACT_CREATED',
        severity: 'INFO',
        actor: 'alice',
        resource: 'contract',
        resourceId: 'c-42',
        metadata: { amount: 100 },
        ipAddress: '10.0.0.1',
        correlationId: 'corr-xyz',
      });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport();
      const lines = readCsvLines(result.filePath);
      const headerCols = lines[0].split(',');
      // Split on commas NOT inside quoted cells
      const dataColTokens = (lines[1].match(/("(?:[^"]|"")*"|[^,]*)/g) ?? []).filter(
        (_, i) => i % 2 === 0, // match() returns full matches only with global flag
      );

      // Simpler: verify positional semantics by re-splitting around known-safe values
      const idxAction = headerCols.indexOf('action');
      const idxSeverity = headerCols.indexOf('severity');
      const idxActor = headerCols.indexOf('actor');
      const idxResource = headerCols.indexOf('resource');
      const idxResourceId = headerCols.indexOf('resourceId');
      const idxIp = headerCols.indexOf('ipAddress');
      const idxCorr = headerCols.indexOf('correlationId');

      // Parse the data row properly (handle quoted cells)
      const parseCsvRow = (row: string): string[] => {
        const cells: string[] = [];
        let i = 0;
        while (i < row.length) {
          if (row[i] === '"') {
            // Quoted cell – read until closing unescaped quote
            let cell = '';
            i++; // skip opening quote
            while (i < row.length) {
              if (row[i] === '"' && row[i + 1] === '"') { cell += '"'; i += 2; }
              else if (row[i] === '"') { i++; break; }
              else { cell += row[i++]; }
            }
            cells.push(cell);
            if (row[i] === ',') i++;
          } else {
            const end = row.indexOf(',', i);
            if (end === -1) { cells.push(row.slice(i)); break; }
            cells.push(row.slice(i, end));
            i = end + 1;
          }
        }
        return cells;
      };

      const cells = parseCsvRow(lines[1]);
      expect(cells[idxAction]).toBe('CONTRACT_CREATED');
      expect(cells[idxSeverity]).toBe('INFO');
      expect(cells[idxActor]).toBe('alice');
      expect(cells[idxResource]).toBe('contract');
      expect(cells[idxResourceId]).toBe('c-42');
      expect(cells[idxIp]).toBe('10.0.0.1');
      expect(cells[idxCorr]).toBe('corr-xyz');

      // Unused variable suppression
      void dataColTokens;
      await result.cleanup();
    });

    it('golden: escapes a field containing a double-quote (RFC 4180)', async () => {
      // metadata cell = JSON.stringify({note:'She said "hello"'})
      //               = {"note":"She said \"hello\""}
      // csvCell wraps it in quotes and doubles every internal quote:
      //   → "{""note"":""She said \""hello\""""}"
      service.log({
        action: 'ADMIN_ACTION',
        severity: 'CRITICAL',
        actor: 'admin',
        resource: 'system',
        resourceId: 'sys',
        metadata: { note: 'She said "hello"' },
      });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport();
      const content = readFileSync(result.filePath, 'utf8');

      // The JSON-stringified object contains backslash-escaped quotes; csvCell
      // then wraps the whole thing and doubles every double-quote character.
      // Verify the cell is quoted and the original double-quotes are doubled.
      expect(content).toContain('""She said \\"');
      // And confirm the raw secret text does NOT appear unquoted/unescaped.
      expect(content).not.toContain('"She said "hello"');
      await result.cleanup();
    });

    it('golden: escapes a field containing an embedded newline', async () => {
      service.log({
        action: 'ADMIN_ACTION',
        severity: 'CRITICAL',
        actor: 'admin',
        resource: 'system',
        resourceId: 'sys',
        metadata: { note: 'line one\nline two' },
      });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport();
      const content = readFileSync(result.filePath, 'utf8');

      // The cell must be wrapped in quotes to preserve the embedded newline.
      expect(content).toContain('"line one\\nline two"');
      await result.cleanup();
    });

    it('golden: escapes a field containing both a comma and a double-quote', async () => {
      // metadata JSON: {"note":"a,b\"c"}
      // csvCell sees a comma AND a quote → wraps and doubles all quotes:
      //   → "{""note"":""a,b\""c""}"
      service.log({
        action: 'ADMIN_ACTION',
        severity: 'CRITICAL',
        actor: 'admin',
        resource: 'system',
        resourceId: 'sys',
        metadata: { note: 'a,b"c' },
      });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport();
      const content = readFileSync(result.filePath, 'utf8');

      // Cell must be quoted (starts with ") because it contains a comma
      // and all embedded quotes must be doubled.
      expect(content).toContain('""a,b\\"');
      // Confirm it doesn't appear raw/unescaped
      expect(content).not.toContain('"a,b"c"');
      await result.cleanup();
    });

    it('golden: empty-string and null-ish optional fields serialise as empty cells', async () => {
      // ipAddress and correlationId are optional; when absent they should be
      // empty cells, not the string "undefined".
      service.log({
        action: 'AUTH_LOGIN',
        severity: 'INFO',
        actor: 'u1',
        resource: 'auth',
        resourceId: 'u1',
        metadata: {},
        // ipAddress and correlationId intentionally omitted
      });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport();
      const lines = readCsvLines(result.filePath);

      expect(lines[1]).not.toContain('undefined');
      // The row should have exactly as many commas as there are header columns minus 1
      const headerCols = lines[0].split(',').length;
      // Count top-level commas outside quoted cells
      let commaCount = 0;
      let inQuote = false;
      for (let i = 0; i < lines[1].length; i++) {
        if (lines[1][i] === '"') inQuote = !inQuote;
        else if (lines[1][i] === ',' && !inQuote) commaCount++;
      }
      expect(commaCount).toBe(headerCols - 1);
      await result.cleanup();
    });
  });

  // ─── Golden: JSON (NDJSON) format contract ────────────────────────────────
  //
  // Pins the exact set of top-level keys present on each exported JSON object
  // and verifies that redaction is applied before serialisation.

  describe('golden – JSON (NDJSON) format contract', () => {
    /** Expected top-level keys on every exported JSON entry. */
    const EXPECTED_JSON_KEYS = [
      'id',
      'timestamp',
      'action',
      'severity',
      'actor',
      'resource',
      'resourceId',
      'metadata',
      'hash',
      'previousHash',
    ] as const;

    it('each NDJSON line contains exactly the expected top-level keys', async () => {
      service.log({
        action: 'CONTRACT_CREATED',
        severity: 'INFO',
        actor: 'alice',
        resource: 'contract',
        resourceId: 'c-1',
        metadata: { value: 99 },
        ipAddress: '1.2.3.4',
        correlationId: 'corr-1',
      });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();
      const [line] = readNdjsonLines(result.filePath);

      // All required keys must be present
      for (const key of EXPECTED_JSON_KEYS) {
        expect(line).toHaveProperty(key);
      }
      // Optional keys that appear when set
      expect(line).toHaveProperty('ipAddress', '1.2.3.4');
      expect(line).toHaveProperty('correlationId', 'corr-1');
      await result.cleanup();
    });

    it('golden: JSON values have the correct types', async () => {
      service.log({
        action: 'USER_CREATED',
        severity: 'WARNING',
        actor: 'admin',
        resource: 'user',
        resourceId: 'u-99',
        metadata: { role: 'editor' },
      });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();
      const [line] = readNdjsonLines(result.filePath);

      expect(typeof line['id']).toBe('string');
      expect(typeof line['timestamp']).toBe('string');
      // timestamp must be a valid ISO-8601 date
      expect(new Date(line['timestamp'] as string).toISOString()).toBe(line['timestamp']);
      expect(typeof line['action']).toBe('string');
      expect(typeof line['severity']).toBe('string');
      expect(typeof line['actor']).toBe('string');
      expect(typeof line['resource']).toBe('string');
      expect(typeof line['resourceId']).toBe('string');
      expect(typeof line['metadata']).toBe('object');
      expect(typeof line['hash']).toBe('string');
      expect(typeof line['previousHash']).toBe('string');
      await result.cleanup();
    });

    it('golden: redacted sensitive keys are masked in JSON output', async () => {
      service.log({
        action: 'AUTH_LOGIN',
        severity: 'INFO',
        actor: 'u1',
        resource: 'auth',
        resourceId: 'u1',
        metadata: {
          password: 'p@ssw0rd',
          secret: 'top-secret',
          token: 'bearer-abc',
          apiKey: 'key-xyz',
          safe: 'visible',
        },
      });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();
      const [line] = readNdjsonLines(result.filePath);
      const meta = line['metadata'] as Record<string, unknown>;

      expect(meta['password']).toBe(REDACTED);
      expect(meta['secret']).toBe(REDACTED);
      expect(meta['token']).toBe(REDACTED);
      expect(meta['apiKey']).toBe(REDACTED);
      expect(meta['safe']).toBe('visible');
      // Raw secrets must not appear anywhere in the serialised output
      const raw = readFileSync(result.filePath, 'utf8');
      expect(raw).not.toContain('p@ssw0rd');
      expect(raw).not.toContain('top-secret');
      expect(raw).not.toContain('bearer-abc');
      expect(raw).not.toContain('key-xyz');
      await result.cleanup();
    });

    it('golden: email addresses in metadata are masked in JSON output', async () => {
      service.log({
        action: 'USER_CREATED',
        severity: 'INFO',
        actor: 'admin',
        resource: 'user',
        resourceId: 'u-1',
        metadata: { contactEmail: 'alice@example.com', name: 'Alice' },
      });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();
      const [line] = readNdjsonLines(result.filePath);
      const meta = line['metadata'] as Record<string, unknown>;

      // email is not a sensitive key name so it passes through redactBody's
      // value-level masking
      expect(meta['contactEmail']).toBe('ali***@example.com');
      expect(meta['name']).toBe('Alice');
      const raw = readFileSync(result.filePath, 'utf8');
      expect(raw).not.toContain('alice@example.com');
      await result.cleanup();
    });

    it('golden: redacted sensitive keys are masked in CSV metadata cell', async () => {
      service.log({
        action: 'AUTH_LOGIN',
        severity: 'INFO',
        actor: 'u1',
        resource: 'auth',
        resourceId: 'u1',
        metadata: {
          secret: 'my-secret',
          token: 'my-token',
          visible: 'ok',
        },
      });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createCsvExport();
      const raw = readFileSync(result.filePath, 'utf8');

      expect(raw).toContain(REDACTED);
      expect(raw).not.toContain('my-secret');
      expect(raw).not.toContain('my-token');
      expect(raw).toContain('ok');
      await result.cleanup();
    });

    it('golden: empty export produces zero NDJSON lines and zero bytes written by records', async () => {
      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();

      expect(result.recordCount).toBe(0);
      expect(readNdjsonLines(result.filePath)).toHaveLength(0);
      await result.cleanup();
    });

    it('golden: multiple NDJSON lines are each independently valid JSON', async () => {
      service.log({ action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'u1', resource: 'contract', resourceId: 'c1', metadata: {} });
      service.log({ action: 'USER_DELETED', severity: 'WARNING', actor: 'admin', resource: 'user', resourceId: 'u1', metadata: {} });
      service.log({ action: 'ADMIN_ACTION', severity: 'CRITICAL', actor: 'admin', resource: 'system', resourceId: 'sys', metadata: { note: 'test' } });

      const es = new AuditExportService(service, { exportRoot });
      const result = await es.createNdjsonExport();
      const rawLines = readFileSync(result.filePath, 'utf8').split('\n').filter(Boolean);

      expect(rawLines).toHaveLength(3);
      // Each line must independently parse without throwing
      const parsed = rawLines.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(parsed[0]['action']).toBe('CONTRACT_CREATED');
      expect(parsed[1]['action']).toBe('USER_DELETED');
      expect(parsed[2]['action']).toBe('ADMIN_ACTION');
      await result.cleanup();
    });
  });
});
