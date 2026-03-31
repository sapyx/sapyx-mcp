// ============================================================
// Pinterest API v5 — Typed HTTP Client
// ============================================================

import { getValidAccessToken, AuthRequiredError } from "./auth.js";
import type {
  Board,
  BoardSection,
  BoardUpdate,
  CreatePinRequest,
  FollowerUser,
  PaginatedResponse,
  Pin,
  PinAnalyticsResponse,
  PinUpdate,
  PinterestApiError,
  TopPinsAnalyticsResponse,
  UserAccount,
  UserAnalyticsResponse,
} from "./types.js";

const API_BASE = process.env.PINTEREST_SANDBOX === "true"
  ? "https://api-sandbox.pinterest.com/v5"
  : "https://api.pinterest.com/v5";

// --------------- In-Memory TTL Cache ---------------

const CACHE_TTL_MS = Number(process.env.PINTEREST_CACHE_TTL_S ?? 60) * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const requestCache = new Map<string, CacheEntry<unknown>>();
let rateLimitedUntil = 0;

function buildCacheKey(path: string, queryParams?: Record<string, string>): string {
  const sortedParams = queryParams
    ? Object.entries(queryParams)
        .filter(([, v]) => v !== undefined && v !== "")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&")
    : "";
  return `GET:${path}?${sortedParams}`;
}

// --------------- Core Request ---------------

async function pinterestRequest<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
  queryParams?: Record<string, string>,
  retryCount = 0,
): Promise<T> {
  // --- Block if globally rate-limited ---
  if (rateLimitedUntil > Date.now()) {
    const waitSec = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    throw new Error(
      `Pinterest API in pausa per rate limit. Riprova tra circa ${waitSec} secondi.`
    );
  }

  // --- Cache read (GET only) ---
  if (method === "GET") {
    const key = buildCacheKey(path, queryParams);
    const entry = requestCache.get(key) as CacheEntry<T> | undefined;
    if (entry && Date.now() < entry.expiresAt) {
      console.error(`[api] cache hit  ${key}`);
      return entry.value;
    }
    if (entry) requestCache.delete(key); // evict stale
  }

  // --- Cache invalidation (POST/PATCH/DELETE) ---
  if (method !== "GET") {
    const prefix = `GET:${path}`;
    for (const key of requestCache.keys()) {
      if (key === prefix || key.startsWith(prefix + "?") || key.startsWith(prefix + "/")) {
        requestCache.delete(key);
        console.error(`[api] cache inv  ${key}`);
      }
    }
  }

  const token = await getValidAccessToken();

  const url = new URL(`${API_BASE}${path}`);
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const options: RequestInit = { method, headers };
  if (body && (method === "POST" || method === "PATCH")) {
    options.body = JSON.stringify(body);
  }

  console.error(`[api] ${method} ${url.pathname}${url.search}`);

  const response = await fetch(url.toString(), options);

  if (!response.ok) {
    // 429 Rate Limited — use x-ratelimit-reset to know exactly when the window resets
    if (response.status === 429) {
      const limitHeader   = response.headers.get("x-ratelimit-limit");
      const remaining     = response.headers.get("x-ratelimit-remaining");
      const resetHeader   = response.headers.get("x-ratelimit-reset");
      const retryAfter    = response.headers.get("Retry-After");

      // Prefer x-ratelimit-reset (Unix timestamp) over Retry-After (seconds delta)
      let waitMs: number;
      if (resetHeader) {
        const resetAt = parseInt(resetHeader, 10) * 1000;
        waitMs = Math.max(resetAt - Date.now(), 1000);
      } else if (retryAfter) {
        waitMs = parseInt(retryAfter, 10) * 1000;
      } else {
        throw new Error("Pinterest API rate limit raggiunto: nessun header di reset ricevuto.");
      }

      rateLimitedUntil = Date.now() + waitMs;

      const waitSec = Math.ceil(waitMs / 1000);
      const limitInfo = limitHeader ? ` (limit: ${limitHeader}, remaining: ${remaining ?? "0"})` : "";
      console.error(`[api] Rate limited${limitInfo}. Reset in ${waitSec}s (attempt ${retryCount + 1}/3)`);

      if (retryCount < 3) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        rateLimitedUntil = 0;
        return pinterestRequest<T>(method, path, body, queryParams, retryCount + 1);
      }
      throw new Error(
        `Pinterest API rate limit raggiunto. Tutti i tentativi esauriti (3/3). ` +
        `Attendi circa ${waitSec} secondi prima di riprovare.`
      );
    }

    // 5xx Server Error — exponential backoff, retry up to 3 times
    if (response.status >= 500 && retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
      console.error(`[api] Server error ${response.status}. Retrying in ${delay / 1000}s (attempt ${retryCount + 1}/3)`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return pinterestRequest<T>(method, path, body, queryParams, retryCount + 1);
    }

    if (response.status === 401) {
      // Try to parse Pinterest's error body to distinguish token issues from scope/Trial restrictions.
      let body: PinterestApiError | null = null;
      try { body = (await response.json()) as PinterestApiError; } catch { /* ignore */ }

      if (!body) {
        throw new AuthRequiredError("Pinterest session expired or revoked. Run the pinterest_auth tool to re-authenticate.");
      }

      // Keywords that indicate the token itself is invalid/expired → need re-auth
      const isTokenInvalid = /expired|revoked|invalid/i.test(body.message ?? "");
      if (isTokenInvalid) {
        throw new AuthRequiredError(`Pinterest session invalid: ${body.message}. Run the pinterest_auth tool to re-authenticate.`);
      }

      // Other 401s (scope restriction, Trial limitation) → show the actual error
      throw new Error(`Pinterest API error 401: ${body.message} (code: ${body.code}). This endpoint may not be available in Trial access.`);
    }

    let errorMessage: string;
    try {
      const errorData = (await response.json()) as PinterestApiError;
      errorMessage = `Pinterest API error ${response.status}: ${errorData.message} (code: ${errorData.code})`;
    } catch {
      errorMessage = `Pinterest API error ${response.status}: ${await response.text()}`;
    }
    throw new Error(errorMessage);
  }

  // 204 No Content (e.g. DELETE)
  if (response.status === 204) {
    return undefined as T;
  }

  const data = (await response.json()) as T;

  // --- Cache write (GET only) ---
  if (method === "GET") {
    const key = buildCacheKey(path, queryParams);
    requestCache.set(key, { value: data, expiresAt: Date.now() + CACHE_TTL_MS });
    console.error(`[api] cache set  ${key} (TTL ${CACHE_TTL_MS / 1000}s)`);
  }

  return data;
}

