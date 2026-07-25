/**
 * @title Reputation Profile Types
 * @dev NatSpec: Types and interfaces for the Freelancer Reputation Profile API.
 */

export interface Review {
  reviewerId: string;
  rating: number;      // 1-5 scale
  comment?: string;
  createdAt: string;   // ISO 8601 date string
}

export interface ReputationProfile {
  freelancerId: string;
  score: number;       // Average of all ratings, 0.0 - 5.0
  jobsCompleted: number;
  totalRatings: number;
  reviews: Review[];
  lastUpdated: string; // ISO 8601 date string
  weightedScore: number;    // Recency-weighted score (0.0 - 5.0 range)
  scoreAlgorithm: string;   // Algorithm identifier, e.g. "exp-decay-v1"
}

/**
 * Paginated reputation profile returned when cursor-based pagination is active.
 * Extends {@link ReputationProfile} with opaque-cursor navigation fields.
 */
export interface PaginatedReputationProfile extends ReputationProfile {
  /** Opaque cursor to pass for the next page of reviews, or null on the last page. */
  nextCursor: string | null;
  /** Convenience flag; true when `nextCursor` is non-null. */
  hasNextPage: boolean;
  /** Page size used for this request (clamped to [1, 100]). */
  limit: number;
}

export interface UpdateReputationPayload {
  reviewerId: string;
  rating: number;
  comment?: string;
  jobCompleted?: boolean;
}
