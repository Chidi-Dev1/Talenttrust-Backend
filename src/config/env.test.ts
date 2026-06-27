import { validateEnv } from './env.schema';

describe('Environment validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should throw when COMPLIANCE_AUDIT_SECRET is missing', () => {
    delete process.env.COMPLIANCE_AUDIT_SECRET;
    expect(() => validateEnv()).toThrow(/COMPLIANCE_AUDIT_SECRET/);
  });

  it('should pass when COMPLIANCE_AUDIT_SECRET is provided', () => {
    process.env.NODE_ENV = 'test';
    process.env.COMPLIANCE_AUDIT_SECRET = 'a'.repeat(32);
    expect(() => validateEnv()).not.toThrow();
  });
});