// --------------- Paginated Request ---------------

async function paginatedRequest<T>(
  path: string,
  queryParams?: Record<string, string>,
  pageSize?: number,
  bookmark?: string,
): Promise<PaginatedResponse<T>> {
  const params: Record<string, string> = { ...queryParams };
  if (pageSize) params.page_size = String(pageSize);
  if (bookmark) params.bookmark = bookmark;

  return pinterestRequest<PaginatedResponse<T>>("GET", path, undefined, params);
}

// --------------- Boards ---------------

export async function listBoards(
  pageSize?: number,
  bookmark?: string,
): Promise<PaginatedResponse<Board>> {
  return paginatedRequest<Board>("/boards", undefined, pageSize, bookmark);
}

export async function getBoard(boardId: string): Promise<Board> {
  return pinterestRequest<Board>("GET", `/boards/${boardId}`);
}

export async function createBoard(
  name: string,
  description?: string,
  privacy?: string,
): Promise<Board> {
  const body: Record<string, unknown> = { name };
  if (description) body.description = description;
  if (privacy) body.privacy = privacy;
  return pinterestRequest<Board>("POST", "/boards", body);
}

export async function updateBoard(boardId: string, update: BoardUpdate): Promise<Board> {
  return pinterestRequest<Board>("PATCH", `/boards/${boardId}`, update as Record<string, unknown>);
}

export async function deleteBoard(boardId: string): Promise<void> {
  return pinterestRequest<void>("DELETE", `/boards/${boardId}`);
}

export async function listBoardSections(
  boardId: string,
  pageSize?: number,
  bookmark?: string,
): Promise<PaginatedResponse<BoardSection>> {
  return paginatedRequest<BoardSection>(
    `/boards/${boardId}/sections`,
    undefined,
    pageSize,
    bookmark,
  );
}

export async function createBoardSection(
  boardId: string,
  name: string,
): Promise<BoardSection> {
  return pinterestRequest<BoardSection>("POST", `/boards/${boardId}/sections`, { name });
}

export async function updateBoardSection(
  boardId: string,
  sectionId: string,
  name: string,
): Promise<BoardSection> {
  return pinterestRequest<BoardSection>("PATCH", `/boards/${boardId}/sections/${sectionId}`, { name });
}

export async function deleteBoardSection(boardId: string, sectionId: string): Promise<void> {
  return pinterestRequest<void>("DELETE", `/boards/${boardId}/sections/${sectionId}`);
}

// --------------- Pins ---------------

