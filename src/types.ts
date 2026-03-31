// ============================================================
// Pinterest API v5 — TypeScript Type Definitions
// ============================================================

// === OAuth / Token Types ===

export interface OAuthTokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  scope: string;
  refresh_token: string;
  refresh_token_expires_in: number;
  refresh_token_expires_at: number;
}

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix ms timestamp
  refresh_token_expires_at: number; // Unix ms timestamp
  scope: string;
}

// === Pagination ===

export interface PaginatedResponse<T> {
  items: T[];
  bookmark: string | null;
}

// === Image / Media ===

export interface ImageSize {
  url: string;
  width: number;
  height: number;
}

export interface PinImages {
  "150x150"?: ImageSize;
  "400x300"?: ImageSize;
  "600x"?: ImageSize;
  "1200x"?: ImageSize;
  originals?: ImageSize;
}

export type ImageSizeKey = keyof PinImages;

export interface PinMediaImage {
  media_type: "image";
  images: PinImages;
}

export interface PinMediaVideo {
  media_type: "video";
  images: PinImages;
  cover_image_url?: string;
  video_url?: string;
  duration?: number;
  height?: number;
  width?: number;
}

export type PinMedia = PinMediaImage | PinMediaVideo;

// === Pin ===

export interface Pin {
  id: string;
  created_at: string;
  link: string | null;
  title: string | null;
  description: string | null;
  alt_text: string | null;
  board_id: string;
  board_section_id: string | null;
  board_owner: { username: string } | null;
  media: PinMedia | null;
  creative_type: string | null;
  dominant_color: string | null;
  has_been_promoted: boolean;
  is_owner: boolean;
  is_standard: boolean;
  parent_pin_id: string | null;
  pin_metrics: Record<string, unknown> | null;
}

export interface PinUpdate {
  title?: string;
  description?: string;
  alt_text?: string;
  link?: string;
  board_id?: string;
  board_section_id?: string;
}

export interface CreatePinRequest {
  board_id: string;
  media_source:
    | { source_type: "image_url"; url: string }
    | { source_type: "image_base64"; content_type: string; data: string };
  title?: string;
  description?: string;
  alt_text?: string;
  link?: string;
  board_section_id?: string;
}

// === Pin Analytics ===

export interface PinDailyMetric {
  date: string;
  data_status: string;
  [metric: string]: string | number;
}

export interface PinAnalyticsMetric {
  daily_metrics: PinDailyMetric[];
  lifetime_metrics: Record<string, number>;
  summary_metrics: Record<string, number>;
}

export type PinAnalyticsResponse = Record<string, PinAnalyticsMetric>;

// === Board ===

export interface Board {
  id: string;
  name: string;
  description: string | null;
  owner: { username: string };
  privacy: "PUBLIC" | "PROTECTED" | "SECRET";
  pin_count: number;
  follower_count: number;
  created_at: string;
  board_pins_modified_at: string;
  media: { pin_thumbnail_urls: string[] } | null;
}

export interface BoardUpdate {
  name?: string;
  description?: string;
  privacy?: "PUBLIC" | "SECRET";
}

export interface BoardSection {
  id: string;
  name: string;
}

// === User ===

export interface UserAccount {
  username: string;
  account_type: string;
  profile_image: string | null;
  website_url: string | null;
  board_count: number;
  pin_count: number;
  follower_count: number;
  following_count: number;
}

export interface FollowerUser {
  username: string;
  profile_image: string | null;
  follower_count: number;
  following_count: number;
  board_count: number;
  pin_count: number;
}

// === User Analytics ===

export interface UserAnalyticsDailyMetric {
  date: string;
  data_status: string;
  metrics: Record<string, number>;
}

export interface UserAnalyticsResponse {
  all: {
    daily_metrics: UserAnalyticsDailyMetric[];
    lifetime_metrics: Record<string, number>;
    summary_metrics: Record<string, number>;
  };
}

// === Top Pins Analytics ===

export interface TopPinsAnalyticsItem {
  pin_id: string;
  [metric: string]: string | number;
}

export interface TopPinsAnalyticsResponse {
  date_availability: {
    latest_available_timestamp: string;
    is_realtime: boolean;
  };
  sort_by: string;
  pins: TopPinsAnalyticsItem[];
}

// === API Error ===

export interface PinterestApiError {
  code: number;
  message: string;
}
