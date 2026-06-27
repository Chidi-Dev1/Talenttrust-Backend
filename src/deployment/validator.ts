/**
 * Deployment Validation Module
 * 
 * Provides pre-deployment validation checks to ensure system readiness
 * and prevent deployment of unhealthy or misconfigured services.
 * 
 * @module deployment/validator
 */

import { EnvironmentConfig } from '../config/environment';
import { isSafeUrl } from '../utils/ssrf';
import { createHttpClient } from '../httpClient';
import { AxiosInstance, AxiosError } from 'axios';

export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** List of validation errors */
  errors: string[];
  /** List of validation warnings */
  warnings: string[];
}

export interface HealthCheckResult {
  /** Service name */
  service: string;
  /** Health status */
  status: 'healthy' | 'unhealthy';
  /** Timestamp of check */
  timestamp: Date;
  /** Additional details */
  details?: Record<string, unknown>;
}

/**
 * Validates environment configuration for deployment
 * @param {EnvironmentConfig} config - Environment configuration to validate
 * @returns {ValidationResult} Validation result with errors and warnings
 */
export function validateDeploymentConfig(config: EnvironmentConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Validate port
  if (config.port < 1 || config.port > 65535) {
    errors.push(`Invalid port number: ${config.port}`);
  }
  
  // Validate API base URL
  if (!config.apiBaseUrl || !isValidUrl(config.apiBaseUrl)) {
    errors.push(`Invalid API base URL: ${config.apiBaseUrl}`);
  }
  
  // Production-specific validations
  if (config.environment === 'production') {
    if (config.debug) {
      warnings.push('Debug mode is enabled in production');
    }
    
    if (config.stellarNetwork !== 'mainnet') {
      errors.push('Production must use Stellar mainnet');
    }
    
    if (config.corsOrigins.includes('*') || config.corsOrigins.some(o => o.includes('localhost'))) {
      errors.push('Production CORS origins must not include wildcards or localhost');
    }
  }
  
  // Staging-specific validations
  if (config.environment === 'staging') {
    if (config.stellarNetwork === 'mainnet') {
      warnings.push('Staging environment using mainnet (consider using testnet)');
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates URL format
 * @param {string} url - URL to validate
 * @returns {boolean} True if URL is valid
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Performs health check on the service
 * @param {string} baseUrl - Base URL of the service
 * @param {AxiosInstance} [httpClient] - Optional injectable HTTP client for testing
 * @returns {Promise<HealthCheckResult>} Health check result
 */
export async function performHealthCheck(
  baseUrl: string,
  httpClient?: AxiosInstance
): Promise<HealthCheckResult> {
  const startTime = Date.now();
  
  try {
    // Validate URL with SSRF guard
    if (!isSafeUrl(baseUrl)) {
      return {
        service: 'talenttrust-backend',
        status: 'unhealthy',
        timestamp: new Date(),
        details: {
          error: 'URL not safe for SSRF',
          baseUrl,
        },
      };
    }

    // Build health check URL
    const healthUrl = new URL('/health/ready', baseUrl);
    const client = httpClient ?? createHttpClient('health-check', { timeout: 5000 });

    // Perform health check
    const response = await client.get(healthUrl.toString());
    const responseTime = Date.now() - startTime;

    const status = response.status === 200 ? 'healthy' : 'unhealthy';
    return {
      service: 'talenttrust-backend',
      status,
      timestamp: new Date(),
      details: {
        responseTime,
        baseUrl,
        statusCode: response.status,
      },
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const axiosError = error as AxiosError;
    let errorMessage = 'Unknown error';
    let statusCode: number | undefined;

    if (axiosError.response) {
      statusCode = axiosError.response.status;
      errorMessage = `HTTP ${statusCode}`;
    } else if (axiosError.code === 'ECONNREFUSED') {
      errorMessage = 'Connection refused';
    } else if (axiosError.code === 'ECONNABORTED') {
      errorMessage = 'Request timeout';
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    return {
      service: 'talenttrust-backend',
      status: 'unhealthy',
      timestamp: new Date(),
      details: {
        error: errorMessage,
        baseUrl,
        responseTime,
        ...(statusCode !== undefined ? { statusCode } : {}),
      },
    };
  }
}

/**
 * Validates deployment readiness
 * @param {EnvironmentConfig} config - Environment configuration
 * @returns {Promise<ValidationResult>} Comprehensive validation result
 */
export async function validateDeploymentReadiness(
  config: EnvironmentConfig
): Promise<ValidationResult> {
  const configValidation = validateDeploymentConfig(config);
  
  if (!configValidation.valid) {
    return configValidation;
  }
  
  // Additional async validations can be added here
  // e.g., database connectivity, external service checks
  
  return configValidation;
}