export async function listBoardPins(
  boardId: string,
  pageSize?: number,
  bookmark?: string,
): Promise<PaginatedResponse<Pin>> {
  return paginatedRequest<Pin>(`/boards/${boardId}/pins`, undefined, pageSize, bookmark);
}

export async function listSectionPins(
  boardId: string,
  sectionId: string,
  pageSize?: number,
  bookmark?: string,
): Promise<PaginatedResponse<Pin>> {
  return paginatedRequest<Pin>(
    `/boards/${boardId}/sections/${sectionId}/pins`,
    undefined,
    pageSize,
    bookmark,
  );
}

export async function getPin(pinId: string): Promise<Pin> {
  return pinterestRequest<Pin>("GET", `/pins/${pinId}`);
}

export async function updatePin(pinId: string, update: PinUpdate): Promise<Pin> {
  return pinterestRequest<Pin>("PATCH", `/pins/${pinId}`, update as Record<string, unknown>);
}

export async function deletePin(pinId: string): Promise<void> {
  return pinterestRequest<void>("DELETE", `/pins/${pinId}`);
}

export async function savePin(
  pinId: string,
  boardId: string,
  boardSectionId?: string,
): Promise<Pin> {
  const body: Record<string, unknown> = { board_id: boardId };
  if (boardSectionId) body.board_section_id = boardSectionId;
  return pinterestRequest<Pin>("POST", `/pins/${pinId}/save`, body);
}

export async function createPin(data: CreatePinRequest): Promise<Pin> {
  return pinterestRequest<Pin>("POST", "/pins", data as unknown as Record<string, unknown>);
}

export async function getPinAnalytics(
  pinId: string,
  startDate: string,
  endDate: string,
  metricTypes: string[],
): Promise<PinAnalyticsResponse> {
  return pinterestRequest<PinAnalyticsResponse>("GET", `/pins/${pinId}/analytics`, undefined, {
    start_date: startDate,
    end_date: endDate,
    metric_types: metricTypes.join(","),
  });
}

// --------------- Search ---------------

export async function searchPins(
  query: string,
  bookmark?: string,
): Promise<PaginatedResponse<Pin>> {
  const params: Record<string, string> = { query };
  if (bookmark) params.bookmark = bookmark;
  return paginatedRequest<Pin>("/search/pins", params);
}

export async function searchBoards(
  query: string,
  bookmark?: string,
): Promise<PaginatedResponse<Board>> {
  const params: Record<string, string> = { query };
  if (bookmark) params.bookmark = bookmark;
  return paginatedRequest<Board>("/search/boards", params);
}

// --------------- User ---------------

export async function getUserAccount(): Promise<UserAccount> {
  return pinterestRequest<UserAccount>("GET", "/user_account");
}

export async function listFollowers(
  pageSize?: number,
  bookmark?: string,
): Promise<PaginatedResponse<FollowerUser>> {
  return paginatedRequest<FollowerUser>("/user_account/followers", undefined, pageSize, bookmark);
}

export async function listFollowing(
  pageSize?: number,
  bookmark?: string,
): Promise<PaginatedResponse<FollowerUser>> {
  return paginatedRequest<FollowerUser>("/user_account/following", undefined, pageSize, bookmark);
}

export async function getUserAnalytics(
  startDate: string,
  endDate: string,
  metricTypes: string[],
): Promise<UserAnalyticsResponse> {
  return pinterestRequest<UserAnalyticsResponse>("GET", "/user_account/analytics", undefined, {
    start_date: startDate,
    end_date: endDate,
    metric_types: metricTypes.join(","),
  });
}

export async function getUserTopPins(
  startDate: string,
  endDate: string,
  sortBy: string,
  numOfPins?: number,
): Promise<TopPinsAnalyticsResponse> {
  const params: Record<string, string> = {
    start_date: startDate,
    end_date: endDate,
    sort_by: sortBy,
  };
  if (numOfPins) params.num_of_pins = String(numOfPins);
  return pinterestRequest<TopPinsAnalyticsResponse>("GET", "/user_account/analytics/top_pins", undefined, params);
}

// --------------- Image Fetcher ---------------

/**
 * Fetches an image from a URL and returns it as base64.
 * This fetches from Pinterest's CDN — no auth header needed.
 */
export async function fetchImageAsBase64(
  imageUrl: string,
): Promise<{ data: string; mimeType: string }> {
  console.error(`[api] Fetching image: ${imageUrl}`);

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image (${response.status}): ${imageUrl}`);
  }

  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");

  console.error(`[api] Image fetched: ${contentType}, ${Math.round(arrayBuffer.byteLength / 1024)}KB`);

  return { data: base64, mimeType: contentType };
}
