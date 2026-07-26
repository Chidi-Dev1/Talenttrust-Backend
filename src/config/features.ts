import { parseBoolEnv } from './env';

export interface FeaturesConfig {
  disputesEnabled: boolean;
}

export const features: FeaturesConfig = {
  disputesEnabled: parseBoolEnv('DISPUTES_FEATURE_ENABLED', true),
};
