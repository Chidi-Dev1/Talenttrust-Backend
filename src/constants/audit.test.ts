import {
  AUDIT_ACTIONS,
  AUDIT_ACTIONS_LIST,
  AUDIT_SEVERITIES,
  AUDIT_SEVERITIES_LIST,
  AUDIT_RESOURCES,
  AUDIT_MESSAGES,
  AUDIT_DEFAULTS,
} from './audit';

describe('Audit Constants Module', () => {
  it('should freeze all constant objects and lists', () => {
    expect(Object.isFrozen(AUDIT_ACTIONS)).toBe(true);
    expect(Object.isFrozen(AUDIT_ACTIONS_LIST)).toBe(true);
    expect(Object.isFrozen(AUDIT_SEVERITIES)).toBe(true);
    expect(Object.isFrozen(AUDIT_SEVERITIES_LIST)).toBe(true);
    expect(Object.isFrozen(AUDIT_RESOURCES)).toBe(true);
    expect(Object.isFrozen(AUDIT_MESSAGES)).toBe(true);
    expect(Object.isFrozen(AUDIT_DEFAULTS)).toBe(true);
  });

  it('should contain expected key audit actions', () => {
    expect(AUDIT_ACTIONS.CONTRACT_CREATED).toBe('CONTRACT_CREATED');
    expect(AUDIT_ACTIONS.PAYMENT_RELEASED).toBe('PAYMENT_RELEASED');
    expect(AUDIT_ACTIONS.AUTH_LOGIN).toBe('AUTH_LOGIN');
    expect(AUDIT_ACTIONS.ADMIN_ACTION).toBe('ADMIN_ACTION');
    expect(AUDIT_ACTIONS_LIST).toContain('CONTRACT_CREATED');
  });

  it('should contain expected severities', () => {
    expect(AUDIT_SEVERITIES.INFO).toBe('INFO');
    expect(AUDIT_SEVERITIES.WARNING).toBe('WARNING');
    expect(AUDIT_SEVERITIES.CRITICAL).toBe('CRITICAL');
    expect(AUDIT_SEVERITIES_LIST).toEqual(['INFO', 'WARNING', 'CRITICAL']);
  });

  it('should contain expected resources', () => {
    expect(AUDIT_RESOURCES.CONTRACT).toBe('contract');
    expect(AUDIT_RESOURCES.USER).toBe('user');
    expect(AUDIT_RESOURCES.PAYMENT).toBe('payment');
    expect(AUDIT_RESOURCES.AUDIT_LOG).toBe('audit-log');
  });

  it('should contain expected error and status messages', () => {
    expect(AUDIT_MESSAGES.NOT_FOUND).toBe('Audit entry not found');
    expect(AUDIT_MESSAGES.VALIDATION_FAILED).toBe('Request validation failed');
    expect(AUDIT_MESSAGES.INVALID_LIMIT).toBe('Invalid limit');
    expect(AUDIT_MESSAGES.INVALID_OFFSET).toBe('Invalid offset');
    expect(AUDIT_MESSAGES.INVALID_CURSOR_FORMAT).toBe('Invalid cursor format');
  });

  it('should contain expected default values', () => {
    expect(AUDIT_DEFAULTS.GENESIS_HASH).toBe('GENESIS');
    expect(AUDIT_DEFAULTS.ANONYMOUS_ACTOR).toBe('anonymous');
    expect(AUDIT_DEFAULTS.SYSTEM_ACTOR).toBe('system');
  });
});
